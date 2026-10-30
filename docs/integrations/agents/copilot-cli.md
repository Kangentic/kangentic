---
type: Reference
title: GitHub Copilot CLI
description: GitHub Copilot CLI with caller-owned --session-id (--resume failed on unseen ids), a per-session --config-dir holding hooks/kangentic.json plus settings.json and config.json copies, cleanup that spares session-state, plan exit read from exit_plan_mode result text, and questions and approvals from the notification hook.
tags: [agents, adapter, copilot]
sources:
  - resource: src/main/agent/adapters/copilot/copilot-adapter.ts
  - resource: src/main/agent/adapters/copilot/detector.ts
  - resource: src/main/agent/adapters/copilot/command-builder.ts
  - resource: src/main/agent/adapters/copilot/hook-manager.ts
  - resource: src/main/agent/adapters/copilot/copilot-home.ts
  - resource: src/main/agent/adapters/copilot/status-parser.ts
---
# GitHub Copilot CLI

## CLI Detection

`src/main/agent/adapters/copilot/detector.ts`

Detection follows the standard pattern: check `config.agent.cliPaths.copilot`, fall back to `PATH` via `which`, run `copilot --version`.

## Command Building

`src/main/agent/adapters/copilot/command-builder.ts`

Copilot CLI 1.0.51+ supports caller-owned session IDs via `--session-id <uuid>` (same semantics as Claude's `--session-id`): passing a new UUID starts a fresh session with that ID, passing an existing UUID resumes it. The builder used `--resume <uuid>`, which 1.0.97 refuses for an id it has not seen ("No session, task, or name matched"), so no new Copilot task started.

A resume carries no prompt. `-i <prompt>` starts an interactive session with one, but neither `copilot --help` nor GitHub's docs say it runs on a session resumed by `--session-id`, so the adapter declares `resumePromptDelivery: 'typed'`: Kangentic keeps a resume's message (a column's message, held messages) off the command line and types it in once Copilot is ready. See [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives).

Per-session config is written to `<eventsOutputPath dir>/copilot-config/` and passed with `--config-dir`, which Copilot 1.0.97 still honors by setting `COPILOT_HOME` (it prints a deprecation line). Three files go there:

- `hooks/kangentic.json` holds the hooks (`preToolUse`, `postToolUse`, `agentStop`, `preCompact`, `notification`) as `{ "version": 1, "hooks": ... }`. Copilot reads every `*.json` in `<COPILOT_HOME>/hooks/` as user hooks, and has since 0.0.422, so one file covers every version.
- `settings.json` is a copy of the user's `~/.copilot/settings.json` plus the `statusLine` bridge and `banner: never`. Copilot 1.0.93 reads user settings only from this file.
- `config.json` is a copy of the user's (signed-in account, trusted folders) with the same two settings for older versions. It never carries hooks: 1.0.8 through 1.0.92 read config.json hooks as well as the hooks folder, so hooks in both would fire twice. Earlier Kangentic versions wrote their hooks there, which 1.0.93 ignores.

The user's Copilot home those copies come from is `$COPILOT_HOME` when set, else `~/.copilot` (`copilotHomeDir`, `copilot-home.ts`), the same folder `--config-dir` names for a session. The history verifier, the model scan, the answer run's session cleanup and the relocation pass read it too. Before, a user with `COPILOT_HOME` set got every session seeded without their sign-in. Only an absolute value is taken.

The adapter tracks these directories keyed by the session's own id (`CommandOptions.ptySessionId`), so `removeHooks(directory, sessionId?)` cleans that session's directory and never the one of the task's next session. It deletes Kangentic's files one by one and never recursively, because Copilot keeps the session's `session-state/` in the same config home and the next resume by `--session-id` needs it. The project-delete sweep (no `sessionId`) cleans every directory recorded for its folder.

## WSL

A Copilot installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Copilot's Linux path in a `wsl -d <distro>` shell, and `--config-dir` names the session's config home in the distro's form. That home is seeded from the distro's Copilot home (its own `COPILOT_HOME`, else the distro's `~/.copilot`), never this machine's, so the session keeps the distro's sign-in. The config home is the session's alone, so its hooks call the session's own copy of the WSL hook transport's script with the same events and directives (a distro may have no node). The status line is the transport's `status`, which renames Copilot's status JSON over `status.json`, and the background shell hint goes through its `reply`. Copilot passes a hook its payload on stdin, which the script reads. On mirrored networking `--additional-mcp-config` names the `http` entry. On NAT networking it is the transport's stdio bridge, `{"type": "stdio", "command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": <token>}, "tools": ["*"]}`. GitHub's Copilot CLI command reference makes `command`, `args` and `tools` required for a local server and takes `local` or `stdio` as its `type`. A Knowledge Graph answer that bridges gets a run directory of its own for the relay. The history verifier's fallback, the model scan and the answer run's session cleanup read the distro's Copilot home. `--help` and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Copilot installed in a distro.

## Permission Modes

| Mode | Flag | Copilot Mode |
|------|------|--------------|
| `plan` | `--plan` | Plan (Read-Only) |
| `dontAsk` | `--plan --no-ask-user` | Plan Non-Interactive (CI) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` | `--allow-all-tools` | Allow All Tools |
| `auto` | `--allow-all-tools` | Autopilot (Allow All Tools) |
| `bypassPermissions` | `--yolo` | YOLO (Full Access) |

`defaultPermission` is `acceptEdits`.

## Status & Events

The `CopilotStatusParser` reads a `status.json` written by Copilot's `statusLine` config (full-rewrite). Activity uses `hooksAndPty` - hooks primary, PTY silence timer as fallback.

### Questions and approvals

The `notification` hook tells a question from an approval (GitHub #452). GitHub's hooks reference lists its `notification_type` values. Two of them are a wait on the user: `elicitation_dialog` ("the agent requests additional information from the user", the `ask_user` question) and `permission_prompt` (a tool to allow). The entry writes the permission `idle` for those two only, tagged `waitKind: 'question'` or `'approval'`, and drops every other type (`shell_completed`, `agent_completed`, `agent_idle`, ...). `permissionRequest` is not used: it fires before Copilot's permission service, so it also fires for calls that rules or session approvals allow without asking.

Measured on a live 1.0.100 session in a `/preview` (`tests/fixtures/copilot-hooks/copilot-1.0.100-waits.jsonl` and the two `copilot-1.0.100-notification-*.json` payloads):

- The payload names the type in snake_case `notification_type` (with `hook_event_name: "Notification"`), even under the camelCase `notification` key, beside the camelCase `sessionId`.
- The notification lands after the waiting tool's `preToolUse`: 45 ms after `ask_user`'s by Copilot's own timestamps, and after the shell tool's for a permission prompt. The tool's `postToolUse` ends the wait, and `agentStop` ends the turn.
- An `echo` ran without a prompt in default mode, so it raised no wait.

The hook is fire-and-forget, so Copilot does not wait for it. An answer given before its process writes could land the tool's end first and leave the wait up. The next tool start or the turn's `agentStop` then clears it.

Copilot's tool hooks carry no tool id, so the engine's sibling rule (a parallel call that finishes does not end a wait, [The kind of a wait](../../architecture/activity/activity-engine.md#the-kind-of-a-wait)) cannot apply. A read tool run beside `ask_user` that ends while the question is open clears it, as it did on Claude before the rule.

## Limitations

- No `transcript-cleanup.ts` despite being a TUI agent (`\x1b[?25l` cursor hide). Handoff transcripts may contain rendering artifacts.
- `locateSessionHistoryFile` returns null - file location is not yet empirically verified.
- Trust is handled at runtime via `--add-dir`, not pre-approved.
- Plan exit detection was read from the 1.0.97 bundle and confirmed on a live 1.0.98 session (`tests/fixtures/plan-exit/copilot-1.0.98-post-tool-use-*.json`). Copilot's plan exit tool is `exit_plan_mode`, and its `postToolUse` result at `toolResult.textResultForLlm` starts "Plan approved! Exited plan mode." for an approved plan and "Plan not approved." otherwise. A rejection does reach `postToolUse`, as a `success` result with the "Plan not approved." text. The `postToolUse` entry carries `setToolWhen({ whenTool: 'exit_plan_mode', toolField: 'toolName', nested: ['toolResult', 'textResultForLlm'], startsWith: 'Plan approved', to: 'ExitPlanMode' })`, so only an approved plan moves the card to the After Plan Mode target.
