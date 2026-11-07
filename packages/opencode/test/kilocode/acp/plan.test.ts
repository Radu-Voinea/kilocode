import { describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event, KiloClient } from "@kilocode/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPSession } from "@/acp/session"
import { Extensions } from "@/kilocode/acp/extensions"
import { planEntries } from "@/kilocode/acp/plan"
import { Subagents } from "@/kilocode/acp/subagents"

type Update = Parameters<AgentSideConnection["sessionUpdate"]>[0]

function harness(todos: Array<{ content: string; status: string; priority: string }> = []) {
  const updates: Update[] = []
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  const connection = { sessionUpdate: (params: Update) => (updates.push(params), Promise.resolve()) }
  const sdk = { session: { todo: async () => ({ data: todos }) } } as unknown as KiloClient
  const subagents = new Subagents({ connection, session })
  const kilo = new Extensions({ sdk, connection, session, subagents })
  return { kilo, session, updates }
}

const todo = (sessionID: string, todos: Array<{ content: string; status: string; priority: string }>) =>
  ({ id: "evt", type: "todo.updated", properties: { sessionID, todos } }) as Event

describe("acp plan", () => {
  it("maps statuses and priorities, dropping cancelled todos", () => {
    expect(
      planEntries([
        { content: "a", status: "pending", priority: "high" },
        { content: "b", status: "in_progress", priority: "odd" },
        { content: "c", status: "completed", priority: "low" },
        { content: "d", status: "cancelled", priority: "low" },
      ]),
    ).toEqual([
      { content: "a", status: "pending", priority: "high" },
      { content: "b", status: "in_progress", priority: "medium" },
      { content: "c", status: "completed", priority: "low" },
    ])
  })

  it("sends the full plan when a known session's todos change, once per change", async () => {
    const { kilo, session, updates } = harness()
    await Effect.runPromise(session.create({ id: "ses", cwd: "/work" }))
    const list = [{ content: "a", status: "pending", priority: "high" }]

    await kilo.handle(todo("ses", list))
    await kilo.handle(todo("ses", list))
    await kilo.handle(todo("other", list))
    await kilo.handle(todo("ses", [{ content: "a", status: "completed", priority: "high" }]))

    expect(updates.map((u) => [u.sessionId, u.update])).toEqual([
      ["ses", { sessionUpdate: "plan", entries: [{ content: "a", status: "pending", priority: "high" }] }],
      ["ses", { sessionUpdate: "plan", entries: [{ content: "a", status: "completed", priority: "high" }] }],
    ])
  })

  it("sends the stored plan on replay", async () => {
    const { kilo, updates } = harness([{ content: "x", status: "in_progress", priority: "medium" }])
    await kilo.replayed("ses", "/work")
    expect(updates).toEqual([
      {
        sessionId: "ses",
        update: { sessionUpdate: "plan", entries: [{ content: "x", status: "in_progress", priority: "medium" }] },
      },
    ])
  })

  it("advertises native subagents only when the client does", () => {
    const { kilo } = harness()
    expect(kilo.agentMeta()).toBeUndefined()
  })
})
