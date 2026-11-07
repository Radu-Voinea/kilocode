import { describe, expect, it } from "bun:test"
import { failureKind } from "@/kilocode/acp/failures"
import { air, event, harness } from "./harness"

const api = (statusCode: number | undefined, message = "boom") =>
  ({ name: "APIError", data: { message, statusCode, isRetryable: false } }) as const

describe("acp session failures", () => {
  it("maps Kilo errors to Air failure kinds", () => {
    expect(failureKind(api(401))).toBe("access_denied")
    expect(failureKind(api(402))).toBe("quota_exhausted")
    expect(failureKind(api(429))).toBe("rate_limited")
    expect(failureKind(api(529))).toBe("overloaded")
    expect(failureKind(api(400))).toBe("bad_request")
    expect(failureKind(api(500))).toBe("provider_error")
    expect(failureKind(api(undefined, "Rate limit exceeded"))).toBe("rate_limited")
    expect(failureKind({ name: "ContextOverflowError", data: { message: "too long" } })).toBe("context_exhausted")
    expect(failureKind({ name: "UnknownError", data: { message: "?" } })).toBe("internal_error")
    expect(failureKind({ name: "MessageAbortedError", data: { message: "" } })).toBeUndefined()
    expect(failureKind({ name: "ProviderAuthError", data: { providerID: "p", message: "" } })).toBeUndefined()
  })

  it("ends a failed turn with a session failure and advertises the capability", async () => {
    const { kilo } = harness({ capabilities: air("sessionFailure") })
    expect(kilo.agentMeta()).toEqual({ jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } })
    await kilo.handle(event("session.status", { sessionID: "ses", status: { type: "busy" } }))
    expect(kilo.failed("ses", api(429, "Too many requests\nslow down"))).toEqual({
      jetbrains: {
        air: {
          version: 1,
          sessionFailure: {
            id: "ses:turn-1:error",
            revision: 1,
            category: "limit",
            severity: "error",
            title: "Too many requests",
            details: "slow down",
            actions: ["retry"],
          },
        },
      },
    })
  })

  it("publishes retries as a warning the turn's error replaces", async () => {
    const { kilo, open, updates } = harness({ capabilities: air("sessionFailure") })
    await open("ses")
    await kilo.handle(event("session.status", { sessionID: "ses", status: { type: "busy" } }))
    await kilo.handle(
      event("session.status", {
        sessionID: "ses",
        status: { type: "retry", attempt: 2, message: "Provider is overloaded", next: 0 },
      }),
    )
    expect(updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "session_info_update",
      _meta: {
        jetbrains: {
          air: { sessionFailure: { id: "ses:turn-1:error", revision: 1, severity: "warning", actions: [] } },
        },
      },
    })
    const meta = kilo.failed("ses", api(529)) as { jetbrains: { air: { sessionFailure: { revision: number } } } }
    expect(meta.jetbrains.air.sessionFailure.revision).toBe(2)

    await kilo.handle(event("session.status", { sessionID: "ses", status: { type: "idle" } }))
    await kilo.handle(event("session.status", { sessionID: "ses", status: { type: "busy" } }))
    const next = kilo.failed("ses", api(500)) as { jetbrains: { air: { sessionFailure: { id: string } } } }
    expect(next.jetbrains.air.sessionFailure.id).toBe("ses:turn-2:error")
  })

  it("leaves other clients' failures alone", () => {
    const { kilo } = harness()
    expect(kilo.failed("ses", api(429))).toBeUndefined()
  })
})
