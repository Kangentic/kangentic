# Analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product,
and crash/error reports to diagnose bugs. Two vendors, two jobs: [Aptabase](https://aptabase.com)
counts product events; [Sentry](https://sentry.io) groups and symbolicates errors. Both share
the same kill switch (below).

## What We Collect (Aptabase)

Eighteen event types are tracked, all on critical-path actions only:

| Event | When | Properties |
|-------|------|------------|
| `app_launch` | App starts (when analytics is enabled) | platform, arch, clientId |
| `app_heartbeat` | Every 30 minutes while at least one agent session is active; skipped when idle. Also fires once right before system sleep if a session is active | activeSessions, suspendedSessions, queuedSessions, totalSessions |
| `app_close` | Graceful quit, Ctrl+C, SIGTERM, or OS shutdown/reboot/log-off | durationSeconds |
| `app_error` | Uncaught exception, unhandled rejection, renderer crash, React ErrorBoundary, updater failure, or PTY spawn failure | source, message (sanitized); see per-source extras below |
| `project_create` | User creates a project | (none) |
| `project_move` | User relocates a project folder via the Locate Folder dialog (move mode) | (none) |
| `project_relocate` | Same dialog, relocate mode | (none) |
| `task_complete` | Task moves to Done | agent, model, permissionMode, durationSeconds, costUsd, inputTokens, outputTokens, toolCalls |
| `session_spawn` | Agent session reaches running state (board or transient) | agent, isTransient, permissionMode, worktree |
| `session_exit` | Agent session finishes | exitCode, durationSeconds, agent, model, costUsd, toolCalls, intentional |
| `transient_session_spawn` | Transient session launched from command bar | agent |
| `onboarding_milestone` | Once per install per funnel step | step (`first_project`, `first_task`, `first_spawn`, `first_task_complete`) |
| `feature_first_use` | Once per install per curated feature | feature |
| `feature_used` | Once per curated feature per UTC day | feature |
| `board_snapshot` | Once per project per app run, on cold project open | columns, customColumns, taskBucket (`0` / `1-9` / `10-49` / `50-199` / `200+`), profiles |
| `update_outcome` | Next launch after the app version changed | result (`applied` / `rolled_back`), fromVersion, toVersion |
| `spawn_failed` | An agent spawn failed (born-into-column create, MCP auto-spawn, any board-driven resume including a drag move, startup recovery) | agent, reason (`create_spawn`, `auto_spawn`, `resume`, `unknown_agent`, `cli_not_found`) |
| `utility_worker_crashed` | A Kangentic utility process exited unexpectedly (not an idle recycle or quit) | service (`kangentic-embeddings`, `kangentic-line-count`), exitCode (see below) |

`utility_worker_crashed`'s `exitCode` is the raw value Electron's `utilityProcess` `exit` event
reports, so it is NOT comparable across platforms (POSIX derives it from `waitpid`, Windows from
`GetExitCodeProcess`). Group by `service` and platform before reading it. The value `-1` is a
sentinel meaning "the fork itself threw, so no process ever started and there is no exit code",
which a real exit code cannot collide with. The matching Sentry tag spells that same case
`unknown` rather than `-1`.

The curated `feature` vocabulary is `ANALYTICS_FEATURES` in `src/main/analytics/usage.ts`:
`command_terminal`, `worktree_session`, `board_profile`, `popout_window`, `browser_pane`,
`mcp_server`, `mobile_bridge`, `usage_dashboard`, `quick_find`, `settings`. Each feature adds at
most one `feature_used` event per user per day, so the list is a budget decision, not a free
enum. Renderer-reported features cross one IPC channel (`analytics:trackFeatureUsed`) and are
re-validated against this list in the main process. Onboarding milestones and feature first-use
flags persist in `<configDir>/analytics-usage.json`, alongside the last-run version that powers
`update_outcome`.

`agent` is the adapter id from a fixed allowlist (`claude`, `codex`, `gemini`, `qwen`, `opencode`, `aider`, `cursor`, `warp`, `copilot`, `kimi`, `droid`, `ollama`, `grok`, `antigravity`). `model` is the CLI-level model identifier the agent itself reports through its status output (e.g. `claude-opus-4-7`, `gpt-5-codex`, `gemini-2.5-pro`).

`model` is only present on events fired *after* the agent has emitted at least one status update, which means it is omitted on `session_spawn` and `transient_session_spawn` (model is unknown at spawn time) and may also be omitted on `session_exit` / `task_complete` for very short sessions that exited before the agent reported a model.

For Claude sessions, `model` is normalized to its base id via `parseModelId` (`src/shared/model-id.ts`) before being attached, so the 1M-context opt-in suffix and a dated pin no longer fragment the model breakdown: `claude-opus-4-8[1m]` -> `claude-opus-4-8`, `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`. This is a display-layer grouping only - the exact spawnable id is unaffected.

`permissionMode` on `session_spawn` / `task_complete` is the RESOLVED mode the session record
actually spawned under (from `resolveEffectivePermissionMode`), not the task's raw override
(which is null for most tasks, meaning "inherit"). `worktree` says whether the session ran in a
git worktree. `intentional` on `session_exit` distinguishes a deliberate kill/suspend (tagged by
the session manager) from a genuine agent-side exit, closing the crash-versus-intentional blind
spot.

`costUsd`, `inputTokens`, `outputTokens`, and `toolCalls` are cumulative session metrics, omitted when not yet available (e.g. a session that exited before any usage was recorded). `session_exit` carries `costUsd`/`toolCalls` only, since its token counts would otherwise be a point-in-time context-window snapshot rather than a cumulative total; `task_complete` is the source for cumulative token counts.

The `app_launch` event also carries `clientId`, an anonymous id Kangentic generates and attaches (see "Unique Installs" below). It is attached only to `app_launch` (the one authoritative per-launch install signal), not to every event, to avoid inflating high-cardinality string-prop volume on events like `app_heartbeat` where it adds no install-counting value.

`board_snapshot` sends counts only: the number of columns, whether the board deviates from the
seeded default (compared against `DEFAULT_SWIMLANES` in `src/main/db/migrations/default-data.ts`
by count and name-set), a bucketed task count (never the exact figure), and the number of Board
Profiles. Column names and task content never leave the machine.

### app_error sources

`source` discriminates the failure path: `uncaughtException`, `unhandledRejection`,
`render-process-gone` (extras: `reason`, `exitCode`), `error_boundary` (extras: `boundary`,
`panel`, `components`), `updater`, `pty_spawn` (extras: `shell`, `shellArgs`, `cwdExists`,
`shellExists`, `errno`, `platform`, `arch`), and `pty_spawn_cwd_missing` (extra: `platform`).

Renderer errors (`source: error_boundary`) carry three extra properties that say *where* the error
happened, since a message alone is rarely enough to locate one. `boundary` is `root`, `panel`, or
`unhandled_rejection` and identifies which of the three reporters caught it; `panel` is the
failing panel's static label; `components` is a trail of React component names, innermost first.
The raw component stack is never sent to Aptabase: a production stack frame embeds a `file://`
URL containing the user's home directory, so main reduces it to component names, which cannot
contain a path. (Sentry receives the real stack instead, with paths normalized - see Error
Reporting below.)

`boundary` and `panel` read directly. `components` does not: React takes frame names from
`fn.name` and the packaged renderer bundle is minified, so the trail arrives mangled. It still
distinguishes one code path from another, but Sentry is now the place to read a symbolicated
stack; `boundary` is the field to reach for first on the Aptabase side.

Aptabase truncates any string property at 180 characters server-side, so `message`, `panel`, and
`components` are all capped at that length locally (`MAX_ANALYTICS_STRING_LENGTH`) rather than
sending text that would be silently cut.

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
  Sentry UI (Advanced Data Scrubbing), not in a `beforeSend` here.
- **Filtering is a different concern and does live in code,** in `ignoreErrors`. Scrubbing removes
  data from an event we keep; filtering decides a whole class of event is un-actionable and should
  never become an issue. Three classes are filtered:
  - The Windows `npm start` TTY write artifacts (`write EAGAIN`, `write EPIPE`).
  - Utility-process exits reported by the SDK's own `childProcessIntegration`
    (`'Utility' process exited with '<reason>'`). That event is tagged only with the process
    TYPE - `serviceName` / `name` / `exitCode` go into a breadcrumb added AFTER the capture, so it
    can never say which process died and no `beforeSend` could recover it. Electron's internal
    utility processes (network, audio, storage) are not ours to fix, and Kangentic's own two
    workers now report themselves (see `utility_process` below), where the service name and exit
    code are known. Scoped to `'Utility'` deliberately: renderer crashes come through the same
    integration as `'renderer' process exited with ...` and must keep reporting. The breadcrumb
    survives the filter, so an internal utility crash still shows as context on later events.
  - `BENIGN_RENDERER_ERRORS` (`src/shared/benign-renderer-errors.ts`) is spread in, so the one
    registry drives the monaco error funnel, the UI-test collector, and Sentry. Patterns there
    must stay unanchored: monaco re-throws as `message + '\n\n' + stack`.
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
  to Sentry so hidden issues are diagnosable, not just counted.
- **User-configuration errors are the one deliberate exclusion.** `reportHandledError`
  early-returns on a `UserConfigurationError` (`src/shared/user-configuration-error.ts`). A
  missing agent CLI (`AgentCliNotFoundError`) is the user's environment, not a defect we can ship
  a fix for, so it is surfaced in the app instead - the spawn-blocked toast names the agent and
  points at the CLI path override in Settings > Agent - while `spawn_failed` still counts it, so
  "how often are users hitting a missing CLI" stays answerable. A future user-config error opts
  itself out by extending that class rather than by adding a message pattern to a filter list.
- **A recoverable utility crash is counted, not reported.** Only the crash that exhausts the
  restart cap produces a Sentry issue, and only once per latch; every crash increments the
  `utility_worker_crashed` counter. The same volume-versus-diagnostic split as `spawn_failed`.
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
  skill reads for issue retrieval, so one scoped variable serves both.
- **Native debug files** ride the same gate: the Windows release build (`scripts/build.js`) also
  uploads node-pty's shipped Windows PDBs (`node_modules/node-pty/prebuilds/win32-*/`) as Sentry
  debug files, so a native crash inside `conpty.node` symbolicates server-side to function and
  line instead of arriving as raw addresses (the DESKTOP-C investigation had to resolve those
  offline). Only the Windows leg uploads, so the release matrix sends them once.

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
