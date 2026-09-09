---
description: Version bump, changelog, tag, push release, and mark the Sentry issues it fixes
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(curl:*), PowerShell, Agent
argument-hint: [patch|minor|major]
---

# Release

Release pipeline: version bump, changelog generation, git tag, and push to trigger the release workflow.

**Usage:** `/release [patch|minor|major]`

- `/release` -- auto-suggests bump type from commit history, asks for confirmation
- `/release patch` -- bump 0.1.0 to 0.1.1
- `/release minor` -- bump 0.1.0 to 0.2.0
- `/release major` -- bump 0.1.0 to 1.0.0

**Release type (optional):** $ARGUMENTS

This command does NOT use `/merge-back`. The release flow is fundamentally different: no rebase, creates tags, and pushes to main directly.

## Step 0 -- Determine Bump Type

1. **Find the previous tag:** Run `git describe --tags --abbrev=0`. Note whether this succeeds or fails (no tags = first release).
2. **Collect commits since last tag:** Run `git log <previousTag>..HEAD --oneline --no-decorate` (or `git log --oneline --no-decorate` if no previous tag).
3. **Analyze conventional commit prefixes to suggest a bump type:**
   - Any commit with `!` after the type (e.g., `feat!:`, `fix!:`) or containing `BREAKING CHANGE` in the subject -- suggest **major**
   - Any `feat:` commit -- suggest **minor**
   - Only `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `perf:`, `ci:`, `build:` -- suggest **patch**
   - If no conventional prefixes found, fall back to keyword analysis (same as legacy): "Add"/"Implement"/"Create" = minor, "Fix" = patch, otherwise patch
4. **If `$ARGUMENTS` is `patch`, `minor`, or `major`:** use it directly, skip the suggestion prompt.
5. **First-release check:** If no previous tags exist and `$ARGUMENTS` is empty, read the current version from `package.json`. Ask the user: "No previous releases found. Release current version as v{version}? [confirm/override]". If confirmed, skip the version bump in Step 2 (tag the current version as-is).
6. **Otherwise (no explicit argument):** Report the suggestion with reasoning:
   ```
   Suggested bump: minor
   Reason: 3 feat: commits found since v0.1.0
   Commits: feat: add dark mode, feat: add notifications, fix: resolve crash

   Proceed with minor bump (0.1.0 -> 0.2.0)? [confirm/override]
   ```
   Wait for user confirmation before proceeding. The user can confirm or override with a different bump type.

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

Report the current version (from package.json), the bump type, and what the new version will be before proceeding.

## Step 1 -- Validate

Run these checks sequentially. Stop on the first failure.

1. Run `npm run typecheck`. If it fails, report type errors and stop.
2. Run `npx playwright test --project=ui`. If it fails, report test failures and stop.

## Step 1.5 -- Documentation Audit

Full anchor point verification before release. The audit is read-only; this step always applies
what it finds. There is no skip and no confirmation prompt here.

1. Spawn a `doc-auditor` agent with scope "all" (verify every anchor).
2. **Apply every gap it reports - unconditionally.** For each gap: add missing items, remove
   extras, fix stale references. Do not ask the user; do not offer a skip.
3. **Document every undocumented `feat:` commit** since the previous tag: scan for features not
   covered in `docs/` and write the missing coverage. Unconditional - do not ask.
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
     `.claude/rules/protocol-release-parity.md` for why the tag is the line.
5. Stage the changed doc files (e.g. `git add docs/foo.md docs/bar.md`). They ride into the
   release commit in Step 4.
6. Report what was fixed: list the changed doc files. A large doc pass folded into the
   version-bump commit is expected and desired - do not treat it as scope creep.

## Step 2 -- Version Bump

**Skip this step entirely if this is a first release** (no previous tags and user confirmed releasing the current version).

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

1. **Find the previous tag:** Run `git describe --tags --abbrev=0`. If no tags exist, use the root commit as the starting point (this is the first release).
2. **Collect commits:** Run `git log <previousTag>..HEAD --oneline --no-decorate` (or `git log --oneline --no-decorate` if no previous tag).
3. **Group commits** into categories using conventional commit prefixes:
   - **Breaking Changes** -- commits with `!` after the type (e.g., `feat!:`, `fix!:`) or containing `BREAKING CHANGE` in the subject
   - **Features** -- commits with `feat:` prefix
   - **Fixes** -- commits with `fix:` prefix
   - **Other** -- commits with `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `perf:`, `ci:`, `build:` prefix
   - **Fallback** -- commits without a conventional prefix get loose keyword matching for backwards compatibility:
     - Starting with "Add", "Implement", "Create", or containing "feature" -- Features
     - Starting with "Fix" or containing "bug", "resolve" -- Fixes
     - Everything else -- Other
   - When displaying commit messages in the changelog, strip the conventional prefix (e.g., `feat: add dark mode` becomes `Add dark mode`)
4. **Format the changelog entry:**

```markdown
## [vX.Y.Z] - YYYY-MM-DD

### Breaking Changes
- Commit message here (abc1234)

### Features
- Commit message here (abc1234)

### Fixes
- Commit message here (def5678)

### Other
- Commit message here (ghi9012)
```

Omit any category section that has no entries.

5. **Read `CHANGELOG.md`**, then use the **Edit tool** to insert the new entry after the `<!-- releases -->` marker line. If the file doesn't exist or doesn't have the marker, stop with an error.

## Step 3.5 -- Generate Release Notes

