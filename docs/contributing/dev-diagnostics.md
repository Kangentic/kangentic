---
type: Reference
title: Dev diagnostics
description: "What the Developer diagnostics of a dev build cost the main process and the budget that holds them to it, how the stall profiler rolls two overlapping CPU profiles so it never restarts, and the per-launch lag journal that keeps stalls, spikes, slow spans and the startup timeline readable after a restart."
tags: [contributing, diagnostics, performance, devtools]
sources:
  - resource: src/devtools/main/stall-profiler.ts
    title: The rolling stall profiler
  - resource: src/devtools/main/diagnostics-budget.ts
    title: The cost budget
  - resource: src/devtools/main/lag-journal.ts
    title: The journal's files and records
  - resource: src/devtools/main/lag-journal-reader.ts
  - resource: src/devtools/main/lag-journal-host.ts
  - resource: src/main/diagnostics/event-loop-lag.ts
    title: The lag monitor and its record sink
  - resource: src/main/diagnostics/log-mirror.ts
    title: Console log persistence, main's and each window's
  - resource: src/main/diagnostics/ipc-recorder.ts
    title: IPC traffic recording and its payload cap
  - resource: scripts/measure-diagnostics-cost.mjs
---
# Dev diagnostics

A dev build of Kangentic (`npm start`, `/preview`) runs a set of diagnostics a packaged build does not. The team works in the dev build all day, so each of them has to be cheap enough to leave on, and what they record has to still be there when a question comes up later. This page covers the budget that keeps them cheap and the journal that keeps their records.

## The diagnostics

| Diagnostic | Switch | What it costs main |
|---|---|---|
| Lag monitor (`src/main/diagnostics/event-loop-lag.ts`) | Always on in a dev build | A 100 ms timer and a 1 ms delay histogram |
| Stall profiler (`src/devtools/main/stall-profiler.ts`) | `developer.stallProfiler`, on by default | A roll every 15 s, a save per stall |
| Spawn tracer (`src/devtools/main/spawn-tracer.ts`) | Always on in a dev build | One stack capture per process start it labels |
| IPC traffic recording (`src/main/diagnostics/ipc-recorder.ts`) | `developer.recordIpcTraffic` | One serialized line per IPC call |
| Console log persistence (`src/main/diagnostics/log-mirror.ts`) | `developer.persistConsoleLogs` for info and debug lines. Errors and warnings are always kept | One serialized line per console line kept, main's and each app window's |
| Lag journal (`src/devtools/main/lag-journal.ts`) | Always on in a dev build | One serialized line per record |

Each one times its own main-thread work under a `diag:<name>` label with `timeSyncWork` or `recordSyncSpan`. The lag monitor already counts every span per label for the whole run, so the cost of each diagnostic is a number the app holds about itself, on the real workload.

## The budget

`evaluateDiagnosticsBudget` (`src/devtools/main/diagnostics-budget.ts`) turns those counts into a verdict, and the lag report carries it as `diagnostics`. Every read of `kangentic_devtools_event_loop_lag` is therefore a budget check.

- **No diagnostic work holds main for 16 ms or more.** That is one frame at 60 Hz and the lag monitor's own slow-span line. The one exemption is the stall profiler's cold start, described below.
- **All diagnostics together stay under 0.1% of main's time.** The share is judged once the run is 10 minutes old. A launch labels about 200 process starts in its first seconds, which is 0.05% of a 25 second run and nothing of an hour.
- **A delay of 75 ms or more in a window marked `stall-profiler` has a stall behind it.** The profiler notes the delay window that follows each save. A long delay there is fine when the save reacted to a real stall, and a defect when it fired on less.

`node scripts/measure-diagnostics-cost.mjs` prints the verdict for a running dev instance. It exits 0 when the budget holds, 1 on a violation, and 2 when no instance answers or an option is wrong. `--instance=<path>` reads another checkout's instance, `--port=<n>` skips the lockfile, and `--json` prints the verdict as JSON. `--watch=<minutes>` adds main's CPU share over a stretch of time, for comparing the profiler on and off. Its sampler is a thread of its own and holds no JavaScript, so no span sees it.

### Measured

A `/preview` on Windows with every diagnostic on, 2026-11-24:

| Diagnostic | Mean per event | Worst |
|---|---|---|
| Stall profiler roll | 0.9 ms | 2 ms |
| Stall profiler save, then summary | 0.2 to 1.4 ms, then 0.4 to 0.9 ms | 2 ms |
| Spawn tracer stack capture | 56 to 76 microseconds | under 1 ms |
| IPC traffic recording | 13 to 45 microseconds | 1 ms |
| Console log persistence | 32 to 45 microseconds | under 1 ms |
| Lag journal line | 21 to 30 microseconds | under 1 ms |

Over an eight minute run under a steady load (two IPC calls and a console line every 500 ms, one of the calls returning a 2.2 MB task list), all of them together used 0.028% of main's time, main had no spike, and its CPU share averaged 0.13% with the profiler on. The profiler's cold start cost 57 to 64 ms at launch.

