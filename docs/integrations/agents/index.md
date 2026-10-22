---
okf_version: "0.2"
---
# Agents

## Adapter contract

* [Agent adapter interface](adapter-interface.md) - The AgentAdapter contract every agent implements, the fifteen supported agents, and the shared rules for agent resolution, first-output detection, exit sequences, history location and prompt templates.
* [Optional adapter properties](optional-properties.md) - Every optional AgentAdapter property and method, what each declares, and which adapters set it.
* [Adapter types and capability discovery](adapter-types.md) - The AgentCapabilities, CommandOptions, AdapterRuntimeStrategy and SpawnSessionInput types, and how each adapter discovers its models and effort levels.

## Shared mechanisms

* [Background commands](background-commands.md) - How an agent declares background commands so a running build holds its task active, and how a hook-driven declaration is wired.
* [Auto-name (summarize)](auto-name.md) - How an adapter's summarize call names tasks and Command Terminals, where the names surface, and how to add summarize to a new adapter.
* [Bridge scripts](bridge-scripts.md) - The status, event, plan-approval and background-shell-hint bridge scripts that agent CLIs run from their hooks and status lines.
* [Project relocation](project-relocation.md) - How the project:relocate handler moves or repoints a project and how each adapter rewrites the paths its CLI stored.

## Adapters

* [Claude Code](claude-code.md) - How Kangentic detects Claude Code, builds its command, maps permission modes, merges per-session settings, injects hooks, and writes ~/.claude.json before each spawn.
* [Codex CLI](codex-cli.md) - How Kangentic detects Codex CLI, builds its new and resume commands, wires MCP and hooks through -c overrides, pre-approves directory trust, and maps permission modes to sandbox flags.
* [Gemini CLI](gemini-cli.md) - How Kangentic detects Gemini CLI, builds its command, maps permission modes, handles plan exit and confirmation prompts, and merges its settings and MCP wiring.
* [Qwen Code](qwen-code.md) - How Kangentic detects Qwen Code, builds its command, maps permission modes and hook events, handles plan exit, trust and the MCP approval gate, and reads its session history.
* [OpenCode](opencode.md) - How Kangentic detects OpenCode, builds its command, merges settings, tracks activity through a plugin, captures the session id, and attaches to a remote server.
* [Aider](aider.md) - How Kangentic detects Aider, builds its command and maps permission modes, and what the integration leaves out.
* [Cursor CLI](cursor-cli.md) - How Kangentic detects Cursor CLI, builds its command and maps permission modes, and what the integration leaves out.
* [GitHub Copilot CLI](copilot-cli.md) - How Kangentic detects GitHub Copilot CLI, builds its command, maps permission modes, and reads its status and events.
* [Oz CLI (Warp)](oz-cli.md) - How Kangentic detects Warp's Oz CLI, builds its command and maps permission modes, and what the integration leaves out.
* [Kimi Code](kimi-code.md) - How Kangentic detects Kimi Code, builds its command, captures the session id, reads its wire.jsonl session history, maps permission modes, and probes authentication.
* [Droid](droid.md) - How Kangentic detects Factory's Droid, builds its command, captures the session id, maps permission modes, and sets up its MCP config.
* [Ollama](ollama.md) - How Kangentic detects Ollama, builds its command, maps permission modes, and detects activity without hooks.
* [Grok Build](grok-build.md) - How Kangentic runs xAI's Grok Build, a Claude-compatible TUI, and how its command building and permission modes map.
* [Antigravity](antigravity.md) - How Kangentic detects Antigravity CLI, builds its command, maps permission modes, wires hooks, MCP and trust, and reads its session history and transcript.
* [Goose CLI](goose-cli.md) - How Kangentic detects Goose CLI, builds and resumes its command, maps permission modes, and detects activity.
