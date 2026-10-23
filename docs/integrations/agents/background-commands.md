---
type: Reference
title: Background commands
description: How a background build or dev server holds its task thinking, the four conditions for declaring backgroundCommands, each agent's launch and stop signals, why Droid, Cursor and Antigravity do not declare it, and the BackgroundCommandSpec directives and hint hook that wire it.
tags: [agents, activity, background-shells]
sources:
  - resource: src/main/agent/shared/background-command-hooks.ts
  - resource: src/main/agent/shared/background-shell-hint-hook.ts
  - resource: src/shared/background-command-spec.ts
  - resource: src/main/agent/agent-adapter.ts
    title: backgroundCommands
---
# Background commands

A background command the agent starts (a build, a test run, a dev server) holds its task `thinking` until the command exits, so a task never reads idle while its work runs. A command that is meant to stay up, a server or a watcher, is released by the agent with `kangentic_mark_background_service`, or kept out of the hold from the start by `--kangentic-no-activity-hold` in its command. Both end the hold without stopping the process. The engine side is in [Activity Detection](../../activity-detection.md), "Opting a background shell out of the hold".

An agent takes part only when it declares `backgroundCommands`. A declaration is a measured claim with four conditions. `tests/unit/background-commands-declaration.test.ts` pins the list and checks the first two; the other two were measured against the real CLI:

- Activity is driven by hooks or a history file (`hooks_and_pty`), so the PTY tracker is off once that source flows and PTY silence stops ending turns. While a session still runs its PTY tracker (a Codex session whose hooks never flowed), PTY silence keeps every tracked shell: `handlePtyIdle` ends the turn through `forceIdle` with `keepBackgroundShells`, so the hold lasts until the command exits.
- `kangenticMcp` is `'per-session'`. A folder-shared URL can name another session, so a mark could land on the wrong one.
- The launch, foreground, stop and flagged payloads were captured from the real CLI and are pinned as fixtures (`tests/fixtures/<agent>-hooks/`, `tests/fixtures/kimi/wire-background-tasks.jsonl`).
- The process runs inside the PTY root's process tree, where the background-shell watcher can see it end. A process started outside it is never adopted, and the hold would be reclaimed after about 30 quiet cycles, which brings back "reads idle while a build runs".

An agent that does not declare emits no background start or end, gets no hint, and is not offered the MCP tool (`resolveBackgroundShells` in `mcp-http-server.ts` checks `SessionManager.reportsBackgroundCommands`). It never gains a hold it cannot release.

