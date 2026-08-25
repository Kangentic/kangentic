# Worktree & Git Strategy

## Worktrees

Each task gets its own git worktree so agents work in isolation. Multiple agents can run in parallel without conflicting on the working tree.

`src/main/git/worktree-manager.ts` handles creation, cleanup, and branch management.

### Branch Naming

Format: `{slug}-{taskId8}`, or `{flattenedBase}/{slug}-{taskId8}` when the resolved base branch
differs from the effective default (`computeAutoBranchName` in `src/shared/slugify.ts`).
`flattenedBase` is the base branch with any `/` replaced by `-` (e.g. `release/2.0` becomes
`release-2.0`), so the auto-generated branch has at most one namespace segment.

- `slug` - slugified task title (lowercase, hyphens, truncated)
- `taskId8` - first 8 characters of the task UUID

Examples: `fix-auth-bug-a1b2c3d4` (base equals the effective default); `release-2.0/fix-auth-bug-a1b2c3d4` (an explicit per-task base that differs from it).

Custom branch names (set per-task) are used as the branch verbatim.

### Worktree Directory Naming

Worktree directory: `<project>/.kangentic/worktrees/{display_id}/` - always flat, and named for the
task's `display_id` (the `#N` shown on its card), independent of the branch.

The directory used to be `{slug}-{taskId8}`. Kangentic's own contribution to the path was therefore
about 49 characters (`\.kangentic\worktrees\` plus a folder name of up to 28), with the
title-derived slug as the larger and unbounded half. The numeric name takes that to about 24: the
`\.kangentic\worktrees\` prefix remains, and only the folder name shrank. It is also strictly more
stable, because the old name was derived from the task title, so renaming a task changed the folder
it would be recreated in.

How much that matters in practice is measured in
[cross-platform.md](cross-platform.md#windows-max_path-is-mostly-not-the-wall-people-expect), which
also records why there is no path-length warning and no configurable worktree root. In short: a
shorter root does help a native Windows toolchain, but it can never be a guarantee, because
Kangentic controls neither the project's own location nor how deep a build runs beneath it. The
naming change is worth making on its own merits (stability, see below); treat the path saving as a
bonus rather than a fix.

#### The folder is chosen once and never changes

`tasks.worktree_folder` records the directory name for the life of the task.

- Non-null: used verbatim. This covers every worktree created before the numeric scheme, which
  keeps its legacy `{slug}-{taskId8}` name. Nothing on disk is ever renamed or relocated.
- Null: the folder is `String(display_id)`, and the caller persists it via
  `TaskRepository.recordWorktree`, which writes path, branch and folder in one transaction.
- Invariant: whenever `worktree_path` is non-null,
  `path.basename(worktree_path) === worktree_folder`.

This is load-bearing rather than cosmetic. Moving a task to Done nulls `worktree_path`, so moving it
back out is a **fresh creation**. If it landed at a different path, the agent's transcript would be
orphaned (Claude keys it by a slug of the cwd, so `--resume` reports "No conversation found") and
the worktree's browser cookie jar would be dropped (`browserPartitionForWorktree` hashes the path).

For a task that predates the column and has already been through Done, both `worktree_path` and
`worktree_folder` are null. `TaskRepository.recoverLegacyWorktreeFolder` recovers the original name
from the task's most recent `sessions.cwd`, accepting it only when it is a **direct child of that
project's own worktrees root**. The anchor matters: Kangentic can be opened *at* a worktree path, so
a project root can itself contain `.kangentic/worktrees/`, and a bare marker search would hand a
task that never had a worktree the enclosing worktree's name - permanently, since the column is
write-once. The migration deliberately does not attempt this, because it receives only the database
handle and has no project path to anchor against.

Parsers that read a folder name (the `/preview` title resolver, the window title, `get_current_task`)
accept both the numeric and the legacy shape.

Numeric folders are unique per project, not globally: everything here is project-scoped (per-project
database, per-project worktrees directory). `display_id` never recycles, so a deleted task's number
is never handed to a new task that could then adopt its leftover directory.

### Base Branch Resolution

The configured base branch is checked in priority order:

1. Task's `base_branch` field (per-task override). An empty string is treated as not set (falls
   through to source 2), not as an explicit, guaranteed-unresolvable candidate.
2. Action config's `baseBranch` (per-transition override)
3. `kangentic.json` `defaultBaseBranch` (team-shared, overridable via `kangentic.local.json`)
4. `config.git.defaultBaseBranch` (per-user fallback, defaults to `main`)

That configured value is then **verified against the repo's actual refs** by
`resolveWorktreeBase` (`src/main/git/base-branch.ts`), called from
`WorktreeManager.ensureWorktree` before `git worktree add` ever runs:

- A **per-task `base_branch`** is a deliberate choice for that task and is tried alone. If it does
  not resolve (locally, on origin, or after a fetch), worktree creation throws a written error
  naming the branch rather than silently substituting a different one.
- With **no per-task override**, `[configured default, 'main', 'master']` (deduped) are tried in
  order. Most repos never configure `defaultBaseBranch`, so it is the hardcoded `'main'` - falling
  through to `master` covers the common repo whose only branch is `master`, which otherwise failed
  worktree creation with a raw `fatal: invalid reference: main`. If none of the candidates resolve
  even after a fetch, worktree creation throws, listing the branches the repo actually has.
- A candidate's fetch reporting success is not, by itself, trusted: a narrowed
  `remote.origin.fetch` refspec can exit 0 without ever writing `refs/remotes/origin/<branch>`.
  `resolveWorktreeBase` re-verifies the ref locally after the fetch before accepting it - the
  same re-verification `createWorktree`'s own `verifiedStartPoint` fallback relies on (see
  Creation Flow below).

When a fallback candidate wins (e.g. `master` for an unconfigured `main`), it is treated as the
new default too, so the branch name stays unprefixed instead of being namespaced under the
substitute (see Branch Naming above). An explicit per-task base is never substituted.

**Known gap:** only source 1 (the task's `base_branch`) counts as "explicit". Sources 2 through 4,
including a per-transition `create_worktree` action's `baseBranch`, are folded into
`defaultBaseBranch` by `executeCreateWorktree` (`transition-engine.ts`) and therefore DO fall
through to `main` / `master`. So an action configured with a base branch the repo does not have
silently creates the worktree from `main` instead of failing, which is the substitution the
per-task rule exists to prevent. Promoting it to an explicit base would also flip its branch
naming from unprefixed to namespaced, so the fix is not mechanical.

The chosen base branch is stored in the worktree's git config as `kangentic.baseBranch` so agents can read it without filesystem access.

### Concurrency

All git-mutating operations (create, remove, branch delete, prune, checkout, rename) are serialized per project via a priority-aware queue (`WorktreeManager.withGitLock` / instance `withLock`). Exactly one operation runs at a time per project (preserving the `.git` lock-contention guarantee), but waiting operations are ordered by `GitQueuePriority` - `USER` (0, the default) runs ahead of `BACKGROUND` (10, e.g. retry cleanups and background prune), with FIFO order within a priority band. This keeps a user-initiated spawn from head-of-line-blocking behind a slow or failing background cleanup. Different projects run independently. `removeWorktree`'s `{ timeoutMs, removalProfile }` options bound how hard a removal retries so one stuck delete cannot hold the queue: `removalProfile` is one of `thorough` (full backoff; the default, used where a failure surfaces an error to the user such as worktree create or project delete), `moderate` (a pinned path fails in a few seconds; used on the user-facing Done-move and cleanup paths so a held handle never holds the queue for minutes), or `fast` (a single attempt; used by the background startup retry pass). `clearQueue` (on project close) rejects any still-waiting jobs so their callers do not hang.

When a removal fails because a process still pins the worktree, `removeWorktree` reaps orphaned processes whose command line points inside that worktree path (a zombie Electron/node left by an agent's E2E run or `/preview`) and retries once. This reap is lazy by design: a clean Done-move never runs the OS process scan, so dragging a task to Done pays no added cost; the scan fires only on the rare delete a held handle actually blocks. It is skipped under `NODE_ENV=test`, where the E2E leak janitor owns process sweeps instead.

### When a worktree is NOT created

`ensureTaskWorktree` (`src/main/ipc/helpers/task-git.ts`) returns without creating anything in
most of these cases, leaving `task.worktree_path` null so the agent's `cwd` falls back to the
project path and the task runs unisolated in the main checkout. The two `WorktreeManager`-internal
guards at the top of the table are a partial exception - see the note in each row.

| Condition | Why |
|-----------|-----|
| A worktree already exists at `task.worktree_path` and is genuinely present on disk | Idempotent short-circuit inside `WorktreeManager.ensureWorktree` - `worktree_path` stays exactly what it already was, not null. Recreating a live worktree would be wasted work. |
| The project path itself is inside a worktree (`isInsideWorktree(this.projectPath)`) | Prevents nesting a worktree inside a worktree - a worktree checkout is never itself a valid parent for another `git worktree add`. |
| `worktreesEnabled` is `false` (per-task `use_worktree` can override either direction) | Worktrees are turned off for this project by default. `task.use_worktree` is checked first when set (`worktree-manager.ts`'s `shouldUseWorktree`): a task can force worktree mode on in a project where it's off, or opt out where it's on. |
| The project is not a git repository | Nothing to branch from. |
| The resolved agent's execution mode is `remote` | The agent runs against a server-side directory instead, so a local worktree would be unused. Resolution mirrors `resolveTargetAgent` exactly (task override, column profile, column override, project default, global fallback) - if the two disagree, a local agent spawns into the main checkout. |
| The repository has **no commits** (`hasCommits` in `src/main/git/git-checks.ts`) | A freshly `git init`-ed repo has an unborn HEAD: the branch exists in name only, so `git worktree add` fails with `fatal: invalid reference: <branch>`. This is the state Kangentic produces itself when it initialises a repo for a folder that had none (see `ensureGitRepo`), and the user's next action is usually a task move. Worktrees start working on their own once there is a first commit. |

This guard lives inside `WorktreeManager.ensureWorktree` (via `resolveWorktreeBase`), not in
`ensureTaskWorktree` itself, so the `create_worktree` transition action (which also calls
`ensureWorktree`) gets the identical no-commits fallback. `ensureTaskBranchCheckout` keeps its own
separate no-commits guard, since it does not go through `WorktreeManager.ensureWorktree`.

#### Sharing one checkout is guarded, not prevented

Every task that does not get a worktree runs in the same directory, the project path. Kangentic does
not stop two agents from working there at once, but it does refuse to **change the branch** under a
live one: `ensureTaskBranchCheckout` throws `BranchCheckoutBlockedError` when another task has a
running or queued session whose `cwd` is that directory.

The check lives in that function rather than in a caller, deliberately. It previously sat in
`task-move.ts` keyed on `task.base_branch`, while the decision to check out is keyed on
`usesCustomBranch || base_branch`, so a task with a custom branch and no base branch checked out with
the guard never running. Co-locating the guard with the checkout makes that class of drift
impossible, and running it inside the per-project git queue (which already wraps the checkout) makes
the probe atomic against every other checkout on the project without adding a third lock.

Where the error goes depends on the entry point, exactly as worktree failures do. A task **move**
surfaces it as a toast. Create, promote, unarchive and MCP auto-spawn deliberately keep the task and
skip only the spawn, so they emit `task:spawnBlocked` and the renderer toasts it, naming the blocking
task. Without that push, "created and silently not spawned" looked identical to success.

`kangentic_create_task` (`src/main/agent/commands/task-commands.ts`) catches the collision one step
earlier still: it refuses a `branchName` that some worktree already holds BEFORE the task row is
written, via `WorktreeManager.findWorktreeHoldingBranch` (`parseWorktreeBranches` parses
`git worktree list --porcelain` into a branch to path map). That matters because the tool response is
sent before auto-spawn runs, so a collision caught later can only reach a desktop toast the calling
agent never sees. The preflight fails open when git cannot be probed, and is skipped for backlog
items. See [MCP Server](mcp-server.md#kangentic_create_task) for the full refusal contract.

### When worktree creation fails with a written error

Two distinct failure modes raise an actionable `Error` rather than falling back silently. Where
that error goes depends on the entry point:

- **Task move** (`handleTaskMove` in `src/main/ipc/handlers/task-move.ts`) and **`SESSION_RESUME`**
  wrap and re-throw it, so the user sees a toast reading `Worktree setup failed: <message>`.
- **Task create, unarchive, backlog promote, and MCP auto-spawn** catch it and skip worktree
  creation, keeping the task. They also emit `task:spawnBlocked`, so the failure reaches the user
  as a toast rather than only a console line (`notifySpawnBlocked` in `ipc/helpers/task-git.ts`,
  which covers the worktree step as well as the checkout step).
- **The `create_worktree` transition action** catches it and logs to console only, so it is the one
  path with no toast today.
- **`TASK_SWITCH_BRANCH`** (`src/main/ipc/handlers/task-branch.ts`) calls `ensureTaskWorktree`
  uncaught, so the error propagates as a rejected `ipcMain.handle` promise - Electron forwards it
  to the renderer's `invoke()` call, not a toast from this list, but however the branch-switch UI
  surfaces a rejected mutation.

A related but distinct signal: a spawn that REUSES a pre-existing worktree (created eagerly from
the branch picker, or by an earlier move of a long-lived task) never re-fetches or moves that
tree. `ensureTaskWorktree` instead runs a fire-and-forget drift probe (throttled base fetch plus
one `rev-list` against `origin/<base>`) and, when the tree's base is behind, decorates the card's
spawn-progress labels with `(base N behind)`. The remedy is explicit, never automatic: the
task-detail kebab's "Update from base" (`TASK_UPDATE_FROM_BASE`, same file) fetches the effective
base and fast-forwards the worktree, refusing cleanly when the branch carries its own commits or
the tree is dirty. A base fetch that genuinely fails (network, credentials) during any spawn path
decorates the labels with `(base fetch failed)` and pushes one cooldown-guarded `task:spawnWarning`
toast per project, so "started from a stale base" is never silent.

The two failure modes:

- **A stale directory** at the computed worktree path could not be removed and is not an empty,
  reusable husk (see Creation Flow step 4) - `staleWorktreeError` in `worktree-manager.ts`.
- **The base branch does not resolve**, even after the fallback chain and a fetch retry described
  under Base Branch Resolution above - `describeUnresolvableBase` in `src/main/git/base-branch.ts`.
  Distinguishes an explicit per-task base (names the branch, suggests picking a different one) from
  an exhausted default chain (lists every candidate tried and points at Settings > Git). The listed
  branches are capped at 10 (`MAX_LISTED_BRANCHES`) so a repo with hundreds of branches doesn't
  produce an unreadable toast.

Both name what failed and what to do about it, rather than surfacing git's raw error text.

### Creation Flow

1. Create `.kangentic/worktrees/` directory
2. `git fetch origin <baseBranch>` (best-effort). The start point is `origin/<baseBranch>` only
   when the fetch actually lands that ref; otherwise it falls back to the ref
   `resolveWorktreeBase` already verified (`verifiedStartPoint`), which may itself be
   `origin/<baseBranch>` for a base that was only ever fetched and never checked out locally.
   A fetch exiting 0 is not proof the ref landed (a narrowed `remote.origin.fetch` refspec, or a
   fetch that only populated `FETCH_HEAD`), so both call sites re-verify before trusting it.
3. Check if branch already exists (stale branch from failed cleanup, or custom branch)
4. Clean up the stale worktree directory if it exists on disk. If removal fails because a process holds the directory as its current directory (Windows pinned-CWD) and the leftover is an empty husk, reuse it in place; if it is non-empty or cannot be inspected, fail with an actionable error naming the likely blocker (an open terminal or editor, the `/preview` dev server, or antivirus). (`git worktree prune` itself is NOT part of creation - it only runs on the removal path, `pruneWorktrees()`, and the debounced background prune.)
5. If branch exists: `git worktree add [--force] <worktreePath> <branchName>`
6. If new branch: `git worktree add [--force] -b <branchName> <worktreePath> <startPoint>` (`--force` is added only when reusing an empty husk from step 4, to clear any stale `.git/worktrees/` registration whose directory still exists)
7. On Windows: enable `core.longpaths` (see below)
8. `git config kangentic.baseBranch <baseBranch>` (in worktree)
9. Set up sparse-checkout (see below)
10. Copy optional files from repo root (configured via `config.git.copyFiles`)
11. Create `node_modules` junction/symlink to root repo's `node_modules` (skipped when `config.git.linkNodeModules` is `false`, so a worktree can own its own dependencies)
12. Run the Post-Worktree Script if `config.git.initScript` is set (see below)
13. Pre-populate `~/.claude.json` trust entry for the worktree path

### Windows Long Paths

On Windows, projects with deeply nested file paths (e.g. .NET migrations, `node_modules` trees) can exceed the default 260-character path limit when checked out into a worktree under `.kangentic/worktrees/<n>/`. This causes `git worktree add` and subsequent git operations to fail with "Filename too long" errors.

Kangentic enables `core.longpaths` in two places:

1. **`git worktree add`** - the `-c core.longpaths=true` flag is passed as a per-command config override so the checkout itself succeeds. This does not modify any persistent git config.
2. **Worktree local config** - after creation, `git config core.longpaths true` is set in the worktree's local config so all subsequent operations (sparse-checkout, agent commits, merges) also use extended-length paths.

This setting uses the `\\?\` extended-length path prefix on Windows. macOS and Linux have 1024-4096 byte `PATH_MAX` limits and are unaffected - the setting is only applied on `process.platform === 'win32'`.

`core.longpaths` covers git itself. Node and the JVM handle long paths on their own (measurement:
1,958 files past MAX_PATH in a real worktree, with `npm install` and Gradle both succeeding), so the
toolchains that run inside a worktree are largely unaffected too. See
[cross-platform.md](cross-platform.md#windows-max_path-is-mostly-not-the-wall-people-expect) for the
measurements and for the one limit that does bind, which is CMake's own object-path policy rather
than the operating system.

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
  → Create worktree (unless skipped - see "When a worktree is NOT created")
  → Spawn agent: claude --session-id <uuid> "prompt"
  → Status: running
  → Bridge scripts write to session directory
  → File watchers emit usage/activity/events to UI

Task moved between active columns (e.g., Planning → Code Review)
  → Session stays alive; an auto_command on the target is injected as keystrokes
    (timing per the column's auto_command_mode: immediate or deferred)
  → Only a permission-mode change, or a model/effort change the agent cannot
    swap live, forces suspend + respawn - and then the auto_command rides along
    as the resume prompt instead of being typed

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
  → Agent adapters notified so they can drop per-directory state (see below)
  → DB references cleared (worktree_path, branch_name set to null)
  → Next activation creates a fresh worktree and branch

Task deleted
  → Full cleanup: session killed, worktree removed, branch deleted (if config.git.autoCleanup)
  → Agent adapters notified so they can drop per-directory state (see below)

App closed
  → All sessions marked suspended in DB (synchronous)
  → PTYs force-killed immediately (no graceful shutdown window)
  → Session files persist

App reopened
  → Recover: orphaned/suspended sessions resumed or respawned
  → Reconcile: tasks in auto_spawn columns without sessions get fresh agents
```

## Cleanup

### Adapter notification on removal

Some agent CLIs record per-directory state in a GLOBAL config file, keyed by absolute path. That state outlives the worktree: Kangentic creates one worktree per task, so an adapter keyed this way accumulates a dead entry per task with nothing to clean it up. Codex is the case that forced this (its directory trust in `~/.codex/config.toml` reached 473 dead entries on one machine); Gemini's `trustedFolders.json` and Grok's `~/.grok/trusted_folders.toml` have the same shape (Grok accumulates entries only for worktrees under an undecided project root, since its trust cascades from a decided ancestor).

`WorktreeManager.removeWorktree` is therefore the single notification point: on a successful removal it calls the listener registered at startup (`setWorktreeRemovedListener` in `src/main/index.ts`), which fans out to every adapter's optional `onWorktreeRemoved` (see [Agent Integration](agent-integration.md)). The listener is registered rather than imported so this git module never reaches into the agent registry.

Notifying from the chokepoint is deliberate. Worktree removal is hand-copied across seven call sites (Done move, task delete, archive, MCP delete, project close, startup retry, branch-switch cleanup); an earlier attempt that notified at each site leaked from the ones it missed. The one path that deliberately does NOT notify is `createWorktree`'s husk-clear, which calls the internal removal directly because it is about to reuse the same path rather than vacate it.

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
- `createWorktree` does NOT inline `git worktree prune` (moved to the removal path and background prune - see Creation Flow above)
- `createWorktree` cleans up stale directory before `git worktree add`
- `pruneWorktrees` calls `git worktree prune`
- The move-failure stale cleanup (`handleTaskMove`, `task-move.ts`) force-deletes ONLY an
  auto-generated branch, gated on `isAutoGeneratedBranch`. A custom, agent-supplied branch is left
  in place even when its worktree could not be created, because `removeBranch` is `git branch -D`
  with its errors swallowed and would otherwise destroy unpushed commits on any worktree failure.
  This gate is local to that one recovery path; the three `autoCleanup`-gated call sites above are
  unaffected.

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

### Base Branch Resolution (`worktree-base-branch.test.ts`)

Runs the real `git` binary against temp directories (mirroring `ensure-git-repo.test.ts`) rather
than mocking git, so the behavior pinned is what `git worktree add` actually does with each
resolved ref.

**`WorktreeManager.ensureWorktree`, end to end:**
- Takes the byte-identical path when the base resolves normally (the additive-only invariant)
- Falls back to `master` when the repo only has `master` and the default is the unconfigured `main`
- Namespaces the branch under an explicit per-task base that differs from the configured default
- Throws a written error naming the branch when an explicit per-task base does not exist
- Reproduces the identical worktree path on a Done round-trip after a default-chain substitution
- Throws and lists the repo's real branches when the default chain is fully exhausted
- Resolves a base that exists only on origin and was never fetched (fetch retry)
- Falls back to a verified `origin/<base>` start point when worktree creation's own fetch fails (the `verifiedStartPoint` seam)
- Returns null (no-commits fallback) for an unborn HEAD, now enforced inside `ensureWorktree`
- Regression pins for states that are already no-ops: detached HEAD, a bare repo, a broken `.git` file pointer

**`resolveWorktreeBase` candidate order:**
- Tries only the per-task base branch when set, never substituting main/master
- Treats an empty-string task base branch as "not set" (falls through to the default chain, not an explicit unresolvable candidate)
- Deduplicates the default chain when the configured default is already `master`
- Marks `substitutedFor` null when the first candidate resolves (no fallback engaged)
- Substitutes a later default-chain candidate resolved only via the fetch pass (`substitutedFor` at an index greater than 0)

**`resolveWorktreeBase` - listBranches truncation:**
- Caps `availableBranches` at `MAX_LISTED_BRANCHES` (10) even when the repo has more

**`resolveWorktreeBase` and `WorktreeManager.createWorktree` - narrowed refspec (fetch succeeds, ref never lands):**
- `resolveWorktreeBase` does not trust a fetch that succeeds without landing the remote-tracking ref
- `createWorktree` falls back to `verifiedStartPoint` instead of trusting a fetch that reports success without landing the ref

**`describeUnresolvableBase` message formatting:**
- Names the branch and offers the fix for an explicit per-task base
- Lists every attempted default-chain candidate and points at the settings fix
- Formats a two-item attempted list without an Oxford comma before "or"

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
