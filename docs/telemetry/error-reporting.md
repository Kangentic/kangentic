---
type: Reference
title: Error reporting (Sentry)
description: "How Sentry runs in main and the renderer: path scrubbing, ignoreErrors filters, the console breadcrumb tag allowlist, the handled-failure chokepoints and their sources, error boundaries, foreign native crash handling, errors counted instead of reported (updater, GPU, workers), the GPU escalation report, and sourcemap and debug file upload."
tags: [sentry, crashes, breadcrumbs, scrubbing]
sources:
  - resource: src/main/analytics/error-reporting.ts
  - resource: src/main/artifacts/artifact-domain-report.ts
  - resource: src/renderer/error-reporting.ts
  - resource: src/shared/sentry-data-collection.ts
  - resource: src/shared/sentry-breadcrumbs.ts
  - resource: src/main/analytics/redact-event-paths.ts
  - resource: src/main/shared/project-roots.ts
  - resource: src/main/db/repositories/project-repository.ts
  - resource: src/main/config/write-failure-notice.ts
  - resource: src/main/config/data-dir-failure.ts
  - resource: src/main/analytics/native-crash-event.ts
  - resource: src/main/diagnostics/host-memory.ts
  - resource: src/main/analytics/reportable-module-name.ts
  - resource: src/main/analytics/renderer-classification.ts
  - resource: src/main/utility-process/stderr-tail.ts
  - resource: src/main/utility-process/event-loop-watchdog.ts
  - resource: src/shared/benign-renderer-errors.ts
  - resource: src/renderer/monaco-error-funnel.ts
  - resource: src/main/diagnostics/gpu-health.ts
  - resource: src/main/updater.ts
  - resource: src/main/updater-mac-signing.ts
  - resource: src/shared/apple-team-id.json
  - resource: build/verify-signed-team-id.js
  - resource: src/main/pty/agent-launch-report.ts
  - resource: src/main/pty/launch-output-class.ts
  - resource: src/main/pty/abandoned-launches.ts
  - resource: src/main/quit-cause.ts
  - resource: src/main/git/worktree-errors.ts
  - resource: src/main/git/git-command-error.ts
  - resource: src/main/retrieval/vec-load-cause.ts
  - resource: src/main/retrieval/worker/checkpoint-labels.ts
  - resource: src/main/accounts/account-report.ts
  - resource: src/main/agent/shared/cli-version-tag.ts
  - resource: src/main/utility-process/off-main-exec.ts
  - resource: src/main/pty/spawn/agent-start-refused.ts
  - resource: src/main/pty/lifecycle/session-id-manager.ts
  - resource: src/main/git/spawn-with-abort.ts
  - resource: src/main/agent/shared/cli-identity.ts
  - resource: scripts/sentry-upload-gate.js
  - resource: src/main/analytics/handled-report.ts
  - resource: src/main/browser/wake-clock.ts
  - resource: src/main/browser/display-server.ts
  - resource: src/main/browser/cpu-speed-limit.ts
  - resource: src/main/analytics/ipc-handler-report.ts
  - resource: src/shared/handled-error-copy.ts
  - resource: src/shared/ipc-rejection.ts
  - resource: src/shared/refusal.ts
  - resource: src/main/agent/mcp-http/tool-reporting.ts
  - resource: src/main/ipc/helpers/recovery-report.ts
  - resource: src/main/ipc/helpers/spawn-failure.ts
  - resource: src/main/pty/host/pty-host-report.ts
  - resource: src/main/pty/host/host-handled-error.ts
  - resource: src/main/pr/pr-report.ts
  - resource: src/renderer/utils/renderer-failure.ts
  - resource: src/renderer/components/layout/SurfaceBoundary.tsx
  - resource: src/preload/push-callback-guard.ts
  - resource: src/main/diagnostics/push-callback-report.ts
  - resource: src/shared/reported-failure-marker.ts
  - resource: src/renderer/lib/ipc-error.ts
  - resource: src/main/analytics/crash-notice.ts
  - resource: src/renderer/utils/crash-notice.ts
---
# Error reporting (Sentry)

Crash and error monitoring is separate from product analytics: Aptabase's `app_error` stays as a
coarse error-rate pulse on the product dashboard, while Sentry (`@sentry/electron`) provides
grouping, deduplication, symbolicated stack traces, and alerting. Desktop and mobile issues land
in one Sentry org, one triage surface.

## Initialization and scrubbing

- **Initialization** (`src/main/analytics/error-reporting.ts`): the SDK initializes in the main
  process (next to `initAnalytics`, before app-ready) and in the renderer
  (`src/renderer/error-reporting.ts`). The renderer SDK has no network path of its own - every
  renderer event transports to the main process over the SDK's internal IPC, and main's
  offline-capable transport is the single point of egress. The renderer init is gated on a boot
  flag (`--kangentic-error-reporting` in `additionalArguments`) that mirrors main's single
  decision, so the two processes can never disagree.
