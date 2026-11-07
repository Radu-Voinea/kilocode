import type { AgentSideConnection, PlanEntry } from "@agentclientprotocol/sdk"
import type { KiloClient, Todo } from "@kilocode/sdk/v2"

type Connection = Pick<AgentSideConnection, "sessionUpdate">

const STATUS: Record<string, PlanEntry["status"] | undefined> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
}

const PRIORITY: Record<string, PlanEntry["priority"] | undefined> = {
  high: "high",
  medium: "medium",
  low: "low",
}

/**
 * Kilo's todo list as an ACP plan. ACP has no cancelled status, so a cancelled todo leaves the
 * plan rather than showing as done.
 */
export function planEntries(todos: readonly Todo[]): PlanEntry[] {
  return todos.flatMap((todo) => {
    const status = STATUS[todo.status]
    if (!status) return []
    return [{ content: todo.content, status, priority: PRIORITY[todo.priority] ?? "medium" }]
  })
}

/**
 * Sends the full plan each time the todo list of a known ACP session changes, like the Claude
 * adapter does for TodoWrite. A plan identical to the last one sent is skipped.
 */
export class Plans {
  private readonly sent = new Map<string, string>()

  constructor(private readonly input: { sdk: KiloClient; connection: Connection }) {}

  async update(sessionId: string, todos: readonly Todo[]) {
    const entries = planEntries(todos)
    const json = JSON.stringify(entries)
    if (this.sent.get(sessionId) === json) return
    // An empty list before any plan was sent says nothing new.
    if (entries.length === 0 && !this.sent.has(sessionId)) return
    this.sent.set(sessionId, json)
    await this.input.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "plan", entries } })
  }

  /** On load, the client has no plan yet: send the current one once. */
  async replay(sessionId: string, directory: string) {
    this.sent.delete(sessionId)
    const todos = await this.input.sdk.session
      .todo({ sessionID: sessionId, directory }, { throwOnError: true })
      .then((response) => response.data)
      .catch(() => undefined)
    if (todos) await this.update(sessionId, todos)
  }

  forget(sessionId: string) {
    this.sent.delete(sessionId)
  }
}
