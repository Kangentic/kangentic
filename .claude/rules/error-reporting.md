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
  clause or a `.catch(callback)` whose own body (not a function nested in it) throws, calls
  `reject`, calls a reporter, or relays a worker's fixed code passes. Anything else carries
  `// report-ok: <reason>` on the catch line or at the top of its body. A log line is not a
  report. An expected outcome (a missing file on first run, a refusal, an abort) is a fine reason;
  "best effort" is not, unless it says whose effort and why a miss costs nothing.
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
  tenant label: `*.sharepoint.com`), or free text.
- **Skip what is not a defect.** `isExpectedFailure` covers shutdown, aborts,
  `UserConfigurationError` and its `RefusalError`, the named expected classes, and network
  failures. A refusal main throws to the renderer is a `RefusalError`, never a plain `Error`.
  Never wrap a caught error you did not classify in a `RefusalError`: the wrapper is skipped
  before its `cause` is read, so a `TypeError` inside goes unreported. Wrap it in a plain `Error`
  with `cause`, which `isExpectedFailure` judges by what it wraps.
- **Fingerprint environment failures, leave code defects to stack grouping.** An errno or
  `SQLITE_` failure groups as `['handled-env', name, code]`. A code defect gets no custom
  fingerprint: Sentry groups it on its in-app frames. Never put an IPC channel or a tool name in
  a fingerprint. Two sources are exceptions, because their frames cannot split an issue. A preload
  push callback's error crosses the context bridge with only the preload's frames, so it groups by
  API method (`['preload-callback', method]`). A renderer catch often holds an IPC rejection only
  the renderer sees (no handler registered, a clone failure), whose frames are Electron's
  `ipcRenderer` internals in every area, so it groups by area and operation
  (`['renderer', area, op, name]`).
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
- **Test (chokepoints and feature sites):** the `tests/unit/error-reporting-*-behavior.test.ts`
  files, `pr-report-behavior.test.ts`, `automation-runner-report-behavior.test.ts`,
  `db-open-failure-notifier.test.ts` and `dictation-failure-report.test.ts` run each report site
  for real: a dependency throws, and the test asserts the report's tags and that no user text
  left. `tests/unit/ipc-handler-report.test.ts` drives the IPC wrap and pins its install in
  `index.ts`. `tests/unit/error-reporting-chokepoints.test.ts` keeps the MCP tool proxy and the
  phone router, and `tests/unit/error-reporting-feature-gaps.test.ts` keeps the sites no test can
  import. `tests/unit/handled-report.test.ts` pins the message, the latch, the cap, the dedupe
  and the expected-failure filter.
- **Test (breadcrumbs):** `tests/unit/sentry-breadcrumbs.test.ts` scans every line under a kept
  console tag for interpolated user content.
- **Review:** `/code-review` judges what a scan cannot: whether a `report-ok:` reason is true,
  whether a tag or context can carry user text, and whether a new data class is disclosed.
- **Gap:** an error handed to `.then(onFulfilled, onRejected)`, or passed on as a value
  (`onFailed(error)`), is out of the scan's reach. So is a catch that throws or reports on one
  branch and swallows on another: the scan passes a catch whose body throws or reports anywhere,
  because `if (isExpected(error)) return; throw error;` is the shape most catches rightly take.
  Whether the other branches are expected outcomes is review's call.

## Scope

Catch sites and handled-error reports in `src/main/**` and `src/renderer/**`. Uncaught errors
(Sentry's own handlers) and the Aptabase analytics events are out of scope.
