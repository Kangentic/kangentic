<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic Logo" width="128" /></a>
</p>

<h1 align="center"><a href="https://www.kangentic.com">Kangentic</a></h1>

<p align="center">
  <strong>Drag a card. An agent starts.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="GitHub release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square" alt="Platform" />
  <a href="https://www.kangentic.com"><img src="https://img.shields.io/badge/website-kangentic.com-purple.svg?style=flat-square" alt="Website" /></a>
  <a href="https://github.com/Kangentic/kangentic/stargazers"><img src="https://img.shields.io/github/stars/Kangentic/kangentic?style=social" alt="GitHub Stars" /></a>
</p>

---

<p align="center">A Kanban board for AI coding agents. Spawn, suspend, and resume sessions across fourteen agent CLIs from one board, with your own backlog. Local, free, open source. One board shows every agent's status, output, and progress: respond when needed, and let them work autonomously the rest of the time.</p>

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/mobile/android-feature-graphic-1024x500.png" alt="Kangentic: Kanban board for AI coding agents" width="800" /></a>
</p>

<p align="center"><em>If Kangentic saves you time, hit ⭐ at the top of this page so others can find it.</em></p>

## Features

- **Customizable workflows** - build pipelines like Plan, Execute, Review, with permission modes, auto-commands, plan-exit targets, entry prompts, and exit scripts or PRs set per column.
- **Real-time status** - see which agents are thinking or idle right on the card, via native hooks where available and PTY fallbacks where not, with desktop notifications when one needs you.
- **Agent Monitor** - one overlay watches every project on your machine: live and recently finished sessions as cards, a table, or a dense list, each with a peek at the agent's latest output.
- **Usage & cost analytics** - tokens, cost, and burn rate by project, agent, model, and effort, over any time range, down to a per-project ledger with cost share and dollars per million tokens.
- **Git worktrees & review** - each agent runs in its own worktree, so parallel work never collides. The built-in Changes panel opens a split or inline diff with file tree and commit graph, one click from the card.
- **Session persistence** - session data is written incrementally, so even a hard crash loses nothing. On relaunch running agents auto-resume with full context, and sessions you paused stay paused.
- **Handoff context** - move a card from a Claude plan column to a Codex execute column and the next agent starts with the full history. Both directions for Claude, Codex, Gemini, Antigravity, Qwen, Kimi, Grok, and OpenCode.
- **Model & effort routing** - Opus at xhigh for Planning, Sonnet for Executing, another agent for review. Save ladders as named Board Profiles; Kangentic applies them live as cards cross columns.
- **Project & global settings** - every project carries its own agent, model, effort, permission mode, base branch, and worktree defaults, separate from machine-wide ones, in a searchable settings panel.
- **Backlog, labels & priorities** - stage work before it hits the board, tag it with custom labels and a fully-customizable priority scale, and batch-promote in one move. The tags keep working as board filters afterward.
- **Agent-to-board tools** - every session gets MCP tools to create tasks, move cards, add columns, search prior sessions, and even message another task's running agent, so agents self-organize.
- **Quick Find & memory** - Ctrl+Shift+F / Cmd+Shift+F searches tasks, backlog, session events, projects, and every past agent conversation, by keyword or on-device semantic memory. No API key.
- **Terminal & activity log** - a real xterm.js terminal per session with WebGL rendering, scrollback that survives restarts, and clipboard image paste, plus an Activity tab that distills output into a structured event feed.
- **Command Terminal** - Ctrl+Shift+P / Cmd+Shift+P opens an ephemeral agent session over any board, no task card needed. Run up to four tiled side by side, with a layout that persists across projects and restarts.
- **Context Bar** - a live strip under every terminal: model, cost, tokens, tool calls, elapsed time, context-window fraction, and Claude rate-limit meters. The profile, model, and effort pills double as pickers.
- **Embedded browser** - point a sandboxed Chromium pane at any URL inside the task dialog, annotate it, and send the frame to the agent. Agents can screenshot, inspect, and click the same pane through MCP.
- **Voice dictation** - hold your push-to-talk button, talk, release: on-device speech-to-text drops your words wherever you are focused, a text field or the agent's terminal, with a streaming preview and a refinement pass.
- **Your CLIs, your machine** - runs on your desktop (Windows, macOS, Linux, and WSL) with your data in a local database. No OAuth, no wrappers, no API proxies: Kangentic launches the native CLIs you already have, with your own logins and subscriptions.

## How It Works

1. **Create a task** - add a card with a title and prompt. Paste screenshots, choose a source branch, and toggle worktree isolation, all from the create dialog.
2. **Drag to run** - drag the card to any active column. Kangentic creates a worktree, picks the permission mode, and spawns your chosen agent automatically. Columns ship preconfigured, To Do through Done; reshape the pipeline, agents, and permissions per column anytime.
3. **Watch it code** - your agent starts writing immediately. Follow along in the live terminal: see diffs, test results, and tool calls as they happen. Drag between columns to steer, or drag to Done to pause and pick up later.

## Supported Agents

Fourteen coding-agent CLIs, all first-class, on one Kanban board. Mix agents per column and hand off context between them:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://developers.openai.com/codex/cli) (OpenAI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Google)
- [Antigravity CLI](https://antigravity.google/docs/cli/getting-started) (Google)
- [Qwen Code](https://github.com/QwenLM/qwen-code) (Alibaba)
- [Kimi Code](https://github.com/MoonshotAI/kimi-cli) (Moonshot AI)
- [Grok Build](https://github.com/xai-org/grok-build) (xAI)
- [OpenCode](https://opencode.ai/docs) (sst)
- [Droid](https://docs.factory.ai/cli/getting-started/overview) (Factory)
- [Cursor CLI](https://cursor.com/docs/cli/overview)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)
- [Aider](https://aider.chat/)
- [Oz CLI](https://docs.warp.dev/reference/cli/cli) (Warp)
- [Ollama](https://ollama.com) (local models)

## Supported Boards

Bring your own backlog. Pull tasks in from the tools your team already uses, including titles, descriptions, labels, and inline images. Already-imported items are detected automatically so re-syncing is safe:

| Board | Status |
|-------|--------|
| GitHub Issues | Supported |
| GitHub Projects | Supported |
| Azure DevOps | Supported |
| Asana | Supported |
| Jira | Coming soon |
| Linear | Coming soon |
| Trello | Coming soon |
| GitLab | Coming soon |
| Obsidian | Coming soon |

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

Building from source requires Node.js 22+ (the npx floor above is for end users running the
launcher).

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure, testing, and conventions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. All contributors must sign a [CLA](CLA.md) before their first PR can be merged.

## Support

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) for questions and feature requests
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) for bug reports
- [support@kangentic.com](mailto:support@kangentic.com) if you would rather not post publicly

Found a security issue? See [SECURITY.md](SECURITY.md) instead.

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

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/brandmark-small.svg" alt="Kangentic app icon" width="26" height="26" /></a>
</p>
