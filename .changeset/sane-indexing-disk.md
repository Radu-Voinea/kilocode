---
"@kilocode/kilo-indexing": patch
---

Stop codebase indexing from rewriting the whole LanceDB index over and over: compaction now runs only once the index has grown meaningfully, old versions are pruned when a large index is reopened, interrupted scans and worktree indexes resume instead of rebuilding from scratch, and indexes of deleted workspaces or worktrees are removed automatically.
