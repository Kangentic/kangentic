# Kangentic

Cross-platform desktop Kanban for Claude Code agents.

Drag tasks between columns to spawn, suspend, and resume Claude Code sessions automatically. Each task gets its own terminal, worktree, and conversation history that persists across app restarts.

## Features

- **Visual agent orchestration** — Drag tasks to Planning or Running columns to spawn Claude Code agents. Drag them back to suspend and later resume with full conversation context.
- **Session persistence** — Agent sessions survive app restarts. Close the app and reopen — your Claude conversations resume exactly where they left off via `--resume`.
- **Git worktrees** — Each task optionally gets its own worktree branch, so multiple agents work in parallel without merge conflicts.
- **Concurrent session management** — Configure max concurrent sessions. Excess tasks queue automatically and promote when slots open.
- **Skill-based transitions** — Attach skills to column transitions: spawn agents, send commands, run scripts, fire webhooks, manage worktrees.
- **Cross-platform** — Windows (Squirrel), macOS (DMG), Linux (deb/rpm). Terminal adapts to PowerShell, bash, zsh, fish, WSL, cmd, and more.
- **Real-time terminal** — xterm.js rendering with scrollback, resize, and per-session tabs in a bottom panel.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH

### Install & Run

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm run dev
```

### Build for Production

```bash
npm run build        # Compile to .vite/build/
npm run package      # Package for distribution
```

### CLI

Open a project directly from the terminal:

```bash
kgnt open            # Open the current directory
kgnt open /path/to   # Open a specific project path
```

## Architecture

```
src/
  main/           # Electron main process
    agent/        # Claude CLI detection, command building, trust management
    db/           # SQLite (better-sqlite3), migrations, repositories
    engine/       # Transition engine (skill execution), session recovery
    git/          # Worktree manager
    ipc/          # IPC handler registration
    pty/          # PTY session manager (node-pty), shell resolver
  renderer/       # React UI
    components/   # Board, dialogs, layout, terminal, sidebar
    stores/       # Zustand stores (board, config, project, session)
  shared/         # Types, IPC channels, path utilities
```

### Data Flow

1. User drags a task between columns (swimlanes)
2. `TASK_MOVE` IPC handler fires in the main process
3. Transition engine checks for skills attached to that column transition
4. `spawn_agent` skill builds a Claude CLI command and spawns a PTY session
5. Terminal output streams to the renderer via IPC
6. Moving a task out of an agent column suspends the session (preserving the conversation ID)
7. Moving it back resumes with `--resume`, restoring full Claude context

### Database

- **Global DB** (`~/.kangentic/kangentic.db`) — project list
- **Per-project DB** (`<project>/.kangentic/project.db`) — tasks, swimlanes, skills, sessions
- Migrations run automatically on project open

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 40, Node 20 |
| Frontend | React 19, Zustand, Tailwind CSS 4, Lucide React |
| Backend | better-sqlite3, node-pty, simple-git |
| Build | Electron Forge + Vite (renderer), esbuild (main/preload) |
| Testing | Playwright with Electron support |
| Package | Squirrel (Windows), DMG (macOS), deb/rpm (Linux) |

## Testing

All tests are Playwright E2E tests running against real Electron:

```bash
npm run build        # Build required before tests
npm test             # Run all tests
npm run test:headed  # Run with visible window
```

Tests use a mock Claude CLI (`tests/fixtures/mock-claude`) for CI. Test data is isolated via `KANGENTIC_DATA_DIR` so tests never touch user data.

## Documentation

Full documentation in [`docs/`](docs/README.md):

- [Overview](docs/overview.md) -- Product overview and key features
- [User Guide](docs/user-guide.md) -- End-user walkthrough
- [Architecture](docs/architecture.md) -- Process model, data flow, IPC channels
- [Developer Guide](docs/developer-guide.md) -- Setup, build, testing, conventions
- [Session Lifecycle](docs/session-lifecycle.md) -- State machine, spawn, queue, resume
- [Configuration](docs/configuration.md) -- All settings keys and config cascade
- [Claude Integration](docs/claude-integration.md) -- CLI commands, hooks, trust
- [Transition Engine](docs/transition-engine.md) -- Action types and execution flow
- [Database](docs/database.md) -- Schema, migrations, repository pattern
- [Cross-Platform](docs/cross-platform.md) -- Shell resolution, packaging, fuses
- [Worktree Strategy](docs/worktree-strategy.md) -- Branch naming, sparse-checkout
- [Activity Detection](docs/activity-detection.md) -- Event pipeline, thinking/idle state

## License

MIT
