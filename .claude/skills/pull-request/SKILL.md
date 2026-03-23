---
description: Commit, rebase, create PR, and admin-merge to source branch
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent
argument-hint: [commit message]
---

# Pull Request

Safely commit, rebase, create a PR, and admin-merge. Works from worktrees (creates PR) and main repo (falls back to direct push like `/merge-back`).

**Usage:** `/pull-request [commit message]`

- `/pull-request` -- auto-generates a commit message from the diff
- `/pull-request added new e2e tests` -- uses the provided text as the commit message

**User-provided commit message (if any):** $ARGUMENTS

## Pre-flight Checks

All git commands below run from the **current working directory** -- never use `cd <path> && git ...` (triggers an unbypasable security prompt). The only exception is Step 7 which uses `git -C <projectRoot>` to target the main repo.

1. **Detect mode:**
   - If CWD contains `.kangentic/worktrees/` -- **worktree mode** (PR workflow)
   - Otherwise -- **main repo mode** (direct push, same as `/merge-back`)
2. Get the current branch name: `git rev-parse --abbrev-ref HEAD`
   - If `HEAD` (detached) -- warn the user and stop.
3. **Worktree mode only:** Derive the project root by walking up from the worktree path -- the project root is two directories above `.kangentic/worktrees/<slug>/` (i.e., strip `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch:
   - **Worktree mode:** `git config kangentic.baseBranch` (fallback: `main`)
   - **Main repo mode:** same as the current branch (push to own remote tracking branch)
5. Run `git status --porcelain` to check for uncommitted changes.

Report the mode, branch name, source branch, and working tree status before proceeding.

**Main repo mode:** If detected, fall back to `/merge-back` behavior (Steps 0-5 of merge-back.md). The PR workflow below only applies to worktree mode.

## Step 0 -- Type Check

Run `npm run typecheck`. If it fails, report the type errors and stop -- do not proceed. Type errors must be fixed before creating a PR.

## Step 1 -- Commit Changes

If there are uncommitted changes (non-empty `git status --porcelain` output):

1. Show the user `git status` and `git diff --stat` for a summary of changes.
2. **Determine the commit message:**
   - If `$ARGUMENTS` is non-empty:
     - Check if it already starts with a conventional commit prefix (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `style:`, `perf:`, `ci:`, `build:`, or any of these with `!` before the colon).
     - If it does, use it as-is.
     - If it does not, analyze the diff to determine the appropriate type prefix and prepend it. For example: `/pull-request added dark mode` becomes `feat: added dark mode`.
   - If `$ARGUMENTS` is empty:
     - Read the full diff (`git diff`), draft a concise commit message.
     - The message **MUST** use conventional commit format.
     - Determine the primary change type from the diff:
       - `feat:` -- new features or capabilities
       - `fix:` -- bug fixes
       - `refactor:` -- restructuring without behavior change
       - `chore:` -- maintenance (deps, config, tooling)
       - `docs:` -- documentation-only changes
       - `test:` -- test-only changes
       - `style:` -- formatting-only changes
       - `perf:` -- performance improvements
       - `ci:` -- CI/CD changes
       - `build:` -- build system changes
     - If the change is breaking, add `!` after the type (e.g., `feat!:`)
     - Scope is optional but encouraged for multi-area changes (e.g., `feat(pty):`, `fix(db):`)
3. **Update documentation before staging** -- targeted anchor check (do NOT invoke `/update-docs` as a skill call):
   a. Identify changed source files (exclude `docs/`, `.claude/`, `tests/`).
   b. If no source files changed, skip to step 4.
   c. Check if any changed file is an anchor source (see `.claude/skills/docs-maintenance/SKILL.md` Anchor Points):
      - `src/shared/types.ts`, `src/shared/ipc-channels.ts`, `src/main/db/migrations.ts`
      - `src/renderer/components/settings/AppSettingsPanel.tsx`, `src/renderer/components/settings/settings-registry.ts`
      - `src/shared/template-vars.ts`
   d. If anchor source files changed: spawn a `doc-auditor` agent with those files.
   e. If the agent reports gaps, fix them inline using the `Edit` tool.
   f. No general prose review here (that is `/update-docs`'s job).
4. Stage changes: `git add -A`
5. Write the commit message using the **Write tool** to the relative path `.kangentic/COMMIT_MSG.tmp` (resolved from CWD -- do NOT resolve an absolute path, do NOT use the system temp directory, do NOT use `os.tmpdir()`).

   `.kangentic/` is gitignored, so `git add -A` won't stage it and no cleanup is needed.
   Then commit: `git commit -F .kangentic/COMMIT_MSG.tmp`
   **Never write to `.git/`** -- in worktrees `.git` is a file, not a directory.
   **Never use `$(...)` or backtick command substitution** -- triggers a safety prompt.

If the working tree is clean, skip to Step 2.

## Step 2 -- Fetch Latest Source Branch

Run: `git fetch origin <sourceBranch>`

Report if the fetch succeeded or if there were errors (e.g., no remote, authentication failure).

## Step 3 -- Rebase onto Source Branch

Run: `git rebase origin/<sourceBranch>`

**If the rebase succeeds** -- proceed to Step 4.

**If conflicts occur:**

1. Show the conflicting files using `git diff --name-only --diff-filter=U`
2. Ask the user which approach they prefer:
   - **Resolve conflicts** -- open each conflicting file, edit the conflict markers, then `git add <file>` and `git rebase --continue`
   - **Abort entirely** -- `git rebase --abort` and stop the process
3. If resolving conflicts: read each conflicting file, use `Edit` to resolve the conflict markers, stage the file, and continue the rebase. Repeat until all conflicts are resolved.

## Step 4 -- Push to Worktree Branch

Push the rebased commits to the **worktree's own branch** (NOT the source branch). This creates or updates the remote branch that the PR will be opened from.

Run: `git push origin HEAD:<branchName> --force-with-lease`

`--force-with-lease` is safe here because this is a personal worktree branch, not a shared branch. After rebase, the history has changed so a regular push would fail.

**If the push fails:**

1. Report the error clearly.
2. Stop -- do not force-push without lease.

## Step 5 -- Create Pull Request

Create a PR from the worktree branch to the source branch:

1. **Determine PR title:** Use the first line of the most recent commit message. If there are multiple commits since the source branch, combine them into a concise title.
2. **Determine PR body:** Write a conventional PR body with:
   - `## Summary` -- bullet points summarizing the changes
   - `## Test plan` -- checklist of verification steps
   - Footer: `Generated with [Claude Code](https://claude.com/claude-code)`
3. Run: `gh pr create --base <sourceBranch> --head <branchName> --title "<title>" --body "<body>"`

   Write the body to `.kangentic/PR_BODY.tmp` using the Write tool, then use `--body-file .kangentic/PR_BODY.tmp` instead of inline `--body` to avoid shell escaping issues.

**If PR creation fails** (e.g., PR already exists):

1. Check if a PR already exists: `gh pr view <branchName>`
2. If it does, report the existing PR URL and proceed to Step 6 (merge it).

## Step 5b -- Update Task with PR URL

After the PR is created (or an existing PR is found), link it to the Kangentic task:

1. Extract the PR URL from the `gh pr create` output (it prints the URL to stdout on success) or from `gh pr view` if the PR already existed.
2. Parse the PR number from the URL (the numeric ID at the end of `/pull/<number>`).
3. Find the current task using `kangentic_find_task` with the branch name from Step 0.
4. If a task is found, call `kangentic_update_task` with the task ID, `prUrl`, and `prNumber`.

If the task lookup or update fails, log the error but do not block - the PR was already created successfully. This step is best-effort alongside the automatic PR detection built into Kangentic.

## Step 6 -- Admin Merge

Merge the PR immediately using admin privileges to bypass status check wait:

Run: `gh pr merge <branchName> --rebase --admin --delete-branch`

- `--rebase`: preserves individual commits on the source branch (no merge commits)
- `--admin`: bypasses required status checks (safe because we already ran typecheck locally in Step 0)
- `--delete-branch`: removes the remote worktree branch immediately after merge

**If merge fails:**

1. Report the error clearly.
2. If it's a permissions issue, suggest the user merge manually on GitHub.
3. Stop.

## Step 7 -- Update Local Source Branch (always runs in worktree mode)

The project root (determined in pre-flight step 3) always has the source branch checked out. Run `git -C <projectRoot> pull --ff-only` to fast-forward it to match the remote.

If this fails (e.g., non-fast-forward divergence), report the warning but do not treat it as a fatal error -- the remote is already updated.

## Step 8 -- Report

Summarize:
- Mode (worktree or main repo)
- PR URL (with link)
- Branch name that was merged
- Source branch that received the changes
- Number of commits landed
- Branch cleanup status (remote branch deleted by `--delete-branch`)
- **Reminder:** The user can clean up the local worktree by moving the task to Done on the board (which triggers `cleanup_worktree`) or manually

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` -- never `cd <path> && git ...`.
