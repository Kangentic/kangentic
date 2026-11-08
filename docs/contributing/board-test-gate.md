---
type: Guide
title: Board test gate
description: How the Code Review, Testing and Merge columns gate a change on this repo's own board, what each column's skill runs, how a red check in Merge sends the task back to Testing and the cap on that loop, why a review pass commits in the task's own worktree, and the Ready or Blocked verdict and ledger it leaves.
tags: [contributing, testing, code-review, ci, board]
sources:
  - resource: .claude/skills/code-review/SKILL.md
  - resource: .claude/skills/pull-request/SKILL.md
  - resource: .claude/skills/merge-pull-request/SKILL.md
  - resource: scripts/review-verdict.mjs
  - resource: scripts/tested-tree.mjs
---
# Board test gate

The expensive and flaky tiers run on CI as PR checks, not on the local machine. Moving a task into
the **Testing** column runs `/pull-request`: it creates a PR and drives its CI checks (lint,
typecheck, unit, build, the UI shards, and the Linux Electron E2E shards) to all-green, auto-fixing
the code and de-flaking or rewriting tests along the way, then stops without merging. Moving it into
**Merge** runs `/merge-pull-request`: it merges the green PR and fast-forwards the local `main`
checkout for HMR. PRs are the normal path to `main` (CI gates it); `/merge-back` stays a direct
quick-push escape hatch for admins. `/test` is for **manual local runs** only and is not wired to a
column.

Merge runs one agent at a time (`maxAgents: 1`), so each PR rebases onto the one merged before it,
and its checks run again on that base. When Merge rebases onto a moved `main` and a check goes red, the task goes back to Testing on
its own: `/merge-pull-request` ends on `PR: checks red`, the Merge column's "Back to Testing" row
moves the task, `/pull-request` fixes or de-flakes the check (a flake that came in from `main`
included), and its `PR: ready to merge` brings the task back to Merge. Leaving Merge frees its slot
at once. On 2026-11-07 two red stops instead waited in Merge for a person and held that one slot for
about 30 minutes each, until the idle pause. The back-route runs at most twice on a task, and
Testing's "On to Merge" row allows one more run than that, since a row's Frequency counts across the
board's own moves. A third red stop finds the row spent, and the board holds the card in Merge with
the `agent-stopped` mark, so a `main` that stays red cannot bounce a task forever. A stop that needs
a person (a rebase conflict that needs judgment, a merge refused for anything but the missing review,
the realign and main-checkout stops) ends on `Needs owner:` and stays in Merge.

The push to `main` that a merge makes does not run those checks again. `main` requires a PR to be
up to date and PRs land by rebase, so the push carries the tree the PR's head already passed on, and
the run's `Tree already tested` job passes it in seconds (`scripts/tested-tree.mjs`). A `/merge-back`
has no PR behind it, so its push runs everything, and so does any doubt about the tree. What earns a
check here, and what one costs an unrelated PR, is in `.claude/rules/test-value.md`.

A contributor's PR from a fork goes through the same two columns with three differences, each spelled
out in the two skills. Main is merged in rather than rebased onto, so the contributor's history
stays. Every push is a bare `git push` to the fork, after checking that the contributor has not
pushed since, because `git push origin` would create a branch on this repository that the PR never
sees. The merge is a squash with an English subject and body, and the contributor's branch is not
deleted.

## The Code Review column

Upstream of both, the **Code Review** column runs `/code-review` as an isolated column agent in the
task's OWN worktree (`isolated` isolates the conversation, not the filesystem; see
[Isolated Sessions](../architecture/sessions/spawn-flow.md#isolated-sessions-per-column-session-model)). Entering the
column suspends the task agent's session and kills its PTY, so the two never overlap, but it leaves
that agent's UNCOMMITTED work in the shared tree, which is why the review pass commits by set math
over `git status` and never `git add -A`.

The pass fixes every finding it verifies (Lows included), applies its recommended option on a
decision and lists the alternative, adds tests, and commits that pass itself, so Testing can open on
a branch carrying a `*(review)` commit no local agent authored. That is expected, not corruption.

The pass ends with a verdict computed by `scripts/review-verdict.mjs`: **Ready** (move to Testing) or
**Blocked** (move back to Executing and do the named steps). A step only a person can do adds a
`Needs owner:` line below the verdict, which neither Code Review row matches, so the card stops
there on the first report with the `agent-stopped` mark, and the person answers in that session.
There is no "skipped" status, and the commit body carries a `Refuted:`/`Decisions:` ledger the next pass reads. A branch with nothing to
review ends Blocked too (`--no-changes`), since on the board it means Executing committed nothing.
Task 916's review ended on a bare "No changes to review." that neither Code Review row matched, and
the workflow moved the task on to Testing unreviewed. A finished pass normally
leaves the tree clean; a fix on an already-dirty path stays uncommitted by design, so a dirty tree
means the pass is either in flight or left those paths deliberately mixed.
