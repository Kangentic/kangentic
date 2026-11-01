# Kangentic

Cross-platform desktop Kanban for Claude Code agents.

## Tech Stack

- **Runtime:** Electron 45 + Node 24
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
    automations/  # Column automation adapter system (mirrors agent/, boards/, pr/)
      shared/     # AutomationAdapter contract, context, errors, describe helpers
      adapters/   # Per-type subfolders (send-message/, run-script/, webhook/, notify/, move-to-column/, legacy/)
      automation-registry.ts  # Central AutomationRegistry + automationRegistry singleton
    boards/       # Board integration adapter system (mirrors agent/)
      shared/     # BoardAdapter interface + auth, mapping, download, rate-limit helpers
      adapters/   # Per-provider subfolders (github-issues/, azure-devops/, jira/, etc.)
      board-registry.ts  # Central BoardRegistry + boardRegistry singleton
    db/           # SQLite database, migrations, repositories
    transition-engine/  # Transition engine (action execution)
    git/          # Worktree manager
    held-messages/  # Messages held for a task with no running agent, sent in its next agent's opening message
    ipc/          # IPC handler registration
    mobile-bridge/  # Mobile companion app bridge: identity, signed roster, QR pairing,
                    #   capability router, relay transport client (consumes @kangentic/protocol)
    pr/           # PR subsystem (mirrors agent/boards): shared/ contract + errors,
                  #   adapters/github/ connector, pr-registry, linking, refresh, scheduler
    pty/          # PTY session manager, shell resolver
    workflows/    # Linked tasks that run on their own: pure engine/ core (starts, lock) + main host,
                  #   turn-end step check, operations behind the kangentic_*_workflow MCP tools
  preload/        # Context bridge (preload.ts)
  renderer/       # React UI
    components/   # Board, dialogs, layout, terminal, sidebar
    hooks/        # useTerminal
    stores/       # Zustand stores (board, config, project, session)
  shared/         # Types and IPC channel constants
  locales/        # Lingui PO catalogs, one per area per locale (lingui.config.ts)
tests/
  e2e/            # Playwright E2E tests
scripts/          # Build and dev scripts
```

## Commands

- `npm start` - Start in development mode (Vite HMR + esbuild watch)
- `npm run build` - Production build to `.vite/build/`
- `npm test` - Run all Playwright E2E tests

- `npm run i18n:extract` - Update the PO catalogs after adding, changing or removing UI text;
  `npm run i18n:check` is the gate CI and the release build run (`.claude/rules/i18n.md`)
- `npm run package` - Package for distribution (unpacked directory)
- `npm run make` - Build installer (NSIS on Windows, DMG on macOS, deb/rpm on Linux)
- `npm run build:demo` - Build the renderer for a plain browser into `dist/demo/` (the web demo
  the site and docs embed; see `demo/README.md`). `npm run test:demo` smoke-tests that build;
  `npm run demo:serve` serves it for a manual look (open `/demo/stage.html`); `npm run demo:measure`
  reports its weight and boot timings; `npm run demo:posters` shoots the docs poster set from it
  and zips it with a manifest (the `demo-posters-<version>.zip` release asset). This is the WEB
  build, not `/preview`, which launches the Electron desktop app and serves none of it.

**Worktrees need `npm install`:** Git worktrees do not share `node_modules/` with the main
repo. Always run `npm install` in a worktree before running any npm scripts (`npm run
typecheck`, `npm run build`, `npx playwright test`, etc.). Without it, binaries like `tsc`
won't be found.

**Background servers carry `--kangentic-no-activity-hold`:** a server or watcher you start in
the background and leave running (`npm run demo:serve`, a scratchpad HTTP server) puts that
flag in its command, as a trailing shell comment when the program rejects unknown flags
(`npm run demo:serve # --kangentic-no-activity-hold`). Without it the activity engine holds the
task active for as long as the server lives: the board shows it working through every Stop,
and the column's On agent turn end automations never run.

