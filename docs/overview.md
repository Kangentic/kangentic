# Kangentic - Product Overview

## What is Kangentic?

Kangentic is a cross-platform desktop Kanban application purpose-built for orchestrating AI coding agents. It supports Claude Code, Codex CLI, Gemini CLI, Cursor CLI, GitHub Copilot CLI, Aider, and Oz CLI (Warp). Dragging a task card between columns can spawn, suspend, resume, or terminate agent sessions - turning a familiar Kanban workflow into a powerful multi-agent control plane.

## The Problem

Working with multiple AI coding agent sessions simultaneously is difficult. Developers juggle terminal tabs, manually start and stop sessions, lose track of which agent is working on what, and struggle to coordinate parallel work across branches. When switching between different agent CLIs, context is lost entirely. There is no visual layer for managing agent lifecycle at scale.

## The Solution

Kangentic replaces terminal tab chaos with a drag-and-drop board. Each task card represents a unit of work. Moving a card into a column triggers configurable actions - spawning an agent, sending it a command, suspending it, or tearing it down. Different columns can use different agents, and context is automatically handed off when a task moves between agents. The board becomes the single interface for seeing what every agent is doing and controlling what happens next.

## Key Features

### Multi-Agent Support

Orchestrate Claude Code, Codex CLI, Gemini CLI, Cursor CLI, GitHub Copilot CLI, Aider, and Oz CLI (Warp) from a single board. Set a default agent per project, or override it per column. When a task moves between columns with different agents, Kangentic automatically packages the outgoing agent's context (transcript, git changes, metrics) and hands it off to the incoming agent. No manual copy-paste between tools.

### Visual Agent Orchestration

Drag a task card into an active column to spawn an agent. Drag it to Done to terminate the session. Drag it back to To Do to suspend. Every column transition is an orchestration event.

### Backlog & Import

Stage tasks in a backlog before promoting them to the board. Import issues from GitHub Issues, GitHub Projects, and Azure DevOps with full metadata (descriptions, labels, attachments, comments). Multi-select items for bulk operations, drag to reorder, and right-click for context menus. See the [User Guide](user-guide.md#backlog) for details.

### Board Filtering & Search

Filter board tasks by priority level and label using the filter popover. A search bar (toggle with Ctrl+F / Cmd+F) filters tasks by title or description across all columns. Active filters show a count badge and can be cleared with one click.

### Markdown Descriptions

Task descriptions support full Markdown rendering with GitHub Flavored Markdown (tables, task lists, strikethrough). Links open in the default browser. Markdown is rendered in the task detail dialog and on completed task summaries.

### File Attachments

Paste or drag-and-drop any file type onto a task as an attachment - not limited to images. Drag files from your file manager onto the terminal to insert the file path directly into the active session.

### Shareable Board Configuration

Teams commit a `kangentic.json` file to share column layout, colors, icons, actions, and transitions across all collaborators. Personal overrides live in `kangentic.local.json` (auto-gitignored). Live file watching detects when a teammate pushes changes and offers to reconcile them into your board.

### Session Persistence

Claude Code sessions survive application restarts. Kangentic uses `--resume` to reconnect to existing sessions, so agents pick up exactly where they left off. No lost context, no repeated work. Sessions paused manually by the user (via the pause button) stay paused on relaunch, respecting user intent. Only system-suspended sessions auto-resume.

### Git Worktrees

Each task can optionally get its own git worktree and branch. Multiple agents work in parallel on separate branches without conflicts, and Kangentic manages the worktree lifecycle automatically.

### Concurrent Session Management

Set a maximum number of concurrent agent sessions. When the limit is reached, new tasks are automatically queued and launched as slots open up.

### Skill-Based Transitions

Attach actions to any column transition: spawn agents, send commands, run shell scripts, fire webhooks, or manage worktrees. Transitions are fully configurable per board, making Kangentic adaptable to any workflow.

### Cross-Platform

Native installers for Windows (NSIS), macOS (DMG), and Linux (deb/rpm). Kangentic adapts to the local shell environment - PowerShell, bash, zsh, fish, nushell, WSL, and cmd are all supported.

### Real-Time Terminal

Embedded xterm.js terminals with WebGL acceleration, full scrollback, resize support, and per-session tabs. Watch agent output live or review history at any time.

### Activity Detection

Real-time thinking and idle status indicators powered by Claude Code hooks. See at a glance which agents are actively working, which are waiting for input, and which are idle.

### Configurable Context Bar

The context bar below each terminal displays session metadata: shell, CLI version, model, cost, tokens, and context window usage. Each element can be toggled on or off in settings.

### Settings Search

A built-in search bar filters settings by keyword with multi-token matching, grouped results by tab, and match count badges. Find any setting instantly across all tabs.

### Multiple Themes

Ten built-in themes: Dark, Light, Moon, Forest, Ocean, Ember, Sand, Mint, Sky, and Peach.

## How It Works

1. **Create a board** with columns representing your workflow stages (To Do, In Progress, Review, Done, or any custom stages).
2. **Add task cards** describing units of work - features, bugs, refactors. Create them directly on the board, stage them in the backlog, or import them from GitHub Issues, GitHub Projects, or Azure DevOps.
3. **Drag a card** into an active column. Kangentic spawns a Claude Code CLI session, passes it the task description as a prompt, and begins streaming terminal output.
4. **Monitor progress** via the embedded terminal, activity indicators, and board-level status at a glance. Filter by priority or label to focus on what matters.
5. **Drag the card forward** through your workflow. Each transition can trigger additional actions - commands, scripts, webhooks.
6. **Drag to Done** to complete and terminate the session, or back to To Do to suspend it for later.

## What Kangentic Is Not

- **Not a task tracker.** It is not Jira, Linear, or Trello. There are no sprints, story points, or grooming features. The board exists to control agents, not to manage project management metadata.
- **Not a CI system.** It does not run pipelines, deploy artifacts, or manage environments. It orchestrates interactive Claude Code sessions on your local machine.
- **Not a wrapper around a web API.** Kangentic works with agent CLIs directly. It spawns real terminal sessions with full PTY support.

Kangentic is an **agent orchestration desktop app** - a visual control surface for running multiple AI coding agents in parallel.

## Tech Stack

| Layer        | Technology                                      |
| ------------ | ----------------------------------------------- |
| Runtime      | Electron 41, Node 24                            |
| Frontend     | React 19, Zustand, Tailwind CSS 4, Lucide icons |
| Backend      | better-sqlite3, node-pty, simple-git             |
| Build        | Vite (renderer), esbuild (main), electron-builder |
| Testing      | Playwright (E2E + UI), Vitest (unit)              |
| Distribution | NSIS (Windows), DMG (macOS), deb/rpm (Linux)      |

## Target Audience

Kangentic is built for developers who use AI coding agents and want to run multiple agents concurrently with visual oversight. Whether you are parallelizing feature work across branches, running review agents alongside coding agents, handing off between Claude Code and Codex mid-task, or simply want a better interface than a wall of terminal tabs - Kangentic gives you a board to see and control it all.
