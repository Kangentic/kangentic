# Architecture

## The whole app

* [System overview](system-overview.md) - Process model with the pty-host, retrieval, embedding and dictation workers, a task move's data flow, and short summaries of the database tables, agent resolution order, transition engine and task template variables, PTY manager constants, board adapters and the mobile bridge.

## Tasks, sessions and the board

* [Sessions](sessions/index.md) - An agent session's life: the state machine, spawn flow and queue, suspend and cleanup, resume, crash recovery, shutdown, terminal ownership, output streaming, transient sessions and the agent absence sweep.
* [Automations](automations/index.md) - What a column move does: the transition engine's priority rules and automation adapters, triggers and Conditions, the Automation agent, and how a column's message is delivered to a live agent and verified.
* [Workflows](workflows/index.md) - Linked tasks that run through their boards on their own: the workflow engine and its lock, the workflow agent that plans them, and the Workflows view.
* [Activity detection](activity/index.md) - How a session is judged thinking, idle or waiting on permission: the activity engine, its event types, the predicate, the watchdog safety nets and background shell tracking.
* [Worktrees](worktrees/index.md) - A task's git worktree: naming, base branch, creation and the git queue, sparse-checkout and node_modules linking, cleanup, and reaping the processes a task left running.

## Main and renderer

* [IPC channels](ipc/index.md) - Every renderer-to-main IPC channel, grouped into board, session and app channels, with its direction and payload.
* [Renderer](renderer/index.md) - Renderer-side structure: the Zustand stores, the Command Terminal's window layer, and the activity marks.
* [Embedded browser](embedded-browser/index.md) - The task Browser pane: webview hardening and cookie jars, Draw and Inspect capture, agent driving, and the numbered decision log behind it.

## Local features

* [Knowledge Graph index and workers](knowledge-graph.md) - When Knowledge Graph indexing, embedding and task-summary passes run and back off, what Rebuild resets, how the retrieval and embed workers idle out and fall back to keyword search, how the Index card counts sources, the Intel Mac exclusion, and the local model and agent choices.
* [Dictation](dictation.md) - How push-to-talk dictation resolves its target and refuses password fields, how the Best, Balanced and Light presets map to live and refinement models per language, when the kangentic-dictation worker is recycled for memory, and how Cloud refinement sends only the final clip.
