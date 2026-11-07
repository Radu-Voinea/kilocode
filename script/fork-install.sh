#!/usr/bin/env bash
# Installs or updates the Kilo CLI and the Kilo JetBrains plugin from the latest release of this
# fork (Linux x64).
#
#   curl -fsSL https://raw.githubusercontent.com/Radu-Voinea/kilocode/main/script/fork-install.sh | bash
#
# The CLI replaces ~/.kilo/bin (KILO_INSTALL_DIR overrides it) and the previous install is kept in
# <dir>.bak, and running Kilo ACP agents are stopped so the IDE restarts them on the new CLI.
# The plugin replaces the Kilo plugin in every JetBrains IDE that already has it
# installed; previous copies are kept in ~/.kilo/jetbrains-backup. Set KILO_SKIP_JETBRAINS=1 to
# leave the plugin alone. Pass a tag such as v7.8.27.1 as the first argument to install that
# release instead of the latest one.
set -euo pipefail

repo="Radu-Voinea/kilocode"
dir="${KILO_INSTALL_DIR:-$HOME/.kilo/bin}"
jetbrains="${KILO_JETBRAINS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/JetBrains}"
backups="$HOME/.kilo/jetbrains-backup"
tag="${1:-}"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "This fork only publishes Linux x64 builds, not $(uname -s) $(uname -m)." >&2
  exit 1
fi

if [ -n "$tag" ]; then
  base="https://github.com/$repo/releases/download/$tag"
else
  base="https://github.com/$repo/releases/latest/download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Downloads a release asset into $tmp and checks it against the release's SHA256SUMS.
fetch() {
  curl -fsSL "$base/$1" -o "$tmp/$1" || return 1
  (cd "$tmp" && grep " $1\$" SHA256SUMS | sha256sum --check --status) || {
    echo "Checksum mismatch for $1, nothing was installed." >&2
    exit 1
  }
}

echo "Downloading from $base"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
fetch kilo-linux-x64.tar.gz

mkdir -p "$tmp/bin"
tar -xzf "$tmp/kilo-linux-x64.tar.gz" -C "$tmp/bin"
version=$("$tmp/bin/kilo" --version)

# ACP agents (Air's "Kilo (fork)") still running an installed CLI, including one left in the
# backup by an earlier update. They are stopped after the swap so the IDE starts the new one.
agents=()
for proc in /proc/[0-9]*; do
  exe=$(readlink "$proc/exe" 2>/dev/null) || continue
  case "$exe" in "$dir/kilo" | "$dir/kilo (deleted)" | "$dir.bak/kilo" | "$dir.bak/kilo (deleted)") ;; *) continue ;; esac
  args=" $(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null) "
  [[ "$args" == *" acp "* ]] && agents+=("${proc#/proc/}")
done

mkdir -p "$(dirname "$dir")"
if [ -d "$dir" ]; then
  rm -rf "$dir.bak"
  mv "$dir" "$dir.bak"
fi
mv "$tmp/bin" "$dir"

echo "Installed Kilo CLI $version to $dir"
[ -d "$dir.bak" ] && echo "Previous CLI kept in $dir.bak"

if [ "${#agents[@]}" -gt 0 ]; then
  kill -TERM "${agents[@]}" 2>/dev/null || true
  echo "Stopped ${#agents[@]} running Kilo ACP agent(s); your IDE starts the new version on the next message."
fi

# JetBrains plugin: only IDEs that already have Kilo installed get the update.
[ "${KILO_SKIP_JETBRAINS:-}" = "1" ] && exit 0

ides=()
for ide in "$jetbrains"/*/; do
  [ -d "$ide/kilo.jetbrains" ] && ides+=("${ide%/}")
done
if [ "${#ides[@]}" -eq 0 ]; then
  echo "No JetBrains IDE with the Kilo plugin found in $jetbrains, skipping the plugin."
  echo "Install it once from https://github.com/$repo/releases/latest/download/kilo-code-jetbrains.zip"
  exit 0
fi
if ! command -v unzip >/dev/null; then
  echo "unzip is not installed, skipping the JetBrains plugin." >&2
  exit 0
fi

# Releases before 7.8.27.2 named the zip after its version.
plugin=kilo-code-jetbrains.zip
if ! fetch "$plugin" 2>/dev/null; then
  plugin="kilo-code-jetbrains-${version}.zip"
  fetch "$plugin"
fi
unzip -q "$tmp/$plugin" -d "$tmp/plugin"
[ -d "$tmp/plugin/kilo.jetbrains" ] || { echo "Unexpected plugin zip layout, skipping the plugin." >&2; exit 1; }

for ide in "${ides[@]}"; do
  name=$(basename "$ide")
  # Backups live outside the plugins folder: a second copy there would load as a duplicate plugin.
  mkdir -p "$backups"
  rm -rf "$backups/$name"
  mv "$ide/kilo.jetbrains" "$backups/$name"
  cp -r "$tmp/plugin/kilo.jetbrains" "$ide/kilo.jetbrains"
  echo "Installed Kilo plugin $version in $name (previous copy in $backups/$name)"
done
echo "Restart any open JetBrains IDE to load the new plugin."
