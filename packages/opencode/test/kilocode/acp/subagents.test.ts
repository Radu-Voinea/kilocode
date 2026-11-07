import { describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { ToolPart } from "@kilocode/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPSession } from "@/acp/session"
import { Subagents, clientSupportsNativeSubagents } from "@/kilocode/acp/subagents"

type Update = Parameters<AgentSideConnection["sessionUpdate"]>[0]

const air = { _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } }

function harness(native: boolean) {
  const updates: Update[] = []
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  const subagents = new Subagents({
    connection: { sessionUpdate: (params: Update) => (updates.push(params), Promise.resolve()) },
    session,
  })
  subagents.setClientCapabilities(native ? air : {})
  return { subagents, session, updates }
}

function task(status: "running" | "completed" | "error", metadata: Record<string, unknown>, error = "") {
  const input = { description: "Echo check", prompt: "Run echo", subagent_type: "general" }
  const state =
    status === "running"
      ? { status, input, metadata, time: { start: 0 } }
      : status === "completed"
        ? { status, input, metadata, output: "", title: "", time: { start: 0, end: 1 } }
        : { status, input, metadata, error, time: { start: 0, end: 1 } }
  return {
    id: "prt",
    sessionID: "root",
    messageID: "msg",
    type: "tool",
    tool: "task",
    callID: "call",
    state,
  } as ToolPart
}

const updateKinds = (updates: Update[]) =>
  updates.map((u) => `${u.sessionId}:${(u.update as { sessionUpdate: string }).sessionUpdate}`)

describe("acp subagents", () => {
  it("detects the Air capability", () => {
    expect(clientSupportsNativeSubagents(air)).toBe(true)
    expect(clientSupportsNativeSubagents({ _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } })).toBe(
      false,
    )
    expect(clientSupportsNativeSubagents(undefined)).toBe(false)
  })

  it("announces a native subagent, routes its requests to itself, and ends it", async () => {
    const { subagents, session, updates } = harness(true)
    await subagents.onTaskPart("root", task("running", { sessionId: "child" }), "/work")

    expect(updateKinds(updates)).toEqual(["root:subagent_spawned"])
    expect(updates[0].update).toMatchObject({ subagentSessionId: "child", name: "Echo check", task: "Run echo" })
    expect(subagents.target("child")).toBe("child")
    expect(await Effect.runPromise(session.tryGet("child"))).toBeDefined()

    await subagents.onTaskPart("root", task("completed", { sessionId: "child" }), "/work")
    expect(updateKinds(updates)).toEqual(["root:subagent_spawned", "root:subagent_state_update"])
    expect(updates[1].update).toMatchObject({ state: "completed" })
    expect(subagents.target("child")).toBe("root")
    expect(await Effect.runPromise(session.tryGet("child"))).toBeUndefined()
  })

  it("keeps a background subagent open until its session goes idle", async () => {
    const { subagents, updates } = harness(true)
    await subagents.onTaskPart("root", task("completed", { sessionId: "child", background: true }), "/work")
    expect(updateKinds(updates)).toEqual(["root:subagent_spawned"])

    await subagents.onIdle("child")
    expect(updates[1].update).toMatchObject({ sessionUpdate: "subagent_state_update", state: "completed" })
  })

  it("reports a cancelled subagent", async () => {
    const { subagents, updates } = harness(true)
    await subagents.onTaskPart("root", task("error", { sessionId: "child" }, "Tool execution aborted"), "/work")
    expect(updates.at(-1)?.update).toMatchObject({ state: "cancelled" })
  })

  it("routes a hidden subagent and its nested subagents to the root session", async () => {
    const { subagents, session, updates } = harness(false)
    await subagents.onTaskPart("root", task("running", { sessionId: "child" }), "/work")
    await subagents.onUnknownPart("child", { ...task("running", { sessionId: "grandchild" }), sessionID: "child" })

    expect(updates).toEqual([])
    expect(subagents.target("child")).toBe("root")
    expect(subagents.target("grandchild")).toBe("root")
    expect(await Effect.runPromise(session.tryGet("child"))).toBeUndefined()
  })
})
