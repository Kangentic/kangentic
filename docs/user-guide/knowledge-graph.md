---
type: Guide
title: Conversation memory and Knowledge Graph
description: "The on-device conversation index (keyword and semantic search, the conversation viewer with column tabs) and the Knowledge Graph map (Mod+Shift+A): flying the 3D map, colour modes, filters, asking questions, Index card sources, task summaries, source code indexing, and Prior work on a task."
tags: [knowledge-graph, search, embeddings, conversations, summaries]
sources:
  - resource: src/renderer/components/knowledge-graph/
  - resource: src/renderer/components/conversation/
  - resource: src/renderer/components/settings/tabs/KnowledgeGraphTab.tsx
---
# Conversation memory and Knowledge Graph

## Conversation Memory

Kangentic indexes every session's conversation into a per-project, on-device search index, so past agent conversations are recallable without scrolling through old terminals. Indexing is on by default; turn it off or tune it in Settings > Knowledge Graph.

### What Gets Indexed

The structured transcript of each session: user turns, assistant replies (including the narration lines Claude Code prints between tool calls), and tool-call summaries. Raw terminal scrollback is never indexed (for TUI agents it is mostly cursor and redraw noise). A session is indexed when it finishes or suspends, an in-progress conversation is re-indexed at each turn boundary, and older history is backfilled in small sweeps when a project opens.

### Keyword and Semantic Search

Keyword (full-text) search is always available while indexing is on. Turning on the **Knowledge Graph** in Settings > Knowledge Graph downloads a small embedding model once and then runs fully offline (it is unavailable on Intel Macs, see [Knowledge Graph](../architecture/knowledge-graph.md)). The **Search quality** row picks it: **Best** is IBM's Granite embedding English R2 (153 MB), **Light** is bge-small (33 MB). The status row under it reads **Downloading** over a progress track, then **Local model** with the model's name, size and where it runs, or **Download failed** in red, and a **License** line links the model's license. It powers the [Knowledge Graph](#knowledge-graph) and hybrid `kangentic_search` for agents; Quick Find stays keyword-only. Embedding runs in an isolated background process, duty-cycle throttled so backfills never peg the CPU, with a **Model acceleration** setting (Auto / GPU / CPU). Changing Search quality re-indexes in the background by itself. **Rebuild the index**, in the Index card, reads every source again in every project without deleting anything: the open project now, every other one the next time you open it. It is only needed if search misses something you know is there, or after a new agent or model, when it also rewrites the task summaries written the old way. Every failure path (no model yet, slow embedding) degrades transparently to keyword-only.

### Where It Surfaces

