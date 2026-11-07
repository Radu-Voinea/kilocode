import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { AssistantMessage, CompactionPart, SessionMessageResponse } from "@kilocode/sdk/v2"
import { withAir } from "./air"

type Connection = Pick<AgentSideConnection, "sessionUpdate">
type Update = Parameters<Connection["sessionUpdate"]>[0]["update"]

type Facts = {
  trigger?: "manual" | "automatic"
  preTokens?: number
  postTokens?: number
  durationMs?: number
  error?: string
}

type Active = {
  id: string
  trigger: Facts["trigger"]
  /** The assistant message that streams the summary. */
  summary?: AssistantMessage
  text: string
}

const TITLE = "Compact conversation"

/**
 * Shows a context compaction to JetBrains Air as the "Compact conversation" tool call that Air
 * recognizes by `_meta.jetbrains.air.contextCompaction`, like Air's Claude adapter does for a
 * client without ACP compaction updates. The summary that Kilo streams as an assistant message
 * goes into that tool call instead of the chat. Other clients keep seeing the summary as text.
 */
export class Compactions {
  private readonly active = new Map<string, Active>()
  /** Summary messages whose text belongs to a compaction rather than the chat. */
  private readonly summaries = new Set<string>()

  constructor(
    private readonly input: { connection: Connection },
    private readonly enabled: () => boolean,
  ) {}

  /** Whether a part delta of `messageId` belongs to a compaction and must not reach the chat. */
  owns(messageId: string) {
    return this.summaries.has(messageId)
  }

  async part(sessionId: string, part: CompactionPart) {
    if (!this.enabled()) return
    if (this.active.has(sessionId)) return
    const state: Active = { id: `compaction_${part.id}`, trigger: part.auto ? "automatic" : "manual", text: "" }
    this.active.set(sessionId, state)
    await this.send(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: state.id,
      title: TITLE,
      kind: "think",
      status: "in_progress",
      _meta: meta({ trigger: state.trigger }),
    })
  }

  async message(sessionId: string, info: AssistantMessage) {
    const state = this.active.get(sessionId)
    if (!state || !info.summary) return
    state.summary = info
    this.summaries.add(info.id)
    if (info.error) await this.finish(sessionId, failure(info.error))
  }

  /** Text of the summary message, collected for the tool call's result. */
  delta(sessionId: string, messageId: string, text: string) {
    const state = this.active.get(sessionId)
    if (state?.summary?.id === messageId) state.text += text
  }

  async compacted(sessionId: string) {
    await this.finish(sessionId)
  }

  /** A session that went idle with a compaction still open never finished it. */
  async idle(sessionId: string) {
    const state = this.active.get(sessionId)
    if (!state) return
    await this.finish(sessionId, state.summary?.error ? failure(state.summary.error) : undefined)
  }

  /** Replays a stored compaction as its tool call; true when `message` was handled. */
  async replay(message: SessionMessageResponse) {
    if (!this.enabled()) return false
    const sessionId = message.info.sessionID
    const part = message.parts.find((item): item is CompactionPart => item.type === "compaction")
    if (message.info.role === "user" && part) {
      this.active.set(sessionId, {
        id: `compaction_${part.id}`,
        trigger: part.auto ? "automatic" : "manual",
        text: "",
      })
      return true
    }
    const state = this.active.get(sessionId)
    if (message.info.role !== "assistant" || !message.info.summary || !state) return false
    state.summary = message.info
    state.text = message.parts.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
    await this.send(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: state.id,
      title: TITLE,
      kind: "think",
      status: "in_progress",
      _meta: meta({ trigger: state.trigger }),
    })
    await this.finish(sessionId, message.info.error ? failure(message.info.error) : undefined)
    return true
  }

  private async finish(sessionId: string, error?: string) {
    const state = this.active.get(sessionId)
    if (!state) return
    this.active.delete(sessionId)
    const facts: Facts = { trigger: state.trigger, ...tokens(state.summary), ...(error ? { error } : {}) }
    const text = error ? `Compaction failed: ${error}` : state.text.trim()
    await this.send(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: state.id,
      status: error ? "failed" : "completed",
      ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
      _meta: meta(facts),
    })
  }

  private send(sessionId: string, update: Update) {
    return this.input.connection.sessionUpdate({ sessionId, update })
  }
}

function meta(facts: Facts) {
  return withAir(undefined, "contextCompaction", { version: 1, ...facts })
}

/** Token counts of the summary request: its input is the context before, its output the summary. */
function tokens(summary: AssistantMessage | undefined): Facts {
  if (!summary) return {}
  const before = summary.tokens.input + summary.tokens.cache.read + summary.tokens.cache.write
  const end = summary.time.completed
  return {
    ...(before > 0 ? { preTokens: before } : {}),
    ...(summary.tokens.output > 0 ? { postTokens: summary.tokens.output } : {}),
    ...(end ? { durationMs: Math.max(0, end - summary.time.created) } : {}),
  }
}

function failure(error: NonNullable<AssistantMessage["error"]>) {
  if (error.name === "MessageAbortedError") return "Compaction was cancelled"
  const data = error.data as { message?: unknown }
  return typeof data?.message === "string" && data.message ? data.message : error.name
}