## Docs

`docs/` is an Open Knowledge Format bundle. Start at [docs/index.md](docs/index.md): each
folder's `index.md` lists its concepts with one line on what each holds, so pick a concept by its
description before reading any doc, then read it whole. Each concept's frontmatter `sources:`
names the code it documents; `node scripts/docs-bundle.mjs sources <file>` lists the concepts a
source file maps to.

## Architecture

### Data Flow
1. User drags a task between columns (swimlanes)
2. `TASK_MOVE` IPC handler fires in main process
3. The priority ladder decides the task's session (reset, suspend, keep, or respawn), and the
   destination column's automations run
4. A column that runs an agent starts it through `spawnAgent`: the agent's adapter builds its
   CLI command, and the PTY session runs in the pty host
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
- **Command Terminal** - Ctrl+Shift+P opens one panel: a rail (Add terminal, Earlier
  conversations) beside up to four auto-tiled "transient" sessions, hosted in a SECOND window-manager
  layer (`components/command-bar/`) separate from the board task-detail layer. Windows are keyed
  by a durable SLOT, geometry is global but population is per-project (reconciled before the
  layer mounts), a reattach NEVER fetches or checks out, the branch is a per-project fact
  re-derived by one layer bridge, ended conversations are recorded and resumable, and the panel
  can move to a window of its own but never shows in both.
  Rules: `.claude/rules/command-terminal.md`. Design history: [docs/architecture/renderer/command-terminal.md](docs/architecture/renderer/command-terminal.md).
- **Activity marks** - The eleven agent/terminal activity glyphs are owned upstream in
  `@kangentic/branding`, NOT hand-authored here, and render only through
  `components/ActivityMark.tsx`. Motion is always on a COMPOSITED property, marks are
  `currentColor` only (the call site supplies the tone), and an icon that changes ELEMENT TYPE
  between states must render through `components/IconSlot.tsx` or it swallows the click.
  Rules: `.claude/rules/activity-marks.md`. Design history: [docs/architecture/renderer/activity-marks.md](docs/architecture/renderer/activity-marks.md).
- **Settings tab separator** - Each tab in `SETTINGS_TABS` (`settings-tabs.ts`) declares a
  `category`: `'project'` tabs save per project and are hidden with no project open; `'system'`
  tabs save to global config and work with no project open. There is no Global/Project scope
  toggle. A setting's `tabId` must match its `scope` (`.claude/rules/settings-tab-scope.md`,
  enforced by `tests/unit/settings-tab-scope-parity.test.ts`). Which tab holds what, the three
  system tiers and why: [docs/settings/settings-panel.md](docs/settings/settings-panel.md).

### Per-Project Directory
All runtime data lives under `<project>/.kangentic/` (auto-added to `.gitignore` on project
open):
- `config.json` - project config overrides
- `sessions/<claudeSessionId>/` - per-session files (`settings.json`, `status.json`, `activity.json`)
- `worktrees/<slug>/` - git worktree checkouts
- `removed-worktrees/<folder>-<timestamp>-<random>/` - worktrees a Done move set aside, deleted in the background
  while no Post-Worktree Script runs

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
guidance live in [docs/contributing/developer-guide.md](docs/contributing/developer-guide.md). The scoped-run discipline
below is the part that must stay in context.

#### The board test gate (Testing and Merge columns)

The expensive and flaky tiers run on CI as PR checks. The **Testing** column runs `/pull-request`
(create the PR, drive its CI checks to green, never merge) and **Merge** runs `/merge-pull-request`
(merge the green PR, fast-forward local `main`). Upstream, the **Code Review** column runs
`/code-review` in the task's own worktree and commits its own `*(review)` pass, which is expected,
then ends Ready or Blocked. `/test` is for manual local runs only. What each column runs and why:
[docs/contributing/board-test-gate.md](docs/contributing/board-test-gate.md).

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
Details: [docs/architecture/sessions/terminal-ownership.md](docs/architecture/sessions/terminal-ownership.md),
[docs/architecture/sessions/output-streaming.md](docs/architecture/sessions/output-streaming.md) and
[docs/architecture/system-overview.md](docs/architecture/system-overview.md).

