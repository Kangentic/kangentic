---
name: release
description: Version bump, changelog, tag, push release, and mark the Sentry issues it fixes
disable-model-invocation: true
---

# Release

Release pipeline: version bump, changelog generation, git tag, and push to trigger the release workflow.

**Usage:** `/release [patch|minor|major]`

- `/release` -- derives the bump type from commit history and applies it, stopping only for a major
- `/release patch` -- bump 0.1.0 to 0.1.1
- `/release minor` -- bump 0.1.0 to 0.2.0
- `/release major` -- bump 0.1.0 to 1.0.0

**Release type (optional):** $ARGUMENTS

This command does NOT use `/merge-back`. The release flow is fundamentally different: no rebase, creates tags, and pushes to main directly.

## Where this runs

Every step operates on the MAIN checkout, even though the board usually hands the release task its
own worktree. Git is the easy half: pass `git -C <main> ...` everywhere. The cwd-sensitive commands
are the trap, because a bare `cd` is reset by the harness between tool calls. Run each of
`node scripts/verify-node-modules.js`, `npm ci`, `npm run typecheck`, `npx playwright test`,
`npm version`, and `node scripts/release-changelog.mjs` as one PowerShell call shaped
`Push-Location <main>; <command>`. `npm ci` is the one
that does damage rather than nothing: run it bare and it wipes the WORKTREE's `node_modules` while
the verifier in main still reports stale. Every Read, Glob, Grep, Edit, and Write path is a
main-checkout absolute path, and the `doc-auditor` agent is given the main-checkout root so it does
not audit a worktree copy of the repo.

The version bump is where getting this wrong is silent. An `npm version` that runs in the worktree
bumps the worktree's `package.json`, stages nothing in main, and ships a `vX.Y.Z` tag on the
PREVIOUS version. That is why Step 2 reads all three files back.

## Step 0 -- Determine Bump Type

1. **Find the previous tag:** Run `git describe --tags --abbrev=0 --match "v*"`. Note whether this
   succeeds or fails (no tags = first release).

   **`--match "v*"` is load-bearing, not decoration.** `@kangentic/protocol` ships on its own
   cadence from this same branch, so a `protocol-v*` tag is often the most recent reachable one.
   Without the filter this returns that protocol tag, and both this step and Step 3 then read a
   range that starts in the middle of the desktop release. Releasing v0.41.0 hit exactly this:
   the bare command returned `protocol-v0.14.0`, and three protocol releases had landed inside
   the real v0.40.0..v0.41.0 range. Nothing about the truncated output looks wrong, which is the
   whole problem. The changelog comes out short but plausible, and the bump derivation reads the
   same truncated range, so a minor can silently derive as a patch.
