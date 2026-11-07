import { describe, expect, it } from "bun:test"
import type { ToolPart } from "@kilocode/sdk/v2"
import { createTwoFilesPatch } from "diff"
import { gitPatch } from "@/kilocode/acp/diff"
import { air, harness } from "./harness"

const part = (tool: string, patch: string, extra: Record<string, unknown> = {}) =>
  ({
    id: "prt",
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    tool,
    callID: "call",
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "",
      metadata: { filediff: { file: "/work/a b.txt", patch }, ...extra },
      time: { start: 0, end: 1 },
    },
  }) as ToolPart

const standard = {
  toolCallId: "call",
  status: "completed" as const,
  content: [
    { type: "content" as const, content: { type: "text" as const, text: "ok" } },
    { type: "diff" as const, path: "/work/a b.txt", oldText: "one", newText: "uno" },
  ],
}

const meta = (update: { content?: unknown }) =>
  (update.content as Array<{ _meta?: { jetbrains: { air: { diffPatch: Record<string, unknown> } } } }>).at(-1)?._meta
    ?.jetbrains.air.diffPatch

describe("acp diff patches", () => {
  it("sends an edit as a git patch to clients that read it", () => {
    const { kilo } = harness({ capabilities: air("diffPatch") })
    const patch = createTwoFilesPatch("/work/a b.txt", "/work/a b.txt", "one\ntwo\n", "uno\ntwo\n")
    const update = kilo.completed(part("edit", patch), standard)

    expect(update.content?.map((item) => item.type)).toEqual(["content", "diff"])
    expect(update.content?.at(-1)).toMatchObject({ type: "diff", path: "/work/a b.txt", oldText: null, newText: "" })
    expect(meta(update)).toEqual({
      version: 1,
      format: "git_patch",
      text: "diff --git a/work/a b.txt b/work/a b.txt\n--- a/work/a b.txt\t\n+++ b/work/a b.txt\t\n@@ -1,2 +1,2 @@\n-one\n+uno\n two\n",
    })
  })

  it("marks a written new file as created", () => {
    const { kilo } = harness({ capabilities: air("diffPatch") })
    const patch = createTwoFilesPatch("/work/a b.txt", "/work/a b.txt", "", "hi")
    const text = meta(kilo.completed(part("write", patch, { exists: false }), standard))?.text as string
    expect(text?.split("\n").slice(1, 4)).toEqual(["new file mode 100644", "--- /dev/null", "+++ b/work/a b.txt\t"])
    expect(text).toContain("\\ No newline at end of file")
  })

  it("keeps the standard diff for other clients and tools", () => {
    const patch = createTwoFilesPatch("/work/a b.txt", "/work/a b.txt", "one\n", "uno\n")
    expect(harness().kilo.completed(part("edit", patch), standard)).toEqual(standard)
    expect(harness({ capabilities: air("diffPatch") }).kilo.completed(part("apply_patch", patch), standard)).toEqual(
      standard,
    )
  })

  it("quotes paths like git", () => {
    expect(gitPatch("/w/é.txt", "update", []).split("\n")[0]).toBe(
      'diff --git "a/w/\\303\\251.txt" "b/w/\\303\\251.txt"',
    )
  })
})
