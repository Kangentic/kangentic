---
description: Version bump, changelog, tag, and push a @kangentic/protocol release, independent of the Kangentic desktop release
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*)
argument-hint: [patch|minor|major]
---

# Release Protocol

Publishes a new version of `@kangentic/protocol` independently of Kangentic's own release cycle
(`/release`). `@kangentic/protocol`'s version (`packages/protocol/package.json`) is deliberately
decoupled from root's -- this pipeline exists so the protocol package can ship on its own
cadence, including while the mobile bridge feature is still being built out, without requiring
or triggering a full Kangentic desktop release. The publish side lives in
`.github/workflows/publish-protocol.yml`.

**Usage:** `/release-protocol [patch|minor|major]`

- `/release-protocol` -- auto-suggests bump type from commit history scoped to `packages/protocol/`, asks for confirmation
- `/release-protocol patch` -- bump 0.1.0 to 0.1.1
- `/release-protocol minor` -- bump 0.1.0 to 0.2.0
- `/release-protocol major` -- bump 0.1.0 to 1.0.0

**Release type (optional):** $ARGUMENTS

This is NOT `/release`. It never touches root's `package.json` version or `packages/launcher`,
never triggers `release.yml`, and tags on the `protocol-v*` namespace instead of `v*` so the two
tag sequences never collide.

## Step 0 -- Determine Bump Type

1. **Find the previous protocol tag:** Run `git describe --tags --abbrev=0 --match "protocol-v*"`. Note whether this succeeds or fails (no matching tags = first protocol release).
2. **Collect commits since the last protocol tag, scoped to the package:** Run `git log <previousTag>..HEAD --oneline --no-decorate -- packages/protocol/` (or `git log --oneline --no-decorate -- packages/protocol/` if no previous tag).
3. **Analyze conventional commit prefixes to suggest a bump type** (same rules as `/release`):
   - Any commit with `!` after the type or containing `BREAKING CHANGE` -- suggest **major**
   - Any `feat:` commit -- suggest **minor**
   - Only `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `perf:`, `ci:`, `build:` -- suggest **patch**
   - No conventional prefixes found -- fall back to keyword analysis: "Add"/"Implement"/"Create" = minor, "Fix" = patch, otherwise patch
4. **If `$ARGUMENTS` is `patch`, `minor`, or `major`:** use it directly, skip the suggestion prompt.
5. **First-release check:** If no previous `protocol-v*` tags exist and `$ARGUMENTS` is empty, read the current version from `packages/protocol/package.json`. Ask the user: "No previous protocol releases found. Release current version as protocol-v{version}? [confirm/override]". If confirmed, skip the version bump in Step 2 (tag the current version as-is).
6. **Otherwise:** report the suggestion with reasoning and wait for confirmation, same format as `/release`:
   ```
   Suggested bump: minor
   Reason: 2 feat: commits found since protocol-v0.1.0 (scoped to packages/protocol/)
   Commits: feat: add capability revocation, feat: add relay reconnect backoff

   Proceed with minor bump (0.1.0 -> 0.2.0)? [confirm/override]
   ```

## Pre-flight Checks

1. **Verify branch:** Run `git rev-parse --abbrev-ref HEAD`. Must be `main`. If not, stop with an error: "Release must run from the main branch."
2. **Verify clean tree:** Run `git status --porcelain`. Must be empty. If not, stop.
3. **Fetch latest:** Run `git fetch origin main`.
4. **Verify up-to-date:** Run `git diff HEAD origin/main --stat`. Must be empty. If not, stop with: "Local main is behind origin/main. Run `git pull` first."
5. **Install dependencies:** Run `npm ci`.
6. **Verify changelog parity across the whole tag sequence.** This step exists because the
   sequence has already drifted once: eight versions reached npm with no entry, because the tags
   were hand-created on feature commits instead of through this skill, and Step 3 only ever
   prepends the newest entry so it never looked down. See
   `.claude/rules/protocol-release-parity.md`.
   - List every tag: `git tag --list "protocol-v*"`.
   - Grep the entry headers: `Grep` for `^## \[protocol-v` in `packages/protocol/CHANGELOG.md`.
   - Every tag must have a matching `## [protocol-vX.Y.Z]` entry. A version that was bumped but
     never tagged is NOT a gap (the changelog entry lands at release time by convention); a
     tagged version with no entry is.
   - **Backfill any gap before continuing, do not just report it.** For each missing version,
     reconstruct the entry from `git log <previousTag>..<thatTag> --oneline --no-decorate --
     packages/protocol/src` plus the individual commit messages, and insert it in descending
     order. Fold the backfill into this release's commit in Step 4.
   - Note that a tag pointing at anything other than a `chore(protocol-release):` commit is the
     signature of a past bypass, and is the fastest way to spot which releases to check first.

