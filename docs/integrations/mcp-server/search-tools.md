---
type: Reference
title: Search tools
description: kangentic_search's unified keyword and semantic search over tasks, backlog, session events, conversations, commits and projects, with groupBy task and relatedToTask rankings, the Ask caller's four-search budget, and the board-scoped kangentic_search_tasks.
tags: [mcp, search, semantic]
sources:
  - resource: src/main/agent/mcp-http/search-tools.ts
  - resource: src/main/agent/mcp-http/task-tools.ts
    title: kangentic_search_tasks registration
  - resource: src/main/agent/mcp-http/answer-search-trace.ts
  - resource: src/main/agent/commands/search-commands.ts
  - resource: src/main/search/search-core.ts
  - resource: src/main/retrieval/related-work.ts
  - resource: src/main/retrieval/commit/commit-search.ts
---
# Search tools

## kangentic_search_tasks

Search by keyword across both the board (active + archived tasks) and the backlog. This is the default tool for finding a task by title, description, or backlog label - it covers items whether or not they have been promoted from backlog to board. Use `scope` to narrow to a single surface.

A query of the form `#<number>` (e.g. `#42`) is a ticket lookup instead of a text search: it matches board tasks whose display ID (`#N`) prefix-matches the number (`#4` matches #4, #40, #41, ...) and returns no backlog items (they have no display ID). For an exact single-task lookup by number, `kangentic_find_task` with `displayId` is more direct.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keyword (case-insensitive). Backlog hits also match on labels. A `#<number>` query (e.g. `#42`) is a ticket lookup: board tasks by display-ID prefix, no text/backlog match. |
| `scope` | `'board' \| 'backlog' \| 'both'` | No | Which surface to search. Defaults to `"both"`. |
| `status` | string | No | Filter board hits: `"active"`, `"completed"`, or `"all"` (default). Ignored for backlog hits. |

Results are grouped under `Board (N):` and `Backlog (N):` sections so the agent can see at a glance which surface each hit came from. Board and backlog hits both render their labels as `[a, b]`, omitted when there are none. Note the asymmetry in *matching*: backlog items match on their labels, board tasks match on title and description only, so a board task is not found by searching for one of its labels.

## kangentic_search

The single unified search tool for agents. One query across the active project (or all registered projects) covering: board tasks (active + archived, title and description), backlog items (title and description), session events (the structured tool_start/tool_end/idle stream from agent runs), past agent conversations, commits on the default branch, and project names/paths. Returns a per-kind grouped result with snippets so an agent can pinpoint the matching task, backlog item, session event, conversation turn, commit, or project in one call instead of issuing `kangentic_search_tasks` + `kangentic_get_session_events` separately. (`kangentic_search_tasks` already spans board + backlog within a single project; reach for `kangentic_search` when you also need session events, past conversations, commits, semantic matching, or cross-project scope.)

A query of the form `#<number>` (e.g. `#42`) is a shortcut for a ticket lookup: it returns only board tasks whose display ID (`#N`) prefix-matches the number (`#4` matches #4, #40, #41, ...), skipping the backlog, session-event, conversation, commit, and project kinds entirely. This mirrors the desktop Quick Find palette and board search box, where the same `#<number>` syntax filters by ticket number.

Conversations are matched by **meaning** and keyword by default (`mode: "hybrid"`, semantic embedding fused with keyword): the "have we solved this / seen this before?" recall path over past agent conversations. `mode: "keyword"` matches literal words only. `mode` affects only the conversation corpus; tasks, backlog, session events, and projects are always keyword. Both modes fall back to keyword transparently when the conversation embedding layer is off. Conversation hits carry a `sessionId` + `turnUuid`; follow up with `kangentic_get_transcript` (`aroundUuid`) to read the neighboring turns.

Defaults to scoping the search to the active project. Pass `scope: "all"` to widen across every registered project (which also surfaces project-name hits so the agent can discover routing targets). Passing `project` forces `scope: "current"` since explicit project routing already specifies the target.

Conversation hits come from the structured transcript index (`memory_chunks` FTS5 + the sqlite-vec embeddings for semantic ranking), not the raw scrollback blob; they appear only when `knowledgeGraph.indexingEnabled` is on (the default), and rank semantically only when the embedding layer (`knowledgeGraph.enabled`) is also on. Per-kind hit caps prevent runaway results: 30 tasks, 20 backlog items, 50 session events, 10 projects, 20 conversations, 10 commits per project. When the index is off the message ends by saying conversations and commits were not searched; when `mode: "hybrid"` found no local model to embed with, it says conversations were matched by keyword only.

A `## Commits` section lists the default branch's commits the query matches (`src/main/retrieval/commit/commit-search.ts`): by keyword on the subject and body, and, for a query of 7 to 40 hex digits, by sha prefix as well. The sha lookup only adds commits; a bare number keeps every other kind's text matches. Each row names the task the commit is linked to (`from #529 ...`), or says none is, and the section closes by saying the link is where the subject was first written. It needs the index on, and it is skipped for a `#N` ticket lookup. For an answer caller, a commit hit's task is reported with the search, so the map rings that task's conversations.

Pass `taskId` to restrict conversation and commit hits to one task's history - e.g. "what was discussed in task #286 about X, and how does that affect the current work?" Resolve the display `"#N"` to its internal id first with `kangentic_find_task` or `kangentic_get_current_task`. `taskId` only scopes conversation and commit hits; task/backlog/session-event/project hits are unaffected. Lexical matching filters by task in the FTS query itself; semantic matching over-fetches a wider vec0 candidate set and narrows it to the task afterward (sqlite-vec has no per-query `WHERE` filter).

This tool consolidates what were previously two tools (`kangentic_search_everything` + a separate `kangentic_recall`) into one, per Anthropic's tool-design guidance that related retrieval operations belong in a single tool with a parameter rather than several overlapping tools.

Pass `groupBy: "task"` to rank TASKS instead of listing hits. Every conversation passage, task record and commit that matches the query (deep semantic and keyword pools, the records on the conversations' relevance scale, the default branch's commits by keyword only, each counted toward the task that wrote it) is rolled up per task, and the tasks come back strongest first, each with its relative strength, how many passages matched, the dates they span, its `taskId`, and its facts on one line (cost, duration, tokens, conversations, files, lines, outcome, pull request; a fact never recorded is left out). The first twelve also carry the task's summary where one was written, its best passage, and a `sessionId` and `turnUuid` to open when a conversation matched; the rest are one line each. The response stops at 30,000 characters and counts the tasks it left out. A task reached only through its own record has no conversation to open. An answer caller gets the lean rows (no facts, no summaries): its prompt already holds every task's facts and the related tasks' summaries. It is the answer to "which tasks touched X?", "how many times did we change Y?" and "what is most related to Z?", which a capped list of snippets cannot count or rank. It is the same rollup the Knowledge Graph's Ask runs before its agent starts (`src/main/retrieval/related-work.ts`). It ranks one project at a time, so it refuses `scope: "all"` and `taskId`, and it needs conversation indexing on. Omitting `groupBy` (or passing `"kind"`) leaves the output exactly as above.

Pass `relatedToTask` (`"#N"`, `"N"`, or the task id) to rank the tasks most like one task, its prior and related work: "has anything like this been done before?" It is the opposite of `taskId`, which searches inside one task. The task's title and description (cut to 1,200 characters) are embedded as ONE query vector, since every vector costs a scan of every conversation vector in the retrieval worker, and its keywords are its title's. The task itself is left out of the ranking, conversations and record alike, so strength is measured against the best other task. It returns at most twelve rows in the same format as `groupBy: "task"`; a `query`, if given, focuses the ranking. `query` is optional with it. It refuses `taskId`, `groupBy: "kind"` and `scope: "all"`, and says so when the task is not on the board or the index is off.

It is also the ONE tool the Knowledge Graph's Ask offers an answering agent that can use a tool. That run's MCP URL carries an `answer-<chatId>` caller segment, and for such a caller the server registers `kangentic_search` and nothing else, so the agent cannot create, move or delete anything whatever its own permission flags. Such a caller gets four searches per question (`ANSWER_SEARCH_BUDGET`); a fifth returns "This question has used its 4 searches" and asks the agent to answer from what it already found. Its searches read only the projects the question was asked across: `scope: "all"` covers those alone, a `project` outside them is refused with their names, and a refused call spends none of the four, nor does a `relatedToTask` that names no task. A run still searching after its question ended reads only the project its URL names. Each search it makes is reported to the Knowledge Graph, which shows it as a step in the chat and rings the conversations it found. See [Conversation memory and Knowledge Graph](../../user-guide/knowledge-graph.md) in the user guide.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Unless `relatedToTask` | Search keyword or phrase, or (in `mode:"hybrid"`) a natural-language description of what you are looking for. Case-insensitive. A `#<number>` query (e.g. `#42`) is a ticket lookup: only board tasks by display-ID prefix. A call with neither `query` nor `relatedToTask` is refused. |
| `scope` | `'current' \| 'all'` | No | `"current"` (default) searches only the active or `project`-routed project. `"all"` widens to every registered project. Ignored (forced to `"current"`) when `project` is set. |
| `mode` | `'keyword' \| 'hybrid'` | No | How conversations are matched. `"hybrid"` (default) fuses keyword + semantic embedding; `"keyword"` is lexical-only. On an Intel Mac, where the local model cannot run, hybrid answers by keyword (see [Knowledge Graph](../../architecture/knowledge-graph.md)). Only affects the conversation corpus. |
| `taskId` | string | No | Restrict conversation and commit hits to this task's internal id (not the display `"#N"`). Other hit kinds are unaffected. |
| `groupBy` | `'kind' \| 'task'` | No | `"kind"` (default) returns hits grouped by kind. `"task"` ranks the tasks whose conversations, own records (title, labels, description, summary) or commits are about the query, strongest first, with their facts, so a task with no indexed conversation still ranks. One project only: refused with `scope: "all"` or `taskId`. |
| `relatedToTask` | string | No | Rank the other tasks most like this one (`"#N"`, `"N"`, or the task id): up to twelve rows like `groupBy: "task"`. Refused with `taskId`, `groupBy: "kind"` or `scope: "all"`. |
| `project` | string | No | Project selector (name or UUID). Defaults to the URL-path project. Forces `scope: "current"`. |
