---
okf_version: "0.2"
---
# Kangentic documentation

## Start here

* [Kangentic documentation](README.md) - Where to start reading the Kangentic docs by audience: installing, evaluating, using the board, contributing code, or finding how a subsystem works, with a pointer to index.md, the full map of every concept.
* [User guide](user-guide/index.md) - Using Kangentic: installation, the board, tasks and task detail, the backlog, columns and automations, workflows, sessions and worktrees, the Knowledge Graph, the Command Terminal, the Agent Monitor, settings, shortcuts and troubleshooting.

## How it works

* [Architecture](architecture/index.md) - How the app is built: the process model and data flow, sessions, automations, workflows, activity detection, worktrees, IPC channels, the renderer, the embedded browser, the Knowledge Graph and dictation.
* [Integrations](integrations/index.md) - The outside tools Kangentic drives or connects to: agent CLI adapters, the MCP server agents call back into, pull request connectors, board import sources, and the mobile bridge.
* [Database](database/index.md) - The two SQLite databases: where they live, every table and its columns, the numbered migration history, and the repository classes that read and write them.
* [Settings](settings/index.md) - How settings resolve from defaults through global, project and column levels, the Settings panel's tabs, every AppConfig key, and the board config files a team shares.
* [Platforms](platforms/index.md) - What differs on Windows, macOS and Linux: shells and paths, packaging and security fuses, Windows and macOS specifics, and recovering from a GPU process that cannot run.

## Shipping and running it

* [Releases](releases/index.md) - Shipping a release: the deployment pipeline, code signing and auto-update, the manual smoke checklist, and the in-app announcements feed.
* [Telemetry](telemetry/index.md) - What Kangentic reports about itself: anonymous Aptabase usage events and their opt-out, and Sentry error and crash reporting with its scrubbing, filtering and symbol upload.

## Working on Kangentic

* [Contributing](contributing/index.md) - Working in this repo: setup, the build and test tiers, the board's Code Review, Testing and Merge columns, and how to author a convention rule.

## Records

* [Audits](audits/index.md) - Point-in-time findings kept for the reasoning they record: the code review fan-out, board drag performance, conversation history paging, the transcript pipeline and a spare pre-installed worktree.
* [Research](research/index.md) - Research written before a design: the Open Knowledge Format these docs follow, and the mobile companion app.
* [Log](log.md) - Dated changes to these docs, newest first, with the measurements behind the concept layout.
