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

All git-mutating operations (create, remove, branch delete, prune, checkout, rename) are serialized per project via a promise-chain queue (`WorktreeManager.withGitLock`). Different projects run independently. This eliminates git lock contention when multiple tasks are dragged simultaneously.

### Creation Flow

1. Create `.kangentic/worktrees/` directory
2. `git fetch origin <baseBranch>` (best-effort, falls back to local branch)
3. `git worktree prune` (clean up stale metadata from previous failed cleanups)
4. Clean up stale worktree directory if it exists on disk
5. Check if branch already exists (stale branch from failed cleanup, or custom branch)
6. If branch exists: `git worktree add <worktreePath> <branchName>`
7. If new branch: `git worktree add -b <branchName> <worktreePath> <startPoint>`
8. On Windows: enable `core.longpaths` (see below)
9. `git config kangentic.baseBranch <baseBranch>` (in worktree)
10. Set up sparse-checkout (see below)
11. Copy optional files from repo root (configured via `config.git.copyFiles`)
12. Create `node_modules` junction/symlink to root repo's `node_modules`
13. Pre-populate `~/.claude.json` trust entry for the worktree path

### Windows Long Paths

On Windows, projects with deeply nested file paths (e.g. .NET migrations, `node_modules` trees) can exceed the default 260-character path limit when checked out into a worktree under `.kangentic/worktrees/<slug>/`. This causes `git worktree add` and subsequent git operations to fail with "Filename too long" errors.

Kangentic enables `core.longpaths` in two places:

1. **`git worktree add`** - the `-c core.longpaths=true` flag is passed as a per-command config override so the checkout itself succeeds. This does not modify any persistent git config.
2. **Worktree local config** - after creation, `git config core.longpaths true` is set in the worktree's local config so all subsequent operations (sparse-checkout, agent commits, merges) also use extended-length paths.

This setting uses the `\\?\` extended-length path prefix on Windows. macOS and Linux have 1024-4096 byte `PATH_MAX` limits and are unaffected - the setting is only applied on `process.platform === 'win32'`.

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
| `event-bridge.js` | `events.jsonl` | 17 hook event types (see below) | Tool calls, prompts, interrupts, activity state (JSONL) |

The event bridge injects into all 17 Claude Code hook events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Notification`, `PreCompact`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`. See [Claude Integration](claude-integration.md#hook-injection) for the full mapping.

Each bridge reads JSON from stdin (piped by Claude Code), writes to its output file, and exits. All writes are try/catch wrapped for non-fatal failures.

Activity state (thinking/idle) is derived from event types in the events pipeline. See [Activity Detection](activity-detection.md) for the full design.

### Settings Merge

All sessions (main repo and worktree) use a unified approach. For each session, a merged settings file is built at `.kangentic/sessions/<sessionId>/settings.json` and passed via `--settings`:

1. Read `.claude/settings.json` from project root (committed, shared)
2. Deep-merge `.claude/settings.local.json` from project root (gitignored, personal)
3. For worktrees: merge permissions from the worktree's `.claude/settings.local.json` (captures "always allow" grants -- hooks are skipped since they may be stale leftovers from before the unified approach)
4. Inject bridge commands into appropriate hook points
5. Write merged file to session directory
6. Pass `--settings <mergedSettingsPath>` to the CLI

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
  → Session suspended (PTY killed, DB record preserved)
  → Status: suspended
  → Session files persist on disk
  → Task archived

Task moved back from Done
  → Resume: claude --resume <uuid> (no prompt, continues context)
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

**Serial queue:**
- Concurrent operations on same project execute sequentially
- Concurrent operations on different projects execute in parallel
- Failed operation does not block subsequent operations
- `clearQueue` removes the project entry
- `withLock` instance method uses the project path

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