- **Scrubbing is mostly the SDK's and Sentry's job, not custom code:** the SDK's default
  `normalizePathsIntegration` rewrites stack-frame paths and URLs relative to the app root (the
  user's home directory never reaches Sentry through an app stack frame; breadcrumbs are a separate
  path, below), `dataCollection` turns off everything the SDK would collect on its own, and
  Sentry's server-side data scrubbing is on by default. Sentry 8 replaced `sendDefaultPii` with
  `dataCollection` and collects every field it leaves out, so `src/shared/sentry-data-collection.ts`
  spells out all of them, off, and both processes pass it: no IP address, cookies, HTTP headers or
  bodies, query strings, local variables, or GraphQL, AI, database and queue payloads. Headers and
  bodies matter in main because the MCP HTTP server runs there, and an error raised while it handles
  a request would otherwise carry the request's token header and its tool arguments. Main also sets
  `attachStacktrace: false`, which Sentry 8 turned on: the SDK reports GPU and renderer process
  exits as messages, and a synthetic stack would group distinct exit reasons together instead of by
  message. Further scrubbing
  rules belong in the Sentry UI (Advanced Data Scrubbing), not in a
  `beforeSend` here. There are four exceptions, all done on the machine before anything is sent
  rather than as Sentry rules, the same shape as the dropped React component stack in [app_error sources](usage-analytics.md#app_error-sources). The utility
  worker's stderr tail (below) is free text, not a stack frame, and Node's `Require stack:` lines print
  absolute install paths under the user's profile, so `src/main/utility-process/stderr-tail.ts`
  replaces the home directory with `~` before the text goes anywhere. A foreign process's crash
  loses its dump, breadcrumbs and full module name in `beforeSend` (see "Native crashes in
  processes that are not ours" below). Every breadcrumb passes a policy before it is recorded
  (see "Breadcrumbs are filtered at the source" below). And `beforeSendEvent` rewrites every
  registered project root to `[project]`, then this machine's home directory to `~`, in every
  string of the event (`src/main/analytics/redact-event-paths.ts`): an exception message is free
  text that path normalization never touches, an OS username is often a real name, and a
  project's folder name can name a client or employer. Monaco's rethrown diff-editor error put
  about 48 home paths in one exception value. Project roots run first, longest first, so a
  project under the home directory loses its folder name too instead of becoming
  `~/projects/<name>`. A root inside the home directory also matches its `~`-relative spelling,
  because a worker's stderr tail is home-redacted before the event is built. Every character
  except letters, digits and `_.-` also matches its percent-encoded UTF-8 bytes, separators
  included (`%20`, `C%3A`, `%5C`), and a space also matches the `+` of a form-encoded query
  string, so a path inside a `file://` URL or a query string is caught too. The same pattern
  drives the home rewrite and the stderr tail's. The roots come from an in-memory ledger
  (`src/main/shared/project-roots.ts`), seeded from the global projects list at boot
  (`ProjectRepository.rememberRegisteredRoots`, which seeds nothing rather than throwing when
  that read fails) and fed by `ProjectRepository.create` and `updatePath`. It never drops a root
  during a run, so an error raised while a project is deleted or moved is still covered.
  `beforeSend` never reads the database, which can be closed or not yet open when an event fires.
  The ledger also remembers each project's repository folder, because git names it in its own
  errors (`<repository>/.git/index.lock`). That is the nearest folder at or above the project
  holding `.git`. For a `.git` file (a linked worktree or a submodule) it is the repository the
  file points into, read through the worktree's `commondir` file, so a worktree of a bare
  repository names the bare repository. That lookup is async and runs one project at a time, so
  a project on an unreachable network share holds one libuv thread rather than all of them. A root at or above the home directory, or at a
  drive root, is skipped and left to the home rewrite. Native crash events are the part this
  cannot reach (see "Native crash fields" below).

  Three folder names are user content wherever they sit, so the same pass rewrites them under
  any root, a root this process never registered included, after the root and home rewrites. A
  worktree folder is `slugify(task.title)-<id>`, so `.kangentic/worktrees/<folder>`,
  `.kangentic/removed-worktrees/<folder>` and `.kangentic/set-aside/<kind>/<name>` become
  `[worktree]`. Claude's transcript folder spells the whole project path, the username included,
  so `.claude/projects/<encoded>` becomes `[project]`. Both separators and their percent-encoded
  forms match. `redactEventText` runs the same rewrites on one string, for text a reporter
  captures before `beforeSend` (the utility worker's stderr tail).

## Filtering

- **Filtering is a different concern and does live in code,** in `ignoreErrors`. Scrubbing removes
  data from an event we keep; filtering decides a whole class of event is un-actionable and should
  never become an issue. Five classes are filtered:
  - Benign Windows stdio write artifacts, in two message shapes. Node's `errnoException` reads
    `write EAGAIN` / `write EPIPE` (the dev `npm start` TTY case) and is matched by those two
    string literals; libuv's `uvException` reads `EPIPE: broken pipe, write` (a packaged GUI
    build, which has no console) and is matched by the two regexes beside them. Neither literal
    matches the other shape, so both forms are listed.
  - Utility-process exits reported by the SDK's own `childProcessIntegration`
    (`'Utility' process exited with '<reason>'`). That event is tagged only with the process
    TYPE - `serviceName` / `name` / `exitCode` go into a breadcrumb added AFTER the capture, so it
    can never say which process died and no `beforeSend` could recover THAT event. Electron's internal
    utility processes (network, audio, storage) are not ours to fix, and Kangentic's own utility
    workers (embeddings, line count, dictation, retrieval, PTY host) report themselves (see
    `utility_process` below), where the service name and exit code are known. Scoped to `'Utility'` deliberately: renderer crashes come through the same
    integration as `'renderer' process exited with ...` and must keep reporting. The breadcrumb
    survives the filter, so an internal utility crash still shows as context on later events.
  - The same SDK integration's GPU variant, but scoped narrower than the Utility filter:
    `'GPU' process exited with 'abnormal-exit'` only, not every reason. A lone GPU death Chromium
    recovers from on its own (DESKTOP-15) is the same un-attributable noise as a utility exit, and
    Kangentic's own GPU health tracker now reports a repeated one (see "A GPU health escalation is
    reported once" below). `'launch-failed'` is left unfiltered. Through Electron 41 it never
    fired: the integration rides `child-process-gone`, and Electron 41 overrode no
    `BrowserChildProcessLaunchFailed`. Electron 44 does override it, so a GPU launch failure that
    Chromium survives now reaches this integration (measured on Linux, see `docs/platforms/gpu-failures.md`).
    The launch failure that ends in the fatal still does not, so DESKTOP-W's ladder is caught by the
    GPU health tracker, which on 44 records the survived failures as fault deaths as well as the
    fallback - see below. Once shutdown has begun, `beforeSend` drops the `launch-failed` message
    (`isQuitTimeGpuLaunchFailure` in `src/main/analytics/error-reporting.ts`). At quit the GPU
    process dies with the session, Chromium relaunches it, the launch fails, and Chromium aborts the
    browser for it, so the message only duplicates that native fatal. DESKTOP-2Q arrived at the
    same instant as a DESKTOP-W event, inside the PTY drain. The GPU health tracker marks a death
    after the quit began and counts it as no fault (DESKTOP-4T, see "A GPU health escalation is
    reported once"). `ignoreErrors` cannot hold this rule, because it cannot see whether
    the app is quitting.
  - The same integration's message for a Browser pane page's renderer,
    `'browser-guest' process exited with ...`. The page is the user's, not ours, and a pane page
    that actually crashes still arrives once, as the reduced native warning described under
    "A Browser pane page's crash becomes a warning without the page" below.
  - `BENIGN_RENDERER_ERRORS` (`src/shared/benign-renderer-errors.ts`) is spread in, so the one
    registry drives the monaco error funnel, the UI-test collector, and Sentry. Patterns there
    must stay unanchored: monaco re-throws as `message + '\n\n' + stack`.
- **One monaco error is reported as handled, with diff context.** Monaco catches an event
  listener's throw and hands it to its error funnel, whose default rethrows it on a timer. Sentry
  DESKTOP-19 ("Illegal value for lineNumber") arrived that way, as an uncaught error with no app
  frame. The funnel (`src/renderer/monaco-error-funnel.ts`) now sends it through
  `reportHandledRendererError` (`src/renderer/error-reporting.ts`) with `source:
  monaco_line_number`, and does not rethrow it. Two more tags make it searchable:
  `hide_unchanged_regions` (`true`, `false`, or `unknown` when no live viewer reports it) and
  `diff_viewers_live` (how many viewers had an editor). Each mounted diff viewer publishes a snapshot
  reader, and the funnel reads them at the moment of the throw. Each becomes a flat
  `diff_viewer_N` context: line counts, scroll metrics, visible line ranges, and the collapse and
  fold state. The funnel's own call stack becomes a `call_site` context. It is captured with a
  raised stack limit, so it holds the outer frames the original error's 50-frame stack lost. Each
  frame keeps only its file's base name, because a production location is a `file://` URL under
  the user's home directory, and the SDK's path normalization does not reach `contexts`. No file
  path or file content is sent. A stuck editor throws on every scroll tick, so the funnel sends at
  most one report per 30 seconds. It absorbs the rest without rethrowing them, and the next report
  carries their count in its `funnel` context (`suppressed_since_last_report`). Every other monaco
  error keeps monaco's default.

## Native and guest crashes

- **Native crash fields are scrubbed by a Sentry rule, not by the app.** A native crash's frames,
  module list and crashpad annotations are built on Sentry's servers from the minidump after
  upload, so `redact-event-paths.ts` never sees them. The `desktop` project carries an Advanced
  Data Scrubbing rule for them (Project Settings > Security & Privacy > Advanced Data Scrubbing),
  stored as this `relayPiiConfig`:

  ```json
  {"rules":{"0":{"type":"userpath","redaction":{"method":"replace","text":"[user]"}}},
   "applications":{"$string":["0"],"$frame.*":["0"],"debug_meta.images.*.code_file":["0"],
   "debug_meta.images.*.debug_file":["0"],"tags.*":["0"],"contexts.*.*":["0"]}}
  ```

  It was tested on 2026-10-03 against synthetic events carrying fake home paths in every place a
  real leak was measured, in a scratch project with a no-rule control. Sentry's ingest servers
  take about two minutes to pick up a changed rule, and events sent sooner can still see the old
  one. With the rule, these arrive scrubbed: exception values, breadcrumb messages, frame
  `abs_path`, the debug image `code_file` and `debug_file`, the crashpad annotations under
  `contexts` (`gpu-url-chunk` carried a `file://` URL under the home directory), tags and
  `extra`. `$string` alone is not enough, because frame, image and tag fields need their own
  selectors, and `$image.*` is not a valid selector (images take a path).
  - **Crashpad annotations also pass through the app.** For a dump it uploads, the SDK copies the
    dump's Crashpad annotations into `contexts.electron` as `crashpad.<key>` on this machine,
    before `beforeSend`, so `redact-event-paths.ts` rewrites the home directory and every
    registered project root in them as well.
    A `LOG(FATAL)` message lands there as `crashpad.LOG_FATAL`, including Electron 44.5's
    install-folder access check, whose message names the per-user install folder under the home
    directory (`tests/unit/redact-event-paths.test.ts` pins that case).
  - **What the rule cannot reach.** Frame `package` (the app's own install path under the user's
    home directory, 133 occurrences in one real Windows event) survived every selector tried:
    `$frame.*`, `$frame.package`, the full path, `$stacktrace.**` and `$exception.**`. The
    readable views (`sentry issue view`, the Sentry MCP) print frame file names, not `package`,
    so what remains is in raw JSON and the Sentry UI's package column. "Prevent Storing of IP
    Addresses" removes `user.ip_address`, but the city derived from the address stays in
    `user.geo`.
  - **New events only.** A rule never rewrites a stored event, so an event from before the rule
    keeps its paths until it ages out. The `desktop` project keeps events for 30 days: an event
    older than that is gone (its issue keeps the counts but shows no latest event), and a search
    sees no further back. The rule was applied on 2026-10-03, so no stored event predating it
    survives past early November 2026.
- **A Browser pane page's crash becomes a warning without the page.** A pane guest (and a popup
  it opened, and an offscreen lane) runs as Kangentic.exe, so its dump reads as ours, but its
  content is the user's page: the event's `contexts.electron.crashed_url` names it, and since
  Electron 42 a guest nearing
  its heap limit writes its JavaScript stack into a Crashpad annotation, which the SDK parses into
  exception frames. The SDK's `getRendererName` (`renderer-classification.ts`) names those
  renderers `browser-guest`. Each surface's webContents is marked when it is created and never
  unmarked, because the SDK asks only after the dump has settled, up to 5 s after the crash, and
  a surface closed by then would otherwise read as ours. `beforeSend` (`toBrowserGuestCrashWarning` in
  `native-crash-event.ts`) rewrites the event into a warning titled "A Browser pane page crashed",
  grouped by exit reason, with the exception, `crashed_url`, every `crashpad.*` annotation and the
  minidump removed. The exit reason and code, the versions and our own scope stay, so guest crash
  rates are still visible. The SDK's `'browser-guest' process exited with ...` message for an
  abnormal exit is dropped in `ignoreErrors`, like the Utility and GPU ones. A guest dump found
  only at the next startup has no WebContents to classify and stays an ordinary renderer crash.
  Our own windows get no name, and the SDK's live native-crash path turns that into
  `event.process: unknown` rather than `renderer`; `beforeSend` puts `renderer` back when the
  dump's `crashpad.process_type` annotation says renderer (`restoreOwnRendererProcessTag`).
- **Native crashes in processes that are not ours become one warning, and their dumps never
  upload.** This happens in `beforeSend` (`beforeSendEvent` -> `filterNativeCrashEvent`), the only
  hook that can see the minidump attachment. On macOS a task's mach exception ports are inherited
  across exec, so a process Kangentic starts writes ITS crashes into our Crashpad database and the
  SDK uploads them as ours. DESKTOP-K was Homebrew ffmpeg's `ffprobe` failing to start, ten fatal
  events; DESKTOP-N was a Puppeteer `chrome-headless-shell`; DESKTOP-Q was
  `/usr/local/share/dotnet/dotnet`, ten more. None loaded a single Kangentic image. DESKTOP-1D was
  another project's dev Electron Helper, killed mid-launch. It loaded Electron Framework like every
  Electron app does, but from that project's own `node_modules/electron/dist/Electron.app`. On
  Windows the leak is an environment variable instead: the browser process puts its handler's pipe
  name in `CHROME_CRASHPAD_PIPE_NAME`, a child that copied main's environment passed it on, and an
  Electron program a terminal started registered with our handler through it. The first Windows
  one reached the grouped issue (DESKTOP-1S) as `module: Code.exe`, crashed on 0.45.0.
  - **Telling them apart.** This class cannot go in `ignoreErrors`, which is the
    `eventFiltersIntegration` and matches only an event's message and its exception type and value:
    a minidump event has none of those, so the matcher sees an empty candidate list and does
    nothing. It also cannot key off the SDK's `event.process` tag, because that reads `unknown` for
    real macOS crashes too (DESKTOP-E is one). The discriminator is the dump's own loaded-image
    list, read from the attachment in `src/main/analytics/native-crash-event.ts`: a crash is foreign
    only when no image sits under the install root, matches the app executable's name, or is the
    Electron framework inside our own `Kangentic.app` bundle. An unpackaged run checks the install
    root alone, because its `Electron` executable and `Electron.app` bundle are names every dev
    Electron app shares. Every uncertain path keeps the event as ours, because a foreign crash that
    slips through is noise while a real crash misread as foreign loses its dump. One real crash does
    read as foreign on purpose: a helper crash from a bundle the user renamed and then moved between
    the crash and the upload, since nothing left in its image list names us.
  - **What a foreign crash sends.** It is still our defect, since our port leaked, so it is
    reported rather than dropped: level `warning` with a fixed fingerprint, so every one lands in the
    single issue "Foreign process crash reached Kangentic's crash database". Its minidump is removed
    from `hint.attachments` before the SDK builds the envelope, because the dump holds another
    program's memory. That is the second exception to "scrubbing is Sentry's job", next to the
    stderr tail, because no Sentry-side rule can scrub a file it has already received.
    `tests/unit/foreign-crash-real-client.test.ts` pins it against the real client. The event also
    loses the `event.process` and `exit.reason` tags and the dump's own `crashpad.*` annotations,
    all of which describe the wrong process, and its breadcrumbs. The breadcrumb policy (below)
    keeps the `SHELL_EXEC` command line out of the trail, but Node's `child_process` breadcrumb
    still carries the spawned file's name, and a dump found at startup can carry an older build's
    unfiltered trail, so either could name the very program the `module` tag withholds. It keeps a
    small `native_crash` context (crash time,
    whether the dump was found at startup, the uploading version), enough to tell the one-time tail
    of dumps written before an upgrade from what follows it.
  - **The `module` tag** names the crashing program only when an installer or a package manager put
    it where it crashed (`src/main/analytics/reportable-module-name.ts`): system directories,
    Homebrew, MacPorts, Nix, per-user toolchain directories such as `~/.cargo/bin` and
    `~/.local/bin`, the browsers Puppeteer and Playwright download, and any `node_modules`. Anything
    else reads `user-binary`, so the name of a user's own build output never leaves the machine. A
    bare file name is not enough on its own: 0.43.0 sent the names of one user's project test
    binaries. One gap is accepted: `cargo install --path .` and `go install ./...` put a user's own
    binary in `~/.cargo/bin` and `~/go/bin`, and `make install` puts one in `/usr/local`. All stay
    on the list, because the program behind most of the pre-change baseline lives in one of them.
  - **Where the port leaks now, and the before-and-after.** PTY children no longer inherit it: the
    packaged macOS app ships its own node-pty `spawn-helper`, which clears the task's exception
    ports before exec, and the four `child_process` shell launches (the login-shell probe,
    shortcuts, `run_script` automations, the post-worktree init script) run through it too. On
    Windows every child env Kangentic builds for a program it did not write drops the pipe-name
    variable (`src/main/shared/child-env.ts`; the pty host's own launches and a few fixed system
    tools are listed in `docs/platforms/windows.md`), so a program a terminal, an agent run, a script or a git
    hook starts finds no handler to register with. "PTY children and Crashpad's handler"
    in `docs/platforms/windows.md` covers both platforms and what each still leaves out. This check
    stays as the backstop for older builds, for an unpackaged macOS run with error reporting
    switched on (`npm start` keeps node-pty's stock helper), and for anything else started outside
    those paths. Earlier
    builds dropped these events and counted them as the Aptabase event `foreign_minidump_dropped`
    instead, with a bare-basename `module`. That counter is the "before": 33 events over 0.41.0 to
    0.43.0, all macOS, 27 of them from one command-line tool. The Sentry issue is the "after", so
    the comparison crosses from Aptabase to Sentry once. On a release with the change, expect a
    one-time tail from dumps written before the upgrade and uploaded at its first launch
    (`native_crash.crash_time` separates it), then only the residue.
- **A crash of ours while quitting groups apart from the same crash mid-run.** The rule for code
  defects is to leave grouping to the stack. The foreign-crash and Browser-guest warnings above
  replace the stack with a fixed fingerprint, and this is the only native crash that gets a client
  fingerprint and keeps its stack grouping. When
  `native_crash.quit_begun` is `true` (below), `correctNativeCrashEvent` sets the fingerprint
  `['{{ default }}', 'quit-begun']` (`QUIT_BEGUN_CRASH_FINGERPRINT` in `native-crash-event.ts`).
  `{{ default }}` keeps Sentry's own stack grouping, so a quit-time crash still groups by its
  frames, only apart from the same frames mid-run. Its level, stack and dump are unchanged: a
  quit-time crash in our own code is still a defect (DESKTOP-C, node-pty's exit callback after
  `node::Stop()`), so nothing is downgraded or dropped. A `quit_begun` that is `false` or absent
  sets no fingerprint, so a dump the run record cannot place stays with the mid-run issue.
  - **Why.** DESKTOP-W's `LOG(FATAL)` arrives two ways ([GPU process
    failures](../platforms/gpu-failures.md)). Mid-run it kills a working app. At a Linux quit the
    GPU's zygote can be gone first, every relaunch fails with exit code 1002 and the same fatal
    fires while the app is already closing. On 0.62.0 both events, and the 0.58.0 one from another
    install, read `quit_begun: true`, so a mid-run recurrence would have hidden among quit-time
    dumps. The foreign-crash warning's fixed fingerprint above is the precedent for deciding
    grouping on the client.
  - **What it costs.** The first quit-time fatal after the change opens a new issue with the same
    `HandleFatal` title. That issue is the quit-time half; DESKTOP-W from then on is the mid-run
    one. Existing events keep their grouping.
  - **How it is checked.** `tests/unit/native-crash-event.test.ts` pins which runs get the
    fingerprint, and `tests/unit/foreign-crash-real-client.test.ts` pins that the real client's
    envelope carries it in the same envelope as the `event.minidump` attachment. Sentry's native
    SDK docs use `{{ default }}` fingerprints, but nothing found says the server keeps a client
    fingerprint on an event whose stack it builds from an attached dump. The first quit-time
    fatal after release settles it: its event JSON shows the fingerprint and the issue it opened.
    If Sentry ignored it, the fallback is a `quit_begun` tag plus a project fingerprint rule
    `tags.quit_begun:true -> {{ default }}, quit-begun`, since a fingerprint rule cannot match a
    context.

## Tags, sessions and breadcrumbs

- **Tagging shares that hook, and runs before the split.** `beforeSend` is `beforeSendEvent`,
  which tags, delegates to `filterNativeCrashEvent`, and then rewrites project roots and the home
  directory in what is left (`redactEventPaths`). `tagTruncatedStack` sets
  `stack_truncated: 'true'` on any event whose parsed stack sits exactly on the SDK's 50-frame
  cap. The parser reads a V8 stack innermost-first and stops there, so a capped event has lost its
  OUTER frames - the app code that called into the library and the timer it ran under - and reads
  as a self-contained third-party failure with `in_app: false` everywhere. Sentry DESKTOP-19 is
  the case that earned the tag: six events, fifty monaco frames each, and no in-app frame. Two caps
  cut it. V8's 50-frame limit cut the original error's outer frames when monaco's listener threw,
  and the parser then cut the one frame of monaco's own rethrow. Those outer frames now arrive in
  the handled report's `call_site` context (see the monaco bullet above). The tag makes "no app
  frames survived" distinguishable from "no app frames" without counting by hand. Tagging is
  annotation, not filtering: it never drops an event.
- **Errors only:** release-health session tracking (the SDK's `MainProcessSession` integration,
  on by default) is filtered out, and tracing and session replay are never enabled.
- **Breadcrumbs are filtered at the source, in both processes.** Every event carries the trail
  of what happened before it: up to 100 breadcrumbs from main and 100 from the renderer. Nothing
  filtered them, and `normalizePathsIntegration` never touches them, so a sample of 23 production
  events carried home paths, agent command lines, task titles, column prompt text, branch names,
  project and file paths inside click selectors, and a Browser pane search URL.
  `filterBreadcrumb` (`src/shared/sentry-breadcrumbs.ts`) is now the `beforeBreadcrumb` in both
  processes. It has to be both: main adds a forwarded renderer crumb with `scope.addBreadcrumb`,
  which never calls main's hook. Dropping a crumb before it is added also keeps it out of the ring;
  on one event, `[agent-push]` debug lines had evicted every click. By category:
  - `console`: kept only under a tag in `CONSOLE_BREADCRUMB_TAGS` (`[AGENT-LAUNCH]`, `[UPDATER]`,
    `[electron-updater]`, `[SHUTDOWN]`, `[terminal-webgl]`, `[gpu]`, `[GPU-HEALTH]`, `[APP]`,
    `[pty-host]`, `[utility-process]`) or
    Electron's own `Error occurred in handler for '<channel>'`, and never at debug level. A kept
    line is rebuilt from its arguments: the tagged string with paths redacted, each Error reduced
    to its name and code, numbers and booleans. A name that is not an identifier reads `Error`, and
    a code is kept only when it is an upper-case constant (`ENOENT`) or an integer. Other arguments
    and raw stacks go, because git and fs error text can hold a branch named after a task. `tests/unit/sentry-breadcrumbs.test.ts`
    parses every literal that opens with one of those tags and fails an interpolation that names
    user content (a title, a branch, a path, an error's text) unless the site carries
    `// breadcrumb-ok: <reason>`. A tag built at runtime (`[${label}]`) is invisible to that scan;
    none resolves to an allowlisted tag today.
  - `ui.click` / `ui.input`: the selector stays, but `title`, `aria-label`, `name` and `alt` lose
    their values (`[title]`), and `type` keeps its value. A crumb with any other quoted value left
    is dropped.
  - `electron`: the lifecycle message and the webContents id stay. A URL stays only when it is the
    app's own `app:///` page, without its query. `powerMonitor.speed-limit-change` is never
    recorded. Main replaces the SDK's Electron breadcrumbs integration with one whose
    `powerMonitor` option skips it (`keepPowerMonitorBreadcrumb`), so the crumb is never built and
    takes no slot. On a CPU the OS keeps throttling it fires every 1 to 2 s, and on Sentry
    DESKTOP-46's 0.62.0 event about 100 of them were the whole of main's trail. The latest limit
    rides that report as `cpu_speed_limit` instead (the `browser_driver` bullet below). Every other
    power event (suspend, resume, lock and unlock, AC and battery) is kept.
    `tests/unit/sentry-power-monitor-breadcrumbs.test.ts` runs the installed integration against
    a real client's ring.
  - Request crumbs (`http`, `electron.net`, `fetch`, `xhr`): method and status stay. The URL stays
    only under a Kangentic prefix (our GitHub repository and release assets, Aptabase), without its
    query. Main's fetch also reaches the board adapters and the webhook automation, whose URLs can
    name an organization or hold a secret.
  - Node's `child_process`: the message is path-redacted and `spawnfile` keeps only its file name.
    Electron's `child-process` is kept whole.
  - `mobile-bridge.relay-dial`: one crumb per mobile relay dial attempt at its outcome, recorded by
    `addRelayDialBreadcrumb` (`src/main/analytics/error-reporting.ts`). It is rebuilt from three
    checked fields: `relay_dial_id` (16 lowercase hex characters), `stack` (a lowercase word such
    as `node` or `chromium`) and `outcome` (`opened`, `failed`, `timed_out`). Anything else on it,
    and a crumb with any field out of shape, is dropped. A dial id is random per attempt, not
    derived from the slot, and the relay's own log records the same id for about a week, so an
    event can be joined to the relay's record of a recent dial ([relay
    transport](../integrations/mobile-bridge/relay-transport.md)). A parked device recycles once a
    minute, so each paired device whose phone is away adds about one crumb a minute to the ring.
    That crumb stays: a returning phone lands on the recycled socket, and its `opened` crumb is
    the only record on a later event that names that dial.
  - Anything else, `sentry.event` and `navigation` included, is dropped, so a category a new SDK
    version adds stays out until someone decides otherwise.

  The filter fails closed, the opposite of `beforeSendEvent`: a throw drops the crumb. The
  `[SHUTDOWN] pty-drain:*` lines pass byte-identical. electron-updater's own lines, which carried
  the Squirrel and package-manager detail on past updater issues, go through a tagged logger in
  `src/main/updater.ts`, with its debug output kept out. That logger also strips every URL's query
  and fragment, because the policy keeps URLs in a console line and `AppUpdater` logs a failed
  download's whole stack, signed link included, before the app's own `error` listener runs. A
  suppressed failure would otherwise leave the link in the ring for the next event. Events uploaded
  before this change still carry the unfiltered trail.

