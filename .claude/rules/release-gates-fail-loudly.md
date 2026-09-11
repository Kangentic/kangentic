---
paths:
  - ".github/workflows/**"
  - "scripts/build.js"
  - "vite.config.mts"
---
# Rule: a release gate fails, it never skips quietly

A gate that stops doing its job without saying so is worse than no gate, because it still reads as
coverage. This has now cost four releases across three failure modes. v0.35.0 split three ways
because build success proved nothing about what was attached to the release. v0.37.0 and v0.38.0
shipped with zero sourcemaps and zero native debug files: the `KANGENTIC_SENTRY_TOKEN` secret had never been created,
so both upload gates read falsy and no-opped, and separately the Sentry bundler plugins skip their
upload whenever `NODE_ENV` is not `production`, logging that only at debug level and deleting the
sourcemaps anyway. Every job reported success throughout. The cost lands later, on whoever tries to
read `Si`, `b`, `cc` in a minified stack. The rpm upgrade gate then passed a re-run of v0.39.1 after
v0.40.0 had shipped: its baseline was the newest tag that was not its own, dnf downgraded 0.40.0 to
0.39.1 without complaint, and `rpm -q` confirmed the version it was asked about.

## The rule

Any step in the release path that exists to guarantee something must fail when it cannot.

- **A missing precondition fails the release, it does not skip it.** If a required secret or
  environment value is absent, exit non-zero with an `::error::` naming what to set and where. Do
  not warn and continue. Put the check in a preflight job the build depends on, so it costs seconds
  rather than a 90-minute matrix.
- **State the branch taken, on every run.** A step that can no-op prints which way it went, at
  normal log level. Silence is indistinguishable from success.
- **Assert the positive condition, not the absence of a known-bad one.** `NODE_ENV !== 'production'`
  catches "nobody set it", which is the failure that actually ships; `NODE_ENV === 'development'` is
  unreachable wherever the value is pinned upstream, and passes while doing nothing.
- **An attempted-and-failed operation is fatal when it was intended.** If a token is present, an
  upload was meant to happen: throw rather than log. Reserve non-fatal warnings for genuinely
  optional work.
- **A job named in `needs:` is also named in `if:` whenever that `if:` contains a status-check
  function.** GitHub implies `success()` on a job whose `if:` names none, and that implied gate is
  what skips the job when a dependency failed. Naming `always()`, `cancelled()`, or `failure()`
  replaces it, so a `needs:` entry missing from the condition lets the job run when its dependency
  FAILED. This is the specific shape that let three matrix legs race past a broken barrier. It is
  not only `always()`: `!cancelled()` reads like a cancellation guard and does the same thing, and
  both publish jobs use it.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/release-workflow-gates.test.ts` parses
  `.github/workflows/release.yml` and fails when any job whose `if:` carries a status-check
  function (`always()`, `cancelled()`, `failure()`) has a `needs:` entry its `if:` does not
  reference, when the set of such jobs stops matching the four that exist (an empty filter would
  otherwise reduce that check to zero test cases and pass), when the draft release stops depending
  on `preflight-symbols`, when that preflight stops being able to fail (`exit 1`) or acquires an
  `environment:` approval gate, or when `release` loses the clause it inherits the gate through.
  It also pins the two shapes v0.39.0 and v0.40.0 broke:
  `create-draft-release` must be able to FAIL on a release that is already published and
  incomplete (rather than reusing it, which lets electron-builder skip every upload while the
  builds still exit 0), and the rpm and deb upgrade gates must resolve their baseline as the newest
  published release whose version is numerically LOWER than the build's. Never from
  `/releases/latest`, which returns the release under construction the moment anything publishes
  it, and never as merely the newest tag that is not the build's own, which on a re-run of an older
  tag hands the gate a downgrade: apt refuses it (red, correct) and dnf performs it (green, wrong).
  The test pins the whole jq program as text and also runs it through a real jq against release
  lists shaped like both incidents, since a text pin cannot tell a rule from its predecessor. That
  execution is itself gated on jq being on PATH, so the test asserts jq IS present whenever `CI` is
  set: a runner image that stopped shipping it would otherwise skip every executed case and still
  report green. The step's own version is asserted rather than regex-gated like the API tags,
  because dropping it would leave nothing to compare against. Runs via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/upload-native-debug-files.test.ts` pins the build-side
  (esbuild/main+preload) half: the skip line is printed, a present-token upload failure throws, the
  `NODE_ENV` guard rejects unset and non-production values, and `resolveSentryReleaseName` throws
  on a missing or empty `version`.
- **Test (mechanical, CI):** `tests/unit/vite-config-sentry-guards.test.ts` pins the mirrored
  renderer half in `vite.config.mts`: `resolveSentryVitePlugins` throws unless `NODE_ENV` is
  `production`, and `resolveSentryReleaseName` throws on a missing or empty `version` - both
  reached by calling the config module's default export directly (`defineConfig` returns it
  unchanged), since neither function is otherwise exported.
- **Test (mechanical, CI):** `tests/unit/verify-unpacked-worker.test.ts` pins the packaged
  embed-worker gate in `build/verify-unpacked-worker.js` (run from `build/afterPack.js`): it
  throws with the child's stderr when the worker's externals do not load from the
  `app.asar.unpacked` tree, it logs the verified branch on success, and its probe fences module
  resolution to that tree, proven with a real child `node` against a dependency that exists only
  above the root (the shape that would otherwise pass locally, where the repo's own `node_modules`
  sits above `out/`, and fail on every install). 0.38.0 and 0.39.0 shipped a worker that exited 1
  on every fork with no gate in the way.
- **Review:** `/code-review` covers the parts that are judgement rather than shape, mainly whether a
  newly added step that can no-op says so.

The general form ("does this step warn where it should fail") is not mechanizable, so the tests
above deliberately pin the concrete shapes that have already broken a release rather than
attempting the general case.

## Scope

The release path: `.github/workflows/release.yml`, `scripts/build.js`, `vite.config.mts`, and the
scripts they call. It does not govern ordinary application error handling, where continuing past a
recoverable failure is usually right. `.claude/skills/release/SKILL.md` carries the pre-tag half,
since on a tag push the tag exists before any workflow runs.