Report the current protocol version, the bump type, the new version, and any backfill you
performed before proceeding.

## Step 1 -- Validate

Scoped to the protocol package only -- do NOT run the full Kangentic app test suite (that is
`/test`'s job, and this release does not touch the desktop app).

1. Run `npx tsc --noEmit`. If it fails, report type errors and stop. (Full-repo typecheck, since `packages/protocol/src` is included in the root tsconfig.)
2. Run `npx eslint packages/protocol/src/ --max-warnings 0`. If it fails, stop.
3. Run `npx vitest run tests/unit/protocol/`. If it fails, stop.
4. Run `npm run build -w packages/protocol` to confirm the package actually builds (dual CJS/ESM bundle + `.d.ts` declarations). If it fails, stop -- a release must never ship a package that fails its own build.

## Step 2 -- Version Bump

**Skip this step entirely if this is a first release** (no previous `protocol-v*` tags and the user confirmed releasing the current version).

Run: `npm version <patch|minor|major> --no-git-tag-version -w packages/protocol`

Read the new version from `packages/protocol/package.json` to confirm it matches expectations.

## Step 3 -- Changelog

1. Read `packages/protocol/CHANGELOG.md`. If it does not exist, create it via the Write tool with:
   ```markdown
   # @kangentic/protocol Changelog

   <!-- releases -->
   ```
2. Group the commits collected in Step 0 the same way `/release`'s Step 3 does: Breaking Changes / Features / Fixes / Other, stripping conventional prefixes, one bullet per commit with its short hash.
3. Use the **Edit tool** to insert the new entry after the `<!-- releases -->` marker:
   ```markdown
   ## [protocol-vX.Y.Z] - YYYY-MM-DD

   ### Features
   - Commit message here (abc1234)
   ```
   Omit any category with no entries.
4. Stage `packages/protocol/CHANGELOG.md` (done in Step 4, not here).

## Step 4 -- Commit

1. Check `git status --porcelain` for what actually changed (Step 2's `npm version -w` touches `packages/protocol/package.json` and the root `package-lock.json`).
2. Stage: `git add packages/protocol/package.json packages/protocol/CHANGELOG.md package-lock.json`
   (If this is a first release with no version bump, only stage `packages/protocol/CHANGELOG.md`.)
3. Write the commit message using the **Write tool** to `.kangentic/COMMIT_MSG.tmp`:
   ```
   chore(protocol-release): protocol-vX.Y.Z
   ```
4. Commit: `git commit -F .kangentic/COMMIT_MSG.tmp`

## Step 5 -- Tag

Run: `git tag -a protocol-vX.Y.Z -m "Release @kangentic/protocol vX.Y.Z"`

## Step 6 -- Push

Run these sequentially:

1. `git push origin main` -- push the release commit
2. `git push origin protocol-vX.Y.Z` -- push the tag (triggers `publish-protocol.yml`)

**If either push fails**, report the error and stop. Do not force-push.

## Step 7 -- Report

Summarize the release:

- Version: `@kangentic/protocol` vX.Y.Z
- Tag: `protocol-vX.Y.Z`
- Commits included: N
- Changelog entry: show the generated entry
- GitHub Actions: link to `https://github.com/Kangentic/kangentic/actions` -- the tag push triggers the "Publish @kangentic/protocol" workflow.
- **First publish only:** if this is the very first time `@kangentic/protocol` is being published, warn the user explicitly: npm cannot link an OIDC Trusted Publisher to a package that has never been published, so this workflow run will likely fail on the `npm publish` step with an authentication error. Tell them to run `npm login`, then `npm run build -w packages/protocol` (there is no `prepack`/`prepublishOnly` hook, so skipping this ships a tarball with an empty `dist/`), then `npm publish --access public -w packages/protocol` locally once from an authenticated maintainer machine, then configure Trusted Publishing for `@kangentic/protocol` on npmjs.com (pointing at this repo and the `publish-protocol.yml` workflow file), then re-trigger the workflow (re-push the tag, or use `workflow_dispatch`) for every publish after that.

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Bash` (for `git`, `npm`, and `npx` commands), `Write` (for the commit message temp file and a new CHANGELOG.md), and `Edit` (for an existing CHANGELOG.md).

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. Use `git -C <path>` for git commands in another directory -- never `cd <path> && git ...`.
