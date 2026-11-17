---
type: Audit
title: Test suite audit
description: "What the test suite and CI cost on 2026-11-02 and what each tier has caught: 37,794 tests and 16.8 minutes to green, set by one web demo job and the UI tier, with little true duplication. CI structure took a PR to 10 to 12 minutes; removals barely move it. Baseline, research with sources, every workflow's verdict, and the options rejected. A 2026-11-17 follow-up took a quiet PR from about 10 minutes to about 6: the UI tier loads a static bundle on CI, its shards are cut by measured time, and main no longer retests merged trees."
tags: [audit, testing, ci, performance]
sources:
  - resource: .github/workflows/ci.yml
  - resource: .github/workflows/package-smoke.yml
  - resource: .github/workflows/task-reap-real-processes.yml
  - resource: .github/workflows/codeql.yml
  - resource: .github/actions/tested-tree/action.yml
  - resource: playwright.config.ts
  - resource: vitest.config.mts
  - resource: scripts/tested-tree.mjs
  - resource: scripts/build-ui-bundle.mjs
  - resource: scripts/ui-shard-plan.mjs
  - resource: scripts/ui-shard-timings.mjs
  - resource: tests/ui/dev-server.ts
  - resource: tests/unit/test-value-budget.test.ts
---
# Test suite audit (2026-11-02)

The suite had grown to 2,296 test files and a pull request took a median 16.8 minutes to reach all
green. The question was what to keep, what to cut, and how to stop it drifting back.

**Verdict: the suite is not padded, and removing tests is the wrong lever for speed.** One job and
one tier set a PR's time. CI structure took a PR from about 17 minutes to 10 to 12 with no test
removed. Reading the eight biggest UI families found little true duplication, and removing all of it
saves about 15 seconds of wall clock. The trims are worth doing for upkeep and honesty, since seven
tests asserted their own copy of the logic and one of those contradicted production. They do not
make CI faster, and nobody should expect them to.

The rule this produced is `.claude/rules/test-value.md`. The per-file classification is in the
[test suite inventory](test-suite-inventory.md).

## Baseline

Measured on CI run 41391402821 and the run history since 2026-07-27.

| Tier | Files | Tests | CI test seconds | CI shape at the baseline |
|---|---:|---:|---:|---|
| Unit | 1,915 | 34,305 | 584 | 3 shards, 113-159s each |
| UI | 327 | 3,061 | 12,236 | 11 shards, 357-687s each |
| E2E | 51 | 121 | 739 | 5 shards, 84-153s each |
| Web demo | 3 | 307 | 971 | 1 job at 1 worker, 1,023s |

The notes `ci.yml` tuned against had gone stale: they said 21 jobs, a 226s pole and 360 unit files.

- **Time to green.** Across 120 merged PRs: p50 16.8 minutes, p90 20.3. The number of path-filtered
  workflows on a PR barely moved it (16.6 minutes with one workflow, 18.3 with five).
- **The pole.** The demo job ran 1,023s, 3 minutes under its timeout. It is not a required check, but
  `/pull-request` waits on every check, so it set the wait anyway. UI shard 3 came next, ending at
  795s. `command-terminal.spec.ts` alone is 943s of UI time.
- **The job cap.** The demo job took a PR to 22 jobs against GitHub Free's 20 and nothing noticed.
  Seven jobs started 85-208s late on a quiet account.
- **The macOS cap.** A lockfile PR started exactly 5 macOS jobs, the whole account's allowance, so a
  second one queued.
- **Cost.** The repo is public, so runner minutes are free. About 120 job-minutes per run costs slots
  and queue time, not money.
- **Push runs.** 563 push runs on main, 32 red. In 30 of the 32 the next push was green. About 12%
  of pushes have no PR behind them. `strict: true` plus rebase merge means a merged PR lands the
  tree its head was tested on.

## What each tier has caught

Ninety red CI attempts over 52 days, read from every attempt's log, including the earlier attempts a
rerun hides. A commit touching `src/` after the red marks it product-linked: the test ran beside a
real change, which is weaker than proof of a caught bug.

| Tier | Flake | Tests-only fix | Product-linked |
|---|---:|---:|---:|
| Unit | 0 | 13 | 23 |
| UI | 25 | 16 | 9 |
| E2E | 6 | 2 | 4 |
| Web demo | 1 | 5 | 2 |

