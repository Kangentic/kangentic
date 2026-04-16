# Kangentic

Cross-platform desktop Kanban for Claude Code agents.

## CRITICAL: Single-Command Bash Calls Only

**THIS IS THE #1 RULE. Every Bash tool call MUST contain exactly ONE command.**

Claude Code does not support chained, piped, or redirected-stderr commands. Violations **will** produce errors or silent data loss.

**Forbidden operators:** `&&`, `||`, `|`, `;`, `2>/dev/null`, `2>&1`

**Forbidden patterns — NEVER do this:**
```
cd /some/path && git status          # WRONG — chained commands
git diff | head -20                  # WRONG — pipe
npm run build && npm test            # WRONG — chained commands
cat file.json | grep "key"          # WRONG — pipe
find . -name "*.ts" -type f         # WRONG — use Glob tool instead
find /path -name "types.ts" | head  # WRONG — pipe + find
command1 ; command2                  # WRONG — semicolon
some-command 2>/dev/null            # WRONG — stderr redirection
```

**ALWAYS use dedicated tools instead of shell commands:**
- **`Read`** tool (with `offset`/`limit`) — replaces `cat`, `head`, `tail`, `less`
- **`Grep`** tool — replaces `grep`, `rg`, and piping into `grep`
- **`Glob`** tool — replaces `find`, `ls` for file discovery
- **`Write`** tool — replaces `echo` redirection, `cat <<EOF`
- **Bash `timeout` parameter** — replaces `sleep`
- Run commands separately in individual Bash tool calls — replaces `&&`, `;`, `||`

**Correct alternatives:**
```
git -C /some/path status             # CORRECT — git -C for git commands in other dirs
git -C /some/path log --oneline -5   # CORRECT — never cd && git
npm run typecheck                    # CORRECT — run from cwd, or use --prefix
```

**Git specifically: ALWAYS use `git -C <path>` instead of `cd <path> && git ...`.** The `cd && git` pattern triggers a Claude Code security prompt that cannot be bypassed. `git -C` is the only correct way to run git in another directory.

**This rule applies everywhere: main sessions, subagents, worktree agents, commands, and skills. No exceptions.**

## Tech Stack

- **Runtime:** Electron 41 + Node 24
- **Frontend:** React 19, Zustand, Tailwind CSS 4, Lucide React icons
- **Backend:** better-sqlite3, node-pty, simple-git
- **Build:** Vite (renderer), esbuild (main/preload), electron-builder (packaging)
- **Testing:** Playwright with Electron support
- **Package:** NSIS (Windows), DMG (macOS), deb/rpm (Linux)

## Project Structure

```
build/            # Platform-specific signing & entitlement files
config/           # Vite configs (renderer, used by scripts/dev.js)
packages/
  launcher/       # Public npm package ("kangentic") -- thin npx installer
    bin/          # kangentic.js launcher script
src/
  main/           # Electron main process
    agent/        # Agent adapter system
      shared/     # Shared utilities (interpolateTemplate, resolveBridgeScript, execVersion)
      adapters/   # Per-agent subfolders (claude/, codex/, gemini/, aider/)
      commands/   # MCP command handlers
    boards/       # Board integration adapter system (mirrors agent/)
      shared/     # BoardAdapter interface + auth, mapping, download, rate-limit helpers
      adapters/   # Per-provider subfolders (github-issues/, azure-devops/, jira/, etc.)
      board-registry.ts  # Central BoardRegistry + boardRegistry singleton
    db/           # SQLite database, migrations, repositories
    engine/       # Transition engine (action execution)
    git/          # Worktree manager
    ipc/          # IPC handler registration
    pty/          # PTY session manager, shell resolver
  preload/        # Context bridge (preload.ts)
  renderer/       # React UI
    components/   # Board, dialogs, layout, terminal, sidebar
    hooks/        # useTerminal
    stores/       # Zustand stores (board, config, project, session)
  shared/         # Types and IPC channel constants
tests/
  e2e/            # Playwright E2E tests
scripts/          # Build and dev scripts
```

