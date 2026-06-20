---
description: Merge an already-green PR (rebase merge, delete branch) and fast-forward the local main checkout for HMR. This is the Ship It column skill. It assumes the Tests column (/pull-request) already drove the PR to green. Not for creating a PR (use /pull-request) or a direct quick-push (use /merge-back).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent
---

# Merge Pull Request

Merge a green pull request and pull the result back into the local `main` checkout so the
dogfooding `npm start` picks it up via HMR. This is the **Ship It column** skill. It assumes the
**Tests column** (`/pull-request`) already created the PR and drove its CI checks to all-green and
flake-free.

It verifies the required CI checks are green, then merges with `--admin` to waive the review
requirement: `main` requires one approving review, but a maintainer's own PRs get no second
reviewer, so that bypass is the normal Ship It path. It NEVER bypasses the CI checks - those are
confirmed green first; the `--admin` only waives the missing review. (For a deliberate direct
quick-push that skips the whole PR gate, use `/merge-back` instead.)

**Usage:** `/merge-pull-request`

## Pre-flight Checks

All git commands run from the **current working directory** - never `cd <path> && git ...`. Use
`git -C <path>` to target another directory.

1. **Detect mode:** worktree mode requires CWD to contain `.kangentic/worktrees/`. If this is the
   main repo (no worktree), stop and tell the user this skill runs from a task worktree (the Ship It
   column); a direct push from the main checkout is `/merge-back`.
2. Get the current branch: `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), warn and stop.
3. Derive the project root: two directories above `.kangentic/worktrees/<slug>/` (strip
   `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch: `git config kangentic.baseBranch` (fallback: `main`).
5. Verify the GitHub CLI is authenticated: `gh auth status`. If it fails, report it and stop.

## Step 0 - Resolve the PR by the live HEAD branch

Always resolve the PR from the actual worktree HEAD, never from a stored slug (agents rename
branches, so the stored `tasks.branch_name` can be stale - this mirrors the resolve-by-HEAD ladder
in `src/main/pr/pr-linking.ts`).

1. `<branch>` is the current branch from pre-flight.
2. Run `gh pr view <branch> --json number,url,state,mergeable,mergeStateStatus,statusCheckRollup,headRefName`.
3. If no PR is found for `<branch>`, stop and report that the Tests column should have created one
   (run `/pull-request` from the Tests column first). Do not create a PR here.

## Step 1 - Doc review at merge time

The Tests column normally ran the targeted doc-anchor check at commit time, but it is skipped when
`/pull-request` had nothing to commit. Re-audit the anchor files across the whole branch diff so a
gap cannot slip through:

1. Determine the anchor source files in the branch diff (compare the current diff against
   `origin/<sourceBranch>`), then narrow to files matching the canonical anchor list in
   `.claude/skills/sync-docs/SKILL.md` Step 2. If none, skip to Step 2.
2. Spawn a `doc-auditor` agent with the matching anchor files. Fix any reported gaps inline with
   `Edit`.
3. If docs changed, commit them (`docs:` message via `.kangentic/COMMIT_MSG.tmp`) and push:
   `git push origin HEAD:<branch> --force-with-lease`.

## Step 2 - Re-verify (rebase if main moved, confirm green and mergeable)

1. `git fetch origin <sourceBranch>`.
2. If `main` moved since the PR went green, rebase onto it: `git rebase origin/<sourceBranch>`
   (resolve conflicts the same way `/pull-request` does, or abort and report). If the rebase changed
   history, push: `git push origin HEAD:<branch> --force-with-lease`.
3. Re-read the PR state: `gh pr view <branch> --json mergeable,mergeStateStatus,statusCheckRollup`.
   **Require every required status check in `statusCheckRollup` to be green (SUCCESS).** That is the
   real gate - do not rely on the merge command to enforce it. `mergeStateStatus` will usually read
   `BLOCKED` rather than `CLEAN` here because the maintainer's own PR has no approving review; that
   block is EXPECTED and is waived by the `--admin` merge in Step 3. But if a required CHECK is
   failing or still pending (not merely the review), stop (or wait - step 4); never `--admin` past a
   red or pending check.
4. If the rebase (step 2) re-triggered checks and they are pending, wait for them with
   `gh pr checks <branch> --watch --fail-fast --interval 30` (Bash `timeout` about `2400000` ms). If
   they go red, stop and report - this should be rare because Tests already drove them green; the
   user can move the task back to Tests to re-run `/pull-request`.

