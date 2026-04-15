<p align="center">
  <a href="https://www.kangentic.com"><img src="resources/icon-256.png" alt="Kangentic Logo" width="128" /></a>
</p>

<h1 align="center"><a href="https://www.kangentic.com">Kangentic</a></h1>

<p align="center">
  <strong>Visual Agent Orchestration for Coding Agents</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="GitHub release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square" alt="Platform" />
  <a href="https://www.kangentic.com"><img src="https://img.shields.io/badge/website-kangentic.com-purple.svg?style=flat-square" alt="Website" /></a>
  <a href="https://www.youtube.com/watch?v=jviSrT47F0o"><img src="https://img.shields.io/badge/demo-YouTube-red.svg?style=flat-square&logo=youtube" alt="Demo Video" /></a>
  <a href="https://github.com/Kangentic/kangentic/stargazers"><img src="https://img.shields.io/github/stars/Kangentic/kangentic?style=social" alt="GitHub Stars" /></a>
</p>

---

<p align="center">One board for Claude Code, Codex CLI, Gemini CLI, Cursor CLI, GitHub Copilot CLI, Aider, and Oz CLI.</p>

<p align="center">Managing multiple coding agents across terminal tabs is chaotic. Kangentic replaces that with a drag-and-drop board where every column transition controls agent lifecycle automatically. Free to use, fully local, no accounts required.</p>

<p align="center">
  <a href="https://www.kangentic.com"><img src="resources/kanban-demo.png" alt="Kangentic Kanban Board" width="800" /></a>
</p>
<p align="center">
  <a href="https://www.youtube.com/watch?v=jviSrT47F0o"><img src="https://img.shields.io/badge/%E2%96%B6%20Watch%20Demo-YouTube-red.svg?style=for-the-badge&logo=youtube" alt="Watch Demo" /></a>
</p>

## Features

- **Visual agent orchestration** - drag tasks between columns to spawn, suspend, and resume agent sessions automatically
- **Git worktree isolation** - each agent works on its own branch in a dedicated checkout, no merge conflicts between parallel agents
- **Built-in terminals** - full xterm.js terminals with WebGL rendering, per-session tabs, and drag-to-resize panels
- **Session persistence** - close the app, reopen it, resume right where you left off via `--resume`
- **Real-time activity detection** - see which agents are thinking, idle, or waiting for input with live tool call tracking, token usage, cost, and context window utilization
- **Concurrent session management** - set a max number of parallel agents with automatic queuing and launch as slots open
- **Customizable board** - configure columns with custom names, colors, icons, permission modes, auto-spawn rules, and transition actions
- **Shareable team config** - commit `kangentic.json` to version control so the whole team shares the same board layout, columns, and actions
- **Custom shortcuts** - add one-click buttons for editors (VS Code, Cursor, Zed), git tools, file browsers, or any shell command with template variables like `{{cwd}}` and `{{branchName}}`
- **Configurable settings** - appearance (10 themes), terminal (font, cursor, scrollback, shell selection), agent behavior (permissions, idle timeout, concurrency), git (worktrees, base branch, init scripts), and notifications
- **100% local** - all data stays on your machine with no accounts, no cloud sync, and no telemetry by default
- **Free and open source** - no subscriptions, no usage limits, no paid tiers
- **Cross-platform** - native installers for Windows, macOS, and Linux with support for PowerShell, bash, zsh, fish, nushell, WSL, and cmd

## How It Works

1. **Add tasks** to your board, describing the work in plain text
2. **Drag a task** into an active column. Kangentic spawns an agent in an isolated git worktree.
3. **Watch progress** in the built-in terminal, or let it run and check back later
4. **Review and merge** when the agent finishes

## Supported Agents

Run any of these coding agent CLIs from a single Kanban board:

| Agent | Status |
|-------|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Supported |
| [Codex CLI](https://developers.openai.com/codex/cli) | Supported |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Supported |
| [Cursor CLI](https://cursor.com/docs/cli/overview) | Supported |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started) | Supported |
| [Aider](https://aider.chat/) | Supported |
| [Oz CLI](https://docs.warp.dev/reference/cli/cli) (Warp) | Supported |

## Import Sources

Bring issues and work items from your existing tools into the backlog:

| Source | Status |
|--------|--------|
| GitHub Issues | Supported |
| GitHub Projects | Supported |
| Azure DevOps | Supported |
| Asana | Coming soon |
| Jira | Coming soon |
| Linear | Coming soon |
| Trello | Coming soon |

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ (for npx)
- [Git 2.25+](https://git-scm.com/)
- At least one supported agent CLI (see [Supported Agents](#supported-agents))

## Setup

```bash
npx kangentic
```

One command to download, install, and launch. After the first run, auto-updates handle everything.

For more details, see the [Installation & Setup guide](https://www.kangentic.com/getting-started/).

## Documentation

Get started at [kangentic.com/getting-started](https://www.kangentic.com/getting-started/).

## Development

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure, testing, and code style.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. All contributors must sign a [CLA](CLA.md) before their first PR can be merged.

## Support

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) for questions and feature requests
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) for bug reports

## License

[AGPL-3.0](LICENSE). If AGPL doesn't work for you, drop us a line at licensing@kangentic.com.

---

<h4 align="center">Built with</h4>

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