2. **Collect commits since last tag:** Run `git log <previousTag>..HEAD --oneline --no-decorate` (or `git log --oneline --no-decorate` if no previous tag).
3. **Analyze conventional commit prefixes to derive a bump type:**
   - Any commit with `!` after the type (e.g., `feat!:`, `fix!:`) or containing `BREAKING CHANGE` in the subject -- suggest **major**
   - Any `feat:` commit -- suggest **minor**
   - Only `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `perf:`, `ci:`, `build:` -- suggest **patch**
   - If no conventional prefixes found, fall back to keyword analysis (same as legacy): "Add"/"Implement"/"Create" = minor, "Fix" = patch, otherwise patch
4. **If `$ARGUMENTS` is `patch`, `minor`, or `major`:** use it directly and skip the derivation in point 3.
5. **First-release check:** If no previous tags exist and `$ARGUMENTS` is empty, read the current version from `package.json`, report "No previous releases found, releasing the current version as v{version}", and skip the version bump in Step 2 (tag the current version as-is). Do not ask. This branch is unreachable on Kangentic, which has released since v0.1.0; it exists for a fresh fork.
6. **Otherwise (no explicit argument): apply the derived bump and keep going.** Do not ask. Report
   what it derived and why, then proceed:
   ```
   Bump: minor (0.1.0 -> 0.2.0)
   Reason: 3 feat: commits, no breaking changes, since v0.1.0
   Commits: feat: add dark mode, feat: add notifications, fix: resolve crash
   ```
   The derivation in point 3 is deterministic, and the operator can force the answer any time by
   passing `/release patch|minor|major`, so a confirmation gate here only re-asks a question the
   commit log already answered. The gate also has a worse record than the rule. v0.40.0 was first
   tagged as a minor over a range carrying no `feat:` commits, where the rule alone would have said
   patch. Unwinding that took a tag deletion, a remote tag deletion, a draft release deletion, and
   a retarget to v0.39.1.

   **The one exception is major.** If the range contains a `!` commit or a `BREAKING CHANGE`
   subject, stop and report the specific commits rather than tagging it. A major is rare, it is the
   one bump a human almost always wants to weigh in on, and on a 0.x line it is the jump to 1.0.0.

## Pre-flight Checks

1. **Verify branch:** Run `git rev-parse --abbrev-ref HEAD`. Must be `main`. If not, stop with an error: "Release must run from the main branch."
2. **Verify clean tree:** Run `git status --porcelain`. Must be empty. If not, stop with an error: "Working tree must be clean before releasing. Commit or stash changes first."
3. **Fetch latest:** Run `git fetch origin main`
4. **Verify up-to-date:** Run `git diff HEAD origin/main --stat`. Must be empty. If not, stop with: "Local main is behind origin/main. Run `git pull` first."
5. **Verify dependencies:** Run `node scripts/verify-node-modules.js`. It compares
   `node_modules/.package-lock.json` against `package-lock.json` and prints which way it went.
   Act on its exit code with no judgment call and no prompt to the user:
   - **Exit 0:** the tree already matches the lockfile. Nothing to install. Continue.
   - **Exit 1 or 2:** the tree is stale or was never installed. Run `npm ci`, then re-run the
     verifier. If `npm ci` fails with EBUSY, stop with: "A file in node_modules is locked by a
     running process. Close the Kangentic dev server (`npm start`) and retry."

   Do not run `npm ci` unconditionally. It deletes `node_modules`, and the team dogfoods
   Kangentic from `npm start`, so on most releases the live dev server is running Electron out of
   the directory `npm ci` is about to remove. That made the step either fail with EBUSY or break
   the dev server, and turned a gate into a question the operator had to answer mid-release. The
   verifier answers the same question in milliseconds and writes nothing.
6. **Verify the Sentry symbol-upload secret:** Run `gh secret list --repo Kangentic/kangentic`.
   `KANGENTIC_SENTRY_TOKEN` must be listed. If it is not, stop with: "KANGENTIC_SENTRY_TOKEN is
   not set on the repo, so this release would ship with no sourcemaps and no native debug files.
   Add it as a repository secret, then re-run."

   This checks the GITHUB secret on purpose, not a local environment variable. Release builds run
   only on the CI matrix, so a local `KANGENTIC_SENTRY_TOKEN` says nothing about what the runners
   will see. The release workflow makes the same check in its `preflight-symbols` job, but on the
   normal tag-push path the tag already exists by the time that job runs. This step is the only
   one that can stop the tag from being created at all.
7. **Verify the target version is unused.** A number freed by a cancelled run reads exactly like a
   fresh one, one of the four surfaces cannot be undone, and one of them CI will not catch for you.
   Check all four against the version Step 0 settled on:
   - `git tag --list "vX.Y.Z"` (local tag)
   - `git ls-remote --tags origin "refs/tags/vX.Y.Z"` (remote tag)
   - `gh release list --repo Kangentic/kangentic --limit 100` (a surviving release, draft or published)
   - `npm view kangentic versions --json` (npm)

   A hit on any of the first three stops the release until that leftover is deleted. `--limit 100`
   is not decoration: the default page of 30 no longer covers this repo's history, so a leftover
   for an older number can fall off it.

   A hit on npm is terminal for that number. A published npm version can never be republished, so
   the release takes the next free one, which means Step 2 runs the explicit
   `npm version <the next free version> --no-git-tag-version` rather than a bump keyword, which
   would recompute the taken number from `package.json` and land on it again.

   A leftover DRAFT is the surface CI will not catch. `create-draft-release` treats an existing
   draft for the tag as a resumable one, logs "A draft release already exists for $tag; reusing
   it", and exits 0, so all five platform builds then upload into whatever a cancelled run left
   behind. It fast-fails only on a release that is already PUBLISHED and incomplete, which is the
   state Step 7 describes. So this check, not the workflow, is what stands between a stale draft
   and a published release built on top of it.

   Reach for this whenever the target version already appears in `git log`. v0.40.0 was tagged,
   cancelled before any platform job uploaded, and torn down; v0.39.1's commit message recorded the
   number as free, and v0.40.0 later shipped normally on it. That declaration lived in a commit
   message and was not self-verifying, so these four checks are what make a reuse safe.
8. **Verify CI is green on the commit being released.** Run
   `gh run list --repo Kangentic/kangentic --workflow=ci.yml --branch main --limit 1 --json headSha,status,conclusion`
   and compare `headSha` against `git rev-parse HEAD`. The `--json` fields are the point: the
   default table prints no SHA, so without them the step cannot check the half that matters.

   Require `conclusion: success` AND `headSha` equal to HEAD. On `failure`, stop: the code does
   not pass its own gate. If `status` is not `completed`, wait for it. If `headSha` is not HEAD,
   the last push never triggered CI and there is nothing here to trust, so say that rather than
   reading a stale run as a pass.

   This is the authoritative gate, and it is strictly broader than Step 1's local run. CI runs
   lint, typecheck, build, 3 unit shards, 11 UI shards, and 5 Linux Electron E2E shards on this
   exact commit. Step 1 runs typecheck and the UI tier, and nothing else: a lint error, a unit
   regression, a broken build, or an E2E failure would all sail past it. One `gh` call covers
   every one of those in about a second.

   A green conclusion already rules out a flaky test. CI runs the UI, E2E and web demo tiers with
   `retries: 1` and `--fail-on-flaky-tests`, so a test that passes only on its retry fails its
   shard and the run's conclusion is `failure` (`tests/unit/ci-workflow-hygiene.test.ts` pins the
   flag in `ci.yml`). Before the flag, a flake hid inside a passing check and this step scanned the
   whole 7 MB run log for `flaky`; v0.48.0's scan found one that had already reached main.

   A run that failed on a flake (its shard's summary lists the test under `flaky`) is a blocker
   under the never-leave-a-flake rule: fix it, rewrite it deterministically, or remove it with a
   justification. Do not ask whether to release around it.

   **The fix lands through its own PR, never as a merge from inside this release.**
   1. Make the fix, commit it on a branch of its own, and open the PR. `/pull-request` drives its
      checks green.
   2. Stop the release and report the PR. Merging it is the Merge column's job
      (`/merge-pull-request`) or the user's. Never `gh pr merge --admin` from inside `/release`:
      v0.48.0 did, the auto mode classifier stopped the next tool call as a merge without review,
      and the user had to step in mid-release anyway.
   3. Resume `/release` once the PR is on main. Fast-forward main and start again at pre-flight
      step 1: the new HEAD needs its own green CI run, and the range Step 3 reads has grown.

Report the current version (from package.json), the bump type, and what the new version will be before proceeding.

## Step 1 -- Validate

Spawn Step 1.5's `doc-auditor` agent before starting these, so the audit runs alongside them. Read
Step 1.5 now for why, and for what may and may not be applied while Step 1 is still running.

Pre-flight step 8 has already confirmed the authoritative gate. This step is a second, local
look that exists because CI's sharding and this machine's load schedule different races: the
v0.41.0 run surfaced a real latent flake here that all 11 green UI shards had never hit.

Run these checks sequentially.

1. Run `npm run typecheck`. If it fails, report type errors and stop.
2. Run `npx playwright test --project=ui`.

**Triaging a Step 1.2 failure.** A failure is either the machine's or yours, and the two want
opposite responses. Sort it before reacting.

**Read the failure's `error-context.md` and screenshot under `test-results/` FIRST.** Playwright
clears that folder at the start of every run, so the scoped re-run below deletes the one piece of
evidence that could show a real regression.

A failure is the machine's (environmental) only when ALL FOUR hold:

1. **It carries no assertion.** Its `error-context.md`, if it wrote one, has no Expected/Received
   block. An interrupted `expect` prints one, so a timeout inside an assertion does not qualify.
2. **The code it stopped in is untouched in this release's commit range.** Judge the code it
   stopped in, not the spec file: v0.48.0's failure stopped in `launchPage`, which the release had
   not changed, inside a spec the release had.
3. **It passes on a scoped re-run** (`npx playwright test <spec> --project=ui`).
4. **Pre-flight step 8's CI run is green on this commit.** CI fails on a flaky test, so that green
   also says no test needed its retry.

When all four hold, record it in the Step 7 report as an environmental failure, naming the four
checks, and keep going. When any one fails, it is yours: a test defect or a real regression, and
either way it blocks. Diagnose it, fix it, and re-run. The never-leave-a-flake rule applies in
full: fix, rewrite deterministically, or remove with a justification, and the fix lands through its
own PR as pre-flight step 8 describes. Never ask whether to release around it.

Shapes that have met all four here, under three workers beside the live dev server. These are
examples, not the rule:

- `worker process exited unexpectedly (code=3221226505)`, which is `0xC0000409`. Chromium died of
  resource exhaustion (v0.32.1).
- `"beforeAll" hook timeout of 15000ms exceeded` inside `launchPage()` (v0.42.0).
- A bare `Test timeout of 15000ms exceeded` with no Expected/Received block (v0.43.0).
- `page.goto: Navigation ... is interrupted by another navigation to` the same URL, inside
  `launchPage` (v0.48.0) and on three gotos in a row in a `beforeAll` (v0.50.0). `navigateToVite`
  in `tests/ui/vite-navigation-retry.ts` now adopts the navigation that took the goto's place
  instead of racing it, and logs a `[gotoVite]` line naming what navigated the page. Before you call a repeat
  environmental, read that line and the run's `[WebServer]` lines: Vite's stdout is piped now, so a
  reload or re-optimization shows there.

Re-running the full suite a third time to chase a clean local exit is not diligence. It is a
ten-minute coin flip that cannot tell you anything the four checks above have not already answered.

## Step 1.5 -- Documentation Audit

Full anchor point verification before release. The audit is read-only; this step always applies
what it finds. There is no skip and no confirmation prompt here.

Spawn the agent when Step 1 STARTS, not when it finishes. The audit reads source and docs, so it
does not depend on the test results, and it runs about as long as the UI suite does. Waiting for
Step 1 first adds roughly ten minutes of wall clock to every release for nothing.

Spawn early, apply late. Hold the findings until Step 1 has PASSED, then work through the numbered
steps below. Applying them while Step 1 is still running means a Step 1 failure stops the release
with doc edits already written into main, which the next attempt's clean-tree check then trips on
for a reason that has nothing to do with the real blocker. If Step 1 fails, discard the findings
unapplied.

1. Spawn a `doc-auditor` agent with scope "all" (verify every anchor).
2. **Apply every gap it reports - unconditionally.** For each gap: add missing items, remove
   extras, fix stale references. Do not ask the user; do not offer a skip.

   A gap is a missing, extra, or stale item in something the docs enumerate. An observation the
   auditor itself labels as prose completeness rather than an anchor gap is not one, so record it
   in the Step 7 report as a follow-up instead. The release commit absorbs a large doc pass
   happily, but it is not the place to start writing sections the auditor never claimed were
   missing.
3. **Document every undocumented `feat:` commit** since the previous tag: scan for features not
   covered in `docs/` and write the missing coverage. Unconditional - do not ask.

   Points 2 and 3 are separate mandates and the auditor's prose-versus-anchor label governs point
   2 only. A feature can be fully enumerated somewhere in `docs/` (so point 2 correctly reports no
   gap) and still be undocumented where a user would look, which is point 3's job. v0.41.0's PR
   merge-readiness pill was exactly this: the PR integration doc (now the
   `docs/integrations/pull-requests/` concepts) enumerated all six readiness values and both
   settings that drive them, while the user guide (now `docs/user-guide/`) never said the pill exists or where it
   renders, so a user could read the setting that flips a PR to `ready` and not know what changed
   on screen. Point 3 covers that; point 2 does not.

   Keep the write proportional. Point 3 asks for the missing coverage of a shipped feature, not a
   docs pass: name the thing where a user would look for it and link to the page that already
   enumerates the detail.
4. **Check `@kangentic/protocol` changelog parity.** Desktop releases are frequent and protocol
   releases are not, so this is the check most likely to catch a protocol release that bypassed
   `/release-protocol`. It is a read-and-fix check, not a protocol release: never bump, tag, or
   publish the protocol package from here.
   - List the tags: `git tag --list "protocol-v*"`.
   - Grep the entry headers: `Grep` for `^## \[protocol-v` in `packages/protocol/CHANGELOG.md`.
   - Every tag must have a matching entry. Backfill any that do not, reconstructing each from
     `git log <previousTag>..<thatTag> --oneline --no-decorate -- packages/protocol/src` and the
     commit messages, and stage `packages/protocol/CHANGELOG.md` with the other doc files.
   - A version bumped but never tagged is NOT a gap. See
     `.cursor/rules/protocol-release-parity.mdc` for why the tag is the line.
