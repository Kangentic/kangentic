# Documentation

Kangentic is a cross-platform desktop Kanban for AI coding agents. Drag tasks between columns to spawn, suspend, and resume agent sessions automatically. Supports Claude Code, Codex, Gemini CLI, and Aider with automatic context handoff between agents.

## Start Here

| Audience | Start with |
|----------|-----------|
| New user | [Installation](installation.md) |
| Evaluating the product | [Overview](overview.md) |
| Contributing code | [Developer Guide](developer-guide.md) |
| Understanding the system | [Architecture](architecture.md) |

## Reference

### Getting Started
- [Installation](installation.md) -- Download, prerequisites, platform-specific setup, troubleshooting

### Product
- [Overview](overview.md) -- What Kangentic is, key features, positioning
- [User Guide](user-guide.md) -- End-user walkthrough of all features

### Architecture
- [Architecture](architecture.md) -- Process model, data flow, IPC channels, stores
- [Session Lifecycle](session-lifecycle.md) -- State machine, spawn flow, queue, suspend, resume, crash recovery
- [Transition Engine](transition-engine.md) -- Column automations and their adapters, templates and escaping, execution flow, priority rules, cross-agent handoff
- [Database](database.md) -- Schema (including session_transcripts and handoffs tables), migrations, repository pattern, connection management
- [Command Terminal](command-terminal.md) - The second window-manager layer: slot-keyed windows, global geometry against per-project population, the reattach and branch rules, and the title-bar controls
- [Activity Marks](activity-marks.md) - The nine activity glyphs: upstream ownership, why motion is composited, the click the mark ate, and the geometry and sizing history

### Integration
- [Agent Integration](agent-integration.md) -- Adapter interface, Claude/Codex/Gemini/Aider CLI details, permission modes, detection, command building
- [Adapter Session History](adapter-session-history.md) - Native session-history file formats Kangentic reads for real-time telemetry; the authoritative reference for the sessionHistory hook
- [Command Injection](command-injection.md) - How a column's message to its agent and its model/effort settings reach a live session, the verifier contract, retry semantics, and the measured per-agent support matrix (plus how to graduate an agent)
- [Board Integration](board-integration.md) -- BoardAdapter interface, registry, GitHub/Azure DevOps/Jira/Linear/etc., how to add a new provider
- [PR Integration](pr-integration.md) - PRConnector interface, registry and its remote-ownership gate, GitHub/Azure DevOps connectors, the confidence-ladder linker, background refresh, where PR state is stored
- [Mobile Bridge](mobile-bridge.md) - Desktop half of the mobile companion app: `@kangentic/protocol` package, pairing ceremony, signed device roster, capability verbs, relay transport
- [Handoff](handoff.md) -- Cross-agent context transfer: extraction, packaging, markdown rendering, prompt delivery
- [MCP Server](mcp-server.md) -- Board management tools for agents, file-based command queue, .mcp.json safety
- [Embedded Browser](embedded-browser.md) - Browser pane architecture: webview capture, draw and inspect modes, the paste engine, multi-modal prompt submission
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state, subagent-aware transitions
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery, cleanup

### Operations
- [Analytics](analytics.md) -- Telemetry events, opt-out, privacy
- [Configuration](configuration.md) -- Config cascade, all settings keys, permission modes
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging, security fuses
- [Deployment](deployment.md) -- Release pipeline, code signing, auto-update, npx launcher
- [Developer Guide](developer-guide.md) -- Setup, build system, testing, conventions
- [Release Smoke Checklist](release-checklist.md) -- Manual real-LLM validation gate run against draft builds before publish

### Historical

Point-in-time findings documents. Kept for the reasoning they record; not maintained as
evergreen references.

- [Transcript Pipeline Audit](transcript-pipeline-audit.md) (2026-06-12) - Hardening the session-transcript pipeline for cross-agent consumption: per-adapter `parseTranscript`, Claude parser fidelity fixes, verified against real session files
- [Board Card Drag Performance Audit](board-drag-perf-audit.md) (2026-09-16) - Measuring the board drag on a production build: the gesture drops no frames, the one stall inside it was an xterm construction from a previous drop's spawn, and dev mode is 4 to 7x slower on every synchronous cost