Console log persistence kept nothing the renderer app printed until this work. The preload patched `console.*` and forwarded each call over IPC, but under context isolation that patch sat in the preload's own world, where the app's calls never passed: 960 `console.debug` calls in the soak left no line. Main now reads each app window's `console-message` event, which carries every world's output and costs the renderer no IPC call per line. The main window and every pop-out register for it; a Browser pane's page, its popups and an offscreen lane do not, because their console is the user's own app's.

IPC traffic recording is the one that had to change to get there. It serialized every result whole to learn whether it was over its 32 KB cap, so recording that 2.2 MB task list cost main up to 5 ms a call. It now counts a payload as far as the cap and stops, which costs about 0.02 ms and took the call's round trip from about 25 ms to 11.

## The stall profiler

Labelled spans name the work someone thought to wrap. A stall in anything else is a duration with no cause. The stall profiler closes that gap: V8's sampling profiler runs over main's whole thread, and when main stalls for 75 ms or more the profile is saved as a `.cpuprofile` under `<userData>/stall-profiles/` and its heaviest functions and stack go into the lag report as `stallProfiler.profiles`.

### Why two profiles overlap

V8 walks the whole heap to log every compiled function when a profiler starts with no profile running. The profiler that shipped first stopped its only profile on every save and every five minutes, so it paid that walk each time. On 2026-11-24, on a 70 MB heap, each save was followed by a main stall of 88 to 258 ms, and the restart's own stall then read as the next one: nine saves in a row over 27 seconds.

V8 only pays the walk when the profiler goes from no profile to one. So two profiles run at all times, staggered by 15 seconds, and a new one always starts before the older one stops. Measured on this checkout's Electron with a 116 MB heap:

| | Start | Stop |
|---|---|---|
| Cold, no other profile running | 185 to 276 ms | 10 to 14 ms |
| Overlapped | 0.02 to 0.08 ms | 0.03 to 0.23 ms |

`v8.startCpuProfile()` is the API that lets two profiles share one profiler. Its `stop()` returns the `.cpuprofile` text, which is written to disk as it is. Only the summary parses it, on a later turn. A saved profile covers up to about 30 seconds. The first one after the profiler starts, or one saved soon after another, covers less.

The cold start is paid once, when the profiler is switched on. At launch that is the first turn of the event loop, while the heap is small. It is on record as the `diag:stall-profiler:start` span and stays out of the lag monitor's delay windows. The profiler closes the open window right before it, and a histogram that was just reset records nothing until its timer fires again.

That same property is why the profiler resets its own delay reading only after a delay it has reported. A reading reset on every check missed any stall that began within one timer tick of the check, which is 15.6 ms of every second on Windows.

### Why 75 ms

It is the lag monitor's spike line, so every recorded spike can have a profile. The recorded data backs it. Under about 65 ms the delay reading and the profile's busy run disagreed: a 25.6 ms delay over a 17 ms busy run, a 45.2 ms delay over 3 ms. That is the Windows timer, which ticks every 15.6 ms. From 65 ms up they matched: 66.7 and 68.3, 81.3 and 82.3, 130.7 and 132.1. The first profiler fired at 25 ms, and 13 of its 28 saves were on delays under 35 ms.

Stalls less than five seconds apart share one saved profile.

## The lag journal

The lag monitor's rings, the profiler's summaries and the startup timeline lived in memory, so a restart erased the record of the run it ended. When a boot freeze was analysed on 2026-11-23, 18 of the last 19 boots had nothing left to read.

Every record is now also written to disk as it happens, one JSON line each, through the shared async file queue. A launch owns two files under `<configDir>/logs/lag/`, named by its start time and process id:

- **`<launch>.launch.jsonl`** holds the header, the startup timeline and every record of the first five minutes. It is never rotated, so a run that lasts a week still has its launch.
- **`<launch>.jsonl`** holds everything after, rotated at 8 MB with one older slice kept as `.1`.

The newest 30 launches are kept.

| Record | From |
|---|---|
| `launch` | The header: versions, platform, and which Developer diagnostics were on |
| `startup` | The startup timeline's marks, in ms since process start |
| `spike` | A stall of 75 ms or more: main's, the pty host's, the renderer's |
| `span` | A labelled span of 16 ms or more: main's, and those the pty host and the retrieval worker relay |
| `window` | A 10 s delay window, when it held a block of 25 ms or more or carries a note. Every window, during the launch's first five minutes |
| `stall` | A stall profiler summary |
| `long-frame` | A renderer long animation frame with its scripts |
| `exit` | A clean quit |

Each record carries the process it is about. Main's and the pty host's are written as they happen. The renderer has no channel to main for this, so main takes its new records over the debugger the inspection bridge already attached, every 30 seconds. With the bridge off, or DevTools open, the renderer's records stay in its own rings.

### Reading a launch back

`kangentic_devtools_event_loop_lag` lists the launches on disk as `launches`. Pass `launch` (`previous`, `current`, or an id from that list) to read one back in place of the live report, with `since` and `until` to narrow the time range and `limit` to cap each list. The reader streams the files a line at a time, so reading megabytes of journal is not itself a stall.

`node scripts/measure-diagnostics-cost.mjs --launch=previous` prints a launch's startup timeline, stalls and worst spikes. The files are plain JSON lines, so they can also be read with no app running.

A `/preview` keeps its journal across an in-app restart and loses it when the preview closes, like the rest of its data.
