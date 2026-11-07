#!/usr/bin/env bash
# Installs or updates the Kilo CLI from the latest release of this fork (Linux x64).
#
#   curl -fsSL https://raw.githubusercontent.com/Radu-Voinea/kilocode/main/script/fork-install.sh | bash
#
# Replaces ~/.kilo/bin (KILO_INSTALL_DIR overrides it) and keeps the previous install in
# <dir>.bak. Pass a tag such as v7.8.27.1 as the first argument to install that release instead.
set -euo pipefail

repo="Radu-Voinea/kilocode"
dir="${KILO_INSTALL_DIR:-$HOME/.kilo/bin}"
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

echo "Downloading from $base"
curl -fsSL "$base/kilo-linux-x64.tar.gz" -o "$tmp/kilo-linux-x64.tar.gz"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep ' kilo-linux-x64.tar.gz$' SHA256SUMS | sha256sum --check --status) || {
  echo "Checksum mismatch, nothing was installed." >&2
  exit 1
}

mkdir -p "$tmp/bin"
tar -xzf "$tmp/kilo-linux-x64.tar.gz" -C "$tmp/bin"
version=$("$tmp/bin/kilo" --version)

mkdir -p "$(dirname "$dir")"
if [ -d "$dir" ]; then
  rm -rf "$dir.bak"
  mv "$dir" "$dir.bak"
fi
mv "$tmp/bin" "$dir"

echo "Installed Kilo $version to $dir"
[ -d "$dir.bak" ] && echo "Previous install kept in $dir.bak"
