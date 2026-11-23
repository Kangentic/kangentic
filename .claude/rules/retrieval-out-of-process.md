---
paths:
  - "src/main/retrieval/**"
  - "src/main/agent/transcript-*.ts"
  - "src/main/agent/message-trail-*.ts"
  - "src/main/agent/commands/structured-transcript.ts"
---
# Rule: the retrieval index is read and written only by the retrieval worker

The Knowledge Graph used to run every index query on Electron's main process, over the one
synchronous better-sqlite3 connection per project. Measured on a real index of 1,005 conversations
and 94,862 chunks: a conversation search held main for 340 to 370 ms per query vector, a map
rebuild read vectors at about 450 ms a page, coverage took 285 ms, and every agent turn re-parsed
its whole transcript. Slicing that work only spread the freezes out. Electron's performance guide
says to move long work off main, its process-model docs name `utilityProcess` for CPU-heavy or
crash-prone work, and loading a native module in a worker thread is unsafe unless the module
documents it (better-sqlite3 does, which is what the checkpoint thread below rests on). So the index moved to
the `kangentic-retrieval` utility process, which opens the same WAL database file on its own
connection.

## The rule

- **Every read and write of the index runs in the worker.** The index is the `memory_*` tables, the
  vec0 and FTS tables, the turn-usage ledger, spawn links, task summaries, and the parse and stitch
  of agent transcripts (the Conversation window, the phone's window, MCP `get_transcript`, the
  board's message trail). Main reaches them only through `retrievalClient.call(method, params)`
  (`src/main/retrieval/retrieval-client.ts`). Nothing heavy falls back to main while the worker is
  down: a caller reports that the index is restarting and returns.
- **Main keeps scheduling and the work only it can do.** Session and board events, debounces,
  config gates, the IPC and MCP shells, the embed worker (`embed-engine.ts` stays the only
  embedder, see [[central-embedding-engine]]), scheduling agent CLI runs (each starts in the pty
  host, [[pty-host-out-of-process]]), and writes to project data: tasks,
  sessions and the app tables. The raw PTY transcript is written by the pty host, which produces
  it, one INSERT per flush over its own connection ([[pty-host-out-of-process]]). Sending each
  64 KB flush to another process was measured at 13 times the sender's major-GC time.
- **Main never loads sqlite-vec.** Main bundle code that touches a vec0 table throws
  `no such module: vec0`, which is the intent.
- **Write transactions stay short on both sides.** Main converts every project-database
  transaction to `writeTransaction` (`src/main/db/transaction.ts`, an immediate transaction), so a
  write that meets the worker's lock waits instead of failing with `SQLITE_BUSY`. Worker
  transactions are capped (16 chunks, 64 deletes, 64 KB) so main waits a few ms at most, and the
  worker's background writes (storage upkeep, record sweeps, the embedding writeback, the map's
  sums, and the corpus purges and width resets) share one lock budget per database
  (`write-budget.ts`): 20% of wall time while no other
  connection has committed for 2 s, 5% with commits at least 50 ms apart while one has. A new
  background write loop awaits `awaitWriteTurn` between its writes.
- **The worker owns checkpoints.** It runs `PRAGMA wal_checkpoint(PASSIVE)` when main asks, every
  5 s (`checkpoint-driver.ts`), and after its own commits at most once a second per connection (`worker/checkpoint-pacing.ts`, through
  `setAfterCommitHook`), bulk upkeep jobs included. Main sets `wal_autocheckpoint = 0`
  while the worker is up and restores 1000 when it goes down; the worker and the pty host always
  set 0, so no checkpoint hides inside a commit (one did, and billed a terminal flood's pages to a
  16-row write: 363 to 479 ms). FULL, RESTART and TRUNCATE are never used: they block writers.
  Both kinds run on the checkpoint thread (`worker/checkpoint-runner.ts`), on its own connection,
  never on the request loop. On the loop one held `transcript.trailRead` past its 15 s budget,
  main killed the worker, and the kill threw the copy away, five times in 80 minutes on one install
  (Sentry DESKTOP-4P). On a 304 MB WAL it held its thread for 527 to 683 ms on an SSD, while the
  loop beside the thread saw no gap over 65 ms. A thread that cannot run hands the checkpoints back
  to the loop, under `db:checkpoint-tick` and `db:checkpoint-after-write`
  (`worker/checkpoint-labels.ts`). Main fails, but does not kill, a call that times out while the
  watchdog names one of them, for up to a minute (`heldInCheckpoint` in `retrieval-client.ts`):
  PASSIVE holds no write lock, and a held write lock is why a stuck worker is killed.
