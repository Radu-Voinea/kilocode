import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk"
import type { Event, KiloClient } from "@kilocode/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPSession } from "@/acp/session"
import { Extensions } from "@/kilocode/acp/extensions"
import { Subagents } from "@/kilocode/acp/subagents"

export type Update = Parameters<AgentSideConnection["sessionUpdate"]>[0]

/** The Air client capabilities `names`, as Air sends them in `initialize`. */
export function air(...names: string[]): ClientCapabilities {
  return { _meta: { jetbrains: { air: { version: 1, capabilities: names } } } }
}

/** Kilo's ACP extensions over a recording connection and a fake SDK made of `sdk`. */
export function harness(opts: { sdk?: object; capabilities?: ClientCapabilities } = {}) {
  const updates: Update[] = []
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  const connection = { sessionUpdate: (params: Update) => (updates.push(params), Promise.resolve()) }
  const subagents = new Subagents({ connection, session })
  const kilo = new Extensions({ sdk: (opts.sdk ?? {}) as KiloClient, connection, session, subagents })
  subagents.setClientCapabilities(opts.capabilities)
  kilo.setClientCapabilities(opts.capabilities)
  const open = (id: string, cwd = "/work") => Effect.runPromise(session.create({ id, cwd }))
  return { kilo, session, subagents, updates, open }
}

export function event<T extends Event["type"]>(type: T, properties: Extract<Event, { type: T }>["properties"]) {
  return { id: "evt", type, properties } as Event
}
