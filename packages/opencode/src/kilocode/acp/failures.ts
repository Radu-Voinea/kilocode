import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AssistantMessage } from "@kilocode/sdk/v2"
import { withAir } from "./air"

type Connection = Pick<AgentSideConnection, "sessionUpdate">
type Error = NonNullable<AssistantMessage["error"]>

export const CAPABILITY = "sessionFailure"

type Kind =
  | "access_denied"
  | "bad_request"
  | "context_exhausted"
  | "internal_error"
  | "overloaded"
  | "provider_error"
  | "quota_exhausted"
  | "rate_limited"

// Category, actions and fallback title per failure kind, as Air's Claude adapter defines them.
const POLICY: Record<Kind, { category: string; actions: string[]; title: string }> = {
  access_denied: { category: "service", actions: ["retry"], title: "Kilo could not access the provider credentials." },
  bad_request: { category: "request", actions: [], title: "The model provider could not process this request." },
  context_exhausted: {
    category: "limit",
    actions: ["new_session"],
    title: "The conversation no longer fits in the model's context.",
  },
  internal_error: {
    category: "service",
    actions: ["retry", "new_session"],
    title: "Kilo encountered an internal error.",
  },
  overloaded: { category: "service", actions: ["retry"], title: "The model provider is temporarily overloaded." },
  provider_error: { category: "service", actions: ["retry"], title: "The model provider reported an error." },
  quota_exhausted: { category: "limit", actions: [], title: "The account has no credits or quota left." },
  rate_limited: { category: "limit", actions: ["retry"], title: "The model provider is rate limiting requests." },
}

/** The Air failure kind of a Kilo error, or undefined when the turn ends without one. */
export function failureKind(error: Error): Kind | undefined {
  switch (error.name) {
    case "MessageAbortedError":
    case "MessageOutputLengthError":
    case "ContentFilterError":
    case "ProviderAuthError":
      return undefined
    case "ContextOverflowError":
      return "context_exhausted"
    case "StructuredOutputError":
      return "bad_request"
    case "UnknownError":
      return "internal_error"
    case "APIError":
      return statusKind(error.data.statusCode, error.data.message)
  }
}

function statusKind(status: number | undefined, message: string): Kind {
  if (status === 401 || status === 403) return "access_denied"
  if (status === 402) return "quota_exhausted"
  if (status === 429) return "rate_limited"
  if (status === 503 || status === 529) return "overloaded"
  if (status === 400 || status === 404 || status === 413 || status === 422) return "bad_request"
  if (/rate.?limit|too many requests/i.test(message)) return "rate_limited"
  if (/overloaded/i.test(message)) return "overloaded"
  return "provider_error"
}

/** A short title and the rest as details, as Air shows them. */
function text(message: string | undefined, fallback: string) {
  const trimmed = message?.trim()
  if (!trimmed) return { title: fallback }
  const [first, ...rest] = trimmed.split(/\r?\n/)
  if (first.length > 256) return { title: fallback, details: trimmed }
  const details = rest.join("\n").trim()
  return details ? { title: first, details } : { title: first }
}

/**
 * Air shows a failed turn and a retry in progress from `_meta.jetbrains.air.sessionFailure`: on the
 * prompt response when a turn fails, and on a `session_info_update` while Kilo retries. A turn's
 * retries and its final error share one id, so each new revision replaces the last.
 */
export class Failures {
  private readonly turns = new Map<string, { n: number; open: boolean }>()
  private readonly revisions = new Map<string, number>()

  constructor(
    private readonly input: { connection: Connection },
    private readonly enabled: () => boolean,
  ) {}

  busy(sessionId: string) {
    const turn = this.turns.get(sessionId)
    if (turn?.open) return
    this.turns.set(sessionId, { n: (turn?.n ?? 0) + 1, open: true })
  }

  idle(sessionId: string) {
    const turn = this.turns.get(sessionId)
    if (turn) turn.open = false
  }

  /** Kilo is retrying a failed provider request. */
  async retry(sessionId: string, attempt: number, message: string) {
    if (!this.enabled()) return
    const kind = statusKind(undefined, message)
    const meta = this.meta(sessionId, kind, "warning", { title: `Retrying, attempt ${attempt}: ${message}` }, [])
    await this.input.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", _meta: meta },
    })
  }

  /** The `_meta` that ends a failed turn for Air, or undefined to fail the prompt as before. */
  failed(sessionId: string, error: Error) {
    if (!this.enabled()) return
    const kind = failureKind(error)
    if (!kind) return
    const message = "message" in error.data && typeof error.data.message === "string" ? error.data.message : undefined
    return this.meta(sessionId, kind, "error", text(message, POLICY[kind].title))
  }

  private meta(
    sessionId: string,
    kind: Kind,
    severity: "error" | "warning",
    shown: { title: string; details?: string },
    actions = POLICY[kind].actions,
  ) {
    const id = `${sessionId}:turn-${this.turns.get(sessionId)?.n ?? 0}:error`
    const revision = (this.revisions.get(id) ?? 0) + 1
    this.revisions.set(id, revision)
    return withAir(undefined, CAPABILITY, {
      id,
      revision,
      category: POLICY[kind].category,
      severity,
      title: shown.title,
      ...(shown.details ? { details: shown.details } : {}),
      actions,
    })
  }
}
