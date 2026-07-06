# Kangentic

Cross-platform desktop Kanban for Claude Code agents.

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
  launcher/       # Public npm package ("kangentic") - thin npx installer
    bin/          # kangentic.js launcher script
src/
  main/           # Electron main process
    agent/        # Agent adapter system
      shared/     # Shared utilities (interpolateTemplate, resolveBridgeScript, execVersion)
      adapters/   # Per-agent subfolders (claude/, codex/, gemini/, qwen-code/, opencode/, aider/)
      commands/   # MCP command handlers
    boards/       # Board integration adapter system (mirrors agent/)
      shared/     # BoardAdapter interface + auth, mapping, download, rate-limit helpers
      adapters/   # Per-provider subfolders (github-issues/, azure-devops/, jira/, etc.)
      board-registry.ts  # Central BoardRegistry + boardRegistry singleton
    db/           # SQLite database, migrations, repositories
    transition-engine/  # Transition engine (action execution)
    git/          # Worktree manager
    ipc/          # IPC handler registration
    pr/           # PR subsystem (mirrors agent/boards): shared/ contract + errors,
                  #   adapters/github/ connector, pr-registry, linking, refresh, scheduler
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

- `npm start` - Start in development mode (Vite HMR + esbuild watch)
- `npm run build` - Production build to `.vite/build/`
- `npm test` - Run all Playwright E2E tests

- `npm run package` - Package for distribution (unpacked directory)
- `npm run make` - Build installer (NSIS on Windows, DMG on macOS, deb/rpm on Linux)

**Worktrees need `npm install`:** Git worktrees do not share `node_modules/` with the main
repo. Always run `npm install` in a worktree before running any npm scripts (`npm run
typecheck`, `npm run build`, `npx playwright test`, etc.). Without it, binaries like `tsc`
won't be found.

## Architecture

### Data Flow
1. User drags a task between columns (swimlanes)
2. `TASK_MOVE` IPC handler fires in main process
3. Transition engine checks for actions attached to that lane transition
4. `spawn_agent` action builds a Claude CLI command and spawns a PTY session
5. Terminal output streams to renderer via IPC

### Key Patterns
- **IPC channels** defined in `src/shared/ipc-channels.ts` - single source of truth. Wiring an
  endpoint through all 7 layers: see `.claude/rules/ipc-7-layer-parity.md`.
- **Stores** use Zustand with IPC bridge: renderer store calls `window.electronAPI.*`, main
  process handles via `ipcMain.handle`
- **PTY sessions** handle cross-platform shells (PowerShell needs `& ` prefix, WSL splits into
  exe + args, fish/nushell skip `--login`)
- **Claude CLI** is invoked with `cwd` set to the project directory (or worktree path) so that
  `.claude/`, `CLAUDE.md`, and commands are loaded into context
- **HMR / dev-mode parity** - The team dogfoods Kangentic from `npm start` daily, so dev mode
  must be visually and behaviourally indistinguishable from a production boot. Patterns A
  through D and their enforcement: `.claude/rules/hmr-patterns.md`.
