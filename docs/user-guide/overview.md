---
type: Guide
title: Product overview
description: What Kangentic is and is not, the problem it solves, each feature in a paragraph (multi-agent handoff, backlog import, search palette, worktrees, session persistence, themes), the six-step board workflow, the tech stack and the target audience.
tags: [overview, features, product]
---
# Product overview

## What is Kangentic?

Kangentic is a cross-platform desktop Kanban application purpose-built for orchestrating AI coding agents. It supports Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Qwen Code, Kimi Code, OpenCode, Droid (Factory), Cursor CLI, GitHub Copilot CLI, Aider, Oz CLI (Warp), Ollama, Grok Build (xAI), and Goose CLI. Dragging a task card between columns can spawn, suspend, resume, or terminate agent sessions - turning a familiar Kanban workflow into a powerful multi-agent control plane.

## The Problem

Working with multiple AI coding agent sessions simultaneously is difficult. Developers juggle terminal tabs, manually start and stop sessions, lose track of which agent is working on what, and struggle to coordinate parallel work across branches. When switching between different agent CLIs, context is lost entirely. There is no visual layer for managing agent lifecycle at scale.

## The Solution

Kangentic replaces terminal tab chaos with a drag-and-drop board. Each task card represents a unit of work. Moving a card into a column triggers configurable actions - spawning an agent, sending it a command, suspending it, or tearing it down. Different columns can use different agents, and context is automatically handed off when a task moves between agents. The board becomes the single interface for seeing what every agent is doing and controlling what happens next.

## Key Features

### Multi-Agent Support

Orchestrate Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Qwen Code, Kimi Code, OpenCode, Droid (Factory), Cursor CLI, GitHub Copilot CLI, Aider, Oz CLI (Warp), Ollama, Grok Build (xAI), and Goose CLI from a single board. Set a default agent per project, or override it per column. When a task moves between columns with different agents, Kangentic automatically packages the outgoing agent's context (transcript, git changes, metrics) and hands it off to the incoming agent. No manual copy-paste between tools.

### Visual Agent Orchestration

Drag a task card into an active column to spawn an agent. Drag it to Done to complete it: the session is suspended with its conversation kept, so an unarchived task resumes where it left off. Drag it back to To Do to reset it: the session, its history and the worktree are removed. Every column transition is an orchestration event.

### Backlog & Import

Stage tasks in a backlog before promoting them to the board. Import issues from GitHub Issues, GitHub Projects, Azure DevOps, and Asana with their titles, descriptions, labels, and images. Azure DevOps and Asana also bring file attachments, and Azure DevOps brings comments. Imports are one-way, and re-importing skips items already imported. Multi-select items for bulk operations, drag to reorder, and right-click for context menus. See the [User Guide](backlog.md#backlog) for details.

### Board Filtering

Filter board tasks by priority level and label using the filter popover at the top right of the board. Active filters show a count badge and can be cleared with one click.

### Search Palette

Press Ctrl+Shift+F (Cmd+Shift+F on macOS) or Ctrl+F to open a global search palette that searches across tasks (active and archived), backlog items, session events, and registered projects. Type `#<number>` (e.g. `#42`) to search by ticket number: only tasks whose display ID prefix-matches. Default scope is the current project; toggle to "All projects" to search across every registered project. Selecting a hit jumps to the right place: a task opens its detail dialog, a session event scrolls the Activity Log to the matching event with a brief highlight, a backlog hit switches to the backlog view and opens the item, a project hit switches projects.

### Markdown Descriptions

Task descriptions support full Markdown rendering with GitHub Flavored Markdown (tables, task lists, strikethrough). Links open in the default browser. Markdown is rendered in the task detail dialog and on completed task summaries.

### File Attachments

Paste or drag-and-drop any file type onto a task as an attachment - not limited to images. Drag files from your file manager onto the terminal to insert the file path directly into the active session.

### Shareable Board Configuration

Teams commit a `kangentic.json` file to share column layout, colors, icons, actions, and transitions across all collaborators. Personal overrides live in `kangentic.local.json` (auto-gitignored). Live file watching detects when a teammate pushes changes and offers to reconcile them into your board.

### Session Persistence

Agent sessions survive application restarts. Kangentic resumes each session with its CLI's own resume flag (Claude Code's `--resume`, for example), so the agent picks up its conversation. Every agent supports this except Aider, Oz CLI, and Ollama, which start fresh. Sessions paused manually by the user (via the pause button) stay paused on relaunch. Only system-suspended sessions auto-resume.

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

Real-time thinking and idle status indicators, from each agent's hooks where it has them and from its terminal output where it does not. See at a glance which agents are actively working, which are waiting for input, and which are idle.

### Configurable Context Bar

The context bar below each terminal displays session metadata: shell, CLI version, model, cost, tokens, and context window usage. Each element can be toggled on or off in settings.

### Settings Search

A built-in search bar filters settings by keyword with multi-token matching, grouped results by tab, and match count badges. Find any setting instantly across all tabs.

### Multiple Themes

Twelve built-in themes, picked from a swatch grid that shows each one in its own colours: the neutral Graphite and Paper, the product pair Rust and Clay, then Moon, Forest, Ocean, Ember, Sand, Mint, Sky, and Peach. A switch keeps one for when the OS is light and another for when it is dark.

## How It Works

1. **Create a board** with columns representing your workflow stages (To Do, In Progress, Review, Done, or any custom stages).
2. **Add task cards** describing units of work - features, bugs, refactors. Create them directly on the board, stage them in the backlog, or import them from GitHub Issues, GitHub Projects, Azure DevOps, or Asana.
3. **Drag a card** into an active column. Kangentic spawns the column's agent CLI, passes it the task description as a prompt, and begins streaming terminal output.
4. **Monitor progress** via the embedded terminal, activity indicators, and board-level status at a glance. Filter by priority or label to focus on what matters.
5. **Drag the card forward** through your workflow. Each transition can trigger additional actions - commands, scripts, webhooks.
6. **Drag to Done** to complete the task and suspend its session, or back to To Do to reset it and start over.

## What Kangentic Is Not

- **Not a task tracker.** It is not Jira, Linear, or Trello. There are no sprints, story points, or grooming features. The board exists to control agents, not to manage project management metadata.
- **Not a CI system.** It does not run pipelines, deploy artifacts, or manage environments. It orchestrates interactive agent CLI sessions on your local machine.
- **Not a wrapper around a web API.** Kangentic works with agent CLIs directly. It spawns real terminal sessions with full PTY support.

Kangentic is an **agent orchestration desktop app** - a visual control surface for running multiple AI coding agents in parallel.

## Tech Stack

| Layer        | Technology                                      |
| ------------ | ----------------------------------------------- |
| Runtime      | Electron 45, Node 24                            |
| Frontend     | React 19, Zustand, Tailwind CSS 4, Lucide icons |
| Backend      | better-sqlite3, node-pty, simple-git             |
| Build        | Vite (renderer), esbuild (main), electron-builder |
| Testing      | Playwright (E2E + UI), Vitest (unit)              |
| Distribution | NSIS (Windows), DMG (macOS), deb/rpm (Linux)      |

## Target Audience

Kangentic is built for developers who use AI coding agents and want to run multiple agents concurrently with visual oversight. Whether you are parallelizing feature work across branches, running review agents alongside coding agents, handing off between Claude Code and Codex mid-task, or simply want a better interface than a wall of terminal tabs - Kangentic gives you a board to see and control it all.
