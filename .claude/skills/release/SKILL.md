---
description: Version bump, changelog, tag, and push release
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Agent
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

**This skill performs irreversible, public actions** (a git tag plus a push that triggers
`release.yml`). Do not skip the confirmation gates: the bump-type confirmation (Step 0) and the
pre-push confirmation (Step 4.5).

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
5. **Install dependencies:** Run `npm ci`. This ensures `node_modules` matches the lockfile exactly, preventing typecheck/test failures from stale or missing packages. The `postinstall` script automatically rebuilds native modules for Electron. If it fails with EBUSY, stop with: "A file in node_modules is locked by a running process. Close the Kangentic dev server (`npm start`) and retry."

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
4. Stage the changed doc files (e.g. `git add docs/foo.md docs/bar.md`). They ride into the
   release commit in Step 4.
5. Report what was fixed: list the changed doc files. A large doc pass folded into the
   version-bump commit is expected and desired - do not treat it as scope creep.

## Step 2 -- Version Bump

**Skip this step entirely if this is a first release** (no previous tags and user confirmed releasing the current version).

Run: `npm version <patch|minor|major> --no-git-tag-version`

This updates both `package.json` and `package-lock.json` without creating a git commit or tag (we do that manually in later steps).

Also bump the launcher package to the same version:

Run: `npm version <new-version> --no-git-tag-version -w packages/launcher`

(Use the exact new version number, e.g., `npm version 0.2.0 --no-git-tag-version -w packages/launcher`)

Read the new version from `package.json` and `packages/launcher/package.json` to confirm both match.

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

## Step 4.5 -- Confirm Release (irreversible)

This is the last reversible point: the release commit exists locally but nothing is public yet.
This gate applies to every invocation path (a human-typed `/release` or the board's
`autoCommand: /release`) - even an auto-injected invocation pauses here.

1. Show the user: the version (vX.Y.Z), the tag that will be created, the number of commits
   included, and that pushing the tag triggers `release.yml` (builds platform artifacts and
   creates a public draft GitHub Release).
2. Ask: "Tag and push vX.Y.Z? This creates a public release and cannot be undone.
   [confirm/cancel]"
3. **On confirm:** proceed to Step 5.
4. **On cancel:** STOP. Report that the release commit is local-only, no tag was created, and
   nothing was pushed. Do not tag, do not push.

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
- GitHub Actions: link to `https://github.com/Kangentic/kangentic/actions` -- the tag push triggers the Release workflow which builds platform artifacts and creates a draft GitHub Release.
- **Open the releases page** in the user's browser: run `start https://github.com/Kangentic/kangentic/releases` so the user can review and publish the draft once the workflow completes.

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Bash` (for `git`, `npm`, and `npx` commands), `Write` (for commit message temp file), and `Edit` (for CHANGELOG.md).

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. Use `git -C <path>` for git commands in another directory -- never `cd <path> && git ...`.
