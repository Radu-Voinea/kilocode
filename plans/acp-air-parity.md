# Plan: bring Kilo's ACP integration to parity with Air's Claude adapter

## Goal

JetBrains Air drives Kilo through ACP (`kilo acp`, registered in Air as the custom agent "Kilo (fork)").
Air's bundled Claude adapter (`@agentclientprotocol/claude-agent-acp`) supports much more of Air than
Kilo does. Port the ten features below so Kilo in Air behaves like Claude in Air. Each feature ships on
its own: implement, test, commit, push to `main` (which releases `7.8.27.N`), install, check in Air.

Already done on this fork (don't redo): question tool as form elicitation with Air's custom-answer
marker (`src/kilocode/acp/question.ts`), `/compact` in the command list (`src/kilocode/acp/commands.ts`),
native subagent sessions and subagent permission/question routing (`src/kilocode/acp/subagents.ts`).

## References

- **Claude adapter source (the contract to copy).** Published JS with comments, no docs folder:
  ```bash
  mkdir -p /tmp/claudeacp && cd /tmp/claudeacp && curl -sL "$(curl -s https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.89.1 | jq -r .dist.tarball)" | tar xz
  ```
  `package/dist/air-extension.js` has every `_meta.jetbrains.air` key and capability name, and the
  helpers `withAirMeta`, `airCapabilityMeta`, `clientSupportsAirCapability`. `acp-agent.js` is the
  agent; each feature below names its module.
- **What Air advertises.** Air sends `clientCapabilities._meta.jetbrains.air = { version: 1, capabilities: [...] }`.
  The current Air build (IU-263.7307.200) advertises: `sessionFailure`, `recommendedValue`,
  `nativeSubagentSessions`, `asyncTasks`, `backgroundSubagents`, `agentFileChangeReport`, `planFile`,
  `diffPatch`, `rawInputRendering`, `planContentDelta`, `modelProviderGroups`, `loadReplayEnd`,
  `sessionIndex`. The agent must advertise a capability back in
  `initialize.agentCapabilities._meta.jetbrains.air.capabilities` before Air uses it (see
  `nativeSubagentsMeta()` in `subagents.ts`); merge, don't overwrite, when several features add one.
- **Air internals, for checking a payload.** Air's ACP code is in
  `~/.local/share/JetBrains/Toolbox/apps/intellij-idea/plugins/air-plugin/lib/modules/intellij.air.backend.acp*.jar`.
  `javap -c -p -constants` on a class shows the JSON keys it reads. Search jars by listing them with
  `unzip -l`; don't run `javap` once per class in a loop (thousands of classes, it stalls).
- **Probes.** `plans/acp-air-parity/probe-compact.ts` and `probe-subagent.ts` are small ACP clients
  that start the patched CLI, run a prompt, and print every update per session. Copy one per feature.
  Run from the repo root:
  `PATH=$HOME/.local/kilo-dev-bin:$PATH bun plans/acp-air-parity/probe-subagent.ts packages/opencode <scratch dir> native`.
  They use the real `~/.config/kilo` config and model (cheap, but real calls); use an empty scratch
  folder as the session cwd so indexing stays trivial.

## Conventions and constraints

- Kilo-only code goes in `packages/opencode/src/kilocode/acp/`, tests in `packages/opencode/test/kilocode/acp/`.
  Edits to shared files (`src/acp/*.ts`) get `// kilocode_change` markers; check with
  `bun run script/check-opencode-annotations.ts --worktree`.
- Gate every Air-only payload on the client capability; plain ACP clients must see unchanged behavior.
  Standard ACP updates (`plan`, `session_info_update`, `current_mode_update`, `config_option_update`)
  need no gate.
- **Bun:** the repo pins Bun 1.4.4 for builds. Locally, `~/.local/kilo-dev-bin/bun` wraps the installed
  Kilo binary as Bun (`BUN_BE_BUN=1 ~/.kilo/bin/kilo`); it's fine for `bun test`, `bun run typecheck` in
  `packages/opencode`, prettier and the annotation check. `script/build.ts` refuses it, so CI builds
  releases.
- **Never run the repo-wide typecheck or the pre-push hook locally**: Turbo typechecks every package in
  parallel and used ~64 GB of RAM. Typecheck only `packages/opencode`, and push with `--no-verify`.
  CI's `typecheck` workflow covers the rest.
- Checks per feature: `bun test test/kilocode/acp test/acp` and `bun run typecheck` in
  `packages/opencode`, prettier on changed files, the annotation check, then a probe run.
- Release: push to `main` of `Radu-Voinea/kilocode` → `fork-release` builds `7.8.27.N` (~8 min).
  Install with `curl -fsSL https://raw.githubusercontent.com/Radu-Voinea/kilocode/main/script/fork-install.sh | bash`
  (it restarts running Kilo ACP agents). Ask the user before installing: it stops their running agent.

## Features, in order

Each: the Air contract to copy, where Kilo has the data, notes, and how to verify.

### 1. Plan updates — standard `plan`

- **Contract:** `{ sessionUpdate: "plan", entries: [{ content, priority, status }] }`, the full list each
  time. See `acp-agent.js` around the `TodoWrite` handling (search `sessionUpdate: "plan"`).
  `planContentDelta` (advertised by Air) is an optional streaming refinement; skip unless cheap.
- **Kilo:** the `todowrite` tool (used ~660 times in this user's history). The SDK defines a
  `todo.updated` event, but I didn't find where v1 emits it; if it doesn't, use the `todowrite` tool
  part's input/metadata, and `GET /session/{id}/todo` for the current list. Map statuses (`pending`, `in_progress`,
  `completed`, `cancelled` → drop or `completed`) and priorities.
- **Also:** on `loadSession` replay, send the current plan once. For subagent sessions, send it under
  the subagent's session id (native) or not at all (plain).
- **Verify:** probe that asks for a 3-step todo list; expect `plan` updates as items change.

### 2. Session titles — standard `session_info_update`

- **Contract:** `{ sessionUpdate: "session_info_update", title }` (see `session-titles.js`). Kilo
  generates titles itself, so none of the Claude title-generation logic is needed.
- **Kilo:** `session.updated` events carry `info.title`. Send it when it changes for a known ACP
  session (not for subagents; their name comes from `subagent_spawned`).
- **Verify:** new session, first prompt; expect a `session_info_update` once Kilo titles it.

### 3. Mode and model sync — `current_mode_update`, `config_option_update`

- **Contract:** `{ sessionUpdate: "current_mode_update", currentModeId }` (`session-mode.js`,
  `exit-plan.js`) and `{ sessionUpdate: "config_option_update", configOptions }` (`acp-agent.js`
  ~6718) when the agent or model changes without the client asking.
- **Kilo:** the plan agent's `plan_exit` (handled in `src/session/prompt.ts` and
  `src/kilocode/plan-file.ts`) switches to `code`; agent switches show on the next
  assistant message's `agent` field (and `session.next.agent.switched` / `model.switched` if v1 emits
  them; verify). `buildConfigOptions` in `src/acp/config-option.ts` builds the options;
  `ACPSession` stores the current mode and model.
