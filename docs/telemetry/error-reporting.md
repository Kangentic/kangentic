---
type: Reference
title: Error reporting (Sentry)
description: "How Sentry runs in main and the renderer: path scrubbing, ignoreErrors filters, the console breadcrumb tag allowlist, foreign native crash handling, errors counted instead of reported (updater, GPU, workers), the GPU escalation report, and sourcemap and debug file upload."
tags: [sentry, crashes, breadcrumbs, scrubbing]
sources:
  - resource: src/main/analytics/error-reporting.ts
  - resource: src/renderer/error-reporting.ts
  - resource: src/shared/sentry-data-collection.ts
  - resource: src/shared/sentry-breadcrumbs.ts
  - resource: src/main/analytics/redact-event-paths.ts
  - resource: src/main/shared/project-roots.ts
  - resource: src/main/db/repositories/project-repository.ts
  - resource: src/main/config/write-failure-notice.ts
  - resource: src/main/analytics/native-crash-event.ts
  - resource: src/main/analytics/reportable-module-name.ts
  - resource: src/main/analytics/renderer-classification.ts
  - resource: src/main/utility-process/stderr-tail.ts
  - resource: src/shared/benign-renderer-errors.ts
  - resource: src/renderer/monaco-error-funnel.ts
  - resource: src/main/diagnostics/gpu-health.ts
  - resource: src/main/updater.ts
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
    fallback - see below.
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
  - `console`: kept only under a tag in `CONSOLE_BREADCRUMB_TAGS` (`[UPDATER]`,
    `[electron-updater]`, `[SHUTDOWN]`, `[terminal-webgl]`, `[gpu]`, `[GPU-HEALTH]`, `[APP]`) or
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
    app's own `app:///` page, without its query.
  - Request crumbs (`http`, `electron.net`, `fetch`, `xhr`): method and status stay. The URL stays
    only under a Kangentic prefix (our GitHub repository and release assets, Aptabase), without its
    query. Main's fetch also reaches the board adapters and the webhook automation, whose URLs can
    name an organization or hold a secret.
  - Node's `child_process`: the message is path-redacted and `spawnfile` keeps only its file name.
    Electron's `child-process` is kept whole.
  - Anything else, `sentry.event` and `navigation` included, is dropped, so a category a new SDK
    version adds stays out until someone decides otherwise.

  The filter fails closed, the opposite of `beforeSendEvent`: a throw drops the crumb. The
  `[SHUTDOWN] pty-drain:*` lines pass byte-identical. electron-updater's own lines, which carried
  the Squirrel and package-manager detail on past updater issues, go through a tagged logger in
  `src/main/updater.ts`, with its debug output kept out. Events uploaded before this change still
  carry the unfiltered trail.

## Handled errors and event context

- **Boundary-caught errors** never reach the SDK's global handlers (React swallows them), so
  all three error boundaries hand the real `Error` to `captureException` explicitly. Two of them
  also keep the existing Aptabase funnel (`ErrorBoundary` as `boundary: 'root'`,
  `PanelErrorBoundary` as `boundary: 'panel'`); `DiffErrorBoundary` reports to Sentry only.
