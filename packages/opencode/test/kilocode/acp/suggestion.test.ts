import { describe, expect, it } from "bun:test"
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk"
import type { Event, KiloClient } from "@kilocode/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPSession } from "@/acp/session"
import { SuggestionHandler, buildSuggestionForm, chosenAction } from "@/kilocode/acp/suggestion"

type SuggestionEvent = Extract<Event, { type: "suggestion.shown" }>

const pollUntil = async (check: () => boolean, message: string) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function shown(sessionID = "ses_1"): SuggestionEvent {
  return {
    id: "evt_1",
    type: "suggestion.shown",
    properties: {
      id: "sug_1",
      sessionID,
      text: "Run the tests?",
      actions: [
        { label: "Run tests", description: "Run the module tests", prompt: "run the tests" },
        { label: "Skip", prompt: "skip" },
      ],
      blocking: false,
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  } as SuggestionEvent
}

async function harness(elicit: (() => Promise<CreateElicitationResponse>) | undefined, form = true) {
  const accepted: { requestID: string; index: number }[] = []
  const dismissed: string[] = []
  const requests: CreateElicitationRequest[] = []
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  await Effect.runPromise(session.create({ id: "ses_1", cwd: "/workspace" }))
  const sdk = {
    suggestion: {
      accept: (params: { requestID: string; index: number }) => (accepted.push(params), Promise.resolve({})),
      dismiss: (params: { requestID: string }) => (dismissed.push(params.requestID), Promise.resolve({})),
    },
  } as unknown as KiloClient
  const connection = elicit
    ? { unstable_createElicitation: (params: CreateElicitationRequest) => (requests.push(params), elicit()) }
    : {}
  const handler = new SuggestionHandler({ sdk, connection, session })
  handler.setClientCapabilities(form ? { elicitation: { form: {} } } : {})
  return { handler, accepted, dismissed, requests }
}

describe("acp suggestions", () => {
  it("offers the actions as one choice", () => {
    const form = buildSuggestionForm(shown().properties)
    expect(form).toMatchObject({ mode: "form", sessionId: "ses_1", toolCallId: "call_1", message: "Run the tests?" })
    if (form.mode !== "form") throw new Error("expected form")
    expect(form.requestedSchema.properties?.action).toMatchObject({
      oneOf: [
        { const: "0", title: "Run tests — Run the module tests" },
        { const: "1", title: "Skip" },
      ],
    })
  })

  it("reads only a valid action index", () => {
    expect(chosenAction(2, { action: "1" })).toBe(1)
    expect(chosenAction(2, { action: "2" })).toBeUndefined()
    expect(chosenAction(2, {})).toBeUndefined()
  })

  it("accepts the chosen action", async () => {
    const h = await harness(() => Promise.resolve({ action: "accept", content: { action: "0" } }))
    h.handler.handle(shown())
    await pollUntil(() => h.accepted.length === 1, "suggestion was not accepted")
    expect(h.accepted[0]).toMatchObject({ requestID: "sug_1", index: 0 })
    expect(h.dismissed).toEqual([])
  })

  it("dismisses when the form is skipped", async () => {
    const h = await harness(() => Promise.resolve({ action: "decline" }))
    h.handler.handle(shown())
    await pollUntil(() => h.dismissed.length === 1, "suggestion was not dismissed")
    expect(h.accepted).toEqual([])
  })

  it("dismisses instead of hanging when the client cannot render forms", async () => {
    const h = await harness(() => Promise.resolve({ action: "accept", content: { action: "0" } }), false)
    h.handler.handle(shown())
    await pollUntil(() => h.dismissed.length === 1, "suggestion was not dismissed")
    expect(h.requests).toEqual([])
  })
})