## Conventions

Enforceable standards live as focused, auto-loaded rules in `.claude/rules/`. Claude Code loads
them into context the way it loads this file: rules without a `paths:` header load every
session; rules with one load when you touch matching files. Each rule names its enforcement (a
`tests/unit/` test that runs in CI, and/or an auditor agent invoked during `/code-review`).

**Always-on rules:**
- `bash-single-command.md` - one command per Bash tool call; no `&&` `||` `|` `;`, redirects, or command substitution.
- `writing-style.md` - no AI tells in authored prose; no em-dashes, en-dashes, `--`, or curly quotes.
- `typescript-style.md` - TypeScript strict mode; no `any` types; full descriptive names.
- `no-personal-info.md` - no usernames, emails, machine paths, client names, or request origins in committed files (repo is public).

**Path-scoped rules (load with their subsystem):**
- `task-lifecycle-lock.md` - wrap per-task async mutation in `withTaskLock`.
- `hmr-patterns.md` - dev-mode HMR parity patterns A through D.
- `ui-conventions.md` - shared primitives, font floor, no hover-only controls, the 900x600 floor, brief copy.
- `one-tooltip.md` - every tooltip is `Tooltip`; no native `title` anywhere in the renderer, truncated values included; no tip that repeats a visible label, and no "Click to...".
- `toast-shape.md` - every toast is a title over one line; a timed toast has no button (its card may open its subject), a toast with a button is persistent.
- `popover-escapes-clipping.md` - a menu popover portals to `document.body` with `strategy: 'fixed'`; `z-index` never escapes an overflow clip.
- `light-dismiss-denylist.md` - clicking outside a task window closes it; overlays mount outside the `data-dismiss-layer` subtree.
- `synchronous-shutdown.md` - the `before-quit` path is synchronous; only the bounded PTY exit drain may `preventDefault`.
- `utc-timestamps.md` - DB writes use `new Date().toISOString()`.
- `guarded-sync-writes.md` - a synchronous write is routed through `safeWriteJson` or marked `// sync-write-ok:` with a reason.
- `ipc-7-layer-parity.md` - wire an IPC endpoint through all 7 layers.
- `project-scoped-ipc.md` - renderer-driven task/session mutations forward an explicit interaction-time `projectId`.
- `esbuild-cjs-imports.md` - ES `import`, not bare `require()`, in bundled main/preload code.
- `dependency-block-parity.md` - `dependencies` is the esbuild externals plus what `electron-builder.yml` names; everything bundled is a devDependency.
- `agent-adapters-boundary.md` - no agent-name branching outside `src/main/agent/adapters/`.
- `automation-adapters.md` - an automation type is declared once in `AUTOMATION_MANIFEST`; the runner owns escaping, timeouts, and retry.
- `cli-features-over-custom-layers.md` - do not shadow an agent CLI's native controls.
- `dev-tooling-build-exclusion.md` - dev tooling is build-excluded via `__KANGENTIC_DEV__`.
- `docs-stay-in-sync.md` - update docs when changing anchor source files (types, IPC, migrations, adapters, settings).
- `protocol-release-parity.md` - every `protocol-v*` tag needs a `CHANGELOG.md` entry; never hand-tag a protocol release.
- `skill-authoring.md` - when to fork a skill and how to route agents.
- `board-config-parity.md` - team-shared swimlane fields round-trip to `kangentic.json`.
- `external-scripts-parity.md` - unbundled bridge/plugin scripts register in `EXTERNAL_SCRIPTS` and are copied by both `build.js` and `dev.js`.
- `activity-state-classification.md` - bucket `ActivityState` idle-vs-active only via `src/shared/activity-state.ts`.
- `activity-marks.md` - marks come from `@kangentic/branding` via `ActivityMark`; composited motion only; `IconSlot` for element-type swaps.
- `command-terminal.md` - slot-keyed windows in an auto-tiled panel, main-owned slots and cap, global geometry against per-project population, a reattach that never checks out, a terminal that ends when its agent exits, no pause that reaches one, resumable Earlier conversations, and a detached window that never shows beside the panel.
- `board-completing-task-chokepoint.md` - hide in-flight Done-completing tasks at KanbanBoard's `tasksPerLane`, never per-lane.
- `keybindings-registry.md` - shortcuts declared in `KEYBINDINGS` and bound via `useKeybinding`, not ad-hoc keydown listeners.
- `keyboard-drag-intent.md` - `IntentKeyboardSensor` is the only dnd-kit keyboard sensor, and it arms only on Tab-placed focus.
- `restore-no-animation-replay.md` - a project switch or restore paints flat: no entrance replay, no value pulse.
- `cross-platform-parity.md` - code and tests behave identically on Windows/macOS/Linux/CI.
- `browser-automation-driver.md` - one shipped CDP driver; every `kangentic_browser_*` tool routes through `withGuest`.
- `mcp-tool-list-parity.md` - every registered MCP tool stays in sync with `MCP_TOOL_MANIFEST` and has a heading in a `docs/integrations/mcp-server/` concept.
- `mcp-column-field-parity.md` - every `Swimlane` field is a parameter of both MCP column tools, or classified unexposed with a reason.
- `central-embedding-engine.md` - only `embed-engine.ts` embeds; call sites index and `markDirty()`, never embed inline.
- `retrieval-out-of-process.md` - the index and agent transcript reads run in the `kangentic-retrieval` worker; main schedules and relays.
- `pty-host-out-of-process.md` - every PTY and its per-chunk work run in the `kangentic-pty-host` utility process; main holds mirrors and async reads; keystrokes and echo ride each renderer's own port; the host's I/O thread starts no process.
- `dictation-out-of-process.md` - `sherpa-onnx-node` is imported only inside the `kangentic-dictation` utilityProcess worker.
- `pop-out-surface-registry.md` - every `BrowserWindow` comes from `createWindow` or the pop-out manager, through the registries.
- `spawn-entry-point-parity.md` - every agent spawn routes through `spawnAgent` / `prepareAgentSpawn` and `runSpawnPreamble`.
- `linux-package-dependencies.md` - rpm dependencies are soname capabilities, never package names.
- `release-gates-fail-loudly.md` - a release-path step that guarantees something fails loudly when it cannot.
- `task-template-vars-parity.md` - promptTemplate keywords are declared once in `TASK_TEMPLATE_VARS`.
- `settings-tab-scope.md` - a setting's tab must match its persistence scope.
- `settings-card-design.md` - every settings tab is `SettingsCard`s whose bodies hold only tiles; depth lifts, switches align, descriptions fit one line, short fixed choices are segmented controls.
- `derived-detail-ownership.md` - task-detail ownership is a host's COMPLETE mounted set, reconciled, never accumulated.
- `retained-pane-never-remounts.md` - a window with an open Browser pane is RETAINED across a project switch; hide it with `opacity: 0`.
- `terminal-arrival-focus.md` - an arriving terminal never decides its own focus; route it through `mayTakeArrivalFocus`.
- `agent-driven-focus.md` - an agent-driven pane SHOWS its focus move, and the driver never takes guest focus itself.
- `xterm-unicode11-parity.md` - every xterm `Terminal` activates Unicode 11 widths; hand-rolled parsers use `wcwidthV11`.
- `xterm-query-replies.md` - a terminal whose `onData` reaches a PTY swallows XTVERSION and keeps the `vtExtensions` replies off, before its first write.
- `cookie-jar-sharing.md` - jar cookies are copied only through `cookie-seed.ts`, and partitions stay task-keyed.
- `pty-teardown-grace.md` - an agent whose console close is its graceful exit (Claude on Windows and Linux) is closed, never typed into; any other young agent gets its exit sequence and the 1500 ms grace; a reap waits for the agent a killed shell left; a dead shell's agent is asked to exit before anything is terminated.
- `task-process-tag.md` - task PTYs carry `KANGENTIC_TASK_ID`; a terminal transition kills only tagged processes in the task's directories, never shared, visible or tmux ones; env text never leaves a reader.
- `web-demo-parity.md` - the web build is the real renderer over the mock bridge; every `ElectronAPI` method has a mock.
- `session-replica-contract.md` - the renderer session store is a replica of main's registry, and a removal is its own push.
- `i18n.md` - UI text goes through Lingui: `.tsx` macros, `msg` plus `i18n._` in `.ts`, translated where it renders, agent text English, one PO file per area.

