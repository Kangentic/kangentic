---
type: Reference
title: Git actions
description: The state behind the Changes button's badge and the Changes panel's line (what counts as not pushed, where a push goes), Commit, Push and Create pull request run by Kangentic, which failures go to the agent and which to a toast, and how the Automation agent drafts a message.
tags: [git, worktrees, commit, push, pull-requests]
sources:
  - resource: src/shared/git-work-state.ts
  - resource: src/main/git/work-state.ts
  - resource: src/main/git-actions/
  - resource: src/main/ipc/handlers/git-actions.ts
  - resource: src/main/shared/temp-text-file.ts
  - resource: src/renderer/hooks/useGitWorkState.ts
  - resource: src/renderer/components/IconBadge.tsx
  - resource: src/renderer/components/dialogs/git/
  - resource: src/renderer/components/dialogs/task-detail/changes/ChangesNextStep.tsx
---
# Git actions

A task window and a Command Terminal show what their checkout needs next, and can do it: commit,
push, create a pull request. Kangentic runs git itself. An agent is involved only to draft a message
and to fix a step that failed.

## Work state

`readGitWorkDetail` (`src/main/git/work-state.ts`) reads one checkout: `git status --porcelain=v2
--branch`, two counts and the remotes. It never fetches. `src/shared/git-work-state.ts` turns the
state into decisions, so the badge, the tooltip, the line and the menus cannot disagree:
`gitWorkBadge` (a PR problem, then uncommitted files, then commits not pushed), `gitNextStep`
(commit, publish, push, create a pull request, or nothing) and `availableGitActions`.

**Not pushed is commits on no remote-tracking branch** (`rev-list --count HEAD --not --remotes`), not
`@{upstream}..HEAD`. A task branch is cut from `origin/<base>` and tracks it, and an agent often
pushes it under another name (`git push origin HEAD:<branch>`), so the upstream count would never
clear after a push. A merged PR reads as pushed, since a squash or a rebase merge with a deleted
branch leaves its commits on no remote.

**The base** is `taskGitBase`: the base the user chose, else the branch the worktree was cut from
(`resolved_base_branch`), else the project's default. Main and every surface that shows the state
ask it.

**A push goes to** the branch's upstream when that is neither the base nor the branch the worktree
was cut from, else the remote branch of `pushed_branch`, else the remote branch of its own name. With
none of them, the push is the first and the action reads Publish branch.

`useGitWorkState` shares one read per folder between every window that shows it, with at least 3
seconds between reads. It reads again when the diff watcher fires for that folder, when the agent's
turn ends, when the window gains focus, and at once after its own actions, whose read drops the
answer of one already running. A window that is hidden,
minimized or retained subscribes to nothing. A project on a host arms no watch, since a host's is a
2 second poll.

## Actions

The four channels (`git:commit`, `git:push`, `git:createPullRequest`, `git:draftText`) take a
`GitActionTarget`: a task id or a Command Terminal's slot. Main resolves the folder, so the renderer
never sends a path. `assertTargetReady` refuses a task that is done or not started, a detached HEAD, a
worktree on another branch than its task's, and a folder where any agent is mid-turn, by
`isTurnSettled` with held work accepted.

- **Commit** takes what is staged, or every change when nothing is. Hooks always run. When Kangentic
  staged everything and the commit failed, it unstages it again, so the next Commit takes what the
  agent fixes rather than the versions the hook refused. It uses `restore --staged`, which keeps a
  merge in progress, and `rm --cached` only before the first commit. Commit is refused while files have conflicts, because `git add -A` would mark
  them resolved.
- **Push** names both sides (`HEAD:refs/heads/<branch>`), so `push.default` cannot change where it
  lands. It never forces. `-u` is passed only on the first push, which moves the branch's upstream from
  `origin/<base>` to its own.
- **Create pull request** pushes when needed, links an open pull request of the branch rather than
  making a second, and otherwise calls the [PR connector](../../integrations/pull-requests/connector-model.md).
  After a failed create it looks once more, since a create that timed out may have landed. A branch
  that pushes to another remote than the primary one is offered none, because that is where the
  connector creates it.

No task lock and no project git lock is held across a step: a hook can run for minutes, and both
would hold every move and worktree meanwhile. `withDirectoryAction` allows one action per folder, and
git's own index lock covers the rest. The task row is written under its task lock, after.

A run gets 10 minutes and `GIT_TERMINAL_PROMPT=0`, since stdin is closed. A credential helper's own
sign-in dialog can still appear, because the run follows a click. `LANGUAGE=en` keeps git's own
messages in the words the classifier reads, and leaves a hook the user's locale and encoding.

A dialog stays open on the checkout it was opened on. A push that changes what is read, or a window
that is parked under it, does not close it or lose what the user wrote.

## Failures

`classifyGitRun` (`src/main/git-actions/failure.ts`) decides who a failure is for.

| For | What | Where it goes |
|-----|------|---------------|
| The agent | A hook that refused, a rejected push, a pull request the platform refused | A message to the task's running agent, a held message for its next one, or the Command Terminal's own agent |
| The user | No network, not signed in, a timeout, no name or email set, another git process holding the index, no remote, a missing `gh` or `az`, nothing to commit | An error toast. The dialog stays open with what was written |

A commit that failed is the agent's unless git could not run, since a commit never reaches the
network and a hook's output can say anything. The message to the agent names the step, carries the
user's commit message or the pull request's title and body (a title cut at 1,000 characters, the rest at 12,000), and ends
with the tail of git's output, cut to what a held message may be. It asks the agent to fix the cause and finish the step with the
same words, never skipping hooks and never force pushing. A paste that did not reach the agent goes
on hold.

## Drafts

`draftGitText` writes a commit message or a pull request description on the
[Automation agent](../automations/automation-agent.md), through the same headless answer path as a
Condition. The agent runs with no tools in the shared answer home, so the diff travels in the
prompt, which is at most 40,000 characters, with the task's title and description, ten recent commit
subjects for style, and the start of up to ten new files. Only a regular file is quoted: a link can
point outside the checkout. A draft is kept per folder and prompt, so
reopening a dialog spends nothing. The sparkle asks again. Each call is recorded as the `git_draft`
background job. With no Automation agent the sparkle is not drawn, and a commit message starts as
the task's title.
