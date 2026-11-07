import { describe, expect, it } from "bun:test"
import type { Session } from "@kilocode/sdk/v2"
import { event, harness } from "./harness"

const info = (id: string, title: string, parentID?: string) =>
  ({ id, title, parentID, time: { created: 0, updated: 1_000 } }) as Session

const updated = (session: Session) => event("session.updated", { sessionID: session.id, info: session })

describe("acp session titles", () => {
  it("sends a known session's title once it changes from the placeholder", async () => {
    const { kilo, open, updates } = harness()
    await open("ses")

    await kilo.handle(updated(info("ses", "New session - 2026-11-07T10:00:00.000Z")))
    await kilo.handle(updated(info("ses", "Fix the login bug")))
    await kilo.handle(updated(info("ses", "Fix the login bug")))
    await kilo.handle(updated(info("other", "Unknown session")))

    expect(updates).toEqual([
      {
        sessionId: "ses",
        update: {
          sessionUpdate: "session_info_update",
          title: "Fix the login bug",
          updatedAt: new Date(1_000).toISOString(),
        },
      },
    ])
  })

  it("leaves subagent titles alone", async () => {
    const { kilo, open, updates } = harness()
    await open("child")
    await kilo.handle(updated(info("child", "Echo check (@general subagent)", "ses")))
    expect(updates).toEqual([])
  })
})
