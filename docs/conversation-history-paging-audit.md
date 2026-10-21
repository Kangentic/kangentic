# Conversation history paging audit (2026-10-21)

Can the Conversation viewer scroll a whole transcript instead of each session's newest 16 MiB
(`MAX_PARSE_SOURCE_BYTES`), without bringing back the 2026-08-20 OOM? That OOM came from several
whole-file reads at once on main. The read now runs in the `kangentic-retrieval` worker, where an
oversized read kills the worker instead. Every transcript read fails until the worker restarts, and
after three crashes it stays off.

**Verdict: yes, and C is built for every agent with a transcript. The checks under "Not measured"
are still open.** Seven options
follow, A to G. The recommended one, C, is a separate bounded page call that loads earlier history
while the user scrolls up. One 8 MiB page costs the worker about half of today's tail read. This
records the options, the measurements behind them and the recommended design. C was then built,
with the decisions below the options (a whole-transcript scrollbar, jumps, column tabs and every
agent with a transcript); `docs/architecture.md` (Transcript) and `docs/agent-integration.md`
(`readTranscriptPage`) describe what shipped. The rows marked pending stay pending until they are
read in the running app.

The safety bar was fixed before measuring. A design passes only if all four hold:

| Bar | Status |
|---|---|
| Worker: one page's peak, times the pages allowed at once (1), under 10% of the heap limit, and under 1 s | Passes against a proxy: 27-34 MB against Electron 44's node limit of 4,192 MB, 18-185 ms. Not yet read inside the running worker |
| Main: holds at most one page's reply, never parses it | Passes by design: one reply of at most 0.9 MB |
| Renderer: retained heap per open window at the cap within budget, no long task over 200 ms on an insert | Pending: estimated at most about 45 MB per window, not measured |
| Other readers read exactly what they read today | Passes by design: the page call is a separate method only the viewer calls |

## Options

Recommended: C, because the reader can get back to the first turn by scrolling, at the same memory
bound as B.

- **A. Keep today's notice.** Each session shows its newest 16 MiB under "Earlier N MB of this
  conversation are not shown". No work and no risk. The omitted part stays out of reach in the
  viewer: a search palette hit inside it opens the window at the latest message instead.
- **B. A "Load earlier" button.** The notice row becomes a button that loads the 8 MiB before it,
  one click per page. Each click costs the worker 27-34 MB of peak memory and sends a reply of at
  most 0.9 MB. Holding the reader's place is simple, because the reader is at the top when they
  click.
- **C. Automatic paging as the reader scrolls up.** The same row loads the next page by itself when
  the reader scrolls near it, so scrolling up just keeps going. A window holds at most 8 pages
  (64 MiB of source). Past that, the page farthest from the reader drops and becomes a gap row
  again. The reader can still reach the first turn, but the window never holds the whole history at
  once. The scrollbar covers only what is loaded, and its thumb shrinks as pages arrive. Same worker
  call, cost and cap as B, plus holding the reader's place while rows appear above them.
- **D. A scrollbar that spans the whole transcript.** Parts not yet loaded are placeholder rows sized
  from their byte counts. Dragging the thumb anywhere loads that page, found by bisecting the file
  on record timestamps, and a search hit can open anywhere. This is the most literal reading of
  "scroll the whole transcript", and the most work. Placeholder heights are estimates, so the thumb
  shifts as real rows replace them, and keeping the reader's place when the visible row is itself a
  placeholder splitting in two is the hard case. It builds on C's worker call, so it can come later.
- **E. Load the whole history at once.** Lift the cap for the viewer only. Least code, but the
  548 MB transcript becomes a 64 MB reply through main and roughly 150 MB in the renderer, and a
  transcript has no size ceiling. It fails the no-crash bar.
- **F. A smaller window.** A 4 or 8 MiB tail makes the first open cheaper but shows less history,
  the opposite of the goal.
- **G. Open the raw file.** It shows JSONL, not a conversation.

The plan was for Claude to go first, as the only agent with a windowed read and an archive, and for
other agents to follow per the costs under Q3. As built, every agent pages (Stage 2 below).

## Measurements