## Handled errors and event context

- **One report is not an error: an unrecognised artifact domain** (`reportHandledMessage`, level
  `info`). A task keeps links to its designs and documents
  ([Artifacts](../integrations/artifacts.md)), and Kangentic recognises a fixed list of platforms.
  When a person or an agent adds a link that no platform pattern matches, main reports that link's
  domain so the list grows from what is used. That includes a page on a listed site that no pattern
  covers, such as a YouTube channel (`src/main/artifacts/artifact-domain-report.ts`). The event carries
  two tags, `artifact_domain` and `artifact_source` (`user` or `agent`; a publish adds only
  recognised links, so `publish` never reports), and is fingerprinted per
  domain, so Sentry holds one issue per site. The domain is the site the host belongs to, without a
  leading `www.`, and every label left of it collapsed to `*` (`collapseTenantLabels`):
  `acme.sharepoint.com` goes as `*.sharepoint.com`, because a tenant host names the customer's
  organization in its first label. A known two-label suffix (`co.uk`, `com.au`, ...) keeps three
  labels. A host that is already the site (`example.com`) goes as it is. Nothing else of the link is sent: no
  path, no query, no fragment, no name, no task. A host that only means something inside a private
  network is never sent (`isPrivateHost`: `localhost`, a bare name, an IP address, and the `.local`,
  `.localhost`, `.internal`, `.intranet`, `.lan`, `.home`, `.home.arpa`, `.corp`, `.test`,
  `.example` and `.invalid` suffixes). Each install reports a
  domain once and at most 100 domains, remembered in `analytics-usage.json`, and nothing is sent
  while error reporting is off. A company's own public domain can still name that company, which is
  the cost of this report, and why Settings > Privacy lists it under what is collected.
- **Boundary-caught errors** never reach the SDK's global handlers (React swallows them), so the
  one `createRoot` passes `onCaughtError` (`src/renderer/index.tsx`), which reports every catch
  once through `reportCaughtRenderError` (`source: react_boundary`). React hands it the boundary
  instance, whose `boundaryReportTags()` names it: `boundary` (`root`, `panel` or `diff`) and, for a
  panel, `panel`, the surface's English name. The component stack goes in a context: component
  names only, never props or text. No boundary reports from its own `componentDidCatch`, so a catch
  is one event. Each surface of the main window has its own boundary (`SurfaceBoundary`: the
  board, sidebar, title bar, terminal panel, backlog, status bar, settings, search and the Command
  Terminal layer), and so does each task window, so one throw no longer unmounts every terminal.
  `ErrorBoundary` and `PanelErrorBoundary` also keep the Aptabase funnel.
