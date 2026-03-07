<p align="center">
  <img src="resources/icon-256.png" alt="Kangentic Logo" width="128" />
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Visual Agent Orchestration for Claude Code</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0 License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg" alt="Platform" />
  <a href="https://www.kangentic.com"><img src="https://img.shields.io/badge/website-kangentic.com-purple.svg" alt="Website" /></a>
</p>

---

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/xterm.js-000000?style=for-the-badge" alt="xterm.js" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright" />
</p>

---

One board to manage all your Claude Code agents. Drag tasks to spawn sessions, see real-time status, and ship work in parallel -- all from native terminals on your desktop.

<p align="center">
  <img src="resources/kanban-demo.png" alt="Kangentic Kanban Board" width="800" />
</p>

## Install

```bash
npx kangentic
```

One command to download, install, and launch. After the first run, auto-updates handle everything (Windows and macOS).

Or download directly from [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest):

| Platform | Download |
|----------|----------|
| Windows | [Kangentic Setup.exe](https://github.com/Kangentic/kangentic/releases/latest) |
| macOS | [Kangentic.dmg](https://github.com/Kangentic/kangentic/releases/latest) |
| Linux | [.deb](https://github.com/Kangentic/kangentic/releases/latest) / [.rpm](https://github.com/Kangentic/kangentic/releases/latest) |

See the [Installation Guide](docs/installation.md) for detailed instructions, prerequisites, and troubleshooting.

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH
- [Git 2.25+](https://git-scm.com/) for worktree support

### From Source

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm run dev
```

Requires Node.js 20+ and C++ build tools for native modules. See [Installation Guide](docs/installation.md#from-source) for details.

## Documentation

Full documentation at [kangentic.com/getting-started](https://www.kangentic.com/getting-started/) and in [`docs/`](docs/README.md).

## Why Kangentic?

AI coding agents can build features, fix bugs, and refactor entire modules autonomously. With git worktrees, you can run many of them in parallel and ship work at incredible speed.

But there's a new bottleneck: **you.** Five agents across three projects -- which ones are stuck waiting for approval? Which one just finished? Which branch has conflicts? Juggling terminals and context-switching between agents is exhausting, and it's exactly where the speed advantage breaks down.

**Kangentic is a command center for your coding agents.** One board shows every agent's status, output, and progress. Respond when needed, and let them work autonomously the rest of the time.

## Features

| | Feature | Description |
|---|---|---|
| 🎯 | **Agent Orchestration** | Drag tasks across your board to spawn, suspend, and resume Claude Code agents. Each card is a living agent session. |
| 📡 | **Real-Time Status** | See which agents are thinking, idle, or waiting -- right on the card. Get desktop notifications when an agent needs your attention. |
| 🖥️ | **Terminal & Activity Log** | A built-in terminal for every session, plus a structured activity log that shows what each agent is doing without the noise. |
| ⚙️ | **Customizable Workflows** | Set permission modes, auto-commands, and transition actions per column. Build pipelines like Plan, Execute, Review automatically. |
| 🌿 | **Git Worktrees** | Each agent runs in its own git worktree. Parallel development without branch conflicts, each with its own isolated working directory. |
| 💾 | **Session Persistence** | Sessions survive restarts and crashes. Suspend to Done, resume later with full context -- pick up right where you left off, even across reboots. |
| 🎨 | **Settings & Themes** | 10 built-in themes, global and per-project settings, and per-column customization for colors, icons, and behavior. |
| 🖥️ | **Cross-Platform & Local** | Runs entirely on your desktop -- Windows, macOS, Linux, and WSL. No cloud service, no data leaves your machine. |
| 🔓 | **Your Claude Code, Your Way** | No wrappers, no API proxies. Kangentic launches native Claude Code terminals -- your login, your subscription or API key. Just the real CLI. |

## How It Works

1. **Create a Task** -- Add a card with a title and prompt. Paste screenshots, choose a source branch, and toggle worktree isolation.
2. **Drag to Run** -- Drag the card to any active column. Kangentic creates a worktree, picks the permission mode, and spawns a Claude Code agent automatically.
3. **Agent Works** -- Monitor via the terminal, activity log, or card indicators. Drag between columns to inject auto-commands -- drag to Done to suspend and resume later.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. All contributors must sign a [CLA](CLA.md) before their first PR can be merged.

## License

Kangentic is open source under the [GNU Affero General Public License v3.0](LICENSE).

For organizations that need a commercial license (e.g., to keep proprietary modifications private), contact licensing@kangentic.com for licensing options.

Copyright (c) 2025-2026 VORPAHL LLC. All rights reserved.

## Anything Else?

Questions, feedback, or just want to say hi? Reach out at hello@kangentic.com.
