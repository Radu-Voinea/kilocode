import path from "path"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Part } from "@kilocode/sdk/v2"
import { airMeta, withAir } from "./air"

type Connection = Pick<AgentSideConnection, "sessionUpdate">

export const CAPABILITY = "agentFileChangeReport"

const MAX_PATHS = 1024
const MAX_BYTES = 256 * 1024
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

type Turn = { requestId: string; files: Set<string> }

/** The request id Air put on a prompt as `_meta.jetbrains.air.agentFileChangeReportRequest`. */
export function requestId(meta: unknown) {
  const request = airMeta(meta)?.agentFileChangeReportRequest as Record<string, unknown> | undefined
  if (!request || typeof request !== "object" || request.version !== 1) return undefined
  return typeof request.requestId === "string" && REQUEST_ID.test(request.requestId) ? request.requestId : undefined
}

/** The files a part says the turn changed: a step's snapshot patch, or a finished file tool. */
export function changedFiles(part: Part): string[] {
  if (part.type === "patch") return part.files
  if (part.type !== "tool" || part.state.status !== "completed") return []
  const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
  const filediff = metadata.filediff as { file?: unknown } | undefined
  if ((part.tool === "edit" || part.tool === "write") && typeof filediff?.file === "string") return [filediff.file]
  if (part.tool !== "apply_patch" || !Array.isArray(metadata.files)) return []
  return metadata.files.flatMap((file: { filePath?: unknown; movePath?: unknown }) =>
    [file.filePath, file.movePath].filter((item): item is string => typeof item === "string"),
  )
}

/**
 * Answers Air's per-turn request for the files the agent changed, which Air uses to review the
 * turn's changes. The file tools record what they changed; a step's snapshot patch would add shell
 * commands, but Kilo takes no snapshots under `kilo acp`. Shell and subagent changes are missing, so
 * the list is never declared complete, as in Air's Claude adapter.
 */
export class Reports {
  private readonly turns = new Map<string, Turn>()

  constructor(private readonly input: { connection: Connection }) {}

  start(sessionId: string, meta: unknown) {
    const id = requestId(meta)
    if (!id) return
    this.turns.set(sessionId, { requestId: id, files: new Set() })
  }

  part(sessionId: string, part: Part) {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    for (const file of changedFiles(part)) turn.files.add(file)
  }

  /** Publishes the turn's report: the changed files, or why there are none to report. */
  async finish(sessionId: string, cwd: string, failure?: "cancelled" | "providerError") {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    this.turns.delete(sessionId)
    const report = failure
      ? { version: 1, requestId: turn.requestId, status: "unavailable", reason: failure }
      : { version: 1, requestId: turn.requestId, status: "reported", ...paths([...turn.files], cwd) }
    await this.input.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", _meta: withAir(undefined, CAPABILITY, report) },
    })
  }
}

/** The changed files inside the session's directory, deduplicated and within Air's limits. */
function paths(files: string[], cwd: string) {
  const root = path.resolve(cwd)
  const state = { bytes: 0, truncated: false, list: [] as string[] }
  for (const file of new Set(files.map((item) => path.resolve(root, item)))) {
    const relative = path.relative(root, file)
    const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    const bytes = Buffer.byteLength(file, "utf8")
    if (!inside || state.list.length >= MAX_PATHS || state.bytes + bytes > MAX_BYTES - 1024) {
      state.truncated = true
      continue
    }
    state.list.push(file)
    state.bytes += bytes
  }
  return { paths: state.list, declaredComplete: false, truncated: state.truncated }
}