## Step 3 - Merge the PR

Only after Step 2 confirmed every required CHECK is green, merge with the maintainer bypass that
waives the missing review:

Run: `gh pr merge <branch> --admin --rebase --delete-branch`

- `--admin`: waives the required approving review (the maintainer's own PR gets no second reviewer).
  It does NOT relax the CI gate - Step 2 already verified the checks are green; this only clears the
  review block. NEVER run it without that green-check verification (it would also bypass the checks).
- `--rebase`: lands the individual commits on the source branch (no merge commit).
- `--delete-branch`: deletes the local and remote PR branch after merge.

**If the merge fails** for any reason other than the expected missing-review block (e.g. the branch
is behind and needs a rebase first, or a required check actually went red), do NOT force past it -
report the unmet requirement and stop.

### Realign the worktree branch (so move-to-Done reads clean)

The `--rebase` merge rewrote the PR commits onto `<sourceBranch>` with NEW SHAs, so the worktree's
branch still holds the pre-rebase commits (same content, different SHAs). Left as-is, the board's
move-to-Done check reports them as "N commits remain only on the local branch" - a false positive
that makes the Done move look unsafe (unlike `/merge-back`, whose same-SHA direct push never
diverged). Realign the worktree branch onto the merged base:

1. Confirm the worktree is clean: `git status --porcelain` (empty right after the merge). If it is
   NOT empty, skip the realign and report - never discard uncommitted work.
2. `git fetch origin <sourceBranch>` to refresh the merged base.
3. `git rebase origin/<sourceBranch>`. Git drops the now-merged commits (matched by patch-id) and
   replays only any genuinely-unmerged local commits, leaving the branch at the merged HEAD (plus
   any real leftover work, which SHOULD still warn on move-to-Done).
4. On conflict (rare - only a genuinely-unmerged local commit can clash), abort cleanly:
   `git rebase --abort`, then report. Never leave a half-finished rebase in the worktree.

## Step 4 - Pull back into the local main checkout

The project root is the dogfooding checkout (`npm start` serves the main process from it), so keep
it fast-forwarded to the freshly merged `main`. This step is salvaged from `/merge-back` and handles
divergence loudly rather than letting it compound.

1. Fast-forward it: `git -C <projectRoot> pull --ff-only`. If this succeeds, you are done.
2. **If it fails, do NOT just log a soft warning - that is how divergence compounds.** A
   fast-forward is impossible the moment the local source branch has even one commit the remote
   lacks. Diagnose and surface it:
   a. Run `git -C <projectRoot> status -sb` to read the ahead/behind counts.
   b. If the local branch is **behind only** (ahead 0) and the ff still failed, the working tree
      likely has uncommitted changes. Report that and stop - do not stash or discard the user's work.
   c. If the local branch is **ahead** (has unpushed local commits), list them with
      `git -C <projectRoot> log --oneline origin/<sourceBranch>..<sourceBranch>` and name them. These
      block every future ff-pull until reconciled.
3. **Offer to reconcile the ahead case** (do not do it silently):
   - Rebase: `git -C <projectRoot> rebase origin/<sourceBranch>`.
   - If the user wants those commits upstream, push: `git -C <projectRoot> push origin <sourceBranch>`.
   - **On conflict, abort cleanly:** `git -C <projectRoot> rebase --abort`, then report manual steps.
     NEVER leave the running dogfooding checkout in a half-finished rebase.

The remote `main` is already updated by Step 3, so a failure here is non-fatal to the merge - but it
is not "ignore and move on": an un-surfaced local commit will keep breaking this step.

**Prevention:** the local `main` checkout should only ever fast-forward. Do not commit directly to
it - use a worktree or feature branch.

## Step 5 - Report

Summarize:
- PR URL (with link) and the branch that was merged.
- The source branch that received the changes and the number of commits landed.
- Branch cleanup status (remote and local PR branch deleted by `--delete-branch`).
- Local `main` checkout status (fast-forwarded for HMR, or the divergence you surfaced).
- **Reminder:** move the task to Done on the board to trigger `cleanup_worktree` and remove the local
  worktree.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never `cd
<path> && git ...`. Conventional commit messages. No em-dashes or `--` as punctuation.