## Commands

- `npm start` — Start in development mode (Vite HMR + esbuild watch)
- `npm run build` — Production build to `.vite/build/`
- `npm test` — Run all Playwright E2E tests

- `npm run package` — Package for distribution (unpacked directory)
- `npm run make` — Build installer (NSIS on Windows, DMG on macOS, deb/rpm on Linux)

**Worktrees need `npm install`:** Git worktrees do not share `node_modules/` with the main repo. Always run `npm install` in a worktree before running any npm scripts (`npm run typecheck`, `npm run build`, `npx playwright test`, etc.). Without it, binaries like `tsc` won't be found.

## Architecture

### Data Flow
1. User drags a task between columns (swimlanes)
2. `TASK_MOVE` IPC handler fires in main process
3. Transition engine checks for actions attached to that lane transition
4. `spawn_agent` action builds a Claude CLI command and spawns a PTY session
5. Terminal output streams to renderer via IPC

### Key Patterns
- **IPC channels** defined in `src/shared/ipc-channels.ts` — single source of truth
- **Stores** use Zustand with IPC bridge: renderer store calls `window.electronAPI.*`, main process handles via `ipcMain.handle`
- **Icons** use Lucide React — no inline SVGs
- **PTY sessions** handle cross-platform shells (PowerShell needs `& ` prefix, WSL splits into exe + args, fish/nushell skip `--login`)
- **Claude CLI** is invoked with `cwd` set to the project directory (or worktree path) so that `.claude/`, `CLAUDE.md`, and commands are loaded into context
- **HMR store re-sync** - The `vite:afterUpdate` handler in `App.tsx` re-fetches every IPC-backed Zustand store after HMR replaces modules. If you add a new store with a `load*` or `sync*` method, add the call there. A unit test (`hmr-resync.test.ts`) enforces this.
- **HMR state preservation** - Module-scoped state that must survive HMR uses the `import.meta.hot.data` / `import.meta.hot.dispose()` pattern. Currently preserved: `syncController` (AbortController), `moveGeneration` counter, `transientSessions` map + pointers, `savedScrollPositions` (terminal viewport offsets), and `commandBarOpen` (keeps overlay mounted). When adding new module-level state in renderer code, consider whether it needs this treatment.
- **Command Terminal** - Ctrl+Shift+P opens an ephemeral "transient" session with no DB persistence. The `transientSessions` map in `session-store.ts` tracks per-project transient sessions (keyed by project ID). Unlike task-bound sessions, transient sessions are NOT restored by `syncSessions()` - they rely entirely on the in-memory map. The map is preserved across HMR via `import.meta.hot.data`. Closing the overlay keeps the PTY alive in the background; reopening reattaches to the existing session. Project switching stashes/restores transient session pointers.
- **Settings tab separator** — In `AppSettingsPanel`, tabs above the `separator: true` marker are per-project settings (saved to `.kangentic/config.json`). Tabs below the separator (Behavior, Notifications, Privacy) are shared settings that apply across all projects (saved to global config). When a project is open, all 7 tabs are shown. When no project is selected, only the 3 shared tabs appear. There is no Global/Project scope toggle. When adding new settings, decide if they are per-project or shared and place the tab accordingly.

### Shutdown (CRITICAL)

The `before-quit` handler in `src/main/index.ts` **must be fully synchronous**. Never use `event.preventDefault()` + async shutdown + `process.exit()`. That pattern cancels Electron's normal quit flow, which means Electron never reaches its own cleanup -- all Chromium child processes (GPU, utility, crashpad) survive as zombies. If the async chain stalls for any reason (network call, PTY wait, uncaught error), the main process also survives, and on Windows installed builds the app can auto-reopen.

The correct pattern:
1. Do all cleanup synchronously in `before-quit` (mark DB records, kill PTYs, close DBs)
2. **Do not** call `event.preventDefault()` -- let Electron's normal quit proceed
3. Fire-and-forget analytics (never await network calls during shutdown)
4. Set a hard failsafe timer (`taskkill /T /F` on Windows) as a backstop

