---
type: Reference
title: Cursor CLI
description: Cursor CLI detection that probes cursor-agent before the agent alias Grok also installs, confirm-changes, --force skip-approval sessions, and -p --trust stream-json commands, --model ids resolved from display names, --resume=id quoting, the project .cursor/mcp.json with --approve-mcps, and create-chat session ids for workflow agents.
tags: [agents, adapter, cursor]
sources:
  - resource: src/main/agent/adapters/cursor/cursor-adapter.ts
  - resource: src/main/agent/adapters/cursor/project-mcp-config.ts
  - resource: src/main/agent/adapters/cursor/answer-workspace.ts
  - resource: src/main/agent/adapters/cursor/stream-parser.ts
  - resource: src/main/agent/adapters/cursor/capability-discovery.ts
---
# Cursor CLI

## CLI Detection

Detection uses the shared `AgentDetector` with binary name `cursor-agent` and `binaryAliases: ['agent']`.

Cursor installs BOTH shims, and the short one is not its alone: xAI's [Grok CLI](grok-build.md) also installs `agent`, and on Windows its `agent.exe` beats Cursor's `agent.cmd` in PATHEXT order. Detecting on `agent` therefore made Cursor **undetectable** on any machine that also had Grok - the probe resolved, ran Grok's binary, and Cursor was reported missing. Probing the unambiguous name first is the fix; the alias keeps working where only `agent` exists.

Two supporting details make the fallback safe. `parseVersion` accepts `1.0.0`, `agent 1.0.0`, or `Cursor Agent 1.0.0` and rejects anything else, so Grok's own version banner fails the probe rather than passing as Cursor. And the PATH loop CONTINUES to the next candidate when a name resolves but fails its version probe, instead of aborting - without that, finding Grok's `agent` would still end the search. Pinned by `tests/unit/cursor-grok-binary-collision.test.ts`.

## Command Building

`src/main/agent/adapters/cursor/cursor-adapter.ts`

### New Session (Interactive)

```
agent "prompt text"
```

User confirms changes in the PTY. `permissionMode === 'default'`.

### New Session (Interactive, skip approvals)

```
agent --trust --force "prompt text"
```

Selected when `permissionMode === 'acceptEdits'`. The session screen stays open. `--force` (alias `--yolo`) allows commands unless one is explicitly denied. `--trust` skips the workspace prompt. This mode prints no stream-json, so the context bar learns the model from `agent about` and the occupancy percent from the TUI status bar (`Composer 2.5 · 7.8%`), the same as confirm-changes. A resume is `agent --trust --force --resume="<chat-id>"`.

### New Session (Non-Interactive)

```
agent --trust -p "prompt text" --output-format stream-json
```

Selected when `permissionMode === 'bypassPermissions'` or `nonInteractive` is set. Has full write access. A directory Cursor has not seen prints "Workspace Trust Required" and exits. `--trust` skips that prompt. The NDJSON `init` event carries `session_id`, which `runtime.sessionId.fromOutput` captures for resume. A non-interactive resume keeps `--trust` for the same reason.

### Resumed Session

```
agent --resume="<chat-id>"
```

A non-interactive resume is `agent --trust --resume="<chat-id>"`. The `=` sits outside the quote boundary (`--resume='id'` on unix, `--resume="id"` on Windows).

A resume carries no prompt. Nothing Cursor documents says a prompt rides `--resume=<id>`, so the adapter declares `resumePromptDelivery: 'typed'`: Kangentic types a resume's message (a column's message, held messages) in once Cursor is ready. See [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives).

## WSL

A Cursor installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Cursor's Linux path in a `wsl -d <distro>` shell. `create-chat`, `about`, `--help`, `--list-models`, a title summary and a Knowledge Graph answer all run through `wsl.exe`. `about` asks the CLI the session was started with, not the Cursor on PATH, which on a machine with both installed reported the Windows Cursor's model for a distro session.

Kangentic's MCP server stays a static entry in the project's `.cursor/mcp.json`. On mirrored networking the distro reaches this machine's loopback, so the entry is the URL one. On NAT networking it is the WSL hook transport's stdio bridge (`CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY`): `sh` with the script, `mcp` and the URL, and the token in the server's `env`. The script path, URL and token are `${env:...}` references, filled from the session's `KANGENTIC_MCP_BRIDGE_SCRIPT`, `KANGENTIC_MCP_URL` and `KANGENTIC_MCP_TOKEN`, which cross into the distro through `WSLENV`. That Cursor fills references in `command`, `args` and `env` comes from Cursor's MCP docs ("Config interpolation"); only the `url` and `headers` case was measured, by the answer path. The CLI path is the project's, so every session sharing a folder shares the entry.

