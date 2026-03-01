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

- **Runtime:** Electron 40 + Node 20
- **Frontend:** React 19, Zustand, Tailwind CSS 4, Lucide React icons
- **Backend:** better-sqlite3, node-pty, simple-git
- **Build:** Electron Forge + Vite (renderer), esbuild (main/preload)
- **Testing:** Playwright with Electron support
- **Package:** Squirrel (Windows), DMG (macOS), deb/rpm (Linux)

## Project Structure

```
src/
  main/           # Electron main process
    agent/        # Claude CLI detection & command building
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

- `npm run dev` — Start in development mode (Forge + Vite HMR)
- `npm run build` — Production build to `.vite/build/`
- `npm test` — Run all Playwright E2E tests
- `npm run test:screenshots` — Run screenshot capture tests only
- `npm start` — Start via Electron Forge
- `npm run package` — Package for distribution

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

### Per-Project Directory
All runtime data lives under `<project>/.kangentic/` (auto-added to `.gitignore` on project open):
- `config.json` — project config overrides
- `sessions/<claudeSessionId>/` — per-session files (`settings.json`, `status.json`, `activity.json`)
- `worktrees/<slug>/` — git worktree checkouts

### Database
- Global DB (`<configDir>/index.db`) for projects list — configDir is `%APPDATA%/kangentic/` (Win), `~/Library/Application Support/kangentic/` (Mac), `~/.config/kangentic/` (Linux)
- Per-project DB (`<configDir>/projects/<projectId>.db`) for tasks, swimlanes, actions, sessions
- Migrations run automatically on open

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
