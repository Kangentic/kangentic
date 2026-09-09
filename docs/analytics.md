# Analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product,
and crash/error reports to diagnose bugs. Two vendors, two jobs: [Aptabase](https://aptabase.com)
counts product events; [Sentry](https://sentry.io) groups and symbolicates errors. Both share
the same kill switch (below).

## What We Collect (Aptabase)

Seventeen event types are tracked, all on critical-path actions only:

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
| `utility_worker_crashed` | A Kangentic utility process exited unexpectedly (not an idle recycle or quit): at most twice per service per app run, on the first crash and when the restart cap latches | service (`kangentic-embeddings`, `kangentic-line-count`), exitCode (see below), phase (`first` / `latched`) |
| `foreign_minidump_dropped` | A native crash dump reached us from a process that is not ours, and was filtered out before upload (see "Error Reporting" below) | module (the crashing executable's file name, never a path) |

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

`agent` is the adapter id from a fixed allowlist (`claude`, `codex`, `gemini`, `qwen`, `opencode`, `aider`, `cursor`, `warp`, `copilot`, `kimi`, `droid`, `ollama`, `grok`, `antigravity`). `model` is the CLI-level model identifier the agent itself reports through its status output (e.g. `claude-opus-4-7`, `gpt-5-codex`, `gemini-2.5-pro`).

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
  issue. Four classes are filtered:
  - The Windows `npm start` TTY write artifacts (`write EAGAIN`, `write EPIPE`).
  - Utility-process exits reported by the SDK's own `childProcessIntegration`
    (`'Utility' process exited with '<reason>'`). That event is tagged only with the process
    TYPE - `serviceName` / `name` / `exitCode` go into a breadcrumb added AFTER the capture, so it
    can never say which process died and no `beforeSend` could recover THAT event. Electron's internal
    utility processes (network, audio, storage) are not ours to fix, and Kangentic's own two
    workers now report themselves (see `utility_process` below), where the service name and exit
    code are known. Scoped to `'Utility'` deliberately: renderer crashes come through the same
    integration as `'renderer' process exited with ...` and must keep reporting. The breadcrumb
    survives the filter, so an internal utility crash still shows as context on later events.
  - `BENIGN_RENDERER_ERRORS` (`src/shared/benign-renderer-errors.ts`) is spread in, so the one
    registry drives the monaco error funnel, the UI-test collector, and Sentry. Patterns there
    must stay unanchored: monaco re-throws as `message + '\n\n' + stack`.
  - **Native crashes in processes that are not ours**, filtered in `beforeSend`
    (`filterNativeCrashEvent`) rather than in `ignoreErrors`. On macOS a task's mach exception ports
    are inherited across exec, so a process spawned from a Kangentic PTY writes ITS crashes into our
    Crashpad database and the SDK uploads them as ours. DESKTOP-K was Homebrew ffmpeg's `ffprobe`
    failing to start, ten fatal events; DESKTOP-N was a Puppeteer `chrome-headless-shell`;
    DESKTOP-Q was `/usr/local/share/dotnet/dotnet`, ten more. None loaded a single Kangentic
    image. This class cannot go in `ignoreErrors`, which is the
    `eventFiltersIntegration` and matches only an event's message and its exception type and value:
    a minidump event has none of those, so the matcher sees an empty candidate list and does
    nothing. It also cannot key off the SDK's `event.process` tag, because that reads `unknown` for
    real macOS crashes too (DESKTOP-E is one). The discriminator is the dump's own loaded-image
    list, read from the attachment in `src/main/analytics/native-crash-event.ts`: the event is
    dropped only when no image sits under the install root, matches the app executable's name, or is
    the Electron framework. Every uncertain path keeps the event, because a foreign crash that slips
    through is noise while a real crash dropped by a parser bug is gone. Each drop increments
    `foreign_minidump_dropped`, which is the only fleet-wide evidence left once the events stop
    arriving, and the before-and-after number for resetting the exception ports at spawn.
- **Errors only:** release-health session tracking (the SDK's `MainProcessSession` integration,
  on by default) is filtered out, and tracing and session replay are never enabled.
- **Boundary-caught errors** never reach the SDK's global handlers (React swallows them), so
  both error boundaries hand the real `Error` to `captureException` explicitly, alongside the
  existing Aptabase funnel.
- **Handled errors are forwarded too** (`reportHandledError`): the deliberate catch sites that
  otherwise emit only a sanitized count - updater structural failures (`source: updater`), PTY
  spawn failures (`source: pty_spawn`), the silent agent-spawn catches (`source: spawn`, with a
  `reason` tag), and a Kangentic utility worker that has crashed past its restart cap
  (`source: utility_process`, with `service`, `exitCode`, and `crashCount`) - send the real error
  to Sentry so hidden issues are diagnosable, not just counted. The utility-worker report also
  carries a `utility_process` context block with the last 8 KiB of the worker's stderr (home
  directory redacted). Both workers are forked with stderr piped for this; with Electron's
  `inherit` default, a packaged GUI build sent the worker's uncaught-exception dump nowhere, so
  every DESKTOP-H event could only say "exit code 1". Content lives in the context, never in a
  tag or the message, so grouping is unchanged.
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
