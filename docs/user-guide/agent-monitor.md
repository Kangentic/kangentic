---
type: Guide
title: Agent Monitor and usage stats
description: The Agent Monitor (Mod+Shift+M) that watches every agent across all projects, with card, table and list layouts, grouping, filters, live output peek and in-place task detail, plus the Usage Stats dashboard (Mod+Shift+U) with cost and token metrics, ranges and background calls.
tags: [monitor, usage, cost, tokens, agents]
sources:
  - resource: src/renderer/components/monitor/
  - resource: src/renderer/components/stats/
---
# Agent Monitor and usage stats

## Usage Stats Dashboard

Open the usage dashboard from the chart icon in the title bar or with `Mod+Shift+U`. It replaces the old status-bar token/cost strip with a full-page view of agent usage:

- **Scope** - the current project, or an app-wide rollup across every registered project (with a per-project comparison table).
- **Metric** - toggle between cost and tokens. The two views chart different things. The Cost view shows cost per day by model and the cumulative spend. The Tokens view reads the same per-turn ledger as the Tokens tile, so its bars add up to that tile: tokens per bucket by model, then the cache hit rate per bucket (cache read over all input), which is what makes a week expensive without more work. The Burn Rate tile and its sparkline follow the metric too, with the other rate as its sub-line. The breakdown lists rank by the selected metric, with the other one in each row's tooltip. In the per-project table the Tokens view swaps Cost and Cost Share for Cache Read and Token Share.
- **Range** - Live (trailing 2 hours), Today, This Week, This Month, All Time, or a custom month range. Click a day in a chart to drill into that single day.
- **Breakdowns** - by model, by agent, by reasoning effort, and, when a session fanned out to subagents, by subagent type, alongside KPI tiles (cost, tokens, sessions, tool calls, line churn, files, cache reads, compactions, burn rate, average active time, subagent tokens) with "vs previous period" deltas. The Subagents tile's tooltip adds how many of those subagents another subagent spawned, and names any agent in the range that cannot report subagent usage at all - only Claude can today, so a Codex or Gemini range says so rather than showing a dash that looks like "nothing fanned out".

- **Background** - the headless agent calls Kangentic makes for you: Condition checks (Agent evaluations; a Text match makes no call), workflow step checks, Knowledge Graph task summaries, task titles and Command Terminal names. A card under the tiles shows the range's total and each job's calls and model, in the selected metric. Below the burn rate chart, "Background calls by day" lists each day and job with all four token types, failures, average time and cost. None of these calls is a session, so none of it is added to the tiles above. An agent whose CLI reports no usage shows a dash, never a zero.

Totals are read from the durable usage ledgers, so they survive task and session deletion. The selected range and scope persist across app restarts (one global value shared across all projects).

Two things the numbers do NOT mean, both said on the tiles themselves. Cost is API-equivalent list price for the tokens each agent reported, not what a subscription was billed, so a subscription session can report $0. And tokens are counted per turn and kept apart by type (fresh input, output, cache write, cache read) because cache reads are far larger and far cheaper than fresh input; per-turn counting started later than cost did, so a long range covers less of it, and the Tokens tile says from when.

## Agent Monitor

Open the monitor from the activity icon in the title bar or with `Mod+Shift+M`. It answers "what are all my agents doing right now?" in one place, across **every** registered project rather than just the one whose board is open. The title-bar icon itself is the ambient signal: green while any agent anywhere is working, amber the moment one starts waiting on you.

Each card is the board card, with one strip added across its top for what the board's lane would otherwise say. The strip names the project on the left, then the workflow for a workflow task, and on the right draws the task's step track with its current column as the column's own icon, as a Workflows canvas card does. A task whose automations are paused adds the board's **Automations paused** strip above it. Under the strip are the board card's title row (the activity mark, the board card's own envelope, speech bubble or crested shield for an agent waiting on you, whose tooltip says what the agent is doing, the ticket number when Ticket Numbers is on, and the green globe while the task's browser is running), its PR link, labels and footer. The footer says **Starting agent...**, **Queued...** or **Paused** as the board card's does (or, for an agent that streams no live telemetry, says so in place of the spinner), and a card waiting on you dims and pulses like one. Four tiles across the top count what needs you, what is active, what is paused, and how many projects have something live. The needs-you tile counts a question, an approval and a finished turn together, as the sidebar does; the cards say which is which. The tiles follow the Projects filter, so a scoped view counts only the projects in view.

