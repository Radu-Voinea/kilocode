/**
 * Codebase Index Constants
 */
export const DEFAULT_VECTOR_STORE = "lancedb" as const

export const CODEBASE_INDEX_DEFAULTS = {
  MIN_SEARCH_RESULTS: 10,
  MAX_SEARCH_RESULTS: 200,
  DEFAULT_SEARCH_RESULTS: 50,
  SEARCH_RESULTS_STEP: 10,
  MIN_SEARCH_SCORE: 0,
  MAX_SEARCH_SCORE: 1,
  DEFAULT_SEARCH_MIN_SCORE: 0.4,
  SEARCH_SCORE_STEP: 0.05,
  MIN_EMBEDDING_BATCH_SIZE: 10,
  MAX_EMBEDDING_BATCH_SIZE: 200,
  DEFAULT_EMBEDDING_BATCH_SIZE: 60,
  EMBEDDING_BATCH_SIZE_STEP: 10,
  MIN_SCANNER_MAX_BATCH_RETRIES: 1,
  MAX_SCANNER_MAX_BATCH_RETRIES: 10,
  DEFAULT_SCANNER_MAX_BATCH_RETRIES: 3,
  SCANNER_MAX_BATCH_RETRIES_STEP: 1,
} as const

/**Parser */
export const MAX_BLOCK_CHARS = 1000
export const MIN_BLOCK_CHARS = 50
export const MIN_CHUNK_REMAINDER_CHARS = 200 // Minimum characters for the *next* chunk after a split
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15 // 15% tolerance for max chars

/**Search */
export const DEFAULT_SEARCH_MIN_SCORE = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
export const DEFAULT_MAX_SEARCH_RESULTS = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS

/**File Watcher */
export const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB
// Defensive bound on establishing the native file-watcher subscription.
export const PARCEL_SUBSCRIBE_TIMEOUT_MS = 10_000

/**Directory Scanner */
export const MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000
export const BATCH_SEGMENT_THRESHOLD = 60 // Number of code segments to batch for embeddings/upserts
export const MAX_BATCH_RETRIES = 3
export const INITIAL_RETRY_DELAY_MS = 500
export const PARSING_CONCURRENCY = 10
export const MAX_PENDING_BATCHES = 20 // Maximum number of batches to accumulate before waiting

/**LanceDB maintenance */
// Consider compacting after this many modification operations (each upsert is a
// delete+add). LanceDB recommends optimizing after ~20 modifications.
export const LANCEDB_COMPACT_EVERY_WRITES = 40
// Lance compaction rewrites every fragment below its 1M-row target together with
// the new small fragments, which for a code index is usually the whole table. The
// JS API does not expose the target, so only compact once the rows written since
// the last compaction reach this share of the table. Total rewrite volume then
// stays proportional to the table size instead of growing quadratically with it.
export const LANCEDB_COMPACT_GROWTH = 0.5
// Compact regardless of growth after this many modification operations, which
// bounds fragment count and manifest size for large tables with small edits.
export const LANCEDB_COMPACT_MAX_WRITES = 2000
// On open, prune old versions once the bytes they pin outweigh the live table.
export const LANCEDB_GARBAGE_MIN_BYTES = 64 * 1024 * 1024
// Grace period before old versions may be pruned. Pruning with a zero-length
// window (new Date()) installs an auto-cleanup that races concurrent writers and
// logs "manifest not found"; keep recent versions available for active readers.
export const LANCEDB_CLEANUP_RETENTION_MS = 10 * 60_000

/**Stale index collection */
// Remove indexes whose workspace directory is gone, at most once per interval.
export const STALE_INDEX_SWEEP_INTERVAL_MS = 24 * 60 * 60_000
// Keep an orphaned index this long after its last write, in case the workspace
// is only temporarily missing (renamed, unmounted).
export const STALE_INDEX_GRACE_MS = 3 * 24 * 60 * 60_000

/**Manager Recovery */
export const MAX_MANAGER_RECOVERY_ATTEMPTS = 3
export const INITIAL_MANAGER_RECOVERY_DELAY_MS = 500

/**Embedder Validation */
export const REMOTE_EMBEDDER_VALIDATION_TIMEOUT_MS = 15_000
export const REMOTE_EMBEDDER_VALIDATION_MAX_RETRIES = 2
export const OLLAMA_EMBEDDER_REQUEST_TIMEOUT_MS = 120_000

/**OpenAI Embedder */
export const MAX_BATCH_TOKENS = 100000
export const MAX_ITEM_TOKENS = 8191
export const BATCH_PROCESSING_CONCURRENCY = 10

/**Gemini Embedder */
export const GEMINI_MAX_ITEM_TOKENS = 2048

/**Managed Indexing */
export const MANAGED_MAX_CHUNK_CHARS = 1000
export const MANAGED_MIN_CHUNK_CHARS = 50
export const MANAGED_OVERLAP_LINES = 5
export const MANAGED_BATCH_SIZE = 60
export const MANAGED_FILE_WATCH_DEBOUNCE_MS = 500
export const MANAGED_MAX_CONCURRENT_FILES = 10
export const MANAGED_MAX_CONCURRENT_BATCHES = 50