Generate a concise, user-friendly summary for the GitHub Release draft body. This is separate from the CHANGELOG -- the CHANGELOG is the full technical log, while release notes are a brief summary for end users.

1. **Use the same commit list from Step 3**, but rewrite them in plain language:
   - Strip conventional commit prefixes (`feat:`, `fix:`, etc.)
   - Remove commit hashes
   - Rewrite terse commit subjects into clear, user-friendly descriptions
   - Merge related commits into single bullet points where appropriate (e.g., three commits that all improve the same feature become one bullet)
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
2. Write the commit message using the **Write tool** to `.kangentic/COMMIT_MSG.tmp`:
   ```
   chore(release): vX.Y.Z
   ```
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
- Commits included: N
- Changelog entry: show the generated entry
- **Release notes:** Read `RELEASE_NOTES.md` and display the contents. Tell the user: "These release notes will be applied to the draft GitHub Release automatically by CI."
- GitHub Actions: link to `https://github.com/Kangentic/kangentic/actions`. The tag push triggers the Release workflow, which creates ONE draft Release, builds all three platforms into it, verifies the asset manifest, and then publishes it automatically.

**Watch the run before opening anything.** Get the run id with `gh run list --repo
Kangentic/kangentic --workflow=release.yml --limit 1`, then wait on it with `gh run watch <runId>
--repo Kangentic/kangentic --exit-status` (run it in the background; it takes 10 to 15 minutes).

**Then** verify the end state rather than trusting the exit code, and only after that open the
releases page in the user's browser with `start
https://github.com/Kangentic/kangentic/releases`:

- `gh api repos/Kangentic/kangentic/releases/tags/vX.Y.Z --jq '{draft, asset_count: (.assets | length)}'` must report `draft: false` and 11 assets.
- `npm view kangentic version` must report the new version.

Opening the releases page while the builds are still running is what caused the v0.39.0 failure
below, so the order here is the guard, not a preference: it puts a draft and a Publish button in
front of a human for the ten minutes when clicking it does the most damage.

**Never publish the draft by hand.** Publishing is automatic once
`scripts/verify-release-assets.js` confirms the tag resolves to exactly one release carrying all
11 expected assets. So a release still sitting as a draft after the workflow finishes means that
gate FAILED, and the draft is presumed incomplete. Clicking Publish in the GitHub UI bypasses the
only check that stands between a partial release and every user's auto-updater, which is exactly
how v0.35.0 shipped macOS-less. Read the `publish-release` job log, fix the cause, and re-run the
workflow instead.

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
`.claude/skills/sentry/SKILL.md` and follow its "Auth" and "Resolution markers" sections for the
token, the request bodies, and the traps; do not re-derive them here.

1. **Derive the candidates:** Run
   `git log <previousTag>..vX.Y.Z --grep="DESKTOP-" --format=%H%n%B`, where `<previousTag>` is the
   value Step 0 captured and `vX.Y.Z` is the tag Step 5 created. Do NOT re-derive `<previousTag>`
   here. Step 5 has already tagged this release, so `git describe --tags --abbrev=0` now returns
   the NEW tag and the range comes back empty. That is the one silent failure this step has, and an
   empty range reads exactly like a clean run. Collect every shortId the commit bodies name.
2. **Judge each candidate.** The scan produces candidates, not answers, because a commit body
   cites shortIds it does not fix. Read each candidate's current issue payload first, both its
   `status` and its newest `set_resolved_in_release` activity entry: a commit body on its own
   cannot tell you whether an issue is already resolved somewhere else. Then drop two kinds:
   - An issue a commit mentions only as context or prior art.
   - An issue already resolved against a release that genuinely carries its fix. This has bitten
     once already: `b653463d` names DESKTOP-C, whose fix shipped in v0.39.0, so a blind re-mark to
     the version being released would have recreated the bug this step exists to prevent.
3. **Confirm the list with the user** as one numbered prompt before any write, showing each
   shortId, the commit that fixes it, and the marker about to be set.
4. **Mark each one** against `Kangentic@<the version just shipped>`. An already-resolved issue
   needs a `{"status":"unresolved"}` PUT first or the write is silently a no-op, and the GitHub
   integration resolves issues on PR merge, so expect that state rather than reading it as a
   decision someone made.
5. **Verify, then say which way it went.** Read each issue's newest `set_resolved_in_release`
   activity entry back, because `statusDetails` alone cannot confirm a write landed. Then report
   the outcome in one line, including the empty ones: "no Sentry shortIds in this range", or "403
   on the resolve PUT, these issues are unmarked: ...". Per
   `.claude/rules/release-gates-fail-loudly.md`, a step that guarantees something says which way
   it went.

**This step never fails the release.** It runs after the release is already published, so its only
failure mode is a report. Do not stop the flow, do not retry in a loop, and do not roll anything
back.

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Bash` (for `git`, `npm`, `npx`, and `curl` commands), `Write` (for commit message temp file), and `Edit` (for CHANGELOG.md).

Step 8 needs two more: `PowerShell`, for the sentry skill's Windows request pattern, which chains
with `;` and so cannot go through `Bash` under `.claude/rules/bash-single-command.md`; and
`Bash(curl:*)` for its macOS and Linux form. Without those grants Step 8 cannot make a single
Sentry request. It reaches the sentry skill's instructions with `Read`, which is already granted,
rather than by invoking the skill.

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. Use `git -C <path>` for git commands in another directory -- never `cd <path> && git ...`.