5. Stage the changed doc files (e.g. `git add docs/<changed-doc>.md`). They ride into the
   release commit in Step 4.
6. Report what was fixed: list the changed doc files. A large doc pass folded into the
   version-bump commit is expected and desired - do not treat it as scope creep.

## Step 1.6 - Refresh translated READMEs

Runs after Step 1.5 has applied its edits, since the audit may change README.md. Each
`i18n/README.<locale>.md` is a machine translation stamped with the README.md blob it came from, and
feature commits edit README.md without touching them. This step brings every stale one up to date.
It never skips.

1. Run `Push-Location <main>; node scripts/i18n/translate-readme.mjs --stale`. On Windows, an npm
   install of Claude Code puts only `claude.cmd` on PATH, so when the script says it cannot start
   the Claude CLI, re-run with `--cli <path to the claude executable>`.
2. **Exit 0:** it prints one line saying which translations it refreshed, restamped, or found
   current. Keep that line for Step 7.
3. **Any other exit:** stop the release and report the problems it printed per locale. The script
   writes nothing unless every stale translation passes its checks, so the tree is as it was and a
   retry's clean-tree check passes. Never release around it.
4. Run `Push-Location <main>; npx vitest run tests/unit/readme-translations.test.ts`. A failure
   stops the release the same way.
