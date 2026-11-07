import type { AgentSideConnection, ClientCapabilities, ToolCallUpdate } from "@agentclientprotocol/sdk"
import type { AssistantMessage, Event, KiloClient, SessionMessageResponse, ToolPart } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"
import { capabilityMeta, isAir, supports } from "./air"
import { Compactions } from "./compaction"
import { CAPABILITY as DIFF, patchContent } from "./diff"
import { CAPABILITY as FAILURE, Failures } from "./failures"
import { setClient } from "./client"
import { Modes, type ConfigOptions } from "./modes"
import { Plans } from "./plan"
import { CAPABILITY as REPORT, Reports } from "./reports"
import { Steering } from "./steering"
import type { Subagents } from "./subagents"
import { Titles } from "./titles"

type Connection = Pick<AgentSideConnection, "sessionUpdate">

/**
 * Kilo's ACP additions that react to server events: one entry point for the shared event
 * subscription, so the upstream file only forwards events, capabilities and replays here.
 */
export class Extensions {
  private readonly plans: Plans
  private readonly titles: Titles
  private readonly modes: Modes
  private readonly compactions: Compactions
  private readonly failures: Failures
  private readonly reports: Reports
  readonly steering = new Steering()
  private capabilities: ClientCapabilities | undefined
  private readonly running = new Set<string>()

  constructor(
    private readonly input: {
      sdk: KiloClient
      connection: Connection
      session: ACPSession.Interface
      subagents: Subagents
    },
  ) {
    this.plans = new Plans(input)
    this.titles = new Titles(input)
    this.modes = new Modes(input)
    this.compactions = new Compactions(input, () => isAir(this.capabilities))
    this.failures = new Failures(input, () => this.supports(FAILURE))
    this.reports = new Reports(input)
  }

  setClientCapabilities(capabilities: ClientCapabilities | undefined) {
    this.capabilities = capabilities
    setClient(capabilities)
  }

  /** How to build a session's config options, which only the ACP service knows. */
  setConfigOptions(options: ConfigOptions) {
    this.modes.setConfigOptions(options)
  }

  /** Whether the client advertised the Air capability `name`. */
  supports(name: string) {
    return supports(this.capabilities, name)
  }

  /** The Air capabilities the agent advertises back in `initialize`. */
  agentMeta() {
    const names = [
      ...(this.input.subagents.enabled ? ["nativeSubagentSessions"] : []),
      ...(this.supports(FAILURE) ? [FAILURE] : []),
      ...(this.supports(DIFF) ? [DIFF] : []),
      ...(this.supports(REPORT) ? [REPORT] : []),
    ]
    return capabilityMeta(names)
  }

  async handle(event: Event) {
    switch (event.type) {
      case "todo.updated": {
        if (!(await this.known(event.properties.sessionID))) return
        await this.plans.update(event.properties.sessionID, event.properties.todos)
        return
      }
      case "message.updated": {
        const info = event.properties.info
        if (info.role === "user") this.steering.message(info.sessionID)
        if (info.role === "user") await this.modes.message(info)
        if (info.role === "assistant") await this.compactions.message(info.sessionID, info)
        return
      }
      case "message.part.updated": {
        const part = event.properties.part
        this.reports.part(part.sessionID, part)
        if (part.type !== "compaction" || !(await this.known(part.sessionID))) return
        await this.compactions.part(part.sessionID, part)
        return
      }
      case "session.compacted":
        await this.compactions.compacted(event.properties.sessionID)
        return
      case "session.status": {
        const id = event.properties.sessionID
        const status = event.properties.status
        if (status.type === "idle") this.running.delete(id)
        if (status.type !== "idle") this.running.add(id)
        if (status.type === "idle") this.steering.idle(id)
        if (status.type === "busy") this.steering.busy(id)
        if (status.type === "busy") this.failures.busy(id)
        if (status.type === "retry" && (await this.known(id)))
          await this.failures.retry(id, status.attempt, status.message)
        if (status.type !== "idle") return
        this.failures.idle(id)
        await this.compactions.idle(id)
        return
      }
      case "session.updated": {
        const info = event.properties.info
        // A subagent's name comes from `subagent_spawned`, not from its title.
        if (info.parentID || this.input.subagents.isChild(info.id)) return
        if (!(await this.known(info.id))) return
        await this.titles.update(info)
        return
      }
    }
  }

  /**
   * A streamed part delta of an assistant message. True when it belongs to one of Kilo's additions,
   * such as a compaction summary, and must not reach the chat.
   */
  delta(sessionId: string, messageId: string, type: string | undefined, field: string, text: string) {
    if (!this.compactions.owns(messageId)) return false
    if (type === "text" && field === "text") this.compactions.delta(sessionId, messageId, text)
    return true
  }

  /** A finished tool call's update, with Air's own form of its content where the client reads it. */
  completed<T extends ToolCallUpdate>(part: ToolPart, update: T): T {
    if (!this.supports(DIFF)) return update
    return { ...update, content: patchContent(part, update.content ?? undefined) }
  }

  /** Whether a turn of the session is running. */
  busy(sessionId: string) {
    return this.running.has(sessionId)
  }

  /** A prompt starts: Air may ask for the files the turn changes. */
  promptStarted(sessionId: string, meta: unknown) {
    if (this.supports(REPORT)) this.reports.start(sessionId, meta)
  }

  /** A prompt ends, before its response: reports the files it changed if Air asked. */
  async promptEnded(sessionId: string, cwd: string, failure?: "cancelled" | "providerError") {
    await this.reports.finish(sessionId, cwd, failure)
  }

  /** The `_meta` that ends a failed turn as an Air session failure, or undefined to fail it as before. */
  failed(sessionId: string, error: NonNullable<AssistantMessage["error"]>) {
    return this.failures.failed(sessionId, error)
  }

  /** Replays a stored message Kilo presents differently; true when it was handled. */
  async replay(message: SessionMessageResponse) {
    return await this.compactions.replay(message)
  }

  /** After a session's history was replayed to the client on load or fork. */
  async replayed(sessionId: string, directory: string) {
    await this.plans.replay(sessionId, directory)
  }

  private async known(sessionId: string) {
    return !!(await Effect.runPromise(this.input.session.tryGet(sessionId)))
  }
}
