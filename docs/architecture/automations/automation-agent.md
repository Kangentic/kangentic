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