- **Handled failures report at their chokepoints**
  (`src/main/analytics/handled-report.ts`, rule `.claude/rules/error-reporting.md`). Each
  chokepoint holds a `createChokepointReporter(source)`, which sends a copy of the error whose
  message is `Handled <source> failure: <ErrorName>` over the original frames (`pathFreeCopy`),
  never `error.message`, a runtime error's included: V8 quotes the property it could not read and
  Node's `ERR_INVALID_ARG_*` quotes the value it got, either of which can be a title. Tags are `source`,
  `error_name`, `errno`, `syscall`, `git_cause` and `az_server_code` when the error carries them, and the chokepoint's own short enums.
  `git_cause` is what a failed git command refused on (below, with the launch report's worktree
  causes), and it is part of the latch key, because every git failure throws from one line.
  `az_server_code` is the Azure DevOps server code (`TF51005`) that refused an az call on the
  Import path, or `none` when az's answer carried no code. The import classifier in
  `boards/adapters/azure-devops/client.ts` reads it from az's stderr and keeps only the code, since
  the rest quotes the user's query and project. `azServerCodeOf` sends only a value of that shape.
  It is part of the latch key too. Most WIQL refusals carry no code, so `none` is common: Sentry
  DESKTOP-47's day-precision refusal had none. It skips what is
  not a defect (`isExpectedFailure`: shutdown, an abort, a `UserConfigurationError` or
  `RefusalError`, the named expected classes, a network errno, `fetch failed` with a network
  cause, a relay dial that never opened as `RelayDialError`), skips an error another reporter
  already sent (`markReported` and `isReported`, which reads one level of `cause`), latches once
  per key per run and stops after 25 keys. A relay dial is expected because undici fails a network
  error and a non-101 answer from the relay with the same fixed text, so the client cannot tell
  them apart. The relay watches its own health. Sentry DESKTOP-4G was Pair a device reporting
  that failure as a defect. An errno,
  libuv's Windows `UNKNOWN` or a `SQLITE_` failure is fingerprinted `['handled-env', name, code]`;
  a code defect keeps Sentry's stack grouping. The sources:
  - `ipc_handler`: every `ipcMain.handle` handler, wrapped once at install
    (`src/main/analytics/ipc-handler-report.ts`, before `installDiagnostics`). The renderer's copy
    of the same rejection (`Error invoking remote method '<channel>': ...`) is dropped by main's
    `ignoreErrors` (`IPC_REJECTION_DUPLICATE_PATTERN`), except `No handler registered for` and an
    uncloneable result, which only the renderer sees. The channel is never in a fingerprint. Its
    cap is 100 keys, not 25, because a defect past it would reach Sentry from neither process. An
    `ipcMain.on` listener is not wrapped: it has no caller to reject to, so its throw is uncaught
    and Sentry's own handler reports it. When the error's report reached Sentry in this run (see
    What the user sees below), the wrap rethrows a copy whose message ends in
    `REPORTED_FAILURE_MARKER`, leaving the original untouched for anything else that holds it; the
    marker is a suffix, so `IPC_REJECTION_DUPLICATE_PATTERN` still matches the renderer's copy.
  - `mcp_tool`, `mcp_command`, `mcp_request`: a tool callback (tag `tool`), a command handler and
    the HTTP request layer of the MCP server (`src/main/agent/mcp-http/tool-reporting.ts`). A
    `mcp_command` report from a workflow reply carries `command` (`save_workflow`,
    `add_workflow_task` or `start_workflow`) and `stage` `reply_clause`: the plan approval clause read
    after a committed write threw, so the write stands and the reply omits the clause.
  - `automation_runner` reports a row's error once its retries are spent, and only a defect: an
    adapter's classified outcome (`AutomationRetryableError`, `AutomationPermanentError`,
    `AutomationTimeoutError`) is the user's endpoint or script answering. A Run script row whose
    script exits non-zero throws the permanent one, so it is a failed run in the run log and no
    event (Sentry DESKTOP-49 was every such script reported as a defect). A row a move stopped
    rejects an error named `AbortError` whose cause is the move's reason. The runner closes the run
    `interrupted` and rethrows it. The `turn_end` pass catches the rethrow and skips it. Sentry
    DESKTOP-4X was a Run script a move stopped, rejected as a plain `Error` and reported as a
    defect. The runner rethrows whatever the row threw, so a `TypeError` that lands during the
    move still reports.
  - `mobile_verb` (tag `verb`, plus `relay_dial_id`), `automation_runner` (tag `automation_type`), `turn_end`,
    `workflow_engine` (tag `stage`), `pr` (tag `stage`), `browser_driver` (tag `kind`, built-in
    classes and the attach, capture and composite failures only), `browser_passkey_guard` (tag
    `surface`: `lane`, `drive` or `created`, for a virtual passkey authenticator a guest refused;
    `src/main/browser/passkey-guard.ts`, no new data class). A `ScreenshotNotComposited`
    report also carries eight fixed tags, so it can say why the capture got no frame (Sentry
    DESKTOP-46, a timeout 18 s after an unlock that could not say whether the capture hold armed):
    `surface` (`pane`, `hidden`, `parked`, `popout`, `lane`), `host_window` (`visible`,
    `minimized`, `hidden`, `none`) and `hold` (`armed`, `skipped_hidden`, `no_host`), both read
    when the capture started, `host_hold` and `guest_hold` (`settled`, `none`), and `since_wake`
    (`none`, `under_30s`, `under_2m`, `under_10m`, `over_10m`), the time since the last
    `unlock-screen` or `resume` (`src/main/browser/wake-clock.ts`). `host_hold` and `guest_hold`
    are read when the capture times out, not when it starts. Each says whether any of the hold's
    own `capturePage` calls on that side had returned by then. They came after DESKTOP-46's 0.60.0
    event armed the hold on a visible host and still got no frame: `host_hold: none` means the
    host compositor stopped answering, and `settled` on both means the hold was answered and CDP's
    capture hung anyway. They mean something only with `hold: armed`. A hold that never armed
    reports `none` on both. The seventh, `display_server` (`x11`, `wayland`, `other`), names the
    display server Chromium draws to, read from Electron's own `--ozone-platform` switch and never
    from an env value (`src/main/browser/display-server.ts`). It is `other` off Linux and for any
    other backend. It came after two 0.61.0 events from one Debian install timed out on a parked
    pane. On Wayland a minimized app still reads `host_window: visible`, so `host_window` alone
    cannot say whether the app was on screen. The eighth, `cpu_speed_limit` (`100`, `75-99`,
    `50-74`, `<50`, `unknown`), is the latest CPU speed limit the OS advertised through
    powerMonitor's `speed-limit-change`, in percent, bucketed
    (`src/main/browser/cpu-speed-limit.ts`). Electron emits that event on Windows and macOS only,
    so Linux always reads `unknown`, and so does a run whose limit never changed. `unknown` never
    means unthrottled. It came after the 0.62.0 Windows event, whose trail was about 100
    `speed-limit-change` crumbs, one every 1 to 2 s, that filled main's ring and evicted every
    other crumb (see the breadcrumbs section). None is a new data class: the `electron`
    breadcrumbs already carry power events and window focus with their timestamps (the
    speed-limit crumb included, until this change), the two hold tags describe Kangentic's own
    calls, and the display server and the speed-limit bucket are few-value facts about the
    machine, the same class as `host_window`. A `CaptureExceedsSurface` report carries five, so it
    can say what the refused request looked like (Sentry DESKTOP-48, a refusal that could not say which of the
    bound's inputs was wrong): `surface` as above, `target` (`viewport`, `full_page`, `element`),
    `clipped` (`yes`, `no`), `emulated` (`yes`, `no`, and `unknown` when no CDP session was
    attached to say) and `widget_size` (`reported`, or `fallback` when the host window stood in
    for a pane that had not reported its size). They describe Kangentic's own request and hold no
    size, selector or page content, so they are not a new data class either. A plain viewport
    capture with no override that comes back larger than the recorded pane is returned, not
    refused, and reports nothing. The error's `detail` is never sent. The latch keys on tags, so
    each combination reports once per run, and those reports count toward the source's 25-key
    cap.
  - A `mobile_verb` report's `relay_dial_id` is the random id of the relay dial the request
    arrived on, so the event can be joined to the relay's log of that dial. It goes in as a
    `correlationTags` entry, which is sent but kept out of the latch key. In the key, one defect
    would report again on every dial until the cap was spent.
  - `task_move` (a rollback that failed), `exit_message_carry` (an exit message held for a
    restarted agent whose hold or run-detail write threw; tag `stage`: `hold`, `record`), `project_recovery` (tag `pass`: `resource_cleanup`,
    `session_recovery`, `session_reconcile`, `host_connected`, `cold_open`,
    `deferred_board_config`, `pty_host_loss`, `activate_project`, `remote_projects`), `db_open` and
    `db_migration` (tags `database`, `stage`: `open`, `pragma`, `migrate`, `initialize`), `held_messages`, `session_handlers` (tag `stage`),
    `session_transcript_path` (a write of the agent's reported transcript path to its session row
    that threw; tag `stage`: `status_line`, `session_start_hook`), `accounts`, `artifact_detection`, `metrics_snapshot`, `worktree_removal` (tags `profile`,
    `timed_out`, `holders`, `refused`, `platform`, `caller`, `path_class` and `syscall`, below), `preload` (our own windows only),
    `pop_out_load` (tags `kind`, `error_code`), `dictation`, `owner_turn` (the read of whether an
    agent's move came in a turn the owner started; the move still runs, as the agent's),
    `carried_owner_turn` (a write, carry or take of a turn a restart cut off, kept as a transcript
    position on its session row; the turn end then reads only its own turn, as before),
    `idle_pause_lift` (a workflow that could not be read while deciding whether an open or an
    owner's move lifts an idle pause, and the pause stays held; or the enter rows that run with the
    agent paused after `spawnAgent` declined that lift, which could not run at all).
  - `pty_host`: a fixed code the host relays as a `handledError` event (`root_pin`, `cli_pin`,
    `orphan_cleanup`, `pty_kill`, `transcript_flush`, `spawn_worker_fallback`, `uncaught`), and a
    heartbeat stall, once per run, fingerprinted `['pty-host', 'heartbeat-stall']`. The stall is
    sent when it ends, not at the 11 s threshold, because DESKTOP-43 could not tell a late answer
    from none. Its `outcome` tag is `answered` (with `answeredAfterMs`), `host_exited`,
    `no_answer` (no answer within the ping's 15 s budget) or `shutdown` (the app quit first).
    A beat whose 11 s threshold timer fired more than 60 s late, four times the ping's budget, is
    voided and sends nothing. The machine slept or main's own loop did not run, so the budget ran
    out with nothing watching the host (the 0.60.0 DESKTOP-43 event fired 15.7 h late). The
    wall-clock lateness decides it, not the wake clock, because a wake's overdue timers can run
    before the `resume` event arrives. A host that stays frozen is still reported by the next
    beat, whose timer fires on time. A beat whose threshold timer fired more than 5 s late
    reports only when the host's watchdog wrote a line during it. A timer that late means main's
    own loop did not run, and the watchdog prints once the host's loop is held 5 s, so a late beat
    with no line measured main, not the host (the 0.62.0 DESKTOP-43 event fired 18.7 s late with
    an empty stderr tail). The check counts every watchdog line the tail was given, so a trim of
    the 8 KB tail cannot hide a new one. It waits about a second after the beat ends, because main
    resumes with its overdue timers, the threshold and the ping's timeout, before it reads the
    line the host wrote during the hold. A quit inside that second decides at once and writes the
    stall to disk as below. An on-time beat with no answer still reports, line or not.
    Nothing sent from the quit path lands. So a `shutdown` stall is written to
    `pty-host-stall-at-quit.json` in the config directory, and the next launch reports it, as
    `abandoned-launches.ts` does. Its `pty_host` context lists the other requests in flight and
    `heldStep`. That is the host watchdog's line when one was written during this stall, and null
    when none was: main's own loop was held, or the watchdog never ran. Its
    `utility_process.stderrTail` is the host's stderr, redacted as a crash report's is.
  - `pty_host` also reports the first host crash of a run, fingerprinted
    `['utility-process-first-crash', service, cause]`, apart from the five-crash latch.
  - `retrieval`: the worker's reply carries the error's class and code, and a sqlite-vec load
    failure and an embeddings init failure each report once. A sqlite-vec load failure
    (`sqlite_vec_load`) also carries `load_cause`, the loader's reason as a fixed word (`not_found`,
    `bad_image`, `blocked_by_policy`, `access_denied`, `entry_point` or `other`), and
    `vec_file_exists` (`yes` or `no`). The worker reads both: the cause from SQLite's message
    (`src/main/retrieval/vec-load-cause.ts`), which is the operating system's own words. Neither
    the message nor the path leaves the worker, and main sends a cause outside the six words as
    `other`. Sentry DESKTOP-4Q carried only `SqliteError`. The
    message described the wrong file until the load dropped the extension's suffix
    (`withoutLibrarySuffix`): SQLite retries a failed load with the suffix appended and keeps the
    last error, so every failure read "module could not be found". On Windows, `not_found` with
    `vec_file_exists: yes` usually means a DLL the extension links against is missing. The
    fingerprint leaves the cause out, so the issue keeps grouping. Both are fixed words of the kind
    Settings > Privacy already discloses ("a fixed failure code"), so that list did not change.
    `vec_file_exists` says only whether Kangentic's own bundled extension file was at the path
    Kangentic resolved for it. It describes the install, not anything the user made or opened, so
    it is part of that failure code rather than a new data class.
  - `agent_session_id`: a session whose id no capture path found within 30 s of its spawn
    (`SessionIdManager`'s window), reported once its outcome is known, never at the window (Sentry
    DESKTOP-36 reported there and could not tell late from never). An id that arrives later sends
    `AgentSessionIdCapturedLateError` with `captured_after_s` (a seconds bucket, counted to when
    Kangentic noticed the id, so an upper bound: an id the suspend-time scrollback scan finds
    counts at the suspend), `after_prompt_s` (the same buckets from the agent's first prompt
    to the capture, or `none` when no prompt was seen), `after_output_s` (the same buckets from the
    agent's first visible output, the first text after the shell's handoff, to the capture, or
    `none` when the agent showed none) and `captured_by` (the path that finally
    delivered the id: `hook`, `status`, `output` for the live PTY stream, `scrollback` for the
    suspend-time scan, `filesystem`, `index` for a host's session index, or `unknown`). Sentry
    DESKTOP-4J, an Antigravity id minutes late, could not say whether the id came from a hook
    that fired late or only from the shutdown summary at a suspend. One late capture sends nothing: a session
    started with no opening prompt (`opening_prompt` `none`) whose first prompt came no more than
    30 s before the id, or within 2 s after it. Such an agent may have no conversation, and so no
    id, until someone types, so the capture window is counted from the prompt (Sentry DESKTOP-4C
    was a Codex terminal whose first prompt came minutes in). The id lands first because main
    reads a batch's ids ahead of its events, which is what the 2 s wait is for. A late id that came
    no more than 30 s after the agent's first visible output, or with it, sends nothing either, at
    any `opening_prompt`. An agent that prints nothing has no id to give, and no capture path is
    faster than its first line (Sentry DESKTOP-4W was a Cursor print run silent for a minute whose
    id came with its first stream line). An agent that drew early and gave its id late still
    reports. An id read from the output waits the same 2 s for that output to be noted, since the
    two come from one chunk in either order. The output skip logs a local `console.warn`, and an
    on-time capture does not spend the agent's one late report. A session removed
    with no id, or still without one five minutes after its spawn (a paused row is never removed),
    sends `AgentSessionIdNotCapturedError` with `settled_by` (`removed`, `ceiling`),
    `session_status` and `agent_ran_for_s`: a seconds bucket from the first sign the agent ran to
    the session's end, `not_run` when it never showed it ran, `running` when the session is still
    up at the ceiling, and `unknown` when the ceiling finds it no longer running with no exit
    recorded. A removed session whose agent ran always gets a bucket. An agent that
    exited seconds after it started had no conversation to capture, and one still running had one
    the capture missed (the DESKTOP-36 recurrence on 0.60.0 could not say which). The end is the
    PTY's exit, or the removal when that came first, so the bucket is an upper bound on the
    agent's own life: a shell outlives the CLI it ran, and the agent-absence sweep ends it later.
    Measured in a preview with Codex 0.163.0 under PowerShell: a signed-out Codex opens on its
    sign-in screen in the alt screen 2.7 s after the spawn, which counts as the agent having run,
    fires no hook and writes no session. Quit from that screen, its session was retired 82 s
    later. That is the shape of the DESKTOP-36 recurrence, and it is the user's setup, so it no
    longer reports: a never-captured session sends nothing when its CLI holds no login (`login`
    `signed_out`), its store is not `present`, and no prompt was seen. All three, because a CLI
    can answer "not logged in" and still work, on a key in its environment or a model provider
    of its own. That one takes prompts and writes its store, so its miss still reports, with
    `login` saying what the CLI answered. A late id needs only the first and last: signed out at
    the window and no prompt seen, whatever the store says. The late id already proves the
    conversation came after the window. That the delay is the sign-in is a reading of the event,
    not a measurement: DESKTOP-4C came back on 0.62.0 as a Codex with its prompt on the command
    line, signed out at the window, whose id came by the hook one to five minutes after the spawn,
    and Codex's source writes a conversation's file at its first persist. No signed-out run that
    then signed in has been timed. It costs a CLI that works signed out, sees no prompt and
    captures late its report. Codex's store used to be no help here, because it answered `present`
    whenever a rollout folder for today or yesterday existed, so an earlier run that day said
    nothing about this session. It now answers about this session (below), but a late id does not
    need it. The screen's own text is not what decides it: ConPTY
    draws that screen as cursor moves, which read as one run-on line, so
    `identifyUserSetupFailure`'s whole-line patterns cannot match it. A never-captured session
    whose agent died at start goes to the launch report instead, as stage `agent_exited` with
    cause `no_conversation`, carrying every tag below. All four must hold: it settled at the
    ceiling with its PTY exited on its own (`settled_by` `ceiling`, `session_status` `exited`),
    not by a removal and not by a `kill()` that kept its row (`intentionalExit`, such as the
    `cleanup_worktree` action's or a user's stop). The agent-absence sweep's retirement still
    counts: it ends a shell whose agent had already exited, and marks it with `overrideExitCode`
    0. Its agent ran and ended under 60 s later, counted in milliseconds; no prompt was seen;
    and its store is not `present`. Such a run had no conversation to capture.
    A terminal nobody used sends nothing either. A never-captured session started with no opening
    prompt (`opening_prompt` `none`), that no prompt reached (`prompt_seen` `no`), and whose store
    reads `absent`, had no conversation, so there was no id to capture. This is DESKTOP-36's
    shape on 0.62.0: a signed-in Codex Command Terminal, still running at the ceiling, with no
    hook line and `id_store` `present`. For Codex that `present` was the day's whole rollout
    folder. The store now answers about this session: `present` only for a rollout whose
    `session_meta` was made at or after the spawn less one second, in the session's cwd, with no
    upper bound on how late, and `absent` for a folder that holds only earlier runs. It is asked
    again when the session settles, not only at the window, because a conversation made after the
    window is no miss of ours. A read that fails reads `unknown`, or `present` when the window's
    read said `present`. Both report, so a stale `absent` is never carried over it. A session where someone typed and the hook was lost has a rollout and
    still reports. A death at start goes to the launch report first. That a Codex makes no
    conversation file until its first turn is Codex's source (a new session's file is created at
    its first persist), not yet a measurement on a signed-in run. Were it written at launch, an
    untouched terminal would read `present` and still report: the rule then does nothing, and
    never drops a real miss. A second Codex started later in the same folder can read as this
    session's, which only moves the answer toward `present`.
    The DESKTOP-36 events after the signed-out drop were one install's Codex 0.163.0 that ran
    with a command-line prompt, exited seconds in and wrote no rollout, on three days. As a
    missed id it hid among the real misses, and dropping it would lose the only sign that a
    launch dies at start. It is the session's one launch report, so a CLI that already named its
    startup failure sends nothing more, the launch report's key keeps it to one per agent per
    attempt each run (a retry that also dies at start sends its own), and it spends no capture
    report. Known gap: once an agent has spent both kinds this run,
    the window holds none of its sessions, so a later death at start sends nothing. Any other
    session with a login that misses its id stays in this report. Each kind reports once per
    agent per run, as its own issue. Both carry
    `agent_cli_version`, `start_path`, `shell`, `opening_prompt` (`command_line`, `typed`, `none`,
    or `unknown` where the spawn did not say), `create_chat` (how a fresh start got the id before
    launch: `ok`, or the CLI's miss, `failed`, `timeout` or `no_id`, from the adapter's
    `createSessionId`; `aborted` when the spawn stopped waiting for it; `not_asked` for a CLI that
    takes Kangentic's id, one that cannot create one, a run that reports its own, and a resume;
    `unknown` where the spawn did not say), `hook_seen`, `agent_started` and `first_output`
    (`yes`, `no`, at the window; `hook_seen` is a line the agent's own hooks wrote to the
    session's events file, and no longer counts PTY output or the engine's watchdog standing in
    for an event, which set it for DESKTOP-4J), `prompt_seen` (`yes`, `no`: whether the agent's own Prompt event
    arrived, read when the outcome is known, so a prompt typed after the window counts; with no
    opening prompt and none seen, the agent may never have made a conversation to resume; PTY
    output standing in for a prompt, which the tracker pushes for a session's first frame, does
    not count, and used to),
    `fs_scan` (what the filesystem pathway did: `none`, `pending`,
    `found`, `empty`, `dropped` for a match another session could own, `failed`), `id_store`
    (`present`, `absent`, `unknown`: whether the agent's own store holds this session, from the
    adapter's `sessionId.storeEvidence`: for Codex a rollout in today's or yesterday's UTC folder
    made since the spawn in the session's cwd, and for OpenCode a `session` or `session_v2` row
    of `opencode.db` made since the spawn in the session's cwd, which until DESKTOP-3A was only
    whether the file existed), `node_on_path` (`yes`, `no`, `unknown`: whether a bare `node` resolves on
    main's PATH, the one a local session's shell starts from, asked at the window. The command
    hooks Kangentic installs start the event bridge as `node`, so `no` says main found none for
    them; OpenCode's hooks run as a plugin inside OpenCode and need none. A session in a WSL
    distro or on a host, a failed lookup and one past 2 s read `unknown`. A node that only a shell
    profile adds reads `no` though the hooks still find it, since a PowerShell session loads its
    profile, and so does one installed after Kangentic started, so `no` is a hint) and `login` (`signed_in`, `signed_out`, `unknown`: whether the CLI holds a
    login, from the adapter's `sessionId.loginEvidence`, asked at the window about the home the
    session ran in, its account's folder or the agent's own. Codex reads `auth.json` there and
    runs `codex login status` only when there is none; every other agent, a CLI in a distro or on
    a host, a session whose account is no longer known, and a check that gave no answer within
    25 s read `unknown`). Every
    value is fixed; no path or id leaves. One `prompt_seen` source has been
    confirmed in a real run: OpenCode 1's plugin writes `prompt` on `chat.message` (1.18.31,
    Windows). Cursor's `beforeSubmitPrompt` hook was written from its docs. DESKTOP-4C's
    `yes` for Codex does not confirm its `UserPromptSubmit` hook either: it was sent before PTY
    output stopped counting, and that run's first frame alone would have set it. Until a run
    confirms an agent's source, its `no` alone is not grounds to stop a report. The signed-out rule above reads
    it only beside the CLI's own answer that it holds no login and a store that is not there.
    The on-time rule needs no such proof, since it acts only on a prompt event that did arrive.
  - `agent_accounts` is a `subsystem` tag, not a chokepoint source: a named account problem from
    `reportAccountProblem` (`src/main/accounts/account-report.ts`), sent as `Agent account problem:
    <problem> (<agent>)` with the tags `subsystem`, `account_problem` and `agent`, fingerprinted
    `['agent-accounts', problem, agent]`. The problems, their facts (a context, never a tag) and
    what is never sent are in [Agent accounts](../integrations/accounts.md#what-is-reported). It
    reports once per problem, agent and fixed `reason` per run, so a usage read's `cache-stale`
    cannot spend the report a later `run-failed` needs. A `usage-read-empty` whose CLI run failed
    carries three more tags, because Sentry DESKTOP-4E was one failed `claude -p /usage` with
    nothing to say why: `run_failure` (`timeout`, `signal`, `exit_code`, `spawn_error`,
    `host_unavailable` for a pty host that gave no answer, `other`, or `unknown` when the adapter
    did not say, read from the run's rejection by `execRunFailureOf`), `run_exit` (the exit code
    from 0 to 255, else `other`, only with `exit_code`) and `agent_cli_version`. On Windows the
    CLI runs through cmd, so a missing CLI reads `exit_code`, and the version reading `unknown`
    is what tells it. The caught error goes as its class and errno in the `cause` context. A
    failed run is sent from the second read in a row that fails for one account: one failed run
    during a network drop is not a defect, and a flag the CLI does not know fails every time.
    A `cache-stale` read waits for a second in a row the same way, counted apart from failed runs.
    Its run exited 0 and its own usage fetch refreshed nothing, which a network drop, a refused fetch
    and a sign-in that needs renewing all look like. DESKTOP-4E's one on 0.62.0 was a first read, and
    its cause is not known. It carries `cache_age` (`under_1h`, `1h_to_1d`, `over_1d`, or `unknown`)
    and `agent_cli_version`, so a cache that never refreshes reads apart from one that missed a pass.
    A `no-windows` read carries `agent_cli_version` too. DESKTOP-4E's 0.61.0 event was one with
    no version, and a plan whose windows are all null looked the same as a Claude Code release
    that renamed them. The renamed case now has its own problem: a Claude cache whose
    `utilization` names none of the known windows is `usage-read-unreadable`, with its keys, and
    so is one whose `utilization` is missing or not a record, with the cache's keys.
  - `preload_callback` (tag `method`, such as `config.onChanged`): a renderer callback that threw
    when the preload called it on a push. That throw is an error of the preload's isolated world,
    which the renderer's SDK cannot see: measured in Electron 45, the main world's `error` and
    `unhandledrejection` listeners heard nothing and the preload's own listener got `Script error.`
    with no stack. `guardPushCallbacks` (`src/preload/push-callback-guard.ts`) wraps every `on*`
    method's callback once, before the API is exposed, so the throw stops there and the channel's
    other listeners still run. It sends main a crash record, and
    `src/main/diagnostics/push-callback-report.ts` reports it for our own windows. The context
    bridge rethrows the callback's error as a plain `Error` with only the preload's frames, so
    these are fingerprinted `['preload-callback', method]`: the frames cannot split them. The
    message stays in the local record only.
  - `renderer` (tags `area`, `op`): `reportRendererFailure` (`src/renderer/utils/renderer-failure.ts`)
    for the board load, a card that opens nothing, terminal replay and frame hold, session sync in
    a packaged build, the project list, pop-out boot, the Monitor's task bundle and the WebGL
    fallback. It is fingerprinted `['renderer', area, op, name]`, the rule's second exception to
    stack grouping: a renderer catch often holds an IPC rejection only the renderer sees (no handler
    registered, a clone failure), whose frames are Electron's `ipcRenderer` internals in every area. It is latched
    per key under HMR, and has no Sentry import: `error-reporting.ts` registers its sink at init.
    The WebGL fallback's `webgl` context holds the failure kind (a word), the context-loss count (a
    number), and `featureStatus` (a word): Chromium's `getGPUFeatureStatus().webgl` as main read it,
    `pending` when the GPU process had not reported in time, or `unknown` before the status is
    read. A machine where Chromium reports WebGL off never files it (DESKTOP-32,
    [GPU process failures](../platforms/gpu-failures.md)). The same feature-status class already
    ships in the GPU process report's `featureStatusOnReport`.

  Settings > Privacy names this data: an error's type, a fixed failure code and, for an interface
  crash, the names of the components it was in. It also names the relay dial id, the one value
  here that another system keeps too: the relay logs it for about a week, so for that long an
  event can be matched to the relay's record of that connection. It carries no slot, key or
  content.
