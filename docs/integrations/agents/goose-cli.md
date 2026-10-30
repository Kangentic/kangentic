---
type: Reference
title: Goose CLI
description: Block's Goose CLI with goose run -t -s, goose session and -n/-r resume, approval mode set through the GOOSE_MODE env var (acceptEdits resolves down to smart_approve, plan to chat with no tools), a version parser that rejects the pressly/goose migration tool, PTY-only activity, and questions and approvals read from its OSC 7501 program status.
tags: [agents, adapter, goose]
sources:
  - resource: src/main/agent/adapters/goose/goose-adapter.ts
  - resource: src/main/agent/adapters/goose/detector.ts
  - resource: src/main/agent/adapters/goose/program-status-parser.ts
---
# Goose CLI

Goose is Block's open-source agent CLI (`goose`, https://github.com/aaif-goose/goose). It is a thin first-pass integration, close to the Warp/Ollama adapters: no hooks wired, no structured status/event output, no trust mechanism, and no settings merging. It differs from those two by supporting session resume and by delivering its approval mode through an env var.

"No hooks wired" rather than "no hooks", and the distinction is load-bearing because it is what justifies the PTY-only activity detection below. Goose ships a hook system: plugin-scoped `hooks/hooks.json` discovered from `<project>/.agents/plugins/<name>/` or `~/.agents/plugins/<name>/`, firing `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `PreToolUseResult`, `PostToolUse`, `PostToolUseFailure`, `BeforeReadFile`, `AfterFileEdit`, `BeforeShellExecution`, and `AfterShellExecution`, each handed a JSON payload on stdin carrying `event` and `session_id`. That is the same `.agents/` workspace shape the Antigravity adapter already writes to and a payload close to what `event-bridge.js` consumes, so wiring hooks (and with them structured activity, a session-id capture, and eventually a submission verifier) is a follow-up rather than a blocked path. Until then activity rides the PTY silence timer, with the false-idle exposure that implies.

## CLI Detection

Detection uses the shared `AgentDetector` (via composition) with binary name `goose` and `standardUnixFallbackPaths('goose')`. The official installer puts the binary in `~/.local/bin` on macOS/Linux (covered by those fallbacks) and in `%USERPROFILE%\.local\bin` on Windows, where it is added to PATH and found by `which`.

`parseVersion` REQUIRES a digit immediately after the product name (`goose` or `goose-cli`, optional `v`, case-insensitive). This is a collision defense, not cosmetic: two other tools install a binary called `goose` - pressly/goose, a widely used Go database-migration tool (banner `goose version: v3.24.1`), and the awesome-goose scaffolding framework (banner `goose version 0.0.0`). A scan-anywhere `MAJOR.MINOR.PATCH` match accepts both and reports them as Block's agent CLI, after which Kangentic spawns `goose run -t "<prompt>" -s` against a tool that has no such command. Both impostors put the literal word `version` where Block's clap-generated banner puts the digits, which is the discriminator. `AgentDetector` walks every `which` match in order, so rejecting a foreign banner means detection skips that binary and keeps looking rather than stopping on the wrong one. Same anchoring as `GrokDetector`, for the same reason.

The accept side is deliberately wider than one pinned string, because Goose's published docs show the `--version` command everywhere and its stdout nowhere. A false negative surfaces as a diagnosable "not found" with the raw line logged by `AgentDetector`; a false positive spawns the wrong binary.

## Command Building

`src/main/agent/adapters/goose/goose-adapter.ts`

```
goose run [-r] [-n <sessionId>] -t "<prompt>" -s    # with a prompt
goose run [-r] [-n <sessionId>] -t "<prompt>"       # nonInteractive spawn_agent action
goose session [-r] [-n <sessionId>]                 # promptless / resume
```

- Goose runs in the process cwd (there is no start-in-dir flag), so the PTY's cwd set by the spawn chokepoint is authoritative and no directory flag is passed.
- A prompt uses `goose run -t "<prompt>" -s`: process the prompt, then stay interactive (`-s` / `--interactive`) so the user can continue the session. A promptless spawn opens a bare interactive `goose session`.
- A `nonInteractive` spawn_agent action drops `-s`, which is already Goose's headless one-shot form: run the prompt and exit. Leaving `-s` on would park a fire-and-forget automation in a session that never exits.
- `-n <sessionId>` names the session with the engine-generated id when one is present; `-r` is added to resume that named session. On Windows / non-unix shells, embedded double quotes in the prompt are rewritten to single quotes.

## Session Resume

`supportsCallerSessionId` is `true`. Goose accepts a caller-supplied session name (`--name`), so the engine hands it the id it generated on the fresh spawn and resumes with `-r -n <id>`. No transcript parsing is needed to capture an id after the fact, so `locateSessionHistoryFile` returns null.

## Permission Modes

Goose sets its approval mode through the `GOOSE_MODE` env var, not a spawn flag, so the permission dropdown is delivered via `buildEnv`. The mapping lives in `GOOSE_MODE_BY_PERMISSION`, a `Record` over the full `PermissionMode` union (so a new mode is a compile error rather than a silent wrong-mode spawn), and it maps all six modes below. The dropdown exposes three, one per distinct Goose mode Kangentic can reach; `dontAsk`, `acceptEdits`, and `auto` are not offered there but are still mapped, so a column/lane override or the global default that forces one of them resolves to a valid `GOOSE_MODE`.

Goose has four modes. `approve` (every action needs approval) is stricter than `smart_approve`, so it sits below `default` on the permissiveness ladder the dropdown is ordered by and nothing maps to it.

| Mode | GOOSE_MODE | Goose Behavior |
|------|-----------|----------------|
| `plan` | `chat` | No tools at all. Not merely read-only: the agent cannot read files either, so a plan-mode Goose session reasons without repo access |
| `dontAsk` | `chat` | No tools (not in the dropdown). Goose has no allowlist, so "deny unless allowed" degrades to "deny" |
| `default` | `smart_approve` | File modifications need approval, reads do not |
| `acceptEdits` | `smart_approve` | Not in the dropdown. See below |
| `auto` | `auto` | Modify/create/delete and run shell commands without approval (not in the dropdown) |
| `bypassPermissions` | `auto` | Same as above. The explicit opt-in to full autonomy |

`acceptEdits` is the mode with no faithful target. Everywhere else in Kangentic it means "auto-approve edits, still gate shell commands", and Goose has no such mode: the only way to stop prompting on edits is `auto`, which also stops prompting on shell. It therefore resolves DOWN to `smart_approve` rather than up to `auto`, and this matters more than it looks: `DEFAULT_CONFIG.agent.permissionMode` is `acceptEdits` and `resolveEffectivePermissionMode` falls through task -> lane -> that global without consulting the adapter's `permissions` list, so whatever `acceptEdits` maps to is the out-of-the-box spawn for every Goose session on a fresh install. Mapping it to `auto` made that a fully unattended agent nobody chose. The practical consequence of resolving down is that a Goose agent on default settings prompts on file writes; choose "Auto (Skip All Approvals)" for unattended board runs.

`defaultPermission` is `default`. Model/provider selection is left to Goose's own `--model`/`--provider` flags and `~/.config/goose/config.yaml`; per `cli-features-over-custom-layers.md` the adapter keeps no model list and does not shadow the CLI's model control.

## WSL

A Goose installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`): the session starts in a `wsl -d <distro>` shell with Goose's Linux path, `GOOSE_MODE` crosses into the distro through `WSLENV` with the adapter's other variables, and a Knowledge Graph answer runs through `wsl.exe` too. Goose wires no hooks, no MCP server and no transcript reader, so there is nothing else to route. Built from Goose's published docs; not yet run against a Goose installed in a distro.

