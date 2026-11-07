import type {
  AgentSideConnection,
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk"
import type { Event, KiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"

type SuggestionEvent = Extract<Event, { type: "suggestion.shown" }>
type Connection = Partial<Pick<AgentSideConnection, "unstable_createElicitation">>
type Content = NonNullable<Extract<CreateElicitationResponse, { action: "accept" }>["content"]>

const FIELD = "action"

// The suggest tool offers one or two follow-up actions and waits until the user picks one or
// dismisses it. ACP has no such prompt, so `suggestion.shown` was dropped and the tool waited
// forever. Clients with form elicitation get the actions as a single choice; for all others,
// and when the form is declined, the suggestion is dismissed so the turn continues.
export class SuggestionHandler {
  private readonly queues = new Map<string, Promise<void>>()
  private form = false

  constructor(
    private readonly input: {
      sdk: KiloClient
      connection: Connection
      session: ACPSession.Interface
      /** The ACP session that answers for a subagent's session, which the ACP layer doesn't know. */
      target?: (sessionId: string) => string | undefined
    },
  ) {}

  setClientCapabilities(capabilities: ClientCapabilities | undefined) {
    this.form = !!capabilities?.elicitation?.form
  }

  handle(event: SuggestionEvent) {
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

  private async process(event: SuggestionEvent) {
    const request = event.properties
    const target = this.input.target?.(request.sessionID) ?? request.sessionID
    const session = await Effect.runPromise(this.input.session.tryGet(target))
    if (!session) return

    const create = this.input.connection.unstable_createElicitation
    if (!this.form || !create) {
      await this.dismiss(request.id, session.cwd)
      return
    }

    const routed = session.id === request.sessionID ? request : { ...request, sessionID: session.id, tool: undefined }
    const result = await create.call(this.input.connection, buildSuggestionForm(routed)).catch(() => undefined)
    const index = result?.action === "accept" ? chosenAction(request.actions.length, result.content ?? {}) : undefined
    if (index === undefined) {
      await this.dismiss(request.id, session.cwd)
      return
    }
    await this.input.sdk.suggestion.accept({ requestID: request.id, index, directory: session.cwd })
  }

  // Kilo may have dismissed it already, for example because the user sent a new prompt.
  private async dismiss(requestID: string, directory: string) {
    await this.input.sdk.suggestion.dismiss({ requestID, directory }).catch(() => {})
  }
}

export function buildSuggestionForm(request: SuggestionEvent["properties"]): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId: request.sessionID,
    ...(request.tool ? { toolCallId: request.tool.callID } : {}),
    message: request.text,
    requestedSchema: {
      type: "object",
      properties: {
        [FIELD]: {
          type: "string",
          title: "Next step",
          description: request.text,
          oneOf: request.actions.map((action, index) => ({
            const: String(index),
            title: action.description ? `${action.label} — ${action.description}` : action.label,
          })),
        },
      },
      required: [FIELD],
    },
  }
}

export function chosenAction(count: number, content: Content) {
  const value = content[FIELD]
  const index = typeof value === "string" ? Number(value) : NaN
  return Number.isInteger(index) && index >= 0 && index < count ? index : undefined
}
