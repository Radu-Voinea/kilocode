import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Session } from "@kilocode/sdk/v2"
import { isDefaultTitle } from "@/session/session"

type Connection = Pick<AgentSideConnection, "sessionUpdate">

/**
 * Tells the client the title Kilo gave a session, as a standard `session_info_update`. Kilo
 * titles sessions itself, so only changes need forwarding; the "New session - <date>"
 * placeholder is not a title worth showing.
 */
export class Titles {
  private readonly sent = new Map<string, string>()

  constructor(private readonly input: { connection: Connection }) {}

  async update(info: Pick<Session, "id" | "title" | "time">) {
    const title = info.title.trim()
    if (!title || isDefaultTitle(title)) return
    if (this.sent.get(info.id) === title) return
    this.sent.set(info.id, title)
    await this.input.connection.sessionUpdate({
      sessionId: info.id,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date(info.time.updated).toISOString(),
      },
    })
  }

  forget(sessionId: string) {
    this.sent.delete(sessionId)
  }
}
