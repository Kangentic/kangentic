---
name: release-workflow
description: From a Command Terminal, build and start the board workflow for a desktop release - the cards in flight, a release task that runs /release once they are in Done, and a kangentic.com task that syncs the site once the release is live
disable-model-invocation: true
allowed-tools: Read, Grep, Bash(git:*), AskUserQuestion, mcp__kangentic__kangentic_list_tasks, mcp__kangentic__kangentic_find_task, mcp__kangentic__kangentic_list_workflows, mcp__kangentic__kangentic_save_workflow, mcp__kangentic__kangentic_get_workflow, mcp__kangentic__kangentic_start_workflow
argument-hint: [patch|minor|major|X.Y.Z] [#N ...]
---

# Release workflow

Queues a desktop release behind the work in flight and the kangentic.com sync behind the release, as one board workflow. The engine does the waiting, so no agent holds a watch and no card is started by hand.

**Arguments:** $ARGUMENTS

"Workflow" here always means a board workflow (`docs/user-guide/workflows.md`). `/release` and `docs/releases/deployment.md` also say "release workflow" for `release.yml`, which the release task's `/release` runs on its own.

## What it builds

A board workflow named `Release X.Y.Z`, made in this project, holding:

- **The cards it waits for**, taken in where they are with `existingTask`.
- **The release task** on this board, titled `Release X.Y.Z`. Route: Executing only, in the project folder (`useWorktree: false`). It runs `/release`, files follow-ups in To Do, and ends on `Findings: applied`. Executing's "On to Code Review" row reads that line, and since Code Review is off the route the move goes to the route's next column, Done.
- **The site task** on kangentic.com, titled `Release X.Y.Z`. Route: Executing through Deploy, skipping Design and Planning. It runs that repo's `/sync-release X.Y.Z`, which gates on the release being live, then Code Review, Merge and Deploy take it to Done.

Every card blocks the release task, and the release task blocks the site task. The release card reaches Done only after `/release` Step 7 has checked the published release, so the site task never starts on a release that is still building.

**Joining changes a card.** A card taken in becomes a full workflow task (#1211): it is locked while it moves (only the workflow, its column automations and its own agent move it), its automations pause is lifted, the step check drives it along its route to Done, the workflow's Pause pauses it, and it cannot pause its automations or go to the Backlog until someone removes it from the workflow (`kangentic_remove_from_workflow`). A card in Done, archived, or already in another workflow cannot join. A card in To Do can, and the workflow then starts it.

## Where this runs

A Command Terminal at the project root, on whatever branch is checked out. It reads git and the board and writes nothing in the repository. Do not fork it: Step 2 may ask the owner one question.

## Step 0 - Arguments

Split `$ARGUMENTS` on spaces.

- **A bump:** `patch`, `minor`, `major`, or a version written `X.Y.Z` or `vX.Y.Z`. At most one.
- **Cards:** `#N` or `N`, any number, on this board.

Anything else, or two bumps, stops with: `Usage: /release-workflow [patch|minor|major|X.Y.Z] [#N ...]`.

## Step 1 - One release at a time

Call `kangentic_list_workflows`. If an unfinished workflow (not started, running or paused) has a title that starts with `Release `, stop and name it. Two would race for the same tag.

## Step 2 - The cards it waits for

**Cards named.** Read each with `kangentic_find_task` (`displayId`). Stop on a number with no card, or a card in Done. These are the cards, with no question, except: if any of them shows `automations paused`, ask once (Step 2's one question) whether to take it in anyway, saying that joining lifts its pause and the workflow will drive it to Done.

**No cards named.** Call `kangentic_list_tasks`. The candidates are the cards in every column but To Do (it lists no Done cards). Read each with `kangentic_find_task` for its `automations paused` flag and its branch. Then ask once:

- With four or fewer, use `AskUserQuestion` with `multiSelect`, one option per card labeled `#N <title>` with its column, and its description naming its column and, for a paused card, `automations paused: joining lifts it`.
- With more, ask in plain text: a numbered list of the same lines, then "Which should the release wait for? Reply with the numbers." Wait for the answer.
- Recommend every card without paused automations and none with them. A paused card is often one the owner is holding on purpose (#1040 sat in Executing, paused, waiting on an outside PR) and should not hold a release or be driven past its own gate.
- Say once, in the question, that each card picked joins the workflow where it is and is driven to Done by it.

With no candidates, ask nothing: the release task waits for nothing and starts at once.

A card already in another workflow cannot join. `kangentic_save_workflow` refuses it with a sentence naming it (`#1208 is already in a workflow.`). Relay that and ask whether to go on without it.

## Step 3 - The version

The title names a version, so predict it the way `/release` Step 0 will derive it, from what will be on main when the release task starts.

1. `git fetch origin main`
2. `git describe --tags --abbrev=0 --match "v*" origin/main` gives the previous tag, `vP` below. The `--match "v*"` is load-bearing: `/release` Step 0 says why (a `protocol-v*` tag is often the nearest).
3. `git log vP..origin/main --format=%s --no-decorate` lists what main already holds.
4. For each card with a branch (the `branch:` in its `find_task` line), `git log origin/main..<branch> --format=%s --no-decorate` lists what it will add. Rebase merges keep these subjects. A card with no branch yet adds nothing you can read, so say so in the report.
5. Apply `/release` Step 0's rule (`.claude/skills/release/SKILL.md`, Step 0 point 3) to all of them: a `!` after the type or `BREAKING CHANGE` is major, any `feat` is minor, anything else is patch.

Then settle it:

- **The owner named a bump:** it wins. A version `X.Y.Z` must be exactly one step from `vP` (its next patch, minor or major). Map it to that keyword. Anything else stops with `X.Y.Z is not one step from vP.`
- **The owner named nothing and the subjects say major:** stop and name the commits. `/release` stops there too. The owner runs this again with `major` or a smaller bump.
- **Otherwise** the derived bump stands, and the release task runs bare `/release`, so its Step 0 derives the bump again from what actually landed. The title is a prediction, and the release brief renames the cards if it was wrong.

`X.Y.Z` below is `vP` with that bump applied. The release command is `/release <keyword>` when the owner named a bump, and `/release` when not.

## Step 4 - Save the plan

Call `kangentic_save_workflow` with no `workflow`:

- `title`: `Release X.Y.Z`
- `brief`: `/release-workflow ` followed by `$ARGUMENTS`
- `tasks`:
  - Each card: `{ key: "card-<N>", title: "<its title>", existingTask: "<N>" }`. Nothing else. A taken-in card keeps its own settings, so run settings are refused, and its route has to include the column it is in, which the default route does.
  - The release task: `{ key: "release", title: "Release X.Y.Z", description: <the release brief below>, routeStart: "Executing", routeLast: "Executing", useWorktree: false }`.
  - The site task: `{ key: "site", project: "kangentic.com", title: "Release X.Y.Z", description: <the site brief below>, routeStart: "Executing" }`. Leave `routeLast` out so the route runs through Deploy.
- `links`: `{ blocker: "card-<N>", blocked: "release" }` for each card, and `{ blocker: "release", blocked: "site" }`.

Fill the briefs from the two sections below: paste the text without the `> ` quote markers, and replace `X.Y.Z` and `<release command>`. Leave `<runId>` and `<version>` as written, because the release agent fills those in. Each brief is far under the 27,500-character limit.

## Step 5 - Check, then start

Call `kangentic_get_workflow` for `Release X.Y.Z` and check it against the plan:

- each card reads `In <its column> (#N, taken in at Start)`;
- the release task's route is Executing alone, and the site task is on `kangentic.com` with a route from Executing to Deploy;
- the links are the ones above;
- no task's plan waits for the owner (neither new task's route has a plan column).

Fix anything that differs and save again, passing the `revision` it reported. Then call `kangentic_start_workflow`. The owner typing this command is the request to start it.

Start checks every card again. If one has moved to Done since the save, or left To Do while planned to wait, its refusal says so. Drop that card, save again with the new revision, and start.

## Step 6 - Report

Keep it short:

- the workflow's name, and the version: the owner's, or the prediction with its reason (`minor: 2 feat commits on main, 1 on #1208's branch, since v0.63.0`), and any card whose branch could not be read;
- the cards it waits for, each with its column, and one line on what joining changed for them;
- the two new tasks by number, from `kangentic_get_workflow` after the start (the site task as `kangentic.com #N`);
- what comes next: the release task starts when the last card reaches Done, any stop arrives as a `Needs owner:` notice, and the Workflows view shows where it is.

## The release brief

The release task's description, filled in:

> Release the desktop app as vX.Y.Z. This card is the release task of the board workflow "Release X.Y.Z". It starts once every card the workflow waits for is in Done, so their work is on main.
>
> Run `<release command>` in this folder, the main checkout, and carry it through Step 8. Its Step 0 settles the version. This card's title is a prediction.
>
> This card is in Executing, and Executing's turn-end rows read every turn end, even one that only waits on a background command or a subagent. A turn that ends before the release is verified gets a message asking you to apply findings and end on "Findings: applied", and that line moves this card to Done with the release unfinished. So end no turn until the last step:
>
> - Run every command in the foreground. Never use run_in_background, and never end a turn to wait for anything.
> - Keep each call under the tool's 10-minute cap (timeout 600000). Run Step 1's UI suite in thirds: `npx playwright test --project=ui --shard=1/3`, then `--shard=2/3` and `--shard=3/3`. Each run clears `test-results/`, so read a failed third's `error-context.md` before you start the next.
> - Wherever /release waits on a GitHub Actions run (pre-flight step 8's CI run if it is still going, Step 7's release.yml run), wait in PowerShell calls like this one instead of `gh run watch`, repeating until it prints `completed`:
>   `$deadline = (Get-Date).AddMinutes(9); do { $run = gh run view <runId> --repo Kangentic/kangentic --json status,conclusion | ConvertFrom-Json; if ($run.status -eq 'completed') { break }; Start-Sleep -Seconds 30 } while ((Get-Date) -lt $deadline); "$($run.status) $($run.conclusion)"`
> - Step 1.5's doc-auditor subagents report back while you keep working. If they are still running when you have nothing else to do, wait in PowerShell `Start-Sleep -Seconds 60` calls, not with a turn end.
> - If a message asks you to apply findings anyway, the release is not done. Carry on from where you were.
>
> Wherever /release says to stop, to report and stop, or to go on only on the owner's word, end the turn with a last line that starts "Needs owner:" and says what you need. Kangentic sends the owner a notice with it.
>
> Once Step 2 has read the new version back, if it is not X.Y.Z, rename this card to "Release <version>". Then find this workflow's kangentic.com task with kangentic_get_workflow (workflow "Release X.Y.Z"), and with kangentic_update_task (project "kangentic.com") rename it the same way and change `/sync-release X.Y.Z` in its description to the new version with descriptionEdits. That card starts the moment this one reaches Done, so do this before the end. The workflow keeps its name.
>
> After Step 8, file each follow-up the release turned up as a To Do task on this board with kangentic_create_task: a Step 1 failure you recorded as environmental, a prose gap Step 1.5 left, a red nightly the pre-flight reported, a Sentry marker that predates its fix, a red poster-gate. The release is tagged and pushed, so nothing more ships in this card. Skip anything already filed as a task.
>
> End with a short summary (version, tag, the end-state check, Step 8's line, the follow-ups by number) and, as the last line, exactly:
>
> `Findings: applied`
>
> This card's route ends at Executing, so that line moves it to Done, and the kangentic.com card starts.

## The site brief

The site task's description, filled in:

> Sync kangentic.com for the desktop release vX.Y.Z. This card is the kangentic.com task of the board workflow "Release X.Y.Z" on the kangentic board. It starts once the desktop release card reaches Done, which that card does only after /release has verified the published release.
>
> Run `/sync-release X.Y.Z` and follow it to its outcome line.

## Why it is built this way

- **No early turn end.** For a running workflow's task, a turn that ends while background work is still open runs the column's Text-match rows at once (`src/main/automations/turn-end/turn-end-runner.ts`, "A running workflow's turn is judged at its Stop"). Executing's "Apply findings" row matches any line but `Needs owner:` and has no Frequency limit, and a workflow task cannot pause its automations. So the brief keeps the whole release in one turn instead.
- **Executing only.** A release has nothing to review, test or merge after it: `/release` pushes the release commit and tag to main itself. Ending the route at Executing turns the column's own forward line into Done, with no column or automation change.
- **The project folder.** `/release` operates on the main checkout wherever it runs. A worktree only adds the trap its "Where this runs" section describes.
- **Follow-ups in To Do.** Elsewhere findings ship in the task that found them. A release cannot take more commits once its tag is pushed, so here they become tasks.
- **`Release X.Y.Z` on both boards.** The site card's title matches the earlier kangentic.com release cards, and its brief stays the one line `/sync-release` was written to take.