- **Command Terminal** - Ctrl+Shift+P opens an ephemeral "transient" session with no DB
  persistence. It is hosted in a SECOND window-manager layer (`CommandTerminalLayer` +
  `CommandTerminalWindow` in `components/command-bar/`), separate from the board task-detail
  layer: the same engine (`src/renderer/window-manager/`) instantiated twice via
  `createWindowManagerStore` and distributed through `WindowManagerProvider` context. So the
  Command Terminal is a movable / resizable / maximizable / snappable WINDOW (top-layered over a
  slight backdrop blur), and its arrangement persists GLOBALLY (one blob, `AppConfig.commandTerminalWorkspace`,
  shared across all projects). Multiple terminals can run at once (cap `MAX_COMMAND_TERMINALS`),
  tiled among themselves via the engine's N-ary tiling: each window owns a durable SLOT id
  (`slot-1`, `slot-2`, ...) as its `anchor`. The `transientSessions` map in `transient-session-slice.ts`
  tracks them keyed by `transientKey(projectId, slot)` (`${projectId}::${slot}`); the value carries
  `projectId` + `slot` so consumers can filter by project. There is no singleton pointer. The map is
  preserved across HMR via `import.meta.hot.data`; on a hard reload `syncSessions()` best-effort
  re-pairs surviving transient PTYs to slots. Hiding the layer (Ctrl+Shift+P / Ctrl+Shift+W /
  backdrop click) keeps every PTY alive in the background; reopening reattaches each slot. There is
  NO per-window X/hide button (removed to avoid the task-detail "close this window" confusion). A
  window's Stop control destroys THAT window's session and closes the window; Stopping the last
  window hides the layer. The header is responsive (priority-plus via `useHeaderPillOverflow`): only
  Stop + title + the window controls (kebab, layout menu, pop-out, maximize) are protected; the
  pills AND the branch picker fold into the kebab as the window narrows, down to the min width. Each
  window has full task-detail parity: tile-layout menu, pop-out (`untileWindow`: the clicked pane
  floats at its current rect; the survivors STAY DOCKED and keep their absolute widths by shrinking
  the footprint - no rescale - except a 2-pane group fully dissolves so both float), and a
  min-pane-width floor on tiling (seam-drag clamp in `TileSplitter` + a footprint grow on spawn).
  Both behaviors live in the shared engine, so task-detail windows get them too. The title-bar terminal button is context-aware: it opens the layer when
  closed, and spawns another terminal (up to the cap) when open. The title-bar glyph is a custom
  SVG (`CommandTerminalIcon` in `TitleBar.tsx`): its stroke color is the aggregate activity of the
  project's terminals (active-green working / attention-amber needs-you / muted rest, via the
  central `--kng-active` / `--kng-attention` tokens) and the working border
  MARCHES (`@keyframes march-border` + a `pathLength`-normalized stroke-dash). The `+` add
  affordance lives in the CENTER of the glyph (replacing the shell prompt) when the layer is open
  and below the cap, not a corner badge, so it never clashes with the activity color. This replaces
  the old background dot. GEOMETRY is global but POPULATION is per-project: the window layout blob
  is shared, yet WHICH slots get windows is reconciled to the current project's live transient
  sessions on open (`reconcileCommandTerminalWindows` +
  `planCommandWindowReconciliation` in `command-window-reconcile.ts`). Project switching keeps every
  slot's PTY alive in the map (no stash/restore); the bar closes on switch, and on reopen the
  reconcile closes carried-over windows whose slot has no live session for the new project (keeping
  one default terminal) and opens a window for every live session that lacks one (so switching BACK
  reattaches all of a project's terminals instead of leaking a window-less PTY). The reconcile runs
  BEFORE the layer mounts (`useCommandBar.open()`, plus the empty-store branch of
  `useEnsureCommandWindow` for the app-restart blob-restore path), because a carried-over window
  committed into the store would otherwise spawn a fresh PTY under the wrong project before a
  bridge-effect reconcile could close it.
- **Settings tab separator** - In `AppSettingsPanel`, tabs above the `separator: true` marker
  are per-project settings (saved to `.kangentic/config.json`). Tabs below the separator
  (Behavior, Notifications, Privacy) are shared settings that apply across all projects (saved
  to global config). When a project is open, all 7 tabs are shown. When no project is selected,
  only the 3 shared tabs appear. There is no Global/Project scope toggle. When adding new
  settings, decide if they are per-project or shared and place the tab accordingly.

### Per-Project Directory
All runtime data lives under `<project>/.kangentic/` (auto-added to `.gitignore` on project
open):
- `config.json` - project config overrides
- `sessions/<claudeSessionId>/` - per-session files (`settings.json`, `status.json`, `activity.json`)
- `worktrees/<slug>/` - git worktree checkouts

### Database
- Global DB (`<configDir>/index.db`) for projects list. configDir is `%APPDATA%/kangentic/`
  (Win), `~/Library/Application Support/kangentic/` (Mac), `~/.config/kangentic/` (Linux)
- Per-project DB (`<configDir>/projects/<projectId>.db`) for tasks, swimlanes, actions, sessions
- Migrations run automatically on open
- **Timestamps** are UTC ISO 8601 strings written via `new Date().toISOString()` (never SQLite
  `DEFAULT CURRENT_TIMESTAMP` or naive strings). Display formatting is the renderer's job
  (`src/renderer/lib/datetime.ts`). See `.claude/rules/utc-timestamps.md`.

### Testing

Three test tiers (unit / UI / E2E). Setup, commands, the headless mock, and tier
guidance live in [docs/developer-guide.md](docs/developer-guide.md). The scoped-run discipline
below is the part that must stay in context.

#### The board test gate (Tests and Ship It columns)

The expensive and flaky tiers now run on CI as PR checks, not on the local machine. Moving a task
into the **Tests** column runs `/pull-request`: it creates a PR and drives its CI checks (lint,
typecheck, unit, build, the UI shards, and the Linux Electron E2E shards) to all-green, auto-fixing
the code and de-flaking or rewriting tests along the way, then stops without merging. Moving it into
**Ship It** runs `/merge-pull-request`: it merges the green PR and fast-forwards the local `main`
checkout for HMR. PRs are the normal path to `main` (CI gates it); `/merge-back` stays a direct
quick-push escape hatch for admins. `/test` is now for **manual local runs** only - it is no longer
wired to a column.

#### When to test

`/test` is the full local gate (typecheck, build, then unit + UI + E2E, all tests, no selection
heuristic), run manually when you want it; `/test quick` runs unit + UI only for the fast inner
loop. Full-tier runs are reserved for the `/test` command or explicit user request. While working on
a task, stay scoped to what you changed - the PR checks are the authoritative full gate.

**Always fine:**
- `npm run typecheck` - run freely at any point.
- Running tests you just added or modified, scoped to those files:
  - `npx vitest run tests/unit/my-new.test.ts`
  - `npx playwright test tests/ui/my-new.spec.ts`
- Single-file validation of an existing test directly affected by your change (same scoped form).

**Never run unless the user explicitly asks, or `/test`, `/pull-request`, or `/merge-back` is executing:**
- `npm test`
- `npm run test:unit` (unscoped vitest)
- `npx vitest run` (no file path)
- `npx playwright test` and `npx playwright test --project=ui` (no spec path)

If a run would execute tests you did not add or modify, it is a full-tier run. Stop and let
`/test` handle it.

**Pre-commit:** `/pull-request` and `/merge-back` run typecheck and lint automatically. Full-tier
validation is CI's job (the PR checks), or the `/test` command for a manual local run.

### Performance

Terminal ownership handoff (one xterm per session, enforced via `dialogSessionIds`), the
activity-log event pipeline (hook -> event-bridge.js -> JSONL -> store, replacing an aggregate
terminal), WebGL rendering with automatic canvas fallback, and 200ms PTY resize debouncing.
Details: [docs/session-lifecycle.md](docs/session-lifecycle.md) and
[docs/architecture.md](docs/architecture.md).

## Conventions

Enforceable standards live as focused, auto-loaded rules in `.claude/rules/`. Claude Code loads
them into context the way it loads this file: rules without a `paths:` header load every
session; rules with one load when you touch matching files. Each rule names its enforcement (a
`tests/unit/` test that runs in CI, and/or an auditor agent invoked during `/code-review`).

**Always-on rules:**
- `bash-single-command.md` - one command per Bash tool call; no `&&` `||` `|` `;` or redirects.
- `text-formatting.md` - no em-dashes (U+2014) or `--` as punctuation in authored text.
- `typescript-style.md` - TypeScript strict mode; no `any` types; full descriptive names.
- `no-personal-info.md` - no usernames, emails, or machine paths in committed code (repo is public).

**Path-scoped rules (load with their subsystem):**
- `task-lifecycle-lock.md` - wrap per-task async mutation in `withTaskLock` (`src/main/ipc/`).
- `hmr-patterns.md` - dev-mode HMR parity patterns A through D (`src/renderer/`).
- `ui-conventions.md` - shared UI primitives, selectors, font floor, no hover-only controls (`src/renderer/`).
- `synchronous-shutdown.md` - the `before-quit` path must be synchronous (`src/main/` shutdown).
- `utc-timestamps.md` - DB writes use `new Date().toISOString()` (`src/main/db/`).
- `ipc-7-layer-parity.md` - wire an IPC endpoint through all 7 layers.
- `project-scoped-ipc.md` - renderer-driven task/session mutations forward an explicit interaction-time `projectId` (`src/preload/`, `src/main/ipc/`, `src/renderer/stores/`).
- `esbuild-cjs-imports.md` - ES `import`, not bare `require()`, in bundled main/preload code.
- `agent-adapters-boundary.md` - no agent-name branching outside `src/main/agent/adapters/`.
- `cli-features-over-custom-layers.md` - do not shadow an agent CLI's native controls (`src/main/agent/`).
- `dev-tooling-build-exclusion.md` - dev tooling build-excluded via `__KANGENTIC_DEV__` (`src/devtools/`).
- `docs-stay-in-sync.md` - update docs when changing anchor source files (types, IPC, migrations, adapters, settings).
- `skill-authoring.md` - when to fork a skill and how to route agents (`.claude/`).
- `board-config-parity.md` - team-shared swimlane fields must round-trip to `kangentic.json`.
- `external-scripts-parity.md` - unbundled bridge/plugin scripts must register in `EXTERNAL_SCRIPTS` and be copied by both `build.js` and `dev.js`.
- `activity-state-classification.md` - bucket `ActivityState` idle-vs-active only via `src/shared/activity-state.ts` (`src/renderer/`).
- `board-completing-task-chokepoint.md` - hide in-flight Done-completing tasks only at KanbanBoard's `tasksPerLane`, never per-lane (`src/renderer/components/board/`).
- `keybindings-registry.md` - renderer shortcuts declared in `KEYBINDINGS` and bound via `useKeybinding`, not ad-hoc `addEventListener('keydown')` (`src/renderer/`).
- `restore-no-animation-replay.md` - a project switch / restore paints flat: restored windows skip the entrance animation (`skipEnterAnimation`) and `useValuePulse` rebaselines on a `resetKey` instead of pulsing (`src/renderer/`).
- `cross-platform-parity.md` - code and tests must behave identically on Windows/macOS/Linux/CI; no OS-specific paths, no cross-test state leakage or pixel-exact assertions (`tests/`, `src/main/` pty/agent/git).
- `browser-automation-driver.md` - the shipped CDP driver is singular and ships; every `kangentic_browser_*` tool routes through `withGuest`; no `src/devtools/` import from shipped code (`src/main/browser/`).
- `mcp-tool-list-parity.md` - every MCP tool registered under `src/main/agent/mcp-http/*-tools.ts` stays in sync with `MCP_TOOL_MANIFEST` (the settings panel's source) and `docs/mcp-server.md` (`src/main/agent/mcp-http/`, `src/shared/mcp-tool-manifest.ts`).

**Local overrides:** there is no per-rule local file. Put machine-specific instruction
overrides in a gitignored `CLAUDE.local.md` at the project root.

**Other conventions (workflow, not extracted to rules):**
- Prefer editing existing files over creating new ones.
- When adding or updating tests, use the `/test` command to ensure correct tier classification.
- A plain **local commit** (snapshot work in progress, protect changes before `/preview`) goes
  through `/commit`: it stages and commits on the current branch only, with no push and no
  rebase. A bare request to "commit" / "commit changes" means `/commit`, never `/merge-back`.
- **Landing changes goes through a PR by default.** The board drives it: the **Tests** column runs
  `/pull-request` (commit, conventional branch, push, create the PR, drive its CI checks to green),
  and the **Ship It** column runs `/merge-pull-request` (merge the green PR, pull back to local
  `main`). For a deliberate direct quick-push that bypasses the PR gate (admin only - CI is down, a
  one-line hotfix), use `/merge-back`. Only push, land, or merge when the user explicitly asks.
- `/commit`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all write conventional-commit
  messages.
- `/sync-docs` keeps `docs/` aligned with source; the doc-anchor check runs inside `/pull-request`
  (commit time) and `/merge-pull-request` (merge time), and `/merge-back` for direct pushes.

### Authoring a rule

When you codify a new convention, add it as a `.claude/rules/*.md` file following the existing
ones (e.g. `board-config-parity.md`):

1. **One concern per file**, with a descriptive kebab-case filename.
2. **Decide loading, and keep always-on rules few.** Always-on rules (no frontmatter) load every
   session and cost context every session, so reserve them for universal, file-independent
   conventions (tool use, house style, security). Everything subsystem-specific gets `paths:`
   frontmatter so it loads only when a matching file enters context. We run ~4 always-on; treat
   that as a soft ceiling.
3. **Mind the read-trigger gap.** A path-scoped rule loads when a matching file is *read into
   context*, not when Claude *creates* a new file in that path. So (a) any convention that must
   hold at file-creation time (universal style, security) belongs in an always-on rule, a lint
   rule, or a hook, never path-scoped-only; and (b) every path-scoped rule should have a CI
   backstop (a `tests/unit/` test, an ESLint rule, or a review-time auditor agent) so a missed
   load is still caught.
4. **Structure:** a one-paragraph context (the problem / the bug it prevents), `## The rule`
   (prescriptive), `## Enforcement (self-maintaining)`, and `## Scope`.
5. **Name an enforcement, strongest available.** A `PreToolUse` hook blocks 100%; a `tests/unit/`
   check or ESLint rule both run in CI; a review-time auditor agent or `/code-review` is the
   probabilistic fallback. Flag explicitly where mechanical coverage is missing. Do not stack
   three redundant enforcers on one rule.
6. **Update the index above** with a one-line pointer, and add a backlink from the enforcing
   agent or skill so the rule stays the single source of truth.
7. **Scaling.** Rules are discovered recursively, so when the flat list grows large, group them
   into `.claude/rules/<subsystem>/` subdirectories (e.g. `frontend/`, `backend/`). There is no
   per-rule local override; machine-specific overrides go in `CLAUDE.local.md`.

**Linting:** `npm run lint` runs `eslint src/ --max-warnings 0` in CI
(`.github/workflows/ci.yml`), so ESLint rules (`no-explicit-any`, `no-require-imports`, etc.)
are enforced on every push. No warnings are tolerated: `--max-warnings 0` makes ANY warning
(including `react-hooks/exhaustive-deps`) fail the lint check, so warnings can never silently
accumulate. Fix a warning properly where the dependency is safe to add (stable refs, Zustand
actions) or restructure (wrap an unstable `?? {}`/`?? []` fallback in `useMemo`); only when an
omission is deliberate, suppress that one line with `// eslint-disable-next-line
react-hooks/exhaustive-deps -- <reason>` and a concrete reason. Use a `tests/unit/` check for
conventions ESLint cannot express (em-dashes, IPC and board-config parity, ...).