5. Stage them: `git -C <main> add README.md i18n`. They ride into the release commit in
   Step 4.

`docs/contributing/translations.md` explains the stamp and why no gate fails on a stale
translation between releases.

## Step 2 -- Version Bump

**Skip this step entirely if this is a first release** (no previous tags, so Step 0's first-release check elected to tag the current version as-is).

Run: `npm version <patch|minor|major> --no-git-tag-version`

This updates both `package.json` and `package-lock.json` without creating a git commit or tag (we do that manually in later steps).

Also bump the launcher package to the same version:

Run: `npm version <new-version> --no-git-tag-version -w packages/launcher`

(Use the exact new version number, e.g., `npm version 0.2.0 --no-git-tag-version -w packages/launcher`)

Read the new version from `package.json` and `packages/launcher/package.json` to confirm both match.

**Do not bump `packages/protocol`.** `@kangentic/protocol`'s version is deliberately decoupled
from Kangentic's own -- it ships on its own cadence via the separate `/release-protocol` skill
and `publish-protocol.yml` workflow, not this one. See that skill for details.

## Step 3 -- Generate Changelog

Run `scripts/release-changelog.mjs` in main, with the tag Step 0 captured and the new version:

`Push-Location <main>; node scripts/release-changelog.mjs <previousTag> <X.Y.Z> --write`

- **`<previousTag>` is Step 0's value.** Step 0 already applied `--match "v*"`, which is what keeps
  a `protocol-v*` tag from starting the range in the middle of the desktop release. Never run a
  fresh `git describe` for it.
- **What it writes.** It reads `<previousTag>..HEAD` from the checkout it lives in, sorts each
  commit by its conventional prefix (Breaking Changes for a `!` or `BREAKING CHANGE`, then
  Features, Fixes and Other, with a keyword fallback for a subject that has no prefix), strips the
  prefix, and inserts the entry after the `<!-- releases -->` marker in CHANGELOG.md's existing
  shape.
- **What it leaves out.** `/code-review` bookkeeping: a commit whose only change is
  `docs/audits/code-review-fanout-audit.md`, and a single-parent commit that changes nothing, which is
  how a pass's Refuted and Decisions ledger rides. They were 22 of v0.48.0's 136 commits and tell
  a reader nothing about the release.
- **What it prints.** The entry, then one line with the count per section and how many commits it
  skipped, zero included, then each skipped commit's hash and subject. Read that list: a wrong skip
  removes a line from a public changelog, and the list is the only place it shows. Keep the summary
  line and the list for Step 7.
- **Exit 2 means nothing was written.** The causes are a missing marker, an entry already there for
  the version, an empty range, and a bad argument. Fix the cause and re-run it. Never type the
  entry by hand.

Leave off `--write` for a dry run that prints the same output and writes nothing.
`tests/unit/release-changelog.test.ts` pins the sorting, the skip and the insertion. A fresh fork
with no tag passes its root commit (`git rev-list --max-parents=0 HEAD`) as `<previousTag>`. The
range starts after that commit, so the entry leaves it out; say so in the Step 7 report.

## Step 3.5 -- Generate Release Notes

Generate a concise, user-friendly summary for the GitHub Release draft body. This is separate from the CHANGELOG -- the CHANGELOG is the full technical log, while release notes are a brief summary for end users.

1. **Use the entry Step 3 printed**, but rewrite its lines in plain language:
   - Strip conventional commit prefixes (`feat:`, `fix:`, etc.)
   - Remove commit hashes
   - Rewrite terse commit subjects into clear, user-friendly descriptions
   - Merge related commits into single bullet points where appropriate (e.g., three commits that all improve the same feature become one bullet)
   Then collect the notes authors wrote themselves. Run
   `git log <previousTag>..HEAD --format="%(trailers:key=Release-Note,valueonly)"` (no tag: drop the
   range). Each non-empty line is a user-facing sentence a commit carried in a `Release-Note:`
   trailer, for a change its subject undersells, such as something that switches off for some users.
   Put each in its section with its meaning kept, and fold it into the bullet for the same change
   rather than listing the change twice. The trailer is the only way such a note reaches this file,
   since the entry Step 3 printed is built from subjects only.
2. **Group into sections:**
   - **What's New** -- features and enhancements
   - **Bug Fixes** -- fixes
   - **Breaking Changes** -- only if applicable
   - Omit any section that has no entries. Do not include an "Other" section -- skip chores, docs, refactors, CI, and build commits.
3. **Write the release notes** to `RELEASE_NOTES.md` at the repo root using the Write tool:

```markdown
## What's New
- Dark mode support
- Desktop notifications for background tasks

## Bug Fixes
- Fixed crash when opening an empty board
```

4. This file is committed in Step 4 and used by CI to populate the draft GitHub Release body automatically.

## Step 4 -- Commit

1. Stage the changed files: `git add package.json package-lock.json packages/launcher/package.json CHANGELOG.md RELEASE_NOTES.md`
   (If this is a first release with no version bump, only stage `CHANGELOG.md RELEASE_NOTES.md`)
2. Write the commit message using the **Write tool** to `.kangentic/COMMIT_MSG.tmp` (a
   main-checkout path, and the file normally already holds a previous release's message, so read
   it first if the tool refuses to overwrite an unread file):
   ```
   chore(release): vX.Y.Z
   ```
   Add the session's attribution lines below the subject if the harness asks for them.
3. Commit: `git commit -F .kangentic/COMMIT_MSG.tmp`

## Step 5 -- Tag

Run: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`

## Step 6 -- Push

Run these sequentially:

1. `git push origin main` -- push the release commit
2. `git push origin vX.Y.Z` -- push the tag (triggers `release.yml` workflow)

**If either push fails**, report the error and stop. Do not force-push.

## Step 7 -- Report

Summarize the release:

- Version: vX.Y.Z
- Tag: vX.Y.Z
- Commits included: N, and the review-record commits Step 3 left out (its summary line and the
  list under it)
- Changelog entry: show the generated entry
- Translated READMEs: Step 1.6's outcome line
- **Release notes:** Read `RELEASE_NOTES.md` and display the contents. Tell the user: "These release notes will be applied to the draft GitHub Release automatically by CI."
- GitHub Actions: link to `https://github.com/Kangentic/kangentic/actions`. The tag push triggers the Release workflow, which creates ONE draft Release, builds all five targets into it (Windows x64, macOS arm64 and x64, Linux x64 and arm64), rebuilds the macOS update feed for both arches, verifies the asset manifest, and then publishes it automatically.

**Watch the run before opening anything.** Get the run id with `gh run list --repo
Kangentic/kangentic --workflow=release.yml --limit 1`, then wait on it with `gh run watch <runId>
--repo Kangentic/kangentic --exit-status` (run it in the background; it takes 15 to 25 minutes,
the last ten of them the `demo-posters` job shooting the docs poster set after the release is
already published).

**Then** verify the end state rather than trusting the exit code, and only after that open the
releases page in the user's browser with `start
https://github.com/Kangentic/kangentic/releases`:

- `gh api repos/Kangentic/kangentic/releases/tags/vX.Y.Z --jq '{draft, asset_count: (.assets | length)}'` must report `draft: false` and 19 assets: the 18 build assets `scripts/release-assets.js` lists, plus `demo-posters-X.Y.Z.zip` from the `demo-posters` job, which runs after the release is published. 18 after a green `gh run watch` means that job did not attach the poster set; read its log.
- `npm view kangentic version` must report the new version.

Opening the releases page while the builds are still running is what caused the v0.39.0 failure
below, so the order here is the guard, not a preference: it puts a draft and a Publish button in
front of a human for the ten minutes when clicking it does the most damage.

**Never publish the draft by hand.** Publishing is automatic once
`scripts/verify-release-assets.js` confirms the tag resolves to exactly one release carrying all
18 expected build assets, with a `latest-mac.yml` that lists both macOS zips. So a release still sitting as a draft after the workflow finishes means that
gate FAILED, and the draft is presumed incomplete. Clicking Publish in the GitHub UI bypasses the
only check that stands between a partial release and every user's auto-updater, which is exactly
how v0.35.0 shipped macOS-less. Read the `publish-release` job log, fix the cause, and re-run the
workflow instead. The same job's first steps also leave the release a draft when they fail.
`scripts/merge-mac-update-feeds.js` rebuilds the one `latest-mac.yml` both arches update from,
hashing both arches' zip and dmg on the release; publishing past it leaves one arch's Macs with no
update, or moves Apple silicon onto the Intel build. `scripts/patch-mac-update-info.js` writes `minimumSystemVersion` into
that feed; publishing past it would auto-update Macs below the macOS floor into a build that will
not open.

Publishing it EARLY, while the builds are still running, is the worse half and is how v0.39.0
first shipped empty. electron-builder uploads only into a draft: handed a published release it
skips every artifact with `existing type not compatible with publishing type` and the builds
still exit 0, leaving a published release carrying nothing. `create-draft-release` now fails the
run in seconds when it finds that state, but the recovery is still manual: `gh release delete
vX.Y.Z --yes` (the tag survives), then a FULL re-run with `gh run rerun <runId>`. Not
`--failed`, which re-runs only the failed job and leaves the other platforms' assets unbuilt.

## Step 8 -- Mark the Sentry issues this release fixes

Runs only after Step 7's end-state verification. The Sentry release `Kangentic@X.Y.Z` is created by
the bundler plugin during the CI build, so it does not exist before then and nothing here can be
done earlier.

The marker must name the release that CARRIES the fix. Naming the release an issue was last seen on
reopens it on exactly the builds that legitimately lack the fix. Read
`.cursor/skills/sentry/SKILL.md` and follow its "Auth" and "Resolution markers" sections for the
token, the request bodies, and the traps; do not re-derive them here.

1. **Derive the candidates:** Run
   `git log <previousTag>..vX.Y.Z --grep="DESKTOP-" --format=%H%n%B`, where `<previousTag>` is the
   value Step 0 captured and `vX.Y.Z` is the tag Step 5 created. Do NOT re-derive `<previousTag>`
   here. Step 5 has already tagged this release, so a fresh `git describe --tags --abbrev=0
   --match "v*"` now returns the NEW tag and the range comes back empty. That is the one silent
   failure this step has, and an empty range reads exactly like a clean run. Collect every shortId
   the commit bodies name.
2. **Sort the candidates mechanically, then act without asking.** The scan produces candidates, not
   answers, because a commit body cites shortIds it does not fix. Read each candidate's issue
   payload first, both its `status` and its newest `set_resolved_in_release` activity entry: a
   commit body on its own cannot tell you whether an issue is already resolved somewhere else. Then
   sort into exactly three buckets and do not deliberate past this:
   - **Currently `unresolved`, and a commit in this range states that it fixes the issue.** Mark it.
   - **Currently `unresolved`, but the commit names it only as context or prior art.** Skip it and
     say so in the report. Getting this one wrong is self-correcting, because a later event on a
     newer release reopens the issue.
   - **Already `resolved`, whatever the commit says.** Never write to it. Report its current
     marker, and say so explicitly when that marker names a release that predates the fix, because
     that is the one case a human has to act on and nothing else in this step surfaces it.

   That third rule is what replaces the old confirmation prompt, and it is strictly safer than the
   prompt was. The failure this step exists to prevent is re-marking an already-resolved issue to
   the version being shipped, which reopens it on exactly the builds that legitimately carry the
   fix: `b653463d` names DESKTOP-C, whose fix shipped in v0.39.0. Every instance of that bug is a
   write to an issue that was already resolved, so refusing those writes removes the bug outright
   rather than asking a human to catch it.

   The cost is that a wrong marker written by the GitHub integration, which resolves an issue
   without being asked when a merged PR names a shortId, gets reported rather than corrected.
   Correcting one takes two ordered writes rather than one, per the sentry skill's "Four things
   bite" item 1. That makes it a deliberate act and the one part of this step genuinely worth a
   human, so it does not belong on the unattended path.
3. **Mark each issue in the first bucket** against `Kangentic@<the version just shipped>`.
4. **Verify, then say which way it went.** Read each issue's newest `set_resolved_in_release`
   activity entry back, because `statusDetails` alone cannot confirm a write landed. Then report
   the outcome in one line, including the empty ones: "no Sentry shortIds in this range", or "403
   on the resolve PUT, these issues are unmarked: ...". Per
   `.cursor/rules/release-gates-fail-loudly.mdc`, a step that guarantees something says which way
   it went.

**This step never fails the release.** It runs after the release is already published, so its only
failure mode is a report. Do not stop the flow, do not retry in a loop, and do not roll anything
back.

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Bash` (for `git`, `gh`, `npm`, `npx`, and `curl` commands), `Write` (for the commit message temp file and `RELEASE_NOTES.md`), and `Edit` (for the Step 1.5 doc fixes). Step 3's changelog script runs through `PowerShell` in main, like the other cwd-sensitive commands "Where this runs" lists.

`gh` carries the entire GitHub half of the release: the symbol-secret check and the leftover-release
check in pre-flight, and every Step 7 call that watches the run and verifies what was published.
Without `Bash(gh:*)` the release can still tag and push, which is the worst possible failure shape,
because it ships the build and then cannot confirm what it shipped.

Step 8 uses two of those grants: `PowerShell`, for the sentry skill's Windows request pattern,
which chains with `;` and so cannot go through `Bash` under `.cursor/rules/bash-single-command.mdc`;
and `Bash(curl:*)` for its macOS and Linux form. Without those grants Step 8 cannot make a single
Sentry request. It reaches the sentry skill's instructions with `Read`, which is already granted,
rather than by invoking the skill.

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. Use `git -C <path>` for git commands in another directory -- never `cd <path> && git ...`.
