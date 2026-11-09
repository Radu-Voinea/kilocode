import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { STALE_INDEX_GRACE_MS, STALE_INDEX_SWEEP_INTERVAL_MS } from "./constants"
import { Log } from "../util/log"

const log = Log.create({ service: "indexing-gc" })

/** File inside each LanceDB database directory naming the workspace it indexes. */
export const WORKSPACE_MARKER = "workspace.json"
const STAMP = ".stale-index-sweep"
const CACHE = /^roo-index-cache-([0-9a-f]{64})\.json$/
const TABLE = /^(.+)-([0-9a-f]{16})$/

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Total size in bytes of every file below `dir` (0 when it does not exist). */
export async function size(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs
          .stat(path.join(entry.parentPath, entry.name))
          .then((stat) => stat.size)
          .catch(() => 0),
      ),
  )
  return sizes.reduce((sum, value) => sum + value, 0)
}

async function mtime(file: string): Promise<number> {
  return fs
    .stat(file)
    .then((stat) => stat.mtimeMs)
    .catch(() => 0)
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

/** Workspace recorded in a database directory's marker, if it matches the directory's hash. */
async function marked(dir: string, hash: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(dir, WORKSPACE_MARKER), "utf-8").catch(() => undefined)
  if (!raw) return undefined
  const value = (() => {
    try {
      return JSON.parse(raw)?.workspacePath
    } catch (err) {
      log.warn("ignoring unreadable workspace marker", { dir, err })
      return undefined
    }
  })()
  if (typeof value !== "string") return undefined
  if (!digest(value).startsWith(hash)) return undefined
  return value
}

/**
 * Workspace a hash cache belongs to. Cache keys are absolute file paths inside the
 * workspace, so the workspace is the ancestor of any key whose sha256 equals the
 * hash in the cache file name. Returns undefined when it cannot be proven.
 */
async function cached(file: string, hash: string): Promise<string | undefined> {
  const raw = await fs.readFile(file, "utf-8").catch(() => undefined)
  if (!raw) return undefined
  const first = (() => {
    try {
      return Object.keys(JSON.parse(raw) ?? {}).at(0)
    } catch (err) {
      log.warn("ignoring unreadable index cache", { file, err })
      return undefined
    }
  })()
  if (!first) return undefined
  for (let dir = path.dirname(first); ; dir = path.dirname(dir)) {
    if (digest(dir) === hash) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

type Entry = {
  workspace?: string
  table?: string
  cache?: string
}

let active: Promise<string[]> | undefined

/** Fire-and-forget sweep shared by every manager in this process. */
export function sweepInBackground(input: Parameters<typeof sweep>[0]): void {
  if (active) return
  active = sweep(input)
    .catch((err) => {
      log.error("stale index sweep failed", { err })
      return []
    })
    .finally(() => {
      active = undefined
    })
}

/**
 * Removes LanceDB tables and hash caches whose workspace directory no longer exists
 * (deleted worktrees, removed checkouts). Only indexes that map back to a workspace
 * with certainty are touched: via the marker in the database directory, or via the
 * cache keys verified against the hashed file name. An index is kept while the
 * workspace's parent directory is missing (e.g. an unmounted drive) and for a grace
 * period after its last write. Runs at most once per interval across processes.
 */
export async function sweep(input: {
  cacheDirectory: string
  lancedbDirectory: string
  keep?: string[]
  now?: number
}): Promise<string[]> {
  const now = input.now ?? Date.now()
  const stamp = path.join(input.cacheDirectory, STAMP)
  const last = Number(await fs.readFile(stamp, "utf-8").catch(() => "0")) || 0
  if (now - last < STALE_INDEX_SWEEP_INTERVAL_MS) return []
  await fs.mkdir(input.cacheDirectory, { recursive: true })
  await fs.writeFile(stamp, String(now))

  const entries = new Map<string, Entry>()
  const entry = (hash: string) => {
    const found = entries.get(hash)
    if (found) return found
    const created: Entry = {}
    entries.set(hash, created)
    return created
  }

  for (const name of await fs.readdir(input.lancedbDirectory).catch(() => [] as string[])) {
    const match = TABLE.exec(name)
    if (!match) continue
    const dir = path.join(input.lancedbDirectory, name)
    const workspace = await marked(dir, match[2])
    if (!workspace || path.basename(workspace) !== match[1]) continue
    const item = entry(digest(workspace))
    item.workspace = workspace
    item.table = dir
  }

  for (const name of await fs.readdir(input.cacheDirectory).catch(() => [] as string[])) {
    const match = CACHE.exec(name)
    if (!match) continue
    const file = path.join(input.cacheDirectory, name)
    const item = entry(match[1])
    item.cache = file
    item.workspace ??= await cached(file, match[1])
    if (!item.workspace || item.table) continue
    const dir = path.join(input.lancedbDirectory, `${path.basename(item.workspace)}-${match[1].slice(0, 16)}`)
    if (await exists(dir)) item.table = dir
  }

  const keep = new Set((input.keep ?? []).map((dir) => path.resolve(dir)))
  const removed: string[] = []
  for (const item of entries.values()) {
    const workspace = item.workspace
    if (!workspace || keep.has(path.resolve(workspace))) continue
    if (await exists(workspace)) continue
    if (!(await exists(path.dirname(workspace)))) continue

    const touched = Math.max(
      item.cache ? await mtime(item.cache) : 0,
      item.table ? await mtime(item.table) : 0,
      item.table ? await mtime(path.join(item.table, "vector.lance", "_versions")) : 0,
      item.table ? await mtime(path.join(item.table, "metadata.lance", "_versions")) : 0,
    )
    if (now - touched < STALE_INDEX_GRACE_MS) continue

    const bytes = item.table ? await size(item.table) : 0
    if (item.table) await fs.rm(item.table, { recursive: true, force: true })
    if (item.cache) {
      await fs.rm(item.cache, { force: true })
      await fs.rm(`${item.cache}.tmp`, { force: true })
    }
    log.info("removed index for missing workspace", { workspace, table: item.table, cache: item.cache, bytes })
    removed.push(workspace)
  }
  return removed
}
