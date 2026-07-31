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
  protocol/       # Public npm package ("@kangentic/protocol") - shared mobile bridge
                  #   wire schema, Noise crypto, capability verbs (desktop + future mobile app)
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
    mobile-bridge/  # Mobile companion app bridge: identity, signed roster, QR pairing,
                    #   capability router, relay transport client (consumes @kangentic/protocol)
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
  pills AND the branch picker fold into the kebab as the window narrows, down to the min width.
  The divider precedes the window-frame cluster (kebab, THEN divider, THEN tile-layout/pop-out/
  maximize), mirroring `TaskDetailHeader`'s divider placement - not a divider isolating just the
  last control. Each window has full task-detail parity: tile-layout menu, pop-out
  (`untileWindow`: the clicked pane floats at its current rect; the survivors STAY DOCKED and keep
  their absolute widths by shrinking the footprint - no rescale - except a 2-pane group fully
  dissolves so both float), and a min-pane-width floor on tiling (seam-drag clamp in
  `TileSplitter` + a footprint grow on spawn). Both behaviors live in the shared engine, so
  task-detail windows get them too. The title bar hosts TWO adjacent, purpose-built buttons
  instead of one overloaded control: a plain open/close TOGGLE (`useCommandBar().open`/`close`,
  `TitleBar.tsx`'s `quick-session-button`) that never spawns a terminal, so there is always a
  discoverable one-click way to hide the layer even when a window is maximized over the backdrop;
  and, rendered only while the layer is open, a "New terminal" button positioned to its LEFT
  (`quick-session-new-terminal`, calling `spawnAdditionalCommandTerminal()`), disabled at
  `MAX_COMMAND_TERMINALS`. Both share the custom `CommandTerminalIcon` SVG glyph (not a bare
  lucide icon): the toggle always shows the shell-prompt variant, while "New terminal" passes
  `showPlus` to render the center-`+` variant (`data-plus` on the svg), so the spawn affordance
  still reads as "add a Command Terminal" rather than a generic plus. Only the TOGGLE carries the
  aggregate activity tone/color/march-animation (`tone={transientActivityTone}`); "New terminal"
  is hardcoded `tone="rest"` (uncolored, unanimated) since it represents an action, not the state
  of any existing terminal - a fresh terminal has no activity to reflect. A thin divider (matching
  the one before the Windows min/max/close controls) sits right after "New terminal", so it reads
  as a transient action distinct from the permanent icon cluster to its right (toggle, Quick Find,
  stats, settings); the divider mounts/unmounts together with the button so it never leaves
  an orphan line when the layer is closed. This pair is the LEFT-MOST icons in the title bar's
  right-aligned button row (before Quick Find), deliberately: that row is right-anchored (a
  `flex-1` spacer eats the space to its left), so an element's on-screen distance from the window
  edge is fixed by whatever comes AFTER it, never before it. Keeping "New terminal" + the divider
  + the toggle first means the conditionally-mounted "New terminal" button
  appearing/disappearing as the layer opens/closes never shifts Quick Find, stats,
  settings, or the OS window controls - only this pair's own position moves. The toggle glyph's
  stroke color is the aggregate activity of the project's terminals (active-green working /
  attention-amber needs-you / muted rest, via the central `--kng-active` / `--kng-attention`
  tokens) and the working border MARCHES (`.kng-march` + a `pathLength`-normalized stroke-dash,
  both shipped with the mark). The glyph itself is no longer hand-authored: `CommandTerminalIcon`
  is a thin wrapper over `components/ActivityMark.tsx`, which renders the `terminal-idle` /
  `terminal-working` / `terminal-new` marks from `@kangentic/branding`. See the Activity marks
  section below. The toggle reflects only the CURRENT project, so the same glyph is mirrored
  per project in the sidebar (`SidebarCommandTerminalIndicator` in each `ProjectListItem` row,
  plus a plain tone dot on `CollapsedRail`'s 28px buttons, where an arc-bearing glyph would read
  as broken). Both the toggle and the sidebar read one shared selector,
  `selectCommandTerminalSummary` (`transient-session-slice.ts`), which derives count + tone from
  the UNSCOPED `sessions` list (`transient && projectId && status === 'running'`) rather than the
  `transientSessions` map: that map is renderer-owned window pairing whose hard-reload recovery
  only re-pairs the current project, so a map-based count reads zero for every background project
  after a reload. The sidebar indicator sits BESIDE the agent thinking/idle counts in the row's
  right-aligned cluster, never merged into them (a Command Terminal is not a task agent). It always
  prints its count, even at 1, so it forms an icon+digit pair matching the agent counts and the
  three indicators stack into one tabular column down the list; a name-adjacent placement was tried
  and reverted, because project names vary enough that the glyph landed at a different x on every
  row. Clicking it switches to that project and reopens its layer via the same
  `setPendingOpenCommandTerminal` flag the notification-click path uses, armed only once the switch
  is CONFIRMED. Awaiting is not enough: `openProject` also RESOLVES without switching (a moved or
  renamed folder routes to the "Locate Folder" dialog) and re-throws every other failure, so the
  sidebar re-reads `currentProject` after the await and leaves the flag disarmed unless it landed.
  Arming on those paths opens the layer on the OUTGOING project. GEOMETRY is global but
  POPULATION is per-project: the window layout blob
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
- **Activity marks** - The nine glyphs that express agent/terminal activity are owned upstream in
  `@kangentic/branding` (`assets/activity/`), NOT hand-authored here, so desktop, web, and mobile
  cannot drift. `components/ActivityMark.tsx` is the only consumer: it imports each mark with
  `?raw`, strips the packaged `<svg>` wrapper, and injects the inner markup into a `<g>` under a
  React-authored root. That root shape is load-bearing and must not become `BrandMark`'s wrapper-
  `<span>` form: React forbids `children` next to `dangerouslySetInnerHTML` on one element, and
  `TaskCard` passes a `<title>` child for its hover tooltip. Marks are `currentColor` only, so the
  CALL SITE supplies `text-active` / `text-attention` / `text-fg-muted` - never hardcode a hex,
  since `--kng-active` / `--kng-attention` are desktop-only values that mobile and web
  deliberately diverge from. There is no `-rest` mark: rest is the `-idle` geometry in a muted
  tone. `data-rest` on the root is the reduced-motion strategy (`static` / `keep-dash` /
  `drop-dash`), NOT a tone; test selectors key off `data-mark`. The set's grid is a WIDTH
  KEYLINE, not a square ink box: each mark fills its slot's width and takes the height its form
  needs (width is the advance that shifts a row; height is absorbed by `align-items: center`).
  Two keylines, one per role - 18 for indicators, 20 for controls. Size floors are 12 for
  indicators and 16 for controls, which is why `TerminalPanel`'s 8px session dot stays lucide.
  The two control marks render at size 20: their r=10 ring draws 18.33px, a pixel match for the
  lucide `Circle` they replaced. Upstream geometry has already moved twice (2.5.0 squared the
  envelope to 18x18 and shrank the controls to r=9; 2.6.0 reversed both), so
  `tests/unit/activity-mark.test.ts` pins the r=10 control ring, the r=9 agent ring, and the
  envelope's 18 x 14.4 box as the guard against a silent upstream reshape. The envelope's height
  is load-bearing beyond legibility: a card swaps idle for working IN PLACE, and at 18x18 the
  envelope enclosed 26% more than the ring, so the indicator visibly grew on every state change.
  At 14.4 the two are within 0.5%, which holds only while `agent-working` stays r=9. Indicators
  render at 16 (`TaskCard` and both sidebar components), NOT the 14 the lucide glyphs used: the
  branding envelope is 18 wide where lucide's `Mail` was 20, so a same-number swap silently
  shrinks it ~10%. 15 restored the drawn size production shipped; 16 is a deliberate one-step
  legibility bump on top of that. Move the sidebar's two indicator components together or the
  row goes ragged. lucide stays everywhere
  else (140+ files), and `utils/swimlane-icons.tsx` needs its whole glyph map
  because column icon names are persisted as kebab-case strings in the DB.
