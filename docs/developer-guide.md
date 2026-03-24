# Developer Guide

## Prerequisites

- Node.js 22+
- Git 2.25+ (worktree support)
- Platform-specific:
  - **Windows:** Visual Studio Build Tools (for better-sqlite3 native compilation)
  - **macOS:** Xcode Command Line Tools
  - **Linux:** `build-essential`, `python3`

## Quick Start

```bash
npm install
npm run dev
```

The dev server starts Vite (renderer HMR), esbuild (main/preload watch), and launches Electron.

## Project Structure

```
src/
  main/                    # Electron main process (Node.js)
    agent/                 # Claude CLI command building, bridge scripts, hook management
      claude-detector.ts   # Locates Claude CLI on PATH, caches result
      claude-status-parser.ts # Parses Claude status line output
      command-bridge.ts    # File-based command queue between MCP server and Electron
      command-builder.ts   # Builds claude CLI invocations
      commands/            # Extracted command handlers (used by command-bridge)
        types.ts           # CommandContext, CommandResponse, CommandHandler interfaces
        column-resolver.ts # Shared column name -> swimlane lookup
        task-commands.ts   # create_task, update_task
        inventory-commands.ts # list_columns, list_tasks
        search-commands.ts # search_tasks, find_task
        analytics-commands.ts # get_task_stats, board_summary, session_history, column_detail
        backlog-commands.ts # list_backlog, create_backlog_item, search_backlog, promote_backlog
        index.ts           # Barrel + command handler registry
      git-detector.ts      # Detects git installation and version
      hook-manager.ts      # Injects/strips Kangentic hooks from Claude settings
      mcp-server.ts        # Stdio MCP server for Claude Code agents
      trust-manager.ts     # Pre-populates ~/.claude.json trust entries for worktrees
      status-bridge.js     # Hook script: writes usage data to status.json
      event-bridge.js      # Hook script: appends tool events to events.jsonl
    config/
      config-manager.ts    # Three-tier config: global -> project overrides -> effective
      board-config-manager.ts # Board config (kangentic.json) export, import, reconciliation
    db/                    # SQLite database layer
      database.ts          # DB initialization, WAL mode, connection caching
      migrations.ts        # Barrel re-export (auto-run on open)
      migrations/
        global-schema.ts   # Global DB schema + migrations
        project-schema.ts  # Per-project DB schema + migrations
        default-data.ts    # Default swimlanes, actions, transitions
      repositories/        # One class per table, synchronous queries
        action-repository.ts
        attachment-repository.ts
        project-group-repository.ts
        project-repository.ts
        session-repository.ts
        swimlane-repository.ts
        task-repository.ts
    engine/                # Transition engine and session recovery
      command-injector.ts  # Deferred PTY command injection for auto_command
      resource-cleanup.ts  # Task resource cleanup (session, worktree, files)
      session-paths.ts     # Session directory path utilities
      session-recovery.ts  # Orphan detection, dedup, resume on app relaunch
      transition-engine.ts # Executes action chains on swimlane transitions
    git/
      worktree-manager.ts  # Worktree creation, sparse-checkout, cleanup
    ipc/
      register-all.ts      # Thin orchestrator, creates IpcContext, re-exports
      ipc-context.ts       # Shared IpcContext interface
      helpers.ts           # Shared helper functions (ensureGitignore, getProjectRepos, etc.)
      handlers/
        board.ts           # Swimlane, Action, Transition, Attachment CRUD
        projects.ts        # PROJECT_* handlers, cleanupProject, openProjectByPath
        session-metrics.ts # Session summary and metrics aggregation
        sessions.ts        # SESSION_* handlers, PTY event listeners
        system.ts          # Config, Claude, Shell, Git, Dialog, Window, Notifications
        task-branch.ts     # TASK_SWITCH_BRANCH handler
        task-crud.ts       # TASK_LIST, CREATE, UPDATE, DELETE, archive handlers
        task-move.ts       # TASK_MOVE handler with priority rules
        tasks.ts           # Task handler orchestrator, bulk operations
    pty/                   # Terminal session management
      pty-buffer-manager.ts # Output buffering, scrollback ring buffer (512KB)
      session-file-watcher.ts # fs.watch for status.json and events.jsonl
      session-manager.ts   # PTY spawn, output streaming, lifecycle
      session-queue.ts     # Concurrency limiter with reentrancy-safe promotion
      shell-resolver.ts    # Cross-platform shell detection
      usage-tracker.ts     # Token usage, activity state, idle timeout, event capping
  preload/
    preload.ts             # Context bridge (window.electronAPI)
  renderer/                # React UI
    components/
      board/               # Kanban board, columns, task cards, drag-and-drop
      dialogs/             # Settings, task detail, project management
      layout/              # App shell, sidebar, title bar, status bar
      terminal/            # xterm integration, activity log
    hooks/
      useTerminal.ts       # xterm lifecycle, resize, scrollback restoration
    stores/                # Zustand state management
      board-store.ts       # Tasks, swimlanes, optimistic updates
      session-store.ts     # PTY sessions, usage, activity, events
      config-store.ts      # App config, Claude detection, theme
      project-store.ts     # Project CRUD
      toast-store.ts       # Notification queue
  shared/                  # Shared between main and renderer
    types.ts               # All TypeScript interfaces
    ipc-channels.ts        # IPC channel constants (single source of truth)
    paths.ts               # Path utilities, shell adaptation
tests/
  unit/                    # Vitest -- pure logic, no browser
  ui/                      # Playwright + headless Chromium -- mock electronAPI
  e2e/                     # Playwright + real Electron -- opens windows
  fixtures/                # Mock Claude CLI, test helpers
scripts/
  dev.js                   # Development server (Vite + esbuild + Electron)
  build.js                 # Production build pipeline
  worktree-preview.js      # Opens native terminal for worktree dev server
```