This means we lose the 2-second graceful Claude CLI exit window (`suspendAll`). Sessions are still resumable because the DB records are marked `suspended` before PTYs are killed, and `--resume <id>` works from the saved session ID.

### Per-Project Directory
All runtime data lives under `<project>/.kangentic/` (auto-added to `.gitignore` on project open):
- `config.json` — project config overrides
- `sessions/<claudeSessionId>/` — per-session files (`settings.json`, `status.json`, `activity.json`)
- `worktrees/<slug>/` — git worktree checkouts

### Database
- Global DB (`<configDir>/index.db`) for projects list — configDir is `%APPDATA%/kangentic/` (Win), `~/Library/Application Support/kangentic/` (Mac), `~/.config/kangentic/` (Linux)
- Per-project DB (`<configDir>/projects/<projectId>.db`) for tasks, swimlanes, actions, sessions
- Migrations run automatically on open
- **Timestamps are stored as UTC ISO 8601 strings** (`TEXT` columns like `created_at`, `updated_at`, `archived_at`, `started_at`, `exited_at`). Always write via `new Date().toISOString()` - never use SQLite's `DEFAULT CURRENT_TIMESTAMP` (emits `YYYY-MM-DD HH:MM:SS` with no `Z` suffix; JS parses that as local time, not UTC) or naive strings like `new Date().toString()`. Display formatting is the renderer's job (`src/renderer/lib/datetime.ts`) - the DB only holds UTC instants.

### Testing

Three test tiers — prefer **unit tests** for pure logic, **UI tests** for anything that doesn't need the real Electron backend.

#### Unit tests (`tests/unit/`) — fast, no browser
- Run with `npm run test:unit` (vitest)
- Covers: event-bridge script, hook-manager inject/strip logic, session suspend state
- No build step, no browser — runs directly against source

#### UI tests (`tests/ui/`) — headless, fast, no windows
- Run with `npx playwright test --project=ui`
- Uses headless Chromium against the Vite dev server (auto-started by Playwright)
- `mock-electron-api.js` injects a full in-memory mock of `window.electronAPI` via `addInitScript()`
- Covers: app launch, project CRUD, task CRUD, drag-and-drop, column management
- No build step needed — runs against Vite HMR directly
- ~13 seconds for 72 tests

#### E2E tests (`tests/e2e/`) — real Electron, opens windows
- Run with `npx playwright test --project=electron`
- Uses Playwright's `_electron.launch()` — always opens a real window on Windows (no headless mode)
- Required for: PTY sessions, terminal rendering, session lifecycle, config persistence, shell detection
- Build required first: `npm run build`
- Shell-parameterized tests run for all detected terminals (WSL, PowerShell, bash, cmd, etc.)

#### Run both
- `npx playwright test` runs UI + Electron projects
- `npx playwright test --project=ui` for quick headless-only validation

#### Adding new tests
- Pure logic (parsers, filters, state machines) → add to `tests/unit/`
- Pure UI interactions (clicks, forms, dialogs, drag-and-drop) → add to `tests/ui/`
- Needs real IPC, PTY, or session spawning → add to `tests/e2e/`
- The mock in `tests/ui/mock-electron-api.js` supports full CRUD — extend it if new API methods are added

#### When to test (column discipline)
- **Executing / Code Review:** Run `npm run typecheck` freely. Quick single-file validation is OK (`npx playwright test tests/ui/specific.spec.ts`) but do NOT run `/test` or full-tier runs. Save full testing for the Tests column.
- **Tests column:** Has `auto_command: /test` configured. When a task enters this column, Smart Run fires automatically - detects changed files and runs only relevant tiers. If tests fail, fix them in place - do not move the task backward to re-enter Tests.
- **Pre-commit:** `/merge-back` runs typecheck automatically. The Tests column should have already validated the full suite.

