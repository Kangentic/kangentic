---
type: Reference
title: Auto-name (summarize)
description: How summarize names tasks and Command Terminals on the Automation agent, the per-agent title invocations (answer run or runCliPrintSummarize), the 30 second automatic rename, the hourly rate limit and the asked-task set, and how to add summarize to a new adapter.
tags: [agents, auto-name]
sources:
  - resource: src/main/agent/shared/auto-name.ts
  - resource: src/main/agent/shared/cli-print.ts
  - resource: src/main/agent/shared/summarize-rate-limit.ts
  - resource: src/renderer/lib/auto-name-scheduler.ts
  - resource: src/renderer/components/NameFromPromptButton.tsx
---
# Auto-name (summarize)

Suggests a task title from the task description, and names a Command Terminal from its first prompt, via each adapter's optional `summarize?(prompt, cliPath, cwd, options)` method. Both run on the **Automation agent** (Settings > Workflows, `AppConfig.automation`), at its model and effort, never on the project's default agent: the project default was Opus at xhigh, the top tier for four to eight words. With no Automation agent, or one whose adapter has no `summarize` (Warp has no headless run; Aider, Ollama and Goose have headless answer runs but no summarize yet), naming is off: the renderer hides the button and never schedules the automatic rename, a Command Terminal keeps "Command Terminal N", and main's handler refuses the call. A Command Terminal the user renamed (`session:renameTransient`) is never named: the namer returns before it spends an agent call or a rate-limit slot on it. Renderer and main read the same predicate, `namingAgentReady` (`src/shared/answer-agent.ts`), and main resolves the agent through the resolver Condition checks use (`src/main/automations/automation-agent.ts`), so the detection cache and the effort rule exist once.

## Surfaces

- **`<NameFromPromptButton>`** (`src/renderer/components/NameFromPromptButton.tsx`) is a square Sparkles icon button placed alongside the title input (not inside it). It exposes a `useNameFromPromptAvailable(description)` hook and is used by `NewTaskDialog` and `TaskDetailEditForm`. The button shows only when the Automation agent can name tasks (`namingAgentReady`) and the description is non-empty.
- **Automatic rename** (`src/renderer/lib/auto-name-scheduler.ts`, scheduled from `App.tsx`) runs once per placeholder-titled task (`fix`, `wip`, etc., or empty), 30 seconds after its agent starts, in any project. It generates a title and applies it at the agent's next idle moment, never mid-turn, because the save also renames the task's branch and a branch cannot move under a running agent. It skips the save if the user renamed the task meanwhile. A timed "Task renamed" toast follows, only for the open project, and a click on it opens the task. The "already named" set is persisted in `AppConfig.autoNameAskedTaskIds` (drained on task delete), written only once a task proves nameable, so a restart never renames a task twice. The request carries the task's project and task ids, read when it was scheduled.

## Implementation

Implementations live next to each adapter. The run's `cwd` is the shared answer home (`ensureAnswerHomeDirectory`), never the project: a title needs nothing from the repository, and a project root loads the agent's instructions into every call. Two shapes:

- **On the answer run.** Gemini, Copilot and OpenCode call their own `answerFromContext` with `buildSummarizePrompt` and clean the reply with `titleFromAnswer` (`src/main/agent/shared/auto-name.ts`). That run already carries the agent's read-only flags and removes the session it leaves, so naming gets both from one place. Each was measured turning the title prompt into a clean title there (2026-10-13: Gemini 3.6 s, OpenCode 7.1 s, Copilot 8.0 s). It runs under the answer run's 120 s bound rather than the title runner's 15 s.
- **On the title runner.** The rest call `runCliPrintSummarize`, the title shape of the headless runner (`runCliPrint`, `src/main/agent/shared/cli-print.ts`). Each takes the model (and effort, where its answer run has one) and trust flags its own `answerFromContext` uses, plus those of that run's read-only and no-session flags that leave its mode alone. A mode change waits for a title measured in that mode: Antigravity's plan-mode answer run, given the title prompt, searched the web twice, tried a shell command and came back empty after 41 s and 36k tokens. Codex, Cursor, Grok, Qwen and Kimi could not be measured on the machine that tried (logged out, an outdated CLI, a provider error, no model set), so Cursor still runs with write tools and keeps its chat, Kimi still runs without plan mode, and Grok keeps its session file.

