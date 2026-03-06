# Documentation

Kangentic is a cross-platform desktop Kanban for Claude Code agents. Drag tasks between columns to spawn, suspend, and resume Claude Code sessions automatically.

## Start Here

| Audience | Start with |
|----------|-----------|
| New user | [User Guide](user-guide.md) |
| Evaluating the product | [Overview](overview.md) |
| Contributing code | [Developer Guide](developer-guide.md) |
| Understanding the system | [Architecture](architecture.md) |

## Reference

### Product
- [Overview](overview.md) -- What Kangentic is, key features, positioning
- [User Guide](user-guide.md) -- End-user walkthrough of all features

### Architecture
- [Architecture](architecture.md) -- Process model, data flow, IPC channels, stores
- [Session Lifecycle](session-lifecycle.md) -- State machine, spawn flow, queue, suspend, resume, crash recovery
- [Transition Engine](transition-engine.md) -- Action types, templates, execution flow, priority rules
- [Database](database.md) -- Schema, migrations, repository pattern, connection management

### Integration
- [Claude Integration](claude-integration.md) -- CLI detection, command building, settings merge, hooks, trust
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state, subagent-aware transitions
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery, cleanup

### Operations
- [Configuration](configuration.md) -- Config cascade, all settings keys, permission modes
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging, security fuses
- [Developer Guide](developer-guide.md) -- Setup, build system, testing, conventions
