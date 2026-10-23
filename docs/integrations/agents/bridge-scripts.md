---
type: Reference
title: Bridge scripts
description: The four stateless Node bridge scripts that hooks and status lines run, status-bridge.js, event-bridge.js, plan-approval-bridge.js (decision file, fails closed, setMode reply) and background-shell-hint-bridge.js, with their inputs, outputs and supported agents.
tags: [agents, hooks, bridge-scripts]
sources:
  - resource: src/main/agent/status-bridge.js
  - resource: src/main/agent/event-bridge.js
  - resource: src/main/agent/plan-approval-bridge.js
  - resource: src/main/agent/background-shell-hint-bridge.js
  - resource: src/main/agent/shared/plan-approval-hook.ts
  - resource: src/main/agent/shared/background-shell-hint-hook.ts
  - resource: src/main/agent/adapters/claude/plan-tool-approval.ts
  - resource: src/main/plan-approval/plan-approval-writer.ts
  - resource: src/main/plan-approval/resolve-decision.ts
---
# Bridge scripts

Four standalone Node.js scripts in `src/main/agent/`:

## `status-bridge.js`

- **Hook point:** `statusLine` (not a hook - uses Claude Code's status line feature)
- **Output:** `status.json` (overwritten on each invocation)
- **Data:** Token usage, cost, model, context window percentage
- **Watched by:** SessionManager with 100ms debounce
- **Supported by:** Claude Code, Gemini CLI (via status parser)

## `event-bridge.js`

- **Hook point:** All registered hooks
- **Output:** `events.jsonl` (append-only, one JSON line per event)
- **Data:** Timestamps, event types, tool names, file paths
- **Appended events:** `appendBackgroundLaunch` and `appendBackgroundStop` write a `background_shell_start` or `background_shell_end` line beside the hook's own event, from the adapter's `BackgroundCommandSpec` (see [Background commands](background-commands.md#background-commands)). They are new kinds rather than flags on an old one, so a stale bridge copy rejects them through its unknown-directive branch instead of misreading them. A suppressed main event still lets an appended line land.
- **Watched by:** SessionManager with 50ms debounce, incremental byte-offset reads
- **Supported by:** Claude Code (18 hook points), Codex CLI (via `-c hooks.*` overrides and a per-spawn workspace copy, `<cwd>/.kangentic/codex-event-bridge.cjs`, with the `env:KANGENTIC_EVENTS_PATH` sentinel - see [Codex Hook Integration](codex-cli.md#hook-integration)), Gemini CLI (via .gemini/settings.json hooks), Qwen Code (on Windows via a per-spawn workspace copy, `<cwd>/.kangentic/qwen-event-bridge.cjs`, and the `env:KANGENTIC_EVENTS_PATH` sentinel - see [Paths in hook commands](claude-code.md#paths-in-hook-commands)), Aider, GitHub Copilot CLI, Grok Build (via `.grok/hooks/kangentic.json`, with the events path resolved through the `env:KANGENTIC_EVENTS_PATH` sentinel - see [Grok Build](grok-build.md#grok-build)), and Antigravity CLI (via a per-spawn workspace copy, `<cwd>/.kangentic/agy-event-bridge.cjs` - see [Antigravity](antigravity.md#antigravity))

## `plan-approval-bridge.js`

- **Hook point:** a second `PermissionRequest` entry, matcher exactly `ExitPlanMode`, beside the event bridge's catch-all one. Registered on every spawn of an adapter that declares `supportsPlanAutoApproval`, whatever the column says, so a column or workflow switched to Automatic while the agent plans needs no hook reload. A question the agent asks (`AskUserQuestion`) never reaches it.
- **Input:** the session's decision file, `.kangentic/sessions/<ptySessionId>/plan-approval.json` (`{ approve, mode, detail }`), and a base64 spec (`PlanApprovalHookSpec` in `src/main/agent/shared/plan-approval-hook.ts`) naming the tool, where its input sits, and the reply the CLI expects. The tool approval entry carries a `PlanToolApprovalHookSpec` instead (the allowed tools, the excluded ones, the modes it answers in, a bare reply). All agent knowledge is in the spec, never in the script.
- **Output:** to approve, the reply on stdout, after one `plan_approval_sent` line appended to `events.jsonl` (`tool_approval_sent` for the tool entry). Claude's reply (`CLAUDE_PLAN_APPROVAL_SPEC` in `adapters/claude/hook-manager.ts`) is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":<tool_input>,"updatedPermissions":[{"type":"setMode","mode":<mode>,"destination":"session"}]}}}`. The input is echoed exactly, since Claude 2.1.300 and later deny a call whose input changed. `setMode` is needed because a hook approval otherwise restores the mode the session had before plan mode, and a session launched in plan mode has none.
- **Allowed tools while planning (task #870):** Claude's plan mode prompts for every tool that is not read-only. An MCP tool whose server does not annotate it `readOnlyHint` is not read-only, and an allow rule does not reach it there, so an unattended Planning session stopped at that prompt. When the session's allow rules name such a tool, the builder registers the same bridge a second time (a third `PermissionRequest` entry), matcher `mcp__.*`, with a `PlanToolApprovalHookSpec`: the tools and server prefixes the rules allow, the ones a deny or ask rule names, and Kangentic's own server, always excluded so its mutating tools keep prompting ([MCP server](../mcp-server/index.md)). It answers a bare allow, after one `tool_approval_sent` line naming the tool, only in plan mode (`permission_mode`) and only while the decision file says `approve: true`. The rules are read from the session's merged settings (project, project local, worktree local) and the user's `~/.claude/settings.json`, in `adapters/claude/plan-tool-approval.ts`. Measured on Claude 2.1.306 by `scripts/probe-claude-plan-tool-approval.js`, in `-p` and the interactive TUI: the hook's allow ran the call, a subagent's included, and outranked an ask rule, which is why the builder leaves an asked tool out. An ask or deny rule it cannot read as one of the MCP forms (a partial wildcard such as `mcp__docs__get_*`, or a specifier) excludes every tool its text before the `*` or `(` begins. Managed settings are not read, so a managed ask rule for a tool a project or user rule allows is answered anyway. The captured requests are in `tests/fixtures/plan-exit/claude-2.1.306-permission-request-mcp-tool*.json`.
- **Fails closed:** another tool, no decision file, `approve: false`, or any error prints nothing and exits 0, so the CLI shows its own dialog and the user decides. Diagnostics go to `plan-approval-bridge.error.log` beside the decision file, never to stdout.
- **Decision writer:** `PlanApprovalWriter` (`src/main/plan-approval/plan-approval-writer.ts`) writes the file through `safeWriteJson` (source `plan_approval`) when a task session first appears, and rewrites every live session's file, coalesced at 100 ms, on any board change and on a Board Profile edit, a settings change or a `kangentic.json` apply (`refreshPlanApprovals`). The decision comes from `resolvePlanApprovalDecision` (`src/main/plan-approval/resolve-decision.ts`): a running workflow's value, else the column's own while it runs in plan mode, and never an approval where the session's agent cannot approve plans or the task's automations are disabled (`canTaskRunAutomations`). `mode` is the destination's effective permission mode (the After Plan Mode target, or the next column on a workflow task's route); where that is `plan`, or `bypassPermissions` in a session launched without bypass available, it falls back to the task's own mode, then the global mode, then `default`. A plan-mode spawn whose approval would continue in `bypassPermissions` launches with `CommandOptions.bypassAvailable`. Transient sessions (a Command Terminal, a workflow's own agent) get no decision file, so their plans always wait.
- **Supported by:** Claude Code (measured on 2.1.302: `acceptEdits` and `auto` apply through `setMode`; `bypassPermissions` applies only to a session launched with bypass available)

## `background-shell-hint-bridge.js`

- **Hook point:** a second post-tool entry beside the event bridge's catch-all one, matcher-scoped to the launch tools where the CLI has matchers (Claude's `Bash|PowerShell`). Registered only for a session whose MCP URL names it as the caller (`urlNamesTaskSessionCaller`), because the hint points at `kangentic_mark_background_service`, which the server offers only to such a session. A Command Terminal, or a session with the MCP server off, gets none.
- **Input:** the hook payload on stdin, and a base64 spec (`src/main/agent/shared/background-shell-hint-hook.ts`) naming the tools, where the command and the shell id sit, the opt-out flag, and the reply. All agent knowledge is in the spec, never in the script. Claude sends the v1 shape (`BackgroundShellHintSpec`), which its replay fixtures pin. Every other agent sends v2 (`BackgroundShellHintSpecV2`, `{ launch, reply }`), whose `launch` is the same match its `appendBackgroundLaunch` directive carries. A stale bridge prints nothing for v2, since it requires the v1 fields.
- **Output:** for a result carrying an id-shaped background shell id, from a command without `--kangentic-no-activity-hold`, the reply on stdout, with the one hint text `BACKGROUND_SHELL_HINT_TEXT` in the CLI's own envelope. Claude's (`CLAUDE_BACKGROUND_SHELL_HINT_SPEC` in `adapters/claude/hook-manager.ts`) is `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":<hint>}}`: the shell keeps the task working and holds the column's turn-end automations until it exits, and a server or watcher can be marked with the tool. See "Opting a background shell out of the hold" in [Background shells](../../architecture/activity/background-shells.md#opting-a-background-shell-out-of-the-hold).
- **Prints nothing** for a foreground call, another tool, a flagged command, stdin over 1 MiB, or any error, and exits 0, so it never fails or blocks a tool.
- **Supported by:** Claude Code (probed headless on 2026-10-20: the context reached the model for a Bash and a PowerShell `run_in_background` launch, both results carried `tool_response.backgroundTaskId`, and Claude runs one event's hooks in parallel, so the hint adds no wall time to a tool call), Qwen Code 0.25.3, Gemini CLI 0.64.0 and GitHub Copilot CLI 1.0.100 (each probed headless against a local stand-in for its model API, with a nonce in the reply found in the next model request)

All four scripts are stateless (no persistent process), read JSON from stdin, and exit. All writes are try/catch wrapped for non-fatal failures.
