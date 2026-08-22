---
description: Merge an already-green PR (rebase merge, delete branch) and fast-forward the local main checkout for HMR. This is the Merge column skill. It assumes the Testing column (/pull-request) already drove the PR to green. Not for creating a PR (use /pull-request) or a direct quick-push (use /merge-back).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent, mcp__kangentic__kangentic_get_current_task, mcp__kangentic__kangentic_link_pr
---

# Merge Pull Request

Merge a green pull request and pull the result back into the local `main` checkout so the
dogfooding `npm start` picks it up via HMR. This is the **Merge column** skill. It assumes the
**Testing column** (`/pull-request`) already created the PR and drove its CI checks to all-green and
flake-free.

It verifies the CI checks are green, then merges with `--admin` to waive the review requirement:
`main` requires one approving review, but a maintainer's own PRs get no second reviewer, so that
bypass is the normal Merge path. It NEVER bypasses the CI checks - those are confirmed green
first; the `--admin` only waives the missing review. (For a deliberate direct quick-push that skips
the whole PR gate, use `/merge-back` instead.)

**This skill merges.** By the time a task reaches Merge the decision to ship has been made, and
this skill executes it. Red or pending CI is the only thing that may stop a run, and even then only
until the checks resolve. Anything else it finds - a stale doc, a bad comment, a lint nit - it
**fixes here and then merges**, accepting a second CI round as the price. It never hands the problem
back to the user, never bounces the task to another column, and never ends with a green PR still
open. If you are about to stop without merging, you are almost certainly doing the wrong thing.

**Usage:** `/merge-pull-request`

## Pre-flight Checks

All git commands run from the **current working directory** - never `cd <path> && git ...`. Use
`git -C <path>` to target another directory.

1. **Detect mode:** worktree mode requires CWD to contain `.kangentic/worktrees/`. If this is the
   main repo (no worktree), stop and tell the user this skill runs from a task worktree (the Merge
   column); a direct push from the main checkout is `/merge-back`.
2. Get the current branch: `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), warn and stop.
3. Derive the project root: two directories above `.kangentic/worktrees/<slug>/` (strip
   `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch: `git config kangentic.baseBranch` (fallback: `main`).
5. Verify the GitHub CLI is authenticated: `gh auth status`. If it fails, report it and stop.

## Step 0 - Resolve the PR (by stored number first, head branch as fallback)

The PR's head branch may NOT equal the worktree's local branch. `/pull-request` pushes the unchanged
local branch to a clean PUBLIC remote name (`<type>/<desc>`) and opens the PR from THAT, keeping the
local branch as the session-safe slug-hex (see `/pull-request` Step 1.5). So resolve the PR the way
`src/main/pr/pr-linking.ts` does - by the stored `pr_number` first (branch-independent), falling back
to the head branch only when there is no stored number.

1. `<branch>` is the current LOCAL branch from pre-flight. It is used later ONLY for local git
   operations (the worktree realign), NEVER for `gh pr` lookups.
