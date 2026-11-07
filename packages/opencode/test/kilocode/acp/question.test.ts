import { describe, expect, it } from "bun:test"
import type {
  AgentSideConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, KiloClient, QuestionInfo } from "@kilocode/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { buildElicitation, toAnswers } from "@/kilocode/acp/question"

type QuestionEvent = Extract<Event, { type: "question.asked" }>
type ReplyParams = Parameters<KiloClient["question"]["reply"]>[0]
type RejectParams = Parameters<KiloClient["question"]["reject"]>[0]
type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]

const pollUntil = async (check: () => boolean, message: string) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createHarness(elicit?: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse>, form = true) {
  const replies: ReplyParams[] = []
  const rejects: RejectParams[] = []
  const requests: CreateElicitationRequest[] = []
  const session = makeSessionService()
  const sdk = {
    question: {
      reply: (params: ReplyParams) => {
        replies.push(params)
        return Promise.resolve({ data: true })
      },
      reject: (params: RejectParams) => {
        rejects.push(params)
        return Promise.resolve({ data: true })
      },
    },
  } as unknown as KiloClient
  const connection = {
    sessionUpdate: (_params: SessionUpdateParams) => Promise.resolve(),
    ...(elicit
      ? {
          unstable_createElicitation: (params: CreateElicitationRequest) => {
            requests.push(params)
            return elicit(params)
          },
        }
      : {}),
  }
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })
  subscription.setClientCapabilities(form ? { elicitation: { form: {} } } : {})
  return { replies, rejects, requests, session, subscription }
}

const single: QuestionInfo = {
  question: "Approve the force-push?",
  header: "Push",
  options: [
    { label: "Yes", description: "Push now" },
    { label: "No", description: "Keep it local" },
  ],
}

const multi: QuestionInfo = {
  question: "Which checks should run?",
  header: "Checks",
  multiple: true,
  custom: false,
  options: [
    { label: "Lint", description: "" },
    { label: "Tests", description: "" },
  ],
}

function questionAsked(sessionID: string, id: string, questions: QuestionInfo[]): QuestionEvent {
  return {
    id: `evt_${id}`,
    type: "question.asked",
    properties: { id, sessionID, questions, tool: { messageID: "msg_1", callID: "call_1" } },
  } as QuestionEvent
}

describe("acp question elicitation", () => {
  it("maps questions to a form schema", () => {
    const request = buildElicitation(questionAsked("ses_1", "que_1", [single, multi]).properties)

    expect(request).toMatchObject({ mode: "form", sessionId: "ses_1", toolCallId: "call_1" })
    if (request.mode !== "form") throw new Error("expected form")
    expect(request.requestedSchema.properties?.q0).toMatchObject({
      type: "string",
      title: "Push",
      oneOf: [
        { const: "Yes", title: "Yes — Push now" },
        { const: "No", title: "No — Keep it local" },
      ],
    })
    expect(request.requestedSchema.properties?.q0_custom).toMatchObject({
      type: "string",
      _meta: {
        _askUserQuestionCustomAnswer: { questionId: "q0", isCustomAnswer: true },
        jetbrains: { air: { version: 1, customAnswer: { questionId: "q0", isCustomAnswer: true } } },
      },
    })
    expect(request.requestedSchema.properties?.q1).toMatchObject({
      type: "array",
      items: { anyOf: [{ const: "Lint" }, { const: "Tests" }] },
    })
    expect(request.requestedSchema.properties?.q1_custom).toBeUndefined()
    expect(request.requestedSchema.required).toEqual(["q1"])
  })

  it("keeps typed text alongside the selection", () => {
    const multiCustom = { ...multi, custom: true }
    expect(
      toAnswers([single, multiCustom], { q0: "Yes", q0_custom: " later ", q1: ["Lint"], q1_custom: "Build" }),
    ).toEqual([
      ["Yes", "later"],
      ["Lint", "Build"],
    ])
    expect(toAnswers([single], { q0_custom: "Something else" })).toEqual([["Something else"]])
    expect(toAnswers([single, multi], { q0: "No", q1: [] })).toEqual([["No"], []])
  })

  it("replies with the accepted answers", async () => {
    const harness = createHarness(() => Promise.resolve({ action: "accept", content: { q0: "Yes" } }))
    await Effect.runPromise(harness.session.create({ id: "ses_1", cwd: "/workspace" }))

    await harness.subscription.handle(questionAsked("ses_1", "que_1", [single]))
    await pollUntil(() => harness.replies.length === 1, "question was not answered")

    expect(harness.requests).toHaveLength(1)
    expect(harness.replies[0]).toEqual({ requestID: "que_1", directory: "/workspace", answers: [["Yes"]] })
    expect(harness.rejects).toHaveLength(0)
  })

  it("rejects when the user declines", async () => {
    const harness = createHarness(() => Promise.resolve({ action: "decline" }))
    await Effect.runPromise(harness.session.create({ id: "ses_1", cwd: "/workspace" }))

    await harness.subscription.handle(questionAsked("ses_1", "que_1", [single]))
    await pollUntil(() => harness.rejects.length === 1, "question was not rejected")

    expect(harness.replies).toHaveLength(0)
  })

  it("rejects instead of hanging when the client cannot render forms", async () => {
    const harness = createHarness(() => Promise.resolve({ action: "accept", content: {} }), false)
    await Effect.runPromise(harness.session.create({ id: "ses_1", cwd: "/workspace" }))

    await harness.subscription.handle(questionAsked("ses_1", "que_1", [single]))
    await pollUntil(() => harness.rejects.length === 1, "question was not rejected")

    expect(harness.requests).toHaveLength(0)
  })
})
