import { RequestError, type AgentSideConnection, type SessionInfo } from "@agentclientprotocol/sdk"
import type { KiloClient, Session } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "@/acp/session"
import { airMeta, withAir } from "./air"

type Connection = Pick<AgentSideConnection, "sessionUpdate"> & Partial<Pick<AgentSideConnection, "extNotification">>
type Params = Record<string, unknown>
type Filter = "unarchived" | "archived" | "all"

export const CAPABILITY = "sessionIndex"
/** What the agent advertises with the index, as Air's Claude adapter does. */
export const CAPABILITIES = [CAPABILITY, "sessionArchive", "sessionRename", "sessionListSubscribe"]

export const RENAME = "_session/rename"
export const ARCHIVE = "_session/archive"
export const UNARCHIVE = "_session/unarchive"
export const SUBSCRIBE = "_session/list/subscribe"
export const UNSUBSCRIBE = "_session/list/unsubscribe"
export const CHANGES = "_session/list/changes"
export const METHODS = [RENAME, ARCHIVE, UNARCHIVE, SUBSCRIBE, UNSUBSCRIBE]

const LIMIT = 50
const MAX = 200
const DEBOUNCE = 150

/** `_meta.jetbrains.air.list` of a `session/list` request. */
export function listOptions(meta: unknown) {
  const list = (airMeta(meta)?.list ?? {}) as Params
  const raw = list.limit ?? LIMIT
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw RequestError.invalidParams(
      { limit: raw },
      "`_meta.jetbrains.air.list.limit` must be an integer of at least 1",
    )
  }
  const archived = list.archived ?? "unarchived"
  if (archived !== "unarchived" && archived !== "archived" && archived !== "all") {
    throw RequestError.invalidParams(
      { archived },
      '`_meta.jetbrains.air.list.archived` must be "unarchived", "archived" or "all"',
    )
  }
  return { limit: Math.min(MAX, raw), archived: archived as Filter }
}

function text(params: Params, key: string) {
  const value = params[key]
  return typeof value === "string" ? value.trim() : ""
}