The list layout ends each row with the same facts turned sideways: **Automations paused**, then the workflow's name and step track, each when it applies, so a held workflow task shows both. The table adds a **Workflow** column and an **Automations** column, where Paused is the one value marked and the rest read On, and names the agent, model and permission mode in the Column Manager's words. An unset model, effort or permission reads Default.

The slot under each card's title follows the same Card Preview setting as the board card (Settings > Task), and renders it the same way. A session with an agent on it shows what that agent is doing, in a shaded terminal panel: its latest message wrapped, or its recent messages one line each. When it has not said anything yet, or it is a Command Terminal with no task, that same panel carries a **live output peek** instead, the last few rendered lines of the session's terminal. The peek updates in place as the agent works (at most twice a second, and only when the visible text actually changes), so you can see what a session is saying without opening it. A paused or finished session shows the task description instead, as does every card when Card Preview is set to the task description. A Command Terminal has no task to describe, so it keeps its last output peek in both of those cases. The terminal panel is a fixed height whichever of the two it carries, so a card never resizes as messages land.

Command Terminals (`Mod+Shift+P`) appear here too. They are the one thing the board cannot show you - they belong to no task, so before now a Command Terminal left running in another project was invisible. Each starts as `Command Terminal N` (matching the number on its own window) and takes a name from its first prompt when an Automation agent is set up in Settings > Workflows, and keeps the number without one. A name you give it (the pencil after its title, or Rename in its `...` menu) replaces either, and shows on its row here too. It draws a terminal-shaped activity glyph rather than the agent one, and its strip names the **branch** it is working on in the slot where a workflow task names its workflow.

You choose how it looks, and the choice is remembered (including across a restart):

- **Layout** - cards (which reflow into 2 or 3 columns as the window widens), a dense sortable table, or a one-line-per-session list.
- **Grouping** - by status (Idle / Active / Paused / Recently finished) or by project. Rows are always sectioned, which is what keeps anything waiting on you at the top without you having to sort for it.
- **Sort** - Oldest or Newest, applied within each section. The table layout sorts by its own column headers instead.
- **Filters** - a project scope multi-select that narrows the whole view (list and tiles) to a chosen subset of projects; its pill reads "All projects" until narrowed (then e.g. "2 of 5 projects") and appears once more than one project has sessions, staying while narrowed - as long as any project has a session - so Clear is always reachable. Plus a text filter across title, project, column, agent, model, ticket number and labels, and a "Live only" toggle that drops paused and recently finished sessions.

Clicking a row opens that task's full detail - terminal included - **in the monitor**, so several agents across several projects can be watched and driven from one surface without leaving for another project's board. Right-click a row and choose **Open on board** for the old behavior. A task's detail is only ever open in one place: opening it somewhere else moves it rather than making a second copy, and its tab leaves the bottom panel while it is open.

The rest of a row's right-click menu is the board card's own menu. Move to, Backlog, Archive, Delete, and Pause or Resume session act on the task's own project. Delete always asks first, and Backlog asks first when the task has a session or worktree to clean up. Both honor the same Don't ask again setting as the board. A change made from the monitor, or from a detail open in it, shows on the board in the main window right away, whichever monitor made it.

Clicking empty space anywhere in the monitor - its list, header, summary cards, or filter bar - closes a detail open there, following your [Close on Outside Click](settings.md#behavior-settings) setting. It is scoped to the monitor, so it never reaches through to a task window open on the board underneath.

The pop-out button detaches the monitor into its own window, which is the intended way to keep it on a second monitor. The detached window lays out by its own width, so it stays readable narrow while the in-app view fills a wide screen.

Whatever you have open in the monitor follows it. Detaching carries your open details into the pop-out, closing the pop-out hands them back to the in-app monitor, and the arrangement survives a restart - the same way board and Command Terminal layouts do. Nothing stays running in the background: closing the monitor unmounts its terminals (the agents keep working, and their tabs return to the bottom panel), and reopening it restores what you had.

Two things are deliberately left out of that restore, because the monitor is for watching agents that are still working: a task you have since opened on the board stays where it is rather than being pulled back in, and a detail whose agent has finished is not reopened. You can still click a finished session's row to look at it; it just will not come back on its own.