- **Verify:** start in `plan`, approve the plan; expect `current_mode_update` to `code`.

### 4. Context compaction — `compaction_update`, `compaction_summary_chunk`

- **Contract:** `context-compaction.js` and `context-compaction-meta.js`: a compaction gets an id,
  `compaction_update` with `status: "in_progress"`, then summary text via `compaction_summary_chunk`,
  then a terminal `compaction_update` (`completed` / `failed` / `cancelled`). Air-only facts go in
  `_meta.jetbrains.air.contextCompaction`.
- **Kilo:** `CompactionPart` (`type: "compaction"`, `auto`, `overflow`) marks it; the summary is the
  following assistant message; `session.compacted` ends it. Today the summary streams as ordinary
  `agent_message_chunk` / `agent_thought_chunk` (seen with `/compact`); route those chunks into the
  compaction instead while one is active. Cover both `/compact` and auto-compaction.
- **Verify:** `probe-compact.ts`; expect the new update kinds instead of plain message chunks.

### 5. Session failures and notices — `sessionFailure`, `notice`

- **Contract:** `session-failure-extension.js` (typed failures such as usage limits, published via
  `session_info_update` `_meta`) and `session-notices.js` (`{ sessionUpdate: "notice", severity, title,
  description? }`, only when the client supports it; otherwise a bold transcript line).
