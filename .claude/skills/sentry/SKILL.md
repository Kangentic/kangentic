---
description: Investigate a Sentry issue - retrieve the issue, latest event, stack trace, tags, and breadcrumbs from kangentic.sentry.io and diagnose it. Use when a task or the user says to investigate/look at/diagnose a Sentry issue or link, to check what errors are arriving, or to triage Sentry before a release (a sweep ends by filing the actionable issues as grouped, parallel-safe board tasks).
---

# Sentry

Retrieve and diagnose issues from the `kangentic` Sentry org (`kangentic.sentry.io`). Two
projects live there: `desktop` (this Electron app, numeric id `4511996066660352`) and `mobile`
(the React Native app, numeric id `4511808149651456`). Desktop error reporting is wired in
`src/main/analytics/error-reporting.ts`; docs/analytics.md ("Error Reporting") describes what
gets captured and how.

## Auth (never print the token)

The `sentry` CLI (see Retrieval) signs in once through the browser: `sentry auth login --read-only`
stores a refreshing OAuth login in `~/.config/sentry`, and you should not need to repeat it. That
stored login wins over a `SENTRY_AUTH_TOKEN` in the environment, so the CI upload token a build
machine has set is ignored; `sentry auth status` says which one is in use. Assigning or resolving
an issue needs a login with write access. The default grant for that also covers admin on projects
and teams, so use the narrow one, which handles triage and assigning (checked on a real issue) and
replaces any earlier login:

```
sentry auth login --force --scope project:read,org:read,event:read,member:read,team:read,event:write
```