- **Unit is the most honest tier:** no flakes on record and the most product-linked reds.
- **UI flakes concentrate.** `command-terminal.spec.ts` and `task-detail-maximize.spec.ts` account for
  15 of the 25.
- **Only 71 of 2,296 files went red at all,** so "has never failed" says nothing about a file. That is
  the reason it is no ground for removal on its own.
- **The web demo caught both of the `src/`-only fixes** among the last 39 PR reds. It stays on the PR
  path; the change was to how it runs.
- **Two suspected Windows-only catches were not.** The task reap red went green on a same-SHA rerun,
  and the shell-quoting red's Linux CI was cancelled by the next push, so it shows nothing unique.
  This workflow stays because a miss kills a user's app: its value is risk, not catch rate.
- **All 14 package-smoke reruns were runner faults:** 7 were electron-builder's `ETXTBSY` on the arm64
  leg, and the rest were install failures or cancellations.
- **CodeQL has never gone red,** and it has fixed 25 alerts with 5 dismissed. Run conclusions are the
  wrong measure for it, which is why its push trigger stays with no `tested-tree` gate.

## Research

**How do teams decide what a test is worth?** Software Engineering at Google separates a test's
size (the resources it uses) from its scope (the code it validates) and aims for about 80% narrow,
15% medium and 5% broad by count; this suite is 90.8, 8.1 and 0.3 by that count, plus the demo tier,
so its shape is healthy ([ch. 11](https://abseil.io/resources/swe-book/html/ch11.html)). The same
chapter calls an over-specified test brittle and says a test's value rests on the trust engineers
place in it. Test impact analysis reports high catch rates for a fraction of the runtime, but that
figure is a vendor's own ([Teamscale](https://teamscale.com/publications/2018-test-impact-analysis-detecting-errors-early-despite-large-long-running-test-suites.pdf)).
Mutation score is the usual yardstick for a test's fault detection, and running many mutants is what
makes it expensive ([Zhang et al.](https://personal.utdallas.edu/~lxz144130/publications/issta2013a.pdf)),
so it fits a disputed removal better than a routine gate.

**What belongs at each tier?** The rule's answer: the lowest tier that can fail for the reason the
bug would. Unit owns logic. UI owns what only a browser proves. E2E owns wiring a mock cannot stand in
for. A move down must keep what the higher test proved, which is why most of the candidates here
turned out to need source extraction first.

**What runs on every PR?** Everything, except where a measured fault history says otherwise. Playwright's
docs describe `--only-changed` as a heuristic that "might miss tests" and say to always run the full
suite afterwards ([CI guide](https://playwright.dev/docs/ci)). It is weaker still here, because UI
specs reach the app through Vite in a browser, so the import graph it reads does not include the
renderer. Vitest's `--changed` follows imports ([docs](https://github.com/vitest-dev/vitest/blob/main/docs/config/changed.md)),
and about 100 unit tests read source as text. Neither can gate a PR.

**How should a large suite be sharded and cached?** Playwright balances shards by test count, and only
`fullyParallel` splits a file ([sharding](https://playwright.dev/docs/test-sharding)). Vitest shards
with blob reports merged at the end ([features](https://github.com/vitest-dev/vitest/blob/main/docs/guide/features.md)),
which is what `ci.yml` already does. The job cap is the real limit: 20 concurrent and 5 macOS on Free,
raisable by a support ticket ([limits](https://docs.github.com/en/actions/reference/limits)).

**How should flaky tests sit beside a zero-flake policy?** Google's chapter says automatic reruns trade
CPU for engineering time and only delay the root cause, and that tests lose value as flakiness nears
1%. The policy stands: fix, rewrite or remove. There is no quarantine lane, which would hide a red
inside a green check, the shape `--fail-on-flaky-tests` was added to end.

**Skipped required checks.** A path-filtered workflow left pending blocks a PR that requires it
([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)), so these
stay not required, and each still costs a PR a fix round when it flakes.

## Every workflow and job

| Workflow or job | Verdict | Reason |
|---|---|---|
| `ci.yml` checks | keep | Fast, required, and holds the only protocol package build |
| `ci.yml` demo | keep, run at 3 workers | Caught real `src/` faults; 981s of test time divides by workers |
| `ci.yml` unit shards | keep, 3 to 2 | Far off the pole; the slot pays for demo |
| `ci.yml` UI shards | keep | The tier the wall clock is made of |
| `ci.yml` E2E shards | keep | Each spec holds wiring no lower tier has; a shard less adds a launch wave |
| `ci.yml` on push | gate on `tested-tree` | The tree already passed on its PR head |
| `cla.yml` | keep | Required, 10-17s |
| `codeql.yml` | keep on push, no gate | 25 alerts fixed; a PR never ran it |
| `deploy-demo.yml` | keep | Called by the release; runs the demo tier on deployed bytes |
| `macos-spawn-helper.yml` | keep, gate on push | Its C code otherwise first compiles on the release matrix |
| `package-smoke.yml` | keep, 3 legs on PRs, 5 nightly | Every rerun was a runner fault; `/release` reads the nightly |
| `publish-protocol.yml` | keep | Tag-driven publish |
| `release.yml` | keep | The release |
| `shell-quoting-posix.yml` | keep, gate on push | Its round trips run nowhere else |
| `shell-quoting-windows.yml` | keep, gate on push, one test added | Same; `windows-cmd-shim-multiline-prompt` ran nowhere |
| `task-reap-real-processes.yml` | keep, gate on push | Only real-process run of the macOS and Windows readers |
| `aspire-host-death.yml` | moved out of the reap workflow | A dispatch-only measurement showed as a skipped row on every run |

`package.json` left the reap and package-smoke path filters. `npm ci` fails when it disagrees with the
lockfile, so it only added scripts-only edits: 5 of 41 commits touching either file changed it alone.

## The classification

Every test file has a row in the [inventory](test-suite-inventory.md). A file is keep unless a review
or the evidence said otherwise: 311 are named as a rule's enforcement, and 71 went red in the window.
Agents then read the flagged families: the eight biggest UI families, the heaviest specs, every
single-file source pin, the adapter families, and all 51 E2E specs.

What the reviews proposed. [What was removed](#what-was-removed) has what survived the second read.

| Family reviewed | Tests | Removed | Folded | Moved down |
|---|---:|---:|---:|---:|
| command-terminal | 202 | 6 | 3 | 2 |
| conversation | 85 | 6 | 0 | 0 |
| dictation | 67 | 3 | 2 | 0 |
| changes | 116 | 2 | 1 | 0 |
| workflow | 191 | 1 | 2 | 0 |
| board | 139 | 4 | 3 | 0 |
| move-to-done | 37 | 2 | 1 | 6 |
| toast | 109 | 1 | 3 | 0 |

Most suspected overlap fell apart once both sides were read. Exact title overlap is 36 pairs across
3,010 UI tests. The tiling, expand and swap tests share a store with `command-terminal-host-arrangement`
but pin real geometry and frames. The background-silence cases in the toast specs guard three separate
`App.tsx` guards. Of about 60 tests that looked DOM-free, 19 held up once helpers were resolved. No E2E
spec is fully covered at a cheaper tier, which matches the earlier finding of no lossless migrations.

**Mirror tests** are the real find: seven unit tests that assert a local copy of the logic and so pass
whatever production does. `permission-mode-guard` still asserts behavior `task-move.ts` no longer has.
This is also the one shape no scan can catch, so `/code-review` holds it.

**Mutation pilot.** StrykerJS over `src/main/agent/shared/agent-detector.ts` killed 315 of 391 mutants
with the Claude, Gemini, Qwen and Copilot detector files, and the same 315 with the 81 shared tests
alone. Their 27 tests add no kills on the shared code. That proves nothing about each adapter's own
parser, so the answer is a table with one row per adapter, not a deletion. The run took two minutes
with `mutate` and `testFiles` scoped to the cluster, which is the cost that makes this usable for a
disputed removal.

**A gap the audit found:** Claude's real hook path has no end-to-end coverage. `mock-claude` writes
`events.jsonl` directly, so the `settings.json` hook commands never run. Only `mock-grok` runs its own.

## Before and after

Runs dispatched on a research branch, against baseline run 41391402821. The method rule says to
discard a run with over 20s of queue, so the two clean runs are the wall-clock numbers: one before
the trims and one with them all landed. The other two shared the account's job cap with another PR's
CI, and they are shown because that is also what a real PR meets. A dispatch has no CLA check, which
is one job fewer than a real PR.

| Measure | Before | Quiet, before trims | Quiet, final | Contended |
|---|---:|---:|---:|---:|
| Time to all green (s) | 1,026 | 590 | 709 | 707, 1,144 |
| Longest queue (s) | 210 | 21 | 14 | 101, 550 |
| Web demo job (s) | 1,023 | 442 | 514 | 523, 447 |
| Slowest UI job (s) | 687 | 566 | 694 | 697, 596 |
| Heaviest UI shard's test-seconds | 1,791 | 1,485 | 1,782 | 1,815, 1,564 |
| Job minutes per run | 122 | 104 | 114 | 118, 116 |
| Concurrent jobs on a PR | 22 | 21 | 21 | 21 |
| Tests | 37,794 | 37,794 | 37,449 | |

- **The demo job stopped setting the time.** It held at 442-523s at 3 workers with no flake in five
  runs, so the slowest UI job is the pole now.
- **The trims did not speed CI, as expected.** The final run is slower than the first clean one. The
  UI tier lost 64 tests, and its spread across these runs is noise that swamps them.
- **A merged PR's push run** drops from about 120 job-minutes to one short job, in the 10 of 14 recent
  pushes the gate would have skipped. The gate read real history correctly: all three direct pushes
  and the one PR whose pushed tree differed from its head still ran everything.
- **A contended account still queues.** The cap is per account, so a second PR's CI costs a run real
  minutes, as the 550s queue shows. Only a higher cap fixes that.

Removing tests is absent from this table on purpose. Unit, E2E and adapter trims change no job that
sets a PR's time, and the UI trims save about 15 seconds of wall clock.

## The flakes

Reading the failing commits changed this picture. Several reds predate fixes already on main, so the
stated rate overstates what is still open: the 15s drag timeouts in `task-detail-maximize.spec.ts`, and
the `step 1` and `Expand and Restore` failures in `command-terminal.spec.ts`, all ran on commits older
than the fixes that addressed them. What was still open:

- **`background-shell-idle.spec.ts`.** The child's 10s lifetime was the suspected cause and it was
  wrong: with a 60s lifetime the test failed just as often. The mock's detached child was a bare `node`
  process, which the watcher does not count as a shell, so it drained the session about 4s in with the
  child alive. The mock now starts a shell, as a real background Bash is.
- **`terminal-input-second-renderer.spec.ts`.** One keystroke sent before the port attached was lost
  for good. It now types until that window's own port echoes, which still proves the port.
- **`task-detail-maximize.spec.ts`.** A starved compositor can paint no frame during a hold, so a
  reading only such a frame can show is asked only of a run that sampled it. The hold itself is asserted
  from the DOM, so a removed hold still fails. Each skip is annotated, so a CI log shows how often.

Every pass here was on an unloaded Windows machine, which does not reproduce CI's load. Only CI's
red rate over the next weeks shows whether these held.

## What was removed

Everything on the sign-off list, on its recommended option. Each cut was read against the test said
to cover it, and that read overturned three, so those tests stayed.

| Tier | Before | After | Change |
|---|---:|---:|---|
| Unit | 34,305 | 34,027 | The dev tooling's tests went, and 22 UI tests arrived |
| UI | 3,061 | 2,997 | 40 removed or folded, 2 loop cases cut, 22 moved down |
| E2E | 121 | 118 | 4 duplicates of `event-bridge.test.ts` out, 1 new test in |
| Web demo | 307 | 307 | Unchanged |

- **UI trims.** 27 removed and 13 folded. `board-filter`'s title match, `knowledge-graph` :2380 and
  `sidebar-command-terminals` :819 stayed: each was the only assertion of what it covers.
- **Moved down.** The completion slice, the mock-only tests and the graph refresh are unit tests now,
  each shown to fail on a mutation. The other 47 candidates stayed in the UI tier, since each needed
  logic extracted from a component for about 15 seconds of wall clock.
- **Mirror tests.** `permission-mode-guard` and `use-terminal-scrollback` are deleted, since each
  contradicted production. The second was meant to be rewritten, but the logic is tangled in terminal
  and focus behavior, and real replay is covered by `terminal-replay-veil.spec.ts`. The other five run
  production code now. They found copies that had drifted in the split resize, the font race and the
  worktree revert.
- **Adapter tables.** `adapter-detectors.test.ts` replaces four files and now covers every adapter's
  binary name and parser, up from four adapters. `adapter-trust-removal.test.ts` replaces the copied
  cases. Rewriting that table found a real bug: Codex's `removeWorktreeTrust` deleted a user's explicit
  `"untrusted"`, which Gemini and Qwen protect. It now removes only the table it wrote.
- **Source pins.** The three `register-all` pins are behavior tests, and so are three of the four
  literal pins. `app-layout-render-scope` stays a pin, since a re-render claim needs a client renderer
  the unit tier does not have.
- **Dev tooling.** `eval-docs-reads` and `measure-docs-structure`, and `scripts/review-eval/`, each
  with its tests, 6,879 lines of test and script that nothing in `package.json`, a skill, a rule or a
  workflow used. The fan-out audit's section 17 numbers can no longer be rerun from this tree;
  git history holds the harness. The alternative was keeping `review-eval` for a future eval.
- **The gap.** `claude-hook-path.spec.ts` runs the real hook commands from `settings.json` through a
  shell on Linux and Windows, which nothing did end to end. Breaking the bridge path turns it red.

## Rejected options

- **`--only-changed` and `--changed` on the PR gate.** See Research. A missed test is a miss on main.
- **A merge queue.** It needs `merge_group` on every required workflow, and I could not confirm it for
  the Free plan: GitHub's 2023 changelog says all public repos owned by organizations, and the current
  docs do not say. 1,000 CI runs over 533 branches is a median of 2 per branch, and faster CI shrinks
  what a queue would save. Revisit if PRs spend real time waiting on `strict` rebases. Looked at
  again on 2026-11-17 with the same answer, for other reasons (see Follow-up).
- **A quarantine lane.** It keeps a flake green. See Research.
- **Removing push runs outright.** `/release` and `/merge-back` would each need a new path, and a hand
  push would get no CI. The gate keeps the run, so `/release` needed no change for it.
- **Skipping CI on docs-only PRs.** One of the last 99 merged PRs was docs-only.
- **Sharding the demo job.** Three workers took it to about 7 minutes with no new job, and it stopped
  being the pole. A second job would have spent a slot for nothing. Reversed on 2026-11-17: once
  the UI tier came down the demo was the pole again, and it runs as two shards (see Follow-up).
- **Folding the demo's cut veil into its cycle test and a session-clock divisor.** These were planned
  at 100s and 150-200s. Once the demo stopped being the pole they would have bought no wall clock, and
  `web-demo-parity.md` leans on both.
- **One browser per worker in `command-terminal.spec.ts`.** Built and measured, then reverted. The spec
  took 795s without it and 982s and 850s with it, so launches were not the cost, and a shared-page test
  in that file costs what a launching one does once `page.goto` is counted. This is the third pass to
  reach that answer. Read the spec's frame recording and drags before trying a fourth.
- **Moving tests to a nightly lane.** Beyond the two package legs, no test's fault history supports
  it, and a nightly red reaches main first.
- **Reading every test file.** 800,000 lines for a list the signals already narrow, against a finding
  that duplication is rare.

## Follow-up: 2026-11-17

Two weeks on, a PR took about 13 minutes to go green again, and a PR in the Merge column paid that
twice, since it rebases onto each merge ahead of it. 450 test files had been added: 405 unit, 35 UI,
8 E2E and 2 demo. The question this time was only the wait.

**Verdict: the wait was how a UI test loads the app, not how many tests there are.** Serving the UI
tier a static bundle on CI cut its test time by 41% with no test changed. Combining and removing
tests on top of that bought another 6%, which is the first audit's finding again.

### What set the time

Measured over 30 green PR runs and 40 pushes to `main`, 2026-11-09 to 11-17, plus two runs
dispatched on the untouched branch.

- **A UI test paid about 3 seconds to boot.** The tier loaded the app from the Vite dev server: 759
  source modules, each its own request, into a browser context with no cache, from one
  single-threaded server the shard's three workers share. A test that makes three assertions took
  3.7s, and about 2,300 of the tier's 3,425 tests boot per test.
- **`main` tested 13 of 31 merged trees a second time.** `cla.yml` runs again when a PR closes, the
  `tested-tree` gate read the PR head at that moment, and an unfinished check meant "run
  everything". That was 21 jobs for 11 to 20 minutes, started as the next PR in Merge rebased and
  needed the same 20 slots.
- **Queueing.** 26 of 30 runs had shards start more than 20s late. The worst waited 16 minutes.
- **Shards cut by test count.** One run's eleven UI shards held 799 to 1,675 test-seconds.

Not the cause: setup and caching (about 30s a job, every cache a hit), docs-only PRs (none of the
last 40 merged), and Vitest's configuration. 60% of a unit shard is the tests themselves, and
Vitest's own estimate for `isolate: false` is 40s a shard, against 912 files that use `vi.mock`.

### What changed

- **The gate stopped reading the CLA check** (`scripts/tested-tree.mjs`). It says who signed, not
  whether the tree works.
- **The UI tier runs against a static bundle on CI** (`scripts/build-ui-bundle.mjs`, served when
  `KANGENTIC_UI_BUNDLE=1`). It is the development app, built with `NODE_ENV=development` and a
  development mode, so `window.__zustandStores` and every other test hook is in it and a release
  build still has none. It builds in 6 to 9s a shard. Local runs stay on the dev server. A spec that
  imported a module by its source path in the page reads it from `window.__kangenticTestModules`
  instead. Six specs need the dev server itself and load from `DEV_SERVER_URL`, after one warm-up
  boot.
- **UI shards are cut by measured time** (`scripts/ui-shard-plan.mjs` over
  `tests/ui/shard-timings.json`). The `checks` job proves the plan against Playwright's own listing
  on every PR, because a `--test-list` line that matches no file is not an error.
- **Two job slots moved to the pole,** inside the same 21. E2E went from 5 shards to 3, the unit tier
  from 2 to 3, and the web demo from one job to 2 shards behind a gate.
- **Tests.** Tests that booted the same seed and only read are one test with a `test.step` each,
  which removed about 120 page boots across 34 spec files. 16 tests were removed as duplicates of a
  named test, and one that evaluated only the mock moved to the unit tier. About 70 seconds of fixed
  sleeps and observation windows now end on a condition. The UI tier went from 3,425 tests to 3,314.

### Before and after

Before is the range over the 30 PR runs and the two baseline runs. After is the range over the
runs dispatched on the branch once the bundle was in place.

| Measure | Before | After |
|---|---:|---:|
| Slowest UI shard, job (s) | 541 to 787 | 348 to 389 |
| Slowest UI shard, test step (s) | 517 to 754 | 303 to 344 |
| UI test steps, all eleven shards (s) | 4,320 to 4,838 | 2,575 to 2,742 |
| UI test-seconds a run | 12,355 | 6,841 |
| Web demo (s) | 441 to 613, one job | 248 to 337 a shard |
| Unit shard (s), before its 35s gate | 216 to 330 | 165 to 241 |
| E2E job (s) | 120 to 190 on 5 shards | 143 to 253 on 3 |
| Lint, typecheck, build (s) | 124 to 173 | 152 to 206 |
| Job-seconds a run | 6,581 to 7,775 | 5,060 to 5,070 |
| Concurrent jobs on a PR | 21 | 21 |
| UI tests | 3,425 | 3,314 |

**A PR's wait went from about 10 minutes to about 6, which is 40% and not the half that was asked
for.** On a quiet account the wait is the slowest job plus a gate of a few seconds. Before, the
quiet runs took 581 to 661s. After, the slowest job took 348 to 389s. No run after the change was
quiet, since other tasks on the board were using the same 20 slots, so the after figure is the
slowest job and not a measured total. The UI tier's own work fell by 45%. What is left is spread:
the eleven UI test steps average 245s and the slowest runs 303 to 344s, on shards planned to hold
the same work.

- **Balancing by time did nothing while the tier was on the dev server.** The rebalanced run's
  slowest shard spent 539s in tests, against 517 to 544 before. Its shards were planned at 1,123
  test-seconds each and ran 897 to 1,492, because on the dev server a spec's cost depends on its
  neighbours: `agent-monitor.spec.ts` took 383s beside other boot-heavy specs and 239s in the run
  its timing came from. On the bundle it takes 144s wherever it runs, so the plan needs the bundle.
- **The slowest shard is partly a draw.** In one bundle run a shard ran every spec it held 36 to 68%
  slower than the timings, on a plan that gave it the same work as the others. The first web demo
  shard ran the same 183 tests in 581 test-seconds in one run and 748 in the next. That is a slow
  runner, and no plan removes it.
- **A fourth UI worker is worth about 20s a shard.** The eleven test steps summed to 2,430s at 4
  workers against 2,655s at 3. Not taken on one run: the project went from 4 to 3 once already
  because load tipped it (see the note in `playwright.config.ts`). It is the next thing to try,
  with three runs per count.
- **Combining tests is worth what the first audit said.** 7,282 test-seconds became 6,841.
- **In bundle mode the dev server starts cold.** Nothing else loads from it, so the first of the
  six specs paid its whole cold start inside a 15s test. `stats-lazy-retry.spec.ts` flaked that way
  in two of four runs until `warmDevServer` (`tests/ui/dev-server.ts`).
- **The job checks grew by about 40s.** `checks` lists the UI project twice to prove the shard
  plan. It is still the shortest job.
- **One E2E test could not fail for its title.** "engine retry succeeds when the agent swallows the
  first \r" in `tests/e2e/browser-evidence-retry.spec.ts` slept 7s and asserted that a capture
  file existed, which is written before the paste. Given the assertion its own comment described,
  no error strip, it failed on CI in both runs that had it: the mock agent answered the retried
  Enter with 25 bytes, and since 2026-05-03 the paste engine takes output as proof of a submit
  only past 50. On Linux the send ended in "Paste landed but Enter did not submit" and the test
  passed anyway. The fixture now replies with a line longer than the floor. The engine did not
  change.

The contended numbers are not in the table. Every run here shared the account with other PRs, and
their totals ran from 700s to 1,735s on queue alone. What a contended PR gains is the 25% fewer
job-seconds and a `main` that no longer starts 21 jobs after a merge.

### A merge queue, looked at again

Not now. The repository qualifies (public, owned by an organization), but:

- `/merge-pull-request` merges with `gh pr merge --admin --rebase`, and `--admin` bypasses a queue.
  It uses `--admin` because branch protection requires one approving review that a sole maintainer
  cannot give. A queue needs that rule dropped or met, which is a branch protection change.
- `ci.yml` and `cla.yml` would each need a `merge_group` trigger, and the `tested-tree` gate would
  have to accept a tree the queue tested.
- Two queue builds cannot run side by side inside a 20-job cap, so the gain would be batching
  several waiting PRs into one run.

With a run at about 6 minutes and `main` quiet after a merge, a PR in Merge waits one short run.
Revisit if Merge stays stack up anyway.

### Not done

- **Path filters for docs-only PRs.** None of the last 40 merged PRs was docs-only, and the unit
  tier reads `docs/`.
- **A third web demo shard.** It would take a UI slot, and ten UI shards land where the demo is now.
- **Skipping the typecheck in the E2E shards' `npm run build`.** About 20s on a job under the pole,
  in the script the release builds through.
- **`isolate: false` for Vitest,** and **one browser per worker.** See above and Rejected options.

## When to revisit

- **A UI shard or a web demo shard passes 7 minutes.**
- **One UI shard runs about 25% past the average in several runs.** Refresh the timings with
  `node scripts/ui-shard-timings.mjs <run-id>`. If `tests/unit/ui-shard-plan.test.ts` then names a
  spec heavier than an average shard, split it.
- **The job budget test fails.** Give a slot up, or lift the cap with a support ticket or a paid plan.
- **Median PR time to green passes 9 minutes again.**
- **A spec passes on the dev server and fails on CI.** Run it with `npm run test:ui:bundle`.
- **The `hold-unsampled` annotation becomes common.** It means the runner is too starved for these
  readings. Read the shard's utilisation before the spec.
- **A flake recurs in the specs above.** Their fixes are unproven under CI's load.
