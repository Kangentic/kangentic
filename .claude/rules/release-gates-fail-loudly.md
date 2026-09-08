---
paths:
  - ".github/workflows/**"
  - "scripts/build.js"
  - "vite.config.mts"
---
# Rule: a release gate fails, it never skips quietly

A gate that stops doing its job without saying so is worse than no gate, because it still reads as
coverage. This has now cost three releases across two failure modes. v0.35.0 split three ways
because build success proved nothing about what was attached to the release. v0.37.0 and v0.38.0
shipped with zero sourcemaps and zero native debug files: the `KANGENTIC_SENTRY_TOKEN` secret had never been created,
so both upload gates read falsy and no-opped, and separately the Sentry bundler plugins skip their
upload whenever `NODE_ENV` is not `production`, logging that only at debug level and deleting the
sourcemaps anyway. Every job reported success throughout. The cost lands later, on whoever tries to
read `Si`, `b`, `cc` in a minified stack.

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
- **A job named in `needs:` is also named in `if:` whenever that `if:` contains `always()`.**
  `always()` overrides GitHub's implicit "skip me if a dependency failed", so a `needs:` entry
  missing from the condition lets the job run when its dependency FAILED. This is the specific shape
  that let three matrix legs race past a broken barrier.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/release-workflow-gates.test.ts` parses
  `.github/workflows/release.yml` and fails when any `always()` job has a `needs:` entry its `if:`
  does not reference, when the draft release stops depending on `preflight-symbols`, when that
  preflight stops being able to fail (`exit 1`) or acquires an `environment:` approval gate, or when
  `release` loses the clause it inherits the gate through. It also pins the two shapes v0.39.0
  broke: `create-draft-release` must be able to FAIL on a release that is already published and
  incomplete (rather than reusing it, which lets electron-builder skip every upload while the
  builds still exit 0), and the rpm and deb upgrade gates must resolve their baseline from the
  release LIST excluding this build's own tag, never from `/releases/latest`, which returns the
  release under construction the moment anything publishes it. Runs via `npm run test:unit`.
- **Test (mechanical, CI):** `tests/unit/upload-native-debug-files.test.ts` pins the build-side
  (esbuild/main+preload) half: the skip line is printed, a present-token upload failure throws, the
  `NODE_ENV` guard rejects unset and non-production values, and `resolveSentryReleaseName` throws
  on a missing or empty `version`.
- **Test (mechanical, CI):** `tests/unit/vite-config-sentry-guards.test.ts` pins the mirrored
  renderer half in `vite.config.mts`: `resolveSentryVitePlugins` throws unless `NODE_ENV` is
  `production`, and `resolveSentryReleaseName` throws on a missing or empty `version` - both
  reached by calling the config module's default export directly (`defineConfig` returns it
  unchanged), since neither function is otherwise exported.
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
