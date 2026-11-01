---
type: Reference
title: Output streaming
description: "How PTY output reaches xterm and a phone (each renderer's own port to the pty host for keystrokes and echo, 16 ms flush, prompt flush after input in the alt screen, a pending buffer bounded by a whole drain or a pause, a pause no ack answers released after 10 s, the root error boundary's focus release, 512 KB ring, tap), the echo's numbers under load, why alt-screen sessions replay the parsed grid, the grid-width mechanisms (deterministic fit, the frame hold, the manager-resize gate, resting grid, echo re-assert, repaint settle, held live output, repaint nudge, mouse pacing), and where a fullscreen agent's wheel-to-paint time goes."
tags: [terminal, output, scrollback, replay, geometry]
sources:
  - resource: src/main/pty/buffer/pty-buffer-manager.ts
  - resource: src/main/pty/buffer/backpressure-controller.ts
  - resource: src/main/pty/host/pty-host-core.ts
  - resource: src/preload/pty-port-client.ts
  - resource: src/shared/pty-port-protocol.ts
  - resource: src/main/pty/host/spawn-worker/spawn-worker-entry.ts
  - resource: src/devtools/main/scroll-latency-report.ts
  - resource: src/main/pty/buffer/headless-frame.ts
  - resource: src/main/pty/buffer/transcript-writer.ts
  - resource: src/main/pty/buffer/output-peek.ts
  - resource: src/renderer/addons/fit-addon.ts
  - resource: src/renderer/hooks/useTerminal.ts
  - resource: src/renderer/utils/focused-terminals.ts
  - resource: src/renderer/components/ErrorBoundary.tsx
  - resource: src/renderer/utils/repaint-nudge.ts
  - resource: src/renderer/utils/terminal-layout-transition.ts
  - resource: src/renderer/utils/terminal-repaint-wait.ts
  - resource: src/renderer/utils/incoming-write-queue.ts
  - resource: src/renderer/hooks/useTerminalRefit.ts
  - resource: src/renderer/window-manager/terminal/manager-resize-gate.ts
  - resource: src/renderer/utils/write-batcher.ts
  - resource: src/renderer/utils/scroll-latency-probe.ts
  - resource: src/renderer/utils/terminal-typing.ts
  - resource: src/renderer/utils/terminal-init-queue.ts
  - resource: src/renderer/utils/dnd-sensor-options.ts
  - resource: src/renderer/stores/board-store/structural-sharing.ts
  - resource: src/main/diagnostics/pty-round-trip-probe.ts
  - resource: src/renderer/utils/terminal-mount-registry.ts
  - resource: src/main/ipc/handlers/session-grid-persistence.ts
  - resource: src/shared/xterm-unicode11.ts
---
# Output streaming

## Transcript Capture

PTY output is captured for two purposes: terminal display (via the scrollback buffer) and persistent transcript storage (via `TranscriptWriter`).

`TranscriptWriter` (`src/main/pty/buffer/transcript-writer.ts`) runs in the pty host. It receives raw PTY data, strips ANSI escape sequences, and flushes every 30 seconds, early if a session's pending buffer exceeds 64KB. Each flush is one INSERT into `session_transcript_chunks` (1 to 2 ms) in the database of the session's own project, over the host's own connection (opened after main migrated the file, with its auto-checkpoint off, since the retrieval worker runs the checkpoints). The project id comes with the spawn, and the writer keeps it for its final flush after removal. A project whose database is not open drops the flush rather than writing it elsewhere. This provides a clean, searchable text transcript of the session without terminal formatting noise, kept whole after the session row is gone.

Agents read it back through the `kangentic_get_transcript` MCP tool's `raw` format. Cross-agent handoff does not use it: the target agent is pointed at the source agent's own session file instead (see [Cross-agent handoff](../../integrations/agents/handoff.md)).

## Output pipeline

Everything in this section runs in the [pty host](crash-recovery.md#pty-host). The host sends a
renderer's output on that renderer's own port, relays a phone's through main, and main reads the
rest by request.

### Input and echo path

A keystroke used to cross main twice. The renderer invoked `session:write`, main ran the draft
ledger and the write queue and posted the bytes to the host, and the echo came back as a host event
that main forwarded on `session:data`. Anything that held main's event loop held every terminal's
echo, and anything that held the host's held them all as well. Every process the host started ran
CreateProcess synchronously on its one thread, and under a disk load a single git start took
hundreds of milliseconds (measured below on Windows 11, 2026-10-25, with
`kangentic_devtools_scroll_latency` typing into the mock agent).

Now each renderer holds its own port to the host and main never relays a keystroke or an echo:

- **The port.** At load the preload asks for one (`PTY_PORT_REQUEST`). `sessions.ts` creates a
  `MessageChannelMain`, gives the host one end (`attachRendererPort`, keyed by the renderer's
  webContents id) and posts the other to the preload (`PTY_PORT`), which keeps it in
  `PtyPortClient` (`src/preload/pty-port-client.ts`, web APIs only). `sessions.write`, `onData`,
  `ackData` and `getScrollback` keep their `ElectronAPI` shape. A reload asks again and the host
  replaces that renderer's port. A host restart issues every renderer a new one, then replays each
  renderer's focus set. Under the in-process fallback main holds the host's end, so typing crosses
  main only there.
- **Output goes only where it is shown.** The host keeps each renderer's focus set
  (`setRendererFocus`) and sends a flush to the ports whose set holds the session. Acks come back on
  the same port. A flush no port took (a reloading page still in a focus set) does not count toward
  backpressure, since nothing will ack it.
- **One write queue, in the host.** A renderer's keystrokes and main's writes (an injected command,
  a paste, dictation) share the PTY's queue (`write-queue.ts`), so a key never lands inside a large
  paste. The prompt-draft ledger records each write in queue order and the host reports changes
  (`promptDraft`), which main mirrors for `getPendingDraft`. The host also reports the first write
  that carries a human's key or text (`userInput`, once per session), which is how main learns a
  Command Terminal was used when the keys never crossed it. Keystroke injection asks the host
  instead (`readPendingDraft`), so a key that reached the host on a port just before is counted.
  `drain()` is a host request. Every
  place main drops a session's PTY handle calls `sealUserInput()` first, so the host stops writing a
  renderer's keystrokes into an agent that is exiting, while main's own exit sequence still goes
  through.
- **The replay stays ordered.** `getScrollback` still goes through main, behind that renderer's
  resizes on main's ordered channel to the host. The host answers on the asking renderer's port, so
  the answer follows the output it flushed before the sample. A port replaced while the sample
  settled (a reload) gets no answer: the reloaded page numbers its requests from 1 again. `useTerminal` asks for the scrollback
  only once its grid request has resolved, and resolves the replay off the scrollback alone.
- **No process starts on the host's I/O thread.** Every one-shot child, CLI run and process-table
  tool starts on the host's spawn worker (`src/main/pty/host/spawn-worker/`), a `worker_threads`
  Worker that loads only `node:` built-ins and pure modules. node-pty cannot move, since a PTY's
  handle belongs to the thread that spawned it, so `pty:spawn` stays on the I/O thread at 5 to 38 ms
  under load.

Both builds, run back to back on one machine the same afternoon, two to four runs of each load per
build (ranges across runs):

| Load | Echo p99 / max, before | Echo p99 / max, after | Kangentic's share max, before / after | Neighbour's longest gap, before / after |
|---|---|---|---|---|
| idle | 3.7-21.5 / 4.7-22.1 ms | 7.9-10.0 / 9.3-11.5 ms | 8.9-9.4 / 14.0-19.8 ms | 139-170 / 79-83 ms |
| `npm ci` with an agent started 8 s in | 3.2-7.7 / 8.5-8.9 ms | 7.9-27.2 / 8.4-38.9 ms | 14.0-15.9 / 13.6-19.2 ms | 94 / 84-92 ms |
| main held 0.8 to 1.3 s, three times | 913-920 / 914-920 ms | 8.4-9.0 / 9.1-10.9 ms | 917-924 / 9.6-10.4 ms | 1,040 / 79 ms |
| Done move of a full `node_modules` | 37.1-52.0 / 221-266 ms | 7.8-9.1 / 8.7-22.7 ms | 228-270 / 14.0-25.6 ms | 296-321 / 80-86 ms |
| worktree create with an `npm ci` init script | 6.0-13.5 / 24.0-28.4 ms | 8.3-9.5 / 8.4-41.8 ms | 24.7-30.1 / 14.0-14.3 ms | 153-156 / 84-85 ms |

Echo is the keystroke leaving the renderer to its first output arriving, so it includes the mock
agent's own answer, which varied from 1 to 41.5 ms between runs under the disk load (the idle 21.5
before and the 27.2 and 41.8 after are that). Kangentic's share is input-to-paint minus that
answer, the number to compare. The neighbour is a second mock repainting at 20 Hz, so 79 ms is its
own cadence. The trade reads straight off the share column: idle and the `npm ci` load cost about
one frame (idle input-to-paint p50 5.0 to 9.3 ms, explained below), and the loads that stall main or
the host's thread go from hundreds of milliseconds to under 26. The main row holds main with a synchronous
SQLite query through the devtools bridge and types from inside the renderer, since the tool's key
drive runs through main itself. Before, each held keystroke waited the whole stall in main. In the
before build's Done moves, git starts held the host's thread for 250 to 304 ms and froze both
terminals together; in the after build the same starts took 96 to 198 ms on the spawn worker and
neither terminal moved. Main also stalled for 177 ms in one after-build Done move, and that run's
echo peaked at 15.5 ms. The `npm ci` load did not slow CreateProcess in these before runs (git
starts of 22 to 28 ms), so it shows no gain here; the case for the spawn worker rests on the Done
move and on real use, where a dogfooding instance recorded single git starts of up to 6.9 s on the
host's thread. An earlier
before run of the init-script create, under a heavier disk load, reached p99 293 ms and max 454 ms,
with CreateProcess taking 190 to 454 ms per git start on the host's thread.