- **Kilo:** `session.error` events (provider auth, rate limits, context overflow, aborted), and
  `RetryPart` / `session.next.retried` for retries. Map Kilo's error names to Air's failure kinds;
  unknown errors become a generic notice.
- **Verify:** force a failure (invalid model id, or a provider with a bad key in a temporary config via
  `KILO_CONFIG_CONTENT`); expect a failure/notice update, not raw text.

### 6. Diff patches — `diffPatch`

- **Contract:** `diff.js`: edit tool calls carry a git-style patch so Air renders a real diff; size and
  time limits fall back to standard ACP `diff` content. Note `writeProposedEdit` in
  `src/acp/permission.ts` already writes proposed edits via `writeTextFile`.
- **Kilo:** `edit`, `write` and `apply_patch` tool parts carry `metadata.diff` (unified diff) and
  `filediff`; `src/acp/tool.ts` builds tool content today. Reuse Kilo's diff instead of recomputing.
- **Verify:** probe asking for a one-line edit in a scratch file; check the tool call content.

### 7. File change report — `agentFileChangeReport`

- **Contract:** `file-change-audit.js` (what the report contains and when it's sent per turn).
- **Kilo:** `PatchPart` (`files`, `hash`) per step and `session.diff` events (`GET /session/{id}/diff`).
- **Verify:** probe that edits two files; expect one report listing both.

### 8. Steering — `_session/steering`

- **Contract:** an agent-side extension method (search `_session/steering` in `acp-agent.js`): the
  client sends a message while a turn runs, and the agent injects it into the running turn. Advertise
  it the way the adapter does.
- **Kilo:** `POST /session/{id}/prompt_async` and the prompt queue (`session.queue.changed`). Wire it
  through `AgentSideConnection`'s ext-method handler in `src/acp/agent.ts`.
- **Verify:** start a long prompt, send a steering message mid-turn; expect the agent to pick it up.

### 9. Async tasks — `asyncTasks`, `backgroundSubagents`

- **Contract:** `async-tasks.js` (866 lines): `async_task_spawned`, `async_task_progress`,
  `async_task_state_update`, plus `_session/async_task/stop` to stop one from Air. Background subagents
  appear as async tasks too.
- **Kilo:** the `background_process` tool (start/list/stop of long commands) and the `task` tool with
  `background: true` (metadata `background: true`, `jobId`), which only exists when
  `KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS` is set. `subagents.ts` already finishes background
  subagents when their session goes idle; extend that rather than duplicating it.
- **Verify:** probe that starts `sleep 20` in the background and a background subagent; stop one from
  the probe with `_session/async_task/stop`.

### 10. Session index — `sessionIndex`, `sessionArchive`, `sessionRename`, `sessionListSubscribe`

- **Contract:** `acp-agent.js` (`this.sessionIndex`) and the capability comments in `air-extension.js`:
  `_session/archive`, `_session/unarchive`, `_session/rename`,
  `_session/list/subscribe` / `unsubscribe` / `changes`. These are advertised only when the client
  declares `sessionIndex`.
- **Kilo:** `session.updated` (`title`, `time.archived`), `session.created` / `session.deleted`, and the
  session update API (rename and archive). Keep subagent sessions out of the index, as `listSessions`
  already does.
- **Verify:** rename and archive from a probe; check `session/list` and the change stream.

## Not in scope

- `goal` and `customInstructions`: this Air build doesn't advertise them.
- Cosmetic tool-call `_meta` (`commandTitle`, `skill`, `kind`, `rawInputRendering`): add opportunistically
  while touching `tool.ts`, not as their own task.
- Upstreaming to Kilo-Org: their `main` only takes bug fixes, and v2 is a separate port.
