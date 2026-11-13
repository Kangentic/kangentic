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
  (`pathFreeCopy`). Never send `error.message`. A `TypeError`, `RangeError` or `ReferenceError`
  message may go in contexts, cut to 200 characters (`diagnosticContextOf`); a `SyntaxError`'s
  never goes anywhere, since `JSON.parse` quotes the input.
- **Tags are short enums.** A stage, a cause, an agent name, an errno. Never a task title, a path,
  a channel's argument, a column or automation name, a URL host (an artifact domain collapses its
  tenant label: `*.sharepoint.com`), or free text.
- **Skip what is not a defect.** `isExpectedFailure` covers shutdown, aborts,
  `UserConfigurationError` and its `RefusalError`, the named expected classes, and network
  failures. A refusal main throws to the renderer is a `RefusalError`, never a plain `Error`.
- **Fingerprint environment failures, leave code defects to stack grouping.** An errno or
  `SQLITE_` failure groups as `['handled-env', name, code]`. A code defect gets no custom
  fingerprint: Sentry groups it on its in-app frames. Never put an IPC channel or a tool name in
  a fingerprint. The one exception is a source whose frames cannot split an issue: a preload push
  callback's error crosses the context bridge with only the preload's frames, so it groups by
  API method (`['preload-callback', method]`).
- **Latch once per key per run, at most about 25 keys per chokepoint.** The reporter does it.
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
- **Test (chokepoints):** `tests/unit/error-reporting-chokepoints.test.ts` and
  `tests/unit/ipc-handler-report.test.ts` pin each chokepoint's call to its reporter and the IPC
  wrap's install in `index.ts`; `tests/unit/error-reporting-feature-gaps.test.ts` pins the feature
  sites; `tests/unit/handled-report.test.ts` pins the message, the latch, the cap, the dedupe and
  the expected-failure filter.
- **Test (breadcrumbs):** `tests/unit/sentry-breadcrumbs.test.ts` scans every line under a kept
  console tag for interpolated user content.
- **Review:** `/code-review` judges what a scan cannot: whether a `report-ok:` reason is true,
  whether a tag or context can carry user text, and whether a new data class is disclosed.
- **Gap:** an error handed to `.then(onFulfilled, onRejected)`, or passed on as a value
  (`onFailed(error)`), is out of the scan's reach.

## Scope

Catch sites and handled-error reports in `src/main/**` and `src/renderer/**`. Uncaught errors
(Sentry's own handlers) and the Aptabase analytics events are out of scope.