2. Resolve the PR number `<pr>`:
   - Call `kangentic_get_current_task` (it reads the worktree's task) and take its `pr_number`. If
     present, that is `<pr>` (the reliable, branch-independent path). Also record the returned
     task's ID as `<taskId>` - it is reused in Step 3 to force an immediate board refresh after the
     merge. If no task is found, `<taskId>` stays unset and that refresh is skipped.
   - If absent, fall back to the head branch: `gh pr list --head <branch> --state open --json number`
     (covers older PRs where the local branch IS the head); `<pr>` is the first match's number.
3. Run `gh pr view <pr> --json number,url,state,mergeable,mergeStateStatus,statusCheckRollup,headRefName`.
   Record `<prHead>` = `headRefName` (the PR's REMOTE head branch - the push and merge target).
4. If no PR resolves either way, stop and report that the Testing column should have created one (run
   `/pull-request` from the Testing column first). Do not create a PR here.

Every later `gh pr` command (view, checks, merge) targets `<pr>` or `<prHead>`; the local `<branch>`
is for local git only.

## Step 1 - Doc backstop (fix anything it finds, here and now)

The doc audit's real home is `/pull-request`, BEFORE the PR is created (its Step 1 item 3, which
runs against the branch diff even when the tree is clean). This step is a cheap BACKSTOP for what
that pass missed.

**If the backstop finds a gap, FIX IT HERE.** Do not bounce the task back to Testing, do not file a
follow-up task, do not merge around it, and do not end the run with the PR still open. Edit the doc,
commit it, push it, wait out the CI round it re-triggers, and then merge. **Running CI twice is an
accepted cost** - it is cheaper than shipping a doc that lies, and far cheaper than a human
round-trip through the board to fix one sentence.

This was learned from a real Merge run that stalled: the backstop found a genuinely stale sentence,
refused to merge, and told the user to move the task back to Testing. The finding was right and the
refusal was wrong - it left a 24/24-green PR sitting open over a one-clause doc edit this skill was
perfectly able to make.

1. Determine the anchor source files in the branch diff (compare the current diff against
   `origin/<sourceBranch>`), then narrow to files matching the canonical anchor list in
   `.claude/skills/sync-docs/SKILL.md` Step 2. If none, skip to Step 2.
2. Spawn a `doc-auditor` agent. Ask it BOTH questions: whether the docs still enumerate every
   anchor, AND whether any prose describing this diff's behavior has gone stale. The second is
   outside the agent's default contract (`.claude/agents/doc-auditor.md`: "Ignore prose"), so it
   answers it only when asked. Give it a prose summary of what each changed file now does, not a
   bare file list.
3. If it reports no gap, go to Step 2. This is the expected outcome.
4. If it reports a gap, **verify it yourself** by reading the cited `file:line` - a prose finding is
   the agent working outside its contract, so confirm the sentence is actually stale before editing.
   Then fix it with `Edit`, commit with a `docs:` message via `.kangentic/COMMIT_MSG.tmp`, and push
   to the PR head: `git push origin HEAD:<prHead>`.

   **Plain push, no `--force-with-lease`.** This adds a commit rather than rewriting history, so no
   force is needed - and a lease would likely be REJECTED here anyway, because pushing via
   `HEAD:<prHead>` never updates the local remote-tracking ref for `<prHead>`, leaving the lease
   stale. Reach for `--force-with-lease` only after a rebase (Step 2 item 2), and `git fetch` first
   to refresh the lease.

   Step 2 item 4 then waits out the re-triggered CI before the merge. That is expected, not a
   failure.

## Step 2 - Re-verify (rebase if main moved, confirm green and mergeable)

1. `git fetch origin <sourceBranch>`.
2. If `<sourceBranch>` moved since the PR went green, rebase onto it: `git rebase origin/<sourceBranch>`
   (resolve conflicts the same way `/pull-request` does, or abort and report). If the rebase changed
   history, push the local HEAD to the PR's remote head: `git push origin HEAD:<prHead> --force-with-lease`.
3. Re-read the PR state: `gh pr view <pr> --json mergeable,mergeStateStatus,statusCheckRollup`.
   **Require EVERY check in the rollup to be green (SUCCESS)** - the whole set, not the
   branch-protection-required subset. That is the real gate; do not rely on the merge command to
   enforce it.

   **Never gate on `gh pr checks --required`.** This repo marks only four checks required (build,
   lint, typecheck, cla), so `--required` reports all-green while every UI shard, E2E shard, and
   unit shard is still running. That has already happened once: `--required` said green with 16
   checks in flight, and an `--admin` merge at that moment would have waived all 16. Use
   `gh pr checks <pr> --json name,state` and confirm the count of SUCCESS equals the total.

   `mergeStateStatus` will usually read `BLOCKED` rather than `CLEAN` here because the maintainer's
   own PR has no approving review; that block is EXPECTED and is waived by the `--admin` merge in
   Step 3. But if a CHECK is failing or still pending (not merely the review), stop (or wait -
   step 4); never `--admin` past a red or pending check.
4. If the rebase (step 2) re-triggered checks and they are pending, wait for them with
   `gh pr checks <pr> --watch --fail-fast --interval 30` (Bash `timeout` about `2400000` ms). If
   they go red, stop and report - this should be rare because Testing already drove them green; the
   user can move the task back to Testing to re-run `/pull-request`.

## Step 3 - Merge the PR

Only after Step 2 confirmed every required CHECK is green, merge with the maintainer bypass that
waives the missing review:

Run: `gh pr merge <pr> --admin --rebase --delete-branch`

- `--admin`: waives the required approving review (the maintainer's own PR gets no second reviewer).
  It does NOT relax the CI gate - Step 2 already verified the checks are green; this only clears the
  review block. NEVER run it without that green-check verification (it would also bypass the checks).
- `--rebase`: lands the individual commits on the source branch (no merge commit).
- `--delete-branch`: deletes the remote PR head branch (`<prHead>`). The local `<branch>` has a
  different name (the slug-hex), so gh's local-branch delete is a no-op and the worktree branch
  stays for the realign below.

**Merge-method fallback - if `--rebase` fails with "can't be rebased":** the PR history contains a
merge commit (typically from a mid-task `git merge origin/<sourceBranch>` that integrated the base
with conflict resolutions). GitHub cannot linearize that, so a rebase merge is impossible. Fall back
to a SQUASH, which still keeps `<sourceBranch>` LINEAR and lands the feature as one commit (the
granular history stays preserved in the PR): `gh pr merge <pr> --admin --squash --delete-branch`. Do
NOT use `--merge`: a merge commit would break the linear-`main` convention this repo maintains.
Record `<mergeMethod>` (rebase or squash) - it selects the realign below.

**If the merge fails** for any OTHER reason than the expected missing-review block (e.g. the branch
is behind and needs a rebase first, or a required check actually went red), do NOT force past it -
report the unmet requirement and stop.

### Refresh the board's PR status

The board caches each task's PR state and only re-resolves it on a background timer (default 5 min)
or on project open, so the Merge card would otherwise keep showing "PR #<pr> open" for minutes
after this merge. Force an immediate re-resolve so the card flips to "merged" right away:

- If Step 0 resolved a `<taskId>`, call `kangentic_link_pr` with that task ID. It re-resolves the PR
  by number (branch-independent, so it works after `--delete-branch`), writes the fresh `merged`
  state, and pushes the update so the board card re-renders at once.
- If no `<taskId>` was resolved (the worktree has no linked task), skip this - there is no board card
  tracking the PR, so nothing is stale.

Run this right after the merge succeeds, before the realign below, so the board updates even if the
realign later needs to stop for a conflict.

### Realign the worktree branch (so move-to-Done reads clean)

The merge rewrote the PR commits onto `<sourceBranch>` (new SHAs for a rebase merge, or a single new
squash commit), so the worktree's local branch still holds the pre-merge commits. Left as-is, the
board's move-to-Done check reports them as "N commits remain only on the local branch" - a false
positive. Realign the worktree branch onto the merged base, by `<mergeMethod>`:

1. Confirm the worktree is clean: `git status --porcelain` (empty right after the merge). If it is
   NOT empty, skip the realign and report - never discard uncommitted work.
2. `git fetch origin <sourceBranch>` to refresh the merged base.
3. Realign by merge method:
   - **rebase merge:** `git rebase origin/<sourceBranch>`. Git drops the now-merged commits (matched
     by patch-id) and replays only any genuinely-unmerged local commits, leaving the branch at the
     merged HEAD (plus any real leftover work, which SHOULD still warn on move-to-Done).
   - **squash merge:** the local commits do NOT patch-match the single squash commit, so a rebase
     would not cleanly drop them. Since step 1 confirmed the worktree is clean and every change is
     now in the squash on `<sourceBranch>`, reset the branch to the merged base instead:
     `git reset --hard origin/<sourceBranch>`. This is safe PRECISELY because the worktree is clean
     and the content is fully merged; never reset if step 1 found uncommitted work.
4. On a rebase conflict (rare - only a genuinely-unmerged local commit can clash), abort cleanly:
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
- Branch cleanup status: the remote PR head (`<prHead>`) deleted by `--delete-branch`; the local
  worktree branch (`<branch>`, a different name) realigned to the merged base and removed later by
  move-to-Done.
- Local `main` checkout status (fast-forwarded for HMR, or the divergence you surfaced).
- **Reminder:** move the task to Done on the board to trigger `cleanup_worktree` and remove the local
  worktree.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never `cd
<path> && git ...`. Conventional commit messages. No em-dashes or `--` as punctuation.
