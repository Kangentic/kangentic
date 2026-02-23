# Kangentic

Cross-platform desktop Kanban for Claude Code agents.

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
    engine/       # Transition engine (skill execution)
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
3. Transition engine checks for skills attached to that lane transition
4. `spawn_agent` skill builds a Claude CLI command and spawns a PTY session
5. Terminal output streams to renderer via IPC

### Key Patterns
- **IPC channels** defined in `src/shared/ipc-channels.ts` — single source of truth
- **Stores** use Zustand with IPC bridge: renderer store calls `window.electronAPI.*`, main process handles via `ipcMain.handle`
- **Icons** use Lucide React — no inline SVGs
- **PTY sessions** handle cross-platform shells (PowerShell needs `& ` prefix, WSL splits into exe + args, fish/nushell skip `--login`)
- **Claude CLI** is invoked with `cwd` set to the project directory (or worktree path) so that `.claude/`, `CLAUDE.md`, and skills are loaded into context

### Database
- Global DB (`~/.kangentic/kangentic.db`) for projects list
- Per-project DB (`<project>/.kangentic/project.db`) for tasks, swimlanes, skills, sessions
- Migrations run automatically on open

### Testing
- All tests use Playwright's `_electron.launch()` for real Electron E2E
- Tests run headless (`show: false` when `NODE_ENV=test`)
- Shell-parameterized tests run for all detected terminals (WSL, PowerShell, bash, cmd, etc.)
- Build required before tests: `npm run build && npm test`

## Conventions

- TypeScript strict mode
- Single-command bash calls only (no `&&`, `||`, `|`, `;` chaining)
- Prefer editing existing files over creating new ones
- Use `data-testid` and `data-swimlane-name` attributes for test selectors
- All dialogs use global `useEffect` Escape key listener