The raw API, the fallback below, needs a bearer token. Resolution order (Kangentic-scoped on
purpose, so another repo's generic `SENTRY_AUTH_TOKEN` is never picked up by mistake):

1. `KANGENTIC_SENTRY_TOKEN` environment variable, if set.
2. On Windows, the User-level registry value for the same name (covers a process tree started
   before the variable was set): `[Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User')`.
3. The `token = ...` line in `~/.sentryclirc` (usually the CI upload token; reads 403 on it).

Read the token into a shell variable and pass it as a header in the SAME command; never echo
it, never write it to a file, never include it in a reply.

A persisted token is safe to keep at Windows User level: it is not a build switch on its own.
`scripts/build.js` and `vite.config.mts` upload symbols only when a token is present AND the
build is authorized, which means CI (GitHub Actions sets `CI=true`) or an explicit
`KANGENTIC_SENTRY_UPLOAD=1` (`isSentryUploadAuthorized`). A local `npm run build` with the
token set prints `Sentry symbol upload: skipped (a token is set, but this is a local build ...)`
and uploads nothing. Before that gate, every local build uploaded artifact bundles for an
unreleased tree under `Kangentic@<version>`.

Release builds run only on the CI matrix, so what actually decides whether a RELEASE gets symbols
is the `KANGENTIC_SENTRY_TOKEN` repository secret, not any local value. The `preflight-symbols`
job in `.github/workflows/release.yml` fails the release when that secret is missing.

Scopes: reading issues/events needs `event:read` + `project:read` + `org:read` (a User Auth
Token from Settings > Account > API > Auth Tokens; assigning and resolving issues additionally
need `event:write`). A `403` from every endpoint means the stored token is a CI-scoped one
(`org:ci` - it can only upload sourcemaps): stop and ask the user to mint a read-scoped token
rather than retrying. A `403` on the assign PUT alone means the token is read-only: report the
issues you could not mark and carry on, never let it block the triage itself.

## Retrieval

Parse the issue id from a pasted URL: `https://kangentic.sentry.io/issues/<ISSUE_ID>/?...`
(the `project=` query param is the numeric project id, useful for list queries).

Use Sentry's own `sentry` CLI (npm package `sentry`, published by Sentry, pre-1.0). Install it once
with `npm install -g sentry@0.46.0` (Node 20+). Run `sentry --version`: it must print `0.x`. A
machine that also has the older upload tool (`sentry-cli`, from scoop or Homebrew) can resolve
`sentry` to that one and print `sentry-cli 3.x`. Call the new one by its full path in npm's global
bin directory, or as `npx -y sentry@0.46.0`. Every call prints a one-line notice about
`.sentryclirc`, which is harmless.

A project target is `kangentic/desktop` or `kangentic/mobile`. An issue target is
`kangentic/DESKTOP-1N`: the shortId works for every command here, so no numeric id is needed. One
command per call:

```
sentry issue list kangentic/desktop --query "is:unresolved is:unassigned environment:production" --json --fields shortId,title,level,count,userCount,firstSeen,lastSeen,assignedTo
sentry issue view kangentic/DESKTOP-1N
sentry issue view kangentic/DESKTOP-1N --json --fields event.contexts.native_crash,event.contexts.chromium_stability_report,event.contexts.crashpad,event.contexts.host_memory,event.contexts.utility_process
sentry api organizations/kangentic/issues/DESKTOP-1N/tags/release/
sentry api organizations/kangentic/issues/DESKTOP-1N/ -X PUT -f assignedTo=user:<id>
```

- **`issue list`** returns 25 rows from the last 30 days by default (`-n 100`, `--cursor next`,
  `--period`). Run it for both projects. `--query` takes Sentry issue search syntax, and the
  query above is the triage set. Retention is 30 days, so no `--period` reaches further back.
- **`issue view`** without `--json` is the readable form: a header table (status, events, users,
  first and last seen), tags, the user's install id and location, the breadcrumbs, and the stack
  with the innermost frame first, each symbolicated frame followed by about ten lines of its source.
  It does not print the crash contexts, instruction addresses, or stackwalker trust.
- **Frame count.** The readable view prints one `at ` line per frame, which matched the JSON on four
  events (39, 40, 13 and 50 frames). In PowerShell:
  `(sentry issue view kangentic/DESKTOP-19 | Select-String '^at ').Count`. A chained exception
  prints each stack in turn, so count per stack. Diagnosis says what 50 means.
- **Crash contexts** come from `--json --fields`, about 1.5 KB for the line above where the
  readable view is 26 KB. A context the event lacks is left out of the result. Do not request
  `event.contexts.electron` or the app's own context: they carry the crashpad `gpu-url-chunk` URL,
  a home path on an event stored before the scrubbing rule.
- **Always give `--json` a `--fields` list.** Bare `--json` prints the whole raw event, 600 KB for
  a native crash, with a home path in every frame's `package`.
- **Release and environment breakdown** is one `sentry api` call per issue and key (`release`,
  `environment`). It is what spots a recurrence on the newest release. Sentry allows about ten of
  these per window, so a long list needs spacing.
- **`sentry api` GET parameters** go in as `-f key=value`, for example
  `sentry api organizations/kangentic/issues/ -f project=4511996066660352 -f query=release:Kangentic@0.43.2 -f limit=100`.
  A query string written into the path was ignored in testing.
- **Assigning** is the PUT above, with your user id from `sentry auth whoami --json --fields id`.
  It needs a login with write access. A 403 means the login is read-only: report the issues you
  could not mark and carry on.

**What reaches the output unscrubbed.** Nothing in the repo rewrites the CLI's output. Sentry removes
home paths from events as it stores them (a Data Scrubbing rule, `docs/analytics.md`, "Native crash
fields"), and the app rewrites its own home directory in exception text from the first release that
includes `src/main/analytics/redact-event-paths.ts`. An event stored before the rule (applied
2026-10-03) still carries them, and they are gone only when the event ages out of the 30-day
retention, by early November 2026. Known cases: DESKTOP-19's exception
value and stored message (the readable view matched 66 paths from two users), the crashpad
`gpu-url-chunk` URL in the `electron` context, and every frame's `package` in `--json`, which the
rule cannot reach at all. So never paste the readable view's Message, an exception value, a
breadcrumb, or a stack line into a task or a reply. Describe the error in your own words, cite
frames by module and line, and search what you are about to paste for `C:\Users`, `/Users/` and
`/home/`. The Sentry MCP's `get_sentry_resource` prints the contexts too, so the same applies.

Fall back to the raw API for what the CLI leaves out: the `debugmeta` images the native
symbolication steps need, the `threads` entry, and the issue `activity` array. In PowerShell, parse
an EVENT payload with `ConvertFrom-Json -AsHashtable`, which needs PowerShell 7 (`pwsh`); Windows
PowerShell 5.1 has no such parameter. Sentry's `_meta` annotation tree carries an empty-string key,
which plain `ConvertFrom-Json` refuses, so `Invoke-RestMethod` hands back the raw string and every
field reads empty as if the event had no data. Issue and list payloads parse either way.

PowerShell 7 pattern (one call per request; substitute the endpoint):

```powershell
$token = $env:KANGENTIC_SENTRY_TOKEN; if (-not $token) { $token = [Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User') }; if (-not $token) { $token = ((Get-Content "$env:USERPROFILE\.sentryclirc") | Where-Object { $_ -match '^token\s*=' }) -replace '^token\s*=\s*','' }; (Invoke-WebRequest -Uri 'https://sentry.io/api/0/organizations/kangentic/issues/<ISSUE_ID>/events/latest/' -Headers @{ Authorization = "Bearer $token" }).Content | ConvertFrom-Json -AsHashtable
```

macOS/Linux (Bash, one command): `curl -s -H "Authorization: Bearer $KANGENTIC_SENTRY_TOKEN" <url>`.

The endpoints that matter:

| What | Endpoint |
|---|---|
| Issue summary (title, culprit, count, userCount, firstSeen/lastSeen, level, substatus) | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/` |
| Latest event (stack trace, tags, breadcrumbs, contexts, release) | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/events/latest/` |
| All events for the issue | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/events/` |
| Search issues (e.g. new unresolved desktop issues) | `GET /api/0/organizations/kangentic/issues/?project=4511996066660352&query=is:unresolved&statsPeriod=14d` |
| Assign an issue (the triage marker, see below) | `PUT /api/0/organizations/kangentic/issues/<ISSUE_ID>/` body `{"assignedTo":"user:<USER_ID>"}` |
| Resolve an issue against a release (see Resolution markers) | `PUT /api/0/organizations/kangentic/issues/<ISSUE_ID>/` body `{"status":"resolved","statusDetails":{...}}` |
| Releases in the project, newest first (which versions Sentry knows) | `GET /api/0/organizations/kangentic/releases/?project=4511996066660352` |
| Org members (read `user.id` for the actor above) | `GET /api/0/organizations/kangentic/members/` |

The latest-event payload is large; extract what you need rather than dumping it: `entries`
with `type: "exception"` carries the stack frames, `type: "breadcrumbs"` the trail, `tags`
carries `source`/`reason` (stamped by `reportHandledError` or `reportHandledRendererError` for
handled forwards), release, environment, and the anonymous install id under `user.id`
(non-reversible; `userCount` on the issue = affected installs).

## Diagnosis

- **Mechanism first.** `mechanism` on the exception says how it was caught: `onunhandledrejection`
  / `onerror` (renderer globals), `generic` via `captureException` (a boundary, main's
  `reportHandledError`, or the renderer's `reportHandledRendererError` - check the `source` tag:
  `updater`, `pty_spawn`, `spawn`, `global_db_read`, `utility_process`, and from the renderer
  `monaco_line_number`). A `utility_process` event carries a `utility_process` context block under
  `contexts` with the worker's stderr tail; read that before the stack, since the stack is only the
  restart policy's report site and the tail is what the worker printed before it died.
- **Symbolication caveat:** packaged-release events resolve to real file/line only once a
  release build uploaded sourcemaps (`KANGENTIC_SENTRY_TOKEN` set during `npm run build`;
  `SENTRY_AUTH_TOKEN` is accepted as the fallback). A dev
  event's renderer frames are unminified module URLs (readable); a packaged event without
  uploaded maps shows minified positions - lean on message, mechanism, tags, and breadcrumbs.
- **Environment tag** separates `development` (forced-on dev/preview runs) from `production`
  (packaged installs). Do not chase dev-only test events (`Kangentic telemetry verification:` is
  the preview rig's own test error).
- **The breadcrumb trail is filtered on the machine.** On a release carrying
  `src/shared/sentry-breadcrumbs.ts`, console crumbs appear only under its allowlisted tags
  (`[UPDATER]`, `[electron-updater]`, `[SHUTDOWN]`, `[terminal-webgl]`, `[gpu]`, `[GPU-HEALTH]`,
  `[APP]`) plus Electron's own `Error occurred in handler for '<channel>'` line, an Error argument
  shows as its name and code only, click selectors read `[title]`
  without a value, and request crumbs keep a URL only when it is Kangentic's own. So a missing
  untagged line (`[WORKTREE]`, `[spawnAgent]`) is not evidence it was never logged: the user's
  `.kangentic/logs` holds the main process's warn and error lines of every tag. Older events still
  carry the unfiltered trail.
- **Exactly 50 frames means the stack is TRUNCATED, not complete.** The SDK caps a parsed stack
  at 50 (`STACKTRACE_FRAME_LIMIT` in `@sentry/core`, and `Error.stackTraceLimit = 50` set by
  `@sentry/browser`'s globalHandlers integration). It reads a V8 stack innermost-first and stops
  there, so the frames it discards are the OUTER ones: the app code that called into the library,
  and the timer or handler the whole thing ran under. Count the frames before concluding anything.
  At exactly 50, `in_app: false` on every frame does NOT mean the app is uninvolved, and the
  outermost frame is "the deepest point still visible", never "where it started". Once the
  release carrying `tagTruncatedStack` (`src/main/analytics/error-reporting.ts`) ships, a capped
  event carries a `stack_truncated: 'true'` tag; every event from before it must be counted by
  hand, and so must any event with no such tag, since its absence is ambiguous until that
  release is the only one reporting. The tag is event-level and set when any one exception hits
  50, so in a chained exception count each stack: a 3-frame cause on a tagged event is complete.
  DESKTOP-19 cost a whole investigation round to this: six events, fifty monaco frames each, and
  no in-app frame. Two different caps cut it. V8's own 50-frame limit cut the ORIGINAL error's
  outer frames when monaco's listener threw, and the SDK's parser then cut the one frame of
  monaco's rethrow (see the `mechanism` bullet below).
- **Read the `context` lines rather than reasoning from function names.** When sourcemaps are
  uploaded every frame carries `context` (the source line plus surrounding lines). That is
  authoritative and beats reading `node_modules` locally. `sentry issue view` prints each
  symbolicated frame followed by about ten lines of its source, with the frame's own line marked, so
  read those before reasoning from names.
- **Resolve library frames against the version the RELEASE shipped**, read from `package.json` at
  that git tag (`git show v0.41.0:package.json`), not from the current tree. A dependency bump
  between the first-seen release and today silently invalidates every line-number mapping and
  every prior "could not reproduce" measurement. DESKTOP-19 spans a monaco 0.55.1 -> 0.56.0 bump,
  which both rules the bump out as the cause and means the 0.55.1 measurement behind the earlier
  fix no longer describes the shipping code.
- **Same-timestamp event pairs are not always double reports.** Compare the pair's stacks before
  dividing the event count: DESKTOP-19's pairs have different outermost frames, so each incident
  threw twice rather than being reported twice.
- **The `mechanism` tag names the timer the error was RETHROWN from, which may not be the one the
  failing chain ran under.** Read the exception value before trusting it. Monaco's default
  `unexpectedErrorHandler` (`vs/base/common/errors.js`) catches an error and rethrows it from its
  own `setTimeout(..., 0)` as `new Error(message + '\n\n' + stack)`. So a value that reads as a
  message, a blank line, then a second stack is that rethrow. The
  `auto.browser.browserapierrors.setTimeout` mechanism is monaco's timer, the frames Sentry shows
  are parsed out of the embedded original stack, and the frame the 50-frame cap cut is the rethrow
  itself. Look for the innermost catcher instead. That is the frame directly above the listener
  that threw, which for a monaco event listener is `Emitter._deliver` in `event.js`. DESKTOP-19 is this
  case. An earlier pass read its `setTimeout` as the scheduler and ruled out timers until one
  app-owned timer was left, which answered the wrong question. Monaco caught the original throw
  synchronously, so whatever scheduled the chain sits in outer frames that V8's own 50-frame limit
  cut when the original error was built. The renderer's monaco funnel
  (`src/renderer/monaco-error-funnel.ts`) now reports that error as handled
  (`source: monaco_line_number`). Each live diff viewer's state is a `diff_viewer_N` context, and
  the funnel's own call stack, captured with a raised limit, is the `call_site` context. Its
  locations are bare bundle file names, so resolve them against the release's uploaded sourcemaps
  by hand. The funnel sends at most one report per 30 seconds, so the event count understates
  the throws: `funnel.suppressed_since_last_report` is how many it absorbed before that report.
- **A default-off setting can be the missing precondition.** When an issue hits very few installs,
  check whether the code path needs a non-default setting before concluding it is unreproducible.
  DESKTOP-19 needs "Collapse Unchanged Regions" on, which defaults to off.
- **Cross-reference locally:** the same failure usually has a local trail - `.kangentic/logs/`
  (crash JSONs, main console), `kangentic_tail_logs`, and the Aptabase `app_error` /
  `spawn_failed` counts are the volume view of the same signal.

## Native minidumps (`platform: native`, mechanism `minidump`)

A native crash's frames arrive as raw addresses with `function: null` for any module Sentry has
no debug file for (node-pty's `conpty.node` / `pty.node`, and better-sqlite3's per-platform
prebuild, such as `win32-x64.node`, which was `better_sqlite3.node` before 13). They can still
be resolved offline on a Windows machine, because node-pty ships the matching PDB in its npm
tarball (`node_modules/node-pty/prebuilds/win32-x64/conpty.pdb`):

1. Read the `debugmeta` entry: for the module, take `image_addr` (the load base) and `debug_id`.
2. Confirm the shipped PDB is the same build: `dumpbin /HEADERS <path to conpty.node>` prints the
   RSDS record (`{GUID}, age, pdb path`); it must equal `debug_id` (`<guid>-<age>`).
3. RVA = `instructionAddr - image_addr` for every frame in that module, `trust: scan` ones
   included (scanned frames are stale, but they name what ran on this stack recently).
4. Resolve the RVAs with dbghelp from PowerShell, no debugger install needed: P/Invoke
   `SymSetOptions` (undname, deferred loads, load lines), `SymInitializeW`,
   `SymLoadModuleExW(hProcess, 0, <path to conpty.node>, null, 0x180000000, <size of image>, 0, 0)`
   (the PDB is found next to the image), then `SymFromAddrW` and `SymGetLineFromAddrW64` at
   `0x180000000 + RVA`. Function plus source line come back; this is how DESKTOP-C resolved to
   `Napi::Error::ThrowAsJavaScriptException` inside `ThreadSafeFunction::CallJS`'s catch block.
5. Read the frames as a C++ story: `_CxxThrowException` is the throw site,
   `__FrameHandler4::CxxCallCatchBlock` above it means the throw happened inside a catch block,
   and `RtlDispatchException` / `RtlUnwindEx` further out mean an exception was already being
   handled when this one was raised.

The Windows release build uploads those PDBs as Sentry debug files when the token is present
(`scripts/build.js`), so a future event should symbolicate without this. `Kangentic.exe` frames
carry names only because Electron publishes its symbols.

Reading a native event, in order of what trips people up:

- **Check for a `native_crash` context first.** `beforeSend`
  (`src/main/analytics/native-crash-event.ts`) writes one from the dump itself: `crash_time`,
  `crashed_version`, `uploaded_by_version`, `main_module`, `module_count`, `found_at_startup`, and
  whether the release or the app context was corrected. Absence means one of two things: the event
  predates that check, or its dump could not be parsed and was therefore kept untouched. Either
  way the two traps below still apply to it in full. The foreign-crash warning (below) carries a
  shorter one: `crash_time`, `uploaded_by_version`, `found_at_startup`.
- **On an Electron OOM (`exit.reason: oom`, `mechanism: minidump`), read
  `contexts.chromium_stability_report.system_memory_state` before anything else.** It carries
  `system_commit_limit` and `system_commit_remaining` - the Windows commit charge, not physical
  RAM - alongside the crashing process's own `process_states[0].memory_state.windows_memory`
  (`process_private_usage`, `process_peak_pagefile_usage`, `process_allocation_attempt`). This one
  field answers "did the process grow, or did the host run out" without touching a single stack
  frame: DESKTOP-16 was a renderer holding 179 MB (smaller than a healthy long session) that died
  because the MACHINE had 2.15 MB of commit left out of an 89.8 GB limit, with 4.66 GB of physical
  RAM still free. Chromium's own OOM frames (`PartitionsOutOfMemoryUsingLessThan16M`,
  `PartitionOutOfMemoryCommitFailure`) name which allocation-size bucket failed and that it was a
  commit refusal, but they say nothing about whose growth caused it - `system_commit_remaining`
  is the only field that separates "renderer leak" from "host exhausted" and it takes one read to
  check. Also see `contexts.host_memory` if the event postdates DESKTOP-16's fix
  (`src/main/diagnostics/host-memory.ts`), which carries main's own periodic sample of the same
  Windows commit figures via a different, verified route (`process.getSystemMemoryInfo()`).
- **On an older event, the release tag is the UPLOADING build's, not the crashed one's.**
  Crashpad writes the dump and the next launch uploads it; if the user upgraded in between, the
  tag is a build that never crashed. `contexts.crashpad._version` is the build that did.
  DESKTOP-M cost a triage sweep a wrong conclusion this way.
- **A shifted stack re-groups into a new issue, so "no new event on this issue" does not mean
  the crash class is gone.** Native grouping keys off stack frames, and inlining, a different
  thread interleaving, or an ASLR-shifted offset can move the same underlying bug into a fresh
  shortId. Verifying a fix held on a later release needs a `release:Kangentic@X` query, not
  `firstRelease:`, which misses a group born on an older release that still carries events on X.
  Drop the `is:unresolved` that this skill's query examples carry, because it hides resolved
  groups the release genuinely produced and breaks the count. `sentry issue list kangentic/desktop
  --query "release:Kangentic@X" -n 100` does that, and so does `sentry api` with `-f` parameters
  (see Retrieval). Sum every returned group and check the total against that release's own event
  count from the releases endpoint. A match means every event the release produced is accounted for
  by a named group; read each group's title to confirm none is the crash class in question. A
  mismatch means the search was incomplete, not that a recurrence is hiding. Widen it and count
  again. Search only sees the last 30 days: a group whose events have all aged out is missing from
  the results although its issue remains, so for a release older than that the sum cannot close. Task #669
  (DESKTOP-Y/DESKTOP-Z) is where this mattered: 0.41.0's six new groups summed to its entire
  16-event volume, and none was a teardown crash.
- **Breadcrumbs on a startup-found dump are not the crashed session's.** On an older event they
  are the uploading launch's, wholly or partly; on a corrected one they are removed rather than
  left to mislead. Breadcrumbs on an event tagged `exit.reason` are trustworthy: that tag marks
  the two SDK paths that report a crash the running session watched happen.
- **A crash in a process Kangentic merely spawned arrives as one warning issue rather than a
  fatal, unless its dump could not be parsed.** The check fails open, so such a dump stays a
  fatal with its minidump attached, and it carries no `native_crash` context. On macOS, mach exception ports are inherited across exec, so an agent shelling out to
  ffmpeg, a headless browser, or a dotnet tool used to file its crashes as ours. Four sources have
  been seen: DESKTOP-K (Homebrew ffmpeg's `ffprobe`), DESKTOP-N (a Puppeteer
  `chrome-headless-shell`), DESKTOP-Q (`/usr/local/share/dotnet/dotnet`, ten events), and
  DESKTOP-1D (another project's dev Electron Helper). One check covers all four, since it keys off
  whether the dump loaded a Kangentic image rather than off any binary's name. DESKTOP-1D got
  through an earlier version of it that counted any `Electron Framework` image as ours. Every
  Electron app loads that framework, so it now counts only inside our own `Kangentic.app` bundle.
  Task #604 tracks DESKTOP-Q, though no commit names it. Every such crash the check identifies
  now groups into the single issue "Foreign process crash reached Kangentic's crash database" (level `warning`, fixed
  fingerprint), with no minidump attached and so no stack. It shows up in the triage query below.
  Break it down by the `module` tag and by release: `module` is the crashing program's file name,
  or `user-binary` when it is not in an installer or package-manager directory. Its
  `native_crash.crash_time` separates dumps written before an upgrade from ones after it. Builds
  before that change dropped these and counted the Aptabase event `foreign_minidump_dropped`
  instead, so an older release's residue lives there.
- **Residue on a release with the exception-port reset points at a launch path it does not
  cover.** PTY children and the four shell launches (`resolveShellLaunch` in
  `src/main/pty/spawn/shell-launch.ts`) start with no exception port on a packaged build. An
  unpackaged run with error reporting switched on keeps node-pty's stock helper, so its events
  (`environment: development`) are not residue. "PTY children and mach exception ports" in
  `docs/cross-platform.md` lists what is covered. Two known paths still inherit it. The headless agent runs (started in the pty host by `src/main/pty/host/host-cli-processes.ts`, or by `src/main/agent/shared/cli-print.ts` with no host) run agent
  hooks, so a `module` that is a hook tool, or anything else an agent's hooks start, most likely
  comes from there. The shell-launch docstring says how to route an agent binary through the
  helper without losing ENOENT. Git runs repository hooks (husky, lefthook, a `post-checkout` on
  `git worktree add`), and git is launched as a plain binary, so a `module` that looks like hook
  tooling in a JS repo points at git's spawns. The fingerprint keeps all of it in one issue, but
  every event still counts against quota: one user produced 18 in a single release before the
  reset. If the issue spikes, set a rate limit on it in Sentry rather than sampling client-side.
- **Scope persists with a 500 ms write throttle**, so on any event the last half-second of
  breadcrumbs before the crash is missing. An entire quit sequence fits in that gap.

## Typical requests

**"Any new issues?" (triage scan).** Run the `issue list` line from Retrieval for
`kangentic/desktop` and again for `kangentic/mobile`, unless the user scoped to one. The query
keeps only unresolved, unassigned production issues, so the result is already most of the report's
per-issue line: shortId, title, count, userCount (affected installs), first and last seen, and
`assignedTo`. Add the link (`https://kangentic.sentry.io/issues/<id>/`), and the release breakdown
(`sentry api` on `/tags/release/`) for any issue you will report. When the CLI is unavailable, this
raw query is the fallback:

```
GET /api/0/organizations/kangentic/issues/?project=4511996066660352&query=is:unresolved is:for_review&statsPeriod=14d&sort=date
```

Either way, assignment and the board search decide what counts as new. Two filters keep the
report honest:

- Treat `environment: development` events as dev/preview noise (the
  `Kangentic telemetry verification:` issues are the rig's own test errors) - list them
  separately or not at all, never alongside production issues without saying so.
- "New" means new to the user: an **unassigned** issue whose shortId appears in no board task.
  Assignment is the triage marker (see below), so start the sweep by reading `assignedTo` on
  each issue and treat an assigned one as already looked at. Still confirm with
  `kangentic_search_tasks` for the shortId, because assignment can be stale and a task can
  exist without one, but an assigned issue is never reported as new.

**Then file the actionable issues as board tasks, grouped.** A sweep ends on the board, not in a
report the user has to turn into tasks by hand, so file without a separate ask unless the user
said to only list or only diagnose. Diagnose each candidate first (below): what gets filed is a
fix with a known throw site or a concrete lead, never "look into X". The user runs these tasks in
parallel worktrees and prefers fewer, larger ones, so:

- **Group by the files the fix touches.** Issues whose fixes land in the same files go in one
  task even when their mechanisms differ: DESKTOP-1G's leaked xterm listener and DESKTOP-1J/1K's
  zero-width WebGL atlas share the terminal lifecycle files, so they were one task. Two worktrees
  editing the same files conflict at merge, which costs more than one larger task.
- **Split only where the files are disjoint.** That is the one reason for a second task. Issue
  count, severity, and subsystem name are not.
- **Make each task self-contained.** Parallel agents share no context, so each description
  carries its own diagnosis, evidence, the fields listed under the next request, and a "Done
  when" naming the red-green test that proves the fix.
- **Title a grouped task by its shared cause:** `Fix DESKTOP-A, DESKTOP-B: <what they share>`.
- **Priority follows impact.** Escalating, many installs, or user-visible first; one event on
  one install with no visible effect last.
- **Do not file what has no fix in this repo.** Host resource exhaustion, an upstream Chromium or
  Electron fault, a third party's build, and an issue an unreleased change already addresses
  each get one line in the report with the reason, and no task. They stay unassigned (see the
  assignment rules below), so offer to archive them in Sentry and do it only on the user's OK.

Close the sweep with the filed tasks (number, title, priority, and the files each touches, which
is what shows the set is safe to run at once), the issues not filed and why, and any recurrence
of an assigned issue on the newest release.

**"Investigate this issue / create a follow-up task."** Retrieve the issue and latest event,
diagnose (below), then - when asked for a task - create ONE task via the kangentic MCP tools,
routed by project: a DESKTOP-* issue goes on the `kangentic` board; a MOBILE-* issue (or a
REACT-NATIVE-* one - issues created before the 2026-08 slug rename keep their old prefix) on
`kangentic-mobile`. First search for an existing task carrying the shortId so a re-report never
duplicates. Title: `Fix DESKTOP-N: <issue title, trimmed>`. Description: the Sentry link,
shortId, level, event/affected-install counts, environment + release, the diagnosis, and the
few stack frames or tags that carry it. Default to To Do; the user decides when it spawns.

Three fields belong in that description because leaving them out is what sends the next
investigation down a wrong path:

- **The frame count, and whether the stack is truncated** (see Diagnosis). "50 frames, truncated,
  no app frame survived" and "47 frames, genuinely all third-party" call for completely different
  work, and the event itself does not say which.
- **The release-to-dependency-version mapping** for whatever library the stack lands in, read
  from `package.json` at each affected release's tag. It is what tells the next reader whether a
  version bump is a suspect or already ruled out.
- **Whether the event count is distinct incidents or paired reports**, and any non-default setting
  the path requires.

Never paste a stack frame's raw `file:///` URL or `absPath` into the task: those carry a
contributor's home directory, and the board is mirrored to a public repo. Cite frames by module
path and line (`viewModelImpl.js:145`).

**Then assign every issue the task covers.** Creating a board task and leaving the Sentry issue
unassigned means the next sweep re-derives the whole cross-reference from scratch, which is what
assignment exists to prevent here. Assignment is a triage marker, not a claim of ownership: it
says a human has looked at this and it has a home. Send the PUT from Retrieval once per issue; each
call touches one issue. Rules:

- Assign after the task is created, never before, so a failed create cannot leave a false marker.
- One task can cover several issues (a cluster, or several issues that resolve in one file).
  Assign all of them, not just the one that named the task.
- Assign issues covered by an EXISTING task too when a sweep turns one up unassigned. The signal
  is only useful if it is complete.
- Never assign an issue with no board task, and never assign dev/preview rig noise. An unassigned
  issue must keep meaning "nobody has dealt with this".
- Resolve nothing here. Assignment leaves the issue in the unresolved stream where a recurrence
  is still visible, which is the whole point: a fix that does not hold shows up as new events on
  an assigned issue rather than disappearing. A native crash is the exception, because a shifted
  stack re-groups into a fresh shortId and the assigned issue stays silent (see Native minidumps
  above). Assignment holds until the fix actually ships, so resolution is a release-time act, not
  a triage one. See Resolution markers below.

## Resolution markers

Resolution is a release-time act. The marker names the release that CARRIES THE FIX, never the one
the issue was last seen on. Which release that is depends on where you are standing. From triage,
before the fix has shipped, the newest release is always the wrong answer, because it predates the
fix. From `/release` Step 8, after the build is published, the version just shipped is the carrier
and is the right answer. Step 8 is where this normally happens; do it by hand only to correct a
marker that is already wrong.

Sentry keeps two resolution types, and they reopen an issue on different events:

- `in_release` against X: an event on X itself reopens the issue, and only releases older than X
  stay suppressed. Naming the current release therefore reopens the issue on exactly the builds
  that legitimately lack the fix.
- `in_next_release` against X: events on X and older stay suppressed, and anything newer reopens.
  That is what "fixed in the release after X" means.

Which body to send:

| Situation | Body of the resolve PUT |
|---|---|
| The release carrying the fix exists in Sentry | `{"status":"resolved","statusDetails":{"inRelease":"Kangentic@X.Y.Z"}}` |
| It does not exist yet (the normal case before that release builds) | `{"status":"resolved","statusDetails":{"inNextRelease":true}}` |

Use the `Kangentic@X.Y.Z` form, not the `vX.Y.Z` git tag. Each release object is created by the
bundler plugin during its own CI build (`scripts/build.js`, `vite.config.mts`), so the version a
pending fix will ship in does not exist yet, and `inRelease` on it fails with a 400 and
"Unable to find a release with the given version."

Four things bite:

1. **A resolve PUT against an already-resolved issue is silently a no-op.** It returns 200 with the
   full group payload and changes nothing. To correct a marker, PUT `{"status":"unresolved"}`
   first, then PUT the resolution. Both writes, in that order, every time.
2. **The read-back cannot tell the two types apart.** `statusDetails` renders
   `inRelease: Kangentic@0.39.0` both for a real `in_release` against 0.39.0 and for an
   `in_next_release` recorded against it, so it cannot confirm a write landed. Verify with the
   issue payload's own `activity` array: the newest `set_resolved_in_release` entry carries a
   populated `version` for an in-release resolution, and an empty `version` plus
   `current_release_version` for an in-next-release one.
3. **The GitHub integration resolves issues without being asked.** Merging a PR whose body names a
   shortId writes a `set_resolved_in_pull_request` entry, and commit-to-release association can
   follow it with a `set_resolved_in_release` naming whichever release was current then. DESKTOP-J
   carried a wrong marker from that path, not from a hand action. So expect an issue to arrive at
   the release step already resolved, and correct it rather than assuming a human chose it.
4. **A 403 on the resolve PUT means the token is read-only or CI-scoped.** Report which issues went
   unmarked and carry on. Never retry in a loop, and never let it block a release.

## Boundaries

- Diagnose and report; fix only when the task asks for a fix.
- A triage sweep files its actionable issues as grouped board tasks without a separate ask
  (see Typical requests), unless the user asked only to list or diagnose. A single-issue
  investigation files a task only when asked. Either way the description carries the Sentry
  link, shortId, affected-install count, and your diagnosis.
- Assigning an issue you just filed a task for is sanctioned and expected, no separate ask
  needed. It is the one write this skill makes on its own.
- Do not resolve/archive issues in Sentry unless explicitly asked (needs `event:write`). Resolving
  belongs to `/release` Step 8, which marks the issues a release fixes once that release exists;
  from here, resolve only to correct a marker that names the wrong release. Either way follow
  Resolution markers above.
- Never paste the token or a full raw event dump into a task, commit, or reply; quote the
  frames and fields that carry the diagnosis.