- **Migrations run on main, first.** The worker opens with migrations off and `fileMustExist`,
  after main has opened and migrated the file. An index over an existing large table is built by
  the worker, never as a migration on main, and only once no other connection has committed for
  2 s (`index-builds.ts`): a build holds the write lock for 180 to 245 ms, and at project open it
  held main's own startup writes for 542 ms.
- **`RetrievalClient` is constructed only in `retrieval-client.ts`**, as the shared
  `retrievalClient`. The worker is its own esbuild entry in `scripts/build.js` and `scripts/dev.js`
  and carries no `electron`, IPC, analytics or Sentry import.
- **The worker runs two threads.** The first is its event-loop watchdog
  (`src/main/utility-process/event-loop-watchdog.ts`, shared with the pty host), which names the
  step that held the loop when a call times out. It runs inline source that requires
  only `node:` built-ins, so nothing it loads can take it down, and it
  writes with `fs.writeSync`, since a thread's console waits on the thread that is hung. It posts
  no message, so main pays nothing while the worker is healthy. The second is the checkpoint
  thread (`worker/checkpoint-thread/checkpoint-thread-entry.ts`, its own esbuild entry, unpacked).
  It is the one thread that loads a native module, and only better-sqlite3, which is context-aware
  and documents worker-thread use. No other native module is proven on a thread, so its graph
  stays to its own folder, built-ins and better-sqlite3, and the afterPack probe
  (`verifyRetrievalCheckpointThreadLoads`) starts it under the packaged Electron and checkpoints a
  WAL, failing the build when it cannot. `project.close` closes its connection too.
- **Project delete closes the worker's handle first** (`project.close`, or a kill after 3 s), since
  Windows refuses to unlink a database file another process holds open.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/retrieval-out-of-process-boundary.test.ts` builds both bundles with esbuild
  and fails if main's dev or production bundle declares a worker-only function or class (the
  store, the indexers, the searches, the map pass, the transcript stitch), if the worker's graph
  reaches `electron`, analytics, Sentry or the IPC layer, if the worker stops being its own entry,
  or if `new RetrievalClient(` appears outside `retrieval-client.ts`. Runs in CI via
  `npm run test:unit`.
- **Test:** `tests/unit/transaction-helper.test.ts` pins `writeTransaction` and the two-connection
  `SQLITE_BUSY` behavior it prevents. `tests/unit/write-budget.test.ts` pins the idle and busy
  shares, the commit gap, the return to idle, and that two jobs writing at once stay within one
  share.
- **Test:** `tests/unit/stderr-tail.test.ts` scans every `utilityProcess.fork` site, the retrieval
  worker's included (see [[cross-platform-parity]]), and `tests/unit/verify-unpacked-worker.test.ts`
  pins the packaging half.
- **Test:** `tests/unit/event-loop-watchdog.test.ts` runs the watchdog on a real thread, holds the
  loop, and reads the line it wrote while the loop was still held. It also fails when the thread
  requires anything but a `node:` built-in, or when `worker_threads` is imported anywhere else in
  `src/main` but the pty host's spawn worker, the shared watchdog module
  (`src/main/utility-process/event-loop-watchdog.ts`, started by the retrieval worker and the pty
  host alike), which load no native module either ([[pty-host-out-of-process]]), and the
  retrieval worker's checkpoint runner and thread. It fails when an adapter that reads a transcript window has
  no `transcript:parse-` span: each parses in its own code after the read's `await`, so nothing
  shared can label it. `tests/unit/retrieval-worker-held-step.test.ts` holds the loop inside a
  handler through the real entry and reads `in method:<name>`.
- **Test (checkpoint thread):** `tests/unit/retrieval-checkpoint-thread.test.ts` runs the real
  thread on a real WAL and deletes the file after its close, answers a request through the real
  entry while a checkpoint holds the thread (red with checkpoints on the loop), and pins the
  runner's join and fallback. `retrieval-out-of-process-boundary.test.ts` holds the thread's
  graph to better-sqlite3 and built-ins and pins its entry and `asarUnpack`;
  `verify-unpacked-worker.test.ts` runs its afterPack probe under this checkout's Electron;
  `retrieval-client.test.ts` pins the no-kill for a checkpoint hold, its ceiling, and the kill for
  any other step.
- **Review:** a new main-side caller of a retrieval-store method compiles (types are erased), so
  the boundary test catches it only when it pulls a declaration into main's bundle. `/code-review`
  flags a direct `getProjectDb` read of a `memory_*` table from main.

## Scope

`src/main/retrieval/**` and the agent transcript readers. Main's own project-data writes are
outside it, as is the usage dashboard UI, which reads through worker calls.
