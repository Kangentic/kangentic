---
description: Create a PR and drive its CI checks to all-green (auto-fixing code and de-flaking/rewriting tests), then stop. Never merges. This is the Tests column skill. Use /merge-pull-request to merge a green PR.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent
argument-hint: [commit message]
---

# Pull Request

Commit, rebase, create a pull request, and drive its CI checks to all-green. This is the **Tests
column** skill: it offloads the expensive and flaky test tiers (unit, UI, and the Windows Electron
E2E tier) to GitHub Actions PR checks instead of running them on the local machine, then auto-fixes
any failures and de-flakes any flaky tests until the PR is green and flake-free.

It **never merges**. When the PR is green, the user manually moves the task Tests -> Ship It, where
`/merge-pull-request` merges it and pulls the result back into the local `main` checkout.

**Usage:** `/pull-request [commit message]`

- `/pull-request` - auto-generates a commit message from the diff
- `/pull-request added new e2e tests` - uses the provided text as the commit message

**User-provided commit message (if any):** $ARGUMENTS

## Pre-flight Checks

All git commands below run from the **current working directory** - never use `cd <path> && git
...` (triggers an unbypassable security prompt). Use `git -C <path>` to target another directory.

1. **Detect mode:**
   - If CWD contains `.kangentic/worktrees/` - **worktree mode** (the PR workflow below).
   - Otherwise - **main repo mode** (fall back to `/merge-back` behavior, see the note at the end).
2. Get the current branch name: `git rev-parse --abbrev-ref HEAD`
   - If `HEAD` (detached) - warn the user and stop.
