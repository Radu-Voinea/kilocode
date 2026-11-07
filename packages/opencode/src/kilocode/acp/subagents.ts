import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk"
import type { ToolPart } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"

type Connection = Pick<AgentSideConnection, "sessionUpdate">
type State = "completed" | "failed" | "cancelled"

type Child = {
  readonly id: string
  /** The ACP session that spawned it: the root session or another subagent. */
  readonly parent: string
  /** The root ACP session the client opened. */
  readonly root: string
  readonly cwd: string
  announced: boolean
  done: boolean
}

// JetBrains Air shows subagents as their own sessions when both sides advertise this capability
// under _meta.jetbrains.air: the parent session announces each child with `subagent_spawned`,
// the child's updates use the child's id as sessionId, and `subagent_state_update` ends it.
const CAPABILITY = "nativeSubagentSessions"

export function clientSupportsNativeSubagents(capabilities: ClientCapabilities | undefined) {
  const air = (capabilities?._meta as { jetbrains?: { air?: { version?: unknown; capabilities?: unknown } } })
    ?.jetbrains?.air
  return typeof air?.version === "number" && Array.isArray(air.capabilities) && air.capabilities.includes(CAPABILITY)
}

/**
 * Tracks the child sessions that the task tool starts. Without this, every event, permission and
 * question of a subagent was dropped because its session id is unknown to the ACP layer, so a
 * subagent that needed an answer waited forever. On clients with native subagent sessions the
 * child is registered as an ACP session of its own; on other clients its permissions and
 * questions go to the root session and its activity stays hidden behind the task tool call.
 */
export class Subagents {
  private readonly children = new Map<string, Child>()
  private native = false

  constructor(
    private readonly input: {
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  setClientCapabilities(capabilities: ClientCapabilities | undefined) {
    this.native = clientSupportsNativeSubagents(capabilities)
  }

  get enabled() {
    return this.native
  }

  isChild(sessionId: string) {
    return this.children.has(sessionId)
  }

  /** The ACP session that should receive a permission or question asked by `sessionId`. */
  target(sessionId: string) {
    const child = this.children.get(sessionId)
    if (!child) return undefined
    return this.native && !child.done ? child.id : child.root
  }

  /**
   * A part of a session the ACP layer doesn't know. Only task tool calls of a known subagent
   * matter: they start nested subagents, whose prompts must be routed too.
   */
  async onUnknownPart(sessionId: string, part: ToolPart) {
    const child = this.children.get(sessionId)
    if (child && part.tool === "task") await this.onTaskPart(sessionId, part, child.cwd)
  }

  async onTaskPart(parentId: string, part: ToolPart, cwd: string) {
    if (part.state.status === "pending") return
    const metadata = (part.state.metadata ?? {}) as { sessionId?: unknown; background?: unknown }
    const childId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined
    if (!childId || childId === parentId) return

    const child = this.children.get(childId) ?? (await this.register(childId, parentId, cwd, part))
    if (part.state.status === "completed" && metadata.background !== true) await this.finish(child, "completed")
    if (part.state.status === "error") {
      await this.finish(child, /abort|cancel|interrupt/i.test(part.state.error) ? "cancelled" : "failed")
    }
  }

  /** A background task's tool call completes at once; its child ends when the child goes idle. */
  async onIdle(sessionId: string) {
    const child = this.children.get(sessionId)
    if (child?.announced) await this.finish(child, "completed")
  }

  private async register(id: string, parentId: string, cwd: string, part: ToolPart) {
    const child: Child = {
      id,
      parent: parentId,
      root: this.children.get(parentId)?.root ?? parentId,
      cwd,
      announced: false,
      done: false,
    }
    this.children.set(id, child)
    if (!this.native) return child

    await Effect.runPromise(this.input.session.create({ id, cwd }))
    const input = part.state.input as { description?: unknown; prompt?: unknown; subagent_type?: unknown }
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
    const description = text(input.description)
    const prompt = text(input.prompt)
    const type = text(input.subagent_type)
    await this.input.connection.sessionUpdate({
      sessionId: parentId,
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: id,
        name: description ?? (type ? `@${type}` : "Subagent"),
        task: prompt ?? description ?? "Delegated task",
        ...(prompt ? { prompt } : {}),
        capabilities: {},
      },
    } as unknown as Parameters<Connection["sessionUpdate"]>[0])
    child.announced = true
    return child
  }

  private async finish(child: Child, state: State) {
    if (child.done) return
    child.done = true
    if (!child.announced) return
    await this.input.connection.sessionUpdate({
      sessionId: child.parent,
      update: { sessionUpdate: "subagent_state_update", subagentSessionId: child.id, state },
    } as unknown as Parameters<Connection["sessionUpdate"]>[0])
    await Effect.runPromise(this.input.session.remove(child.id))
  }
}
