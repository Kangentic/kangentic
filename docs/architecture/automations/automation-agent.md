---
type: Reference
title: Automation agent
description: "The headless agent that answers a column's Agent evaluation Conditions, judges a workflow step done, and names tasks and Command Terminals: how resolveAutomationAgent picks it with no fallback, what is skipped while it is unset, its cached CLI detection, and the two-at-once check limit."
tags: [automations, automation-agent, conditions, naming]
sources:
  - resource: src/main/automations/automation-agent.ts
  - resource: src/shared/answer-agent.ts
    title: automationAgentChoice, automationAgentReady, namingAgentReady
  - resource: src/main/automations/condition-check/condition-check.ts
  - resource: src/main/workflows/workflow-step.ts
---
# Automation agent

One setting, `AppConfig.automation` (Settings > Workflows), picks the agent for two kinds of
headless job (`AutomationAgentJob` in `src/main/automations/automation-agent.ts`):

- `check`: answering a column automation's Agent evaluation Condition (see
  [Condition and Frequency](triggers.md#condition-and-frequency)), and judging whether a workflow
  task's step is done (`src/main/workflows/workflow-step.ts`).
- `naming`: suggesting a task title and naming a Command Terminal from its first prompt (see
  [Auto-name](../../integrations/agents/auto-name.md)).

A judge that answers yes or no, or writes a four-word title, runs well on a small model. That is
why this is its own choice, separate from the [Workflow agent](../workflows/workflow-agent.md), the
Knowledge Graph's agent and the project's default agent. The keys are listed in
[App config keys](../../settings/app-config.md#workflows-and-automation).

## No fallback

`resolveAutomationAgent` resolves the setting through `automationAgentChoice`
(`src/shared/answer-agent.ts`) and never falls back to another agent, so nothing spends on an
agent nobody chose. While the setting is unset or its agent cannot run the job:

- A row with an Agent evaluation is skipped with "Set up an Automation agent in Settings > Workflows
  to check this condition." A Text match Condition is checked in code and needs no agent.
- Naming is off: no automatic rename, no Name-from-prompt button, and a Command Terminal keeps its
  default title.

`automationAgentReady` and `namingAgentReady` are the checks the Edit automation dialog, the engine
and the naming controls read, so the UI and main agree on when a job can run. Each way a job cannot
run has its own sentence per job (`REASONS` in `automation-agent.ts`): no agent chosen, no model
chosen where the CLI takes one, an agent whose adapter cannot do the job, a CLI that is not found,
and a setup that failed.

Each also has a typed `cause`, so no caller matches a sentence. On a not-ok `ConditionCheckOutcome`
it is one of three:

- `unavailable`: a setting a person fixes (the first four above).
- `failed`: a setup that threw, a call that failed, or a time limit that ran out. A later try may
  pass.
- `stopped`: a caller that stopped waiting.

A workflow step reads `unavailable` as a human gate, said once a visit. It records `failed` and
retries it on its recovery's schedule (see
[Workflow engine](../workflows/workflow-engine.md)), and writes nothing for `stopped`.

## The workflow step's asks

Before any ask, a reply whose last line is `Needs owner: <question>` waits on the owner. It is
matched in code (`src/shared/workflow-needs-owner.ts`), so no check runs and none can overrule it.

The first ask is `workflowStepCondition`: is the step done, with the agent not waiting on the user.
It is the wording measured on 2026-10-04, and only its yes moves the task. A yes still moves
nothing when the column's own Text match exit rows refuse the reply (`stepExitVerdict`, see
[Workflow engine](../workflows/workflow-engine.md)).

When it says no, or the rows refuse the reply, the agent's open work decides first. A background
shell it holds, or a subagent running past its turn end, by the hook events
(`SessionManager.getOpenWork`), is still working, with no second call. Anything else is a stall,
and recovery nudges it. A second call asks two blocker Conditions (`workflowBlockerConditions`),
so the nudge can aim at what the reply says the agent is stuck on:

1. `resource`: a command, a test run, a build or the gate was stopped or failed because the
   machine was low on memory or too busy, not because of the code.
2. `main-fails-too`: the failures it is stuck on also happen on the task's base branch, which the
   row names.

A yes changes only what the nudge says. Unsure answers no, as every Condition does, so a reply that
names no blocker gets the general nudge. Both rows are one call. A turn with no reply text is a
stall with no second call.

This replaced a second ask of whether the agent waited on the user or on running work (owner's
decision, 2026-10-31). Measured on 2026-10-25 with `scripts/eval-condition-check.mjs` on 311
not-done turn ends, that ask stopped on 1 and scored 120 of 120 on the cases a stop turns on. It
still read running work from the reply's wording, which once judged one gate still running and,
three hours later, not done. Waiting on the owner is now the agent's own call, made with the
`Needs owner:` line.

## How a check runs

A check runs through the same headless, read-only answer path as Ask (`answerFromContext`, in the
shared answer home), and naming runs the adapter's `summarize`. At most `MAX_CONCURRENT_CHECKS` (2)
checks run at once (`condition-check.ts`). The CLI's detection and effort levels are cached for five
minutes, keyed by agent name plus its CLI path override, so a changed override is found at once; a
discovery that threw is retried after 30 seconds. Checks run at turn ends, which a busy board
produces many of, so probing on every call would cost a CLI launch each time.

## Model and effort

The model is the CLI's own id, and the Model row lists the agent's floating aliases first, so a
picked alias (Claude's `haiku`) follows each new release. The effort is optional. Measured with
`scripts/eval-condition-check.mjs` on Haiku 5.5, an exact-line Condition scored 114 of 114 at low,
medium and high alike, so low is the cheapest at the same accuracy. A Condition that asks for a
judgment scored 78 to 96% at every level: effort does not fix that wording, and an exact line the
agent is told to write does.
