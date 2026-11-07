import type { ClientCapabilities } from "@agentclientprotocol/sdk"

// JetBrains Air reads Kilo-specific ACP payloads under `_meta.jetbrains.air`, and both sides
// list the extensions they support in `capabilities` there. Only a capability that both sides
// advertise may be used. Mirrors `air-extension.js` of Air's bundled Claude adapter.

const VERSION = 1

type Meta = Record<string, unknown>

function record(value: unknown): Meta {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Meta) : {}
}

/** The `air` object of a `_meta`, or undefined when the peer sent no Air extension. */
export function airMeta(meta: unknown) {
  const air = record(record(record(meta).jetbrains).air)
  return Object.keys(air).length > 0 ? air : undefined
}

/** Whether the client is JetBrains Air: it declared `_meta.jetbrains.air`. */
export function isAir(capabilities: ClientCapabilities | undefined) {
  return airMeta(capabilities?._meta) !== undefined
}

/** Whether the client advertised the Air capability `name`. */
export function supports(capabilities: ClientCapabilities | undefined, name: string) {
  const air = airMeta(capabilities?._meta)
  const version = air?.version
  const list = air?.capabilities
  return typeof version === "number" && version >= VERSION && Array.isArray(list) && list.includes(name)
}

/** Merges one Air payload into `meta`, keeping every other namespace and Air key. */
export function withAir(meta: Meta | undefined, key: string, payload: unknown): Meta {
  const jetbrains = record(meta?.jetbrains)
  const air = record(jetbrains.air)
  return { ...meta, jetbrains: { ...jetbrains, air: { ...air, version: VERSION, [key]: payload } } }
}

/** The `_meta` that advertises the agent's Air capabilities, or undefined when there are none. */
export function capabilityMeta(names: readonly string[]) {
  const list = [...new Set(names)]
  if (list.length === 0) return undefined
  return withAir(undefined, "capabilities", list)
}