- The [Search Palette](board-basics.md#search-palette) shows a **Conversations** group of keyword matches; a hit opens the viewer at the matched turn.
- The **View conversation** pill in the [Task Detail Dialog](task-detail.md#task-detail-dialog) opens the task's live session, or its newest when none is live, directly, no search needed.
- A completed task shows its conversation in its own Conversation tab: a column in its Route opens that tab on the column, and View conversation in an archived card's right-click menu opens the task on it. A viewer window already open for a task is reused: a search hit switches it to All, and the other ways in leave its tab alone.
- Agents read what the Knowledge Graph knows over MCP - see [Search tools](../integrations/mcp-server/search-tools.md):
  - `kangentic_search` recalls past conversations by meaning (the default) and finds the commits a query matches, each with the task it came from. It ranks tasks by a topic (`groupBy: "task"`, with each task's facts and summary) or by how like one task they are (`relatedToTask`). An agent drills into a cited turn with `kangentic_get_transcript`.
  - `kangentic_find_task` and `kangentic_get_current_task` carry a finished task's summary, the commits linked to it, and the files its sessions changed.

### The Conversation Viewer

A read-only window on the same layer as task detail windows: drag, resize, snap, tile, and maximize it like any other window. Open viewers persist in the workspace across project switches and app restarts. Each turn renders cleanly with per-message copy buttons, and the header keeps two one-tap actions, **Open task** (jump to the owning task's detail window) and **Copy conversation as Markdown**, both also available from the window's kebab menu.

The viewer opens positioned at the latest message, or centered on the turn matching where you had scrolled in the live terminal, so it lands where you were looking. A search bar at the top does debounced substring search across the loaded part of the transcript (the placeholder says "Search loaded messages" while older history is not loaded) with snippet results and prev/next navigation; press **Mod+F** (Ctrl+F on Windows/Linux, Cmd+F on macOS) to focus it, and click a result to jump straight to that turn. Very long transcripts (tens of thousands of messages) stay smooth via row virtualization and a custom overlay scrollbar with a "jump to latest" pill. A transcript larger than the newest 16 MB each session shows loads its earlier history as you scroll up, and the scrollbar spans the whole conversation: dragging the thumb past the loaded part shows placeholder rows and the date under the pointer (none for an agent without timestamps), then loads the page there once the pointer rests, and "Jump to start" in the window menu goes to the first message.

A task that worked in two or more columns gets a row of tabs under the title bar: **All**, then one tab per column of its Route, with the column's icon. All is the whole conversation, with a line naming the column wherever the task moved. A column tab keeps only the turns from that column, and each stay in it opens with its date. A column that ran an isolated session ends its tab name, and its line on All, in a split icon. A column the agent never ran in says so. When the names do not fit, every tab except the selected one shows only its icon, named on hover, and the split icon goes with the name; with even less room the row scrolls. Search and Copy conversation cover the tab you are on, and a search hit from the Search Palette always opens on All. Turns from before Kangentic logged the task's moves show on All only.

A plan the agent submitted for approval shows as a **Plan** card, open, with the plan as formatted text. It is tagged **Approved automatically** when Kangentic approved it, or **Approved by you** when you did, as the agent's own transcript records it. A plan whose transcript does not say who approved it has no tag. A copied plan carries the same tag. Claude Code 2.1.303 records the plan only once it is approved, so a plan still waiting for you shows as a plain ExitPlanMode tool call until you approve it.

When the agent has deleted its own transcript, the viewer shows Kangentic's saved copy under a banner that names the agent. The copy is written on each settled turn, a suspend, and an exit, so it stays readable after the agent's cleanup.

## Knowledge Graph

Open it from the brain icon in the title bar or with `Mod+Shift+A`. It answers "what does this
project's conversation index actually know, and how much of my history has it reached" - a question
neither the Knowledge Graph settings tab (switches, counts and a Rebuild button) nor Quick Find (a flat list of keyword matches)
can answer.

**The map.** Every indexed conversation is a point in 3D space, placed by the meaning of its
embeddings, so conversations about the same thing cluster together. Links join each conversation to
its nearest neighbours. Regions are named automatically from what the conversations in them are
about, so the map reads as a topic atlas of the project rather than an anonymous scatter. The names
come from the conversations' task titles, and with **Task summaries** on, from each task's summary too,
counted a little lower than its title: a region then reads as what its work touched ("alt screen /
wheel scroll") rather than how its titles happened to be worded ("code / quit / exit"). As summaries
are written the regions are renamed in place, at most every few minutes and once more when the
summaries have caught up; no conversation moves. Switching summaries off puts the title-only names back.

**Flying it.** Drag to orbit, right-drag to pan, scroll to zoom in and out. Click the map and use
**W** / **S** to fly forward and back, **A** / **D** to slide left and right, and **Q** / **E** to
rise and drop - you can fly right into a cluster and out the other side. The camera toolbar at the
bottom centre of the map holds **Reset view**, which frames the whole map again so it is always
possible to get un-lost, and **Controls**, which shows these keys. With regions switched off, Reset
view frames what is left rather than the regions you hid, so resetting a scoped map fills the view
instead of pulling it back out. With no chat open, Reset view also clears the selected conversation
and its panel, and centres the map in the space the panel leaves. While a chat is open the selection
stays, since its panel's Back is the way back to the chat.

Every change to what the map shows moves the camera by flying, never by a cut: narrowing a filter
or landing an answer flies to what is lit, clearing it or ending the chat flies back to the whole
map, and adding or removing a project flies from where you were to the new map. Three things still
reframe at once: resizing the window (a fly would fight the drag), opening the graph, and switching
the open project.

**Clicking around.** Hover a point for its title and size; click it for a detail panel. With a
chat open, the panel's **Back** control returns to it. With **Task summaries** on, the panel shows the
conversation's task summary under its title: what the task set out to do and did, in a sentence or
two.

The panel lists **Closest conversations**, its strongest links, ordered rather than scored: the
embeddings sit in a narrow similarity band where a percentage reads "99%" on every row and tells
you nothing, so the ordering is the signal.

Two actions: **Open conversation** (or a double-click on the point) opens the full transcript in a
movable window over the map, so it stays where you are reading rather than opening behind the
graph - the same when the graph is detached into its own window. **Explore from here** re-scopes
the map to that conversation and everything it links to, with a breadcrumb at the top of the map to
take it back.

The left panel holds four cards, and each one collapses: **Filter** (projects, time and status),
**Regions** (detail and the region list), **Display** (colour and what shows), and **Index**, which
opens beside the panel.

**Colour** switches what the points encode:

- **Topic** - the region each conversation belongs to.
- **Recency** - warm is recent, cool is old. Shows where your attention has moved, and which
  areas have gone quiet.
- **Status** - green is Done, amber is still open on the board, grey is a conversation with no
  task. Offered only when the less common status covers at least a twentieth of the index: on a
  healthy board almost everything gets done (642 of 648 on a real one), and a map that is uniformly
  green with six specks in it is a question for the status FILTER rather than a thing colour can
  show.
- **Length** - how much transcript the conversation holds, from deep indigo for the shortest through
  blue and teal to a warm yellow for the longest.
- **Duration** - how long it ran in wall time, on the same ramp.
- **Cost** - what it cost to run, on the same ramp.

Those last three are three different questions, not three readings of one: measured on a real index
their rank correlations are 0.507 (length to duration), 0.560 (length to cost) and 0.664 (duration
to cost), so a long conversation is not reliably a slow one and a slow one is not reliably an
expensive one. Duration and Cost are hidden on an index that records neither, and a conversation
missing one draws at the low end rather than disappearing.

**Show** turns the region labels and the similarity links on and off.

**Detail** cuts the map into more or fewer regions: **Coarse**, **Balanced** (the default) or
**Fine**. All three are computed with the map, so switching between them is instant and never
rebuilds anything. There is no measurement that can pick this for you - every way of scoring a
clustering prefers the fewest regions on a cloud this continuous - so it is simply how much detail
you want to read. How finely the map CAN be cut is bounded by the index: on a small one every
setting produces the same regions, and the control hides itself rather than offering choices that
repaint the identical picture.

**Filter** scopes the map by time (Any, 30 days, 90 days) and by status (Any, Done, Open), each a
row of buttons so every choice shows and takes one click. Done is a task in the Done column (or
archived, which only moving to Done does), and Open is every other task on the board. Both rows
always show their three choices, lined up in columns, so changing the scope never moves the panel.
A choice that cannot narrow this index is disabled, and its tooltip says why: both time windows
when nothing is older than 30 days, a status no task has, and the one status every task has.
Unlike the colour mode, the status row survives a lopsided board, which is the point of it -
scoping to the handful still open is exactly the question a green map cannot answer.

**Projects.** The graph opens on the project you have open. The Filter card's first row names the
scope and picks which projects the map shows: any of them, or **All**. It is there however many
projects are indexed, so it never comes and goes, and the header does not repeat it. **None** goes back to the open project
alone, since an empty map would leave nothing to pick from. Each project draws as its own island, labelled with its name and sized by how much it
holds, and the Regions list groups each project's regions under its name. A project with nothing
indexed is listed but cannot be picked. One the graph has never shown builds its map the first time
it is picked, which takes about a minute on a large project, and its island appears when that
finishes.

Asking follows the same scope. The box reads "Ask across 3 projects", every project's tasks go into
one table and one search, and the agent's own searches can reach each project. Ticket numbers repeat
between projects, so the reply names another project's task with its project, like **Mobile #88**,
and every row names its project. A row opens its conversation from its own project, and **Open
task** switches to that project to show it.

The **Regions** section below it lists every region with its colour and how many conversations it
holds, each independently switchable, plus **All** and **None**. A large index can carry dozens of
regions, so past a dozen the list gains a **Find a region** box. That narrows the LIST only - All
and None still act on every region, which is what the "N of M shown" count above them reports.

Position and links are not equally precise, and the surface says so rather than letting you assume:
**links are exact** (computed in the embedding's full dimensionality), while **position is
approximate** - reducing 1024 dimensions to three loses information, so "nearby" is a strong hint
rather than a guarantee. Follow the links when you want certainty.

**Asking.** Type a question in the box and press Enter: "what was the most expensive task?", "why
did we drop the sphere fit?", "which tasks touched the relay?". The question moves into a chat on
the right and the box goes. Follow-ups go in the chat's own box, and the **X** in its header ends
the chat and brings the box back. The chat is not saved, and it also ends when you switch projects.

**Set first, answer on top.** Before the agent starts, Kangentic searches every indexed conversation
and every task's own record (its title, labels, description and summary) for the question, locally
and in under a second, and rolls the matches up per task. A task's record can bring it in even when
none of its conversations was indexed, as long as the map is not filtered. The map lights
that related set at once, brighter where a task matches more strongly, and the chat reads "Reading
14 related tasks" while the agent works. When the answer lands, the map narrows to the tasks it is
about and nothing else: eleven tasks for an answer that names eleven, one conversation for an answer
about one. The rest fades out and the camera flies in, so a follow-up that narrows the answer
narrows the map with it, and clicking an earlier turn brings its tasks back the same way. If none of
the answer's tasks has a conversation of its own (tasks found by their records alone), the related
set stays, dimmed, so the map still points at the work the answer drew on. An answer that names no
task, such as "nothing here covers that", lights nothing and leaves the plain map. The filters in the left panel are the scope of the
question: a filtered map means a filtered table and a filtered search, so the chat never repeats
them.

**How it answers.** The agent is handed the related tasks with their strongest passages, facts and
summaries, a complete table of every task in scope, and the chat so far. The table holds every task on the
board, including ones with no indexed conversation, and settles factual questions exactly: what
each task cost, how long it ran, its tokens, how many sessions it took, how many files and lines
its branch changed, which pull request it opened and whether that merged, when it was last active,
which region it sits in, and what agent and model ran it, with the totals computed before the agent
sees them.
A task with no indexed conversation has nothing to open over the map, so its row opens the task on
the board instead. An agent that can use a tool also gets ONE: the same `kangentic_search` every agent gets,
scoped to this project (or to each project in a scope that spans several), for when the related
work misses something. Each search shows as a step in
the chat, and the conversations it found get a white ring on the map. Nothing else loads: no other
tool, none of your other MCP servers, and not the project's own instructions.

**The reply** is a few sentences that name tasks by their board ticket, drawn as small **#561**
marks. Under it are rows of one kind, a ticket and a title for each task the reply is about: five,
then **Show all**, which folds back with **Show fewer**. A row or a mark opens that task's most relevant conversation over the map,
scrolled to the passage the answer used, and that window's **Open task** closes the graph and opens
the task on the board. When you ask a follow-up, the earlier reply's rows fold into **Show N
tasks**. Asked something neither the table nor the conversations cover, it says so rather than
guessing. If the agent fails, its reason is shown as it came, with **Try again**.

It knows what the board and the conversations recorded, and, with **Source code** on, the code on
the project's default branch. With it on, the passages of code that read closest to a question go to
the agent beside the related tasks, so "how does the embedding drain pace itself?" is answered from
the code, naming the files, and the reply's rows stay tasks. A board question gets no code: code is
handed only when it reads close enough to the question. With it off, "how many agents does the app
support?" is a question about the repository that nothing here holds. Work done outside a board task
leaves nothing to find either way, and the box's placeholder says "tasks, conversations and code" only
while code is indexed.

Each question costs one agent call, and the glyph at the end of the box names the agent before you
press Enter.

**Which agent answers** is its own setting, because the agent that runs your tasks and the agent
that reads their history are different choices. The **Knowledge Graph** card in Settings >
Knowledge Graph holds the switch that turns the feature on, then the local model that finds work by
meaning, then the agent that answers: its **Agent** and **Model**, one choice for the whole app.
On an Intel Mac the card has no switch and reads **Unavailable**, because the local model has no
Intel macOS build.
Nothing picks them for you: until both are set, pressing Enter in the box opens Settings > Knowledge
Graph at that row and keeps your question typed, so you can come back and press Enter again. The same agent and model write the
task summaries, so it is chosen once. Reading the index is lighter work than writing code, so a
cheaper model can be enough. Measured on Claude, Haiku 5.5 at `low` answered a counting
question and a "most expensive" question right in every run, as Sonnet did. It was a second faster
and cost about a twentieth as much. It also invents more in task summaries (below), and the one
model does both jobs. Every agent that has a headless read-only mode can answer; Warp
cannot, since it has none. **Effort** appears when the agent's CLI reports effort levels, and starts
at `low`, which answers fastest. A higher level is worth trying on a question that counts or
compares across many tasks and comes back wrong. In one measurement Claude's `max` got right a
count that `low` got wrong, at about ten times the wait. A later replay through the app's own Ask
call got it right at every level, so `low` is the place to start. Effort is for answers only: summaries always write at the recommended level, where a higher
one changed nothing.

The **Index** card below it lists what the index searches, one line per source:
**Conversations**, **Tasks** and **Commits** are always indexed while the index is on, on switches
that cannot be turned off, each with its count and a check once caught up. **Task summaries** and
**Source code** have their own switches and are on by default. A running source keeps its line and
shows the share done and the time left over a progress track ("22%, 3 min left"). Switched off, a
line shows what switching it on would cover ("674 tasks", "1,488 files"), or for Task summaries
the count with a check once every Done task already has one. The figures are every
indexed project's (each project with a conversation in the index), the same projects the Knowledge
Graph's All projects map draws, so the two read the same. Source code switched off is the exception:
its estimate is the open project's. Both wait for the Knowledge Graph and its agent, spending nothing until then, and say
so ("Needs the Knowledge Graph", "Needs an agent"): the agent writes the summaries, and only its
answers read the code. Their switches still work while they wait, so you can turn one off before
choosing the agent that would start it. On an Intel Mac both lines read **Unavailable** instead,
since the Knowledge Graph cannot run there.

**Task summaries** start once the Knowledge Graph has an agent and a model. The agent writes a
sentence or two about each Done task: what it set out to do and what it ended up doing, from the
task's title and description, the files its sessions changed, the commits it landed on the default
branch, and how its last sessions ended. A summary is searched with the task and handed to the
agent beside it, so a question finds a task by what it did, not only by what its title says.
Summaries are written in the background, ten tasks to a call, three calls at a time (at Sonnet,
about $0.02 per ten tasks, and about three minutes for 700 tasks), and a task that reaches Done
gets one on the next pass. Every project is asked once each launch, a minute in, whether or not you
open it, and again when summaries are switched on or the agent is chosen. Caught up, the line shows
the count with a check. Behind with nothing writing, it shows how many are written of how many
could be, and how many the agent passed over ("670 of 673, 3 skipped"); those are asked about again
on the next launch, or after **Rebuild**. When a reply answers none of its batch while another batch
in the same pass was answered, each of those tasks is asked again on its own, so one task the agent
will not summarize does not hold back the rest. A failed call reads **A call failed** in yellow, with when
it is retried. When a call fails and no other call of the pass came back answered, every project's
summaries wait until then, since the agent is the same for all of them. One call failing beside
another that answered holds back only its own project. Switching summaries off stops new calls and keeps the
summaries already written, so they go on helping search. A new model applies to new and changed
tasks, and the line loses its check until **Rebuild** rewrites the rest, showing the share
rewritten over a track while those rewrites are being written; Rebuild asks first when it
will rewrite summaries, and says how many and about how many calls. Measured on this project's own
tasks, a mid-size model at low effort (Sonnet) wrote as well as a larger one and higher effort
changed nothing; the larger models (Opus, Fable) add a little detail at two to seven times the
cost, and the smallest (Haiku) invented details. Remeasured with Haiku 5.5 on 50 tasks, 22 of
them with no files or commits to go on: Haiku invented 13 details and Sonnet 8, almost all on
those thin tasks, where both wrote that a proposal had shipped. Neither passed a task over.

**Source code** starts once the Knowledge Graph has an agent. It reads the project's default branch as committed:
`origin/main` (or whatever the project's base branch is), else the local branch of that name, else
the remote's own default, else the branch you have checked out. Any branch works; it reads source
files and docs, not tests, fixtures, data files, lock files, build output or anything over 256 KB.
Each file is split into passages at its top-level declarations and embedded in the background by
the Knowledge Graph's local model. Off, its line shows the files it would read, or "Nothing committed yet"
in a repository with no commit. This repository took about half an hour on a GPU and would take a
couple of hours on a CPU. When the branch moves, only the files whose content changed are read
again. Switching it off clears the open project's code index at once and another project's the
next time you open it; switching it back on reads the branch again. Switching the Knowledge Graph
off, or clearing its agent, keeps the code index as it is, so turning it back on costs nothing.

The **Index** card at the bottom of the left panel opens to its side into the Index card that
Settings > Knowledge Graph shows, without its switches. Each source is a line: its count with a
check once caught up, its share while it is still being embedded, and a tag while it waits for
something (the Knowledge Graph, an agent, a model). The sources are **Conversations** (what the map
draws), **Tasks** (each task's and backlog item's own text), **Commits** (the commits on the
project's default branch, each tied to the task whose conversation wrote it), **Task summaries**
(how many Done tasks have one, a track only while a pass is writing them) and **Source code** (the
default branch's files). A source with nothing in it yet says **Not yet indexed**, and Task summaries with no Done
task says **No Done tasks yet**. Session changes
are kept as text for the task summaries and never searched, so they have no line. On All projects
the panel reads the same figures as the Settings card. With the Knowledge Graph switched off it
reads as off here too, even while the map it already drew is still shown: counts without a share,
and **Needs the Knowledge Graph** on the lines that wait for it.

Below the sources is what only the map has. **Links** counts the similarity links, computed in full
embedding dimensionality, so they are exact; a dot's position is an approximate reduction.
**Transcript gone** counts conversations whose agent transcript file was deleted (a pruned
worktree, a cleaned CLI cache) while their indexed text and embeddings still answer queries. On a
mature project that is most of the index, and it is not a problem. **Not yet indexed** counts
conversations the background sweep has not reached, **Failed to index** any it could not read, and
**Size on disk** covers every source. **Open Settings** opens Settings > Knowledge Graph, where the
sources change, the index is rebuilt, and its model and agent are set.

The panel opens to the side and stays inside the window whatever the left panel holds: with every
card expanded it rises until its bottom clears the window's edge, and in a window too short for it
the panel scrolls inside itself.

The index holds what the board and its conversations recorded, plus your repository's committed
files while Source code is on.

The map is drawn on the GPU. On a machine that cannot provide a 3D drawing context (a blocklisted
driver, some remote sessions) it says so, and the coverage numbers and Ask keep working.

**Building the map.** The first time a project opens the graph, Kangentic reads every embedding in
the index to place the dots. On a large project that takes a few minutes, runs in the background,
and only happens once; after that it updates in about a second as new conversations are indexed.
While it builds, one card in the middle of the screen shows how far it has got (reading the
conversations, then placing them, then naming the regions), the same source lines the Index panel
lists, and an **Open Settings** button. The Index card joins the left panel once the map is drawn.
It needs the Knowledge Graph's embeddings (Settings > Knowledge Graph). Without them there is no
meaningful notion of "near", so until the Knowledge Graph has embedded anything the graph shows an
Off card with an **Open Settings** button rather than drawing a map that would imply a meaning it
does not have. Switching the Knowledge Graph off later keeps the map it already drew. On an Intel
Mac, where the local model cannot run, the graph shows an **Unavailable** card with no
**Open Settings** button, since there is nothing to turn on.

Like the Agent Monitor and Usage Stats, it detaches into its own window from the pop-out control in
its header.

### Prior work on a task

The map is somewhere you go. This is the same recall coming to you: open a task and, if the index
holds earlier conversations close to it, a line appears under the description reading
**"3 earlier conversations about this"**. Expand it to see up to five of them, strongest first, and click one to open its transcript.
Each row is named after the task the conversation belongs to. Hover it to read the passage that
matched, which matters when that task's title sounds unrelated.

The task's own title and description are the query, so there is nothing to type. Only tasks created
before this one count, and only their turns from before it was created. Only what was said counts,
never the files and command output a tool call read. The task's own history is left out, since it
is one click away in the header. A task shows only when one of its conversations is much closer to
this task than the rest of the index is. When none is, the line is not shown at all. Like the map,
it needs the Knowledge Graph's embeddings, and an index that already holds other tasks'
conversations to compare against, so it stays hidden with embeddings off or in a new project.
