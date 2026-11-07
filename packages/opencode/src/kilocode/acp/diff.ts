import type { ToolCallContent } from "@agentclientprotocol/sdk"
import type { ToolPart } from "@kilocode/sdk/v2"
import { withAir } from "./air"

export const CAPABILITY = "diffPatch"

/** Past this a patch is not worth sending; the standard diff content stays. */
const MAX_PATCH = 256 * 1024

type Change = "create" | "update"

/**
 * Air renders an edit from a git patch it reads in `_meta.jetbrains.air.diffPatch` of a diff
 * content block, so it shows the real change instead of comparing the edit's old and new snippets.
 * Kilo's edit and write tools already record the exact unified patch of the whole file in
 * `metadata.filediff`; this turns it into that block. Anything else keeps the standard content.
 */
export function patchContent(part: ToolPart, content: ToolCallContent[] | undefined) {
  if (part.state.status !== "completed" || !content) return content
  if (part.tool !== "edit" && part.tool !== "write") return content
  const metadata = (part.state.metadata ?? {}) as { filediff?: { file?: unknown; patch?: unknown }; exists?: unknown }
  const file = metadata.filediff?.file
  const patch = metadata.filediff?.patch
  if (typeof file !== "string" || typeof patch !== "string" || !patch || patch.length > MAX_PATCH) return content

  const hunks = body(patch)
  if (!hunks) return content
  const change: Change = part.tool === "write" && metadata.exists === false ? "create" : "update"
  const block: ToolCallContent = {
    type: "diff",
    path: file,
    oldText: null,
    newText: "",
    _meta: withAir(undefined, CAPABILITY, { version: 1, format: "git_patch", text: gitPatch(file, change, hunks) }),
  }
  const rest = content.filter((item) => item.type !== "diff")
  return [...rest, block]
}

/** The hunks of a one-file unified patch, from its first `@@` line on, or undefined without any. */
function body(patch: string) {
  const lines = patch.split("\n")
  if (lines.filter((line) => line.startsWith("+++ ")).length !== 1) return undefined
  const start = lines.findIndex((line) => line.startsWith("@@ "))
  if (start < 0) return undefined
  const end = lines.at(-1) === "" ? -1 : undefined
  return lines.slice(start, end)
}

/** The text of one git patch for `file`, as Air's Claude adapter writes it (`gitPatchText`). */
export function gitPatch(file: string, change: Change, hunks: readonly string[]) {
  const name = file.replaceAll("\\", "/").replace(/^\/+/u, "")
  const before = quote("a/", name)
  const after = quote("b/", name)
  const tab = name.includes(" ") ? "\t" : ""
  return [
    `diff --git ${before} ${after}`,
    ...(change === "create" ? ["new file mode 100644"] : []),
    `--- ${change === "create" ? "/dev/null" : `${before}${tab}`}`,
    `+++ ${after}${tab}`,
    ...hunks,
    "",
  ].join("\n")
}

const ESCAPES: Record<number, string> = {
  0x07: "a",
  0x08: "b",
  0x09: "t",
  0x0a: "n",
  0x0b: "v",
  0x0c: "f",
  0x0d: "r",
  0x22: '"',
  0x5c: "\\",
}

/** Quotes `prefix + name` like git with the default `core.quotePath`. */
function quote(prefix: string, name: string) {
  const full = `${prefix}${name}`
  const state = { quoted: "", needed: false }
  for (const byte of Buffer.from(full, "utf8")) {
    const escape = ESCAPES[byte]
    if (escape !== undefined) {
      state.quoted += `\\${escape}`
      state.needed = true
      continue
    }
    if (byte < 0x20 || byte >= 0x7f) {
      state.quoted += `\\${byte.toString(8).padStart(3, "0")}`
      state.needed = true
      continue
    }
    state.quoted += String.fromCharCode(byte)
  }
  return state.needed ? `"${state.quoted}"` : full
}