A Knowledge Graph answer from a distro starts in a stable folder beside the shared answer home, `<home>-wsl-<distro>` (`cursorAnswerHome`), so its entry never overwrites the one a Cursor on this machine reads. Beside it rather than inside, in case Cursor looks for a `.cursor` folder above the one it starts in. Its chat is removed from the distro's `~/.cursor/chats`. Not yet run against a Cursor installed in a distro.

## Model override

`--list-models` prints `cursor-grok-4.6-high - Grok 4.6`. The picker shows the display name. A live session's stream-json init event and `agent about --format json` report that display name as `model`, not the id. A column that stored `grok 4.6 high` used to be passed through as `--model "grok 4.6 high"`, which the CLI rejects.

`resolveCursorModelId` maps the stored value onto the last `--list-models` catalog before `--model` or `/model` is emitted: exact id, display name, dashes-as-spaces, then a unique `cursor-` prefix or unique suffix. The stream-json init event and `agent about` keep the display name on the pill and store the resolved id. Display names with spaces are not written into `discoveredModelsByAgent`, so they do not reappear as picker rows.

## Permission Modes

| Mode | Behavior | Cursor Mode |
|------|----------|-------------|
| `default` | (no special flag) | Interactive (Confirm Changes) |
| `acceptEdits` | `--trust --force`, session screen stays open | Interactive (Skip Approvals) |
| `bypassPermissions` | `--trust -p ... --output-format stream-json` | Non-Interactive (Full Access) |

## Limitations

- No hooks wired and no structured status pipeline (PTY silence timer only). The CLI does run hooks: it reads the same `<project>/.cursor/hooks.json` and `~/.cursor/hooks.json` as the editor, and Cursor's forum lists `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `postToolUse`, `stop` and `sessionStart` as working in the CLI, with reports of hooks not firing on some Linux and Windows builds. Kangentic wires none. None of those events marks a wait on the user either (its AskQuestion tool raises no hook, stream event or file), so a Cursor wait stays on the envelope (GitHub #452). Interactive occupancy is read from the TUI status bar (`Composer 2.5 · 7.8%`) in `stream-parser.ts`, not from a statusline command.
- No settings merge. Workspace trust is the `--trust` flag on every spawn except confirm-changes (and on those resumes), not a file Kangentic writes. Confirm-changes leaves Cursor's own prompt so the user can decide.
- Kangentic's MCP server reaches every session through the project's `.cursor/mcp.json` (a static
  `${env:...}` entry beside the user's servers, `project-mcp-config.ts`) and `--approve-mcps`, which
  also approves the user's own project servers for that run. The entry is removed when the last
  session in the folder exits. A `.cursor/mcp.json` Kangentic cannot parse as a JSON object (one
  with comments, say) is left untouched, and that start gets neither the entry nor
  `--approve-mcps`; a workflow's agent refuses to start there and says why.
- Interactive mode prints no session id. A workflow's agent on Cursor gets one before launch
  instead: `createSessionId` runs `cursor-agent create-chat` in the project folder (measured: it
  prints the bare UUID and writes nothing under `~/.cursor`), and the start opens that chat with
  `--resume=<id>` plus the first message. Whether `--resume` opens a chat made this way in an
  interactive session, and keeps it across a Pause, has not been run live yet. A task or Command
  Terminal in interactive mode still starts without an id, so it cannot be resumed.
- No `transcript-cleanup.ts` (uses streaming text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null. The location is no longer unknown - Cursor writes
  `~/.cursor/projects/<cwd-slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl` plus a per-session
  `store.db` - but two things block wiring it in: the records carry NO timestamp, and the stored
  text is WRAPPED (`<user_query>...</user_query>`) rather than the raw submitted text. See
  [Cursor](../../architecture/automations/command-injection-support-matrix.md#cursor-located-not-yet-verified). Cursor was
  also measured as turn-end flushed, so it gets no `command-injection` verifier either.
