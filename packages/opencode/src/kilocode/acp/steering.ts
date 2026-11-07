type Steer = {
  /** The steered user message was created. */
  seen: boolean
  /** A turn started after it: the steered turn, or the running one it joined. */
  started: boolean
  done: PromiseWithResolvers<void>
  timer?: ReturnType<typeof setTimeout>
}

/** How long an idle session may stay idle before a steered message that never started is dropped. */
const GRACE = 1500

/**
 * Keeps a steered turn inside the ACP prompt it steered. Kilo ends the running turn and starts the
 * queued message as a turn of its own, with an idle status between them, so without this the
 * prompt answered before the steered work ran. The steered message is usually created while the old
 * turn still runs, so a steer settles at the first idle after a turn started after its message, or
 * when the session stays idle for a moment without starting one.
 */
export class Steering {
  private readonly pending = new Map<string, Steer>()

  steered(sessionId: string) {
    if (this.pending.has(sessionId)) return
    this.pending.set(sessionId, { seen: false, started: false, done: Promise.withResolvers<void>() })
  }

  /** A user message of the session was created: the steered one, if a steer waits for it. */
  message(sessionId: string) {
    const steer = this.pending.get(sessionId)
    if (steer) steer.seen = true
  }

  busy(sessionId: string) {
    const steer = this.pending.get(sessionId)
    if (!steer) return
    if (steer.timer) clearTimeout(steer.timer)
    steer.timer = undefined
    if (steer.seen) steer.started = true
  }

  idle(sessionId: string) {
    const steer = this.pending.get(sessionId)
    if (!steer) return
    if (steer.started) return this.settle(sessionId)
    steer.timer = setTimeout(() => this.settle(sessionId), GRACE)
  }

  /** Resolves once every steer of the session has run. */
  async settled(sessionId: string) {
    await this.pending.get(sessionId)?.done.promise
  }

  private settle(sessionId: string) {
    const steer = this.pending.get(sessionId)
    if (!steer) return
    if (steer.timer) clearTimeout(steer.timer)
    this.pending.delete(sessionId)
    steer.done.resolve()
  }
}
