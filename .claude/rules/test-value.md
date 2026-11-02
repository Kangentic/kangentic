---
paths:
  - "tests/**"
  - ".github/workflows/**"
  - "playwright.config.ts"
  - "vitest.config.mts"
---
# Rule: what earns a test, and what earns a CI job

A suite of 2,296 test files reached 17 minutes to green with nothing watching its cost: the web demo
job took CI past GitHub Free's job cap with no one deciding that, and seven jobs queued behind it. An
audit (`docs/audits/test-suite-audit.md`) found the suite was not padded. The waste was in structure,
and in a smaller set of tests that could not fail for the reason they exist: seven asserted their
own copy of the logic, and one of those still passed after production changed. This rule keeps both
from growing back.

## The rule

### The tier

Pick the lowest tier that can fail for the reason the bug would.

- **Unit (`tests/unit/`):** logic, parsers, stores, state machines, and repo conventions. This is the
  default. A test costs milliseconds and the tier has no flakes on record.
- **UI (`tests/ui/`):** what only a browser proves: layout, focus, keyboard, drag, portal clipping,
  and a visible state. Never a test whose whole body evaluates a store.
- **E2E (`tests/e2e/`):** real wiring a mock cannot stand in for: a PTY, `fs.watch`, a restart, a kill,
  a real worktree. Name that wiring in the spec's header.
- **Demo (`tests/demo/`):** what only the built web bundle proves. See `web-demo-parity.md`.

A behavior belongs to one tier. The lower tier owns the logic, and a higher tier keeps one test that
proves the wiring, not a copy of the logic's cases.

### The bar for a test

- **Say what a user or a rule loses if it goes.** A test nobody can name that for does not get added.
- **Run the real code.** A test never asserts its own copy of the logic. A copy passes whatever
  production does. If the logic is trapped in a hook or a component, extract it and import it.
- **Read source text only to check a convention across files,** or where the file cannot be imported
  (`src/main/index.ts`, `scripts/dev.js`). A pin of one importable file's literal code is a behavior
  test waiting to be written.
- **Assert behavior, not a re-statement of the code.** Google's name for the failure is a brittle test
  that over-specifies its outcome: it breaks on a harmless refactor and catches nothing.
- **Never remove a test only because it has not failed.** Risk outranks catch rate. A rarely red test
  stays when a miss is expensive, such as a reader that decides which process to kill. To remove one,
  name what else asserts the behavior, and read that test.
- **A flake is fixed, rewritten or removed.** No quarantine lane, and no per-spec `retries`:
  `--fail-on-flaky-tests` makes a pass on retry a failure anyway. The one exception is a race that
  exists only on Windows, whose local runs have no retry. That one is gated on `process.platform`.

### The bar for a CI job or workflow

- **Cost is slots, not minutes.** The repo is public, so standard runners are free. What is scarce is
  20 concurrent jobs and 5 macOS jobs for the whole account. Spend one by giving one up.
- **A check that is not required still costs a PR.** `/pull-request` waits on every check and fixes
  anything red. A path-filtered check that flakes costs an unrelated PR a fix round, and a slow one
  sets its time to green. Count both.
- **Name what it catches that nothing else can.** A new workflow says so in its header, along with
  what it costs and why it is not required.
- **Filter on the lockfile, not `package.json`.** `npm ci` fails when they disagree, so `package.json`
  alone adds only scripts-only edits.
- **A PR-gated workflow on `push` carries the `tested-tree` gate.** A merged PR lands the tree its head
  passed on, so a second run can only find a flake. A direct push still runs everything.
- **A check off the PR path fails loudly somewhere.** A nightly leg is read by `/release` before a tag.
- **`--only-changed` and `--changed` never gate a PR.** Playwright documents the first as a heuristic
  to run ahead of a full run. UI specs reach the app through Vite in a browser, so its import graph
  cannot see a source change. Vitest's graph cannot see the tests that read source as text.
- **Measure a CI change by paired runs.** Identical code has spread 231-357s. Use at least three runs
  against the same commit, decide on max per-shard aggregate test-seconds, and discard a run with
  over 20s of queue, since the cap is account-wide.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/test-value-budget.test.ts` fails when `ci.yml`'s concurrent
  jobs plus the CLA check pass 21, when the workflows one lockfile edit starts on a PR take more than
  5 macOS jobs, when a PR-gated workflow runs on `push` to main without the `tested-tree` gate or an
  allowlisted reason, when a spec sets `retries` other than on Windows, and when `test-builder`'s
  worker counts stop matching `playwright.config.ts`. Each case mutates a real workflow in memory, so
  a collector that stopped matching fails rather than passes.
- **Test (mechanical, CI):** `tests/unit/tested-tree.test.ts` runs the gate's decision through every
  way it must keep running the tests, and fails on a job in a gated workflow that does not answer to
  it. `tests/unit/ci-workflow-hygiene.test.ts` pins `--fail-on-flaky-tests` and the path filters.
- **Review:** `/code-review` judges what no scan can: whether a test can fail for the reason it
  exists, whether a new test is a mirror or a literal pin, and whether a job names what only it
  catches. Mutation testing settles a disputed removal: run StrykerJS with `mutate` on the shared code
  and `testFiles` with and without the cluster, and compare kills (`docs/audits/test-suite-audit.md`).
- **Gap:** nothing stops a mirror test mechanically, since a test with a local copy looks like any
  other test.

## Scope

Tests under `tests/`, `.github/workflows/`, and the two runner configs. Existing tests are not
findings: the audit classified them, and a test kept there needs no new justification. Marketing
captures under `tests/captures/` are not tests of behavior and are out of scope.