## Activity Detection

Runtime activity is PTY-only. The silence timer drives the idle transition; `detectFirstOutput` returns true on any non-empty data (no alternate screen buffer). There is no hook or status pipeline.

### Questions and approvals

From 1.56, Goose's CLI writes a program status escape to the terminal at each change of state, the one place it says it waits on you (GitHub #452). Read from Goose's own source (`crates/goose-cli/src/session/program_status.rs`):

```
ESC ] 7501 ; state=<state>[:kind=permission|question]:app=goose[:msg=<base64>] ESC \
```

`state` is `idle`, `working`, `done`, `error`, `blocked` or `clear`, and `kind` rides only on `blocked`. Goose writes it only when stdout is a terminal and `GOOSE_CLI_PROGRAM_STATUS` is not turned off. `runtime.streamOutput` runs `GooseProgramStatusParser` (`program-status-parser.ts`) over the PTY output, holding a sequence split across chunks, and reports the waits only:

- `blocked` is the permission wait, `kind=question` a question and `kind=permission` an approval. A `blocked` with no kind is left unknown.
- `working` after a wait writes the PTY tracker's own resume event (`prompt`, `PromptReason.PtyActivity`), which clears it.
- `idle`, `done`, `error` or `clear` after a wait writes `interrupted`: it clears the wait and settles idle at once, read downstream as work ended by the user's hand. Never a plain `idle`, which the engine reads as the agent's own turn end and which would run the column's On agent turn end automations for an agent that reports none.

Every other status writes nothing, so the silence timer still ends turns: a `pty` agent's stream events never suppress its tracker, and the silence timer leaves a wait alone because it fires only while the session is thinking. The question text in `msg` is not read. Built from Goose's source; no live Goose session has shown the sequence yet. On Windows, ConPTY passes an OSC 7501 sequence through to node-pty unchanged with either terminator (measured with node-pty 1.2.0-beta.15), though it can move it ahead of printable text written in the same frame.

## Limitations

Every item here is "not wired in this adapter", not "the CLI cannot do it", except where noted.

- No hook plugin installed, so no structured status or event output: the PTY silence timer is the sole idle detection, with the false-idle exposure that implies. Goose's hook system (see above) is the obvious way to close this.
- No MCP wiring, so a Goose session cannot call the `kangentic_*` tools. Goose supports MCP extensions natively (`--with-extension`, `--with-streamable-http-extension <url>`), so this is a follow-up too.
- No settings merge and no trust mechanism (Goose genuinely has no folder-trust gate).
- No transcript parsing or capability discovery, and no `summarize` (auto-name not yet wired).
- `locateSessionHistoryFile` returns null - resume rides on the caller-supplied `--name` instead.
- `plan` mode maps to Goose `chat`, which has no file access at all, so a plan-mode Goose session cannot read the repo it is planning against.