| Agent | Starts and ends reported by | Launch hint | Decision |
|-------|-----------------------------|-------------|----------|
| Claude Code | PreToolUse and PostToolUse remaps of `Bash` and `PowerShell` with `run_in_background`, the shell id in `tool_response.backgroundTaskId`; `KillShell` ends one | Yes | Declared. Payloads pinned by the replay fixtures |
| Qwen Code 0.25.3 | PostToolUse: `run_shell_command` with `tool_input.is_background`, id read from the text after `\nid: ` in `tool_response.llmContent` (observed as `bg_<hex>`); `task_stop` ends one (`tool_input.task_id`) | Yes, `hookSpecificOutput.additionalContext` | Declared. Hooks of one event run in parallel |
| Gemini CLI 0.64.0 | AfterTool: `run_shell_command` with `is_background`, the PID read from "Command moved to background (PID: N)". No stop tool, so the end is the process's exit | Yes, AfterTool `additionalContext` | Declared. Became per-session: the MCP URL and token are `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}` references Gemini expands from the session environment, so `.gemini/settings.json` holds neither, and Gemini can now be a workflow's agent |
| GitHub Copilot CLI 1.0.100 | postToolUse: `powershell` and `bash` started async, the `shellId` read from the result text (agent-chosen or assigned); `stop_powershell` and `stop_bash` end one when `resultType` is `success` | Yes, top-level `additionalContext` (`hookSpecificOutput` is ignored) | Declared. A `detach: true` launch is excluded: the agent declared that process independent of the session |
| Grok Build 1.0.0 | PostToolUse: `run_terminal_command` whose `toolResult.type` is `BackgroundTaskStarted`, id `toolResult.task_id`; `kill_command_or_subagent` whose result is `KillTask` ends one | No, its PostToolUse output never reaches the model | Declared. The agent learns of the tool from its description |
| Kimi Code 1.37.0 | wire.jsonl: a `Shell` ToolResult with message "Background task started." and a `background_task` display block naming the task id; `TaskStop`'s result and the task's `task.*` Notification end one | No, its PostToolUse hook reads only a block or deny decision | Declared. Activity moved to `hooks_and_pty`: the first wire read turns the PTY tracker off, and `TurnEnd` is now an Idle event, so On agent turn end automations run for Kimi. Measured in the interactive TUI, every record reaches wire.jsonl 13 to 40 ms after its own timestamp |
| Codex CLI 0.154.0 and 0.163.0 (fixtures captured on 0.154.0, the TUI and the trust read run on 0.163.0) | The rollout: a command still running at its yield (`Process running with session ID N`) starts one, keyed by the call id its PreToolUse carried; a `write_stdin` poll that finds it exited ends one. No hook fires at the yield, and `write_stdin` fires none | No, no hook fires at the launch | Declared. Codex runs Kangentic's hooks once its trust read confirms them (see [Codex Hook Integration](codex-cli.md#hook-integration)): activity is `hooks_and_pty`, and the Stop hook's Idle makes On agent turn end automations run for Codex. Only the exec status block before `Output:` is read, so a command that prints the phrase is never a launch |
| Droid 0.218.0 | Not reported | No | Not declared. `Execute` with `fireAndForget` starts the command through `Start-Process`, whose parent exits at once, so the process is outside the PTY root's tree and the watcher cannot see it end. Detached by design, like Copilot's `detach: true`. The `droid exec` payloads this was decided from are in `tests/fixtures/droid-hooks/`. Its activity stays on the PTY tracker: a hook pipeline through `--settings` was measured in `droid exec` (the file merges with the user's `~/.factory/settings.json`; SessionStart, PreToolUse, PostToolUse and Stop fire; UserPromptSubmit did not), but the TUI asks for a Factory sign-in even with a BYOK model, so its prompt, permission and interrupt events were never seen and the pipeline is not built |
| Cursor CLI | Not reported | No | Not probed: the CLI needs a signed-in account to run, so neither its background `shell_id` nor its hooks were seen against the real CLI. Its activity stays as it was |
| Antigravity CLI 1.3.4 | Not reported | No | Not declared. `run_command` backgrounds after `WaitMsBeforeAsync`, but the PostToolUse payload carries no tool output, so there is no id to key on, and the hook's reply must be `{}` |
| OpenCode 1.18.31 | Not reported | No | Its `bash` tool cannot run a command in the background |
| Goose CLI 1.55.0 | Not reported | No | No background commands: its `shell` tool takes only `command` and `timeout_secs`, returns when the command ends and kills it at the timeout (probed headless against a local stand-in for the model API). Not wired, and Goose has no Kangentic MCP |
| Aider, Oz CLI (Warp), Ollama | Not reported | No | No background commands |

## How a hook-driven declaration is wired

Each declaring adapter keeps one `BackgroundCommandSpec` (`src/shared/background-command-spec.ts`) in its adapter folder: which tool calls are a launch (tool names, `when` and `unless` conditions on the payload, where the id sits, and the literal text that frames an id inside result text), which are a stop, and the hint's reply envelope. Shared builders in `src/main/agent/shared/background-command-hooks.ts` turn it into directives and the hint command, so the hold and the hint answer the same calls.

- The launch and the stop ride the adapter's existing post-tool `tool_end` entry as two more directives, `appendBackgroundLaunch` and `appendBackgroundStop`. The event bridge writes their `background_shell_start` and `background_shell_end` lines beside the tool's own event, in one append. A separate entry would cost a second hook process per tool call, and Copilot and Grok run one event's hooks one after another, measured at 0.6 to 0.9 s each.
- The start carries no `toolId`. A start with one closes that pending tool, and the tool's own `tool_end` would then decrement the count a second time. With no tool id for the memo, a launch whose command carries `--kangentic-no-activity-hold` reports it on the start itself (`noActivityHold`).
- A stop is read on the stop tool's post-tool success payload, never pre-tool, so a denied or failed stop never drains a live command.
- The hint is its own entry, matcher-scoped to the launch tools, running `background-shell-hint-bridge.js` with a v2 spec (`{ launch, reply }`) built from the same launch match. It is added only when the session's MCP URL names it as the caller (`offersMarkBackgroundService`).
- A CLI whose hooks take bare tokens (Qwen on Windows) runs a workspace copy of the hint bridge, `<cwd>/.kangentic/qwen-background-shell-hint-bridge.cjs`. `copyBridgeInto` refuses a copy name that does not contain the script's name, which is what lets `isKangenticHookCommand` recognize the copy during cleanup.
- The matching code is in both bridges between `// BEGIN background-call-match` and `// END background-call-match`, since a workspace copy is one file and cannot `require` a shared module. `tests/unit/background-call-match-parity.test.ts` keeps the two blocks byte-identical and pins the block's `SHELL_ID_PATTERN` literal to `SHELL_ID_PATTERN_SOURCE`, since a workspace copy cannot import the shared constant. The block finds an id in result text by plain string search, so it compiles no regex from its argv.

A history parser that reports a turn end as a forced idle (Grok's `updates.jsonl`) would clear every tracked shell through `forceIdle`. `SessionTelemetry.forceActivity` turns that hint into the plain Idle event a Stop hook sends while any shell is tracked, which ends the turn and keeps the shells. PTY silence is handled the same way for the same reason (`handlePtyIdle`, above).
