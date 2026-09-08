---
description: Investigate a Sentry issue - retrieve the issue, latest event, stack trace, tags, and breadcrumbs from kangentic.sentry.io and diagnose it. Use when a task or the user says to investigate/look at/diagnose a Sentry issue or link, or to check what errors are arriving.
---

# Sentry

Retrieve and diagnose issues from the `kangentic` Sentry org (`kangentic.sentry.io`). Two
projects live there: `desktop` (this Electron app, numeric id `4511996066660352`) and `mobile`
(the React Native app, numeric id `4511808149651456`). Desktop error reporting is wired in
`src/main/analytics/error-reporting.ts`; docs/analytics.md ("Error Reporting") describes what
gets captured and how.

## Auth (never print the token)

Requests need a bearer token. Resolution order (Kangentic-scoped on purpose, so another
repo's generic `SENTRY_AUTH_TOKEN` is never picked up by mistake):

1. `KANGENTIC_SENTRY_TOKEN` environment variable, if set.
2. On Windows, the User-level registry value for the same name (covers a process tree started
   before the variable was set): `[Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User')`.
3. The `token = ...` line in `~/.sentryclirc` (usually the CI upload token; reads 403 on it).

Read the token into a shell variable and pass it as a header in the SAME command; never echo
it, never write it to a file, never include it in a reply.

A persisted token doubles as a build switch: `scripts/build.js` and `vite.config.mts` activate
release sourcemap upload whenever `KANGENTIC_SENTRY_TOKEN` (or `SENTRY_AUTH_TOKEN`) is present
at build time. A Windows User-level value survives into every later `npm run build`, so store
the token that way only if local production builds attempting an upload is acceptable;
otherwise set it per-session. A local build that uploads writes real artifact bundles to the
`desktop` project under `Kangentic@<version>`, which is harmless (Sentry matches by debug id, so
bundles from a build nobody shipped simply go unused) but is not nothing.

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

PowerShell pattern (one call per request; substitute the endpoint):

```powershell
$token = $env:KANGENTIC_SENTRY_TOKEN; if (-not $token) { $token = [Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User') }; if (-not $token) { $token = ((Get-Content "$env:USERPROFILE\.sentryclirc") | Where-Object { $_ -match '^token\s*=' }) -replace '^token\s*=\s*','' }; Invoke-RestMethod -Uri 'https://sentry.io/api/0/organizations/kangentic/issues/<ISSUE_ID>/' -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
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
| Org members (read `user.id` for the actor above) | `GET /api/0/organizations/kangentic/members/` |

The latest-event payload is large; extract what you need rather than dumping it: `entries`
with `type: "exception"` carries the stack frames, `type: "breadcrumbs"` the trail, `tags`
carries `source`/`reason` (stamped by `reportHandledError` for handled forwards), release,
environment, and the anonymous install id under `user.id` (non-reversible; `userCount` on the
issue = affected installs).

## Diagnosis

- **Mechanism first.** `mechanism` on the exception says how it was caught: `onunhandledrejection`
  / `onerror` (renderer globals), `generic` via `captureException` (a boundary or
  `reportHandledError` - check the `source` tag: `updater`, `pty_spawn`, `spawn`, `global_db_read`,
  `utility_process`). A `utility_process` event carries a `utility_process` context block under
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
- **Cross-reference locally:** the same failure usually has a local trail - `.kangentic/logs/`
  (crash JSONs, main console), `kangentic_tail_logs`, and the Aptabase `app_error` /
  `spawn_failed` counts are the volume view of the same signal.

## Native minidumps (`platform: native`, mechanism `minidump`)

A native crash's frames arrive as raw addresses with `function: null` for any module Sentry has
no debug file for (node-pty's `conpty.node` / `pty.node`, `better_sqlite3.node`). They can still
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
  `crashed_version`, `uploaded_by_version`, `main_module`, `found_at_startup`, and whether the
  release or the app context was corrected. Its absence dates the event to before that filter
  shipped, so the two traps below still apply to it in full.
- **On an older event, the release tag is the UPLOADING build's, not the crashed one's.**
  Crashpad writes the dump and the next launch uploads it; if the user upgraded in between, the
  tag is a build that never crashed. `contexts.crashpad._version` is the build that did.
  DESKTOP-M cost a triage sweep a wrong conclusion this way.
- **Breadcrumbs on a startup-found dump are not the crashed session's.** On an older event they
  are the uploading launch's, wholly or partly; on a corrected one they are removed rather than
  left to mislead. Breadcrumbs on an event tagged `exit.reason` are trustworthy: that tag marks
  the two SDK paths that report a crash the running session watched happen.
- **A crash in a process Kangentic merely spawned no longer arrives at all.** On macOS, mach
  exception ports are inherited across exec, so an agent shelling out to ffmpeg or a headless
  browser used to file its crashes as ours (DESKTOP-K, DESKTOP-N). Those are dropped before
  upload now and counted as Aptabase `foreign_minidump_dropped` instead. If a native issue looks
  like someone else's binary, check that counter rather than expecting a Sentry issue.
- **Scope persists with a 500 ms write throttle**, so on any event the last half-second of
  breadcrumbs before the crash is missing. An entire quit sequence fits in that gap.

## Typical requests

**"Any new issues?" (triage scan).** Query each project (or the one named) for what needs
eyes, newest first:

```
GET /api/0/organizations/kangentic/issues/?project=4511996066660352&query=is:unresolved is:for_review&statsPeriod=14d&sort=date
```

Run it for both project ids unless the user scoped to one. Report a compact per-issue line:
shortId, title, count, userCount (affected installs), firstSeen, environment, and the link
(`https://kangentic.sentry.io/issues/<id>/`). Two filters keep the report honest:

- Treat `environment: development` events as dev/preview noise (the
  `Kangentic telemetry verification:` issues are the rig's own test errors) - list them
  separately or not at all, never alongside production issues without saying so.
- "New" means new to the user: an **unassigned** issue whose shortId appears in no board task.
  Assignment is the triage marker (see below), so start the sweep by reading `assignedTo` on
  each issue and treat an assigned one as already looked at. Still confirm with
  `kangentic_search_tasks` for the shortId, because assignment can be stale and a task can
  exist without one, but an assigned issue is never reported as new.

**"Investigate this issue / create a follow-up task."** Retrieve the issue and latest event,
diagnose (below), then - when asked for a task - create ONE task via the kangentic MCP tools,
routed by project: a DESKTOP-* issue goes on the `kangentic` board; a MOBILE-* issue (or a
REACT-NATIVE-* one - issues created before the 2026-08 slug rename keep their old prefix) on
`kangentic-mobile`. First search for an existing task carrying the shortId so a re-report never
duplicates. Title: `Fix DESKTOP-N: <issue title, trimmed>`. Description: the Sentry link,
shortId, level, event/affected-install counts, environment + release, the diagnosis, and the
few stack frames or tags that carry it. Default to To Do; the user decides when it spawns.

**Then assign every issue the task covers.** Creating a board task and leaving the Sentry issue
unassigned means the next sweep re-derives the whole cross-reference from scratch, which is what
assignment exists to prevent here. Assignment is a triage marker, not a claim of ownership: it
says a human has looked at this and it has a home. Rules:

- Assign after the task is created, never before, so a failed create cannot leave a false marker.
- One task can cover several issues (a cluster, or several issues that resolve in one file).
  Assign all of them, not just the one that named the task.
- Assign issues covered by an EXISTING task too when a sweep turns one up unassigned. The signal
  is only useful if it is complete.
- Never assign an issue with no board task, and never assign dev/preview rig noise. An unassigned
  issue must keep meaning "nobody has dealt with this".
- Resolve nothing. Assignment leaves the issue in the unresolved stream where a recurrence is
  still visible, which is the whole point: a fix that does not hold shows up as new events on an
  assigned issue rather than disappearing.

## Boundaries

- Diagnose and report; fix only when the task asks for a fix.
- Create a follow-up board task only when asked ("create a follow up task" style requests):
  include the Sentry link, shortId, affected-install count, and your diagnosis in the
  description.
- Assigning an issue you just filed a task for is sanctioned and expected, no separate ask
  needed. It is the one write this skill makes on its own.
- Do not resolve/archive issues in Sentry unless explicitly asked (needs `event:write`).
- Never paste the token or a full raw event dump into a task, commit, or reply; quote the
  frames and fields that carry the diagnosis.
