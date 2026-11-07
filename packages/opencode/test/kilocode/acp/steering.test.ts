import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import { handle } from "@/kilocode/acp/methods"
import { event, harness } from "./harness"

function setup() {
  const sent: unknown[] = []
  const prompts: unknown[] = []
  const sdk = { session: { promptAsync: async (body: unknown) => (sent.push(body), { data: undefined }) } }
  const h = harness({ sdk })
  const ctx = {
    sdk: sdk as unknown as KiloClient,
    session: h.session,
    extensions: h.kilo,
    prompt: async (params: unknown) => (prompts.push(params), { stopReason: "end_turn" as const }),
  }
  return { ...h, ctx, sent, prompts }
}

const text = [{ type: "text", text: "also do this" }]

describe("acp steering", () => {
  it("queues the message into the running turn", async () => {
    const { kilo, session, open, ctx, sent } = setup()
    await open("ses")
    await Effect.runPromise(session.setMode("ses", "code"))
    await kilo.handle(event("session.status", { sessionID: "ses", status: { type: "busy" } }))

    expect(await handle("_session/steering", { sessionId: "ses", prompt: text }, ctx)).toEqual({ outcome: "injected" })
    expect(sent).toEqual([
      { sessionID: "ses", directory: "/work", parts: [{ type: "text", text: "also do this" }], agent: "code" },
    ])
  })

  it("starts a turn, or hands the message back, when none is running", async () => {
    const { open, ctx, prompts } = setup()
    await open("ses")
    expect(await handle("_session/steering", { sessionId: "ses", prompt: text }, ctx)).toEqual({
      outcome: "startedNewTurn",
    })
    expect(prompts).toEqual([{ sessionId: "ses", prompt: text }])
    expect(
      await handle(
        "_session/steering",
        { sessionId: "ses", prompt: text, _meta: { steering: { idleBehavior: "promptRequired" } } },
        ctx,
      ),
    ).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" })
  })

  it("rejects bad requests and unknown methods", async () => {
    const { ctx } = setup()
    await expect(handle("_session/steering", { sessionId: "ses", prompt: [] }, ctx)).rejects.toThrow()
    await expect(handle("_session/steering", { sessionId: "missing", prompt: text }, ctx)).rejects.toThrow()
    await expect(handle("_nope", {}, ctx)).rejects.toThrow()
  })
})

describe("acp steered turn", () => {
  const status = (type: "busy" | "idle") => event("session.status", { sessionID: "ses", status: { type } })
  const user = event("message.updated", {
    sessionID: "ses",
    info: { id: "msg", sessionID: "ses", role: "user", time: { created: 0 }, agent: "code" } as never,
  })

  it("settles after the turn that runs the steered message", async () => {
    const { kilo } = setup()
    const order: string[] = []
    await kilo.handle(status("busy"))
    kilo.steering.steered("ses")
    void kilo.steering.settled("ses").then(() => order.push("settled"))
    await kilo.handle(user)
    await kilo.handle(status("idle"))
    await kilo.handle(status("busy"))
    await Bun.sleep(5)
    expect(order).toEqual([])
    await kilo.handle(status("idle"))
    await Bun.sleep(5)
    expect(order).toEqual(["settled"])
  })

  it("settles when the session stays idle without running the steered message", async () => {
    const { kilo } = setup()
    kilo.steering.steered("ses")
    const settled = kilo.steering.settled("ses")
    await kilo.handle(status("idle"))
    await settled
  })
})