**Method.** A scratch rig bundled the shipped Claude parser (`parseClaudeTranscript`,
`parseClaudeTranscriptWindow`, `readJsonlWindow`, `truncateEntries`) with esbuild and ran it under
Electron 44's own node (`ELECTRON_RUN_AS_NODE`), one fresh process per data point. Peak is the
growth of the process's max RSS during the read: the read buffer, the decoded string and the parse
transients. Retained is `heapUsed` after forced GC. Reply is the clamped entries serialized the way
the worker builds its reply. The corpus was eight real Claude transcripts of 32, 52, 60, 97, 138,
153, 428 and 548 MB.

### One read, in the worker

| Read | Peak RSS added | Time | Entries | Retained | Reply |
|---|---|---|---|---|---|
| Today's tail, 16 MiB | 66-70 MB | 40-53 ms | 528-2,371 | 1.2-7.6 MB | 0.4-2.3 MB |
| Earlier page, 4 MiB | 13-17 MB | 13-76 ms | 40-476 | 0.1-1.7 MB | up to 0.5 MB |
| Earlier page, 8 MiB | 27-34 MB | 18-72 ms | 90-768 | 0.1-2.8 MB | up to 0.9 MB |
| Earlier page, 16 MiB | 55-69 MB | 36-96 ms | 176-1,102 | 0.3-4.1 MB | up to 1.3 MB |

Each page ended where the 16 MiB tail starts, which is the first page a reader scrolling up would
load, and peak memory was measured at that one position only. Time varies more along the file: the
whole-history walk below reached 185 ms for one 8 MiB window of the 548 MB file. Serializing a
page's reply took at most 7 ms.

The heap limit under Electron 44's node is 4,192 MB. The worker's fork passes no heap flag (there is
no `--max-old-space-size` anywhere under `src/main`), so it runs with V8's default. One 8 MiB page
peaks at under 1% of that limit, inside the 10% bar set before measuring. At 185 ms it still
finishes about 80 times inside the 15 s call timeout.

### The whole history, held at once

A forward walk in 8 MiB windows, the way the indexer walks, keeping every entry:

| Transcript | Windows | Entries | Clamped entries held | Reply if sent at once | Slowest window |
|---|---|---|---|---|---|
| 32 MB | 5 | 1,497 | 2.7 MB | 1.9 MB | 31 ms |
| 138 MB | 18 | 4,927 | 6.5 MB | 5.2 MB | 43 ms |
| 153 MB | 20 | 5,042 | 5.5 MB | 4.3 MB | 37 ms |
| 428 MB | 55 | 33,327 | 44.4 MB | 36.2 MB | 54 ms |
| 548 MB | 70 | 56,554 | 74.5 MB | 63.9 MB | 185 ms |

Size on disk predicts entry count poorly. Across the eight files, entries per megabyte ranged from 28
(the 97 MB file) to 103 (the 548 MB one). Sending a whole history in one reply is what the design
must avoid: 64 MB of JSON through main and a `JSON.parse` of it in the preload.

### Resumed sessions (Q4)

Claude keeps one folder of transcripts per working directory, and each task runs in its own
worktree. Of the 37 folders holding a transcript of 30 MB or more, 36 hold exactly one such file next
to at most nine small ones.

The size of those other files bounds how much of an omitted head the stitch could already show. For
every file of 97 MB or more, the other files in its folder total at most 19% of it. Beside the
548 MB file they total 61 MB, so at least 470 MB of its 532 MB omitted head exists only in that one
file. So the omitted part is mostly that session's own history, and the notice does not overstate
the loss by much.

Two things stay open. Every record parsed from the first 256 KB of each large file, and from the
256 KB before its tail, carries the file's own `sessionId`, but that cannot rule out a replay
written under the new id. Some of those probes also parsed no record at all, because one line ran
past 256 KB. And these folders do not show the multiple full-size replay files that the comment in
`transcript-cache.ts` describes for a `--resume`. A uuid overlap scan would settle both.

### Not measured

These were stopped because the rigs slowed the machine for other work, and the build did not run
them. They are still open:

