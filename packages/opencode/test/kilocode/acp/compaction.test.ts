import { describe, expect, it } from "bun:test"
import type { AssistantMessage, CompactionPart, SessionMessageResponse } from "@kilocode/sdk/v2"
import { air, event, harness } from "./harness"

const part = (auto = false) =>
  ({ id: "prt_c", sessionID: "ses", messageID: "msg_u", type: "compaction", auto }) as CompactionPart

const summary = (extra: Partial<AssistantMessage> = {}) =>
  ({
    id: "msg_s",
    sessionID: "ses",
    role: "assistant",
    summary: true,
    time: { created: 1_000, completed: 1_500 },
    tokens: { input: 700, output: 100, reasoning: 0, cache: { read: 50, write: 0 } },
    ...extra,
  }) as AssistantMessage

const kinds = (updates: { update: { sessionUpdate: string } }[]) => updates.map((u) => u.update.sessionUpdate)

describe("acp context compaction", () => {
  it("shows a compaction as Air's tool call and keeps the summary out of the chat", async () => {
    const { kilo, open, updates } = harness({ capabilities: air() })
    await open("ses")

    await kilo.handle(event("message.part.updated", { sessionID: "ses", part: part(true), time: 0 }))
    await kilo.handle(event("message.updated", { sessionID: "ses", info: summary() }))
    expect(kilo.delta("ses", "msg_s", "text", "text", "The summary")).toBe(true)
    expect(kilo.delta("ses", "msg_other", "text", "text", "chat")).toBe(false)
    await kilo.handle(event("session.compacted", { sessionID: "ses" }))

    expect(kinds(updates)).toEqual(["tool_call", "tool_call_update"])
    expect(updates[0].update).toMatchObject({
      title: "Compact conversation",
      status: "in_progress",
      _meta: { jetbrains: { air: { contextCompaction: { version: 1, trigger: "automatic" } } } },
    })
    expect(updates[1].update).toMatchObject({
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "The summary" } }],
      _meta: {
        jetbrains: {
          air: {
            contextCompaction: { version: 1, trigger: "automatic", preTokens: 750, postTokens: 100, durationMs: 500 },
          },
        },
      },
    })
  })

  it("reports a failed compaction", async () => {
    const { kilo, open, updates } = harness({ capabilities: air() })
    await open("ses")
    await kilo.handle(event("message.part.updated", { sessionID: "ses", part: part(), time: 0 }))
    await kilo.handle(
      event("message.updated", {
        sessionID: "ses",
        info: summary({ error: { name: "MessageAbortedError", data: { message: "aborted" } } }),
      }),
    )
    expect(updates.at(-1)?.update).toMatchObject({
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Compaction failed: Compaction was cancelled" } }],
    })
  })

  it("leaves other clients' compaction as chat text", async () => {
    const { kilo, open, updates } = harness()
    await open("ses")
    await kilo.handle(event("message.part.updated", { sessionID: "ses", part: part(), time: 0 }))
    await kilo.handle(event("message.updated", { sessionID: "ses", info: summary() }))
    expect(kilo.delta("ses", "msg_s", "text", "text", "The summary")).toBe(false)
    expect(updates).toEqual([])
  })

  it("replays a stored compaction as its tool call", async () => {
    const { kilo, updates } = harness({ capabilities: air() })
    const user = { info: { id: "msg_u", sessionID: "ses", role: "user" }, parts: [part()] } as SessionMessageResponse
    const reply = {
      info: summary(),
      parts: [{ id: "prt_t", sessionID: "ses", messageID: "msg_s", type: "text", text: "Stored summary" }],
    } as SessionMessageResponse
    expect(await kilo.replay(user)).toBe(true)
    expect(await kilo.replay(reply)).toBe(true)
    expect(kinds(updates)).toEqual(["tool_call", "tool_call_update"])
    expect(updates[1].update).toMatchObject({
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Stored summary" } }],
    })
  })
})
