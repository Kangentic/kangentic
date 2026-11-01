# Automations

## Engine

* [Transition engine](transition-engine.md) - The task-move priority ladder (To Do, Done, auto_spawn off, live session, no session), the four live-session cases, the six automation adapters and their fields, isolated bounded recorded runs, the Template Variables table, AbortSignal cancellation, plan_exit_target_id and cross-agent handoff.
* [Automation triggers](triggers.md) - How enter, turn_end and exit automations run: why exit runs before the priority ladder under a 60 second budget, what counts as an agent turn end, Condition, Text match and Frequency checks, and the per-task automations_disabled switch.
* [Automation agent](automation-agent.md) - The headless agent that answers a column's Agent evaluation Conditions, judges a workflow step done, and names tasks and Command Terminals: how resolveAutomationAgent picks it with no fallback, what is skipped while it is unset, its cached CLI detection, and the two-at-once check limit.

## Message delivery

* [Command injection](command-injection.md) - How a column message reaches a live agent: the settings delta that restarts instead of typing /model, the verifier contract, the four-rung delivery ladder, handshake keystrokes (Ctrl+U, one Esc, retried Enter), the prompt-draft ledger, the automated keystrokes guard, outcomes, awaited exit delivery, test coverage and the file map.
* [Command injection support matrix](command-injection-support-matrix.md) - Which adapters verify delivery (verified, confirm-only or none), why escalation needs a measurement plus an in-app proof, the recipe for graduating an adapter, per-adapter limits (OpenCode remote, Copilot global history, Aider), delivery modes, and the measured delivery rate.
* [Command injection measurements](command-injection-measurements.md) - Why a verifier must be measured before it is written, the paired short and long turn trial in measure-injection-flush.mjs, and the live flush latency per agent (Claude, Codex, Qwen, Cursor, Gemini, Droid) against the 4000 ms delivery budget, with each verdict.
