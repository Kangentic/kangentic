# Kangentic -- Product Overview

## What is Kangentic?

Kangentic is a cross-platform desktop Kanban application purpose-built for orchestrating Claude Code CLI agents. It gives developers a visual board where dragging a task card between columns can spawn, suspend, resume, or terminate Claude Code sessions -- turning a familiar Kanban workflow into a powerful agent control plane.

## The Problem

Working with multiple Claude Code CLI sessions simultaneously is difficult. Developers juggle terminal tabs, manually start and stop sessions, lose track of which agent is working on what, and struggle to coordinate parallel work across branches. There is no visual layer for managing agent lifecycle at scale.

## The Solution

Kangentic replaces terminal tab chaos with a drag-and-drop board. Each task card represents a unit of work. Moving a card into a column triggers configurable actions -- spawning a Claude Code agent, sending it a command, suspending it, or tearing it down. The board becomes the single interface for seeing what every agent is doing and controlling what happens next.

## Key Features

### Visual Agent Orchestration

Drag a task card into an active column to spawn a Claude Code agent. Drag it to Done to terminate the session. Drag it back to Backlog to suspend. Every column transition is an orchestration event.

### Session Persistence

Claude Code sessions survive application restarts. Kangentic uses `--resume` to reconnect to existing sessions, so agents pick up exactly where they left off -- no lost context, no repeated work.

### Git Worktrees

Each task can optionally get its own git worktree and branch. Multiple agents work in parallel on separate branches without conflicts, and Kangentic manages the worktree lifecycle automatically.

### Concurrent Session Management

Set a maximum number of concurrent agent sessions. When the limit is reached, new tasks are automatically queued and launched as slots open up.

### Skill-Based Transitions

Attach actions to any column transition: spawn agents, send commands, run shell scripts, fire webhooks, or manage worktrees. Transitions are fully configurable per board, making Kangentic adaptable to any workflow.

### Cross-Platform

Native installers for Windows (Squirrel), macOS (DMG), and Linux (deb/rpm). Kangentic adapts to the local shell environment -- PowerShell, bash, zsh, fish, nushell, WSL, and cmd are all supported.

### Real-Time Terminal

Embedded xterm.js terminals with WebGL acceleration, full scrollback, resize support, and per-session tabs. Watch agent output live or review history at any time.

### Activity Detection

Real-time thinking and idle status indicators powered by Claude Code hooks. See at a glance which agents are actively working, which are waiting for input, and which are idle.

### Multiple Themes

Ten built-in themes: Dark, Light, Moon, Forest, Ocean, Ember, Sand, Mint, Sky, and Peach.

## How It Works

1. **Create a board** with columns representing your workflow stages (Backlog, In Progress, Review, Done, or any custom stages).
2. **Add task cards** describing units of work -- features, bugs, refactors.
3. **Drag a card** into an active column. Kangentic spawns a Claude Code CLI session, passes it the task description as a prompt, and begins streaming terminal output.
4. **Monitor progress** via the embedded terminal, activity indicators, and board-level status at a glance.
5. **Drag the card forward** through your workflow. Each transition can trigger additional actions -- commands, scripts, webhooks.
6. **Drag to Done** to complete and terminate the session, or back to Backlog to suspend it for later.

## What Kangentic Is Not

- **Not a task tracker.** It is not Jira, Linear, or Trello. There are no sprints, story points, or backlog grooming features. The board exists to control agents, not to manage project management metadata.
- **Not a CI system.** It does not run pipelines, deploy artifacts, or manage environments. It orchestrates interactive Claude Code sessions on your local machine.
- **Not a wrapper around a web API.** Kangentic works with the Claude Code CLI directly. It spawns real terminal sessions with full PTY support.

Kangentic is an **agent orchestration desktop app** -- a visual control surface for running multiple Claude Code agents in parallel.

## Tech Stack

| Layer        | Technology                                      |
| ------------ | ----------------------------------------------- |
| Runtime      | Electron 40, Node 20                            |
| Frontend     | React 19, Zustand, Tailwind CSS 4, Lucide icons |
| Backend      | better-sqlite3, node-pty, simple-git             |
| Build        | Electron Forge + Vite (renderer), esbuild (main) |
| Testing      | Playwright (E2E + UI), Vitest (unit)             |
| Distribution | Squirrel (Windows), DMG (macOS), deb/rpm (Linux) |

## Target Audience

Kangentic is built for developers who use Claude Code and want to run multiple agents concurrently with visual oversight. Whether you are parallelizing feature work across branches, running review agents alongside coding agents, or simply want a better interface than a wall of terminal tabs -- Kangentic gives you a board to see and control it all.