### Performance

- **Terminal ownership handoff:** Each PTY session spawns exactly one Claude Code CLI process. The bottom panel and task detail dialog share that single process but never render simultaneously — when the dialog opens, it claims the session via `dialogSessionId` and the panel unmounts its xterm instance. On close, the panel recreates its xterm from the PTY scrollback buffer. This prevents duplicate xterm instances from sending conflicting resize calls (different container widths garble TUI output) and ensures one CLI process per task regardless of which view is active.
- **Activity log replaces aggregate terminal:** The "Activity" tab shows structured events (tool calls, idle state) from Claude Code hooks instead of raw terminal output. Uses a plain DOM list — no xterm/WebGL overhead. Events flow: hook → event-bridge.js → JSONL file → fs.watch → IPC → Zustand store → ActivityLog component.
- **WebGL renderer:** xterm instances attempt WebGL acceleration first, with automatic fallback to canvas on context loss or unavailability.
- **Resize debouncing:** PTY resize calls are debounced (200ms) and suppressed entirely during panel drag operations to prevent scrollback eviction from rapid row-count changes.

## Conventions

- TypeScript strict mode
- Prefer editing existing files over creating new ones
- Use `data-testid` and `data-swimlane-name` attributes for test selectors
- All dialogs use global `useEffect` Escape key listener
- When adding or updating tests, use the `/test` command to ensure correct tier classification
- **No `any` types** — never use `any` in new code. Use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints. The `/code-review` command will flag `any` usage. Existing `any` casts should be replaced when touching the file.
- **Git commit/push workflow:** When asked to "commit and push", "commit changes", or similar — use `/merge-back`. It handles commit, typecheck, rebase, and push safely. Works from both worktrees and the main repo. Use `/pull-request` instead when a PR audit trail is desired — it shares the same commit/rebase flow but creates a PR and admin-merges it instead of pushing directly.
- **No shorthand variable names** — use full, descriptive names. `currentIndex` not `curIdx`, `previousValue` not `prev`, `session` not `sess`. Applies to all code: variables, refs, parameters, callback args, etc.
- **No em-dashes or double-dashes** — never use em-dashes (U+2014), `&mdash;`, or `--` as sentence or list separators. Use a single dash `-` for inline separators (e.g. `**Bold** - description`) or restructure with periods. Em-dashes render as garbled characters on Windows console code pages; double-dashes look awkward in UI text. Applies to source code, comments, tests, docs, scripts, and JSX.
- **Confirmation dialogs:** Use `ConfirmDialog` for all yes/no prompts. Set `showDontAskAgain` when the confirmation should be suppressible. Never create one-off modal components for simple confirmations.
- **Per-task lifecycle locks:** Any IPC handler or helper that crosses an `await` boundary AND mutates per-task state (`task.session_id`, PTY sessions via `sessionManager.spawn`/`kill`/`suspend`, worktrees via `ensureTaskWorktree`/`cleanupTaskResources`, or calls `spawnAgent`/`autoSpawnForTask`) MUST wrap its async region in `withTaskLock(taskId, async () => { ... })` from `src/main/ipc/task-lifecycle-lock.ts`. This serializes concurrent operations on the same task while leaving different tasks fully parallel. Two rules: (1) cancellation (`AbortController.abort()`) goes OUTSIDE the lock so the in-flight holder can observe its abort and release; (2) the lock is NOT reentrant - never call another `withTaskLock` for the same `taskId` from inside a locked block. Pure read-only handlers and synchronous-only paths do not need the lock - if you never `await`, you cannot race. See the JSDoc on `withTaskLock` and existing usage in `handlers/sessions.ts` for the canonical pattern. Contract is locked in by `tests/unit/task-lifecycle-lock.test.ts`.
- **Documentation maintenance:** `/sync-docs` reviews and updates `docs/` to match source code. Runs automatically during `/merge-back`. See `.claude/skills/sync-docs/SKILL.md` for the source-to-doc mapping.
