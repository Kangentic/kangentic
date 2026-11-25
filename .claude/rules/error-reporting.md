---
paths:
  - "src/main/**"
  - "src/renderer/**"
---
# Rule: a caught error is reported, rethrown, or swallowed with a reason

Uncaught errors always reached Sentry, but handled ones mostly did not. No IPC handler, MCP tool,
phone verb, automation, turn-end pass, workflow evaluation or recovery pass reported, and none of
the renderer's catch sites did, so a broken drag, resume or project open showed the user a toast
and told us nothing. Some of what did reach Sentry carried user content: worktree folder slugs are
task titles. The chokepoints now report, and this rule keeps a new catch from going quiet and a
new report from carrying what a user wrote. The design and every source: [docs/telemetry/error-reporting.md](../../docs/telemetry/error-reporting.md).

## The rule

- **A catch reports, rethrows, hands the error on, or says why it does none of those.** A `catch`
  clause, a `.catch(callback)` or the rejection handler of `.then(onFulfilled, onRejected)` whose
  own body (not a function nested in it) throws, calls `reject`, calls a reporter, or relays a
  worker's fixed code passes. Anything else carries `// report-ok: <reason>` on the catch line or
  at the top of its body. A log line is not a report. An expected outcome (a missing file on
  first run, a refusal, an abort) is a fine reason; "best effort" is not, unless it says whose
  effort and why a miss costs nothing. Never write that another function reports the failure
  unless you opened it and saw the report.
- **A swallow followed by something destructive stops before it.** A catch that logs a failed
  copy and then deletes the originals, or a failed read and then deletes as if nothing was there,
  loses data whether or not it reports. Stop before the destructive step: rethrow into the
  caller's rollback, or skip the step and report. The audit that wrote this bullet found eight.
- **Report through a chokepoint reporter where one exists.** `createChokepointReporter(source)`
  (`src/main/analytics/handled-report.ts`) holds every other bullet below; bind it to a name
  ending in `Reporter`, which the scan keys on. In the renderer, `reportRendererFailure(area, op,
  error)` (`src/renderer/utils/renderer-failure.ts`). A new named reporter function joins
  `REPORTER_FUNCTIONS` in `tests/unit/helpers/error-reporting-scan.ts`.
- **The message is fixed: `Handled <source> failure: <ErrorName>`, with the original frames**
  (`pathFreeCopy`). Never send `error.message`, in the event or in contexts, a runtime error's
  included: V8 quotes the property it could not read, Node's `ERR_INVALID_ARG_*` quotes the value
  it got, and `JSON.parse` quotes its input.
- **Tags are short enums.** A stage, a cause, an agent name, an errno. Never a task title, a path,
  a channel's argument, a column or automation name, a URL host (an artifact domain collapses its
  tenant label: `*.sharepoint.com`), or free text. The one non-enum tag is a `correlationTags`
  entry: a fixed-shape random id that joins the event to another system's record
  (`relay_dial_id`). It is minted per occurrence and derived from nothing. It stays out of the
  latch key, and Settings > Privacy names it. A tag that describes one occurrence (`ran_for`,
  `caller`, `attempts`) is a `detailTags` entry, sent and kept out of the latch key the same way.
- **A first event answers four questions, so a new reporter says them up front.** Why, as a
  fixed word, when the error wraps another program's text (`git_cause`, `load_cause`; the shared
  send already adds `exit_code`, `exit_signal`, `timed_out`, `cause_name` and `cause_errno`).
  Which path delivered, when one failure can arrive several ways (`stage`, `automation_trigger`,
  `caller`, `captured_by`). How long, as a bucket, for anything that waits or times out (`ran_for`). And
  what the machine and window were doing, which `beforeSendEvent` puts on every event
  (`run-state-tags.ts`). Six issues each needed a later release that only added these. A report
  of a timeout says what the timer measured and how it ended, and is sent at the outcome, not at
  the threshold.
- **Skip what is not a defect.** `isExpectedFailure` covers shutdown, aborts,
  `UserConfigurationError` and its `RefusalError`, the named expected classes, and network
  failures. A refusal main throws to the renderer is a `RefusalError`, never a plain `Error`.
  When a catch's common failure is another program's plain `Error` (an agent CLI that exited, a
  host that was busy), give that outcome a named expected class where it is thrown, or guard
  the site, before the report ships: Sentry DESKTOP-49, 4G, 4X and 43 were each an expected
  outcome filed as a defect.
  Never wrap a caught error you did not classify in a `RefusalError`: the wrapper is skipped
  before its `cause` is read, so a `TypeError` inside goes unreported. Wrap it in a plain `Error`
  with `cause`, which `isExpectedFailure` judges by what it wraps. A `RefusalError` that does
  carry a caught `cause` says how it was classified with `// refusal-wrap-ok: <reason>`. A drop
  of an SSH link is expected too: a request the host never answered rejects with
  `HostRequestUnansweredError`, never a plain `Error`.
