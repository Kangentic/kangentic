---
paths:
  - "tests/**"
  - "src/main/pty/**"
  - "src/main/agent/**"
  - "src/main/git/**"
  - "src/main/**/*path*"
---

# Rule: code and tests must behave identically across Windows, macOS, Linux, and CI

The team develops and dogfoods on Windows, but CI runs its checks (typecheck, build,
lint, unit, UI, and E2E tests) on **headless Linux** (`ubuntu-latest`; the E2E/electron tier under
xvfb). Anything that silently depends
on the local OS therefore passes on a developer's machine and fails only in CI, where it is
slowest and most expensive to diagnose. This bit us with four UI tests (the Ctrl+N hotkey and the
three split-divider drag tests) that were green on local Windows and red on every CI run because
they leaned on OS-specific timing, cross-test state, and pixel-exact layout. Production code has
the mirror risk: a hardcoded separator or shell assumption runs fine where it was written and
breaks on the next platform.

## The rule

### Code (any committed source)

- **Never hardcode platform-specific values.** Build paths with `path.join` / `path.sep`, never
  literal `\` or `/`. Derive locations at runtime (`app.getPath`, `configDir`, `__dirname`, env
  vars), never machine-absolute paths. See [[no-personal-info]].
- **Guard OS-specific branches explicitly** on `process.platform` and handle all three of
  `win32` / `darwin` / `linux`. Shell, PTY, and CLI-argument construction must account for
  PowerShell quoting, WSL exe/arg splitting, and POSIX shells (the patterns the `platform-guard`
  agent checks).
- **File operations are Windows-aware:** `fs.rmSync` / `fs.rm` use `{ force: true }` (and
  `{ recursive: true }` for trees) because Windows locks open files. Do not assume an unlink
  succeeds while a handle is open.
- **Line endings:** author with `\n`; never assert on or emit `\r\n` literally. Let git's
  normalization handle CRLF.

### Tests (unit, UI, E2E)

A test must pass on CI's headless Linux runner, not merely on local Windows. Concretely:

- **No cross-test state leakage in a shared-page suite.** Each test owns its setup: open the
  panel/dialog it needs from a known state rather than relying on a previous test leaving it
  open. A single flaky interaction must never cascade into later failures. (This was the
  split-divider root cause.)
- **No pixel-exact or zero-tolerance layout assertions.** Scrollbar widths, font metrics, and
  sub-pixel rounding differ between Windows and headless Linux. Assert on programmatic state (a
  store value, a data attribute) when one exists; when asserting geometry, use a real tolerance,
  never `toBeLessThan(exactValue)` against a freshly measured float.
- **No OS-dependent timing assumptions.** Wait for the condition (`expect.poll`,
  `locator.waitFor`, `toBeVisible`/`toBeHidden` with a timeout), never a bare
  `waitForTimeout`. A control mounted "just now" on a fast local machine may attach its listeners
  a tick later under CI load: poll for the effect.
- **Real input is read from live geometry.** Read an element's `boundingBox` immediately before a
  drag/click, confirm the container has non-zero width, and prefer asserting the *effect* via
  state over re-measuring pixels.
- **No machine-specific paths or personal info** in fixtures (use `C:\\Users\\dev`, `/mock/...`).
  See [[text-formatting]] for the em-dash ban that also applies to authored test text.
- **Test filesystem writes stay under `os.tmpdir()`.** Derive every write target from
  `fs.mkdtempSync(path.join(os.tmpdir(), ...))` or a mocked home directory. Never pass a
  hardcoded absolute root (`/projects/...`, `C:\\...`) to a write call (`mkdirSync`,
  `writeFileSync`, `rmSync`, `mkdtempSync`, and the like): it is writable on a developer's
  Windows drive but `EACCES` on CI's Linux runner, where `/` is the unwritable filesystem root.
  This is green locally and red on every CI push. A `cwd:` / `path:` string passed to a command
  builder or pure path function is fine; the ban is on actual on-disk write arguments.

## Enforcement (self-maintaining)

- **CI is the mechanical backstop for tests (primary):** the `unit`, `ui`, and `e2e-shards` jobs run
  the unit, UI, and E2E (electron, under xvfb at workers=4) tiers on `ubuntu-latest` on every push
  (`.github/workflows/ci.yml`), so a Windows-only-green test now fails CI at every tier - including
  E2E, which previously ran only on local Windows. This is the load-bearing guarantee; keep the UI
  and E2E gates in the required checks.
- **Author-time guard for test fs writes (runs locally on Windows AND Linux):**
  `tests/unit/test-fs-writes-sandboxed.test.ts` statically scans `tests/**` for a write call
  (`mkdirSync`, `writeFileSync`, `rmSync`, `mkdtempSync`, and the rest) whose first argument is a
  hardcoded absolute string literal, and fails before the test ever runs. It rides the unit tier,
  so it runs on CI as a PR check (caught and fixed by the Testing column's `/pull-request`
  monitor-and-fix loop) and also locally in `/merge-back` Step 0 for a direct push and in a manual
  `/test` run. Because it is a static scan it flags the absolute-write subclass on any OS, without a
  Linux runner, closing the "green locally, red on CI" gap that let `main` go red by design.
- **Review for code:** the `platform-guard` agent audits `src/main/pty`, `src/main/agent`,
  `src/main/git`, and any `path` / `fs.rm` / `child_process` usage for the code rules above
  (hardcoded `C:\\Users\\`, missing platform guards, missing `{ force: true }`, em-dashes).
  `/code-review` flags the test-fragility patterns on changes under `tests/`.
- **Specialist:** the `test-builder` agent encodes the Windows/CI quirks (workers=1 lock,
  single-instance bypass, scrollback races) and is the right tool for de-flaking an
  environment-sensitive test.

The one fs-write subclass excepted, mechanical coverage of the test-authoring conventions is
intentionally CI itself (run the tests on Linux) rather than a static scan, because "depends on
cross-test state" and "pixel-exact assertion" are not reliably detectable by a lint rule. The
read-trigger gap (a brand-new test file does not pre-load this rule) is closed for absolute
writes by the fs-write guard above, which scans the file whether or not the rule loaded, and for
the un-mechanizable conventions by that same CI backstop: a fragile new test is caught the first
time it runs on Linux.

## Scope

Committed source under the platform-sensitive `src/main/` subsystems (pty, agent, git, path
handling) and all of `tests/`. Marketing capture fixtures (`tests/captures/`) that intentionally
pin OS-specific rendering for screenshots are exempt from the geometry-tolerance conventions.
