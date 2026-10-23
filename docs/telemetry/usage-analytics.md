---
type: Reference
title: Usage analytics
description: The Aptabase events Kangentic sends and their properties (app_launch, settings_snapshot, app_error sources, utility_worker_crashed, gpu_process_gone), how clientId and last-run uptime are derived, what is never collected, the KANGENTIC_TELEMETRY switches, and the local sink for checking events.
tags: [analytics, aptabase, privacy, events]
sources:
  - resource: src/main/analytics/analytics.ts
  - resource: src/main/analytics/usage.ts
    title: ANALYTICS_FEATURES and ONBOARDING_MILESTONES
  - resource: src/main/analytics/run-uptime.ts
  - resource: src/main/analytics/client-id.ts
  - resource: src/main/analytics/settings-snapshot.ts
    title: SETTINGS_SNAPSHOT_ALLOWLIST
  - resource: scripts/aptabase-sink.mjs
  - resource: src/main/diagnostics/gpu-health.ts
  - resource: src/main/diagnostics/async-file-queue.ts
---
# Usage analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product.
[Aptabase](https://aptabase.com) counts the product events below. Crash and error reports are a
separate vendor and job, in [Error reporting](error-reporting.md), and both share the same kill
switch (`KANGENTIC_TELEMETRY`, below).

## What We Collect (Aptabase)

Nineteen event types are tracked, all on critical-path actions only:

| Event | When | Properties |
|-------|------|------------|
| `app_launch` | App starts (when analytics is enabled) | platform, arch, clientId; from the second launch on, the previous run's lastRunUptimeSeconds, lastRunUptime (`<1m` / `1-5m` / `5-30m` / `30m-2h` / `2-8h` / `8h+`), lastRunExit (`clean` / `failsafe` / `abrupt`) |
| `settings_snapshot` | Once per app run, right after `app_launch` | one key per global setting that differs from its default (see below), plus deviations (`0` / `1` / `2` / `3-5` / `6+`) |
| `app_heartbeat` | Every 55 minutes while at least one agent session is active; skipped when idle. Also fires once right before system sleep if a session is active | activeSessions, suspendedSessions, queuedSessions, totalSessions |
| `app_error` | Uncaught exception, unhandled rejection, renderer crash, React ErrorBoundary, updater failure, or PTY spawn failure | source, message (sanitized); see per-source extras below |
| `project_create` | User creates a project, through the New Project dialog or by adding a folder | (none) |
| `project_relocate` | User re-points a project at another folder, either through the Locate Folder dialog (`repoint`) or the one-step Move in Project Settings > General (`move`) | mode (`repoint` / `move`) |
| `task_complete` | Task moves to Done | agent, model, permissionMode, durationSeconds, costUsd, inputTokens, outputTokens, toolCalls |
| `session_spawn` | Agent session reaches running state (board or transient; a Command Terminal session is `isTransient: true`) | agent, isTransient, permissionMode, worktree |
| `session_exit` | Agent session finishes | exitCode, durationSeconds, agent, model, costUsd, toolCalls, intentional |
| `onboarding_milestone` | Once per install per funnel step | step (`first_project`, `first_task`, `first_spawn`, `first_task_complete`), clientId |
| `feature_first_use` | Once per install per curated feature | feature, clientId |
| `feature_used` | Once per curated feature per UTC day | feature |
| `board_snapshot` | Once per project per app run, the first time the user views it (the boot auto-open or a sidebar switch); background activation of other projects does not count, and neither does the open that creates a project, whose board is still the default | columns, customColumns, taskBucket (`0` / `1-9` / `10-49` / `50-199` / `200+`), profiles |
| `update_outcome` | Next launch after the app version changed | result (`applied` / `rolled_back`), fromVersion, toVersion |
| `spawn_failed` | An agent spawn failed (born-into-column create, MCP auto-spawn, any board-driven resume including a drag move, startup recovery) | agent, reason (`create_spawn`, `auto_spawn`, `resume`, `unknown_agent`, `cli_not_found`) |
| `utility_worker_crashed` | A Kangentic utility process failed unexpectedly (it exited, failed to fork, never said ready, or stopped answering; not an idle recycle or quit): at most twice per service per app run, on the first crash and when the restart cap latches | service (`kangentic-embeddings`, `kangentic-line-count`, `kangentic-dictation`, `kangentic-retrieval`, `kangentic-pty-host`), exitCode (see below), cause (`exit` / `fork_failed` / `ready_timeout` / `request_timeout`), phase (`first` / `latched`) |
| `gpu_process_gone` | The GPU process failed (a fault death: not a kill, an OOM, or a Windows session-teardown exit): at most twice per app run, on the first fault and when the escalation threshold latches | reason (Electron's `child-process-gone` reason), exitCode, phase (`first` / `latched`) |
| `leftover_processes` | Once per leftover-process report, the one a toast shows: a terminal transition (Done, To Do, delete) or a burst of them found something a task's agent left running in its folder, or the startup sweep stopped or failed to stop something. Never sent when a task left nothing | stopped, kept, failed (counts of processes stopped, left running on purpose or with stopping off, and still running after the force kill), stoppingEnabled |
| `mobile_bridge_forced_redial` | The mobile bridge abandoned a relay socket that still read connected but carried nothing (a socket the relay reaped while the network was away; see `docs/integrations/mobile-bridge/relay-transport.md`): at most once per reason per app run | reason (`paired-silent` / `parked-stale`) |

There is no close event. Every quit path exits before a network send can complete, so
`app_close` fired on every quit and landed on none of them; the run's duration is instead
checkpointed to `<configDir>/analytics-run.json` once a minute and reported by the NEXT launch as
`lastRunUptimeSeconds` (Aptabase averages numeric properties, which is what replaces the
dashboard's own Avg. Duration) and the `lastRunUptime` bucket. `lastRunExit` says how that run
ended: `clean` (the quit path ran: window close, Cmd+Q, Ctrl+C, SIGTERM, a closed hosting terminal
(SIGHUP), an OS shutdown or log-off that reached the app, an update install, a restart to change
Graphics acceleration), `failsafe` (the quit path ran but Electron's teardown
hung and the hard failsafe force-killed the process), or `abrupt` (nothing was recorded: a crash, a
kill, a power loss). Uptime is wall-clock and includes time asleep. Aptabase's own session
duration is coarse by comparison, since heartbeats are the only events a long agent run emits.

A dev build also writes the previous run's ending to the local log, once per launch, after the boot
opens its project: `[startup] previous run: exit=abrupt uptime=4h12m lastAliveAt=<iso>` (or
`none`; `lastAliveAt=unknown` for a record written before `at` existed). It lands in that
project's `.kangentic/logs/<date>.log`, beside the previous run's `[SHUTDOWN]` lines, or in
`<configDir>/logs/` when no project opened. Like the `[SHUTDOWN]` lines it is a `log`-level line,
so it is persisted while `developer.persistConsoleLogs` is on, which is the dev default. A
production build has neither the line nor the exit drain below.

In a dev build the signal routes (Ctrl+C, a closed hosting terminal, and SIGTERM on macOS and
Linux) write the log lines still queued before `process.exit`, through `drainQueuedAppendsSync` in
`src/main/diagnostics/async-file-queue.ts`, and so do a `process.on('exit')` listener and the hard
failsafe's callback. Without it every line the shutdown logged was lost, and a closed terminal left
the same log as a crash. The drain also writes the batch a flush had already taken off the queue.
If that flush's write was already running, the batch can appear twice in the log.

Each write also stamps `at`, the wall-clock moment of that write, so the last record on disk says
when the run was last known alive. For a `clean` or `failsafe` exit that is the exit itself; for an
`abrupt` one it is the final checkpoint, which is the only clock an abrupt ending leaves behind.
It is read locally rather than reported: `previousRunLastAliveAt()` feeds the GPU report gate,
which needs to tell "the GPU crash-looped as this run ended" from "the GPU crash-looped forty
minutes before something unrelated killed it".

`utility_worker_crashed`'s `exitCode` is the raw value Electron's `utilityProcess` `exit` event
reports, so it is NOT comparable across platforms (POSIX derives it from `waitpid`, Windows from
`GetExitCodeProcess`). Group by `service` and platform before reading it. The value `-1` is a
sentinel meaning "there is no exit code", which a real exit code cannot collide with. The matching
Sentry tag spells that same case `unknown` rather than `-1`. `cause` says why there is none: an
`exit` normally carries a real code and sends `-1` only if Electron reported none, while
`fork_failed` (the fork threw, so no process started), `ready_timeout` (the worker never said
ready) and `request_timeout` (the client killed a worker that stopped answering) always send `-1`.
Before `cause` was sent, a retrieval worker that hung read as a fork failure. `phase` says which of the two per-run events it is: `first` counts the
installs that hit a crash at all, `latched` counts the installs whose subsystem gave up (the same
moment the Sentry issue is filed). The event used to tick on every crash, which with three crashes
per five-minute decay window read as "71 crashes a day" when it was a handful of installs looping,
and could not tell those apart. The per-run cap is held per service across policy instances, since
the embed client rebuilds its policy on every model change and project switch.

`gpu_process_gone` follows the same shape for the GPU process (`src/main/diagnostics/gpu-health.ts`),
mirroring Chromium's own judgment of GPU health: three deaths inside five minutes is also the point
at which Chromium falls back to software compositing on its own
(`GpuProcessHost::RecordProcessCrash`). `first` fires on the first death, `latched` on the third,
counting FAULT deaths only (`isGpuFaultDeath`, see [Counted, not reported](error-reporting.md#counted-not-reported)): a kill or a Windows
session-teardown exit is written to the record but never ticks, or every shutdown with the app open
would read as a GPU death on the dashboard. Neither fires again for the rest of the RUN, even across a later decay reset and a fresh escalation -
the phase gate is per-run, not per-window, which is what keeps this at exactly two Aptabase events no
matter how many separate incidents one launch has. `exitCode`'s `-1` sentinel does NOT carry the same
meaning it does for `utility_worker_crashed` above: there `cause` says why no code exists, but here it
means Electron's `child-process-gone` event reported no exit code, a routine and more common case.
The latch governs this Aptabase tick ONLY. The durable escalation record is written on every death
from the first (see [Counted, not reported](error-reporting.md#counted-not-reported)), because the death that actually kills the app is one
JS never hears about: Chromium calls `RecordProcessCrash`, and the `LOG(FATAL)` under it, from the
delegate rather than from the observer notification Electron emits `child-process-gone` from. Live
reporting is impossible here for the same reason - the browser process is gone before an async
Sentry POST queued at that moment could transmit. A GPU fallback that the tracker records from
`gpu-info-update` ticks no Aptabase event, because it is not a death. Through Electron 41 a
launch-failure ladder produced no `child-process-gone` at all and left this count at zero. On
Electron 44 the launch failures Chromium survives arrive as `child-process-gone` with reason
`launch-failed`, count as fault deaths, and tick `first` and then `latched`. The launch failure
that ends in the fatal still never reaches JS.

The curated `feature` vocabulary is `ANALYTICS_FEATURES` in `src/main/analytics/usage.ts`:
`command_terminal`, `worktree_session`, `board_profile`, `popout_window`, `browser_pane`,
`mcp_server`, `mobile_bridge`, `usage_dashboard`, `quick_find`, `settings`, `agent_monitor`,
`semantic_memory`, `dictation`, `backlog`, `changes_panel`, `conversation_viewer`,
`board_integration`, `pull_request`. Each feature adds at most one `feature_used` event per user
per day, so the list is a budget decision, not a free enum. Renderer-reported features cross one
IPC channel (`analytics:trackFeatureUsed`) and are re-validated against this list in the main
process. Onboarding milestones and feature first-use flags persist in
`<configDir>/analytics-usage.json`, alongside the last-run version that powers `update_outcome`;
the run-duration checkpoint lives beside it in `analytics-run.json`, in its own file because it is
rewritten once a minute and a torn write must never blank the lifetime flags. `semantic_memory`
counts only a search whose query actually embedded (a lexical fallback is not a use),
`board_integration` counts an import fetch or execute through any provider, and `pull_request`
counts a PR actually linked to a task, never the automatic sweeps that find nothing.

`agent` is the adapter id from a fixed allowlist (`claude`, `codex`, `gemini`, `qwen`, `opencode`, `aider`, `cursor`, `warp`, `copilot`, `kimi`, `droid`, `ollama`, `grok`, `antigravity`, `goose`). `model` is the CLI-level model identifier the agent itself reports through its status output (e.g. `claude-opus-4-7`, `gpt-5-codex`, `gemini-2.5-pro`).

`model` is only present on events fired *after* the agent has emitted at least one status update, which means it is omitted on `session_spawn` (model is unknown at spawn time) and may also be omitted on `session_exit` / `task_complete` for very short sessions that exited before the agent reported a model.

For Claude sessions, `model` is normalized to its base id via `parseModelId` (`src/shared/model-id.ts`) before being attached, so the 1M-context opt-in suffix and a dated pin no longer fragment the model breakdown: `claude-opus-4-8[1m]` -> `claude-opus-4-8`, `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`. This is a display-layer grouping only - the exact spawnable id is unaffected.

`permissionMode` on `session_spawn` / `task_complete` is the RESOLVED mode the session record
actually spawned under (from `resolveEffectivePermissionMode`), not the task's raw override
(which is null for most tasks, meaning "inherit"). `session_spawn` fires inside the spawn,
before the session's record is inserted, so it reads the mode the spawn carried onto the session
(`SpawnSessionInput.permissionMode`, `SessionManager.getSessionPermissionMode`); a Command
Terminal carries none. `worktree` says whether the session ran in a
git worktree. `intentional` on `session_exit` distinguishes a deliberate kill/suspend (tagged by
the session manager) from a genuine agent-side exit, closing the crash-versus-intentional blind
spot.

`costUsd`, `inputTokens`, `outputTokens`, and `toolCalls` are cumulative session metrics, omitted when not yet available (e.g. a session that exited before any usage was recorded). `session_exit` carries `costUsd`/`toolCalls` only, since its token counts would otherwise be a point-in-time context-window snapshot rather than a cumulative total; `task_complete` is the source for cumulative token counts.

The `app_launch` event also carries `clientId`, an anonymous id Kangentic generates and attaches (see "Unique Installs" below). It rides `app_launch` (the one authoritative per-launch install signal) and the two lifetime-once events, `feature_first_use` and `onboarding_milestone`, where it turns "N first uses" into "N installs reached this step" at negligible cost since each fires at most once per install for all time. It is not attached to every event, to avoid inflating high-cardinality string-prop volume on events like `app_heartbeat` or the daily `feature_used` where it adds no install-counting value.

`board_snapshot` sends counts only: the number of columns, whether the board deviates from the
seeded default (compared against `DEFAULT_SWIMLANES` in `src/main/db/migrations/default-data.ts`
by count and name-set), a bucketed task count (never the exact figure), and the number of Board
Profiles. Column names and task content never leave the machine.

`settings_snapshot` answers "what are people actually running with", the question that changes a
default; a stream of setting-changed events would only say what was touched. It carries only the
settings that differ from their default, from a fixed allowlist of sixteen global settings
(`SETTINGS_SNAPSHOT_ALLOWLIST` in `src/main/analytics/settings-snapshot.ts`): `knowledgeGraph.indexingEnabled`,
`knowledgeGraph.enabled`, `knowledgeGraph.localModel`, `knowledgeGraph.acceleration`,
`agent.maxConcurrentSessions` (bucketed `1-3` / `4-7` / `9-12` / `13-16` / `17+`),
`agent.autoResumeSessionsOnRestart`, `agent.idleTimeoutEnabled`, `agent.idleTimeoutMinutes`
(bucketed `0` / `1-15` / `16-29` / `31-60` / `61+`), `agent.pauseIdleAgentsOnLowMemory`, `browserAutomation.enabled`, `browserAutomation.allowEval`,
`browserAutomation.restrictNavigationToLocalhost` (sent as `browserAutomation.localhostOnly`,
since Aptabase rejects the whole event for a key over 40 characters), `mobileBridge.relayMode`,
`dictation.language`, `windowLightDismiss`, and `animationsEnabled`. Property keys are the
settings-registry ids. Every listed setting is global-scoped, so there is always a value to read
with no project open; `agent.executionMode` is project-scoped and deliberately absent. The
allowlist is a security control before it is a budget one: the global config also holds server
URLs and auth, relay URLs, CLI paths, init scripts, and shortcuts, none of which can be read by
the snapshot, and a listed key can only leave through a closed shape (a boolean, an enum drawn
from a fixed set, a bucketed number, or a short pattern-checked string). A stored value outside
that shape is sent as the literal `other`, never verbatim. Cosmetic settings and settings already
carried by other events (permission mode, worktrees, and the default agent and model on
`session_spawn`) stay out. An all-defaults run still sends the event with `deviations: 0`, which is
itself the signal that the defaults are right.

### app_error sources

`source` discriminates the failure path: `uncaughtException`, `unhandledRejection`,
`render-process-gone` (extras: `reason`, `exitCode`), `error_boundary` (extras: `boundary`,
`panel`), `updater`, `pty_spawn` (extras: `shell`, `shellArgs`, `cwdExists`,
`shellExists`, `errno`, `platform`, `arch`), `pty_spawn_cwd_missing` (extra: `platform`),
`secondInstanceNoWindow`, `duplicateCreateWindow`, `createWindowBeforeMcpSettled`,
`globalDbUnreadable`, and `startupFailure`.

The last four are all startup-path faults in `src/main/index.ts`.
`duplicateCreateWindow` fires when `createWindow` is called while a live main window already
exists, and `createWindowBeforeMcpSettled` when it runs before `startMcpHttpServer` settled;
both report an ordering bug rather than a user-visible failure.
`globalDbUnreadable` carries the sanitized open error when the global database cannot be read,
and `startupFailure` the sanitized error from any other throw in the startup body.

`secondInstanceNoWindow` is the window-lifecycle fault: a second launch hit the single-instance
lock and found the running process alive with no main window, which off macOS means a browser
lane survived the teardown sweep and held the window count above zero, so `window-all-closed`
never fired. The handler rebuilds the window either way; the event is what keeps the underlying
leak visible instead of being absorbed by the recovery. It is not sent on macOS, where an app
outliving its window is the ordinary lifecycle rather than a fault.

Renderer errors (`source: error_boundary`) carry two extra properties that say *where* the error
happened, since a message alone is rarely enough to locate one. `boundary` is `root`, `panel`, or
`unhandled_rejection` and identifies which of the three reporters caught it; `panel` is the
failing panel's static label. Both read directly, because a string literal and a prop survive
minification. The React component stack never crosses IPC: a production stack frame embeds a
`file://` URL containing the user's home directory, and a trail of component names reduced from it
arrived mangled anyway (React takes frame names from `fn.name` and the packaged renderer bundle is
minified), so that property was dropped. Sentry receives the real, symbolicated stack instead, with
paths normalized (see [Initialization and scrubbing](error-reporting.md#initialization-and-scrubbing)); `boundary` is the field to reach for first on the
Aptabase side.

Aptabase truncates any string property at 180 characters server-side, so `message` and `panel`
are capped at that length locally (`MAX_ANALYTICS_STRING_LENGTH`) rather than sending text that
would be silently cut.

`boundary` classifies only `source: error_boundary` events. The other `app_error` sources
(all raised in the main process)
never carry it, and they are separate from the local crash-log system under
`.kangentic/logs/crashes/`, which records its own JSON files and never reaches Aptabase.

The analytics SDK automatically detects: OS name, OS version, locale, app version, anonymous session ID, and country (derived from IP, then discarded).

### Unique Installs

Aptabase's own identity model rotates daily (see "How It Works" below), so it cannot report unique users or installs. To make that possible ourselves, Kangentic generates its own anonymous `clientId` and attaches it to the `app_launch` event, the one authoritative per-launch install signal, so unique installs can be rolled up as `COUNT(DISTINCT clientId)` over that event.

- **Derivation:** `clientId` is an HMAC-SHA256 digest of the OS machine id (already SHA-256-hashed by the `node-machine-id` library) and a hash of the OS home directory, keyed with a fixed Kangentic salt. It is a one-way, non-reversible digest containing no raw machine identifiers, paths, or usernames.
- **Stability:** stable across app updates and a clean uninstall/reinstall, because it is derived from the OS install itself rather than data Kangentic's own uninstaller would remove. It is unique per OS user, so two accounts on a shared machine get distinct ids.
- **Fallback:** if the OS machine-id source is unavailable (e.g. a hardened or containerized environment), Kangentic falls back to a random id persisted locally; that id does not survive a reinstall.
- **Control:** `clientId` is on by default and shares the same `KANGENTIC_TELEMETRY` control as every other event below - there is no separate opt-out.

## What We Don't Collect

- Task titles, descriptions, or any user-generated content
- File paths, project names, or code (stack-frame paths are normalized to the app root, and in
  Sentry event text every registered project root is rewritten to `[project]` and the machine's
  home directory to `~`, before they leave the machine)
- Console output in Sentry breadcrumbs, except lines under a short list of diagnostic tags, which
  are rebuilt without error text and with paths redacted. Click breadcrumbs lose their title and
  label text, and request breadcrumbs lose any URL that is not Kangentic's own (see [Tags, sessions
  and breadcrumbs](error-reporting.md#tags-sessions-and-breadcrumbs))
- Usernames, emails, or any personally identifiable information
- Task creation, task start, or mid-board task moves (only done-entry is tracked)
- Per-feature content: `feature_used` says a feature was touched that day, never what it was
  used for

## Why

- Understand how many people use Kangentic and on which platforms
- Measure product effectiveness (task completion rates, agent success rates)
- Prioritize development based on actual usage patterns
- See where new installs stall (the onboarding funnel) and which features earn their keep
- Diagnose crashes with actionable, grouped, symbolicated reports instead of truncated strings

## How It Works

Kangentic uses [Aptabase](https://aptabase.com), a privacy-first, open-source analytics platform designed for desktop apps:

- No cookies
- Aptabase's own session IDs are random and rotate daily, not tied to any identity
- IP addresses are used for geographic lookup only, then discarded
- No personal data is collected or stored
- GDPR-compliant by design

Kangentic separately attaches its own anonymous, non-reversible `clientId` to the `app_launch` event so we can count unique installs ourselves - see "Unique Installs" above. It contains no personal data and is not an Aptabase feature.

All telemetry egress happens in the main process. Renderer errors reach it over IPC (the
`analytics:trackRendererError` funnel for Aptabase, the Sentry SDK's internal IPC transport for
error reports); the renderer never opens a network path of its own.

Nothing is sent from the quit path. The `before-quit` handler is synchronous by rule
(`.claude/rules/synchronous-shutdown.md`), the SDK issues one HTTP request per event with no flush
hook, and every shutdown route exits before that request can complete, so any event fired there
is lost. That is why run duration is reported by the next launch (above) rather than by a close
event.

### Local verification

Aptabase publishes an ingestion API only, so what production received can only be read off the
dashboard by a person. To see the event stream directly, point it at a local sink instead: the SDK
picks its host from the middle segment of the app key, and an `A-DEV-<digits>` key routes every
event to `http://localhost:3000`. `KANGENTIC_APTABASE_APP_KEY` overrides the key so no source edit
is needed.

```
node scripts/aptabase-sink.mjs
```

Then start Kangentic with `KANGENTIC_TELEMETRY=1`, `KANGENTIC_APTABASE_APP_KEY=A-DEV-0000000000`,
and `KANGENTIC_ERROR_REPORTING=0` in its environment (the last one because error reporting
inherits the telemetry switch, and a dev build should not start sending real errors to Sentry just
to watch analytics). For a worktree preview, pass them through the launcher, which splices them
into the terminal command it opens (a new terminal tab does not inherit the calling shell's
environment, so setting them on the launcher's own process is not enough):

```
node scripts/worktree-preview.js --env KANGENTIC_TELEMETRY=1 --env KANGENTIC_APTABASE_APP_KEY=A-DEV-0000000000 --env KANGENTIC_ERROR_REPORTING=0
```

Each event prints at the sink as it is posted, with its properties, at zero cost against the
production budget. This is the acceptance test for anything near the quit path
(quit each way and confirm the next launch's `app_launch` reports `lastRunExit: clean`; kill the
process and confirm `abrupt`), for the once-per-run events (`settings_snapshot`, one per launch;
`board_snapshot`, once per project viewed, and not on the open that creates one), and for
confirming a removed event stays gone.

## Environment Variables

`KANGENTIC_TELEMETRY` is the superset kill switch (it predates error reporting and its
documented promise - "disables analytics entirely" - is honored: `0` disables Aptabase AND
Sentry). `KANGENTIC_ERROR_REPORTING` controls Sentry alone:

| Variable | Value | Behavior |
|----------|-------|----------|
| `KANGENTIC_TELEMETRY` | `0` or `false` | ALL telemetry disabled: analytics and error reporting (opt-out) |
| `KANGENTIC_TELEMETRY` | `1` or `true` | Telemetry enabled, even in dev builds (for local debugging) |
| `KANGENTIC_TELEMETRY` | *(unset)* | Enabled in production only (default) |
| `KANGENTIC_ERROR_REPORTING` | `0` or `false` | Error reporting disabled; analytics unaffected |
| `KANGENTIC_ERROR_REPORTING` | `1` or `true` | Error reporting enabled, even in dev builds (unless `KANGENTIC_TELEMETRY=0`) |
| `KANGENTIC_ERROR_REPORTING` | *(unset)* | Inherits the `KANGENTIC_TELEMETRY` behavior |
| `KANGENTIC_APTABASE_APP_KEY` | an Aptabase app key | Replaces the production key; an `A-DEV-*` key routes every event to `http://localhost:3000` (see "Local verification") |

### Opt-out examples

**Windows (PowerShell):**
```
$env:KANGENTIC_TELEMETRY = "0"
```

**Windows (System):**
Add `KANGENTIC_TELEMETRY` with value `0` in System Properties > Environment Variables.

**macOS / Linux:**
```
export KANGENTIC_TELEMETRY=0
```

Add the export to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) to make it permanent.

## Data Retention

Analytics retention follows [Aptabase's privacy policy](https://aptabase.com/legal/privacy).
Error reports follow the Sentry organization's plan retention (30 days on the current plan).
