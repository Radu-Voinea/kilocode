import { describe, expect, it } from "bun:test"
import { planEntries } from "@/kilocode/acp/plan"
import { air, event, harness } from "./harness"

type Todo = { content: string; status: string; priority: string }

const todo = (sessionID: string, todos: Todo[]) => event("todo.updated", { sessionID, todos })

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
    const { kilo, open, updates } = harness()
    await open("ses")
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
    const todos = [{ content: "x", status: "in_progress", priority: "medium" }]
    const { kilo, updates } = harness({ sdk: { session: { todo: async () => ({ data: todos }) } } })
    await kilo.replayed("ses", "/work")
    expect(updates).toEqual([
      {
        sessionId: "ses",
        update: { sessionUpdate: "plan", entries: [{ content: "x", status: "in_progress", priority: "medium" }] },
      },
    ])
  })

  it("advertises native subagents only when the client does", () => {
    expect(harness().kilo.agentMeta()).toBeUndefined()
    expect(harness({ capabilities: air("nativeSubagentSessions") }).kilo.agentMeta()).toEqual({
      jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } },
    })
  })
})
