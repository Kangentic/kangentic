---
type: Reference
title: Workflow agent
description: "The transient session that plans a workflow: which agents qualify (per-session MCP, resumable ids), its read-only MCP scope, why there is no fallback to the project agent, start-over from the saved plan, and how its first message, model and effort are read on every start."
tags: [workflows, agent, planning, mcp]
sources:
  - resource: src/main/workflows/workflow-agent.ts
  - resource: src/main/workflows/workflow-agent-prompt.ts
  - resource: src/main/workflows/workflow-agent-record.ts
  - resource: src/main/workflows/workflow-agent-effort.ts
  - resource: src/shared/workflow-agent-choice.ts
    title: workflowAgentSetupGap
  - resource: src/shared/workflow-agent-first-open.ts
    title: awaitsFirstAgent
---
# Workflow agent

Every workflow has its own agent, a transient session that plans the workflow's tasks and links and
changes them when asked. It is chosen in Settings and started from the workflow's view.

## Settings > Workflows

Settings > Workflows, first in the Advanced tier. Global-only: it applies to every project and works
with no project open. Its first card is the **Workflow agent**, which every workflow's own agent
runs on, then that agent's first message, then the **Automation agent**, which answers every
Agent evaluation (and judges when a workflow step is done) and names tasks and Command
Terminals. With no Automation agent, naming is off. The two agents are separate choices. A judge
that answers yes or no, or writes a four-word title, runs well on a small model that a planner
should not.

The `workflows.*` and `automation.*` keys, with their types and defaults, are listed in
[App config keys](../../settings/app-config.md#workflows-and-automation).

**The two agent cards are registry entries, not config keys.** `automation.agentCard` is the Automation agent card, so Settings search finds it by "automation", "condition", "workflow step", "name", "title", "auto-name", "rename" or "command terminal" and lands on the whole card. Its three rows are the `automation.agent`, `automation.model` and `automation.effort` entries above. `workflows.agentCard` is the Workflow agent card, found by "workflow", "planner" or "plan", whose rows are `workflows.agent`, `workflows.model` and `workflows.effort`.

**The pane starts the agent on its own once the choice is made.** It waits for the setting to be complete and for Settings to be closed, then starts the agent with its first message. This applies to a new workflow with no tasks yet. A workflow with tasks and no agent recorded (another session saved its plan, or its tasks were added by hand while the agent could not start) starts nothing on that close; its pane waits for Ask for changes. Closing Settings is the trigger, so an Effort picked after the Model still makes the first run. While a complete setting waits on that close, the pane says the agent starts when Settings closes. It does not wait for the agent list: main checks the setting too. A start main refuses, for want of the setting or for a reason it gives (the CLI not found, the MCP server off), waits for the next Settings close and then tries once more. A Settings close never re-opens a pane that already opened, so an agent that exited is not resumed unasked.

## The planning session

**The workflow agent is a transient session carrying `workflowId`** (`src/shared/session-owner.ts`).
Transient keeps it out of everything a task session drives: `sessions.task_id` is a foreign key to
tasks, so its conversation is recorded on the workflow instead (`agent_name`, `agent_session_id`).
`isCommandTerminalSession` keeps it out of what a Command Terminal has: the title-bar count, the
slot cap and re-pairing, window reconciliation, the Monitor, the name from its first prompt, the
leftover reap, and the phone's terminal list, lifecycle feed and push. Main ends a Command
Terminal whose PTY exits or is suspended; the workflow agent keeps its row, as a task's agent
does, so its Pause leaves a paused pane and an exited row tells the pane to start it over. The
agent-absence sweep judges and retires it like a task's agent, and its processes carry its
workflow's id as their `KANGENTIC_TASK_ID`, which no task shares. While it runs it holds an agent
slot under Max Concurrent Sessions, as a Command Terminal does, and its Pause frees it. It runs in
the home project's checkout with an MCP URL whose caller segment is `workflow-<id>`, for which the
server registers only the read-only tools and the planning tools, bound to that workflow
(`workflow-agent-scope.ts`). That scope is the guard for every agent. Any agent can be it whose
adapter delivers Kangentic's MCP per session (`kangenticMcp: 'per-session'`) and whose
conversation can be resumed, by an id Kangentic chose, one the CLI creates before launch
(`createSessionId`, Cursor's `create-chat`), or one captured after launch (`canBeWorkflowAgent`). Where the adapter declares `supportsReadOnlyLaunch` (Claude: `--tools
Read,Grep,Glob,ToolSearch`, `--strict-mcp-config`, `--no-chrome`) it also has no edit or shell
tools; any other runs in its default mode, and the first message asks it to leave files alone.
An id the agent reports after launch, or a Claude `/clear` fork's new one, is recorded on the
workflow by the `'agent-session-id'` listener. A start with no conversation to resume continues
from the saved plan when there is one (`buildWorkflowAgentContinueMessage`, whose reason says
where it came from): on a workflow whose agent already ran (`not-resumed`, and the pane says it
started over), or on a plan no agent of the workflow has seen (`saved-elsewhere`: another
session saved it over MCP, or the user planned by hand while the agent could not start). It is
not resumed at boot; the view's pane opens it. An open on a workflow with tasks and no agent ever
recorded (`agent_name` null) starts nothing and answers `startsOnRequest`; the pane's Ask for
changes starts it through the Resume path, so arrival never holds the plan. The rule is
`awaitsFirstAgent` (`src/shared/workflow-agent-first-open.ts`), which the pane also reads from
the picker's summary to open folded to its strip on that workflow, without writing its own
collapse, and to keep its setup state from promising a start when Settings closes.