## Build System

### Development (`npm run dev` / `scripts/dev.js`)

Three parallel processes:

1. **Vite dev server** -- serves renderer with HMR on port 5173 (5174+ in worktrees)
2. **esbuild watch** -- bundles `src/main/index.ts` → `.vite/build/index.js` and `src/preload/preload.ts` → `.vite/build/preload.js`
3. **Electron** -- launched with `MAIN_WINDOW_VITE_DEV_SERVER_URL` pointing to Vite

Native modules (`better-sqlite3`, `node-pty`, `simple-git`) are marked external in esbuild -- loaded at runtime from `node_modules`.

Flags:
- `--port=<n>` -- override Vite port
- `--ephemeral` -- isolated data directory, auto-cleaned on exit (used for worktree previews)

### Production (`npm run build` / `scripts/build.js`)

1. `tsc --noEmit` (type check)
2. Vite builds renderer → `.vite/build/renderer/main_window/`
3. esbuild bundles main + preload (minified)
4. Copies bridge scripts (`status-bridge.js`, `event-bridge.js`) to `.vite/build/`

### Worktree Dev

In worktrees, `dev.js` bypasses `vite.config.mts` and creates an inline Vite config. This avoids pattern-matching issues where `.kangentic/**` in the watch ignore would match the worktree's own path.

`scripts/worktree-preview.js` creates a `node_modules` junction/symlink from the worktree to the repo root, then opens a native terminal running the dev server.

## Testing

Three tiers. Use the right one for the job.

### Unit Tests (`tests/unit/`)

```bash
npm run test:unit
```

- **Runner:** Vitest
- **Speed:** Sub-second
- **What to test here:** Pure logic -- parsers, filters, state machines, utility functions
- **No build needed**, no browser, no Electron

### UI Tests (`tests/ui/`)

```bash
npx playwright test --project=ui
```

- **Runner:** Playwright with headless Chromium
- **Speed:** ~13s for 72 tests
- **What to test here:** React components, forms, dialogs, drag-and-drop, board interactions
- **No build needed** -- runs against Vite dev server (auto-started by Playwright)
- **Mock:** `tests/ui/mock-electron-api.js` injects a full in-memory mock of `window.electronAPI` via `addInitScript()`. Supports full CRUD for projects, tasks, swimlanes, actions, sessions, config, attachments.
- **Pre-configure:** `window.__mockPreConfigure(fn)` lets tests set up mock state before React mounts

### E2E Tests (`tests/e2e/`)

```bash
npm run build
npx playwright test --project=electron
```

- **Runner:** Playwright with `_electron.launch()`
- **Speed:** Slower, opens real windows (no headless mode on Windows)
- **What to test here:** PTY sessions, terminal rendering, session lifecycle, shell detection, config persistence
- **Build required** before running

### Decision Guide