The Done move's `node_modules` deletion does not hold main's thread: a cheap IPC round trip every
50 ms measured p99 1.3 to 2.7 ms through most moves. What main felt was its own small synchronous
file calls slowed by that disk load. The 177 ms stall above was the probe's own round trip:
`config:get` read the project's `config.json` with `readFileSync` in `getEffectiveConfig`, which
spawns and moves also called, reading the file 14 times for one task start and 9 times for a Done
move. An agent
start under the same load once held main 108 ms truncating the session's status files
(`StatusFileReader.attach`). Both now wait off main's thread: `getEffectiveConfig` serves cached
overrides (see `docs/settings/cascade.md`) and the spawn empties the status files asynchronously
before the agent starts. Across three agent starts and two Done moves after that, main read the
config file synchronously zero times, no stall was attributed to either, and a round trip to main
that touches no file measured p99 1.6 to 2.2 ms. One synchronous write remains on an agent start:
Claude's adapter writes its merged `settings.json` inside `buildCommand`, which every adapter
implements synchronously, and under the load it once held main 124 ms. None of these reach typing.

**Why an idle echo paints one frame later than before.** Chromium's `DeferRendererTasksAfterInput`
holds a posted message, and a timer, until the frame after an input event has painted. The old
echo arrived as an IPC message, which the feature does not hold. A port message is held, so the
echo misses the keystroke's own frame. A renderer-local `MessageChannel` probe on real keydowns
measured key to frame at 3.4 ms and key to message at 4.2 ms (p50), with the message after the frame
in 60 of 60. `transportLegs` on the latency tool shows it as the host-to-renderer hop: 2.7 ms at
p50 and 7.9 ms at most, one 120 Hz frame, against 0.1 ms for the keystroke's hop to the host. Idle
input-to-paint went from 5.3 ms to 9.4 ms at the median. Turning the feature off brought the echo
back to 0.8 ms and input-to-paint to 4.7 ms, but React's scheduler posts its work the same way, and
six reorder drags then painted their drop 15 to 62 ms after release with seven long frames, against
29 to 40 ms and none with the feature on. The feature stays on. VS Code's terminal also receives
its output over a MessagePort.

**The renderer's own work between keys.** A key's handler and its echo's paint both wait for the
renderer's main thread, so a React commit or a terminal build that lands between two keys holds
the second key. The latency tool times each key from its own `keydown` event time
(`keyToSend`, `keyToPainted`, `slowKeys`), which counts that wait; a timer that starts at the
handler cannot see it. Two costs landed between keys while agents worked:

- **Every board reload re-rendered the whole app.** An agent's task update reloads the board, and
  the reload handed `swimlanes`, `archivedTasks`, `shortcuts`, `automations` and the board
  profiles new arrays even when nothing in them changed. `AppLayout` read `swimlanes` through the
  onboarding hooks, each task window's detail host carried it in its context value, and every
  `useSensor` call passed an inline options literal, which dnd-kit memoizes by identity, so each
  board render rebuilt the context every card and column reads. Now an unchanged list keeps its
  identity (`keepIfUnchanged` and `keepIfSameJson` in `structural-sharing.ts`), the onboarding
  hooks select primitives, sensor options are module constants (`dnd-sensor-options.ts`), and the
  sortable `items` arrays are keyed on their ids. Measured in dev with a React commit recorder, one
  agent update went from 493 to 497 components in a 21 to 26 ms render, plus 93 more in a second
  commit for the open task window, to 249 components in 14 to 17 ms in one commit. What still
  re-renders is the changed card and its lane, plus the toolbar, the terminal panel and the status
  bar, which read the whole task list.
- **A spawned task's terminal was built between keys.** A build is 13 to 120 ms in dev and 21 to
  42 ms in production. The init queue now holds it while a key was pressed in any terminal in the
  last 500 ms (`terminal-typing.ts`, `terminal-init-queue.ts`). The stamp listens in the capture
  phase because xterm stops propagation of every key it handles, in the capture pass on its own
  textarea.

Agents updating idle tasks every 2 s while the rig types, three runs per build, dev, the fixes
toggled as one patch in the same preview:

| Typing | `keyToPainted` p99 / max, before | after | Longest wait before the key's handler, before / after |
|---|---|---|---|
| fixed 100 ms cadence, 320 keys | 18.5-39.4 / 39.5-41.6 ms | 14.2-18.3 / 16.4-19.5 ms | 22.0-28.7 / 4.1-10.9 ms |
| person-like bursts and pauses, 133 keys | 31.5-36.8 / 33.8-49.4 ms | 14.1-17.9 / 14.1-19.5 ms | 11.9-22.0 / 1.7-2.6 ms |

Spawns did not separate per key in that preview, where a build cost only 13 to 17 ms: an agent
creating two tasks gave a worst key of 14 to 22 ms either way. In a preview that had run for a
while, a build cost 109 ms, and a key typed during it waited 170 ms before the hold. Across six
drag-spawn runs per build, long frames outside the drag itself went from 11 (create 51 to 55 ms,
spawn 56 to 67 ms with the build inside) to 3 (spawn 51 to 54 ms, React only).

### Buffering and the scrollback ring

- PTY `onData` accumulates into a per-session buffer.
- A 16ms flush interval (~60fps) sends buffered data on the port of each renderer that shows the
  session (see Input and echo path above). A phone's stream gets every flushed byte as `tap`, for
  as long as it holds a `subscribeDataTap` subscription.
- **In the alt screen, output that answers input flushes on the next loop turn.** For 250 ms after
  input is written to a session's PTY (`PtyBufferManager.noteInput`, from the host's `write`
  command), an alt-screen session's flush runs on `setImmediate` instead of the timer. On Windows a
  16 ms timer fires on the system's ~15.6 ms tick, so the flush waited 16 to 31 ms (20 ms median),
  and that wait was most of a fullscreen agent's wheel-to-paint time (see "Where a wheel tick's time
  goes" below). A keystroke's echo is the same case: typing into Claude Code with a flooding session
  beside it went from 25.8 ms to 10.7 ms keystroke-to-paint at the median (30.2 to 16.3 ms at p95),
  with no change in CPU. Typing into a session that repaints at 60 Hz sends each of its frames on its
  own while the keys last: 67 flushes a second against 32 untouched, the same 31 KB/s, 1.5 points
  more renderer CPU, no long frames. Chunks read in the same loop turn still leave in one flush,
  output with no recent input keeps the timer's batching, and both re-arms stay on the timer: the
  replay hold's, so it cannot spin, and a backlog past one slice, which is a stream and would
  otherwise drain to the renderer every loop turn while someone types. Nothing else spaces prompt
  flushes apart. A session producing faster than 60 Hz while someone types flushes once per loop
  turn that read output, held back only by the in-flight backpressure below, and that case is not
  measured. A minimum spacing between flushes was the alternative, and it was not taken: in the
  60 Hz case the previous flush is always under 16 ms old, so a keystroke's echo would go back on
  the timer. Every number in this bullet is from Windows 11. On macOS and Linux a 16 ms timer fires
  close to 16 ms, so the prompt flush saves less there, and that saving is not measured either.
- **Inline renderers keep the timer.** A normal-buffer agent whose output is taller than its
  terminal answers a keystroke by clearing and reprinting itself through the viewport, about 6
  chunks over 13 ms, and the timer is what kept that redraw in one paint. Gemini CLI in a 10-row
  bottom panel painted 3% of its echoes half-drawn on the timer and 77% on the next loop turn
  (2026-10-24, the `tornPaints` stat of `kangentic_devtools_scroll_latency`). In a tall window its
  echo is one chunk, and the next loop turn took it from 35 ms to 8 ms with nothing torn, so a gate
  that tells the two cases apart could recover that gain. Claude Code's fullscreen echo also counts
  as torn on that stat, but its two pieces are identical full repaints, so no paint between them
  shows anything wrong.
- **A flush that reaches no one drains the whole buffer.** The 256 KB-per-flush cap
  (`MAX_BYTES_PER_FLUSH`) protects a renderer or a phone from one huge write, so it applies only
  when the session is in the focused union or tapped (`hasFlushConsumer`). Before that, an
  off-screen session writing faster than 256 KB a tick grew its pending buffer without bound until
  the host died on `RangeError: Invalid string length` (measured: a crash at 533.75 million
  characters, every session lost and resumed). While it grew, the host spent 98 to 100% of a core
  slicing the string, and Claude's echo in another session took 69 ms at the median and 176 ms at
  p95. Draining whole, the same flood cost the host 44.5% and the echo was back at 26 ms.
- **The pending buffer is a second reason to pause the PTY.** An on-screen flood drains at most
  256 KB a tick, about 11 MB/s, and the renderer acknowledges that fast, so the in-flight count
  (`BACKPRESSURE_HIGH_WATER`, 1 MB) never paused it while the pending buffer climbed 5 million
  characters a second toward the same crash. `BackpressureController.recordPending` pauses the PTY
  once pending passes `PENDING_HIGH_WATER` (4 MB) and resumes it only when pending is back under
  one slice and in-flight is low too. Ordinary output never reaches it: Claude streaming a 300-line
  answer peaked at 1,901 characters pending, a 60 Hz full-screen repaint at 2,359. A pause stops
  reads only, so typing still reaches a paused session. Sampled back to back for 30 s, an on-screen
  flood peaked at 4,201,475 characters pending (the high water plus one read) and was paused in 17%
  of samples. The host's working set stayed between 235 and 297 MB with no climb, so paused output
  does not pile up below the host instead. The flood delivered 14.8 MB/s at 31% of a core for the
  host, against 11.3 MB/s at 81% while its pending buffer grew.
  A phone-streamed session is sliced too, so a phone watching a flood now pauses the agent where
  the host used to crash.
- **A pause no ack answers is released after 10 s.** A paused PTY reads nothing, so no flush
  comes along to notice that its renderer stopped acking. Task #912 is the case: a dev hot
  update threw under the root error boundary, and the page lived on with its port and its focus
  set but no xterm. The host kept posting output, nothing acked, and the agent and the phone's
  mirror sat paused for 10 minutes until a reload. The host now runs a 1 s check while any
  session is paused (`STALE_PAUSE_CHECK_MS`, an unref'd timer armed only then and cleared on
  shutdown). `BackpressureController.releaseStalePauses` resumes a session paused on in-flight
  bytes once it has gone `STALE_PAUSE_MS` (10 s) with no ack since the pause or the last ack. That
  bound sits above every hold a live renderer makes without acking: the scrollback watchdog
  (5 s), the frame hold (2 s), and mounts measured at up to 6 s under CPU throttle. The release
  resets the session's in-flight and raises its high water to `RELEASED_HIGH_WATER` (8 M
  characters, 8 times the normal one) until the next ack shows a renderer consuming again. A
  dead renderer then costs the agent one 10 s wait per 8 M characters. A renderer that is alive
  but stalled past 10 s gets at most that much more before the host pauses again. Without the
  cap, the host posted at the flush's ~11 MB/s for as long as the stall lasted. The first ack
  restores the normal high water and keeps counting what was sent while released, so a thawed
  renderer works through that backlog before more output comes. A pause the pending buffer
  holds stays, because that one protects the host.
  Each release prints a `[pty-host]` warning, which reaches main's log, so a packaged build
  records it too. Measured in a preview (2026-10-26), with a stand-in agent writing 640 KB/s
  into a Command Terminal and the renderer held in a 16 s busy loop: paused at 1,055,377
  characters in flight, released 10,104 ms later while the renderer was still frozen, and the
  warning landed in the project log.