- Renderer heap with pages loaded, in `/preview`. Estimate from the code: the renderer holds the
  parsed entries plus one `DisplayRow` per entry whose `searchText`, once a search reads it, copies
  up to 16,000 characters of the row, so at most roughly twice the "clamped entries held" figure. That is about 150 MB for the whole
  548 MB history. For the cap of 8 pages of 8 MiB per window it is about 17 MB at the 548 MB file's
  average of 1.1 MB per window, and at most about 45 MB at the largest page measured (2.8 MB). Each
  open Conversation window adds its own. Mounted DOM rows stay bounded by the virtualizer (visible
  rows plus 8 overscan on each side) whatever is loaded.
- The heap limit read inside the running worker, rather than in Electron's node.
- Scroll anchoring with `anchorTo: 'end'` (below), in `/preview`.
- A uuid overlap scan between each large file and the other files in its folder (Q4).

## Answers

1. **Memory per process (Q1).** Worker: the tables above. Main: it relays the reply string and never
   parses it, so a page costs main one reply of at most 0.9 MB for the round trip at 8 MiB.
   Renderer: estimated above.
2. **On-demand loading (Q2).** Yes. The viewer already virtualizes with `@tanstack/react-virtual`
   and measured row heights, so loading more rows does not mount more DOM. It needs scroll anchoring
   when rows are inserted above the reader, which it does not have today.
3. **Adapters without `parseTranscriptWindow` (Q3).** Only Claude has it. Qwen and Droid are trivial
   (stateless JSONL with their own ids). Codex, Kimi and Grok are moderate, because their entry
   uuids are absolute line numbers and the window contract has no line count to carry. Gemini's
   JSONL is moderate (a message re-emitted across a page seam), and its legacy single-JSON format
   cannot be windowed. Antigravity is light (step order and an error line at a seam). OpenCode
   reads SQLite or HTTP, so a byte cursor does not apply. Aider, Cursor, Copilot, Goose, Ollama and
   Warp have no transcript parser at all. Codex's, Grok's and OpenCode's history locators do not
   name the file their parser reads, and the archive sweep sizes files through the locator, so those
   three need fixing first.
4. **A truncated session in the middle of a task (Q4).** Each session's notice becomes that
   session's own gap row, with its own cursor. A page for it is inserted at its gap row, so earlier
   history lands between the previous session's end and that session's surviving tail.
5. **Search and Jump to latest (Q5).** In-viewer search scans loaded rows only, and should say how
   much is not loaded. The search palette already covers Claude's whole history through the index.
   Jump to latest targets the tail, which is always loaded.
6. **Other readers (Q6).** MCP `kangentic_get_transcript`, the phone and the recap tail keep reading
   through `parseTranscript`, `resolveTaskTranscript` and `readSavedConversation`. The page call is
   a separate worker method only the viewer calls, and it touches none of their caches.
7. **Window size (Q7).** Keep 16 MiB for the tail. It costs 66-70 MB peak and 40-53 ms off main, and
   lowering it would shrink what the agents without a windowed read show and index. Page in 8 MiB:
   half the tail's peak, and the same window the indexer and the transcript archive use, so an
   archived page is one archive row.

## Option C in detail

### Stage 1: Claude, the viewer only

- **Expose the page's first line.** `ParsedTranscriptWindow` gains `firstByteOffset`, the post-skip
  `startByte` that `readJsonlWindow` already computes and the Claude window drops. A backward pager
  needs it: the next page must end exactly where this one's first whole line starts, or the line
  straddling the seam is lost.
- **Give the notice a cursor.** The `truncated` system entry carries the agent session id and the
  byte its surviving entries start at, and its uuid includes the session id. Today's uuid,
  `kangentic-truncated:<omittedBytes>`, can collide between two sessions in one stitch.
- **Add one worker method, `transcript.page`.** It takes `{ projectId, sessionId, beforeByte }` and
  returns the clamped entries of the 8 MiB before `beforeByte` plus the next cursor. It reads the
  live file first and the archive rows when the file is gone, the order `resolveSessionTranscript`
  already uses. It runs on its own concurrency-1 queue in the worker and writes no shared cache.
  Then it is wired as one IPC endpoint through the 7 layers, with a web demo mock.
- **Keep pages apart from the polled tail.** `ConversationWindow` holds the pages per session next to
  the polled response. A pure merge inserts each session's pages at its gap row and dedupes by uuid,
  the tail winning. The index-based delta of `transcript.task` never sees a page, so the poll
  protocol is unchanged. Holding pages in the window, not in `ConversationView`, also keeps them
  across the remount a Route tab switch causes.
