import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk"
import type { Event, KiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"
import { capabilityMeta, supports } from "./air"
import { setClient } from "./client"
import { Modes, type ConfigOptions } from "./modes"
import { Plans } from "./plan"
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
  private capabilities: ClientCapabilities | undefined

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
    const names = [...(this.input.subagents.enabled ? ["nativeSubagentSessions"] : [])]
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
        if (info.role === "user") await this.modes.message(info)
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

  /** After a session's history was replayed to the client on load or fork. */
  async replayed(sessionId: string, directory: string) {
    await this.plans.replay(sessionId, directory)
  }

  private async known(sessionId: string) {
    return !!(await Effect.runPromise(this.input.session.tryGet(sessionId)))
  }
}