- **Fingerprint environment failures, leave code defects to stack grouping.** An errno or
  `SQLITE_` failure groups as `['handled-env', name, code]`. A code defect gets no custom
  fingerprint: Sentry groups it on its in-app frames. Never put an IPC channel or a tool name in
  a fingerprint. Three sources are exceptions, because their frames cannot split an issue. A preload
  push callback's error crosses the context bridge with only the preload's frames, so it groups by
  API method (`['preload-callback', method]`). A renderer catch often holds an IPC rejection only
  the renderer sees (no handler registered, a clone failure), whose frames are Electron's
  `ipcRenderer` internals in every area, so it groups by area and operation
  (`['renderer', area, op, name]`). And a worker's failed reply is rebuilt in main, with main's
  frames whatever the worker threw, so it groups by method (`['retrieval-call', method, name,
  code]`).
- **An `ipcMain.on` listener registers through `onReported`** (`ipc-handler-report.ts`). `handle`
  is patched once and wraps every handler. `on` is not, since a wrapper would break
  `removeListener`, and a bare listener that throws is an uncaught exception that reaches Sentry
  with the error's own text and no channel.
- **Latch once per key per run, at most about 25 keys per chokepoint.** The reporter does it. The
  IPC wrap keeps 100, since the renderer drops its own copy of a rejection main saw.
- **Dedupe through `markReported(original)`.** A reporter marks the error it was handed, and a
  wrapper that sees it again (the IPC wrap, a caller's catch) skips it through `isReported`,
  which also checks one level of `cause`. Never keep a set of the copies that were sent.
- **Report from main or the renderer, never from a worker process.** The pty host, the retrieval
  worker and the dictation worker cannot import Sentry. They relay a fixed code (`handledError`)
  and main reports it. A renderer store reports through `reportRendererFailure`, whose sink the
  SDK module registers, so a store never imports the SDK.
- **Disclose a new data class** in Settings > Privacy (`PrivacyTab.tsx`) and in
  `docs/telemetry/error-reporting.md` in the same change. A new console tag kept as a breadcrumb
  joins `CONSOLE_BREADCRUMB_TAGS` only when nothing under it interpolates user content.

## Enforcement (self-maintaining)

- **Test (catch sites):** `tests/unit/error-reporting-coverage.test.ts` parses every `.ts` and
  `.tsx` under `src/main` and `src/renderer` and fails when a file has more unreported catch sites
  than `tests/unit/helpers/error-reporting-unreported-sites.ts` allows, and when a count there is
  higher than the file now has, so the list only shrinks. It pins each name in the reporter set to
  a real declaration and every `createChokepointReporter` binding to a `*Reporter` name, and drives
  the detector over known source. Runs in CI via `npm run test:unit`.
- **Type system (renderer tags):** `reportRendererFailure` takes `area` and `op` as `FixedWord`,
  a string literal or a union of them, so a plain `string` (a title, a path, text built at run
  time) fails `npm run typecheck`. Main's tags are `Record<string, string>` and have no such
  guard.
- **Test (chokepoints and feature sites):** the `tests/unit/error-reporting-*-behavior.test.ts`
  files, `pr-report-behavior.test.ts`, `unclassified-defect-report.test.ts`,
  `automation-runner-report-behavior.test.ts`, `db-open-failure-notifier.test.ts`,
  `dictation-failure-report.test.ts` and `download-model-classification.test.ts` run each report
  site for real: a dependency throws, and the test asserts the report's tags and that no user
  text left. `tests/ui/renderer-failure-reports.spec.ts` does the same in a browser for the
  component sites the unit tier cannot mount. `tests/unit/ipc-handler-report.test.ts` drives the IPC wrap and pins its install in
  `index.ts`. `tests/unit/error-reporting-chokepoints.test.ts` keeps the MCP tool proxy and the
  phone router, and `tests/unit/error-reporting-feature-gaps.test.ts` keeps the sites no test can
  import. `tests/unit/handled-report.test.ts` pins the message, the latch, the cap, the dedupe
  and the expected-failure filter.
- **Test (breadcrumbs):** `tests/unit/sentry-breadcrumbs.test.ts` scans every line under a kept
  console tag for interpolated user content.
- **Review:** `/code-review` judges what a scan cannot: whether a `report-ok:` reason is true,
  whether a tag or context can carry user text, and whether a new data class is disclosed.
- **Test (refusal wraps and listeners):** the coverage test also fails a `new RefusalError(...,
  { cause })` inside a catch with no `// refusal-wrap-ok:` marker, and
  `tests/unit/ipc-handler-report.test.ts` fails a bare `ipcMain.on(` under `src/main`.
- **Gap:** an error passed on as a value (`onFailed(error)`, `emit('rejected', error)`, a helper
  that turns it into `{ success: false }`) is out of the scan's reach: report inside the function
  that receives it, as `reportWorkflowCommandFailure` does. So is a catch that throws or reports
  on one branch and swallows on another: the scan passes a catch whose body throws or reports
  anywhere, because `if (isExpected(error)) return; throw error;` is the shape most catches
  rightly take. Whether the other branches are expected outcomes is review's call. The shape to
  look for is a guard that names one class and a silent return for the rest
  (`if (!isSqliteError(error)) throw error;`, `if (toThrow) throw toThrow; return [];`).

## Scope

Catch sites and handled-error reports in `src/main/**` and `src/renderer/**`. Uncaught errors
(Sentry's own handlers) and the Aptabase analytics events are out of scope.
