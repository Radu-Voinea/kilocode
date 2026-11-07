import { RequestError, type ContentBlock, type PromptRequest, type PromptResponse } from "@agentclientprotocol/sdk"
import type { KiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import { promptContentToParts } from "@/acp/content"
import type { ACPSession } from "@/acp/session"
import type { Extensions } from "./extensions"
import { STOP } from "./tasks"

type Params = Record<string, unknown>

export type Context = {
  sdk: KiloClient
  session: ACPSession.Interface
  extensions: Extensions | undefined
  /** The ACP prompt handler, for a turn the agent starts itself. */
  prompt: (params: PromptRequest) => Promise<PromptResponse>
}

/** Injects a message into the turn that is running, per the ACP steering extension. */
export const STEER = "_session/steering"

/** The top-level `initialize` `_meta` that advertises steering. */
export function steeringMeta() {
  return { steering: { supported: true } }
}

/** Kilo's ACP extension methods; an unknown one is `methodNotFound`. */
export async function handle(method: string, params: Params, ctx: Context): Promise<Params> {
  if (method === STEER) return await steer(params, ctx)
  if (method === STOP) return await stop(params, ctx)
  throw RequestError.methodNotFound(method)
}

/**
 * Kilo queues a prompt sent while a turn runs, and the running turn hands over to it once its
 * current step finishes, so the message steers the turn: its ACP prompt stays open until the
 * steered work is done. With no turn running, the message starts a turn of its own, unless the
 * client asked to send it as a prompt itself.
 */
async function steer(params: Params, ctx: Context): Promise<Params> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : ""
  const prompt = Array.isArray(params.prompt) ? (params.prompt as ContentBlock[]) : []
  if (!sessionId) throw RequestError.invalidParams(undefined, "steer params require a non-empty sessionId")
  if (prompt.length === 0) throw RequestError.invalidParams(undefined, "steer params require a non-empty prompt array")
  const idle = ((params._meta as Params | undefined)?.steering as Params | undefined)?.idleBehavior
  if (idle !== undefined && idle !== "promptRequired") {
    throw RequestError.invalidParams(undefined, "unsupported steering idleBehavior")
  }

  const state = await Effect.runPromise(ctx.session.tryGet(sessionId))
  if (!state) throw RequestError.resourceNotFound(sessionId)

  if (!ctx.extensions?.busy(sessionId)) {
    if (idle === "promptRequired") return { outcome: "promptRequired", reason: "noRunningTurn" }
    void ctx.prompt({ sessionId, prompt }).catch(() => {})
    return { outcome: "startedNewTurn" }
  }

  await ctx.sdk.session.promptAsync(
    {
      sessionID: sessionId,
      directory: state.cwd,
      parts: promptContentToParts(prompt),
      ...(state.model ? { model: { providerID: state.model.providerID, modelID: state.model.modelID } } : {}),
      ...(state.variant ? { variant: state.variant } : {}),
      ...(state.modeId ? { agent: state.modeId } : {}),
    },
    { throwOnError: true },
  )
  ctx.extensions?.steering.steered(sessionId)
  return { outcome: "injected" }
}

/** Stops one background task without cancelling the turn, as Air's `_session/async_task/stop`. */
async function stop(params: Params, ctx: Context): Promise<Params> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : ""
  const id = typeof params.asyncTaskId === "string" ? params.asyncTaskId.trim() : ""
  if (!sessionId) throw RequestError.invalidParams(undefined, "async task stop params require a non-empty sessionId")
  if (!id) throw RequestError.invalidParams(undefined, "async task stop params require a non-empty asyncTaskId")
  return (await ctx.extensions?.stopTask(sessionId, id)) ?? { stopped: false }
}