- **Settings tab separator** - Each tab in `SETTINGS_TABS` (`settings-tabs.ts`) declares a
  `category`. `'project'` tabs (General, Theme, Agent, Git, Browser, Shortcuts) are per-project
  settings, saved to `.kangentic/config.json`, and hidden when no project is selected.
  `'system'` tabs (Board, Task, Changes, Terminal, Behavior, Hotkeys, Notifications, Dictation,
  Memory, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer) are shared settings that
  apply across all projects, saved to global config, and remain fully functional with no
  project open. The Task tab holds task-presentation settings split out of Board (Card Density,
  Ticket Numbers) and Terminal (the whole Context Bar section): those describe how an individual
  task presents itself, not board layout or terminal cosmetics, so Board stays pure board layout
  and Terminal stays pure terminal cosmetics. Terminal (shell, font, cursor style,
  colors) is global-only, not per-project: shell in particular was never reliably project-scoped
  at the PTY-spawn level (`SessionManager` caches a single `configuredShell` keyed to whichever
  project is currently focused - `src/main/pty/session-manager.ts`), so a background project's
  spawn/resume could silently pick up the wrong shell. There is no Global/Project scope toggle.
  Theme is its own tab, not folded into General, so it has a discoverable sidebar entry distinct
  from Project Location. System tabs are further grouped in the sidebar into three tiers (`tier`
  in `settings-tabs.ts`): Core (Board through Notifications, unlabeled - the default group
  directly under the System header), Advanced (Dictation through Mobile Devices), and Other
  (Privacy, Developer). Tiers must stay contiguous; `settings-tab-scope-parity.test.ts` enforces
  it. A thin full-bleed divider (not just the "System" text label) marks the Project/System
  boundary, since that split is behavioral (System tabs must work with no project open), not just
  organizational. Order within each group (Project; each System tier) is curated by
  frequency/concept, not alphabetical - see the comment above `SETTINGS_TABS` in
  `settings-tabs.ts` for why.
  When adding a new setting, its `tabId` must match its `scope` - see
  `.claude/rules/settings-tab-scope.md`, which is enforced by
  `tests/unit/settings-tab-scope-parity.test.ts`.

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