- **The root error boundary releases its window's focus.** `ErrorBoundary.componentDidCatch`
  publishes an empty focused set and empties the renderer's registry (`syncFocusedTerminals`), so
  main stops routing output to a page whose terminals are gone. Try again remounts the tree, and
  its publisher sends the set again as on a cold boot. The publishers themselves have no cleanup,
  on purpose: Fast Refresh re-runs every effect, so an unmount cleanup would drop and restore
  every focused session on each dev save. A `PanelErrorBoundary` is narrower and releases
  nothing: one that catches inside a Command Terminal window unmounts that terminal while its
  session stays in the window's focused set, and the 10 s release above is what keeps that
  agent running.
- A 512KB scrollback ring buffer per session supports terminal restoration.
- **Alt-screen sessions - and non-alt sessions whose byte ring spans an effective geometry
  change - replay the parsed grid, not the byte tail.** A raw byte replay is not a
  frame snapshot: a fullscreen TUI leaves write-once static cells (box rules, mode labels)
  undrawn after a clear, so once a session outgrows the 512KB ring their drawing bytes are gone
  and a remount at unchanged geometry (no SIGWINCH, so no fresh repaint) paints a permanently
  holed frame. A multi-geometry ring is the normal-buffer twin of that problem: Claude Code's
  default (non-fullscreen) renderer is a TUI in the normal buffer addressing rows absolutely
  per-geometry, and Windows ConPTY re-emits even plain shell output the same way, so replaying
  bytes drawn at one grid into an xterm at another lands stale CUP writes mid-history and
  interleaves two frames' text on one row. `PtyBufferManager.getReplaySnapshot` therefore
  serves the headless PARSED grid (the same serialized frame `getSeedFrame` gives the
  mobile seed) when the session is in the alt screen or its ring is geometry-suspect, and the
  raw byte replay for stable-geometry non-alt sessions - a plain shell's scrollback IS the
  bytes, and truncation there only loses old history. The gate
  (`BufferState.geometryChangedAtRingIndex`) is armed by an effective resize while the ring
  holds bytes, shifted down by ring trims, and cleared once the suspect prefix trims out, so a
  long-lived session self-heals back to the full-history byte replay; a respawn carries it
  across via `initSession`'s `previousGeometry` (conservatively marking the carried ring
  suspect when the prior drawn-at geometry is unknown or changed). The pre-TUI strip is
  mirrored beyond the byte replay too, in two layers. The SOURCE layer: an agent spawn's
  typed command line, a transient session's included, is prefixed with the shell's own clear
  (`buildSpawnClearPrelude`: `Clear-Host; ` / `cls & ` / `clear; `), so the shell erases its startup preamble and command echo the instant
  the command executes - a real clear in the real byte stream that every consumer (live
  terminal, ring, parser, replays, phone) honors natively, immune to pwsh/ConPTY updates
  reshaping their startup bytes. The DETECTION layer: a fresh session's TUI-takeover clear
  (the first NORMAL-buffer `SPAWN_HANDOFF_CLEAR`, a `\x1b[2J` or `\x1b[3J`, PRECEDED by
  printable output - ConPTY's own escape-only startup clear must not consume the one-shot)
  injects an `\x1b[3J` (erase scrollback only) into the HEADLESS PARSER's stream and the LIVE
  FLUSH buffer (never the ring) and stamps `tuiStartIndex` at the same boundary, so neither a
  serialized frame nor a terminal that was already mounted at spawn resurrects the echo. It
  accepts both shapes because pwsh's `Clear-Host` and cmd's `cls` render through ConPTY as
  per-row erases plus `\x1b[3J` with no `\x1b[2J` at all, while a POSIX `clear` sends
  `\x1b[2J\x1b[3J`. Keyed on `\x1b[2J` alone, it never fired under PowerShell or cmd, and the
  byte replay fell back to ConPTY's startup clear and replayed the prompt and the typed
  command. The launch overlay's `AgentOutputTracker` finds the handoff with the same
  definition. The two layers stay INDEPENDENT, not chained: the prelude cleans every consumer
  purely in-stream with no Kangentic parsing, and the detection layer only stamps and repeats
  what the stream already did, so either alone suffices. The one-shot is bounded to the spawn: transient sessions (Command
  Terminals and a workflow's agent) never arm it, because the prelude already erases their echo
  in-stream and the one-shot would add only its risk (a late qualifying clear wiping history a
  Command Terminal user has already built up), and it expires after a takeover window
  (`PRE_TUI_TAKEOVER_WINDOW_MS`) so a mid-session repaint clear can never fire it against
  genuine accumulated history. Alt-screen sessions skip the
  injection (no user-visible scrollback to protect), and a carried-over ring opts out
  exactly like `tuiStartIndex` does, so a respawn's first clear cannot wipe genuine carried
  history. Every parser on this
  path - the headless grid,
  the renderer xterm that replays it, and the hand-rolled `VirtualScreen` probes - runs the
  Unicode 11 width table via `src/shared/xterm-unicode11.ts`, because xterm's default V6 table
  scores emoji single-width and drifts every autowrapped row of an agent TUI frame one column
  per emoji (see `.claude/rules/xterm-unicode11-parity.md`).
- **Do not trim the byte replay to the last full-screen clear.** Tried and reverted: it cut a
  512KB ring to ~1.5KB but produced a permanently black terminal on a fast open/close/reopen.
  Slicing at the last clear discards write-once cells, and a sample landing at or just after a
  clear replays a clear with nothing after it. The parsed-grid snapshot above is the safe shape,
  not a byte-offset heuristic; and since the byte path now serves stable-geometry normal-buffer
  sessions, a trim there would discard genuine user-scrollable history, not just a TUI's redraw
  bytes.

### Grid width and fit

- **One grid width per mount (deterministic fit).** `describeProposedDimensions`
  (`src/renderer/addons/fit-addon.ts`, the single implementation that both `proposeDimensions` and
  `fit` read) is a pure function of two inputs and no others: the container geometry, and the ACTIVE
  renderer's cell metric. It must not read anything else that can change while a terminal is
  mounting, because every distinct column count costs a PTY resize and a full agent
  repaint the user watches land. Holding the second input still across a mount or a reveal is the
  next bullet's subject. The rule exists because the fit used to reclaim the scrollbar
  gutter whenever the alternate screen buffer was active: the scrollback replay writes the TUI's
  alt-screen enter mid-mount, so the mount fit and the post-replay refit disagreed by two columns on
  every open (always, under the fullscreen renderer, which Kangentic turns on with `CLAUDE_CODE_NO_FLICKER=1`). That produced the "opens mis-sized,
  then refits" flash, and its stacked-repaint race intermittently left the terminal black with
  correct dimensions. xterm's own stylesheet sets `.xterm-viewport { overflow-y: scroll }`, so the
  gutter is reserved in the alt buffer too; it is now MEASURED (`offsetWidth - clientWidth`) rather
  than assumed, which is both correct and constant across buffer modes. The old hardcoded 14px
  against the real 8px gutter was the actual cause of the empty right-hand strip that the
  alt-buffer reclaim was mistakenly written to fix. The container geometry is the parent's box
  less the `.xterm` element's own padding, which `index.css` sets to 8px on the left, top and
  bottom to match Windows Terminal's default inset; the measured gutter is the right side's inset,
  so the text does not sit flush against the pane's edges. Gated by
  `tests/e2e/terminal-fit-invariant.spec.ts` (one distinct grid width per open, and the grid never
  wider than its viewport) and `tests/unit/fit-addon.test.ts`.
- **A user's layout change shows at once, each terminal holding its frame until the agent's is in
  (the frame hold).** A grid change shows the old frame reflowed onto the new grid (lines cut or
  wrapped, the input box mid-pane), then ConPTY's redraw of the old screen, then the agent's frame:
  the double paint this removes (measured on Claude Code 2.1.310 on Windows: ConPTY redraws within
  45 ms, the agent's frame lands 98 to 181 ms after the resize). So a user's gesture that resizes
  terminals goes through `runTerminalLayoutChange` (`terminal-layout-transition.ts`): a maximize or
  restore, a keyboard snap, a drop that docks or maximizes, a released edge, seam or footprint
  drag, closing a tiled window, a task window's panel toggles, the Command Terminal panel's maximize
  and released resize, Expand and Restore, adding, resuming or stopping a Command Terminal, each
  step of a Command Terminal swap drag's preview and its cancel, and the bottom panel's released
  height drag. The change runs at once and opens a landing on the nearest
  `data-terminal-layout-scope` (a window layer's overlay, the Command Terminal panel area, the
  bottom panel): once a terminal under it has fitted (`noteTerminalFitInLanding`), for at least
  150 ms and until two frames pass with no terminal pane or grid under it moving; until one has, up
  to 500 ms (capped at 700 ms in all), every host refits at once (`useTerminalRefit` skips its
  debounce) and a terminal whose grid would change holds its frame instead (`useTerminal`). Waiting
  for a fit is there because a change can reach its terminals through a render React runs in a task
  of its own: on a loaded runner the Command Terminal panel's re-tile came more than two frames, and
  later more than 150 ms, after the click (4 of 6 runs on two cores), after a landing that ended on
  a still layout had closed. A held terminal keeps xterm's grid, its
  drawn screen and the agent's output (in the incoming queue), and marks its host
  `data-terminal-frame-hold`. Where the frame still fills its new box (the box shrank both ways),
  it stays on screen pinned to the bottom (`translateY` on `.xterm-screen`), because an agent keeps
  its input box and newest output on the bottom rows; pinned to the top, a restore showed the
  banner with the input box cut off. Where it no longer fills the box (the box grew either way), it
  is not drawn at all (`opacity: 0`): the old text sat narrow and low in a maximized window. The
  element clips, so a frame larger than its box does not spill over what sits beside it. After
  one still frame the terminal sends the grid its box fits, once: a refit during the hold re-aims
  it against the same base, and a send waits a frame so a grid about to move again is not sent. It
  opens a repaint wait (`terminal-repaint-wait.ts`), which ends 20 ms after the first output chunk
  that finishes a synchronized update (DEC 2026) at least 90 ms after the send: measured with
  Claude Code in the desktop app, ConPTY's redraws of the old screen (which carry the same markers)
  all came within 65 ms, the agent's first frame at the new grid at 126 to 155 ms, and the one or
  two frames after it had identical text. Output with no such frame (no ConPTY on macOS and Linux)
  keeps the first rule: no sooner than 190 ms after the send, then 40 ms of quiet output. Either
  way it ends by 500 ms whatever the output does, and a refused or held answer releases it. The
  hold then ends in the gap between two frames: right after a paint, xterm resizes to the grid the
  PTY already has without a second send, the held output is parsed (the queue's `settled`), and
  the screen is shown on the next frame, after xterm's renderer has drawn it, so the next painted
  frame is the agent's. The screen is hidden while that runs, so output too large to parse before
  the next paint shows an empty terminal for a frame, never the old frame reflowed. A frame in a
  box that grew fades in from the background over 80 ms (an instant cut with Animations off). An
  element-scoped View Transition on the terminal's host did this first, and the screen came back
  from it blank for one or two frames at the cut, on the GPU as in software. Nothing holds the
  pointer, and keys reach the focused terminal throughout. A hold ends without waiting (dropped,
  the plain fit takes over) for a replay, a held grid, a terminal that leaves view, or a session
  change; one still open 2 s after its last change, or whose send throws, ends the same way, since
  a hold keeps its terminal's output back. There is no landing while the window is hidden, for a
  change an agent or main makes (a restore or project switch included, so the fade never replays
  on arrival), or for a hidden, parked or covered terminal, which refits as it always has. Gated by
  `tests/unit/terminal-layout-transition.test.ts`, `tests/unit/terminal-repaint-wait.test.ts`,
  `tests/unit/incoming-write-queue.test.ts` (the queue's `settled`), and the screencast cases in
  `command-terminal.spec.ts` and `task-detail-maximize.spec.ts`: a change shows at most one
  picture per terminal between before and after, never ConPTY's early redraw; a box that grows
  shows no old text, and its frame fades in with Animations on; a box that shrinks keeps its
  input box on screen in every frame, except the one unbroken run of blank frames painted while
  its screen is hidden, which is never longer than the dev trace's `framesHidden` (exact when the
  screen shows from the 50 ms frame fallback too) and ends before the agent's frame; a swap preview holds and sends one resize per step; plus the
  one-resize, held-output, cap and recovery cases beside them.
- **A window drag holds every window terminal's refit, and closes itself (the manager-resize
  gate).** The window manager's resizers (a window edge, a tile seam, a tiled group's outer edge,
  the Command Terminal panel's edges and its rail's edge) move frames imperatively per pointer frame, so each opens a
  gesture on `manager-resize-gate.ts` for the drag. While one is open, `TerminalTab` skips its
  per-frame ResizeObserver refit and `scheduleWindowTerminalResize` holds its ask, and the last
  gesture to close sends one, so a drag ends in one SIGWINCH. Because every window terminal waits
  on it, a gesture left open freezes all of their grids until a reload: measured once, a task
  window grew to 1981px while its terminal kept the 1483px grid it mounted at. So the gate never
  trusts an owner to close what it opened. While a gesture is open it listens on the window, and
  the first host pointer event that shows the primary button up (a move, an enter, a new press of
  the same pointer, a release no owner answered) or the window losing focus abandons it: the owner
  commits its drag as it stands and forgets it, then the gesture closes. There is no timer, since
  holding still mid-drag is a drag. A release's look runs a task after it, and input outranks
  that task: measured, it ran 61 ms late while a second drag began, so it abandons only the
  gestures open at the release, never one the same pointer opened since. A drag of the OS window's own edge shows the page no pointer,
  only a resize event per frame, and each one reached the PTY: measured, a 40-step drag sent 40
  resizes to a maximized task window's terminal, on this branch's base as well. So the gate watches
  the window's resizes too. A second resize within `WINDOW_RESIZE_SETTLE_MS` (150 ms) of the last
  opens a gesture of its own, which closes once the size has held that long, and then tells every
  terminal to refit (the bottom panel included, whose observer the gate held meanwhile). The same
  drag now sends 2, the first resize at once and one more when the size holds. A lone resize opens
  nothing and refits at once; the OS maximizing or restoring the window delivers one (measured in
  Electron 45). The gate opens on the second resize, but the observer reports the first resize's
  layout a frame or more earlier, so its 200 ms refit is armed with the gate still closed. That
  refit asks the gate again when its timer fires and waits while a gesture is open
  (`resolveRefitTimerAction`); fitting there moved the grid mid-drag and the PTY heard a third
  resize 200 ms after it, about one drag in ten. Gate opens and abandons go to the terminal trace
  with their owner. Gated by `tests/unit/manager-resize-gate.test.ts`,
  `tests/unit/use-terminal-refit.test.ts`, the unseen-release and OS window drag cases in
  `task-detail-maximize.spec.ts` and the seam cases in `command-terminal.spec.ts`.
- **Fit only on the renderer the terminal keeps.** The container is not the fit's only input: the
  cell metric is, and that comes from whichever renderer is attached
  (`terminal.dimensions.css.cell.width`). Parking a terminal disposes its WebGL addon for the
  GPU budget, and the DOM renderer it falls back to measures a WIDER cell, so an unchanged container
  proposes ~10% FEWER columns while suspended (measured: 210 attached, 191 suspended, at
  hostWidth 1483). `useFocusedSessionsSync` therefore applies the WebGL attachment plan BEFORE it
  publishes the parked set, because `syncParkedTerminals` fires reveal listeners synchronously and
  each one fits itself on the spot; the mount path already had this order
  (`attachWebglRenderer`, then the initial fit). With the order inverted, a Board -> Backlog ->
  Board round trip wrote main's full-width frame into the narrow grid and the refit widened it back
  WITHOUT reflowing - xterm reflows the normal buffer on resize and never the alternate one, so a
  full-screen agent TUI stayed hard-wrapped until something forced a repaint. As a backstop for
  the other ways the width can move across a REVEAL replay's async gap, `resolveReplayWidthAction`
  (`useTerminal.ts`) compares the grid width at the write against the width after the post-write
  refit and re-issues the replay once on a mismatch. It is wired into `reloadScrollback` only. The
  mount replay has the same structural gap but is usually not exposed to it: its fit runs after the
  WebGL attach, and it sends a real resize, so main serializes at the width it fitted to. The
  exception is a mount taken while the page is already at `WEBGL_ATTACH_BUDGET` - that terminal
  starts SUSPENDED, so its fit reads the DOM cell, and the coordinator's next plan can promote it to
  WebGL mid-replay, which is the same uncovered corruption. Widening the backstop to the mount path
  is left undone deliberately. `fit()` returns an applied/declined outcome so
  a silent bail (a collapsed container, an unmeasured cell) is distinguishable from a real resize in
  the `fit` trace. Gated by `tests/unit/replay-width-invariant.test.ts` and
  `tests/ui/window-reveal-grid-width.spec.ts`, which deliberately keeps WebGL on and asserts on the
  renderer trace ring, because the specs that read terminal CONTENT pass `--disable-webgl` and so
  cannot reproduce a renderer swap at all.

  A terminal CONFORMED to a held grid (below, in [Width self-heal and geometry re-assert](#width-self-heal-and-geometry-re-assert)) needs a third answer here, because the two above
  cannot reach it: it runs at a derived font, so it cannot simply re-measure its natural cell at
  the configured size the way an unheld terminal does, and the grid it probes main with would
  drift by that same ~10% across a swap. `attachWebglRenderer` therefore takes an
  `onRendererChange` callback, fired on each real flip (attach, context loss, budget suspend,
  resume), and `handleRendererChange` answers it: an unheld terminal re-measures, while a held one
  rescales its remembered natural cell by how far its conformed cell moved across the swap and
  re-conforms the held grid for the new metrics.

### The resting grid and phone-streamed sessions

- **A session nobody is showing goes to the resting grid.** A PTY has ONE
  grid and every surface fits it to its own box, so a session last shown in the bottom panel was
  left at that panel's strip - measured live at 306x14 - with nothing to give it back. The agent
  then kept working in a 14-row window, and a paired phone (which mirrors the desktop grid 1:1 and
  cannot reshape a shared session) could not fill its screen from 14 rows no matter what it did
  locally. `SessionManager.scheduleRestingGridRestore` parks such a session at the RESTING GRID
  (`RESTING_GRID_COLS x RESTING_GRID_ROWS`, 210x48 - detail-shaped on purpose, not the 120x30
  spawn default: the phone mirrors the resting grid 1:1, and a phone-fitted narrow grid was
  built, live-tested, and judged LESS readable than the desktop's own layout, whose rules and
  boxes are drawn for a wide frame) after `RESTING_GRID_DELAY_MS` (1s). The park is a MOBILE
  feature and is gated on mobile interest: it fires only for a session a paired phone is actually
  streaming (`MobileTerminalProbe.hasStreamSubscriber`, answered from the bridge's per-device
  subscription registries), and a phone subscribing to a session that went unheld earlier, or
  whose only hold is a focus claim with no xterm mounted or a grid under the 20-row floor, gets an
  immediate park instead (`parkRestingGridForMobileSubscriber`, called by the read-stream
  subscribe handler BEFORE it serializes the seed, so the one snapshot already carries the
  resting grid). A desktop that never pairs never parks at all - no probe, no bridge registries,
  byte-for-byte the pre-park behavior. Three further guards make a firing park safe: the
  background park fires only when NOTHING holds the session - unfocused AND no renderer has an
  xterm mounted for it (`session:setMounted`, published by `terminal-mount-registry` from each
  terminal's own mount effect; the subscribe-time park overrides two holds, see path 3 below and
  the row floor in the next bullet); it never touches a grid a phone is holding (the armed size guard consulted through
  `MobileTerminalProbe.isSizeHeld` - the guard registry, never a last-writer origin, which a
  desktop resize overwrites while the hold stays armed); and it no-ops when the PTY is already at
  the resting grid. The park resizes with origin `'park'`, which deliberately does NOT update
  `lastDesktopDimensions`: that map is the restore target for a phone's `release-size`, and a
  park recording itself there made release "restore" the phone to the park instead of the
  desktop's grid. After a release the guard teardown asks for the park decision to re-run
  (`reconsiderRestingGridAfterMobileRelease`), so an unheld session returns to the resting grid
  and the phone's next visit finds park dims again. The mounted set is the load-bearing hold: a
  PARKED terminal (Backlog view, occluded window) is unfocused but still mounted, and xterm
  re-sends dimensions only when its OWN size changes, so a PTY reshaped underneath one would
  disagree with it permanently - and the reveal deliberately skips its resize. Cost when it does
  fire: the next open of that session pays the marker settle (~20-40ms) because the grid changed
  while it was away, which is what any surface switch already pays.

  The park also reaches a session nothing has laid out. A PTY with no grid to inherit or restore
  spawns at the 120x30 default (`DEFAULT_PTY_COLS/ROWS`), and only a focus or mount change used to
  re-run the park decision,
  so a phone could open an Executing task and mirror 120x30. Three paths close that:
  1. `doSpawn` re-runs the decision when a PTY comes up (`reconsiderRestingGrid`), so a PTY born
     unheld while a phone streams its id parks after the usual delay.
  2. A full queue hands back a `queued` placeholder with no PTY, and the task row (so the phone)
     learns that id. The promotion keeps the id, so the phone's subscription survives into the
     real spawn. The park stashes the resting grid for such a placeholder in `pendingResizes`, so
     the promotion spawns there with no reflow mid-boot, and the seed served at subscribe already
     reports 210x48. A suspended row is left alone: its resume spawns under a NEW id, and that
     spawn drops the grids kept for the row it replaces (`forgetSessionGrid`). A resize that
     reaches the placeholder during the promotion's own host round trip is stashed after the
     spawn read its stash, so the spawn drops it once the new row is registered
     (`discardPendingResize`); left behind, it would outrank the PTY's real grid at a later
     respawn. Path 1 still re-runs the park decision for the new PTY.
  3. The subscribe-time park also overrides a focus claim with no xterm mounted anywhere (a
     minimized pop-out monitor, a detail window whose Changes view unmounted its terminal). Such
     a claim holds no grid, so nothing can disagree with the reshape, and the surface fits the PTY
     to itself when its terminal does mount. The background park still treats a focus claim as a
     hold.

  A respawn of a session the phone was watching starts at its predecessor's grid, normally the
  resting grid (see Repaint-settled scrollback sampling below), so the phone's re-subscribe on the
  new id finds nothing to park and the agent is not reshaped mid-boot.

  Gated by the `Resting grid restore` block in `tests/unit/session-manager.test.ts`,
  `tests/unit/terminal-mount-registry.test.ts`, and the park assertions in
  `tests/unit/mobile-bridge/{interactive-terminal,read-stream}.test.ts`.
- **A phone-streamed session is never rendered by the bottom panel, and never drops below the
  mobile row floor.** Terminal ownership is one xterm per PTY, and a phone mirrors the grid 1:1
  with no way to escape a strip-shaped fit: when the expanded bottom panel survived a
  detail-close as the owning surface, its fit took the grid to the 306x14 strip and the phone
  showed a sliver; and when the park reshaped a session under an unmounted-then-revealed panel
  xterm, the reveal's `skipResize` replay left the panel permanently mis-wrapped (both observed
  live 2026-08-02; user decision: the panel is a utility surface - the task detail is primary,
  and the phone must never inherit the strip). Three layers enforce it:
  1. **The gate is terminal-wanting subscriptions, not the bare stream key.** The phone holds a
     list-only stream subscription for EVERY live session whenever it is connected, so
     `MobileTerminalProbe.hasStreamSubscriber` answers from the `stream-terminal:<id>` marker
     that `read-stream` registers only for `terminal: true` subscribes (and removes on every
     release path). Gating on `stream:<id>` made the park fire for the entire board.
  2. **The panel drops the tab of a phone-streamed session entirely.** Main pushes the
     terminal-streamed set to the renderer (`MobileBridgeService.terminalStreamedSessionIds`,
     `mobile:terminalStreamsChanged`, mirrored by `useMobileTerminalStreamsSync`), and
     `derivePanelSessions` folds it into the `owned` exclusion - the same no-tab treatment a
     detail-owned session gets, so no panel fit ever contends with the park, and the focused
     set, the parked/reveal plan, and the WebGL budget all follow from the shared derivation.
     No placeholder (user decision 2026-08-02): the user watching that session is on their
     phone, not at the desk, and the tab returns the moment the phone lets go. A task-detail
     window still mounts a real terminal: the detail is primary and its grid wins while open.
  3. **`SessionManager` backstops the races** (`MOBILE_USABLE_MIN_ROWS`, 20): `resize()`
     REFUSES a desktop-origin resize below the floor while a phone streams (before
     `bufferManager.onResize`, so the headless parser never diverges from the real PTY; the
     refused grid still records `lastDesktopDimensions` as the restore target), and
     `parkRestingGridForMobileSubscriber` overrides a desktop HOLD below the floor, rescuing a
     phone that subscribes to a session the strip captured before the phone arrived (and a focus
     claim with no xterm mounted, path 3 above).
  A desktop with no terminal-streaming phone never hits any layer: the panel renders and owns
  grids exactly as before the park existed. Gated by the floor tests in the `Resting grid
  restore` block of `tests/unit/session-manager.test.ts`, the terminal-marker tests in
  `tests/unit/mobile-bridge/read-stream.test.ts`, the change-hook test in
  `tests/unit/mobile-bridge/subscription-registry.test.ts`, and `panelTerminalSessionIdFor` in
  `tests/unit/focused-sessions.test.ts`.

### Width self-heal and geometry re-assert

- **The width-drift self-heal (PTY dims echo + owner re-assert).** xterm re-sends its dimensions
  only when its OWN size changes, so a PTY reshaped under a mounted xterm (a lost or overridden
  resize on a surface flip, a respawn at stashed dims, any last-writer-wins race - `resize()`
  carries no surface identity) used to diverge with NO recovery path: with the Windows
  full-repaint flag every frame is absolute-positioned at the PTY width, so the mounted grid
  rendered a staircase (rows shifted progressively right, labels clipped) until the window was
  resized by hand. Main now broadcasts `session:ptyResized` (`SESSION_PTY_RESIZED`) whenever the
  PTY's grid ACTUALLY changes - the same-dims short-circuit runs first, so the echo of a
  terminal's own resize always carries its own dims - with the resize's origin
  (`PtyResizeOrigin`: `desktop`/`mobile`/`park`/`spawn`). It is a broadcast, not a focus-routed
  push: a freshly mounted xterm can miss a routed echo during exactly the mount window where a
  divergence is born, and echoes only fire on real grid changes. The mounted owner's listener
  (`useTerminal`) compares the echoed dims to its own and, when they disagree, re-asserts its
  fitted grid after a 150ms coalescing debounce and repairs the already-garbled frame with a
  `reloadScrollback({ skipResize: true })` replay (the resize it just sent armed the repaint
  settle, so the reload samples the frame drawn at the corrected width). The guard matrix is the
  pure `resolvePtyEchoReassert` (exported from `useTerminal.ts`): in-sync self-filter first,
  then foreign-hold (`mobile`/`park` origins - a phone or the park legitimately holds the grid;
  `spawn` is healable), refused-hold (see below), parked, replay-in-flight, own-resize-pending,
  and last a TIME-WINDOWED budget. A replay-in-flight or parked skip is deferred, not
  dropped (`isPtyEchoDeferredToReplaySettle`): a replay sends a resize only when its fit changes the
  grid, and a PTY reshaped under the terminal changes nothing on its side, so `settleScrollback`
  judges the last echo again once the replay ends. A parked skip is deferred the same way: the
  reveal reloads with `skipResize`, so its settle is the first judgment that can heal, and a
  settle while still parked skips as parked again. The same holds for a re-assert whose debounce
  fires while a replay is in flight or after the terminal parked (traced
  `echo-reassert-deferred`). Before this, a rogue resize landing during a slow replay, or while
  the terminal was parked, was never healed. The budget allows 2 re-asserts per divergence signature per 10s and is
  deliberately not reset by an in-sync echo, because in a two-surface fight each side's successful re-assert
  lands an in-sync echo at the other side, so a reset-on-heal budget never binds in exactly the
  livelock it exists to bound. `resize()` also reports `refused: true` from the mobile sub-floor
  branch (the one path where main deliberately holds the grid against the caller), which arms a
  time-stamped refusal hold after a single refused IPC: no further re-asserts for the budget
  window, whatever dims later echoes carry (time-stamped rather than signature-keyed, because
  the pre-send fit can move the terminal's own dims and a burned signature would stop binding
  exactly then). The refusal also names the grid main keeps (`SessionResizeResult.held`), and
  the terminal CONFORMS to it (`conformToHeldGrid` in `useTerminal.ts`): it resizes its own
  xterm to the held grid and scales its font DOWN to fit that grid into the pane, letterboxed
  and never above the configured size (`CONFORM_MAX_SCALE` is 1), so the frame the PTY paints
  is the frame the user sees rather than the taller grid clipped. The size it takes is the
  LARGEST quarter-pixel size at which the grid fits. It proposes one from a linear model of the
  cell, steps down while rounding leaves the grid over the box (up to 12 quarter-pixel steps,
  `CONFORM_MAX_STEPS`: one device pixel of cell width spans about 1.8px of font, and a budget of
  4 declined a 154 x 37 grid the pane could show once the terminal gained its 8px inset), and, when the proposal fit at
  once, steps back UP while the grid still fits (`CONFORM_MAX_STEP_UPS`): a cell is not linear in
  the font (the renderer floors its width to device pixels, and a face's height can drop a whole
  pixel between two sizes), so the proposal alone could stop a size short and letterbox rows the
  pane had room for. A
  held terminal keeps probing main with the grid it would fit on its own, and the first accepted
  probe releases the hold and restores the configured font. Only the container fit probes
  (`fitTerminal`'s probe argument, passed true by the `fit()` callback alone): a replay, a reload,
  or a renderer swap re-conforms the held grid without asking main anything.
  A conform that the pane cannot show (the grid needs type below the 4 px floor, the box cannot
  be measured, or the step-down budget runs out before the grid fits) is DECLINED: the hold is
  released and the terminal keeps its own fit, rather than committing a font size nothing
  verified. The web demo's mock holds a replayed session through the same answer, at the grid its
  pane takes in the smaller type that carries the recording's columns (demo/README.md, "Live
  replay"). Gated by `tests/ui/terminal-held-grid-conform.spec.ts`.

  Every renderer resize sender now traces `resize-request` with an origin
  tag (`mount`/`flush`/`reload`/`echo-reassert`/`debounced-onResize`) and main traces every
  resize outcome (`resize-applied`/`resize-noop`/`resize-refused`/`resize-stash`/
  `resize-ignored`/`resize-invalid`/`resize-failed` (node-pty threw on a just-died child; main
  records the failure and returns `{ colsChanged }` rather than rejecting the renderer's invoke),
  plus `resize-reassert`/`resize-reassert-failed` from the post-boot re-assert below), so
  `kangentic_devtools_terminal_state`'s merged trace
  names the trigger if a divergence ever recurs. A resize for a queued or suspended session
  stashes (including suspend's marked-but-alive teardown window, where the PTY is still
  non-null but must not be reshaped or re-echoed; never a phone's grid, see the respawn
  paragraph below); one for a missing or exited session is ignored. Gated by `tests/unit/pty-resize-echo-reassert.test.ts` (the guard
  matrix), the emit/refusal pins in `tests/unit/session-manager.test.ts`,
  `tests/ui/terminal-resize-echo-reassert.spec.ts` (real xterm wiring: re-assert, repair,
  self-echo no-op, budget bound), and `tests/e2e/terminal-width-drift-selfheal.spec.ts` (a real
  PTY driven to the incident by a rogue `sessions.resize`, healed back to the owner grid).
- **Post-boot geometry re-assert (the spawn-window race).** ConPTY only delivers a
  resize to a connected client, so a resize applied while the agent is still booting (the fit
  lands ~140ms after `pty.spawn`) can be lost, leaving the child composing at the spawn width
  inside the fitted grid while `ptyMatchesGrid`/`colsDrift` read healthy. `resize()`
  arms `ManagedSession.resizeAppliedBeforeTuiReady` when it applies a resize while the stream is
  not in the alt buffer - NOT keyed on the first-output latch, which a shell preamble can
  trip seconds before the agent exists (pwsh 7.6's preamble carries the cursor-hide escape the
  adapters match; this shipped as a live recurrence of task #573 on 2026-08-30). Two triggers
  then re-deliver the geometry as a jiggle
  (`cols-1`, then `cols` back, traced `resize-reassert` with its `trigger`): the first-output
  latch (disarming only when the output provably came from the TUI) and the stream's first
  alt-screen entry via `PtyBufferManager`'s `onAltScreenEnter` (which nothing but the TUI can
  produce, always disarming). The arming criterion is the stream's CURRENT alt-screen state, not
  a once-ever latch, so a booted TUI resized during a normal-buffer excursion (`\x1b[?1049l`, or
  an RIS `\x1bc`) re-arms and re-jiggles on its next re-entry; that costs one redundant
  re-delivery of geometry the child already holds, and is accepted rather than tracked. Both call
  direct `pty.resize()` -
  deliberately bypassing `resize()`'s ladder, whose same-dims short-circuit would eat the
  restore leg and whose broadcasts would churn the echo budget, phone re-seeds, and settle for
  net-unchanged geometry. The third-layer diagnostic (`composedCols`/`composedMatchesPty` on
  `kangentic_devtools_terminal_state`) measures the width the child actually composes at from
  its raw ring, alt-screen sessions only. Pinned by the `Post-boot geometry re-assert`
  block in `tests/unit/session-manager.test.ts` and the respawn latch-cleanup tests in
  `tests/unit/session-spawn-flow.test.ts`; the diagnostic is exercised by
  `tests/unit/composed-width.test.ts` and `tests/unit/devtools-terminal-state.test.ts`.

### Scrollback replay

- **Repaint-settled scrollback sampling.** A session with no better grid spawns at a default
  120x30 (a respawn takes its predecessor's grid and a resume takes its recorded one, see below).
  A PTY that does start at the default, such as an auto-resume whose record carries no grid, sits
  at that size on a cold launch until a card opens and the renderer fits it wider. When a
  geometry-changing resize fires (cols OR rows), a full-screen agent TUI repaints its frame
  asynchronously in response to SIGWINCH. So `getScrollback` waits for that repaint to land and
  quiesce before sampling (`PtyBufferManager.waitForResizeRepaint`), so a terminal restored right
  after a resize replays the frame at the fitted geometry instead of a stale one. Width armed the
  settle first; rows-only changes (a bottom-panel height drag, a vertical-only window resize) arm
  it too since a 2026-07-31 live measurement: 12/12 trials sampled the old-row-count frame before
  the repaint, and the rows repaint always arrived 21-122ms later carrying a full `\x1b[2J` erase,
  so the marker settles the wait early rather than riding the ceiling. (The resize IPC's
  `colsChanged` report is unchanged - arming widened internally; nothing on the renderer or the
  mobile wire consumes a rows flag.) A ring with NO `\x1b[2J` anywhere takes a
  short wait of its own rather than the old instant sample: "no marker" at mount time also
  describes a fullscreen TUI that has not drawn its first frame yet (observed live as a 237-byte
  replay where a settled mount replays hundreds of KB), so the no-marker path samples on a
  post-resize erase (the first frame just landed), on a marker-less quiesce, or - for a session
  that answers SIGWINCH with silence, i.e. a plain shell - after a small grace
  (`NO_MARKER_SILENT_GRACE_MS`), bounded by `NO_MARKER_MAX_WAIT_MS` far below the TUI ceiling so
  Command Terminal opens stay fast. The wait is skipped entirely when the session has no live PTY
  (a suspended, killed, or pre-spawn session can never receive a SIGWINCH repaint, so the wait
  would only burn its deadline), and is bounded by a max-wait ceiling, so a missing or
  slow repaint can only delay a first paint, never hang the read. An actively streaming session
  never quiesces, so the wait also settles EARLY the moment a full-frame repaint marker lands in
  the bytes appended after the resize, outside any open synchronized-output frame - instead of
  burning the whole ceiling and sampling mid-repaint. The marker is the `\x1b[2J` erase ONLY: a
  bare `\x1b[H` cursor-home was tried and reverted, since TUIs emit it for ordinary partial
  updates (a live session showed 169 cursor-homes to 56 erases). A MARKER-LESS repaint no longer
  rides the whole ceiling: past `MARKERLESS_REPAINT_MIN_WAIT_MS` (a floor above the measured
  21-122ms marker-arrival window, so a genuine erase still wins) post-resize bytes that have
  quiesced settle the wait, because Claude's default renderer repaints WITHOUT an erase while
  idle (measured 2026-08-26: 12/12 idle detail opens rode the deadline at 407-422ms) and a
  premature sample is no longer the raw-replay wrapped-bytes flicker - every settle-armed sample
  takes the parsed-grid route, so the worst case is a correctly-shaped slightly-stale frame the
  held live bytes then update. True post-resize silence still rides the ceiling. STACKED resizes (a second
  geometry change while a RECENT previous repaint is still pending, e.g. rapidly closing and
  reopening a task detail ping-pongs the PTY between the dialog and bottom-panel widths) disable
  the marker-only settle - the first marker may be the previous geometry's late repaint - and
  require marker AND quiesce, falling back to the ceiling while streaming. An arm older than the
  400ms ceiling does not stack the next one: by then its repaint has landed or never will (the
  settle itself stops waiting at that ceiling), so an unconsumed old arm - a height drag nothing
  sampled after - cannot slow the next open. Concurrent samplers of the SAME
  resize (a bottom-panel tab and a detail window overlapping during a handover; in dev, StrictMode's
  double mount of a Command Terminal window - both terminal hosts defer their init off the mount
  commit via the shared `useDeferredTerminalInit` hook, which lets StrictMode's
  synchronous unmount cancel the first scheduled init, so each pair collapses to a single fetch
  and no throwaway xterm races the survivor; what matters here is cancel-before-run, not which
  frame the init lands on, since the shared queue in `terminal-init-queue.ts` can push a host
  contending with others several frames out) share ONE wait: the second joins the first rather
  than starting its own. Two
  independent waits could not both work, because the first to settle clears the pending-repaint
  state that the other's early-settle scan offset points at, so the loser could never settle early
  and rode the full ceiling out - a deterministic ~415ms added to that open. A resize that arrives
  before the PTY exists (the renderer mounts before the auto-resume spawn lands) is stashed and
  applied at spawn, so the PTY starts at the fitted size and no corrective resize is needed. A
  respawn needs a second source, because every board respawn (a column move, a model switch, a
  resume) mints a NEW session id, so a stash under the old id never reaches it. The successor
  therefore starts at the grid of the row it replaces (`SessionManager.successorGridFor`, read
  through `SpawnFlowContext.inheritedGrid`). That is a resize stashed while the old row was
  suspended, else `ManagedSession.lastPtyGrid` (its spawn grid, then every applied resize except a
  phone's, which the size guard owns and an exit disarms without restoring). The stash keeps the
  same exclusion: `resize()` never stashes a phone's grid, so a phone resizing a row in suspend's
  marked-but-alive window cannot hand its grid on that way either. Before
  this, a respawn spawned at 120x30 and whatever showed the old session reshaped it mid-boot: the
  surface's mount fit, or a streaming phone's resting-grid park. Each one was a resize plus two
  boot-time geometry re-asserts. Only a running or suspended in-memory predecessor hands its grid
  on; a killed or crashed row does not (though a resume of its conversation can still take its
  grid from the record, below). A sub-floor grid (the bottom panel's strip) carries over only
  while a surface still holds the old session, so a successor nothing shows never starts in that
  letterbox. A caller-supplied grid (`input.cols/rows`) and a same-id stash both win over it. Below
  it sits one more source, the grid recorded on the replaced session record
  (`SpawnSessionInput.restoredGrid`, see [Crash Recovery](crash-recovery.md#crash-recovery-session-recovery) step 7). It covers the resumes no in-memory
  row can speak for: after a desktop restart the registry is empty, and after a pty host crash the
  lost row is exited, which `successorGridFor` refuses. The record is written at every grid change
  by the `pty-resize` listener (`session-grid-persistence.ts`); the spawn's own announcement fires
  before the caller inserts the record, so that one write waits for `setImmediate`, and a desktop
  or park write that lands first cancels it. Gated by the `Respawn grid` block in
  `tests/unit/session-manager.test.ts`, the inherited and restored precedence cases in
  `tests/unit/session-spawn-flow.test.ts`, `tests/unit/session-pty-grid-persistence.test.ts`, and
  `tests/unit/session-pty-grid-migration.test.ts` (real SQLite through better-sqlite3, which loads
  under the unit tier's plain Node since its Node-API rewrite in 13).
  One reader deliberately OPTS OUT of this settle: `SessionManager.getOutputPeek`, which backs the
  Agent Monitor's live output peek. The settle exists so a captured frame becomes the terminal the
  user then looks at; a peek is a few throwaway lines resampled twice a second, so a mid-repaint
  sample self-corrects on the next tick, while awaiting the settle would cost up to the ceiling on
  every sample and force a synchronous read to become async. It reads the parsed grid row by row
  (`HeadlessFrameBuffer.cursorRow` / `lineAt`) rather than serializing a frame, and the line
  selection lives in `src/main/pty/buffer/output-peek.ts`.
- **DEC private mode and alt-screen re-assert on replay.** `xterm.reset()` on the renderer wipes
  every DEC private mode xterm is tracking, and the original mode-set bytes usually scroll out of
  the 512KB scrollback window on a long-running session. On the byte-replay path,
  `PtyBufferManager` tracks DEC private input/reporting modes (DECCKM, mouse tracking, bracketed
  paste, ...) from the live stream and re-asserts them as a prefix on `getScrollback` (#313), and
  a synchronized-output frame (mode 2026) left open by a mid-frame sample is closed with a
  trailing `\x1b[?2026l` so it cannot stall the renderer's ~1s safety timeout. Alt-screen (mode
  1049/47/1047) is tracked separately as `inAltScreen`; together with the geometry gate it routes
  the replay (see
  `getReplaySnapshot` above), and a session in the alt screen gets a serialized frame that carries
  its own addon-emitted alt-screen switch and mode re-asserts (mid-stream, after the serialized
  normal buffer - not a leading prefix, so nothing may `startsWith` on it), so the replay paints
  into the alt buffer with the right input modes (a replay landing in the normal buffer was
  previously the cause of a cursor left visually disconnected from the TUI frame). A
  geometry-gated NON-alt session gets the same frame shape minus the switch: the addon emits
  `\x1b[?1049h` only when the active buffer is alternate, so a never-alt frame carries none and
  replays into the normal buffer where the session lives. One mode class
  the addon cannot emit is the mouse ENCODING modes (1005/1006/1015/1016 - it re-asserts mouse
  TRACKING only), so `getReplaySnapshot` folds the tracked DEC-mode prefix onto every frame it
  serves (both routes); without
  it, a same-grid remount left xterm reporting legacy X10 mouse bytes that an SGR-expecting TUI
  ignores, and wheel scroll went dead until the TUI happened to re-assert its own modes.
  The DECSTBM scroll region is two integers of buffer state rather than a mode flag, so `IModes`
  has no member for it. Up to xterm 6.0 the addon dropped it. Since 6.1 (xtermjs/xterm.js#5547)
  it emits a non-full region as its last sequence, with no cursor restore after it, and DECSTBM
  homes the cursor. `HeadlessFrameBuffer.serialize` therefore appends the region again plus an
  absolute cursor restore; the repeated region is harmless, since DECSTBM is idempotent. Order is
  load-bearing twice over: the region must FOLLOW the frame (set before it, the frame's own row
  writes would scroll against it), and it must be followed by the CUP, because DECSTBM homes the
  cursor and would otherwise discard the position the addon's relative moves just rebuilt. The
  suffix is empty only when the region already spans the grid AND origin mode is off, which is the
  common case: with DECOM on it still emits a bare CUP, because the addon appends its own
  `\x1b[?6h` after its cursor restore and DECSET 6 homes the cursor too. Claude Code gates its own
  DECSTBM use on a terminal-capability probe and left it off under xterm.js in the last
  measurement (Claude Code 2.1.250 on xterm 6.0, with `claude --debug`: `XTVERSION: no reply` then
  `DECSTBM: gated`). xterm 6.1 answers
  XTVERSION by default (#5502), so the renderer swallows the query before its first write
  (`swallowXtversionQuery`, see `.claude/rules/xterm-query-replies.md`). The REGION half
  therefore guards against that gate reopening rather than repairing a live break. The
  origin-mode half repairs a live one.
  The parser can also hold cells the grid no longer has. xterm trims lines on a column shrink only
  inside its reflow branch, and the alt buffer has no scrollback, so it never reflows. A shrink
  while the alt screen is up left every alt line at the old width for the rest of the session. The
  addon walks `line.length`, not `terminal.cols`, so it serialized those off-grid cells, and where
  a row ended in null cells above a wrapped row it added its `-` wrap separator. Every reopen
  replayed text rows interleaved with dashed rows. `HeadlessFrameBuffer.resize` therefore cuts each
  alt line back to the new width and blanks a wide glyph the cut left half on the last column,
  which the replay would otherwise autowrap. The same trim keeps off-grid text out of the Agent
  Monitor peek (`lineAt`). A shrink before entering the alt screen was never affected, since xterm
  builds the alt lines at the current width. A renderer xterm keeps the same long alt lines, which
  are harmless on screen because it draws only `cols` cells, so its text readers go through
  `readViewportLines` (`terminal-capture-registry.ts`), which cuts each row to `cols`. That keeps
  stale off-grid text out of the conversation viewer's TUI anchor match and the devtools grid dump.
  `getScrollback` itself retains the `\x1b[?1049h` prefix gate, reachable now only via direct
  byte-path reads and `getReplaySnapshot`'s serialize-deadline fallback.
- **Hold, not drop, live output across a renderer-side replay.** While a scrollback replay is in
  flight (`scrollbackPendingRef`), the renderer's incoming-write queue HOLDS (retains, does not
  ack) rather than drops live PTY bytes, and flushes them in order once the replay's `afterWrite`
  completes. This closes a window where a live diff (e.g. a fullscreen TUI's selection-highlight
  redraw) could be silently discarded during a reattach. Only the loading overlay continues to
  drop-and-ack (its window can span the whole agent startup). A generation-aware `afterWrite` and a
  bounded watchdog timer additionally guard against a stale or stuck replay leaving
  `scrollbackPendingRef` true indefinitely, which would otherwise drop all live output forever.
- **But the held bytes that PREDATE the sample are dropped, not flushed.** The hold above must not
  be read as "every held byte is flushed after the replay": bytes main flushed BEFORE the
  `getScrollback` reply are, by construction, already inside the replay whichever shape it takes
  (a byte replay: main appends to its ring and its pending buffer from the same bytes and clears
  the pending buffer when it samples; a parsed-grid frame: the serialize is atomic with the
  parser's flush barrier so every pre-sample byte is baked in, bytes racing the sample ride the
  reply as an appended tail, and main holds the session's flush ticks for the sample's duration
  so nothing can be flushed ahead of the reply), so
  flushing them afterwards repaints a pre-sample frame ON TOP of the fresh one. Because a TUI then
  sends only differential updates, nothing repairs it and the terminal shows the previous geometry's
  frame until the next SIGWINCH - a task detail opening on a session at the bottom panel's 14 rows
  showed that 14-row frame in a 48-row grid until the window was resized by hand. Both replay paths
  therefore reset the queue the moment the sample resolves, before writing it, and trace what they
  discarded (`replay-drop-held`, with a byte count). Bytes flushed AFTER the reply are post-sample
  and still held, then flushed, exactly as above. This was latent until the deferred terminal init
  collapsed `TerminalTab`'s StrictMode double mount to one terminal: the second mount's replay had
  been overwriting the stale paint.
- **A replay never leaves the terminal both blank and held.** Two rules keep an aborted replay from
  becoming a permanently black terminal. First, `reloadScrollback` clears the terminal immediately
  before writing the new frame, not before fetching it: clearing first opened a window in which only
  a SUCCESSFUL replay ever repainted, so any abort (a newer generation, a rejected read) left the
  grid empty with every byte still sitting in the main-process ring and an idle agent with no reason
  to send more. The last good frame now stays on screen until the new one replaces it. Second, the
  stuck-replay watchdog RECOVERS (re-issues the replay once, at the already-synced width) rather
  than only unblocking the queue, since unblocking a queue does not repaint a cleared grid. The
  replay lifecycle is traced (`replay-start` / `-write` / `-abort` / `-done` / `-error` /
  `-watchdog`, each with its generation) and surfaces in `kangentic_devtools_terminal_state`, so an
  abandoned replay is readable directly instead of inferred from a missing later event.

### Focus catch-up, input pacing and repaint

- **Focus-edge catch-up, the wider sibling of park/reveal.** The host sends a renderer only the
  sessions in its focused set, but the only catch-up repaint used to be `onTerminalReveal`, which fires on the PARKED
  edge. Parking implies unfocus, not the reverse, so every session that left the union WITHOUT
  being parked had no path back to a correct grid: a detail window a detached monitor owns
  (`remotelyOwnedSessionIds`), a hidden bottom panel, a closed command bar over a transient.
  `src/renderer/utils/focused-terminals.ts` adds the missing edge (`syncFocusedTerminals` /
  `onTerminalRefocus`, edge-triggered exactly like the parked registry), and `useTerminal`
  subscribes it to the same `reloadScrollback({ skipResize: true, skipFocus: true })` the reveal
  path uses, skipping when a replay is already in flight so a mount-time replay is never aborted
  and re-issued for the same frame. Both registries are kept: only parking additionally makes the
  incoming queue ack-and-discard, so neither subsumes the other.
- **Mouse reports are paced, never batched.** Outgoing terminal input rides a microtask write
  batcher (`src/renderer/utils/write-batcher.ts`) that coalesces synchronous onData bursts into
  one port write - byte-safe, but not semantics-safe for a fullscreen TUI, which treats a chunk
  as one input batch: a run of wheel reports delivered together becomes one multi-line jump, and
  the TUI's differential frame for a multi-line jump intermittently mis-assembles, splicing
  rows so entries go missing from the frame. Verified by controlled injection (2026-08-23): ten spaced
  reports produced ten clean frames and ~29KB of output; the same ten in one chunk produced one
  ~2KB spliced frame. Unbatching alone is NOT enough - a pipe preserves no message boundaries,
  so reports written back-to-back still land in one read while the TUI renders the previous
  frame. So `useTerminal` routes every mouse report (`isMouseReport`) through `writePaced`: an
  ordered queue that writes each report as its own payload at a 16ms-per-report floor, restoring
  the physical-wheel cadence a native terminal delivers; typed bytes keep arrival order across
  the two paths, and teardown drops pending reports rather than writing them joined. The paced
  queue is bounded as well as paced: wheel reports carry a direction lane (`mouseReportLane`),
  pending same-lane depth is capped at 8 so a high-resolution flick's post-stop tail is bounded
  near 128ms instead of scaling with wheel resolution, and a same-axis, same-modifier reversal
  drops the pending opposite-direction reports as stale intent (the same philosophy as
  teardown). Motion reports (drift and drags) carry a single self-superseding lane that keeps
  only the newest pointer position: motion generates at display refresh rate, above the 16ms
  floor's 62.5/s drain, so a laneless motion stream grew the queue whenever refresh outpaced
  the floor (measured 2026-08-28 on a 143Hz display: a two-second cursor traverse left 117
  motion reports pending), and since the queue is FIFO, every wheel report and click landing
  after a traverse waited out that stale backlog - the flick-after-move lag the wheel cap
  alone could not fix. Clicks and releases are laneless, never capped or superseded (teardown
  still drops them like any pending report). The 16ms floor itself stays
  deliberately: the cap changes how many writes queue, not the per-write cadence the TUI's read
  loop needs to catch each report individually.
  (Ack-clocking each report to the TUI's answer was tried and reverted: the TUI coalesces
  repaints onto its own frame clock, so input-clocking capped scrolling at ~10Hz.) The jump a
  coalesced read still produces is bounded by keeping `CLAUDE_CODE_SCROLL_SPEED` at the CLI
  default of 1 - see [Shells and paths](../../platforms/shells-and-paths.md) for why Kangentic no longer
  raises it. This targets the wheel-scroll flavor at the source; single-report multi-line jumps
  the CLI performs internally (Ctrl+End, PageUp/Down) remain exposed and are what the repaint
  nudge below repairs.
- **Where a wheel tick's time goes.** Measured on 2026-10-24 on Windows 11 with
  `kangentic_devtools_scroll_latency` (`src/devtools/main/scroll-latency-route.ts`): trusted wheel
  notches 300 ms apart into a detail-window terminal, running Claude Code 2.1.310 on Haiku in
  fullscreen over a 500-line answer, with four mock agents repainting at 20 Hz beside it. Claude
  started its answer to a report 2.5 to 3 ms after it at the median, 15 ms at p95. With the 16 ms
  flush timer the median wheel-to-paint was 28.5 ms, and 26 ms of that was Kangentic's: the host's
  flush wait 19 ms, the wait for the next display frame 5 ms, IPC and main under 1 ms, and the paced
  queue nothing, since notches came slower than its 16 ms floor. With the prompt flush above it is
  7.5 ms at the median and 22 ms at p95, about 5 ms of it Kangentic's, mostly the display frame. The
  four streaming agents moved none of these numbers; the host was busy 2% of the window. Claude does
  not bracket a scroll frame in DEC 2026 under Kangentic. It sends an empty `?2026h`/`?2026l` pair,
  then the whole ~4.7 KB frame in one piece, then a 3-character tail about 20 ms later, so a paint
  between the pieces never showed a torn frame. A high-resolution wheel or touchpad is the case the
  prompt flush does not help: at a tick every 7 ms (143 a second, against the paced queue's 62.5) a
  report waited 43 ms in the queue at the median and 87 ms at p95, wheel-to-paint was 49 ms and
  104 ms, and the lane cap dropped 4 of 60 reports. That cost is the mouse pacing above, kept for
  `claude-code#83714`. Not measured yet: a transcript as long as a day-old task's.
- **Post-interaction repaint nudge.** A fullscreen TUI intermittently emits a frame that erases
  the grid and then redraws only some of it, leaving either the whole transcript blank or a
  contiguous band of rows missing mid-frame. Its renderer is differential, so it never revisits
  those rows and only a full repaint heals them, which is why a click or a resize fixes it and
  waiting does not. `src/renderer/utils/repaint-nudge.ts` asks for that repaint automatically:
  after real user input reaches a focused alt-screen terminal and the output it provoked goes
  quiet (250ms), it writes a FocusOut+FocusIn pair, which is the same report a real terminal sends
  on alt-tab and the same one the user's click was already sending. It fires on the TRIGGER rather
  than on a detected symptom, so there is no threshold to false-positive on a legitimately sparse
  frame and it covers every shape of the defect. Gated on alt-screen plus DECSET 1004 plus
  not-parked plus no-replay-pending, floored at one per 750ms per session. `isUserInputData`
  filters out xterm's OWN focus and motion reports, which arrive through the same `onData` channel
  and would otherwise self-arm a nudge on every mount replay. The before/after grid comparison is
  reporting only and never gates the nudge. A richer repair layer (resize and replay arming
  channels, a spaced focus pair, mid-burst fires, floor deferral, a persisted verdict log) was
  built, dogfooded, and removed the same day: against a producer-side defect it bought visible
  repair flicker, not correctness. Upstream: anthropics/claude-code#83714 - reproduced NATIVELY
  (PowerShell, wheel-scrolling deep into a large resumed session), so this whole family is the
  CLI renderer's, not the host's. Every host-side workaround site carries an
  `UNWIND(claude-code#83714)` marker; grep for it and sweep them out when upstream fixes the
  renderer.

- **Trace vocabulary for the two mechanisms above.** `focus-union-gained` / `focus-union-lost`
  (main, `recomputeFocusedUnion`), `terminal-unfocus` / `terminal-refocus` (renderer,
  `focused-terminals.ts`), and `repaint-repaired` / `repaint-verified` (renderer,
  `repaint-nudge.ts`, the latter meaning the frame was already correct and the nudge cost one
  render). `arrival-focus` (renderer, `terminal-arrival-focus.ts`) joins them, carrying the
  allow/deny plus the tier that decided it (`hidden` / `claim` / `claim-mismatch` / `agent-window` /
  `window` / `window-mismatch` / `occupied` / `burst-taken` / `unclaimed`), the `site` that asked
  (one arrival decides more than once, and they were otherwise indistinguishable), and the
  arbiter's own INPUTS: whether the terminal was visible to the user, the claimed session, both
  fingerprints, the claim's age, and the focused window's session and `openedByAgent` stamp. The reason alone was not enough to diagnose with - it
  could not separate "no claim was live" from "a claim was live and its fingerprint had moved". `claimArrivalFocus` emits
  `arrival-claim` / `arrival-claim-clear` beside it, so a claim that was never made reads as a
  positive fact rather than as a missing entry. Together they are the only record of WHY a terminal
  did or did not take focus, which a "typed into the wrong terminal" report otherwise leaves to
  guesswork - and an ABSENT `arrival-focus` entry is itself a diagnosis, meaning nothing ever asked
  (see the [arrival-obligation bullet](terminal-ownership.md#terminal-ownership-handoff)). All nine merge into
  `kangentic_devtools_terminal_state`'s timeline alongside the resize and replay events above. `kangentic_devtools_terminal_forensics` is the session-scoped
  companion: renderer viewport rows, main's re-parsed grid, and the raw byte ring side by side,
  which is what separates "the agent never sent these rows" from "we lost them".
### Traces and the launch overlay

- **The main trace survives a restart (dev builds).** Both rings live in memory, and the usual
  response to a stuck terminal is to restart, which erased the only record of one: two task
  windows whose agents painted full-width rows for the bottom panel's 306x19 grid inside a 210x48
  window, while main's last applied grid (`sessions.last_pty_cols/rows`) was the window's. The
  devtools install (`src/devtools/install.ts`) now appends every main-ring entry to
  `<configDir>/logs/terminal-trace.jsonl` (`terminal-trace-persist.ts`, one JSON line each, 8 MB
  cap plus one rotated `.1` copy, never truncated on a resume). Each line carries `process`
  (`main` or `pty-host`), so a resize main applied reads apart from the one the host applied.
  After the host falls back into main, its entries are recorded there and read `main`. One
  second after a session's last `pty-resize`, `composed-width-sampler.ts` measures the width the
  agent itself is composing at from the raw ring and, for an alt-screen session only (a
  normal-buffer session records none), records a `composed-sample` entry with
  `composedCols`, the main grid (`ptyCols`/`ptyRows`), the host buffer's grid (`hostCols`/
  `hostRows`) and `matchesPty`. That sample is the only persisted reading of the third layer, and
  `matchesPty: false` beside matching main and host grids names an agent that did not follow the
  resize. Trust the verdict over the number: rows glued by autowrap make the evidence ambiguous
  between a width and its multiples, the PTY grid breaks that tie (as in the terminal-state route,
  so a healthy session never reads double), and a disagreeing width can come out as a multiple or
  sub-multiple of the true one (an agent composing 306 in a 210 grid reads 153). The renderer ring
  is not persisted.
- **The launch overlay waits for the agent.** `TerminalTab` and the Command Terminal pane lift
  their launch overlay on `sessionFirstOutput`, which main sets only once the session's agent is
  on screen (`SessionManager.markAgentReady`: its first text after the shell ran the spawn command,
  its first alt-screen entry, its SessionStart hook, or a 15 s ceiling), or on an exit. Not on the
  adapter's first-output latch, which a shell's startup frame trips, and not on usage, which the
  spawn seeds with the model name. Both hosts mount the terminal at once under the overlay and
  drop PTY output until the lift, then replay the scrollback. See
  [The launch overlay](../../integrations/agents/adapter-interface.md#the-launch-overlay).
- **Replay veil for a warm mount.** For an already-running session, `sessionFirstOutput` is already
  set, so `TerminalTab`'s launch overlay never shows (`terminalReady` is derived from it), so the whole mount-time fit -> replay -> refit ->
  held-byte-flush sequence used to paint live, occasionally as a visible flash. `TerminalTab` now
  covers the terminal with a veil (fixed terminal-background color, no spinner or transition) from
  mount until `useTerminal` fires its first `onScrollbackSettled` notification, so only the settled
  frame is ever shown. Every settle path (afterWrite, IPC-rejection catch, watchdog) funnels
  through one `settleScrollback` chokepoint, so the veil always lifts.