**Local overrides:** there is no per-rule local file. Put machine-specific instruction
overrides in a gitignored `CLAUDE.local.md` at the project root.

**Other conventions (workflow, not extracted to rules):**
- Prefer editing existing files over creating new ones.
- When adding or updating tests, use the `/test` command to ensure correct tier classification.
- A plain **local commit** (snapshot work in progress, protect changes before `/preview`) goes
  through `/commit`: it stages and commits on the current branch only, with no push and no
  rebase. A bare request to "commit" / "commit changes" means `/commit`, never `/merge-back`.
- **Landing changes goes through a PR by default.** The board drives it: the **Testing** column runs
  `/pull-request` (commit, conventional branch, push, create the PR, drive its CI checks to green),
  and the **Merge** column runs `/merge-pull-request` (merge the green PR, pull back to local
  `main`). For a deliberate direct quick-push that bypasses the PR gate (admin only - CI is down, a
  one-line hotfix), use `/merge-back`. Only push, land, or merge when the user explicitly asks.
- `/commit`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all write conventional-commit
  messages.
- `/sync-docs` keeps `docs/` aligned with source; the doc-anchor check runs inside `/pull-request`
  (commit time) and `/merge-pull-request` (merge time), and `/merge-back` for direct pushes.

### Authoring a rule

