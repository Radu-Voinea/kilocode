import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { STALE_INDEX_GRACE_MS, STALE_INDEX_SWEEP_INTERVAL_MS } from "../../../src/indexing/constants"
import { WORKSPACE_MARKER, sweep } from "../../../src/indexing/stale-indexes"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

describe("stale index sweep", () => {
  let root: string
  let cacheDirectory: string
  let lancedbDirectory: string
  let projects: string
  const later = () => Date.now() + STALE_INDEX_GRACE_MS + 60_000

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-stale-index-"))
    cacheDirectory = path.join(root, "indexing")
    lancedbDirectory = path.join(cacheDirectory, "lancedb")
    projects = path.join(root, "projects")
    fs.mkdirSync(lancedbDirectory, { recursive: true })
    fs.mkdirSync(projects, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  // Lays out an index the way LanceDBVectorStore and CacheManager name it.
  function index(workspace: string, opts: { marker?: boolean; files?: string[] } = {}) {
    const hash = digest(workspace)
    const table = path.join(lancedbDirectory, `${path.basename(workspace)}-${hash.slice(0, 16)}`)
    fs.mkdirSync(path.join(table, "vector.lance", "_versions"), { recursive: true })
    fs.writeFileSync(path.join(table, "vector.lance", "_versions", "1.manifest"), "x")
    if (opts.marker !== false)
      fs.writeFileSync(path.join(table, WORKSPACE_MARKER), JSON.stringify({ workspacePath: workspace }))
    const cache = path.join(cacheDirectory, `roo-index-cache-${hash}.json`)
    const files = opts.files ?? [path.join(workspace, "src", "a.ts")]
    fs.writeFileSync(cache, JSON.stringify(Object.fromEntries(files.map((file) => [file, "hash"]))))
    return { table, cache }
  }

  test("removes the table and cache of a deleted workspace", async () => {
    const gone = index(path.join(projects, "deleted-worktree"))

    const removed = await sweep({ cacheDirectory, lancedbDirectory, now: later() })

    expect(removed).toEqual([path.join(projects, "deleted-worktree")])
    expect(fs.existsSync(gone.table)).toBe(false)
    expect(fs.existsSync(gone.cache)).toBe(false)
  })

  test("maps legacy indexes without a marker through their cache keys", async () => {
    const workspace = path.join(projects, "legacy")
    const gone = index(workspace, { marker: false, files: [path.join(workspace, "deep", "nested", "file.ts")] })

    const removed = await sweep({ cacheDirectory, lancedbDirectory, now: later() })

    expect(removed).toEqual([workspace])
    expect(fs.existsSync(gone.table)).toBe(false)
    expect(fs.existsSync(gone.cache)).toBe(false)
  })

  test("keeps indexes whose workspace still exists", async () => {
    const workspace = path.join(projects, "alive")
    fs.mkdirSync(workspace)
    const alive = index(workspace)

    expect(await sweep({ cacheDirectory, lancedbDirectory, now: later() })).toEqual([])
    expect(fs.existsSync(alive.table)).toBe(true)
    expect(fs.existsSync(alive.cache)).toBe(true)
  })

  test("keeps recently written indexes during the grace period", async () => {
    const recent = index(path.join(projects, "recent"))

    expect(await sweep({ cacheDirectory, lancedbDirectory })).toEqual([])
    expect(fs.existsSync(recent.table)).toBe(true)
  })

  test("keeps indexes whose parent directory is missing, such as an unmounted drive", async () => {
    const unmounted = index(path.join(root, "media", "usb", "project"))

    expect(await sweep({ cacheDirectory, lancedbDirectory, now: later() })).toEqual([])
    expect(fs.existsSync(unmounted.table)).toBe(true)
  })

  test("never touches indexes it cannot map to a workspace", async () => {
    const table = path.join(lancedbDirectory, "unknown-0123456789abcdef")
    fs.mkdirSync(table)
    const forged = path.join(lancedbDirectory, `forged-${digest("/elsewhere").slice(0, 16)}`)
    fs.mkdirSync(forged)
    // A marker whose path does not hash to the directory name is ignored.
    fs.writeFileSync(
      path.join(forged, WORKSPACE_MARKER),
      JSON.stringify({ workspacePath: path.join(projects, "forged") }),
    )
    const empty = path.join(cacheDirectory, `roo-index-cache-${digest("/nowhere")}.json`)
    fs.writeFileSync(empty, "{}")

    expect(await sweep({ cacheDirectory, lancedbDirectory, now: later() })).toEqual([])
    expect(fs.existsSync(table)).toBe(true)
    expect(fs.existsSync(forged)).toBe(true)
    expect(fs.existsSync(empty)).toBe(true)
  })

  test("keeps workspaces the caller is using", async () => {
    const workspace = path.join(projects, "in-use")
    const used = index(workspace)

    expect(await sweep({ cacheDirectory, lancedbDirectory, keep: [workspace], now: later() })).toEqual([])
    expect(fs.existsSync(used.table)).toBe(true)
  })

  test("runs at most once per interval", async () => {
    const now = later()
    expect(await sweep({ cacheDirectory, lancedbDirectory, now })).toEqual([])

    const gone = index(path.join(projects, "deleted-later"))
    expect(await sweep({ cacheDirectory, lancedbDirectory, now: now + 1_000 })).toEqual([])
    expect(fs.existsSync(gone.table)).toBe(true)

    const removed = await sweep({ cacheDirectory, lancedbDirectory, now: now + STALE_INDEX_SWEEP_INTERVAL_MS + 1 })
    expect(removed).toEqual([path.join(projects, "deleted-later")])
  })
})
