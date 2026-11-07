import { describe, expect, it } from "bun:test"
import type { Session } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import { handle } from "@/kilocode/acp/methods"
import { listOptions } from "@/kilocode/acp/sessions"
import { air, event, harness } from "./harness"

const info = (id: string, updated: number, extra: Partial<Session> = {}) =>
  ({ id, title: `T ${id}`, directory: "/work", time: { created: 0, updated }, ...extra }) as Session

function setup() {
  const calls: unknown[] = []
  const store = new Map([
    ["a", info("a", 3)],
    ["b", info("b", 2, { time: { created: 0, updated: 2, archived: 5 } })],
    ["c", info("c", 1)],
    ["d", info("d", 4, { directory: "/other" })],
  ])
  const sdk = {
    session: {
      list: async () => ({ data: [...store.values()] }),
      get: async (p: { sessionID: string }) => ({ data: store.get(p.sessionID) }),
      update: async (p: unknown) => (calls.push(["update", p]), { data: {} }),
      abort: async (p: unknown) => (calls.push(["abort", p]), { data: true }),
    },
  }
  const cleared: string[] = []
  const unarchive = async (id: string) => {
    cleared.push(id)
  }
  const h = harness({ sdk, capabilities: air("sessionIndex"), unarchive })
  const ctx = { sdk: sdk as never, session: h.session, extensions: h.kilo, prompt: async () => ({}) as never }
  return { ...h, ctx, calls, cleared, store }
}

const meta = (row: { _meta?: unknown }) => (row._meta as { jetbrains: { air: Record<string, unknown> } }).jetbrains.air

describe("acp session index", () => {
  it("advertises the index only to a client that declares it", () => {
    expect(setup().kilo.agentMeta()).toEqual({
      jetbrains: {
        air: { version: 1, capabilities: ["sessionIndex", "sessionArchive", "sessionRename", "sessionListSubscribe"] },
      },
    })
    expect(harness().kilo.agentMeta()).toBeUndefined()
  })

  it("lists a cwd's sessions newest first, with the archive filter and paging", async () => {
    const { kilo } = setup()
    const first = await kilo.list({ cwd: "/work", _meta: { jetbrains: { air: { list: { limit: 1 } } } } })
    expect(first?.sessions.map((row) => row.sessionId)).toEqual(["a"])
    expect(meta(first!.sessions[0])).toEqual({ version: 1, archived: false, state: "idle" })
    const next = await kilo.list({ cwd: "/work", cursor: first?.nextCursor })
    expect(next?.sessions.map((row) => row.sessionId)).toEqual(["c"])
    const archived = await kilo.list({
      cwd: "/work",
      _meta: { jetbrains: { air: { list: { archived: "archived" } } } },
    })
    expect(archived?.sessions.map((row) => row.sessionId)).toEqual(["b"])
    expect(() => listOptions({ jetbrains: { air: { list: { archived: "nope" } } } })).toThrow()
  })

  it("renames and archives through Kilo, and unarchives in process", async () => {
    const { ctx, calls, cleared, open, updates, session } = setup()
    await open("a")
    expect(await handle("_session/rename", { sessionId: "a", title: "  New   name " }, ctx)).toEqual({})
    expect(await handle("_session/archive", { sessionId: "a" }, ctx)).toEqual({})
    expect(calls).toEqual([
      ["update", { sessionID: "a", directory: "/work", title: "New name" }],
      ["abort", { sessionID: "a", directory: "/work" }],
      ["update", { sessionID: "a", directory: "/work", time: { archived: expect.any(Number) } }],
    ])
    expect(updates.at(-1)?.update).toEqual({
      sessionUpdate: "session_info_update",
      _meta: { jetbrains: { air: { version: 1, archived: true } } },
    })
    expect(await Effect.runPromise(session.tryGet("a"))).toBeUndefined()
    expect(await handle("_session/unarchive", { sessionId: "b" }, ctx)).toEqual({})
    expect(cleared).toEqual(["b"])
  })

  it("pushes the rows that changed to a subscription", async () => {
    const { kilo, ctx, notes } = setup()
    const { subscriptionId } = (await handle("_session/list/subscribe", { cwd: "/work" }, ctx)) as {
      subscriptionId: string
    }
    await kilo.handle(event("session.updated", { sessionID: "a", info: info("a", 9, { title: "Renamed" }) }))
    await kilo.handle(event("session.updated", { sessionID: "d", info: info("d", 9, { directory: "/other" }) }))
    await kilo.handle(event("session.status", { sessionID: "a", status: { type: "busy" } }))
    await Bun.sleep(250)
    expect(notes).toHaveLength(1)
    const [method, params] = notes[0] as [
      string,
      { subscriptionId: string; sessions: { sessionId: string; title: string; _meta?: unknown }[] },
    ]
    expect(method).toBe("_session/list/changes")
    expect(params.subscriptionId).toBe(subscriptionId)
    expect(params.sessions.map((row) => [row.sessionId, row.title, meta(row).state])).toEqual([
      ["a", "Renamed", "running"],
    ])

    await kilo.handle(event("session.deleted", { sessionID: "a", info: info("a", 9) }))
    await Bun.sleep(250)
    expect(notes.at(-1)).toEqual(["_session/list/changes", { subscriptionId, sessions: [], removed: ["a"] }])
    expect(await handle("_session/list/unsubscribe", { subscriptionId }, ctx)).toEqual({})
  })

  it("keeps the plain list for other clients", async () => {
    const h = harness()
    expect(await h.kilo.list({ cwd: "/work" })).toBeUndefined()
    const ctx = { sdk: {} as never, session: h.session, extensions: h.kilo, prompt: async () => ({}) as never }
    await expect(handle("_session/rename", { sessionId: "a", title: "x" }, ctx)).rejects.toThrow()
  })
})
