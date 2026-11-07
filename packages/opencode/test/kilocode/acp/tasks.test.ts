import { describe, expect, it } from "bun:test"
import type { ToolCallUpdate } from "@agentclientprotocol/sdk"
import type { BackgroundProcessInfo, ToolPart } from "@kilocode/sdk/v2"
import { handle } from "@/kilocode/acp/methods"
import { air, event, harness } from "./harness"

const tool = (name: string, input: Record<string, unknown>, metadata: Record<string, unknown>) =>
  ({
    id: "prt",
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    tool: name,
    callID: `call_${name}`,
    state: { status: "completed", input, output: "", title: "", metadata, time: { start: 0, end: 1 } },
  }) as ToolPart

const proc = (status: BackgroundProcessInfo["status"], exitCode?: number) =>
  ({
    id: "bgp_1",
    sessionID: "ses",
    command: "sleep 20",
    cwd: "/work",
    ports: [],
    status,
    lifetime: "session",
    ready: false,
    output: "",
    time: { started: 0, updated: 0 },
    ...(exitCode === undefined ? {} : { exitCode }),
  }) as BackgroundProcessInfo

function setup() {
  const calls: string[] = []
  const sdk = {
    backgroundProcess: { stop: async (p: { processID: string }) => (calls.push(`stop ${p.processID}`), {}) },
    session: { abort: async (p: { sessionID: string }) => (calls.push(`abort ${p.sessionID}`), {}) },
  }
  const h = harness({ sdk, capabilities: air("asyncTasks") })
  return { ...h, calls }
}

const kinds = (updates: { update: unknown }[]) =>
  updates.map((u) => {
    const update = u.update as { sessionUpdate: string; state?: string }
    return update.state ? `${update.sessionUpdate}:${update.state}` : update.sessionUpdate
  })

describe("acp async tasks", () => {
  it("shows a background process as a task and ends it with its exit", async () => {
    const { kilo, open, updates } = setup()
    await open("ses")
    expect(kilo.agentMeta()).toEqual({ jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } })

    await kilo.handle(event("background_process.updated", { info: proc("running"), scope: "s" }))
    await kilo.handle(
      event("message.part.updated", {
        sessionID: "ses",
        part: tool("background_process", { action: "start", command: "sleep 20" }, { processID: "bgp_1" }),
        time: 0,
      }),
    )
    await kilo.handle(event("background_process.updated", { info: proc("exited", 1), scope: "s" }))

    expect(kinds(updates)).toEqual(["async_task_spawned", "async_task_progress", "async_task_state_update:failed"])
    expect(updates[0].update).toMatchObject({
      asyncTaskId: "process:bgp_1",
      name: "sleep 20",
      taskType: "shell",
      canStop: true,
    })
    expect(updates[1].update).toMatchObject({ toolCallId: "call_background_process" })
    expect(updates[2].update).toMatchObject({ summary: "Exited with code 1" })
  })

  it("marks the launching tool call as backgrounded", () => {
    const { kilo } = setup()
    const part = tool("task", { description: "Scan" }, { background: true, sessionId: "child" })
    const update: ToolCallUpdate = { toolCallId: "call_task", status: "completed" }
    expect(kilo.completed(part, update)._meta).toEqual({
      jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } },
    })
  })

  it("stops a background subagent from the client", async () => {
    const { kilo, open, updates, calls } = setup()
    await open("ses")
    await kilo.handle(
      event("message.part.updated", {
        sessionID: "ses",
        part: tool("task", { description: "Scan" }, { background: true, sessionId: "child" }),
        time: 0,
      }),
    )
    const ctx = { sdk: {} as never, session: {} as never, extensions: kilo, prompt: async () => ({}) as never }
    expect(await handle("_session/async_task/stop", { sessionId: "ses", asyncTaskId: "agent:child" }, ctx)).toEqual({
      stopped: true,
    })
    expect(await handle("_session/async_task/stop", { sessionId: "ses", asyncTaskId: "agent:child" }, ctx)).toEqual({
      stopped: false,
    })
    await kilo.handle(event("session.status", { sessionID: "child", status: { type: "idle" } }))
    expect(calls).toEqual(["abort child"])
    expect(kinds(updates)).toEqual(["async_task_spawned", "async_task_state_update:stopped"])
  })

  it("leaves other clients alone", async () => {
    const h = harness()
    await h.open("ses")
    await h.kilo.handle(event("background_process.updated", { info: proc("running"), scope: "s" }))
    expect(h.updates).toEqual([])
  })
})