- **Grouping a defect reached through a dispatcher.** The dispatcher frames (the IPC wrap,
  `runHandler`, the `registerTool` proxy, `capability-router`'s dispatch) are the same for every
  handler, so they cannot split an issue and stay in the stack. If one ever groups unrelated
  handlers together, the server-side stack trace rule (Project Settings > Issue Grouping > Stack
  Trace Rules) is `stack.abs_path:**/ipc-handler-report.ts v-group -group`: `-group` takes the
  dispatcher's frame out of grouping and `v-group` takes every frame below it, its callers in
  Electron's IPC plumbing, so only the handler's own frames above it group. The same line with
  another dispatcher's file covers the rest. It is not set today.
- **Handled errors are forwarded too** (`reportHandledError`; the renderer counterpart,
  `reportHandledRendererError`, serves the monaco funnel above): the deliberate catch sites that
  otherwise emit only a sanitized count - updater structural failures (`source: updater`), PTY
  spawn failures (`source: pty_spawn`), a Kangentic utility worker that has crashed past its restart cap
  (`source: utility_process`, with `service`, `exitCode`, `crashCount`, and `cause`, fingerprinted
  `['utility-process-latched', service, cause]`, its stderr tail run through `redactEventText`; an embed
  worker that could not load a native module, `ERR_DLOPEN_FAILED`, is reported once a run in its place with
  `code: ERR_DLOPEN_FAILED`, fingerprinted `['handled-env', 'utility-process-load-failed', service, 'ERR_DLOPEN_FAILED']`,
  with the same redacted stderr tail), and a GPU health
  escalation reported on the next launch (`source: gpu_process`, with `reason`, `exitCode`, and
  `crashCount` - see the GPU health bullet below), a failed agent launch (`source: agent_launch`,
  see "Every failed launch that is reported has one report" below), a task leftover reap or a
  leftover-list Stop that
  failed (`source: task_reap`, with `stage` (`reap` or `stop`) and `code` (`reader_load`,
  `empty_scan`, `process_list`, `window_list`, `connection_list`, `reap_error`, `host_timeout`,
  `host_exited`, `host_error`, `wsl_error`), once per stage and code per launch; the message is
  fixed, and only a `reader_load` event carries text, the path-stripped load error in a
  `task_reap` context, since any other failure's text can come from a process scan. The three
  host codes are main's request to the pty host failing with no result. `host_timeout`: a running
  host did not answer within the budget, which starts when the request's batch starts running in
  the host, not when main sent it. `host_exited`: the host exited before it answered, or was still
  down when the budget ran out. `host_error`: any other rejection. A failure in
  a scan pass also carries a `pass` tag. `first`: nothing was signalled yet. `second`: the
  graceful kills went out. `last`: the force pass ran as well, possibly with no target.
  `reader_load`, the three host codes, `wsl_error`, and a `reap_error` from the home-directory
  lookup (which runs before any scan), carry no `pass` tag. A `window_list` failure also carries a
  `cause` tag saying how `lsappinfo`'s last attempt failed. `spawn_error`: it never started, or the
  spawn worker lost the run. `exit_code`: it exited non-zero. `signal`: something other than the
  timeout killed it. `timeout`: it ran past its timeout. `pass` and `cause` stay out of the message
  and the once-per-launch key, so neither splits the issue. A Stop
  that refused a process, such as Kangentic's own tree or a held PTY, is not reported. Neither is
  one that found the process still running after the force kill), and a guarded synchronous write that could not
  reach disk (`src/main/config/write-failure-notice.ts`, one report per failing `source` tag per
  outage: `config`, `config_dirs`, `config_project_override`, `import_source`, `browser_url`, the
  three `mobile_bridge_*` stores, `asana_credential`, `jira_credential`, `linear_credential`, `trello_credential`, `gitlab_credential`, plus `errno` and `syscall` tags when the
  error carries them; `config_dirs` is the one source that is a directory creation rather than a
  write (`ensureDirs()` at config load), and it also carries `config_dir` (`config`, `projects`, `models`),
  `config_dir_origin` (`env`, `flag`, `appdata`, `home`) and `config_dir_state` (`drive_missing`,
  `dangling_link`, `invalid_path`, `other`), from `src/main/config/data-dir-failure.ts`, which say
  why a directory could not be created without sending its path) - send the real error to Sentry so hidden issues
  are diagnosable, not just counted. The guarded write is the one exception to "the real error".
  Node writes the paths a syscall touched into an fs error's message, and a project on another
  drive reached Sentry whole that way (Sentry DESKTOP-1Z). A config file a guarded write targets
  can also sit outside both the home directory and every project, such as a relocated config
  directory on another drive. So it sends a copy whose message is built
  from the errno and syscall (`EPERM: rename failed`), with the original frames and no `path` or
  `dest`. A message that names a session directory or a worktree, such as a spawn's
  `Cannot create session directory at <path>` on a full disk (Sentry DESKTOP-21), needs no such
  copy, because `beforeSendEvent` redacts every registered project root (see "Initialization and
  scrubbing" above). ENOSPC arrives on that last path and is deliberately NOT
  filtered: it is a host condition rather than a defect, but it is also the only evidence the
  user-facing toast fires at all, and the per-source latch already caps the volume at one event
  per outage. The `errno` tag is what makes muting it later a Sentry-UI change rather than a code
  change (Sentry DESKTOP-1C). Each report passes the fingerprint
  `['sync-write-failure', source, errno]` (`none` for an error with no errno). Sentry's default
  grouping is by stack, so every caller of `safeWriteJson` opened its own issue for one outage
  (DESKTOP-1C, then 1Y from the `CONFIG_SET` handler, then 2K from `CONFIG_SET_SYNC`), and
  archiving one never stopped the next. With the fingerprint, one source and errno is one issue.
  The user's notice has a latch of its own: a report made before any
  window exists leaves the notice armed, so the source's next failure raises it with no second
  Sentry event. The utility-worker report also
  carries a `utility_process` context block with the last 8 KiB of the worker's stderr (home
  directory redacted). Every worker is forked with stderr piped for this; with Electron's
  `inherit` default, a packaged GUI build sent the worker's uncaught-exception dump nowhere, so
  every DESKTOP-H event could only say "exit code 1". Content lives in the context, never in a
  tag or the message, so grouping is unchanged. The same block lists `crashes`, one line per crash
  in the decay window, oldest first: the cause (`exit`, `fork_failed`, `ready_timeout` or
  `request_timeout`), the exit code when there is one, and for a request timeout the method that
  did not answer and the other methods still pending, as in
  `request_timeout method=projects.summaries pending=transcript.usage(12)`. The latching crash's
  cause is also a `cause` tag. Only `exit` is a process exit, so a `request_timeout` latch means the
  worker hung; DESKTOP-1Q said only "exit code unknown" and could not tell. Each crash is a string
  because Sentry normalizes contexts to depth 3, which turns an object inside the list into
  `[Object]`. The pending list names every job in flight, since the retrieval worker schedules
  nothing itself, but not which one held the loop. For that, the worker runs an event-loop watchdog
  thread (`src/main/utility-process/event-loop-watchdog.ts`, which the pty host runs too, with the
  `[pty-host]` prefix, for its heartbeat stall). When its heartbeat stops for about
  5 s, it writes `[retrieval-worker] event loop held 5 s in <step>` straight to stderr, naming the
  innermost `timeSyncWork` span that was running (or `outside any labelled step` when none was), so
  the line is in the stderr tail by the 15 s kill. Every handler's synchronous slice runs inside a
  `method:<name>` span, and each agent's transcript parse has one of its own
  (`transcript:parse-codex`, or `transcript:read-goose` and `transcript:read-opencode` for the two
  agents that read a database),
  because a parse runs after its read's `await`, outside any span around the call. The shared
  steps have `transcript:split-lines`, `transcript:previews` and `transcript:final-reply`.
  The stderr tail is one worker's text and cannot say which crash wrote it, so a
  crash with a watchdog line also carries it on its own `crashes` entry, read at report time:
  `request_timeout method=transcript.trailRead watchdog="[retrieval-worker] event loop held 5 s in transcript:parse-codex"`.
  Sentry DESKTOP-4P's entries all read `in db:checkpoint`. The two checkpoint sites now have labels
  of their own, `db:checkpoint-tick` (main's 5 s request) and `db:checkpoint-after-write` (the pacer
  after the worker's commits). Both run on the worker's checkpoint thread and hold no loop. The
  labels name the in-loop fallback when that thread cannot run. A request that times out while the
  newest watchdog line, written since the worker's last message, names one of them is failed without
  a kill or a counted crash, for up to a minute (`CHECKPOINT_HOLD_MAX_MS`), so it reaches no
  latch report.
- **Every failed launch that is reported has one report.** A user whose terminal never starts leaves, and most of
  these failures throw nothing, so `src/main/pty/agent-launch-report.ts` is the one way a launch
  failure reaches Sentry. Each report has a `stage`, and each stage its own error name:

  | `stage` | Fires when | Error name |
  |---|---|---|
  | `preflight` | A worktree, checkout, session folder or adapter step failed before any PTY, or a Command Terminal, workflow agent or startup recovery start threw | `AgentLaunchPreflightError` |
  | `pty_spawn` | The shell did not spawn. Its `source` stays `pty_spawn` | `PtyOutputNotConnectedError`, or the plain `Error` every earlier issue was grouped on |
  | `shell_exit` | The shell exited on its own with no sign the agent ran | `AgentLaunchShellExitError` |
  | `never_started` | The sweep, or a timer where the sweep cannot judge, found no agent and no sign one ran; or a launch on an SSH host whose adapter reports its start and whose output named its cause | `AgentLaunchNeverStartedError` |
  | `agent_exited` | A CLI named its own startup failure (`describeStartupFailure`), or a never-captured session's agent ran, then ended on its own under a minute later with no prompt, no session store and no deliberate kill (cause `no_conversation`, sent from the `agent_session_id` report with its tags). For a shell the agent-absence sweep retired, the agent's end is the shell's last output, since the sweep can kill it minutes later. A session whose launch already reported sends no capture report | `AgentLaunchAgentExitedError` |
  | `abandoned` | A person, or a quit an update or the OS began, ended a launch that had shown nothing for 15 s | `AgentLaunchAbandonedError` |
  | `pty_port` | A renderer that stays open never got its terminal port | `PtyPortDeliveryError` |

  `reportHandledError` takes a fingerprint, and these reports pass `['agent-launch', stage, cause]`,
  so each cause opens its own issue whichever call path reported it. `pty_spawn` passes none, because
  its issues are grouped on the lines in `recordSpawnFailure`, which claim the report and keep
  sending from those lines. A retry that worked sends one `AgentLaunchRecoveredError`, tagged
  `retry: recovered`, so a recovered failure still shows.

  An event carries `stage`, `cause`, `platform`, `agent`, `agent_cli_version`, `start_path` (`board`,
  `resume`, `command_terminal`, `workflow`, `phone`, `startup_recovery`, `retry`, `open`, `phone_open`), `shell`, `attempt`,
  `launcher` (`none`, `present`, `missing`), `command_head` (`present`, `missing`, or `unknown`
  for no recorded path, a bare command name or a WSL shell: whether the CLI path the command builder
  was handed exists at report time, never the path), `command_head_since_detection` (`same`,
  `changed`, `unknown`, below), `shell_printed` (`none`, `before_launch`,
  `after_launch`, around the spawn's clear), `first_output_s`, `session_age_s` (both buckets),
  `typed_line_bytes` and `overlay_ceiling`. A report on a session adds `output_class`
  (`command_not_found`, `permission_denied`, `no_such_file` (the command's own path),
  `bad_interpreter` (the command exists and its shebang's interpreter does not),
  `launcher_unreadable` (the shell could not read the launcher file its typed line names, such as
  `cat: <dir>/launch.sh: No such file or directory`), `exec_format` (the command's file is not a
  program this machine runs), `bad_cpu_type` (macOS refused the binary for its CPU type, zsh's
  `bad CPU type in executable:`), `killed` (the shell reported the command killed, such as bash's
  and dash's `Killed` or zsh's `killed`), `crashed` (a segmentation fault, bus error, abort or illegal instruction), `unknown_option`, `line_too_long`,
  `conversation_missing`, `login_required`, `bad_configuration`, `other`, `not_read`, `unreadable`). Output
  that is `other` adds `other_from`: `shell` when the last lines hold a PowerShell error record (a
  line that starts with `CategoryInfo` or `FullyQualifiedErrorId`, so the shell refused the typed
  line), and `unknown` otherwise. A shell refusing the line and an agent that started and left need
  different fixes, and both read `other` (Sentry DESKTOP-2J). A class that names a cause has no
  `other_from`. An ending adds `exit_code`, `exit_signal` and, for `abandoned`, `ended_by`
  (`pause`, `kill`, `quit`) and `agent_process` (`present`, `absent`, `unknown`). An `abandoned`
  report from a quit adds `quit_by` (below).
  `never_started` adds `judge` (`sweep`, `timer`). A launch on an SSH host judged on its output sends `sweep` though no sweep ran, with no `agent_process` tag and a `typed_line_bytes` of 0. An `agent_exited` report with cause
  `no_conversation` is the exception to this list: it carries `stage`, `cause`, `platform`,
  `attempt`, `source` (`agent_launch`) and the `agent_session_id` report's tags, not these. A preflight report
  adds `error_type` and `errno` when the error has them, and `start_refused_reason` for a start
  refused before it had a PTY (`AgentStartRefusedError`): `worktree-missing` or `folder-missing`
  for a gone folder. The folder's path is redacted, so this tag is what tells a gone worktree from
  a gone project folder (Sentry DESKTOP-2P could not). A command too long for its shell
  (`AgentCommandTooLongError`) is refused by design and its card says `prompt-too-long`, so
  `reportPreflightFailure` counts it as `spawn_failed` and sends nothing, on every path, and spends
  no key (Sentry DESKTOP-3Z spent the run's one OpenCode resume key on one). A remote start its
  host's link refused (`isRemoteLinkRefusal`: a `HostUnreachableError` or `UnsupportedOnHostError`,
  bare or as the `cause` of a wrapper) goes the same way at `preflight`, and at `pty_spawn`
  `recordSpawnFailure` keeps its `app_error` count and files nothing. That is the host's state, and
  the router's sentence named the host's id. Sentry DESKTOP-4N was one, sent renamed as
  `AgentLaunchPreflightError (worktree_other)`. It is not every `isExpectedFailure` class:
  `AgentCwdMissingError` is one, and a gone folder is reported here on purpose. A preflight failure
  once shutdown has begun sends nothing, counts no `spawn_failed` and writes one local
  `[AGENT-LAUNCH] ... shutdown=yes` line, whatever the error: the spawn
  refuses itself then (`Cannot spawn session during shutdown`), and a quit takes a host's links down
  under starts still running. Sentry DESKTOP-4V was a Command Terminal start that an update's
  `quitAndInstall` overtook. In any shell, a launch
  past cmd's typed budget whose `.cmd` shim cannot be read past
  (`AgentBatchShimUnresolvedError`) is refused the same way, with the same card reason, and goes
  under the cause `batch_shim_unresolved` whichever path started it, with `batch_shim` naming why
  the shim gave up (`unreadable`, `unparsed`, `target_missing`, `target_batch` for a chain of
  shims past `MAX_SHIM_HOPS`, `target_ps1`, `target_extensionless`, `target_other`, `node_path`).
  Sentry DESKTOP-3R saw only the typed refusal, 30 to 60 s later, and could not say which shim, and
  DESKTOP-3Y's one `target_not_script` covered every target that was not a program or a script. A
  Post-Worktree Script failure (`WorktreeSetupScriptError`) adds how the script ended, from
  `spawnWithAbort`'s fields: `script_exit` (its exit code), `script_signal` (a `SIG` name, for a
  script something else killed) and `timed_out` (`yes`, `no`). Sentry DESKTOP-3D had none and could
  not tell an exit from a kill: a non-zero exit carried no code either.

  A report on a resuming session adds what the resume check read before it
  (`assessResumeConversationWithEvidence`, `src/main/transition-engine/resume-conversation-guard.ts`),
  because a `conversation_missing` after an `unknown` verdict could not say which of the check's
  paths it took (Sentry DESKTOP-2M). `resume_turns` (`yes`, `no`) is whether any record of the
  lineage showed a turn. `resume_agent_report` (`status`, `session_start`, `none`) is the
  agent-written report the check read first. `resume_transcript` (`on_disk`, `missing`,
  `not_reported`, `unknown`) is a stat of the transcript the agent reported, or else the newest
  one a record kept. `unknown` there is a stat that failed with anything but ENOENT. `resume_cwd`
  (`same`, `moved`, `unknown`) is whether the spawn runs in the cwd the conversation last ran in.
  `resume_account` (`same`, `changed`, `none`, from `resumeAccountMatch` in
  `src/main/accounts/account-service.ts`) is whether the spawn runs on the account the
  conversation was written on. An override, or a signed-out or `replaced` conversation account, puts a resume on
  another account, whose config folder holds no such conversation. `changed` says the accounts
  differ, not that the difference lost the conversation. `none` is an agent with no accounts.
  None of them carries a path or an account id. The stat runs after the cwd migration, so
  `resume_cwd: moved` with `resume_transcript: missing` can be a file the migration moved, not a
  deleted conversation. Only the two task spawn chokepoints run the check, so a workflow agent's
  resume and a Command Terminal's Earlier conversation carry no `resume_*` tags.

  `command_head_since_detection` says whether the command head still resolves to the file
  detection found. `src/main/agent/shared/cli-identity.ts` compares the real path, device, inode,
  size and modified time. A link repointed at another version reads `changed`, and so does a file
  replaced or rewritten. A path that no longer resolves reads `changed` too, and `missing` on
  `command_head`. It reads `unknown` where detection recorded nothing for the path: a sibling shim
  swapped in on Windows, a bare name, a WSL shell.

  `agent_process` says whether the shell still had an agent under it when the launch was ended:
  `present` is a CLI that ran and stayed silent past the abandon bound, `absent` a command that had
  already ended. It means what the agent-absence sweep means by an agent, any descendant of the
  shell but a console host. Main reads it from the pty host's process table where it decides to
  end the launch (`noteAgentProcessBeforeEnd`, in `kill()` and `suspend()`), before the kill or the
  exit sequence reaches the agent, and never waits for it: read at the exit, the hangup would
  already have ended a live agent. It reads `unknown` when the read fails, when the listing no
  longer holds the shell, for a WSL shell, and for a quit, where nothing can read. It also reads
  `unknown` for a launch ended just short of the abandon bound whose exit lands past it: the read
  is posted only for a launch already past the bound, so a quick Stop costs no listing.

  Every output class rests on lines a real shell printed, never on wording from memory:
  `tests/unit/typed-launch-round-trip.test.ts` types each failure into each shell CI runs and pins
  the line it printed: bash 5.2, zsh 5.9, fish 3.7.0 and nushell 0.116.0, as CI's Ubuntu 24.04
  runs them, and zsh 5.9 with BSD `cat` on a macOS runner. nushell never names an exec format
  error: it hands such a file to `/bin/sh`, which reads its first bytes as a command not found, so
  that case stays `other` there. macOS differs from Linux in three ways. BSD `cat` leaves the path
  unquoted. The long `/private/var/folders/...` temp path wraps zsh's job line, so what is left
  once zsh's redraw is read out is just `zsh: killed` or `zsh: segmentation fault`, and the shapes
  take the command text as optional. macOS prints no `(core dumped)`. PowerShell's missing
  `launch.ps1` was measured on Windows, where no launcher is used. POSIX pwsh, the one that uses
  it, has no round trip in CI yet.

  Every value is fixed. A command holds the task's prompt and scrollback can hold secrets, so the
  last output is classified in main and only the class leaves. It is the launch's own output, never
  the ring a retry or resume carried over from the session it replaced (`getLaunchOutput`). The classifier anchors on how a shell
  words a failure, so text the shell echoed, such as a task titled "fix permission denied", cannot
  match. Detection keeps whatever a CLI printed, so `agent_cli_version` must look like a version or
  it reads `unknown`. The launcher's path stays in main, and only whether it still exists leaves.
  Git writes branch names into its errors, and branches are named after tasks, so a worktree or
  checkout report sends a fixed message and a `cause`. A checkout sends `checkout`. A worktree sends
  what it failed on, read in main from git's own `fatal:` line (`worktreeFailureCause`,
  `src/main/git/worktree-errors.ts`): `worktree_branch_checked_out`, `worktree_branch_exists`,
  `worktree_path_registered`, `worktree_path_exists`, `worktree_invalid_reference`,
  `worktree_invalid_branch_name`, `worktree_ref_lock`, `worktree_not_a_repository`,
  `worktree_permission`, `worktree_no_space`, or `worktree_other`. Two come from a type instead:
  `stale_directory` (a folder that would not clear) and `worktree_setup_script` (the Post-Worktree
  Script failed, `WorktreeSetupScriptError`). Each phrase was read off real git, and
  `tests/unit/worktree-failure-cause-real-git.test.ts` produces each one, except the full disk,
  which no test can make. Every other failed git command the git client runs (`runGitCommand`,
  local or on an SSH host) throws a `GitCommandError` (`src/main/git/git-command-error.ts`), whose
  `gitCause` any handled report sends as the `git_cause` tag: `unknown_revision` (a revision that
  names nothing, such as the HEAD of a repository with no commits), `missing_object` (a full hash
  the repository no longer holds), `not_a_repository`, `dubious_ownership`, `ref_lock`,
  `index_lock`, `corrupt_index`, `permission`, `no_space`, or `other`. It is read from git's
  stderr only, since a failed `show` can print file text first, and
  `tests/unit/git-failure-cause-real-git.test.ts` produces each phrase but the full disk.
  `permission` and `worktree_permission` match git's own `fatal:` or `error:` line ending in the
  OS's "Permission denied", so ssh's refused login and a `warning:` about a file git skipped read
  `other`. A git
  that prints another language reads `other`. Sentry DESKTOP-4A was `git:diffFiles` failing with
  only `Error` to go on. Its cause turned out to be a repository with no commits, where the
  Changes panel now diffs against the empty tree. Two git runners are not named this way yet:
  `spawnWithAbort` (fetch, prune, `branch -D`) and simple-git's own errors (blame, branch
  summary, commit graph, file history). No preflight report sends an error's message: the event is the stage's
  built error (`Agent launch failed: preflight (<cause>)`) carrying the original's frames, with
  its class in `error_type` and its code in `errno`. Messages here held branch names, task titles
  and URLs, and redacting paths left those. A failure `spawnAgent` reported and rethrew is marked
  (`markReported`), so the caller that catches it again (`auto_spawn`, `create_spawn`) sends
  nothing.

  One event per `stage`, `cause`, `attempt` and `agent` per run, on top of one report per session
  (`launchFailureNoted`), so one broken machine cannot use up the org's quota. `attempt` is in the
  key because a retry that failed has to reach Sentry, and `agent` because one agent's failure must
  not hide another's. The local `[AGENT-LAUNCH]` line is written
  whether or not the event goes, and that tag is a breadcrumb, so these events carry their trail.

  **Sentry stays a list of bugs we can fix, so what the user's own setup causes stays out.** That is
  decided in one place, the early return in `reportHandledError`, by `UserConfigurationError`. These
  reach it through the same path as any failure, and it drops them, so nothing else decides:

  - `AgentCliNotFoundError`: the CLI is missing.
  - `AgentUserSetupError`: an installed CLI is not logged in or refuses the user's own configuration,
    as its adapter identified from the CLI's words (`identifyUserSetupFailure`).
  - `GitUserStateError`: a dirty tree, a branch in use elsewhere, a missing base branch, a path too
    long. `BranchCheckoutBlockedError` is the same.

  Excluded failures still count in Aptabase as `spawn_failed`, with a fixed reason. The CLI's line
  that named the failure goes to the user's notice and nowhere else.

  **Only a cause identified positively is excluded.** An unknown failure from an installed CLI is
  reported, because it may be our bug. So is one that reads as command not found (detection and the
  shell disagreed) or that rejects an option we passed (we built a bad command). A recognizer reads
  whole lines at the end of the output, so a typed prompt quoting one of these sentences cannot
  match, and it leaves out any file Kangentic writes. See
  [Which agents identify what](../integrations/agents/optional-properties.md).

  An abort is a task taken over, not a failure, and a refusal at a Command Terminal start (the cap, a
  slot taken, a conversation in use) is an answer, so none of those is reported at all. The one
  refusal that is reported is a launch whose `.cmd` shim cannot be read past
  (`AgentBatchShimUnresolvedError`, cause `batch_shim_unresolved`), because the gap is the
  launcher's, not the user's.

  The quit path sends nothing (`synchronous-shutdown.md`), and no exit listener runs there. So a
  launch a person quit on goes on disk, as `abandoned-launches.json` in the config directory, and
  the next launch reports it (`src/main/pty/abandoned-launches.ts`). A person who never opens the
  app again is not reported.

  That report says what began the quit, as `quit_by`: `update` (the updater's install, which every
  `quitAndInstall` call goes through), `os` (the Windows `session-end` route and the macOS and Linux
  `powerMonitor` shutdown route in `src/main/index.ts`), or `user`. Each route notes it just before
  its quit (`src/main/quit-cause.ts`, first note wins) and `syncShutdownCleanup` reads it into
  `abandonedLaunchTags`. It is a fixed word, never read from text. The report stays: the launch
  still showed nothing for a minute or more, which an update's installer does not explain. Sentry
  DESKTOP-2N was a person installing an update, and only a timestamp match against DESKTOP-4V showed
  that, because the report said `abandoned` and nothing else. `user` is also the answer for a quit
  nobody noted: a POSIX signal cannot say whether a person or the OS sent it, and an app quitting
  with a downloaded update installs on the way out (`autoInstallOnAppQuit`) without going through
  the updater's install, so both read `user`.
- **A ConPTY whose output never connected is its own issue.** Sentry groups a `pty_spawn` report
  by the error's type and the code line of each in-app frame, and ignores the message (DESKTOP-23's
  grouping info). So `recordSpawnFailure` (`src/main/pty/spawn/pty-spawn.ts`) reports that shape
  from its own line as `PtyOutputNotConnectedError`, with `errno: PTY_OUTPUT_NOT_CONNECTED`. A real
  CreateProcessW failure keeps the plain `Error` and the line every earlier `pty_spawn` issue was
  grouped on. Rewording that line, or any other frame's line on the spawn-failure path, regroups
  them all. A report with no errno is tagged `errno: none`. The message names the attempt's time
  and the longest stall of the pty host's event loop while it waited (`RootPidGate.longestStallMs`).
  An attempt of about 5000 ms is node-pty's connect timeout, and a fast failure is the conout
  worker's own error. A stall past 5 s on a timeout is a lead, not a measured cause: it fits the
  timeout firing while the host's loop was held with the worker's ready message still unread. A
  short stall on a timeout points at the worker instead.
- **Host memory pressure carries a `host_memory` context on every event** (`setHostMemoryContext`,
  `src/main/diagnostics/host-memory.ts`; DESKTOP-16 was a renderer OOM where the crashing process
  held 179 MB while the host had 2.15 MB of Windows commit remaining out of an 89.8 GB limit - a
  minimal reading like that took a multi-hour investigation to establish because the diagnosis
  lived only in the minidump's `chromium_stability_report`, not on the event proper). The main
  process samples `process.getSystemMemoryInfo()` every 60s and calls `Sentry.setContext` on the
  ambient scope (not `beforeSend`, which is already `beforeSendEvent` above and has no
  transaction for `setMeasurement` to hang on), so whatever event fires next - including a native
  crash - carries the freshest sample. `correctNativeCrashEvent` prunes `host_memory` under the
  same stale-dump condition as `app_memory`/`free_memory`, since a startup-found dump can otherwise
  present the uploading launch's memory as the crash's. The commit fields are Windows-only. On
  Linux the sample carries `physicalAvailableBytes` instead, the kernel's MemAvailable
  (`available`, Electron 44+), because `physicalFreeBytes` there is MemFree, which leaves out page
  cache and reads near zero on a healthy machine. It is null on every other platform. Linux
  samples also carry `swapTotalBytes` and `swapFreeBytes`, and macOS samples `memoryPressureLevel`
  (the kernel's `kern.memorystatus_vm_pressure_level`, read a tick late) and `memoryFreePercent`
  (`kern.memorystatus_level`, which judges the warn level). The workflow's memory gate reads the
  same samples (`memoryHeadroom`, `src/main/workflows/workflow-memory-gate.ts`), and crash records
  and the renderer give-up dialog read the last one.
- **A low spell leaves two log lines, and nothing else.** Memory reads low below the smaller of 2 GB
  and 5% of the limit, and recovers at twice that (`updateLowMemoryLatch`). `trackLowMemorySpell`
  logs one `console.warn` tagged `[host-memory]` when a spell starts and one when it ends, with its
  duration, its lowest headroom and the limit at both ends, so a spell can be read back when
  diagnosing a crash. There is no toast, analytics event or automatic pause. A low reading was a
  short spell of reservations on a limit that grows, and the load came from working agents that a
  pause of waiting agents never touched.
- **A worker crash is logged after its stderr pipe ends.** Electron 44.5.0 drains a utility
  process's stderr after `exit`, so `UtilityRestartPolicy.recordCrash` holds the crash's log line
  and latch report until the pipe ends, bounded at 500 ms (`STDERR_DRAIN_BOUND_MS`). Measured on
  44.5.1, `end` follows `exit` by about 3 ms. The count, backoff, telemetry and the latch decision
  stay synchronous.

## What the user sees

A failure users hit closes its loop in two places: the moment it happens, and the release that
fixes it. Both are collective. Nothing matches a report to this install or tells a user "you hit
this".

- **A failure toast says it was reported.** When main sent the failure's report to Sentry in this
  run, the failure toast the user already sees draws one more line under its body: a bug icon in
  the card's color and "This issue has been automatically reported to Kangentic"
  (`ToastItem.tsx`, `.claude/rules/toast-shape.md`). It never promises a fix: `/sentry` leaves
  upstream and host-exhaustion issues unfiled. No toast is added for a handled error that
  recovered on its own.
- **What counts as sent.** `reportHandledError` returns whether it handed the report to Sentry
  (false with reporting off or for a user-configuration error). `handled-report.ts` keeps the
  errors whose report Sentry took in `wasSentToErrorReporting`: the error a send carried, and a
  latched repeat of a key whose first send was taken. A refusal, an expected failure, a key past
  the cap and a run with reporting off are never in it. `isReported` cannot answer this, since it
  also holds errors marked while nothing was sent. "Sent" means the SDK took the event, not that
  the transport delivered it: a `beforeSend` drop or an offline upload still counts. Waiting for
  each handled event's `afterSendEvent` would tie a toast to a network round trip, so the toast
  takes the SDK's word; the crash notice, which has no toast to hold up, waits for the 2xx.
- **How the fact reaches the toast.** An IPC rejection reaches the renderer as message text only,
  so the IPC wrap rethrows a sent error as a copy whose message ends in `REPORTED_FAILURE_MARKER`
  (`src/shared/reported-failure-marker.ts`). `describeIpcError` strips it from every reason, and a failure toast passes
  `ipcFailureToastFields(error)` (or `ipcErrorWasReported(error)`), so the toast's `reported` field
  draws the line. `tests/unit/toast-reported-fields.test.ts` keeps new toast sites passing it.
  An error from an inner chokepoint the handler rethrew is marked too: it is in the sent set.
- **One notice after a crash.** `src/main/analytics/crash-notice.ts` listens to Sentry's
  `afterSendEvent` and earns a notice only from a `fatal` native crash event the transport
  accepted (2xx). A dump found at startup from a run whose exit was `abrupt` is the app crash
  ("Kangentic crashed", with the dump's crash time); a live renderer crash sent within
  `WINDOW_RELOAD_ARM_MS` (60 s) of the main window's reload gate arming the holder
  (`armWindowReload`, in the `render-process-gone` handler) is "The window crashed and reloaded".
  Past that window a renderer crash is some other window's, or one whose report never went out,
  and shows nothing. The ping goes out even while the page is loading, since the mount's take can
  run before the load finishes. A foreign dump is a `warning` and never uploads, a clean previous
  exit shows nothing, and at most one notice shows per launch. The main window takes it on mount
  and on each `IPC.CRASH_NOTICE_READY` ping (`IPC.CRASH_NOTICE_TAKE`), and the toast carries the
  reported line.
- **The fix reaches users through the release notes.** `/release` writes a fix whose commit names
  a DESKTOP shortId and carries a `Release-Note:` line as an ordinary Bug Fixes entry in the
  symptom's words, with no shortId, and links one GitHub number per entry (the issue the fix
  closed, else the PR). A shortId commit with no `Release-Note:` line only improved diagnostics
  and stays out. The `/sentry` sweep opens a short public GitHub issue for each user-visible bug,
  read for anything sensitive first; Sentry's own GitHub issue automation stays off, because its
  issues carry the event's stack, tags and a link into the project.

## Counted, not reported

- **User-configuration errors are a deliberate exclusion.** `reportHandledError`
  early-returns on a `UserConfigurationError` (`src/shared/user-configuration-error.ts`). A
  missing agent CLI (`AgentCliNotFoundError`) is the user's environment, not a defect we can ship
  a fix for, so it is surfaced in the app instead - the spawn-blocked toast names the agent and
  points at the CLI path override in Settings > Agent - while `spawn_failed` still counts it, so
  "how often are users hitting a missing CLI" stays answerable. A future user-config error opts
  itself out by extending that class rather than by adding a message pattern to a filter list.
- **A folder Kangentic cannot write to is refused, not reported.** Before it registers a new
  project, `openProjectByPath` (`src/main/ipc/handlers/projects.ts`) writes and removes a probe
  file in `<folder>/.kangentic/`. A refusal throws an error that starts with
  `PROJECT_FOLDER_NOT_WRITABLE_PREFIX`, which reaches no Sentry issue because a user's folder
  permissions are not a defect in the app (Sentry DESKTOP-28 was this folder arriving through the
  config write instead). The Add project flow turns the sentinel into a toast, and nothing is
  registered, so `project_create` does not fire either.
- **A worktree the task's reap left a process in is counted, not reported.** Every terminal
  transition runs `reapTaskLeftovers` (`src/main/ipc/helpers/task-cleanup.ts`) before it removes the
  task's worktree. The reap keeps some processes on purpose (shared, outside, a visible app, under
  tmux or a live PTY), cannot stop some, and with "Stop leftover processes" off stops none. A kept
  process working inside the worktree holds the folder on Windows, so the removal fails with `EBUSY`.
  The user was told through the leftover-processes toast, and the removal is retried once the
  process ends. The reap now resolves with its verdict (`ReapVerdict`: the tasks it left a process
  working inside the worktree of), and the removal right after it passes `reapLeftRunning`. A failed
  removal with that set sends `app_error` (`source: worktree_removal`, `reason: reap_left_running`,
  with `caller`, `profile`, `errno`) instead of an issue. The Done move hands the same verdict to its
  delayed retry ten seconds later, since the kept process is usually still there. A retry that a
  Stop, a late reap answer or the row's recheck starts has no verdict of its own. The process it
  waited for is gone, and any other process the same reap kept in that worktree is not. DESKTOP-3P
  came back on 0.62.0 from one of these three. So a retry with no verdict that names the task, the
  delayed one included, first asks whether a process reported as left in that worktree still runs
  (`leftInWorktree` in `leftover-process-reports.ts`, then `checkReportedProcesses`, by identity and
  never by a scan). If one does, a failure is counted. If none does, or the host cannot say, it is
  reported. What a startup sweep kept is remembered for the same question (`rememberLeft`), and
  still never shown. A reap that failed, or that the host had not answered in time, names no task,
  and a failure after it reports unless a late answer has named a process there since. Sentry
  DESKTOP-3P was 15 events, every one `EBUSY` on Windows. Its `holders: none` on 11 of them is no
  evidence against a kept process: the holder scan (`findWorktreePathHolders`) reads command lines,
  and a process holding the folder only as its working directory cannot be seen on Windows.

  The cold open's retry of a Done task's removal (`caller: startup_retry`) takes the startup
  sweep's verdict the same way. The 0.62.0 recurrence of DESKTOP-3P was this retry, before it was
  given the verdict. The sweep runs just before it, once per launch, and a later open in the same
  launch gets the same verdict, waiting for it while the first sweep still reaps. So a process the
  sweep keeps finding in the folder is counted at every launch. The verdict is the first sweep's
  for the whole launch, by decision: a kept process that exits before a later open leaves that
  open's failure counted too, the price of not reporting the same held folder on every project
  switch. With "Stop leftover processes" off the sweep scans nothing, by decision, so nothing is
  known and a failed startup retry still reports. The cost is one event per launch for a user who
  keeps a process in a Done task's worktree with stopping off.

  What still reports carries three more fixed values to split the rest. `caller` names the path
  that asked: `done_fallback` (a Done move's in-place delete after its move aside failed),
  `done_retry_delayed` (its one retry ten seconds later), `done_retry_stop` (a Stop from the leftover
  list, one that finished late included), `done_retry_recheck` (the list found a process had ended),
  `done_retry_late_reap` (a reap main had stopped waiting for stopped one; 0.62.0 sent all four as
  `done_retry`), `cleanup` (To Do, Backlog, delete), `stale_cleanup` (a failed creation's leftovers),
  `startup_retry`, `mcp_delete`, `project_delete`, `spare`, `create_clear`, or `other`. The stack
  cannot say: DESKTOP-3P's frames were cut at an `await` inside the removal. `path_class` is where
  the manual removal last failed: `root`, `.git`, `node_modules`, `other`, or `none` when the error
  named no path. `syscall` is the syscall it failed in (`rmdir`, `unlink`, `rename` and a few more
  a removal makes), `other`, or `none`. The path itself never leaves: it holds the task's folder
  name. The process readers are not widened to read an untagged process's working directory to
  explain the rest. Their gates forbid it by design.
- **A recoverable utility crash is counted, not reported.** Only the crash that exhausts the
  restart cap produces a Sentry issue, and only once per latch, except an embed worker that could not
  load a native module (`ERR_DLOPEN_FAILED`), which is reported on its first crash because it
  stops forking then; Aptabase sees at most two
  `utility_worker_crashed` events per service per app run, the first crash and the latch. The same
  volume-versus-diagnostic split as `spawn_failed`.
  Every crash does log its stderr tail to the main console as a
  `[utility-process] <service> <what happened> (crash <i> of <cap>)` warning, which the log
  mirror persists to `<project>/.kangentic/logs/<date>.log`, so the text is on disk locally whether
  or not error reporting is on. An exit reads `exited with code <n>`. A crash with no exit says what
  the worker failed to do, as in `did not answer projects.summaries in time`. The package smoke
  matches the `(crash <i> of <cap>)` suffix every cause shares. The Knowledge Graph settings tab shows the same reason, plus
  the first error line, while semantic search is off because of it.
- **A GPU health escalation is reported once, and on the NEXT launch, not live.**
  `src/main/diagnostics/gpu-health.ts` counts GPU `child-process-gone` deaths the same way
  `UtilityRestartPolicy` counts a worker's, but cannot report live: the failure sequence this exists
  for can end in Chromium calling `LOG(FATAL)` (`IntentionallyCrashBrowserForUnusableGpuProcess`),
  which kills the whole process before an async Sentry POST queued at that moment would ever
  transmit. (Through Electron 41, Electron never emitted `child-process-gone` for a launch failure
  at all, so no `'GPU' process exited with 'launch-failed'` event could arrive. Electron 44 does.
  The first one Sentry kept, DESKTOP-2Q, arrived at the same instant as a DESKTOP-W fatal during an
  OS shutdown, which is why that message is now dropped once shutdown has begun; see "Filtering".)
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
  were launch failures, which Electron 41 never forwarded to JS (Electron 44 forwards the ones
  Chromium survives), and on Linux the running GPU
  process's death through a dead zygote reads as a normal exit that fires nothing either (see
  [GPU process failures](../platforms/gpu-failures.md)). A fallback-only
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
  the previous run survived: a fallback, or a crash loop that reached the report threshold.

  Only FAULT deaths count toward the report and the recovery, and the record is judged when it is
  read, so a record an older version wrote is judged the same way. A fault death
  (`isGpuFaultDeath`) has a reason naming a failure in the GPU process itself (`crashed`,
  `abnormal-exit`, `launch-failed`, `integrity-failure`) AND an exit code outside the
  session-teardown set: `0xC000026B` (STATUS_DLL_INIT_FAILED_LOGOFF), `0x40010004`
  (DBG_TERMINATE_PROCESS) and `0xC000013A` (STATUS_CONTROL_C_EXIT), compared unsigned because
  records store the signed form, AND the death did not come after the quit began (`quitBegun`,
  below). `killed`, `oom` and `memory-eviction` never count. The reason alone
  is not enough, because Chromium reports an exit code it does not recognize as `crashed`. A Windows
  shutdown with the dev instance open wrote five GPU deaths in 126 ms: one `killed` with
  `0x40010004`, then four relaunches `crashed` with `0xC000026B`, because Windows will not start a
  graphics process while the session is ending. The main process died with them and recorded no
  exit. Counting every death, that read as a crash loop that killed the run, and the next launch
  turned a healthy GPU's acceleration off. A fallback counts too, unless a non-fault death came up
  to 5 s before it, since Chromium steps down its ladder on the counted failure itself.

  A death after the quit began is never a fault, whatever its reason and code. `crash-capture.ts`
  reads `isShuttingDown()` at each `child-process-gone` and passes it on, and the death is kept in
  the record marked `quitBegun`, so a triage still sees it. DESKTOP-4T was that teardown filed as a
  crash loop: on a Fedora install, each run ended in DESKTOP-W's quit-time fatal (`quit_begun`
  true), and in the same second the GPU's zygote was already gone and five relaunches failed
  `launch-failed` with exit code 1002 inside 10 ms. Mid-run the GPU worked on that machine. As
  non-fault deaths, they also explain the fallback to the last rung that the quit set off.

  Not every pending record earns an issue: `shouldReportEscalation` reports on 3+ fault deaths, OR
  when `gpuEndedPreviousRun` holds. That needs all three of: the previous run ended `abrupt`; the
  GPU faulted repeatedly (3+ fault deaths, or a fallback no non-fault death explains, which is
  DESKTOP-W's only trace); and the latest fault sits within 90s of that run's last known sign of
  life (`run-uptime.ts`'s `at` checkpoint). `abrupt` alone means only that no exit was recorded,
  which covers a renderer OOM, a task-manager kill and a power loss. A lone crash cannot have
  killed the app, because Chromium's fatal is only reachable after it has fallen back, which takes
  three counted failures. A fallback the run survived is not reported: VMs and broken-GL machines
  can fall back at every boot. When it does report, `src/main/index.ts` calls `reportHandledError` with
  the message `GPU process exited repeatedly (...)`, or `GPU left hardware acceleration with no GPU
  process exit reported` for a fallback-only record, which groups as its own issue. Through
  Electron 41 that was the launch-failure shape. On Electron 44 the launch failures Chromium
  survives count as fault deaths, so that shape reports as `GPU process exited repeatedly`, and
  the fallback-only message is left for a fallback no reported death explains. It carries tags
  `source: gpu_process`, `reason`, `exitCode`, `crashCount`, and a `gpu_process` context carrying
  `reason`, `exitCode`, `count`, `faultDeathCount` (how many of `count` were fault deaths; the gap
  is kills, teardown exits and deaths after the quit began), `firstAt`, `lastAt`, `escalatedInVersion` (the app version that
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

  `buildGpuProcessContext` in `gpu-health.ts` builds this object. Sentry normalizes contexts to
  depth 3, which turned every entry of `deaths` and `modeChanges` into `[Object]` and
  `gpuInfoOnReport.gpuDevice` into `[Array]`, so DESKTOP-29 arrived with none of the fields that
  explain it and the Linux reading had never reached Sentry. Each `deaths` and `modeChanges` entry
  is now one line, as in `launch-failed code=1002 at=<iso> compositing=<value> webgl=<value>`, with
  ` quit=begun` at the end of a death after the quit began, and a
  `modeChanges` line on Linux ends with `zygote=<state> schedulingEntities=<n>
  maxUserProcesses=<limit>`. `gpuDevice` sits a level deeper, where any array flattens, so it is one
  string with its first four adapters joined by `; `. `normalizeDepth` stays at the default, because raising it
  is global, grows every event, and widens what `redact-event-paths.ts` walks.
  `tests/unit/gpu-health.test.ts` runs the builder's output through the real `@sentry/core`
  `normalize`. The other contexts were audited for the same flattening and hold only flat values:
  `host_memory`, `native_crash`, `task_reap`, `call_site` (a list of strings) and `diff_viewer_N`.
- **A GPU failure that killed the last run also downgrades this one, once.** When
  `killedTheLastRun` (`gpuEndedPreviousRun`, above) holds, `src/main/index.ts` has already started Chromium with
  `app.disableHardwareAcceleration()` and `--in-process-gpu` (decided at module scope, because
  that API throws once the app is ready), and now persists `graphicsAccelerationEnabled: false` with
  `graphicsAccelerationOffBy: 'app'` so later launches read the setting instead of re-deriving it
  from a record that is about to be cleared. `graphicsAccelerationOffBy` is what stops a later
  failure overwriting a choice the user made themselves. The renderer PULLS this state
  (`IPC.GPU_HEALTH_STATUS`) rather than main pushing it: both facts are decided during boot, when a
  `webContents.send` can land before any listener is registered and be dropped silently, and the
  record behind them is already gone. A read from the main window consumes the notice, so a reload
  cannot re-toast. A pop-out's read never takes it.
  The way back is the Settings > Performance toggle, which saves and restarts in one call
  (`IPC.GPU_HEALTH_SET_ACCELERATION`) through the normal quit, so that run records `clean`.
  See "Graphics failures" in [Troubleshooting](../user-guide/troubleshooting.md#graphics-failures) for what the user sees.
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

  Exit 1 is not matched. `gksudo` / `kdesudo` exit 1 when cancelled, which is indistinguishable
  from a command that ran and failed, so those declines still report.
  `LinuxUpdater.determineSudoCommand` picks `pkexec` on a stock GNOME or KDE desktop, which is the
  case this was written for. A bare `sudo` exit 1 has its own gate, the sudo fallback entry below.
  Because the pattern hand-matches a third-party
  template, `tests/unit/updater-error-classifier.test.ts` reads the installed
  `electron-updater` and fails if that template is reworded or a fifth sudo front-end appears.
- **A refused macOS authorization is counted, not reported, and a denial is told.**
  `isAuthorizationRefusedError` (`src/main/updater.ts`) is the macOS twin of the gate above, at the
  same position. Squirrel.Mac's ShipIt asks for admin rights when the app or its folder is not
  writable by the user running it (an app an administrator put in /Applications, run by a standard
  user), and macOS shows a password prompt. OSStatus -60005 (`errAuthorizationDenied`) is the
  rights refused, and -60006 (`errAuthorizationCanceled`) is the user pressing Cancel. Neither is a
  defect (DESKTOP-4M). The match is the `OSStatus error -60005` (or `-60006`) text alone: the sentence around it carries a curly
  apostrophe and Squirrel raises it natively, with no stack. A Cancel stays quiet, since the user
  just answered. A denial pushes `updater:blocked` through the same latch as the read-only volume
  below, because it repeats on every "Restart to update" and the modal the user saw now does
  nothing. See [macOS updates need an administrator](../releases/deployment.md#macos-updates-need-an-administrator).
- **A read-only volume is counted, not reported, and the user hears about it.**
  `isReadOnlyVolumeError` (`src/main/updater.ts`) gates the same `reportHandledError` call from
  the same position as the two above. A macOS app launched straight from the mounted DMG, or
  running translocated, cannot write over itself, so Squirrel.Mac refuses the install. That is a
  property of where the user put the app, not a defect: no build of ours would behave
  differently. DESKTOP-1A filed it 11 times from a single install.

  This branch also pushes `updater:blocked` to the renderer, which toasts a sentence pointing at
  the Applications folder. The reason is that the condition is permanent and silent: an install in
  this state never updates again and says nothing, so dropping the Sentry issue without telling
  anyone would leave the user on a frozen version indefinitely. The push is latched in main for
  the app's lifetime, so a condition every 4-hour check rediscovers still produces one toast per
  run.

  The pattern matches Squirrel's opening sentence only. Squirrel appends a recovery suggestion
  naming Downloads, macOS Sierra and a GitHub issue URL, none of which identifies the condition.
- **A refused update signature is still reported, as one issue, and a modified copy's user hears
  about it.**
  `isSignatureRequirementError` (`src/main/updater.ts`) matches `code failed to satisfy specified
  code requirement`, Squirrel.Mac's errSecCSReqFailed text. Squirrel checks a downloaded update
  against the RUNNING copy's designated requirement, so this means one of two things. The running
  copy is no longer signed by us (an ad-hoc copy's requirement is its own cdhash, which no release
  can satisfy), or a release was signed by another identity. The second would hit every Mac, so
  this gate does not drop the report the way the read-only one does.

  The event has no frames, so Sentry groups it by message, and the message names ShipIt's staging
  folder (`update.<random>`), new on every attempt. That split one install's failure into
  DESKTOP-2R and DESKTOP-2T. `signatureRequirementReport` replaces the folder with
  `update.<staging>` in the message and stack, and reports under the fixed fingerprint
  `['updater', 'signature-requirement']`. The `running_signing` tag tells the two causes apart. It
  comes from `codesign -dv` on the running bundle (`src/main/updater-mac-signing.ts`), read once
  per run:
  - `adhoc`, `unsigned` or `other-team`: this copy was modified or re-signed after it left us.
  - `our-team`: the copy is ours, so look at the release's signing.
  - `unreadable`: codesign failed.

  "Our team" is the Team ID in `src/shared/apple-team-id.json`. `build/afterSign.js` fails a
  release leg whose signature or `APPLE_TEAM_ID` disagrees with that file, so the tag cannot go
  stale quietly. Once the tag is known, the branch also pushes `updater:blocked` through the
  shared once-per-run latch, and the toast tells the user to download Kangentic again. It skips
  the toast on `our-team`, because a fresh download would fetch the same release.
- **A `.deb` install with no package manager is counted, not reported, and the user hears about
  it.** `isPackageManagerMissingError` (`src/main/updater.ts`), the branch below the signature one.
  `electron-updater` picks its updater from the `package-type` marker in `resourcesPath`, so a
  `.deb` unpacked outside dpkg runs `DebUpdater` on a host that may have neither `dpkg` nor `apt`.
  `DebUpdater.doInstall` then refuses before any elevation with a bare `new Error` and no `code`,
  so the message is all there is to test. `BaseUpdater.quitAndInstall` resets its own latch when
  the install fails, so every "Restart to update" click dispatches the error again. DESKTOP-R
  filed two events from two clicks 3 seconds apart on one Arch install. This is not
  `isElevationDeniedError`, because no prompt was shown and nothing was declined.

  It pushes `updater:blocked` through `notifyUpdateBlocked`, the once-per-run latch it shares with
  the two macOS cases and the sudo fallback below, so two clicks give one toast. The toast body is the error text word for
  word, with no advice. The fix depends on how the package got there, and the event cannot say
  which tool unpacked it. Because the pattern hand-matches a third-party string,
  `tests/unit/updater-error-classifier.test.ts` runs it over the messages in the installed
  `DebUpdater.js` and fails if none or more than one matches. `RpmUpdater` has no equivalent
  check, so this is the only message to match.
- **A sudo fallback that cannot prompt is counted, not reported, and the user hears about it.**
  `isSudoFallbackFailure` (`src/main/updater.ts`), the branch below the package manager one,
  matches `Command sudo exited with code 1`. The command name is the elevator `electron-updater`
  picked, and `sudo` is its fallback when none of `gksudo`, `kdesudo`, `pkexec` or `beesu` is on
  PATH. A GUI-launched app has no terminal for sudo to ask on, so sudo exits 1 at once, for
  `dpkg -i` and again for the `apt-get install -f -y` repair. No prompt is shown, the app does not
  quit, and every click repeats it. DESKTOP-44 filed this from an Ubuntu 26.04 host without
  pkexec. `RpmUpdater` elevates the same way, so the gate covers `.rpm` too.

  sudo also exits 1 when the package manager under a passwordless sudo fails, which is a real
  defect, so the message alone does not decide it. The branch runs `sudo -n true` through
  `execFileAsync`, in the pty host. Both failures of one click wait on the same probe, and the next
  failure after it settles runs a fresh one. Any non-zero exit means sudo needed a password: classic sudo
  exits 1, and sudo-rs parses `-n` the same way with an undocumented code. Then the branch logs,
  pushes `updater:blocked` ("No graphical password prompt, such as pkexec, is installed.") through
  the shared once-per-run latch, and drops the report. An exit 0 means sudo could have run the
  install, so the failure reports as structural. A killed or timed-out probe, a spawn error, or a
  pty host that gave no answer also reports, and shows nothing. Both reports carry the probe's
  answer as `sudo_probe` (`can-elevate`, `unknown`), and an `unknown` also carries how the probe
  failed as `sudo_probe_failure` (`timeout`, `signal`, `exit_code`, `spawn_error`,
  `host_unavailable`, `other`, read by `execRunFailureOf`). DESKTOP-44 sent one from v0.60.0, a
  build with this gate, and could not say which of the two let it through. If the toast or the
  reporting tail throws, that is our defect, so the branch reports it straight to
  `reportHandledError`. sudo's stderr is never read: classic sudo translates it, and the
  breadcrumbs had it filtered.
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
- **Reading `app_error` / `source: updater`: the count is not every updater failure.** The six
  suppressions above are not uniform about it, and the split is older than any of them.
  `isTransientUpdaterError` gates ABOVE `trackEvent`, so the classes it catches (a raw
  `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `EPIPE`, an `HTTP_ERROR_5xx`
  / `408` / `429` / `618`, a download whose message reads `Cannot download "...", status 5xx | 408 |
  429 | 618:`, a `net::ERR_`, an aborted request, a failed pipe) produce no event at all. That was the deliberate call when it was written: keep network blips out of `app_error`
  entirely. Every gate added since sits BELOW `trackEvent` and keeps the count.

  A failed download never matches the `HTTP_ERROR_` branch. `doDownload` passes a plain Error with
  no `code` to its callback, so those statuses are matched in its message, `Cannot download "...", status <code>:`.
  DESKTOP-24 was a signed link that expired while the machine slept (status 618), and the next
  check gets a fresh link. `tests/unit/updater-error-classifier.test.ts` renders the template it
  reads from the `httpExecutor.js` electron-updater loads and runs the predicate on the result, so
  an upstream fix or reword fails a test instead of going quiet. A 403 or 404 stays reportable, and
  its URL holds `sig=` and `jwt=`. `stripUrlQueries` in `updater.ts` removes every URL's query and
  fragment from what leaves the app: the report's message and stack, the `app_error` message, and
  the `[electron-updater]` log line (see "Breadcrumbs are filtered at the source").

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
  since there is no per-class tag on the `app_error` event. The Sentry report for a refused
  signature is the one that carries a class tag (`running_signing`).

## Investigating an issue

- **Affected-install counts:** the same anonymous, non-reversible `clientId` documented under
  [Unique Installs](usage-analytics.md#unique-installs) is attached as the Sentry user id, so an issue's Users column means
  "installs affected." It contains no personal data and shares the same kill switches.
- **Investigating an issue:** the `/sentry` skill (`.claude/skills/sentry/SKILL.md`) teaches an
  agent to retrieve and diagnose issues from the org. It retrieves through Sentry's own `sentry`
  CLI (`sentry issue list`, `sentry issue view`, `sentry api`) and keeps the raw API endpoints as
  the fallback. Nothing rewrites that output on the way to the reader. Home paths are removed
  earlier: the app rewrites its own home directory in event strings from the first release that
  includes `redact-event-paths.ts`, and every registered project root from the release that carries
  the DESKTOP-21 fix, and Sentry's rule scrubs most stored fields (see "Native crash
  fields" above). An event stored before either change, and any frame `package`, can still carry
  one.

## Sourcemaps and debug files

- **Sourcemaps** upload at release time only: `@sentry/vite-plugin` (renderer) and
  `@sentry/esbuild-plugin` (main/preload) activate when an upload token is present
  (`KANGENTIC_SENTRY_TOKEN`, or the conventional `SENTRY_AUTH_TOKEN` as a CI fallback) AND the
  build is authorized to upload: in CI (`CI=true`), or locally only with an explicit
  `KANGENTIC_SENTRY_UPLOAD=1`, so a developer's persisted token never uploads a local build. They
  generate hidden maps, upload them with debug IDs, and delete them from the output. Nothing ships in the
  artifact; resolution is entirely server-side. The DSN in source is a public routing
  identifier by design, not a secret. `KANGENTIC_SENTRY_TOKEN` is also what the `/sentry`
  skill's raw-API fallback reads. Normal retrieval uses the `sentry` CLI's stored login instead. Both plugins pass an
  explicit `release.name` of `Kangentic@<version>`, matching what `@sentry/electron` reports at
  runtime; left unset the bundler default is `GITHUB_SHA`, which files the artifacts under a name
  no event ever carries. A build that uploads runs its main-process bundles one at a time
  (`runEsbuildBundles` in `scripts/build.js`): the `sentry` package the plugins drive keeps one
  module-global env per command, so two uploads in flight at once leave one of them with no token.
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
  correction is gated on. The ownership check above stays unconditional, since a live crash event
  can still pick up a stray foreign dump sitting in the same directory. What the dump itself says
  lands in a `native_crash` context on every event of ours whose dump PARSED: crash time, crashed
  version, uploading version, the main module's file name, the module count, whether the dump was
  found at startup, and which corrections fired. A dump the reader cannot parse keeps its event
  untouched and carries no context block, so the absence of one is itself a signal when triaging.

  `quit_begun` says whether the crashed run had begun quitting. gpu-health.ts's next-boot recovery
  acts only on a run that ended `abrupt`, and a startup-found dump keeps no breadcrumbs, so without
  it a browser fatal at quit and one mid-run look the same (DESKTOP-W). A live event takes it from
  the running session's shutdown flag. A startup-found dump is judged by the previous run's record
  (`src/main/analytics/run-uptime.ts`), which `src/main/index.ts` reads at module scope before
  `initRunUptimeTracking` overwrites it, and only when the crash time falls inside that run (its
  last `at` less its uptime). A dump left from an earlier run gets no answer. Inside the run:
  `abrupt` gives `false`; `clean` gives `true` when the crash came in or after the second of the
  record's `at`, which is when `performShutdown` began, and `false` before it (the dump's stamp
  holds whole seconds); `failsafe` leaves it out, because
  that `at` is the kill, not the quit's start. `previous_run_exit` names the exit kind whenever the
  dump was placed in the previous run. An absent `quit_begun` means unknown, never `false`.
  A `true` also sets the `quit-begun` fingerprint (see "Native and guest crashes").
  Note the SDK decrements its 10-minidumps-per-session budget at capture time, before `beforeSend`
  runs, so foreign dumps consume it too, even though their dumps never upload.
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
    load, and both it and `vite.config.mts` refuse to build when an upload is authorized (a token in
    CI, or a token with `KANGENTIC_SENTRY_UPLOAD=1`) and `NODE_ENV` is anything other than
    production, which also catches it being unset.

  On top of that, every build now prints which way the gate went, and with a token present any
  upload failure fails the build rather than warning past it.

  An upload that matches nothing is not a failure to the plugins. They only call `logger.warn`,
  which `errorHandler` never sees, and one bundle with no debug id or no map drops out at debug
  level while the build still logs "Successfully uploaded". So `scripts/sentry-upload-gate.js`
  counts the positive case. Each plugin gets a `sourcemaps.resolveSourceMap` hook that records a
  bundle when the upload reaches it with a map beside it, and a gate plugin after Sentry's fails
  the build on any bundle it did not record, whatever the reason the plugin skipped it. esbuild
  holds every `.js` in each build's metafile to that. Vite holds every entry chunk and every chunk
  the bundler wrote a map for. Worker bundles are assets the plugin skips by design, and rolldown
  writes no map for chunks of only its own generated code (`rolldown-runtime`, `preload-helper`).
  The gate plugin's name starts `sentry-` because `demo/vite.config.mts` drops plugins by that
  prefix, and the web demo has no upload to check.
