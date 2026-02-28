# Merge Back

Merge the current worktree branch back into the source branch via rebase and direct push.

## Pre-flight Checks

1. Verify the current working directory is inside a Kangentic worktree (path contains `.kangentic/worktrees/`). If not, warn the user and stop.
2. Get the current branch name: `git rev-parse --abbrev-ref HEAD`
3. Determine the project root by walking up from the worktree path — the project root is two directories above `.kangentic/worktrees/<slug>/` (i.e., strip `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch using Bash (not the Read tool — the config file is outside the worktree and triggers a permission prompt): run `cat <projectRoot>/.kangentic/config.json 2>/dev/null` and parse `git.defaultBaseBranch` from the JSON output. If the file doesn't exist or the field is missing, default to `main`.
5. Run `git status --porcelain` to check for uncommitted changes.

Report the branch name, source branch, and working tree status before proceeding.

## Step 0 — Type Check

Run `npm run typecheck` in the worktree. If it fails, report the type errors and stop — do not proceed with the merge. Type errors must be fixed before merging back.

## Step 1 — Commit Changes

If there are uncommitted changes (non-empty `git status --porcelain` output):

1. **Ask the user first** (before showing diffs) how they want to handle the commit message:
   - **Auto-generate** — you will read the diff and write the message
   - **Manual** — the user will provide the message
2. Show the user `git status` and `git diff --stat` for a summary of changes.
3. If **auto-generate**: read the full diff (`git diff`), draft a concise commit message summarizing the changes, then `git add -A` and `git commit -m "<message>"` immediately — do not ask the user to confirm or edit the message.
4. If **manual**: ask the user for their commit message, then `git add -A` and `git commit -m "<message>"`.

If the working tree is clean, skip to Step 2.

## Step 2 — Fetch Latest Source Branch

Run: `git fetch origin <sourceBranch>`

Report if the fetch succeeded or if there were errors (e.g., no remote, authentication failure).

## Step 3 — Rebase onto Source Branch

Run: `git rebase origin/<sourceBranch>`

**If the rebase succeeds** — proceed to Step 4.

**If conflicts occur:**

1. Show the conflicting files using `git diff --name-only --diff-filter=U`
2. Ask the user which approach they prefer:
   - **Resolve conflicts** — open each conflicting file, edit the conflict markers, then `git add <file>` and `git rebase --continue`
   - **Abort and merge instead** — `git rebase --abort` then `git merge origin/<sourceBranch>` (creates a merge commit)
   - **Abort entirely** — `git rebase --abort` and stop the merge-back process
3. If resolving conflicts: read each conflicting file, use `Edit` to resolve the conflict markers, stage the file, and continue the rebase. Repeat until all conflicts are resolved.

## Step 4 — Push to Source Branch

Run: `git push origin HEAD:<sourceBranch>`

This pushes the rebased commits directly to the remote source branch. After a successful rebase, this is guaranteed to be a fast-forward push.

**If the push fails** (e.g., someone else pushed in the meantime):

1. Report the error clearly.
2. Suggest re-running `/merge-back` to fetch the latest and rebase again.
3. Stop — do not force-push.

## Step 5 — Report

Summarize:
- Branch name that was merged
- Source branch that received the changes
- Number of commits landed (from `git log origin/<sourceBranch>@{1}..origin/<sourceBranch> --oneline` or similar)
- Remind the user they can clean up the worktree by moving the task to Done on the board (which triggers `cleanup_worktree`) or manually

## Step 6 — Update Local Source Branch

The project root (determined in pre-flight step 3) always has the source branch checked out. Run `git -C <projectRoot> pull --ff-only` to fast-forward it to match the remote.

If this fails (e.g., non-fast-forward divergence), report the warning but do not treat it as a fatal error — the remote is already updated.

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Bash` (for `git` commands and reading config files outside the worktree via `cat`), `Edit` (for conflict resolution), and `AskUserQuestion`. Do not use `Write`. Do not use `Read` for files outside the worktree (e.g., project root config) — use `Bash` with `cat` instead to avoid permission prompts.

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`. For git commands in the worktree, use `git -C <worktreePath>` — never `cd <path> && git ...`.
