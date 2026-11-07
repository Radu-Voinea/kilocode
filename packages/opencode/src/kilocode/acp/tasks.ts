import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { BackgroundProcessInfo, KiloClient, ToolPart } from "@kilocode/sdk/v2"
import { withAir } from "./air"

type Connection = Pick<AgentSideConnection, "sessionUpdate">
type Update = Parameters<Connection["sessionUpdate"]>[0]["update"]
type State = "completed" | "failed" | "stopped"

export const CAPABILITY = "asyncTasks"
export const STOP = "_session/async_task/stop"

type Task = {
  id: string
  /** The ACP session that shows the task. */
  sessionId: string
  cwd: string
  kind: "process" | "agent"
  /** The background process id, or the subagent's session id. */
  target: string
  toolCallId?: string
  done: boolean
}

/** Whether a finished tool call left work running in the background. */
export function backgrounded(part: ToolPart) {
  if (part.state.status !== "completed") return false
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
  if (part.tool === "background_process") return input.action === "start" && typeof metadata.processID === "string"
  return part.tool === "task" && metadata.background === true && typeof metadata.sessionId === "string"
}

/** The tool call `_meta` that tells Air the call's work went on in the background. */
export function backgroundedMeta(meta: Record<string, unknown> | undefined) {
  return withAir(meta, CAPABILITY, { backgrounded: true })
}

/**
 * Shows Kilo's background work in Air's task panel, as Air's Claude adapter does for its
 * background tasks: background processes started with `background_process`, and subagents the
 * task tool runs in the background. Each gets `async_task_spawned`, then a terminal
 * `async_task_state_update`, and Air can stop it with `_session/async_task/stop`.
 */
export class Tasks {
  private readonly tasks = new Map<string, Task>()
  /** Tool call ids of background process starts, by process id; the process may be seen first. */
  private readonly calls = new Map<string, string>()

  constructor(
    private readonly input: { sdk: KiloClient; connection: Connection },
    private readonly enabled: () => boolean,
  ) {}

  /** A finished tool call of a known ACP session. */
  async tool(sessionId: string, cwd: string, part: ToolPart) {
    if (!this.enabled() || !backgrounded(part) || part.state.status !== "completed") return
    const metadata = part.state.metadata as Record<string, unknown>
    if (part.tool === "background_process") {
      const id = metadata.processID as string
      this.calls.set(id, part.callID)
      const task = this.tasks.get(`process:${id}`)
      if (task && !task.toolCallId) {
        task.toolCallId = part.callID
        await this.send(task, { sessionUpdate: "async_task_progress", asyncTaskId: task.id, toolCallId: part.callID })
      }
      return
    }
    const input = part.state.input as { description?: unknown; prompt?: unknown }
    const child = metadata.sessionId as string
    const description = typeof input.description === "string" && input.description ? input.description : "Subagent"
    await this.spawn(
      { id: `agent:${child}`, sessionId, cwd, kind: "agent", target: child, toolCallId: part.callID },
      {
        name: description,
        description,
        taskType: "agent",
      },
    )
  }

  /** A background process changed; `sessionId` is the ACP session that shows it, if any. */
  async process(sessionId: string | undefined, cwd: string, info: BackgroundProcessInfo) {
    if (!this.enabled() || !sessionId) return
    const id = `process:${info.id}`
    const label = info.description?.trim() || info.command
    if (!this.tasks.has(id)) {
      if (["exited", "failed", "stopped", "stopping"].includes(info.status)) return
      const toolCallId = this.calls.get(info.id)
      await this.spawn(
        { id, sessionId, cwd, kind: "process", target: info.id, toolCallId },
        {
          name: label,
          description: label,
          taskType: "shell",
        },
      )
    }
    if (info.status === "exited") {
      const code = info.exitCode ?? 0
      await this.end(id, code === 0 ? "completed" : "failed", `Exited with code ${code}`)
    }
    if (info.status === "failed") await this.end(id, "failed", "The process failed")
    if (info.status === "stopped") await this.end(id, "stopped")
  }

  async processDeleted(processId: string) {
    await this.end(`process:${processId}`, "stopped")
  }

  /** A session went idle or failed: a background subagent in it is done. */
  async agent(sessionId: string, state: State) {
    await this.end(`agent:${sessionId}`, state)
  }

  /** Stops a task from the client. */
  async stop(sessionId: string, id: string) {
    const task = this.tasks.get(id)
    if (!task || task.done || task.sessionId !== sessionId) return { stopped: false }
    const ok =
      task.kind === "process"
        ? await this.input.sdk.backgroundProcess
            .stop({ processID: task.target, directory: task.cwd }, { throwOnError: true })
            .then(() => true)
            .catch(() => false)
        : await this.input.sdk.session
            .abort({ sessionID: task.target, directory: task.cwd }, { throwOnError: true })
            .then(() => true)
            .catch(() => false)
    if (!ok) return { stopped: false }
    await this.end(id, "stopped")
    return { stopped: true }
  }

  private async spawn(task: Omit<Task, "done">, shown: { name: string; description: string; taskType: string }) {
    if (this.tasks.has(task.id)) return
    const entry = { ...task, done: false }
    this.tasks.set(task.id, entry)
    await this.send(entry, {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: task.id,
      ...shown,
      showInTranscript: true,
      canStop: true,
      ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
    })
  }

  private async end(id: string, state: State, summary?: string) {
    const task = this.tasks.get(id)
    if (!task || task.done) return
    task.done = true
    await this.send(task, {
      sessionUpdate: "async_task_state_update",
      asyncTaskId: id,
      state,
      ...(summary ? { summary } : {}),
    })
  }

  private send(task: Task, update: Record<string, unknown>) {
    return this.input.connection.sessionUpdate({ sessionId: task.sessionId, update: update as Update })
  }
}