| Agent | Invocation | Prompt delivery |
|-------|-----------|-----------------|
| Claude | `claude --print --no-session-persistence --permission-prompts none --tools '' --strict-mcp-config --settings <file> --output-format json [--model] [--effort]`, the answer run's flags (`answerArgs`), with no plan mode, which rerouted a Haiku request to Sonnet | stdin |
| Codex | `codex exec --skip-git-repo-check --sandbox read-only --ephemeral [--model]` | stdin |
| Gemini | Its answer run: `gemini --skip-trust --output-format stream-json --approval-mode plan --session-id <uuid> [--model]`, the chat removed after | stdin (non-TTY headless) |
| Qwen Code | `qwen --output-format text --chat-recording=false [--model]` | stdin (non-TTY headless) |
| OpenCode | Its answer run: `opencode run --agent plan --format json --pure [--model]`, the session deleted after | stdin |
| Kimi | `kimi --print --quiet [--model]` | stdin |
| Cursor | `agent --trust --output-format text [--model] -p "<prompt>"` | positional arg |
| Droid | `droid exec -o text [--model] "<prompt>"` | positional arg |
| Copilot | Its answer run: `copilot --silent --output-format json --stream off --session-id <uuid> --no-ask-user [--model] [--reasoning-effort]`, the session folder removed after | stdin |
| Grok Build | `grok --output-format plain --deny Write --deny Edit --deny Bash --no-subagents --disable-web-search --no-memory [--model] [--reasoning-effort] -p "<prompt>"` | positional arg |
| Antigravity | `agy -p "<prompt>" --output-format json [--model] [--effort]` through a hidden PTY (`agy -p` hangs without a TTY, upstream #318); runs in a pre-trusted scratch cwd so it never touches the project workspace's `agy -c` mapping. It removes the conversation the run made and reports the result's `usage` | flag arg |
| Warp | (no headless run) | n/a |
| Aider | (headless answer run only; summarize not wired) | n/a |
| Ollama | (headless answer run only; summarize not wired) | n/a |
| Goose CLI | (headless answer run only; summarize not wired) | n/a |

## Configuration knobs

- `AppConfig.autoNameAskedTaskIds: string[]` - persisted "don't re-ask" set, drained when a task is deleted (`drainAutoNameAskedIds` in `src/main/ipc/helpers/task-delete.ts`, reached from the single delete, a workflow delete's never-started deletions, and the bulk delete handler in `task-crud.ts`).
- `AppConfig.autoNameRateLimitPerHour: number` (default 60, 0 disables) - sliding-window cap on summarize CLI calls per hour. One window is shared by task titles (`agent:summarize`) and Command Terminal names (`src/main/agent/shared/summarize-rate-limit.ts`).

## Verification

`node scripts/probe-summarize.js` runs each detected adapter's `summarize()` against a sample description and reports success / timeout / format issues. Run it after installing or upgrading an agent CLI to confirm Kangentic's invocation still produces a sane title.

## Adding summarize to a new adapter

First run the title prompt through the adapter's own `answerFromContext` against the real CLI, in an empty folder. If it comes back as a clean title, `summarize()` is `titleFromAnswer(await this.answerFromContext(buildSummarizePrompt(prompt), cliPath, cwd, options?.model, { effort, runDirectory, onUsage }))`, and the answer run's read-only flags and cleanup come with it. If it explores, comes back empty or runs long, import `runCliPrintSummarize` and `buildSummarizePrompt` from `../../shared/auto-name` instead and choose the right `args`, `promptVia`, and (if needed) `extractRaw`. Mirror the pattern in `tests/unit/agent-summarize-shape.test.ts`, and set `supportsSummarize: true` on the agent's entry in `tests/ui/mock-electron-api.js`.
