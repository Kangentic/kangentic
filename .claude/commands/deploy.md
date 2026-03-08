---
description: Version bump, changelog, tag, and push release
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*)
argument-hint: <patch|minor|major>
---

# Deploy

Release pipeline: version bump, changelog generation, git tag, and push to trigger the release workflow.

**Usage:** `/deploy <patch|minor|major>`

- `/deploy patch` -- bump 0.1.0 to 0.1.1
- `/deploy minor` -- bump 0.1.0 to 0.2.0
- `/deploy major` -- bump 0.1.0 to 1.0.0

**Release type:** $ARGUMENTS

This command does NOT use `/merge-back`. The deploy flow is fundamentally different: no rebase, creates tags, and pushes to main directly.

## Pre-flight Checks

1. **Verify branch:** Run `git rev-parse --abbrev-ref HEAD`. Must be `main`. If not, stop with an error: "Deploy must run from the main branch."
2. **Verify clean tree:** Run `git status --porcelain`. Must be empty. If not, stop with an error: "Working tree must be clean before deploying. Commit or stash changes first."
3. **Verify argument:** The user must provide exactly one of `patch`, `minor`, or `major`. If missing or invalid, stop with usage instructions.
4. **Fetch latest:** Run `git fetch origin main`
5. **Verify up-to-date:** Run `git diff HEAD origin/main --stat`. Must be empty. If not, stop with: "Local main is behind origin/main. Run `git pull` first."

Report the current version (from package.json), the bump type, and what the new version will be before proceeding.

## Step 1 -- Validate

Run these checks sequentially. Stop on the first failure.

1. Run `npm run typecheck`. If it fails, report type errors and stop.
2. Run `npx playwright test --project=ui`. If it fails, report test failures and stop.

## Step 2 -- Version Bump

Run: `npm version <patch|minor|major> --no-git-tag-version`

This updates both `package.json` and `package-lock.json` without creating a git commit or tag (we do that manually in later steps).

Also bump the launcher package to the same version:

Run: `npm version <new-version> --no-git-tag-version -w packages/launcher`

(Use the exact new version number, e.g., `npm version 0.2.0 --no-git-tag-version -w packages/launcher`)

Read the new version from `package.json` and `packages/launcher/package.json` to confirm both match.

## Step 3 -- Generate Changelog

1. **Find the previous tag:** Run `git describe --tags --abbrev=0`. If no tags exist, use the root commit as the starting point (this is the first release).
2. **Collect commits:** Run `git log <previousTag>..HEAD --oneline --no-decorate` (or `git log --oneline --no-decorate` if no previous tag).
3. **Group commits** into categories based on the commit message:
   - **Features** -- commits starting with "Add", "Implement", "Create", or containing "feature", "feat"
   - **Fixes** -- commits starting with "Fix" or containing "bug", "patch", "resolve"
   - **Other** -- everything else
4. **Format the changelog entry:**

```markdown
## [vX.Y.Z] - YYYY-MM-DD

### Features
- Commit message here (abc1234)

### Fixes
- Commit message here (def5678)

### Other
- Commit message here (ghi9012)
```

Omit any category section that has no entries.

5. **Read `CHANGELOG.md`**, then use the **Edit tool** to insert the new entry after the `<!-- releases -->` marker line. If the file doesn't exist or doesn't have the marker, stop with an error.

## Step 4 -- Commit

1. Stage the changed files: `git add package.json package-lock.json packages/launcher/package.json CHANGELOG.md`
2. Write the commit message using the **Write tool** to `.kangentic/COMMIT_MSG.tmp`:
   ```
   Release vX.Y.Z
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
- GitHub Actions: link to `https://github.com/Kangentic/kangentic/actions` -- the tag push triggers the Release workflow which builds platform artifacts and creates a draft GitHub Release.
- **Remind the user:** "Review and publish the draft release at https://github.com/Kangentic/kangentic/releases once the workflow completes."

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Bash` (for `git`, `npm`, and `npx` commands), `Write` (for commit message temp file), and `Edit` (for CHANGELOG.md).

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. Use `git -C <path>` for git commands in another directory -- never `cd <path> && git ...`.
