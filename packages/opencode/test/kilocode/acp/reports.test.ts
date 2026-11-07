import { describe, expect, it } from "bun:test"
import type { Part } from "@kilocode/sdk/v2"
import { requestId } from "@/kilocode/acp/reports"
import { air, event, harness } from "./harness"

const request = (id: string) => ({
  jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: id } } },
})

const patch = (files: string[]) =>
  ({ id: "prt_p", sessionID: "ses", messageID: "msg", type: "patch", hash: "h", files }) as Part

const edit = (file: string) =>
  ({
    id: "prt_e",
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    tool: "edit",
    callID: "call",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: { filediff: { file } },
      time: { start: 0, end: 1 },
    },
  }) as Part

const reportOf = (update: { update: unknown }) =>
  (update.update as { _meta: { jetbrains: { air: { agentFileChangeReport: unknown } } } })._meta.jetbrains.air
    .agentFileChangeReport

describe("acp file change report", () => {
  it("reads Air's request id", () => {
    expect(requestId(request("req-1"))).toBe("req-1")
    expect(requestId(request("bad id"))).toBeUndefined()
    expect(requestId({})).toBeUndefined()
  })

  it("reports the files a turn changed inside the session directory", async () => {
    const { kilo, updates } = harness({ capabilities: air("agentFileChangeReport") })
    expect(kilo.agentMeta()).toEqual({ jetbrains: { air: { version: 1, capabilities: ["agentFileChangeReport"] } } })
    kilo.promptStarted("ses", request("req-1"))
    await kilo.handle(
      event("message.part.updated", { sessionID: "ses", part: patch(["/work/a.ts", "/elsewhere/x"]), time: 0 }),
    )
    await kilo.handle(event("message.part.updated", { sessionID: "ses", part: edit("/work/b.ts"), time: 0 }))
    await kilo.handle(event("message.part.updated", { sessionID: "ses", part: patch(["/work/a.ts"]), time: 0 }))
    await kilo.promptEnded("ses", "/work")

    expect(updates).toHaveLength(1)
    expect(updates[0].update).toMatchObject({ sessionUpdate: "session_info_update" })
    expect(reportOf(updates[0])).toEqual({
      version: 1,
      requestId: "req-1",
      status: "reported",
      paths: ["/work/a.ts", "/work/b.ts"],
      declaredComplete: false,
      truncated: true,
    })
  })

  it("reports a cancelled turn as unavailable", async () => {
    const { kilo, updates } = harness({ capabilities: air("agentFileChangeReport") })
    kilo.promptStarted("ses", request("req-2"))
    await kilo.promptEnded("ses", "/work", "cancelled")
    expect(reportOf(updates[0])).toEqual({ version: 1, requestId: "req-2", status: "unavailable", reason: "cancelled" })
  })

  it("sends nothing without a request or the capability", async () => {
    const plain = harness()
    plain.kilo.promptStarted("ses", request("req-3"))
    await plain.kilo.promptEnded("ses", "/work")
    const unasked = harness({ capabilities: air("agentFileChangeReport") })
    unasked.kilo.promptStarted("ses", {})
    await unasked.kilo.promptEnded("ses", "/work")
    expect([...plain.updates, ...unasked.updates]).toEqual([])
  })
})