- **Trigger and anchor.** A gap row entering the overscan requests the next page, one request in
  flight per window. Anchoring comes from virtual-core's `anchorTo: 'end'`, which keeps the first
  visible row in place by key when the row count changes. A page that arrives while
  `useScrollSettle` is positioning waits until it settles. If the `/preview` check shows the option
  fighting the open-at-bottom path, the fallback is the same arithmetic by hand: record the first
  visible row and its offset, then restore them after the commit. If neither holds the place
  cleanly, ship B: the same rows, loaded on a click.
- **Cap.** At most 8 pages (64 MiB of source) per Conversation window, across all its sessions, on
  top of the tails it holds today. Capping per session instead would let a task with five truncated
  sessions hold 40 pages. Loading a ninth drops the page farthest from the viewport and turns its
  edge back into a gap row, so the loaded span slides and a gap row can sit on either side of it.
  Jump to latest drops every page.
- **The moving seam.** Claude's incremental parse grows the tail to 32 MiB, then re-reads it at
  16 MiB, so the tail's first byte jumps forward. The merge fetches the hole between the old and the
  new cursor as one more page. As built, the window keeps what the re-read tail dropped as a block
  between the two notices' cursors instead (`retainSeam`), so no read is needed.

### Stage 2: other agents

Fix the three locators, then add `parseTranscriptWindow` to Qwen and Droid. Codex, Kimi and Grok
need a line count carried in the cursor. OpenCode needs a row cursor outside the byte contract.

As built, every adapter got `readTranscriptPage` over its own tail's line parser instead: no
`parseTranscriptWindow` and no locator change was needed, since a page reads the file the adapter's
own parse reads. Qwen, Droid, Codex, Kimi and Grok carry a line count in the cursor. OpenCode's
cursor names a message, and its unit is the characters of stored data. A legacy single-document
Gemini file does not page. Where a page edge cuts state that crosses lines, the result is what the
tail's own start already did:

- A Codex page's replies before its own first `turn_context` have no model.
- A Kimi text run cut by a page edge shows as two rows.
- An Antigravity error whose tool call sits on the far side of a page edge shows nothing.
- A Gemini message re-emitted across a page edge keeps its later copy, which is the whole-file rule.

Grok's reasoning records became thinking rows of their own: the parser used to carry them onto the
next reply, which lost them at every page edge and at the tail's start.

### Stage 3: jumping into unloaded history (the start of D)

A palette hit in an unloaded part carries its agent session id and `ts`. Bisecting the file by record
timestamp finds its page in about `log2(size / 64 KB)` small reads. That page loads as a detached
span with a gap row above and below.

## Existing exposures

These held when the audit was written, and the build closed each one:

- OpenCode's parser had no read cap and no notice: it read the whole session from SQLite. A local
  session's tail is now capped at the same window, and its notice pages the rest by message. A
  remote session is capped too, but its notice carries no cursor, so its older history stays out
  of the viewer.
- The file cache and the stitch memo charged a transcript's whole file size against their 192 MiB
  budgets, though they hold only the 16 MiB tail, so one 548 MB transcript evicted everything else.
  They now charge at most twice the tail window (`retainedSourceBytes`).
- An archive read kept the row that crossed the cap, so it could reach about 24 MiB of source, not
  16. It now keeps rows while they fit, and always at least one.
- The MCP structured transcript skipped the per-span clamp. It now applies `truncateEntries`, and
  still reads around the file cache.
- The worker queued no requests, and the viewer's 2.5 s poll had no in-flight guard. A call that
  passes 15 s kills the worker. History reads now share one queue whose every call answers `busy`
  by 10 s, waiting or running. A page read gives up after 4 s, a timeline build stops probing after
  6 s, and the poll skips a tick while its last read is out. A wait cap alone was not enough: in
  `/preview` a timeline cache check read with a 1-byte page, skipped a 97 MB file one byte at a
  time, and held the calls behind it until main killed the worker three times.
- No UI test rendered a `truncated` row, clicked Jump to latest, or checked anchoring on an insert.
  `tests/ui/conversation-paging.spec.ts` does all three.
