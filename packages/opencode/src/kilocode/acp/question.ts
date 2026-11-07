import type {
  AgentSideConnection,
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk"
import type { Event, KiloClient, QuestionAnswer, QuestionInfo } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"

type QuestionEvent = Extract<Event, { type: "question.asked" }>
type Connection = Partial<Pick<AgentSideConnection, "unstable_createElicitation">>
type Content = NonNullable<Extract<CreateElicitationResponse, { action: "accept" }>["content"]>

const CUSTOM_SUFFIX = "_custom"

// The question tool has no ACP counterpart, so without this handler `question.asked` events
// were dropped and the agent waited forever on an answer the client could not give. Clients
// that advertise form elicitation get a real form; all others get the question rejected so
// the turn continues instead of hanging.
export class QuestionHandler {
  private readonly queues = new Map<string, Promise<void>>()
  private form = false

  constructor(
    private readonly input: {
      sdk: KiloClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  setClientCapabilities(capabilities: ClientCapabilities | undefined) {
    this.form = !!capabilities?.elicitation?.form
  }

  handle(event: QuestionEvent) {
    const request = event.properties
    const previous = this.queues.get(request.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(request.sessionID) === next) this.queues.delete(request.sessionID)
      })
    this.queues.set(request.sessionID, next)
  }

  private async process(event: QuestionEvent) {
    const request = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(request.sessionID))
    if (!session) return

    const create = this.input.connection.unstable_createElicitation
    if (!this.form || !create) {
      await this.reject(request.id, session.cwd)
      return
    }

    const result = await create.call(this.input.connection, buildElicitation(request)).catch(() => undefined)

    if (result?.action !== "accept") {
      await this.reject(request.id, session.cwd)
      return
    }

    await this.input.sdk.question.reply({
      requestID: request.id,
      directory: session.cwd,
      answers: toAnswers(request.questions, result.content ?? {}),
    })
  }

  private async reject(requestID: string, directory: string) {
    await this.input.sdk.question.reject({ requestID, directory })
  }
}

export function buildElicitation(request: QuestionEvent["properties"]): CreateElicitationRequest {
  const properties: Record<string, ElicitationPropertySchema> = {}
  const required: string[] = []

  request.questions.forEach((question, index) => {
    const key = questionKey(index)
    const choices = question.options.map((option) => ({
      const: option.label,
      title: option.description ? `${option.label} — ${option.description}` : option.label,
    }))
    const custom = question.custom !== false

    if (question.multiple) {
      properties[key] = {
        type: "array",
        title: question.header,
        description: question.question,
        items: { anyOf: choices },
      }
    } else {
      properties[key] = {
        type: "string",
        title: question.header,
        description: question.question,
        oneOf: choices,
        ...(question.default && question.options.some((o) => o.label === question.default)
          ? { default: question.default }
          : {}),
      }
    }

    if (custom) {
      // JetBrains Air folds a field marked this way into the question it names, as a free-text
      // answer, instead of showing it as a separate page. Released Air versions read the root
      // key, newer ones the jetbrains.air one. Other clients ignore the _meta.
      const customAnswer = { questionId: key, isCustomAnswer: true }
      const field = {
        type: "string",
        title: "Other",
        description: "Type your own answer instead",
        _meta: {
          _askUserQuestionCustomAnswer: customAnswer,
          jetbrains: { air: { version: 1, customAnswer } },
        },
      }
      properties[key + CUSTOM_SUFFIX] = field as ElicitationPropertySchema
    } else {
      required.push(key)
    }
  })

  return {
    mode: "form",
    sessionId: request.sessionID,
    ...(request.tool ? { toolCallId: request.tool.callID } : {}),
    message: request.questions.length === 1 ? request.questions[0].question : "The agent has a few questions",
    requestedSchema: { type: "object", properties, required },
  }
}

export function toAnswers(questions: readonly QuestionInfo[], content: Content): QuestionAnswer[] {
  return questions.map((question, index) => {
    const key = questionKey(index)
    const value = content[key]
    const selected = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []
    const custom = content[key + CUSTOM_SUFFIX]
    const typed = typeof custom === "string" ? custom.trim() : ""

    // Air labels the text box "Add a note to your answer" once an option is picked, so typed
    // text is kept alongside the selection rather than replacing it.
    return typed ? [...selected, typed] : selected
  })
}

function questionKey(index: number) {
  return `q${index}`
}
