# Analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product,
and crash/error reports to diagnose bugs. Two vendors, two jobs: [Aptabase](https://aptabase.com)
counts product events; [Sentry](https://sentry.io) groups and symbolicates errors. Both share
the same kill switch (below).

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
| `utility_worker_crashed` | A Kangentic utility process exited unexpectedly (not an idle recycle or quit): at most twice per service per app run, on the first crash and when the restart cap latches | service (`kangentic-embeddings`, `kangentic-line-count`, `kangentic-dictation`), exitCode (see below), phase (`first` / `latched`) |
| `foreign_minidump_dropped` | A native crash dump reached us from a process that is not ours, and was filtered out before upload (see "Error Reporting" below) | module (the crashing executable's file name, never a path) |
| `gpu_process_gone` | The GPU process exited abnormally (not a clean exit on quit): at most twice per app run, on the first death and when the escalation threshold latches | reason (Electron's `child-process-gone` reason), exitCode, phase (`first` / `latched`) |
| `mobile_bridge_forced_redial` | The mobile bridge abandoned a relay socket that still read connected but carried nothing (a socket the relay reaped while the network was away; see `docs/mobile-bridge.md`): at most once per reason per app run | reason (`paired-silent` / `parked-stale`) |

There is no close event. Every quit path exits before a network send can complete, so
`app_close` fired on every quit and landed on none of them; the run's duration is instead
checkpointed to `<configDir>/analytics-run.json` once a minute and reported by the NEXT launch as
`lastRunUptimeSeconds` (Aptabase averages numeric properties, which is what replaces the
dashboard's own Avg. Duration) and the `lastRunUptime` bucket. `lastRunExit` says how that run
ended: `clean` (the quit path ran: window close, Cmd+Q, Ctrl+C, SIGTERM, an OS shutdown or log-off
that reached the app, an update install), `failsafe` (the quit path ran but Electron's teardown
hung and the hard failsafe force-killed the process), or `abrupt` (nothing was recorded: a crash, a
kill, a power loss). Uptime is wall-clock and includes time asleep. Aptabase's own session
duration is coarse by comparison, since heartbeats are the only events a long agent run emits.

Each write also stamps `at`, the wall-clock moment of that write, so the last record on disk says
when the run was last known alive. For a `clean` or `failsafe` exit that is the exit itself; for an
`abrupt` one it is the final checkpoint, which is the only clock an abrupt ending leaves behind.
It is read locally rather than reported: `previousRunLastAliveAt()` feeds the GPU report gate,
which needs to tell "the GPU died as this run ended" from "the GPU died once, forty minutes before
something unrelated killed it".

`utility_worker_crashed`'s `exitCode` is the raw value Electron's `utilityProcess` `exit` event
reports, so it is NOT comparable across platforms (POSIX derives it from `waitpid`, Windows from
`GetExitCodeProcess`). Group by `service` and platform before reading it. The value `-1` is a
sentinel meaning "the fork itself threw, so no process ever started and there is no exit code",
which a real exit code cannot collide with. The matching Sentry tag spells that same case
`unknown` rather than `-1`. `phase` says which of the two per-run events it is: `first` counts the
installs that hit a crash at all, `latched` counts the installs whose subsystem gave up (the same
moment the Sentry issue is filed). The event used to tick on every crash, which with three crashes
per five-minute decay window read as "71 crashes a day" when it was a handful of installs looping,
and could not tell those apart. The per-run cap is held per service across policy instances, since
the embed client rebuilds its policy on every model change and project switch.

`gpu_process_gone` follows the same shape for the GPU process (`src/main/diagnostics/gpu-health.ts`),
mirroring Chromium's own judgment of GPU health: three deaths inside five minutes is also the point
at which Chromium falls back to software compositing on its own
(`GpuProcessHost::RecordProcessCrash`). `first` fires on the first death, `latched` on the third;
neither fires again for the rest of the RUN, even across a later decay reset and a fresh escalation -
the phase gate is per-run, not per-window, which is what keeps this at exactly two Aptabase events no
matter how many separate incidents one launch has. `exitCode`'s `-1` sentinel does NOT carry the same
meaning it does for `utility_worker_crashed` above: there it means the fork never started, but here it
means Electron's `child-process-gone` event reported no exit code, a routine and more common case.
The latch governs this Aptabase tick ONLY. The durable escalation record is written on every death
from the first (see "Error Reporting" below), because the death that actually kills the app is one
JS never hears about: Chromium calls `RecordProcessCrash`, and the `LOG(FATAL)` under it, from the
delegate rather than from the observer notification Electron emits `child-process-gone` from. Live
reporting is impossible here for the same reason - the browser process is gone before an async
Sentry POST queued at that moment could transmit. A GPU fallback that the tracker records from
`gpu-info-update` ticks no Aptabase event, because it is not a death. So a launch-failure ladder,
which produces no `child-process-gone` at all, leaves this count at zero.

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
(which is null for most tasks, meaning "inherit"). `worktree` says whether the session ran in a
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
settings that differ from their default, from a fixed allowlist of fifteen global settings
(`SETTINGS_SNAPSHOT_ALLOWLIST` in `src/main/analytics/settings-snapshot.ts`): `memory.indexingEnabled`,
`memory.semanticEnabled`, `memory.embeddingModel`, `memory.acceleration`,
`agent.maxConcurrentSessions` (bucketed `1-3` / `4-7` / `9-12` / `13-16` / `17+`),
`agent.queueOverflow`, `agent.autoResumeSessionsOnRestart`, `agent.idleTimeoutMinutes` (bucketed
`1-15` / `16-60` / `61+`), `browserAutomation.enabled`, `browserAutomation.allowEval`,
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
paths normalized (see Error Reporting below); `boundary` is the field to reach for first on the
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

## Error Reporting (Sentry)

Crash and error monitoring is separate from product analytics: Aptabase's `app_error` stays as a
coarse error-rate pulse on the product dashboard, while Sentry (`@sentry/electron`) provides
grouping, deduplication, symbolicated stack traces, and alerting. Desktop and mobile issues land
in one Sentry org, one triage surface.

- **Initialization** (`src/main/analytics/error-reporting.ts`): the SDK initializes in the main
  process (next to `initAnalytics`, before app-ready) and in the renderer
  (`src/renderer/error-reporting.ts`). The renderer SDK has no network path of its own - every
  renderer event transports to the main process over the SDK's internal IPC, and main's
  offline-capable transport is the single point of egress. The renderer init is gated on a boot
  flag (`--kangentic-error-reporting` in `additionalArguments`) that mirrors main's single
  decision, so the two processes can never disagree.
- **Scrubbing is the SDK's and Sentry's job, not custom code:** the SDK's default
  `normalizePathsIntegration` rewrites stack-frame paths and URLs relative to the app root (the
  user's home directory never reaches Sentry for app code), `sendDefaultPii` stays `false`, and
  Sentry's server-side data scrubbing is on by default. Any further scrubbing rule belongs in the
  Sentry UI (Advanced Data Scrubbing), not in a `beforeSend` here. The one capture-site exception
  is the utility worker's stderr tail (below): it is free text, not a stack frame, and Node's
  `Require stack:` lines print absolute install paths under the user's profile, so
  `src/main/utility-process/stderr-tail.ts` replaces the home directory with `~` before the text
  goes anywhere. Same shape as the component-stack reduction above: data minimization at the
  source, not a scrubbing rule.
- **Filtering is a different concern and does live in code,** in `ignoreErrors`, plus a `beforeSend`
  for the one class `ignoreErrors` cannot see (native crashes, below). Scrubbing removes data from an
  event we keep; filtering decides a whole class of event is un-actionable and should never become an
  issue. Five classes are filtered:
  - Benign Windows stdio write artifacts, in two message shapes. Node's `errnoException` reads
    `write EAGAIN` / `write EPIPE` (the dev `npm start` TTY case) and is matched by those two
    string literals; libuv's `uvException` reads `EPIPE: broken pipe, write` (a packaged GUI
    build, which has no console) and is matched by the two regexes beside them. Neither literal
    matches the other shape, so both forms are listed.
  - Utility-process exits reported by the SDK's own `childProcessIntegration`
    (`'Utility' process exited with '<reason>'`). That event is tagged only with the process
    TYPE - `serviceName` / `name` / `exitCode` go into a breadcrumb added AFTER the capture, so it
    can never say which process died and no `beforeSend` could recover THAT event. Electron's internal
    utility processes (network, audio, storage) are not ours to fix, and Kangentic's own two
    workers now report themselves (see `utility_process` below), where the service name and exit
    code are known. Scoped to `'Utility'` deliberately: renderer crashes come through the same
    integration as `'renderer' process exited with ...` and must keep reporting. The breadcrumb
    survives the filter, so an internal utility crash still shows as context on later events.
  - The same SDK integration's GPU variant, but scoped narrower than the Utility filter:
    `'GPU' process exited with 'abnormal-exit'` only, not every reason. A lone GPU death Chromium
    recovers from on its own (DESKTOP-15) is the same un-attributable noise as a utility exit, and
    Kangentic's own GPU health tracker now reports a repeated one (see "A GPU health escalation is
    reported once" below). `'launch-failed'` is left unfiltered, but it is not a backstop: the
    integration rides `child-process-gone`, which Electron 41 never emits for a launch failure
    (it overrides no `BrowserChildProcessLaunchFailed`). DESKTOP-W's launch-failure ladder is caught
    by the GPU health tracker's fallback record instead - see below.
  - `BENIGN_RENDERER_ERRORS` (`src/shared/benign-renderer-errors.ts`) is spread in, so the one
    registry drives the monaco error funnel, the UI-test collector, and Sentry. Patterns there
    must stay unanchored: monaco re-throws as `message + '\n\n' + stack`.
  - **Native crashes in processes that are not ours**, filtered in `beforeSend`
    (`beforeSendEvent` -> `filterNativeCrashEvent`) rather than in `ignoreErrors`. On macOS a
    task's mach exception ports are inherited across exec, so a process spawned from a Kangentic
    PTY writes ITS crashes into our Crashpad database and the SDK uploads them as ours. DESKTOP-K
    was Homebrew ffmpeg's `ffprobe` failing to start, ten fatal events; DESKTOP-N was a Puppeteer
    `chrome-headless-shell`;
    DESKTOP-Q was `/usr/local/share/dotnet/dotnet`, ten more. None loaded a single Kangentic
    image. DESKTOP-1D was another project's dev Electron Helper, killed mid-launch. It loaded
    Electron Framework like every Electron app does, but from that project's own
    `node_modules/electron/dist/Electron.app`. This class cannot go in `ignoreErrors`, which is the
    `eventFiltersIntegration` and matches only an event's message and its exception type and value:
    a minidump event has none of those, so the matcher sees an empty candidate list and does
    nothing. It also cannot key off the SDK's `event.process` tag, because that reads `unknown` for
    real macOS crashes too (DESKTOP-E is one). The discriminator is the dump's own loaded-image
    list, read from the attachment in `src/main/analytics/native-crash-event.ts`: the event is
    dropped only when no image sits under the install root, matches the app executable's name, or is
    the Electron framework inside our own `Kangentic.app` bundle. An unpackaged run checks the
    install root alone, because its `Electron` executable and `Electron.app` bundle are names every
    dev Electron app shares. Every uncertain path keeps the event, because a foreign crash that slips
    through is noise while a real crash dropped by a parser bug is gone. One real crash does drop on
    purpose: a helper crash from a bundle the user renamed and then moved between the crash and the
    upload, since nothing left in its image list names us. Each drop increments
    `foreign_minidump_dropped`, which is the only fleet-wide evidence left once the events stop
    arriving, and the before-and-after number for resetting the exception ports at spawn.
- **Tagging shares that hook, and runs before the filter.** `beforeSend` is `beforeSendEvent`,
  which tags and then delegates to `filterNativeCrashEvent`. `tagTruncatedStack` sets
  `stack_truncated: 'true'` on any event whose parsed stack sits exactly on the SDK's 50-frame
  cap. The parser reads a V8 stack innermost-first and stops there, so a capped event has lost its
  OUTER frames - the app code that called into the library and the timer it ran under - and reads
  as a self-contained third-party failure with `in_app: false` everywhere. Sentry DESKTOP-19 is
  the case that earned the tag: six events, fifty monaco frames each, no in-app frame, and the app
  frame that armed the call truncated away. The tag makes "no app frames survived" distinguishable
  from "no app frames" without counting by hand. Tagging is annotation, not filtering: it never
  drops an event.
- **Errors only:** release-health session tracking (the SDK's `MainProcessSession` integration,
  on by default) is filtered out, and tracing and session replay are never enabled.
- **Boundary-caught errors** never reach the SDK's global handlers (React swallows them), so
  all three error boundaries hand the real `Error` to `captureException` explicitly. Two of them
  also keep the existing Aptabase funnel (`ErrorBoundary` as `boundary: 'root'`,
  `PanelErrorBoundary` as `boundary: 'panel'`); `DiffErrorBoundary` reports to Sentry only.
- **Handled errors are forwarded too** (`reportHandledError`): the deliberate catch sites that
  otherwise emit only a sanitized count - updater structural failures (`source: updater`), PTY
  spawn failures (`source: pty_spawn`), the silent agent-spawn catches (`source: spawn`, with a
  `reason` tag), a Kangentic utility worker that has crashed past its restart cap
  (`source: utility_process`, with `service`, `exitCode`, and `crashCount`), and a GPU health
  escalation reported on the next launch (`source: gpu_process`, with `reason`, `exitCode`, and
  `crashCount` - see the GPU health bullet below), and a guarded synchronous write that could not
  reach disk (`src/main/config/write-failure-notice.ts`, one report per failing `source` tag per
  outage: `config`, `config_dirs`, `config_project_override`, `import_source`, `browser_url`, the
  three `mobile_bridge_*` stores, `asana_credential`, plus an `errno` tag when the error carries
  one) - send the real error to Sentry so hidden issues
  are diagnosable, not just counted. ENOSPC arrives on that last path and is deliberately NOT
  filtered: it is a host condition rather than a defect, but it is also the only evidence the
  user-facing toast fires at all, and the per-source latch already caps the volume at one event
  per outage. The `errno` tag is what makes muting it later a Sentry-UI change rather than a code
  change (Sentry DESKTOP-1C). The utility-worker report also
  carries a `utility_process` context block with the last 8 KiB of the worker's stderr (home
  directory redacted). Both workers are forked with stderr piped for this; with Electron's
  `inherit` default, a packaged GUI build sent the worker's uncaught-exception dump nowhere, so
  every DESKTOP-H event could only say "exit code 1". Content lives in the context, never in a
  tag or the message, so grouping is unchanged.
- **Host memory pressure carries a `host_memory` context on every event** (`setHostMemoryContext`,
  `src/main/diagnostics/host-memory.ts`; DESKTOP-16 was a renderer OOM where the crashing process
  held 179 MB while the host had 2.15 MB of Windows commit remaining out of an 89.8 GB limit - a
  minimal reading like that took a multi-hour investigation to establish because the diagnosis
  lived only in the minidump's `chromium_stability_report`, not on the event proper). The main
  process samples `process.getSystemMemoryInfo()` every 60s and calls `Sentry.setContext` on the
  ambient scope (not `beforeSend`, which is already `beforeSendEvent` below and has no
  transaction for `setMeasurement` to hang on), so whatever event fires next - including a native
  crash - carries the freshest sample. `correctNativeCrashEvent` prunes `host_memory` under the
  same stale-dump condition as `app_memory`/`free_memory`, since a startup-found dump can otherwise
  present the uploading launch's memory as the crash's.
- **User-configuration errors are the one deliberate exclusion.** `reportHandledError`
  early-returns on a `UserConfigurationError` (`src/shared/user-configuration-error.ts`). A
  missing agent CLI (`AgentCliNotFoundError`) is the user's environment, not a defect we can ship
  a fix for, so it is surfaced in the app instead - the spawn-blocked toast names the agent and
  points at the CLI path override in Settings > Agent - while `spawn_failed` still counts it, so
  "how often are users hitting a missing CLI" stays answerable. A future user-config error opts
  itself out by extending that class rather than by adding a message pattern to a filter list.
- **A recoverable utility crash is counted, not reported.** Only the crash that exhausts the
  restart cap produces a Sentry issue, and only once per latch; Aptabase sees at most two
  `utility_worker_crashed` events per service per app run, the first crash and the latch. The same
  volume-versus-diagnostic split as `spawn_failed`.
  Every crash does log its stderr tail to the main console as a
  `[utility-process] <service> exited with code <n>` warning, which the log mirror persists to
  `<project>/.kangentic/logs/<date>.log`, so the text is on disk locally whether or not error
  reporting is on. The Memory settings tab shows the same reason (exit code plus the first error
  line) while semantic search is off because of it.
- **A GPU health escalation is reported once, and on the NEXT launch, not live.**
  `src/main/diagnostics/gpu-health.ts` counts GPU `child-process-gone` deaths the same way
  `UtilityRestartPolicy` counts a worker's, but cannot report live: the failure sequence this exists
  for can end in Chromium calling `LOG(FATAL)` (`IntentionallyCrashBrowserForUnusableGpuProcess`),
  which kills the whole process before an async Sentry POST queued at that moment would ever
  transmit. (A 90-day search never turned up a `'GPU' process exited with 'launch-failed'` event
  for a different reason: Electron never emits `child-process-gone` for a launch failure at all.)
  EVERY death writes the durable record at `<configDir>/gpu-health.json`, from the first - not
  just a threshold breach.
  The ordering is why: Chromium calls `GpuProcessHost::RecordProcessCrash` (and the `LOG(FATAL)`
  under it) from the delegate, BEFORE the observer notification Electron emits
  `child-process-gone` from, so the death that actually kills the app is one JS never hears about.
  A write gated on three observed deaths can therefore lose the whole incident, which is what
  DESKTOP-18's seven 8-to-12-second launches would have done. Each write carries
  `app.getGPUFeatureStatus()` AT THAT MOMENT plus a bounded `deaths` sequence (20 entries, middle
  trimmed, first and last kept) recording the reason, exit code, GPU mode and timestamp of each
  death in order - the sequence is the only thing that can show how Chromium walked its ladder,
  where a single end-state snapshot cannot. Each entry's mode is read after Chromium handled that
  death, so it names the rung the death left behind: the death that triggers a fallback already
  reads the lower rung. The FALLBACK writes too, from
  `gpu-info-update`: once this run has been seen compositing on the GPU, the moment
  `gpu_compositing` leaves it, and each later status change, appends to a bounded `modeChanges`
  list (8 entries) and moves the record's `lastAt`. That is DESKTOP-W's only trace. Its deaths
  were launch failures, which Electron never forwards to JS, and on Linux the running GPU
  process's death through a dead zygote reads as a normal exit that fires nothing either (see
  "When the GPU process is unusable" in [cross-platform.md](cross-platform.md)). A fallback-only
  record has `count: 0` and `reason: 'hardware-fallback'`. On Linux each fallback entry also
  carries a `linux` block from `src/main/diagnostics/linux-gpu-zygote.ts`: the GPU zygote's state
  (`alive`, `dead`, `unknown`), the system-wide thread count, and the soft process limit. A dead
  zygote and a fork refused at the limit produce the same DESKTOP-W stack, and this block is what
  tells them apart. A dead zygote also records a fallback on a machine that never composited on the
  GPU. `src/main/index.ts` reads the record once `app.whenReady()`
  resolves on the FOLLOWING launch, skips it if `isEscalationFromCurrentRun` says THIS run wrote it
  (the writer is installed at module scope and the reader runs after `createWindow` and an `await`,
  so a GPU crash-looping from startup writes into that gap; consuming it there would burn the
  report on a run about to be killed and leave the next launch with nothing),
  **clears it BEFORE reporting** (so a launch with error reporting
  off - the kill switch, or `KANGENTIC_ERROR_REPORTING=0` - still consumes it silently rather than
  carrying it forward to a later launch that might have reporting on; the local crash JSONs and the
  `gpu_process_gone` Aptabase count exist either way). The clear is a compare-and-clear against the
  `lastAt` that was reported, because a crash loop can write a FRESH record between the read and the
  clear and an unconditional unlink would take it. The reverse race is not guarded: the writers are
  installed at module scope and each write rebuilds the file from this run's state alone, so a
  boot-time death or fallback on THIS run can overwrite the previous run's record before the report
  block reads it. A VM or broken-GL machine that falls back at every boot makes that common. The
  recovery decision is safe, because it reads the record at module scope before any GPU process
  exists, and the software mode it engages never writes. What can be lost is the report of something
  the previous run survived: a fallback, or a crash loop that reached the report threshold. Not
  every pending record earns an issue:
  `shouldReportEscalation` reports on `count >= 3`, OR when the previous run ended `abrupt` AND the
  record's `lastAt` (the last death or fallback) sits within 90s of that run's last known sign of
  life (`run-uptime.ts`'s `at` checkpoint). The second arm needs both halves - `abrupt` alone means
  only that no exit was recorded, which covers a renderer OOM, a task-manager kill and a power loss,
  and pairing it with "the GPU died once at some point" would blame graphics for a death it had
  nothing to do with. A fallback the run survived is not reported: VMs and broken-GL machines can
  fall back at every boot. When it does report, `src/main/index.ts` calls `reportHandledError` with
  the message `GPU process exited repeatedly (...)`, or `GPU left hardware acceleration with no GPU
  process exit reported` for a fallback-only record, which groups the launch-failure shape as its
  own issue. It carries tags
  `source: gpu_process`, `reason`, `exitCode`, `crashCount`, and a `gpu_process` context carrying
  `reason`, `exitCode`, `count`, `firstAt`, `lastAt`, `escalatedInVersion` (the app version that
  produced the escalation, not the one reporting it - the same build-attribution concern the native
  crash correction below exists for), `featureStatusAtEscalation`, `featureStatusOnReport`, and
  `previousRunExit`. The last three are deliberately three separate facts, not one:
  `featureStatusAtEscalation` is what Chromium's GPU mode was at the record's LATEST WRITE, a death
  or a fallback (the one fact neither DESKTOP-W nor DESKTOP-15 could say); `featureStatusOnReport` is what it is on
  THIS boot, read live, which may already differ (a machine can recover on its own between launches);
  and `previousRunExit` is the previous run's `run-uptime.ts` exit kind (`abrupt` means that run ended
  in a process kill, the DESKTOP-W shape; `clean` or `failsafe` means Chromium recovered on its own,
  the DESKTOP-15 shape; `unknown` on a first launch or a wiped config dir), so the two failure shapes
  are distinguishable on arrival. The context also carries `deaths` (the sequence above),
  `modeChanges` (the fallback steps above),
  `gpuInfoOnReport` (`app.getGPUInfo('complete')`, the one call of it in this path, naming the
  machine's actual graphics stack), `killedTheLastRun`, and `softwareRenderingEngaged`.
- **A GPU failure that killed the last run also downgrades this one, once.** When
  `killedTheLastRun` holds, `src/main/index.ts` has already started Chromium with
  `app.disableHardwareAcceleration()` and `--in-process-gpu` (decided at module scope, because
  that API throws once the app is ready), and now persists `graphicsAccelerationEnabled: false` with
  `graphicsAccelerationOffBy: 'app'` so later launches read the setting instead of re-deriving it
  from a record that is about to be cleared. `graphicsAccelerationOffBy` is what stops a later
  failure overwriting a choice the user made themselves. The renderer PULLS this state
  (`IPC.GPU_HEALTH_STATUS`) rather than main pushing it: both facts are decided during boot, when a
  `webContents.send` can land before any listener is registered and be dropped silently, and the
  record behind them is already gone. Reading consumes the notice, so a reload cannot re-toast.
  See "Graphics failures" in [user-guide.md](user-guide.md) for what the user sees.
- **A transient updater feed failure is counted, not reported.** `hasTransientNetworkCause`
  (`src/main/updater.ts`) gates the `reportHandledError` call in the `autoUpdater.on('error')`
  handler, and sits deliberately AFTER `trackEvent('app_error')` so the "how often do update
  checks fail" volume view survives. GitHub returning a 504 on a routine check is not something
  we can ship a fix for, and the next check succeeds.

  It exists because the neighbouring `isTransientUpdaterError` cannot see these. electron-updater's
  `newError()` constructs a new `Error` and assigns its own `code`, and `GitHubProvider` rewraps
  twice, so an `HTTP_ERROR_504` arrives as `ERR_UPDATER_INVALID_RELEASE_FEED` and every code-based
  branch misses. The original failure survives only as nested stack text inside the wrapper's
  message, so the check reads the message, and requires BOTH a feed wrapper (by code or by the
  literal phrase the wrapper writes) and a transient shape in the text. A genuinely malformed feed
  carries no transient shape and stays reportable.
- **A denied elevation prompt is counted, not reported.** `isElevationDeniedError`
  (`src/main/updater.ts`) gates the same `reportHandledError` call from the same position, one
  branch below the one above. A Linux user on a `.deb` or `.rpm` install who presses "Restart to
  update" and then dismisses the polkit dialog has declined the update, which is their own choice
  and not a defect. The `app_error` counter still fires, so "how often is a Linux update declined"
  stays answerable.

  It is a message pattern rather than a `UserConfigurationError` subclass, against that class's own
  advice, because the throw site is third-party: `BaseUpdater.spawnSyncLog` throws a bare
  ``Error(`Command ${cmd} exited with code ${status}`)`` with no `code` and no `cause`, so the
  message is all there is to test. Only exit 126 and 127 are suppressed, and pkexec(1) is what
  makes those two safe. It exits 126 when the user dismissed the dialog and 127 when the user is
  not authorized or authentication failed, both meaning the elevated command never ran; when the
  command does run, pkexec returns that program's own value, and `dpkg` exits 1 or 2 while `rpm`
  exits 1. A genuine install failure therefore never wears either code.

  One gap is deliberate. `sudo` exits 1 for an authentication failure and `gksudo` / `kdesudo`
  exit 1 when cancelled, which is indistinguishable from a command that ran and failed, so those
  declines still report. `LinuxUpdater.determineSudoCommand` picks `pkexec` on any current GNOME
  or KDE desktop, which is the case that ships. Because the pattern hand-matches a third-party
  template, `tests/unit/updater-error-classifier.test.ts` reads the installed
  `electron-updater` and fails if that template is reworded or a fifth sudo front-end appears.
- **A read-only volume is counted, not reported, and is the one condition the user hears about.**
  `isReadOnlyVolumeError` (`src/main/updater.ts`) gates the same `reportHandledError` call from
  the same position as the two above. A macOS app launched straight from the mounted DMG, or
  running translocated, cannot write over itself, so Squirrel.Mac refuses the install. That is a
  property of where the user put the app, not a defect: no build of ours would behave
  differently. DESKTOP-1A filed it 11 times from a single install.

  Unlike every other suppressed branch, this one also pushes `updater:blocked` to the renderer,
  which toasts a sentence pointing at the Applications folder. The reason is that the condition
  is permanent and silent: an install in this state never updates again and says nothing, so
  dropping the Sentry issue without telling anyone would leave the user on a frozen version
  indefinitely. The push is latched in main for the app's lifetime, so a condition every 4-hour
  check rediscovers still produces one toast per run.

  The pattern matches Squirrel's opening sentence only. Squirrel appends a recovery suggestion
  naming Downloads, macOS Sierra and a GitHub issue URL, none of which identifies the condition.
- **An EAGAIN install failure is counted, not reported.** `isResourceUnavailableError`
  (`src/main/updater.ts`), the branch below. DESKTOP-1B is the POSIX `EAGAIN` reaching us through
  macOS's `NSError` rendering rather than through Node, which is the only reason
  `isTransientUpdaterError` misses it: `ECONNRESET` and friends sit beside `EAGAIN` in the same
  errno table, but a Squirrel.Mac error carries no `code` for those branches to read. It is as
  transient as the network blips above and gets the same treatment.

  The pattern matches `Resource temporarily unavailable`, the strerror text, and ignores the
  `The operation couldn't be completed.` sentence in front of it. That half is `NSError`
  boilerplate identifying nothing, and it carries a typographic apostrophe no source pattern
  should have to reproduce.
- **A prerelease build with no matching release is counted, not reported.**
  `isPrereleaseWithNoMatchingRelease` (`src/main/updater.ts`), the last branch before the report.
  `AppUpdater` derives `allowPrerelease` from whether the running version has a prerelease
  component, so a `0.41.0-dev.1` build asks `GitHubProvider` for a `dev` channel, finds nothing
  in the feed, and throws. We publish no such channel, so that is the build's expected steady
  state. DESKTOP-17.

  The predicate is conjunctive and the version half is the point of it. `GitHubProvider` throws
  the same `No published versions on GitHub` sentence from two places: the tag-is-null throw,
  which carries `ERR_UPDATER_NO_PUBLISHED_VERSIONS` and needs `allowPrerelease`, and the feed's
  own entry lookup, which throws it codeless when the Atom feed has no entries at all. On a
  stable build that second one means our releases feed is empty or broken, which still reports.
  `tests/unit/updater-error-classifier.test.ts` pins both throw sites against the installed
  `electron-updater`, and pins the stable-build negative.

  Two gaps are named rather than left implicit. The macOS predicates above get no upstream drift
  guard and cannot: Squirrel.Mac is compiled into Electron and the EAGAIN text is macOS
  localization, so neither string has a source on disk to assert against. A reword would cost a
  rediscovery, not a silent regression, since the issue would simply reappear.
- **Reading `app_error` / `source: updater`: the count is not every updater failure.** The five
  suppressions above are not uniform about it, and the split is older than any of them.
  `isTransientUpdaterError` gates ABOVE `trackEvent`, so the classes it catches (a raw
  `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `EPIPE`, an `HTTP_ERROR_5xx`
  / `408` / `429` / `618`, a `net::ERR_`, an aborted request, a failed pipe) produce no event at
  all. That was the deliberate call when it was written: keep network blips out of `app_error`
  entirely. Every gate added since sits BELOW `trackEvent` and keeps the count.

  The practical consequence: one underlying network failure is counted or not depending on
  whether electron-updater rewrapped it. A feed fetch that fails with an intact errno is
  suppressed silently; the same fetch failing through `GitHubProvider`'s double rewrap loses its
  code, falls through to `hasTransientNetworkCause`, and IS counted. So "how often do update
  checks fail" undercounts by exactly the class that kept its errno. Moving
  `isTransientUpdaterError` below `trackEvent` would make the file consistent, and is the obvious
  cleanup, but it would redefine a metric that has counted the same way since April 2026
  (`5513c7cc`). Treat it as a telemetry decision, not a refactor.

  Also note `sanitizeErrorMessage` truncates to 180 characters, which is shorter than the
  read-only-volume message. The classes are still distinguishable by their opening sentence,
  since there is no per-class tag on the event.
- **Affected-install counts:** the same anonymous, non-reversible `clientId` documented under
  "Unique Installs" is attached as the Sentry user id, so an issue's Users column means
  "installs affected." It contains no personal data and shares the same kill switches.
- **Investigating an issue:** the `/sentry` skill (`.claude/skills/sentry/SKILL.md`) teaches an
  agent to retrieve and diagnose issues from the org via the API.
- **Sourcemaps** upload at release time only: `@sentry/vite-plugin` (renderer) and
  `@sentry/esbuild-plugin` (main/preload) activate when an upload token is present
  (`KANGENTIC_SENTRY_TOKEN`, or the conventional `SENTRY_AUTH_TOKEN` as a CI fallback), generate
  hidden maps, upload them with debug IDs, and delete them from the output. Nothing ships in the
  artifact; resolution is entirely server-side. The DSN in source is a public routing
  identifier by design, not a secret. `KANGENTIC_SENTRY_TOKEN` is also what the `/sentry`
  skill reads for issue retrieval, so one scoped variable serves both. Both plugins pass an
  explicit `release.name` of `Kangentic@<version>`, matching what `@sentry/electron` reports at
  runtime; left unset the bundler default is `GITHUB_SHA`, which files the artifacts under a name
  no event ever carries.
- **A native crash is attributed to the build that crashed, not the one that uploaded it.** Crashpad
  writes the dump; the SDK uploads it on the next launch. If the user upgraded in between, that later
  build's release tag and scope ride along: DESKTOP-M crashed on 0.38.0 and arrived tagged
  `Kangentic@0.39.0`, with an `app_start_time` 21 minutes AFTER the crash and seven breadcrumbs from
  the launch that uploaded it. The same `beforeSend` corrects this from the dump. The crashed build's
  version is Crashpad's `_version` annotation, which lives in the process-level simple-annotation
  dictionary the SDK does not read (it reads the per-module annotation objects, a disjoint set), so
  it is read directly from the attachment. `release` is rewritten keeping whatever prefix it already
  carries, and `contexts.app` is corrected when its `app_start_time` postdates the dump or its
  version disagrees. Breadcrumbs go entirely: the SDK merges the CURRENT scope's breadcrumbs on top
  of the stored previous-run scope, so the two runs cannot be separated after the fact and reading
  them as the crashed session's is a trap.

  All of that applies only to a dump found at STARTUP, which is the sole SDK path that replays a
  stored previous-run scope. The other two native paths fire from `render-process-gone` and
  `child-process-gone` in the session that is still running: they build the event fresh, so its
  breadcrumbs and app context really are the crashed session's and correcting them would delete a
  good trail. Those two are also the only paths that stamp an `exit.reason` tag, which is what the
  correction is gated on. The ownership filter above stays unconditional, since a live crash event
  can still pick up a stray foreign dump sitting in the same directory. What the dump itself says
  lands in a `native_crash` context on every kept event whose dump PARSED: crash time, crashed
  version, uploading version, the main module's file name, the module count, whether the dump was
  found at startup, and which corrections fired. A dump the reader cannot parse keeps its event
  untouched and carries no context block, so the absence of one is itself a signal when triaging.
  Note the SDK decrements its 10-minidumps-per-session budget at capture time, before `beforeSend`
  runs, so dropped foreign dumps still consume it.
- **Native debug files** ride the same gate: the Windows release build (`scripts/build.js`) also
  uploads node-pty's shipped Windows PDBs (`node_modules/node-pty/prebuilds/win32-*/`) as Sentry
  debug files, so a native crash inside `conpty.node` symbolicates server-side to function and
  line instead of arriving as raw addresses (the DESKTOP-C investigation had to resolve those
  offline). Only the Windows leg uploads, so the release matrix sends them once. Debug files are
  keyed by build id rather than by release, so this upload is unaffected by the release name above.
- **The upload is not allowed to fail quietly**, because for two releases it did. v0.37.0 and
  v0.38.0 both shipped with zero sourcemaps and zero debug files, which is why DESKTOP-D's stack
  was nothing but `Si`, `b`, `cc` in `react-vendor-*.js`. Two independent causes, both silent:
  - The `KANGENTIC_SENTRY_TOKEN` repository secret did not exist, so `${{ secrets.* }}` expanded
    to the empty string and both gates read false. The `preflight-symbols` job in
    `.github/workflows/release.yml` now fails the release before anything is built or drafted,
    and `/release` checks the same secret before it creates the tag.
  - Both plugins skip the upload when `NODE_ENV === 'development'`, logging only at debug level
    and deleting the sourcemaps anyway. `scripts/build.js` sets `NODE_ENV=production` at module
    load, and both it and `vite.config.mts` refuse to build if a token is present while
    `NODE_ENV` is anything other than production, which also catches it being unset.

  On top of that, every build now prints which way the gate went, and with a token present any
  upload failure fails the build rather than warning past it.

## What We Don't Collect

- Task titles, descriptions, or any user-generated content
- File paths, project names, or code (stack-frame paths are normalized to the app root before
  they leave the machine)
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
| `KANGENTIC_ERROR_REPORTING` | `0` or `false` | Error reporting disabled; analytics unaffected, except `foreign_minidump_dropped`, which fires from the Sentry `beforeSend` hook and so never installs |
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
