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
- [Transition Engine](transition-engine.md) -- Action types, templates, execution flow, priority rules, cross-agent handoff
- [Database](database.md) -- Schema (including session_transcripts and handoffs tables), migrations, repository pattern, connection management

### Integration
- [Agent Integration](agent-integration.md) -- Adapter interface, Claude/Codex/Gemini/Aider CLI details, permission modes, detection, command building
- [Board Integration](board-integration.md) -- BoardAdapter interface, registry, GitHub/Azure DevOps/Jira/Linear/etc., how to add a new provider
- [Handoff](handoff.md) -- Cross-agent context transfer: extraction, packaging, markdown rendering, prompt delivery
- [MCP Server](mcp-server.md) -- Board management tools for agents, file-based command queue, .mcp.json safety
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state, subagent-aware transitions
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery, cleanup

### Operations
- [Analytics](analytics.md) -- Telemetry events, opt-out, privacy
- [Configuration](configuration.md) -- Config cascade, all settings keys, permission modes
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging, security fuses
- [Deployment](deployment.md) -- Release pipeline, code signing, auto-update, npx launcher
- [Developer Guide](developer-guide.md) -- Setup, build system, testing, conventions
- [Release Smoke Checklist](release-checklist.md) -- Manual real-LLM validation gate run against draft builds before publish
