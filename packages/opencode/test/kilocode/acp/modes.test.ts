import { describe, expect, it } from "bun:test"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { UserMessage } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import { event, harness } from "./harness"

const user = (agent: string, modelID = "m1", variant?: string) =>
  ({
    id: "msg",
    sessionID: "ses",
    role: "user",
    time: { created: 0 },
    agent,
    model: { providerID: "p", modelID, ...(variant ? { variant } : {}) },
  }) as UserMessage

const options = (mode: string | undefined): SessionConfigOption[] => [
  {
    id: "mode",
    name: "Session Mode",
    type: "select",
    currentValue: mode ?? "plan",
    options: [
      { value: "plan", name: "plan" },
      { value: "code", name: "code" },
    ],
  },
]

function setup() {
  const h = harness()
  h.kilo.setConfigOptions(async (state) => options(state.modeId))
  return h
}

const updated = (info: UserMessage) => event("message.updated", { sessionID: info.sessionID, info })

describe("acp mode and model sync", () => {
  it("follows an agent switch that Kilo made itself", async () => {
    const { kilo, session, open, updates } = setup()
    await open("ses")
    await Effect.runPromise(session.setMode("ses", "plan"))
    await Effect.runPromise(session.setModel("ses", { providerID: "p", modelID: "m1" } as never))

    await kilo.handle(updated(user("plan")))
    expect(updates).toEqual([])

    await kilo.handle(updated(user("code")))
    expect(updates.map((u) => u.update)).toEqual([
      { sessionUpdate: "current_mode_update", currentModeId: "code" },
      { sessionUpdate: "config_option_update", configOptions: options("code") },
    ])
    expect((await Effect.runPromise(session.get("ses"))).modeId).toBe("code")
  })

  it("follows a model switch without a mode update", async () => {
    const { kilo, session, open, updates } = setup()
    await open("ses")
    await Effect.runPromise(session.setMode("ses", "code"))
    await Effect.runPromise(session.setModel("ses", { providerID: "p", modelID: "m1" } as never))

    await kilo.handle(updated(user("code", "m2", "high")))
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual(["config_option_update"])
    const state = await Effect.runPromise(session.get("ses"))
    expect(state.model).toEqual({ providerID: "p", modelID: "m2" } as never)
    expect(state.variant).toBe("high")
  })

  it("ignores agents the client does not offer as modes", async () => {
    const { kilo, session, open, updates } = setup()
    await open("ses")
    await Effect.runPromise(session.setMode("ses", "code"))
    await Effect.runPromise(session.setModel("ses", { providerID: "p", modelID: "m1" } as never))
    await kilo.handle(updated(user("compaction")))
    expect(updates).toEqual([])
  })
})

describe("acp plan follow-up", () => {
  it("is offered only to clients that answer forms", async () => {
    const { clientForms } = await import("@/kilocode/acp/client")
    harness({ capabilities: { elicitation: { form: {} } } })
    expect(clientForms()).toBe(true)
    harness({ capabilities: {} })
    expect(clientForms()).toBe(false)
  })
})
