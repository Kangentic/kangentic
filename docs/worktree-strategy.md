# Worktree & Git Strategy

## Worktrees

Each task gets its own git worktree so agents work in isolation. Multiple agents can run in parallel without conflicting on the working tree.

`src/main/git/worktree-manager.ts` handles creation, cleanup, and branch management.

### Branch Naming

Format: `{slug}-{taskId8}`

- `slug` - slugified task title (lowercase, hyphens, truncated)
- `taskId8` - first 8 characters of the task UUID

Example: `fix-auth-bug-a1b2c3d4`

Worktree directory: `<project>/.kangentic/worktrees/{slug}-{taskId8}/`

Custom branch names (set per-task) use the custom name as the branch, with a slugified folder name: `{slugifiedCustom}-{taskId8}/`.

### Base Branch Resolution

Checked in priority order:

1. Task's `base_branch` field (per-task override)
2. Action config's `baseBranch` (per-transition override)
3. `kangentic.json` `defaultBaseBranch` (team-shared, overridable via `kangentic.local.json`)
4. `config.git.defaultBaseBranch` (per-user fallback, defaults to `main`)

If the remote branch exists, the worktree branches from `origin/<baseBranch>`. Otherwise falls back to the local branch.

The chosen base branch is stored in the worktree's git config as `kangentic.baseBranch` so agents can read it without filesystem access.

### Concurrency

All git-mutating operations (create, remove, branch delete, prune, checkout, rename) are serialized per project via a priority-aware queue (`WorktreeManager.withGitLock` / instance `withLock`). Exactly one operation runs at a time per project (preserving the `.git` lock-contention guarantee), but waiting operations are ordered by `GitQueuePriority` - `USER` (0, the default) runs ahead of `BACKGROUND` (10, e.g. retry cleanups and background prune), with FIFO order within a priority band. This keeps a user-initiated spawn from head-of-line-blocking behind a slow or failing background cleanup. Different projects run independently. `removeWorktree`'s `{ timeoutMs, removalProfile }` options bound how hard a removal retries so one stuck delete cannot hold the queue: `removalProfile` is one of `thorough` (full backoff; the default, used where a failure surfaces an error to the user such as worktree create or project delete), `moderate` (a pinned path fails in a few seconds; used on the user-facing Done-move and cleanup paths so a held handle never holds the queue for minutes), or `fast` (a single attempt; used by the background startup retry pass). `clearQueue` (on project close) rejects any still-waiting jobs so their callers do not hang.