Upstream of both, the **Code Review** column runs `/code-review` as an isolated column agent in the
task's OWN worktree (`isolated` isolates the conversation, not the filesystem - see
[docs/session-lifecycle.md](docs/session-lifecycle.md)). Entering the column suspends the task
agent's session and kills its PTY, so the two never overlap - but it leaves that agent's
UNCOMMITTED work in the shared tree, which is why the review pass commits by set math over
`git status` and never `git add -A`. It auto-fixes findings, adds tests, and commits that pass
itself, so Tests can open on a branch carrying a `*(review)` commit no local agent authored. That is
expected, not corruption. A finished pass normally leaves the tree clean; a fix on an already-dirty
path stays uncommitted by design, so a dirty tree means the pass is either in flight or left those
paths deliberately mixed.

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
- `ui-conventions.md` - shared UI primitives, selectors, font floor, no hover-only controls, brief accurate copy (`src/renderer/`).
- `popover-escapes-clipping.md` - a menu popover portals to `document.body` with `strategy: 'fixed'`; `z-index` never escapes an ancestor's overflow clip (`src/renderer/`).
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
- `central-embedding-engine.md` - only `embed-engine.ts` embeds; lifecycle/IPC call sites index and `markDirty()`, never embed inline (`src/main/retrieval/**`, `src/main/ipc/handlers/**`).
- `pop-out-surface-registry.md` - every OS `BrowserWindow` is created only in `createWindow` or the pop-out window manager; every detachable surface goes through the shared + renderer registries (`src/main/pop-out/**`, `src/shared/pop-out.ts`, `src/renderer/pop-out/**`).
- `spawn-entry-point-parity.md` - every agent-spawn entry point routes through `spawnAgent` / `prepareAgentSpawn` and the shared `runSpawnPreamble` (first-spawn override lock + agent resolution); no direct engine spawn calls in handlers (`src/main/ipc/**`, `src/main/transition-engine/**`).
- `linux-package-dependencies.md` - rpm dependencies are soname capabilities, never package names, since RPM package names differ per distro (`electron-builder.yml`).
- `task-template-vars-parity.md` - the 10 auto_command / spawn_agent promptTemplate keywords are declared once in `TASK_TEMPLATE_VARS` and drive the resolver map, UI chips, and docs tables (`src/shared/task-template-vars.ts`, `src/main/agent/shared/task-template-resolvers.ts`, `src/renderer/components/dialogs/BoardManagerDialog.tsx`).
- `settings-tab-scope.md` - a setting's tab must match its persistence scope; a project-scoped setting in a system tab silently drops its write with no project open (`src/renderer/components/settings/settings-registry.ts`, `settings-tabs.ts`, `tabs/**`).
- `derived-detail-ownership.md` - task-detail ownership is reported as a host's COMPLETE mounted set and reconciled, never accumulated from claim/release; the reporter mounts where it outlives the window store (`src/main/task-detail/**`, `src/renderer/window-manager/bridge/**`, `src/renderer/components/monitor/**`).

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