3. **Worktree mode only:** Derive the project root by walking up from the worktree path - the
   project root is two directories above `.kangentic/worktrees/<slug>/` (strip
   `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch:
   - **Worktree mode:** `git config kangentic.baseBranch` (fallback: `main`).
   - **Main repo mode:** the current branch.
5. Run `git status --porcelain` to check for uncommitted changes.
6. Verify the GitHub CLI is authenticated: `gh auth status`. If it fails, report it and stop -
   this skill drives PR checks over `gh` and a long monitor loop must not start unauthenticated.

Report the mode, branch name, source branch, and working tree status before proceeding.

**Main repo mode:** If detected, fall back to `/merge-back` behavior (Steps 0-5 of merge-back.md)
and stop. The PR workflow below applies to worktree mode only.

## Step 0 - Local gate (typecheck + lint only)

The point of this skill is to OFFLOAD the slow and flaky tiers to CI. Run only the fast, reliable
local gates so a trivially broken push does not waste a full CI round:

1. Ensure dependencies are present: if `node_modules` is missing (a fresh worktree - worktrees do
   not share `node_modules` with the main repo), run `npm install` first. If it fails with EBUSY, a
   file is locked by a running process; report it and stop.
2. Run `npm run typecheck`. If it fails, report the errors and stop.
3. Run `npm run lint`. ESLint runs in CI with `--max-warnings 0`, so any error will fail the push.
   If it reports errors, report them and stop. Warnings do not block.

Do NOT run the unit, UI, or E2E tiers locally - CI owns them. (`/test` is still available for a
manual local run when you want it.)

## Step 1 - Commit Changes

If there are uncommitted changes (non-empty `git status --porcelain` output):

1. Show the user `git status` and `git diff --stat` for a summary of changes.
2. **Determine the commit message:**
   - If `$ARGUMENTS` is non-empty:
     - Check if it already starts with a conventional commit prefix (`feat:`, `fix:`, `refactor:`,
       `chore:`, `docs:`, `test:`, `style:`, `perf:`, `ci:`, `build:`, or any of these with `!`
       before the colon).
     - If it does, use it as-is.
     - If it does not, analyze the diff to determine the appropriate type prefix and prepend it.
       For example: `/pull-request added dark mode` becomes `feat: added dark mode`.
   - If `$ARGUMENTS` is empty:
     - Read the full diff (`git diff`), draft a concise commit message.
     - The message **MUST** use conventional commit format.
     - Determine the primary change type from the diff:
       - `feat:` - new features or capabilities
       - `fix:` - bug fixes
       - `refactor:` - restructuring without behavior change
       - `chore:` - maintenance (deps, config, tooling)
       - `docs:` - documentation-only changes
       - `test:` - test-only changes
       - `style:` - formatting-only changes
       - `perf:` - performance improvements
       - `ci:` - CI/CD changes
       - `build:` - build system changes
     - If the change is breaking, add `!` after the type (e.g., `feat!:`)
     - Scope is optional but encouraged for multi-area changes (e.g., `feat(pty):`, `fix(db):`)
3. **Update documentation before staging** - targeted anchor check (do NOT invoke `/sync-docs` as a
   skill call):
   a. Identify changed source files (exclude `docs/`, `.claude/`, `tests/`).
   b. If no source files changed, skip to step 4.
   c. Read the canonical anchor list from `.claude/skills/sync-docs/SKILL.md` Step 2 ("Anchor Point
      Verification"). That file is the single source of truth - do not maintain a duplicate list
      here. The list contains both single-file anchors (e.g., `src/shared/types.ts`,
      `src/main/agent/agent-adapter.ts`) and glob anchors (e.g., `src/main/db/migrations/**`,
      `src/main/agent/adapters/**`, `src/main/ipc/handlers/**`).
   d. If any changed file matches an anchor entry (single file or glob), spawn a `doc-auditor` agent
      with the matching files.
   e. If the agent reports gaps, fix them inline using the `Edit` tool.
   f. No general prose review here (that is `/sync-docs`'s job).
4. Stage changes: `git add -A`
5. Write the commit message using the **Write tool** to the relative path
   `.kangentic/COMMIT_MSG.tmp` (resolved from CWD - do NOT resolve an absolute path, do NOT use the
   system temp directory, do NOT use `os.tmpdir()`).

   `.kangentic/` is gitignored, so `git add -A` won't stage it and no cleanup is needed.
   Then commit: `git commit -F .kangentic/COMMIT_MSG.tmp`
   **Never write to `.git/`** - in worktrees `.git` is a file, not a directory.
   **Never use `$(...)` or backtick command substitution** - triggers a safety prompt.

If the working tree is clean, skip to Step 1.5.

## Step 1.5 - Compute the clean PUBLIC branch name (never rename the local branch)

The local branch, the worktree folder, and `tasks.branch_name` together encode Kangentic's session
identity: on a Done->back round-trip the worktree folder is re-derived from them
(`src/main/git/worktree-manager.ts` `createWorktree`), and Claude keys its transcript by that
folder's path, so renaming the LOCAL branch to a non-auto name can recreate the worktree at a
different path and orphan the session. We therefore NEVER rename the local branch.

A branch only needs to look professional where it is PUBLIC: the remote branch and the PR head. We
push the unchanged local branch to a clean remote name and open the PR from that. PR state resolves
by `pr_number` (branch-independent; `src/main/pr/pr-linking.ts`), so the local-vs-remote name
mismatch is a non-issue once Step 5b links the number.

Compute `<branch>`, the clean public name. The local HEAD is the push SOURCE and is never touched:

1. `<type>` = the conventional prefix of the Step 1 commit message (`feat`, `fix`, `chore`, ...).
2. `<desc>` = a clean kebab slug of the work. Resolve the task with `kangentic_get_current_task`
   (pass the worktree cwd + the local branch) and slugify its TITLE: lowercase, words joined by
   single hyphens, drop filler ("build", "the", "a", "add", "support for"), drop any trailing
   parenthetical or punctuation, cap to ~4-5 meaningful words. If `$ARGUMENTS` supplied a name,
   prefer it (strip a leading `<type>/`). Per the Conventional Branch spec: only `[a-z0-9-]`, no
   leading or trailing hyphen, no consecutive hyphens.
   - Example: "Build the in-app fluid window manager: modeless task windows" -> `in-app-window-manager`.
3. `<branch>` = `<type>/<desc>` (e.g. `feat/in-app-window-manager`). Every later step uses `<branch>`
   as the push TARGET and the PR head; the push SOURCE is always `HEAD` (the untouched local branch).
4. RESUMING: if the task already has a PR (`task.pr_number` set, or you previously pushed a remote
   branch for it), reuse that existing remote name as `<branch>` so the PR head stays valid - do not
   invent a new one.

## Step 2 - Fetch Latest Source Branch

Run: `git fetch origin <sourceBranch>`

Report if the fetch succeeded or if there were errors (e.g., no remote, authentication failure).

## Step 3 - Rebase onto Source Branch

Run: `git rebase origin/<sourceBranch>`

**If the rebase succeeds** - proceed to Step 3.5.

**If conflicts occur:**

1. Show the conflicting files using `git diff --name-only --diff-filter=U`
2. Ask the user which approach they prefer:
   - **Resolve conflicts** - open each conflicting file, edit the conflict markers, then `git add
     <file>` and `git rebase --continue`
   - **Abort entirely** - `git rebase --abort` and stop the process
3. If resolving conflicts: read each conflicting file, use `Edit` to resolve the conflict markers,
   stage the file, and continue the rebase. Repeat until all conflicts are resolved.

## Step 3.5 - Coverage pass (delegate to test-builder, gated)

Write any missing tests for the new functionality BEFORE the PR is created, so CI exercises them.

1. Compute the diff against the source branch: `git diff origin/<sourceBranch>...HEAD`.
2. If the diff touches no source files (docs/config/test-only), skip this step.
3. Otherwise spawn ONE `test-builder` agent in **write mode** scoped to the diff: "Audit coverage of
   this diff and implement any genuinely missing tests for the new functionality, following the tier
   rules and anti-flake patterns. Red-green each test. A clean no-op is fine if coverage is already
   adequate." Do not run the full suite locally - CI runs the new tests.
4. If `test-builder` wrote tests, stage and commit them with a `test:` message via
   `.kangentic/COMMIT_MSG.tmp` and `git commit -F .kangentic/COMMIT_MSG.tmp`.

Keep this proportional: a clean no-op on a thin or trivial diff is the expected outcome, so the
Tests column stays fast.

## Step 4 - Push the Branch

Run: `git push origin HEAD:<branch> --force-with-lease`

`--force-with-lease` is safe here (a personal worktree branch) and required after a rebase. If it
fails because someone else pushed to the branch, report it and stop - never bare `--force`.

## Step 5 - Create the Pull Request

1. **Determine PR title:** the first line of the most recent commit. If there are several commits
   since the source branch, combine them into one concise title.
2. **Determine PR body:** write a rich, reviewer-facing body and save it to `.kangentic/PR_BODY.tmp`
   with the Write tool (avoids shell escaping). Include:
   - `## Summary` - what changed and why.
   - `## Impact / behavior` - user-visible behavior, features, and bug fixes.
   - `## Test plan` - how it is verified (the CI checks plus any tests added in Step 3.5).
   - Footer: `Generated with [Claude Code](https://claude.com/claude-code)`
3. Run: `gh pr create --base <sourceBranch> --head <branch> --title "<title>" --body-file .kangentic/PR_BODY.tmp`

**If PR creation fails because one already exists:** run `gh pr view <branch>` and proceed to
Step 5b with the existing PR.

## Step 5b - Link the PR to the task

1. Extract the PR URL from the `gh pr create` output (or `gh pr view` if it already existed).
2. Parse the PR number from the URL (the numeric ID after `/pull/`).
3. Find the task with `kangentic_get_current_task` (pass the worktree cwd + the local branch).
   `<branch>` is the remote/PR name, NOT `tasks.branch_name`, so it is not a valid
   `kangentic_find_task` lookup key.
4. If a task is found, call `kangentic_update_task` with the task ID, `prUrl`, and `prNumber`.

This link is REQUIRED, not just best-effort: because `<branch>` (the PR head) differs from the
worktree's local HEAD by design, Kangentic's branch-based auto-detection will NOT find this PR - the
stored `pr_number` is the only thing connecting the task to it. If the update fails, retry it; do
not leave the task unlinked.

## Step 6 - Monitor checks until green

Wait for the PR's CI checks to finish, then branch on the outcome. Use `gh pr checks` in watch mode
rather than a manual poll loop (no `sleep` - the single-command rule forbids it):

1. The PR head is `<branch>` (the clean public name from Step 1.5), so `gh pr checks <branch>`
   resolves it. The local HEAD differs by design; PR resolution does not need them to match.
2. Run `gh pr checks <branch> --watch --fail-fast --interval 30` with a generous Bash tool
   `timeout` (about 40 minutes / `2400000` ms) as the hard wall-clock cap. `--watch` returns when
   the checks settle; `--fail-fast` returns as soon as one fails so the fix loop starts promptly.
   The Windows Electron E2E job is the long pole (a few minutes cold).
3. Interpret the result:
   - **All checks passed** (exit 0): go to Step 6b (flake scan).
   - **A check failed** (non-zero exit): go to Step 7 (auto-fix).
   - **The Bash timeout fired** (a check stuck pending): go to Step 8b (escalate, stuck checks).

## Step 6b - Flake scan (ZERO flaky tolerance)

A test that fails then passes on retry still counts as a failure here. CI runs the UI and Electron
projects with `retries: 1`, so a flake can show up as a GREEN check. Do not accept green-via-retry:

1. Identify the latest CI run for `<branch>` (`gh pr checks <branch> --json name,state,link` to find
   the run, then `gh run view <run-id>`).
2. Inspect the UI and E2E job output for any test that needed a retry (Playwright reports these as
   "flaky"). Retrieve the job log if needed to confirm.
3. If any flaky test is found, treat it exactly like a failure and go to Step 7 to de-flake it. Only
   when the checks are green AND no test was retried do you proceed to Step 8.

## Step 7 - Auto-fix loop (max 3 rounds, fully automatic)

Do NOT pause to ask. Each round, diagnose every failing or flaky check and fix it, then push and
re-monitor. Hard cap: 3 rounds. After the 3rd unsuccessful round, go to Step 8b.

For each round:

1. Pull the failure detail: `gh run view <run-id> --log-failed` (and the full job log for a flake
   that passed on retry).
2. Classify each problem and act automatically:
   - **Real regression** (the code is wrong): fix the code with `Edit`.
   - **Broken or wrong test** (the code is right, the assertion is stale): fix the test. Delegate
     non-trivial test fixes to a `test-builder` agent. Cross-platform parity
     (`.claude/rules/cross-platform-parity.md`) is the usual cause of a test that is green locally
     on Windows but red on CI's Linux runner.
   - **Flaky test** (passed on retry, or intermittent across shards/runs): do NOT accept it.
     Delegate to `test-builder` to rewrite it deterministically (replace fixed waits with conditional
     polls, disambiguate selectors, etc.). If it is genuinely unsalvageable, remove it with an
     explicit justification in the commit body. Leave NO flaky tests behind.
3. Commit the fixes (conventional message via `.kangentic/COMMIT_MSG.tmp`), then push:
   `git push origin HEAD:<branch> --force-with-lease`.
4. Return to Step 6 to re-monitor.

## Step 8 - Report (success)

The PR is green and flake-free. Report:
- PR URL (with link) and branch name.
- Number of commits and any tests written (Step 3.5) or rewritten/removed (Step 7).
- "All checks green, no flaky tests."
- Next step: the user moves the task Tests -> Ship It, where `/merge-pull-request` merges it.

**Do NOT merge.** Merging is `/merge-pull-request`'s job.

## Step 8b - Escalate (after 3 rounds, or stuck checks)

Stop. Do not start a 4th round and do not `--admin` bypass. Leave the PR open, pushed, and with no
half-finished rebase. Report concrete, learned recommendations so a human can finish quickly:
- For each still-failing or flaky check: the classification, what each round tried, and the root
  cause as far as you determined it.
- Specific recommendations, e.g. "remove test X - root cause Y, not fixable", "rewrite test Z to
  poll for <condition>", or "the regression is in `<file>:<line>`".
- The PR URL and the current red/pending check summary.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never `cd
<path> && git ...`. Conventional commit messages. No em-dashes or `--` as punctuation.