type Subscription = {
  id: string
  cwd: string
  sent: Map<string, string>
  queued: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Air's session index: a `session/list` whose rows carry the archive state and whether a turn runs,
 * `_session/rename`, `_session/archive` and `_session/unarchive`, and a subscription that pushes the
 * rows that changed. Only for a client that declared `sessionIndex`; subagent sessions stay out, as
 * in the plain list.
 */
export class SessionIndex {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly infos = new Map<string, Session>()

  constructor(
    private readonly input: {
      sdk: KiloClient
      connection: Connection
      session: ACPSession.Interface
      running: (sessionId: string) => boolean
      /** Clears a session's archive time; the HTTP API can only set one. */
      unarchive?: (sessionId: string, directory: string) => Promise<void>
    },
  ) {}

  async list(params: { cwd?: string | null; cursor?: string | null; _meta?: unknown }) {
    const options = listOptions(params._meta)
    const cwd = params.cwd ?? undefined
    const all = await this.input.sdk.session
      .list({ ...(cwd ? { directory: cwd } : {}), roots: true, limit: 1000 }, { throwOnError: true })
      .then((response) => response.data ?? [])
    for (const info of all) this.infos.set(info.id, info)
    const cursor = params.cursor ? Number(params.cursor) : undefined
    const rows = all
      .filter((info) => !cwd || info.directory === cwd)
      .filter((info) => matches(info, options.archived))
      .filter((info) => cursor === undefined || !Number.isFinite(cursor) || info.time.updated < cursor)
      .toSorted((a, b) => b.time.updated - a.time.updated)
    const page = rows.slice(0, options.limit)
    const last = page.at(-1)
    return {
      sessions: page.map((info) => this.row(info)),
      ...(rows.length > options.limit && last ? { nextCursor: String(last.time.updated) } : {}),
    }
  }

  async handle(method: string, params: Params): Promise<Params> {
    if (method === SUBSCRIBE) {
      const cwd = text(params, "cwd")
      if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) {
        throw RequestError.invalidParams({ cwd }, "params require an absolute cwd")
      }
      const id = crypto.randomUUID()
      this.subscriptions.set(id, { id, cwd, sent: new Map(), queued: new Set() })
      return { subscriptionId: id }
    }
    if (method === UNSUBSCRIBE) {
      const id = params.subscriptionId
      if (typeof id !== "string") throw RequestError.invalidParams(undefined, "params require a subscriptionId")
      const subscription = this.subscriptions.get(id)
      if (subscription?.timer) clearTimeout(subscription.timer)
      this.subscriptions.delete(id)
      return {}
    }

    const sessionId = text(params, "sessionId")
    if (!sessionId) throw RequestError.invalidParams(undefined, "params require a non-empty sessionId")
    const info = await this.info(sessionId)
    if (!info) throw RequestError.resourceNotFound(sessionId)

    if (method === RENAME) {
      const title = text(params, "title").replace(/\s+/g, " ")
      if (!title) throw RequestError.invalidParams(undefined, "title must be a non-empty string")
      await this.input.sdk.session.update(
        { sessionID: sessionId, directory: info.directory, title },
        { throwOnError: true },
      )
      return {}
    }
    if (method === ARCHIVE) {
      const loaded = await Effect.runPromise(this.input.session.tryGet(sessionId))
      if (loaded) {
        await this.input.sdk.session.abort({ sessionID: sessionId, directory: info.directory }).catch(() => undefined)
      }
      if (!info.time.archived) {
        await this.input.sdk.session.update(
          { sessionID: sessionId, directory: info.directory, time: { archived: Date.now() } },
          { throwOnError: true },
        )
      }
      if (loaded) {
        await this.archived(sessionId, true)
        await Effect.runPromise(this.input.session.remove(sessionId))
      }
      return {}
    }
    if (method === UNARCHIVE) {
      if (info.time.archived) await (this.input.unarchive ?? unarchive)(sessionId, info.directory)
      if (await Effect.runPromise(this.input.session.tryGet(sessionId))) await this.archived(sessionId, false)
      return {}
    }
    throw RequestError.methodNotFound(method)
  }

  /** A session was created or changed. */
  updated(info: Session) {
    if (info.parentID) return
    this.infos.set(info.id, info)
    this.queue(info.id, info.directory)
  }

  deleted(info: Session) {
    this.infos.delete(info.id)
    this.queue(info.id, info.directory)
  }

  /** A turn started or ended: the row's state changed. */
  status(sessionId: string) {
    const info = this.infos.get(sessionId)
    if (info) this.queue(sessionId, info.directory)
  }

  private row(info: Session): SessionInfo {
    return {
      sessionId: info.id,
      cwd: info.directory,
      title: info.title,
      updatedAt: new Date(info.time.updated).toISOString(),
      _meta: withAir(
        withAir(undefined, "archived", !!info.time.archived),
        "state",
        this.input.running(info.id) ? "running" : "idle",
      ),
    }
  }

  private queue(sessionId: string, directory: string) {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.cwd !== directory) continue
      subscription.queued.add(sessionId)
      if (subscription.timer) clearTimeout(subscription.timer)
      subscription.timer = setTimeout(() => void this.flush(subscription).catch(() => {}), DEBOUNCE)
    }
  }

  private async flush(subscription: Subscription) {
    subscription.timer = undefined
    const ids = [...subscription.queued]
    subscription.queued.clear()
    const sessions: SessionInfo[] = []
    const removed: string[] = []
    for (const id of ids) {
      const info = this.infos.get(id)
      if (!info) {
        if (subscription.sent.delete(id)) removed.push(id)
        continue
      }
      const row = this.row(info)
      const signature = JSON.stringify([row.title, row.cwd, row._meta])
      if (subscription.sent.get(id) === signature) continue
      subscription.sent.set(id, signature)
      sessions.push(row)
    }
    if (sessions.length === 0 && removed.length === 0) return
    await this.input.connection.extNotification?.(CHANGES, { subscriptionId: subscription.id, sessions, removed })
  }

  private async info(sessionId: string) {
    const fetched = await this.input.sdk.session
      .get({ sessionID: sessionId }, { throwOnError: true })
      .then((response) => response.data)
      .catch(() => undefined)
    if (fetched) this.infos.set(fetched.id, fetched)
    return fetched ?? this.infos.get(sessionId)
  }

  private async archived(sessionId: string, archived: boolean) {
    await this.input.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", _meta: withAir(undefined, "archived", archived) },
    })
  }
}

function matches(info: Session, filter: Filter) {
  if (filter === "all") return true
  return filter === "archived" ? !!info.time.archived : !info.time.archived
}

/** Clears the archive time through Kilo's session service, which runs in this process. */
async function unarchive(sessionId: string, directory: string) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { InstanceStore } = await import("@/project/instance-store")
  const { InstanceRef } = await import("@/effect/instance-ref")
  const { Session } = await import("@/session/session")
  const { SessionID } = await import("@/session/schema")
  const ctx = await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory })))
  await AppRuntime.runPromise(
    Session.Service.use((svc) => svc.setArchived({ sessionID: SessionID.make(sessionId) })).pipe(
      Effect.provideService(InstanceRef, ctx),
    ),
  )
}