- **Handled errors are forwarded too** (`reportHandledError`; the renderer counterpart,
  `reportHandledRendererError`, serves the monaco funnel above): the deliberate catch sites that
  otherwise emit only a sanitized count - updater structural failures (`source: updater`), PTY
  spawn failures (`source: pty_spawn`), the silent agent-spawn catches (`source: spawn`, with a
  `reason` tag), a Kangentic utility worker that has crashed past its restart cap
  (`source: utility_process`, with `service`, `exitCode`, `crashCount`, and `cause`), and a GPU health
  escalation reported on the next launch (`source: gpu_process`, with `reason`, `exitCode`, and
  `crashCount` - see the GPU health bullet below), a task leftover reap or a leftover-list Stop that
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
  lookup (which runs before any scan), carry no `pass` tag. A Stop
  that refused a process, such as Kangentic's own tree or a held PTY, is not reported. Neither is
  one that found the process still running after the force kill), and a guarded synchronous write that could not
  reach disk (`src/main/config/write-failure-notice.ts`, one report per failing `source` tag per
  outage: `config`, `config_dirs`, `config_project_override`, `import_source`, `browser_url`, the
  three `mobile_bridge_*` stores, `asana_credential`, plus `errno` and `syscall` tags when the
  error carries them) - send the real error to Sentry so hidden issues
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
  change (Sentry DESKTOP-1C). The utility-worker report also
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
  thread (`src/main/retrieval/worker/event-loop-watchdog.ts`). When its heartbeat stops for about
  5 s, it writes `[retrieval-worker] event loop held 5 s in <step>` straight to stderr, naming the
  `timeSyncWork` span that was running (or `outside any labelled step` when none was), so the line
  is in the stderr tail by the 15 s kill.
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
  cache and reads near zero on a healthy machine. It is null on every other platform. No Linux
  pressure warning is raised from it. Linux samples also carry `swapTotalBytes` and
  `swapFreeBytes`, and macOS samples `memoryPressureLevel` (the kernel's
  `kern.memorystatus_vm_pressure_level`, read a tick late), which the low-memory pause reads
  (`src/main/diagnostics/idle-agent-pause.ts`).
- **A worker crash is logged after its stderr pipe ends.** Electron 44.5.0 drains a utility
  process's stderr after `exit`, so `UtilityRestartPolicy.recordCrash` holds the crash's log line
  and latch report until the pipe ends, bounded at 500 ms (`STDERR_DRAIN_BOUND_MS`). Measured on
  44.5.1, `end` follows `exit` by about 3 ms. The count, backoff, telemetry and the latch decision
  stay synchronous.

## Counted, not reported

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
  transmit. (A search of everything Sentry retained never turned up a `'GPU' process exited with 'launch-failed'` event
  for a different reason: through Electron 41, Electron never emitted `child-process-gone` for a
  launch failure at all. Electron 44 does, for the ones Chromium survives.)
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
  records store the signed form. `killed`, `oom` and `memory-eviction` never count. The reason alone
  is not enough, because Chromium reports an exit code it does not recognize as `crashed`. A Windows
  shutdown with the dev instance open wrote five GPU deaths in 126 ms: one `killed` with
  `0x40010004`, then four relaunches `crashed` with `0xC000026B`, because Windows will not start a
  graphics process while the session is ending. The main process died with them and recorded no
  exit. Counting every death, that read as a crash loop that killed the run, and the next launch
  turned a healthy GPU's acceleration off. A fallback counts too, unless a non-fault death came up
  to 5 s before it, since Chromium steps down its ladder on the counted failure itself.

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
  is kills and teardown exits), `firstAt`, `lastAt`, `escalatedInVersion` (the app version that
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
  `killedTheLastRun` (`gpuEndedPreviousRun`, above) holds, `src/main/index.ts` has already started Chromium with
  `app.disableHardwareAcceleration()` and `--in-process-gpu` (decided at module scope, because
  that API throws once the app is ready), and now persists `graphicsAccelerationEnabled: false` with
  `graphicsAccelerationOffBy: 'app'` so later launches read the setting instead of re-deriving it
  from a record that is about to be cleared. `graphicsAccelerationOffBy` is what stops a later
  failure overwriting a choice the user made themselves. The renderer PULLS this state
  (`IPC.GPU_HEALTH_STATUS`) rather than main pushing it: both facts are decided during boot, when a
  `webContents.send` can land before any listener is registered and be dropped silently, and the
  record behind them is already gone. Reading consumes the notice, so a reload cannot re-toast.
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
    load, and both it and `vite.config.mts` refuse to build if a token is present while
    `NODE_ENV` is anything other than production, which also catches it being unset.

  On top of that, every build now prints which way the gate went, and with a token present any
  upload failure fails the build rather than warning past it.
