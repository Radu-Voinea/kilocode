import type { AgentSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk"
import type { UserMessage } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"

type Connection = Pick<AgentSideConnection, "sessionUpdate">

/** Builds the session's config options from its current ACP state. */
export type ConfigOptions = (state: ACPSession.Info) => Promise<SessionConfigOption[] | undefined>

/**
 * Keeps the ACP session's mode and model in step with Kilo when Kilo switches them on its own,
 * such as the plan follow-up that continues in the `code` agent. Without this the client kept
 * showing the old mode and the next prompt switched the session back to it.
 */
export class Modes {
  private options: ConfigOptions | undefined

  constructor(private readonly input: { connection: Connection; session: ACPSession.Interface }) {}

  setConfigOptions(options: ConfigOptions) {
    this.options = options
  }

  /** A user message of a known session, carrying the agent and model its turn runs with. */
  async message(info: UserMessage) {
    const state = await Effect.runPromise(this.input.session.tryGet(info.sessionID))
    if (!state || !this.options) return
    // Only agents the client offers as modes; hidden agents run for one message and switch back.
    const offered = modeValues(await this.options(state).catch(() => undefined))
    const mode = info.agent && info.agent !== state.modeId && offered.includes(info.agent) ? info.agent : undefined
    const model =
      info.model && (info.model.providerID !== state.model?.providerID || info.model.modelID !== state.model?.modelID)
        ? { providerID: info.model.providerID, modelID: info.model.modelID }
        : undefined
    const variant = info.model?.variant && info.model.variant !== state.variant ? info.model.variant : undefined
    if (!mode && !model && !variant) return

    if (mode) await Effect.runPromise(this.input.session.setMode(state.id, mode))
    if (model) await Effect.runPromise(this.input.session.setModel(state.id, model as ACPSession.SelectedModel))
    if (model || variant) await Effect.runPromise(this.input.session.setVariant(state.id, info.model?.variant))

    if (mode) {
      await this.input.connection.sessionUpdate({
        sessionId: state.id,
        update: { sessionUpdate: "current_mode_update", currentModeId: mode },
      })
    }
    const next = await Effect.runPromise(this.input.session.tryGet(state.id))
    const configOptions = next && (await this.options(next).catch(() => undefined))
    if (!configOptions) return
    await this.input.connection.sessionUpdate({
      sessionId: state.id,
      update: { sessionUpdate: "config_option_update", configOptions },
    })
  }
}

function modeValues(options: SessionConfigOption[] | undefined) {
  const mode = options?.find((option) => option.id === "mode")
  if (!mode || mode.type !== "select") return []
  return mode.options.flatMap((option) => ("value" in option ? [option.value] : option.options.map((o) => o.value)))
}