| What you're testing | Tier |
|---------------------|------|
| Pure function, parser, utility | Unit |
| Component rendering, user interaction, form validation | UI |
| Real IPC, PTY spawning, terminal output, file I/O | E2E |

### Run All

```bash
npx playwright test              # UI + E2E
npm run test:unit                 # Unit (separate runner)
```

## Adding Features

### New IPC Channel

1. Add channel constant to `src/shared/ipc-channels.ts`
2. Add handler in the appropriate `src/main/ipc/handlers/*.ts` module
3. Add method to `ElectronAPI` interface in `src/shared/types.ts`
4. Add bridge method in `src/preload/preload.ts`
5. Call from renderer via `window.electronAPI.domain.method()`
6. Extend `tests/ui/mock-electron-api.js` if UI tests need it

### New Zustand Store

1. Create `src/renderer/stores/my-store.ts`
2. Use `create<State>()` pattern
3. Bridge to IPC in actions: `const result = await window.electronAPI.domain.method()`
4. Import in components: `const value = useMyStore(s => s.value)`

### New Component

1. Add to appropriate `src/renderer/components/` subdirectory
2. Use `data-testid` attributes for test selectors
3. Use Lucide React for icons (no inline SVGs)
4. Dialogs: use `useEffect` Escape key listener

### New Test

- Pure logic → `tests/unit/`
- UI interaction → `tests/ui/`
- Needs real Electron backend → `tests/e2e/`

## Conventions

- **TypeScript strict mode** -- `noImplicitAny` enabled
- **No `any` types** -- use proper types from `src/shared/types.ts`, `unknown` with type guards, or generic constraints
- **Icons** -- Lucide React only, no inline SVGs
- **Test selectors** -- `data-testid` and `data-swimlane-name` attributes
- **Escape key** -- all dialogs use global `useEffect` listener
- **IPC channels** -- `src/shared/ipc-channels.ts` is the single source of truth

## Environment Variables

| Variable | Context | Purpose |
|----------|---------|---------|
| `KANGENTIC_DATA_DIR` | Runtime/Test | Override per-project data directory path |
| `VITE_PORT` | Dev | Explicit Vite port (enables external server reuse) |
| `PLAYWRIGHT_VITE_PORT` | Test | Port passed to Playwright's webServer |
| `HEADED` | Test | Set to `1` for visible Electron windows in E2E |
| `NODE_ENV` | Build | `development` or `production` |
| `MAIN_WINDOW_VITE_DEV_SERVER_URL` | Dev | Injected by esbuild, points Electron to Vite |
| `MAIN_WINDOW_VITE_NAME` | Build | Renderer output directory name (`main_window`) |

## Further Reading

- [Architecture](architecture.md) -- Process model, data flow, IPC channels, stores
- [Session Lifecycle](session-lifecycle.md) -- State machine, spawn flow, queue, suspend, resume
- [Transition Engine](transition-engine.md) -- Action types, templates, execution flow
- [Database](database.md) -- Full schema reference, migrations, connection management
- [Claude Integration](claude-integration.md) -- CLI detection, command building, hooks, trust
- [Configuration](configuration.md) -- Config cascade, all settings keys, permission modes
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging, fuses
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery
- [User Guide](user-guide.md) -- End-user feature walkthrough

## Documentation Maintenance

Run `/update-docs` to review and update documentation after code changes. This command:
- Maps changed source files to affected docs using the source-to-doc mapping in `.claude/skills/docs-maintenance/SKILL.md`
- Checks for stale facts (schema, config keys, constants, types)
- Updates docs in-place and reports what changed

This runs automatically as part of `/merge-back` (Step 4.5). To run manually: `/update-docs`.

## Packaging

electron-builder handles platform-specific packaging via `electron-builder.yml`:

| Platform | Format | Builder |
|----------|--------|---------|
| Windows | Installer | NSIS |
| macOS | Disk image + ZIP | DMG |
| Linux | Package | deb, rpm |

Native modules:
- `better-sqlite3` -- rebuilt against Electron headers via `scripts/rebuild-native.js`
- `node-pty` -- uses prebuilt NAPI binaries, no rebuild needed

Security fuses enabled: no RunAsNode, no NodeOptions, no inspection, cookie encryption, ASAR integrity validation.

```bash
npm run package    # Package for current platform
npm run make       # Create distributable
npm run publish    # Publish to GitHub (draft release)
```
