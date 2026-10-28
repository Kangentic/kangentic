---
type: Guide
title: Board test gate
description: How the Code Review, Testing and Merge columns gate a change on this repo's own board, what each column's skill runs, why a review pass commits in the task's own worktree, and the Ready or Blocked verdict and ledger it leaves.
tags: [contributing, testing, code-review, ci, board]
sources:
  - resource: .claude/skills/code-review/SKILL.md
  - resource: .claude/skills/pull-request/SKILL.md
  - resource: .claude/skills/merge-pull-request/SKILL.md
  - resource: scripts/review-verdict.mjs
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
**Blocked** (move back to Executing and do the named steps). There is no "skipped" status, and the
commit body carries a `Refuted:`/`Decisions:` ledger the next pass reads. A branch with nothing to
review ends Blocked too (`--no-changes`), since on the board it means Executing committed nothing.
Task 916's review ended on a bare "No changes to review." that neither Code Review row matched, and
the workflow moved the task on to Testing unreviewed. A finished pass normally
leaves the tree clean; a fix on an already-dirty path stays uncommitted by design, so a dirty tree
means the pass is either in flight or left those paths deliberately mixed.