When a removal fails because a process still pins the worktree, `removeWorktree` reaps orphaned processes whose command line points inside that worktree path (a zombie Electron/node left by an agent's E2E run or `/preview`) and retries once. This reap is lazy by design: a clean Done-move never runs the OS process scan, so dragging a task to Done pays no added cost; the scan fires only on the rare delete a held handle actually blocks. It is skipped under `NODE_ENV=test`, where the E2E leak janitor owns process sweeps instead.

### Creation Flow

1. Create `.kangentic/worktrees/` directory
2. `git fetch origin <baseBranch>` (best-effort, falls back to local branch)
3. `git worktree prune` (clean up stale metadata from previous failed cleanups)
4. Clean up the stale worktree directory if it exists on disk. If removal fails because a process holds the directory as its current directory (Windows pinned-CWD) and the leftover is an empty husk, reuse it in place; if it is non-empty or cannot be inspected, fail with an actionable error naming the likely blocker (an open terminal or editor, the `/preview` dev server, or antivirus).
5. Check if branch already exists (stale branch from failed cleanup, or custom branch)
6. If branch exists: `git worktree add [--force] <worktreePath> <branchName>`
7. If new branch: `git worktree add [--force] -b <branchName> <worktreePath> <startPoint>` (`--force` is added only when reusing an empty husk from step 4, to clear any stale `.git/worktrees/` registration whose directory still exists)
8. On Windows: enable `core.longpaths` (see below)
9. `git config kangentic.baseBranch <baseBranch>` (in worktree)
10. Set up sparse-checkout (see below)
11. Copy optional files from repo root (configured via `config.git.copyFiles`)
12. Create `node_modules` junction/symlink to root repo's `node_modules` (skipped when `config.git.linkNodeModules` is `false`, so a worktree can own its own dependencies)
13. Run the Post-Worktree Script if `config.git.initScript` is set (see below)
14. Pre-populate `~/.claude.json` trust entry for the worktree path

### Windows Long Paths

On Windows, projects with deeply nested file paths (e.g. .NET migrations, `node_modules` trees) can exceed the default 260-character path limit when checked out into a worktree under `.kangentic/worktrees/<slug>/`. This causes `git worktree add` and subsequent git operations to fail with "Filename too long" errors.

Kangentic enables `core.longpaths` in two places:

1. **`git worktree add`** - the `-c core.longpaths=true` flag is passed as a per-command config override so the checkout itself succeeds. This does not modify any persistent git config.
2. **Worktree local config** - after creation, `git config core.longpaths true` is set in the worktree's local config so all subsequent operations (sparse-checkout, agent commits, merges) also use extended-length paths.

This setting uses the `\\?\` extended-length path prefix on Windows. macOS and Linux have 1024-4096 byte `PATH_MAX` limits and are unaffected - the setting is only applied on `process.platform === 'win32'`.

## node_modules Linking and the Post-Worktree Script

By default Kangentic symlinks (junction on Windows, directory symlink on POSIX) the root repo's `node_modules` into each new worktree so agents can run typecheck/tests immediately without a slow `npm install`. The link is non-fatal: if the root has no `node_modules` yet, the step is skipped silently.

The shared link has a trade-off: the worktree runs the *root's* dependencies, not the branch's, and a worktree `npm install` writes back through the link into the main repo. For a branch that changes dependencies, set `config.git.linkNodeModules` to `false` to skip linking, then use the Post-Worktree Script to install the worktree's own dependencies.

The **Post-Worktree Script** (`config.git.initScript`, surfaced as "Post-Worktree Script" in Git settings) runs once in each new worktree, after files are copied and `node_modules` is linked (or deliberately skipped). It runs through the platform shell - `cmd.exe` on Windows, `/bin/sh` on POSIX - so the same configured command works cross-platform for simple cases like `npm install`. While it runs, the task card shows a "Running setup script..." phase.

The script is **fatal**: a non-zero exit, a timeout (10-minute cap), or cancellation (a superseding move or app shutdown) rejects worktree creation and fails the task move / agent spawn, surfacing the captured output. The worktree directory is left on disk on failure, exactly as a failed file copy is; the next attempt reuses or recreates it.

## Sparse-Checkout

Worktrees exclude only `.claude/commands/` from checkout using sparse-checkout in `--no-cone` mode:

```
git sparse-checkout init --no-cone
git sparse-checkout set '/*' '!/.claude/commands/'
```

**Why only commands are excluded:** Claude Code's discovery behavior differs by artifact type:

- **Commands** walk up the directory tree from the worktree CWD to the main repo's `.claude/commands/`. Excluding them from the worktree prevents duplicate discovery.
- **Skills** and **agents** do NOT walk up. They are only discovered from the project root's `.claude/` directory. Since each worktree is its own project root (has a `.git` file), skills and agents must be present in the worktree checkout to be visible to the agent.

Worktrees get all files including `.claude/settings.json` (so Claude resolves permissions naturally), `.claude/skills/`, and `.claude/agents/`. `.claude/settings.local.json` is untracked (gitignored), so it's not present in worktrees from checkout -- writes to it (from Kangentic hooks or Claude's "always allow") are invisible to git.

Sparse-checkout was chosen over `skip-worktree` because skip-worktree flags get lost during rebase and merge operations. Sparse-checkout survives all git operations.

Sparse-checkout requires git 2.25+. On older git versions (some Linux distros), the commands fail gracefully -- worktrees still work but `.claude/commands/` will be present, which may cause duplicate command discovery.

## Hook Delivery

Two bridge scripts integrate Claude Code's hook system with Kangentic's UI.

### Bridge Scripts

All in `src/main/agent/`:

| Script | Output File | Hook Points | Data |
|--------|-------------|-------------|------|
| `status-bridge.js` | `status.json` | statusLine | Token usage, cost, model, context % |
| `event-bridge.js` | `events.jsonl` | 18 hook event types (see below) | Tool calls, prompts, interrupts, activity state (JSONL) |

The event bridge injects into all 18 Claude Code hook events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PermissionRequest`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Notification`, `PreCompact`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`. See [Agent Integration](agent-integration.md#hook-injection) for the full mapping.

Each bridge reads JSON from stdin (piped by Claude Code), writes to its output file, and exits. All writes are try/catch wrapped for non-fatal failures.

Activity state (thinking/idle) is derived from event types in the events pipeline. See [Activity Detection](activity-detection.md) for the full design.

### Settings Merge

All sessions (main repo and worktree) use a unified approach. For each session, a merged settings file is built at `.kangentic/sessions/<sessionId>/settings.json` and passed via `--settings`:

1. Read `.claude/settings.json` from project root (committed, shared)
2. Deep-merge `.claude/settings.local.json` from project root (gitignored, personal)
3. For worktrees: merge permissions from the worktree's `.claude/settings.local.json` (captures "always allow" grants -- hooks are skipped since they may be stale leftovers from before the unified approach)
4. Inject bridge commands into appropriate hook points
5. When the MCP server is attached, append `mcp__kangentic` to `permissions.allow` (append-if-absent) so kangentic's own tools never prompt in default mode
6. Write merged file to session directory
7. Pass `--settings <mergedSettingsPath>` to the CLI

All Kangentic artifacts stay in `.kangentic/` -- nothing is written to `.claude/settings.local.json`. When users hit "always allow" on a permission prompt, Claude writes to `settings.local.json` in the CWD (worktree or project root). These grants are read back on session resume (step 3) so they persist across restarts.

### Hook Identification

Kangentic hooks are identified by two markers in the command string:
- Contains `.kangentic` (path component)
- Contains a known bridge name (`activity-bridge` or `event-bridge`)

Both must match. This prevents false positives on user-defined hooks with similar names. The `activity-bridge` check is for backwards compatibility with older session directories -- the current bridge script is `event-bridge`.

## Session Directory

Each Claude Code session gets a directory at `<project>/.kangentic/sessions/<claudeSessionId>/`:

```
.kangentic/sessions/<uuid>/
  settings.json    # Merged settings passed via --settings
  status.json      # Usage data (written by status-bridge, watched by SessionManager)
  events.jsonl     # Structured event log + activity state (appended by event-bridge)
```

The SessionManager watches these files with debounced `fs.watch` and emits IPC events to the renderer. Activity state (thinking/idle) is derived from event types -- see [Activity Detection](activity-detection.md).

## Session Lifecycle

```
Task created (To Do)
  → No session, no worktree

Task moved to active column (e.g., Planning)
  → Create worktree (if enabled)
  → Spawn agent: claude --session-id <uuid> "prompt"
  → Status: running
  → Bridge scripts write to session directory
  → File watchers emit usage/activity/events to UI

Task moved between active columns (e.g., Planning → Code Review)
  → If no auto_command: session stays alive (regardless of permission mode)
  → If auto_command configured on target: suspend and resume with command as prompt

Task moved to Done
  → Confirmation dialog ONLY when the worktree has uncommitted files or unpushed
    commits (or the git probe fails). A clean move is recoverable (branch +
    session preserved, worktree restored on resume) and proceeds without asking.
  → Session suspended (PTY killed, DB record preserved)
  → Status: suspended
  → Local worktree directory deleted; worktree_path cleared in DB
  → branch_name and session files preserved on disk for resume
  → Task archived

Task moved back from Done (into any non-todo, non-done column)
  → Worktree recreated from preserved branch_name via ensureTaskWorktree
    (runs regardless of auto_spawn so the code is always on disk)
  → Recreation verifies the worktree still exists on disk; a leftover empty
    husk (a Done cleanup that could not delete the directory) is reused in place
  → If target has auto_spawn: claude --resume <uuid> (no prompt, continues context)
  → Status: running

Task moved to To Do
  → Full cleanup: session killed, worktree removed, branch deleted (if config.git.autoCleanup)
  → DB references cleared (worktree_path, branch_name set to null)
  → Next activation creates a fresh worktree and branch

Task deleted
  → Full cleanup: session killed, worktree removed, branch deleted (if config.git.autoCleanup)

App closed
  → All sessions marked suspended in DB (synchronous)
  → PTYs force-killed immediately (no graceful shutdown window)
  → Session files persist

App reopened
  → Recover: orphaned/suspended sessions resumed or respawned
  → Reconcile: tasks in auto_spawn columns without sessions get fresh agents
```

## Cleanup

### On Project Open

- **`pruneOrphanedWorktrees()`** -- Scans `.kangentic/worktrees/`. If a worktree directory was deleted externally, deletes the associated task (skips tasks with active PTYs).

### On Project Close/Delete

- **`stripKangenticHooks()`** -- Removes all Kangentic hooks from `.claude/settings.local.json`. Backs up the file before modification, restores on error. Removes empty settings files and `.claude/` directories if they only contained our hooks.
- **`cleanupProject()`** -- Kills all PTYs, detaches worktrees, strips hooks, removes `.kangentic/` directory and DB files, removes `.kangentic/` from `.gitignore`.

### On Task Delete

- **`cleanupTaskResources()`** - Kills PTY, deletes session DB records, removes session directory, removes worktree (serialized via `withLock`), prunes stale worktree metadata, optionally deletes branch.

## Safety

- **No git contamination** -- `.claude/commands/` excluded from worktrees via sparse-checkout (commands walk up, so exclusion prevents duplicates). `.claude/skills/` and `.claude/agents/` are kept in worktrees (they do not walk up and must be present). `.claude/settings.json` is present (from git). `settings.local.json` is untracked and gitignored. Hooks are delivered via `--settings` flag for all sessions (main repo and worktree) -- Kangentic never writes to `.claude/settings.local.json`.
- **Hook identification** -- two-marker pattern (`.kangentic` + bridge name) prevents touching user hooks.
- **Backup on strip** -- `stripKangenticHooks()` backs up settings before modification, restores on failure.
- **Orphan dedup** -- on session resume, old PTY is killed and its file paths nulled before new PTY spawns. Prevents stale `onExit` handlers from deleting files the new session needs.
- **Trust pre-population** -- `ensureWorktreeTrust()` adds worktree paths to `~/.claude.json` so Claude Code doesn't prompt for trust on first run.
- **Synchronous shutdown** -- DB records marked suspended, PTYs force-killed immediately. No async graceful window. Files persist for recovery on next launch.

## Test Coverage

Unit tests (`tests/unit/`, run with `npm run test:unit`) cover the worktree strategy areas below.

### Trust Manager (`trust-manager.test.ts`)

- Creates `~/.claude.json` with trust entry when file doesn't exist
- Creates trust entry when file exists but has no `projects` key
- Skips write if worktree already trusted (idempotent)
- Copies `enabledMcpjsonServers` from parent project entry
- Uses empty array when parent has no MCP servers
- Preserves existing worktree entry fields while setting `hasTrustDialogAccepted`
- Handles malformed JSON (treats as empty)

Uses real temp files with mocked `os.homedir()`.

### Worktree Manager (`worktree-manager.test.ts`)

**Sparse-checkout** (`.claude/commands/` exclusion):
- Initializes sparse-checkout with `--no-cone` and excludes `.claude/commands/` only
- Sparse-checkout runs before `copyFiles`
- Skips `.claude/` entries in `copyFiles`
- No `skip-worktree` or `update-index` calls
- Does not call `rmSync` for `.claude` directories

**Fetch and base branch:**
- Fetch succeeds → worktree created with `origin/<baseBranch>` as start point
- Fetch fails (no remote) → worktree created with local `<baseBranch>` as start point
- Stores `kangentic.baseBranch` in worktree git config
- `kangentic.baseBranch` config failure is non-fatal

**Removal:**
- `removeWorktree` calls `git worktree remove --force`
- `removeWorktree` falls back to `rmSync` + `git worktree prune` on failure
- `removeWorktree` no-ops when path doesn't exist
- `removeBranch` calls `git branch -D`
- `removeBranch` silently handles missing branch

**Stale branch recovery:**
- `createWorktree` reuses auto-generated branch that already exists (no `-b` flag)
- `createWorktree` prunes stale worktree metadata before checking branch
- `createWorktree` cleans up stale directory before `git worktree add`
- `pruneWorktrees` calls `git worktree prune`

**Priority queue:**
- Concurrent operations on same project execute sequentially (one at a time)
- Concurrent operations on different projects execute in parallel
- Failed operation does not block subsequent operations
- A later `USER`-priority op jumps ahead of an already-queued `BACKGROUND` op; equal priority drains FIFO
- `clearQueue` removes the project entry and rejects any still-waiting jobs
- `withLock` instance method uses the project path

**Fail-fast removal:**
- `removeWorktree({ removalProfile: 'fast' })` forwards single-attempt opts to `removeWithRetry`; the default `'thorough'` profile keeps the full backoff
- Background retry cleanup runs at `BACKGROUND` priority with `{ timeoutMs: 3000, removalProfile: 'fast' }`

**listWorktrees:**
- Parses `git worktree list --porcelain` output correctly
- Returns empty array for bare output

Uses vi.mock for `simple-git` and `node:fs`.

### Hook Manager (`hook-manager.test.ts`)

- Inject event hooks creates correct hook entries
- Hooks preserve user-defined hooks
- Strip removes all Kangentic hooks, preserves user hooks
- Strip cleans up empty settings file
- Strip handles missing file gracefully

Uses real temp files.

### Session Queue (`session-queue.test.ts`)

- FIFO ordering with configurable concurrency
- Queue drain callback fires when all tasks complete
- Task errors don't block subsequent tasks