A new convention is one `.claude/rules/<kebab-name>.md` with a context paragraph, `## The rule`,
`## Enforcement (self-maintaining)` and `## Scope`. Give it `paths:` frontmatter unless it must
hold in every session (we run 4 always-on rules), name the strongest enforcement available, and add
its one-line pointer to the index above (`tests/unit/rules-index-parity.test.ts` checks it). Run
`node scripts/measure-rule-load.js` when you add a rule or widen a glob. The full procedure, the
read-trigger gap and why: [docs/contributing/authoring-rules.md](docs/contributing/authoring-rules.md).

**Linting:** `npm run lint` runs `eslint src/ --max-warnings 0` in CI
(`.github/workflows/ci.yml`), so ESLint rules (`no-explicit-any`, `no-require-imports`, etc.)
are enforced on every push. No warnings are tolerated: `--max-warnings 0` makes ANY warning
(including `react-hooks/exhaustive-deps`) fail the lint check, so warnings can never silently
accumulate. Fix a warning properly where the dependency is safe to add (stable refs, Zustand
actions) or restructure (wrap an unstable `?? {}`/`?? []` fallback in `useMemo`); only when an
omission is deliberate, suppress that one line with `// eslint-disable-next-line
react-hooks/exhaustive-deps -- <reason>` and a concrete reason. Use a `tests/unit/` check for
conventions ESLint cannot express (em-dashes, IPC and board-config parity, ...).

**This file has a size budget.** `tests/unit/rules-index-parity.test.ts` fails when CLAUDE.md
passes 40,000 characters, the point Claude Code warns at. It loads into every session and every
subagent's fixed floor, so when it grows, move the newest weight out instead of raising the
number: prescriptive content into a path-scoped `.claude/rules/*.md`, and background,
measurements, and rejected alternatives into `docs/`. Leave a pointer line behind.
