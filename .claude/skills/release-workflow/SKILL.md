---
name: release-workflow
description: From a Command Terminal, build and start the board workflow for a desktop release - the cards in flight, a release task that runs /release once they are in Done, and a kangentic.com task that syncs the site once the release is live
disable-model-invocation: true
allowed-tools: Read, Grep, Bash(git:*), AskUserQuestion, mcp__kangentic__kangentic_board_summary, mcp__kangentic__kangentic_list_tasks, mcp__kangentic__kangentic_find_task, mcp__kangentic__kangentic_list_workflows, mcp__kangentic__kangentic_save_workflow, mcp__kangentic__kangentic_get_workflow, mcp__kangentic__kangentic_start_workflow
argument-hint: [patch|minor|major|X.Y.Z] [#N ...]
---

# Release workflow

Queues a desktop release behind the work in flight and the kangentic.com sync behind the release, as one board workflow. The engine does the waiting, so no agent holds a watch and no card is started by hand.

**Arguments:** $ARGUMENTS

"Workflow" here always means a board workflow (`docs/user-guide/workflows.md`). `/release` and `docs/releases/deployment.md` also say "release workflow" for `release.yml`, which the release task's `/release` runs on its own.

## What it builds

A board workflow named `Release X.Y.Z`, made in this project, holding:

- **The cards it waits for**, taken in where they are with `existingTask`.
- **The release task** on this board, titled `Release X.Y.Z`. Route: Executing only, in the project folder (`useWorktree: false`). It runs `/release`, fixes what the run turns up instead of filing tasks (doc fixes in the release commit, release-process fixes through `/merge-back` after Step 8), and ends on `Findings: applied`. Executing's "On to Code Review" row reads that line, and since Code Review is off the route the move goes to the route's next column, Done.
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

**No cards named.** Call `kangentic_board_summary` and read its `Columns:` lines. For each column between To Do and Done that holds a task, call `kangentic_list_tasks` with that `column`. Those cards are the candidates. Listing the whole board would print every To Do card's description, and To Do often holds dozens; a To Do card can still be named. Read each candidate with `kangentic_find_task` for its `automations paused` flag and its branch.

Before asking, run Step 3 for main and for each candidate's branch, so the question can name the version. Then ask once:

- Name the predicted version and its reason in the question (`Release 0.64.0, minor: 4 feat commits on main since v0.63.0`). For a candidate whose branch would change it, say what waiting for it makes the version.
- With one candidate, use `AskUserQuestion` with two options, `Release now` and `Wait for #N`, since the tool needs at least two. The question names the card, its column and, for a paused card, `automations paused: joining lifts it`.
- With two to four, use `AskUserQuestion` with `multiSelect`, one option per card labeled `#N <title>`, and its description naming its column and, for a paused card, `automations paused: joining lifts it`.
- With more, ask in plain text: a numbered list of the same lines, then "Which should the release wait for? Reply with the numbers." Wait for the answer.
- Recommend every card without paused automations and none with them. With one candidate that means `Wait for #N`, or `Release now` when it is paused. A paused card is often one the owner is holding on purpose (#1040 sat in Executing, paused, waiting on an outside PR) and should not hold a release or be driven past its own gate.
- Say once, in the question, that each card picked joins the workflow where it is and is driven to Done by it.

With no candidates, ask nothing: the release task waits for nothing and starts at once.

A card already in another workflow cannot join. `kangentic_save_workflow` refuses it with a sentence naming it (`#1208 is already in a workflow.`). Relay that and ask whether to go on without it.

## Step 3 - The version

The title names a version, so predict it the way `/release` Step 0 will derive it, from what will be on main when the release task starts. With no cards named, Step 2 runs this before its question, for main and for each candidate's branch. Settle the version on the cards picked.

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

Fill the briefs from the two sections below: paste the text without the `> ` quote markers, and replace `X.Y.Z` and `<release command>`. Leave `<runId>`, `<version>` and `<this folder>` as written, because the release agent fills those in. Each brief is far under the 27,500-character limit.

## Step 5 - Check, then start

Call `kangentic_get_workflow` for `Release X.Y.Z` and check it against the plan:

- each card reads `In <its column> (#N, taken in at Start)`, on the board's default route. A card already past the plan column still lists that column's plan approval, and it never goes back there, so that line is no reason to stop;
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
> This card is in Executing, and Executing's turn-end rows read every turn end, even one that only waits on a background command or a subagent. A turn that ends before the release is verified gets a message asking you to apply findings and end on "Findings: applied", and that line moves this card to Done with the release unfinished. So end no turn until the last step. A background command or a subagent is fine while the turn stays open. Ending the turn to wait for one is not:
>
> - Never end a turn to wait for anything. Keep every tool call under the tool's 10-minute cap (timeout 600000).
> - Step 1's UI suite takes about 30 minutes, three times the cap. Run it as one PowerShell call with run_in_background, writing to a log instead of piping it. Put `Set-Location <this folder>;` in front of it and of the wait below, since the shell may start elsewhere:
>   `Remove-Item .kangentic/release-X.Y.Z-ui-suite.log -ErrorAction SilentlyContinue; npx playwright test --project=ui --reporter=line *> .kangentic/release-X.Y.Z-ui-suite.log; "exit $LASTEXITCODE" | Add-Content .kangentic/release-X.Y.Z-ui-suite.log`
>   Then wait in calls like this one, repeating until the log's last line starts with `exit`. The lines above it carry Playwright's summary:
>   `$deadline = (Get-Date).AddMinutes(9); do { Start-Sleep -Seconds 30; $last = Get-Content .kangentic/release-X.Y.Z-ui-suite.log -Tail 1 -ErrorAction SilentlyContinue } while ($last -notmatch '^exit ' -and (Get-Date) -lt $deadline); Get-Content .kangentic/release-X.Y.Z-ui-suite.log -Tail 30 -ErrorAction SilentlyContinue`
>   A pipe into Select-Object or any other stage keeps the log empty until the run ends, so the wait would see nothing. On a failure, read its `error-context.md` under `test-results/` before any re-run, as Step 1.2 says.
> - A call the tool moved to the background because it ran past the cap, and Step 1.5's doc-auditor subagents once you have nothing else to do, are waited on in PowerShell `Start-Sleep -Seconds 60` calls until their completion notice arrives, never with a turn end.
> - Wherever /release waits on pre-flight step 8's CI run, if it is still going, wait in PowerShell calls like this one instead of `gh run watch`, repeating until it prints `completed`:
>   `$deadline = (Get-Date).AddMinutes(9); do { $run = gh run view <runId> --repo Kangentic/kangentic --json status,conclusion | ConvertFrom-Json; if ($run.status -eq 'completed') { break }; Start-Sleep -Seconds 30 } while ((Get-Date) -lt $deadline); "$($run.status) $($run.conclusion)"`
> - In Step 7, wait for the three release.yml jobs the kangentic.com card's gate reads, not the whole run: `publish-release` (the published release), `publish-npm`, and `deploy-demo / deploy` (the live demo, which runs after the poster zip is attached). Repeat this call until it shows all three completed, or the run completed:
>   `$deadline = (Get-Date).AddMinutes(9); do { $view = gh run view <runId> --repo Kangentic/kangentic --json status,conclusion,jobs | ConvertFrom-Json; $done = @($view.jobs | Where-Object { ($_.name -in @('publish-release', 'publish-npm', 'deploy-demo / deploy')) -and ($_.status -eq 'completed') }); if ($view.status -eq 'completed' -or $done.Count -eq 3) { break }; Start-Sleep -Seconds 30 } while ((Get-Date) -lt $deadline); "run: $($view.status) $($view.conclusion)"; $view.jobs | Where-Object { $_.name -match '^(publish-release|publish-npm|deploy-demo|poster-gate)' } | ForEach-Object { "$($_.name): $($_.status) $($_.conclusion)" }`
>   When all three succeeded, verify the end state as Step 7 says. `poster-gate` runs on after them, and nothing the site reads waits for it. If it is still running, do not wait for it: say in the summary that it is still running on run <runId>. If it already finished red, read it as Step 7 says and put the scene, scale and OS its log names in the summary. If one of the three did not succeed, do what Step 7 says for it, run Step 8 only if the end-state check passed, and end on "Needs owner:" naming the job, never on "Findings: applied": the kangentic.com card would start on a release its gate cannot pass.
> - If a message asks you to apply findings anyway, the release is not done. Carry on from where you were.
>
> Wherever /release says to stop, to report and stop, or to go on only on the owner's word, end the turn with a last line that starts "Needs owner:" and says what you need. Kangentic sends the owner a notice with it.
>
> Once Step 2 has read the new version back, if it is not X.Y.Z, rename this card to "Release <version>". Then find this workflow's kangentic.com task with kangentic_get_workflow (workflow "Release X.Y.Z"), and with kangentic_update_task (project "kangentic.com") rename it the same way and change `/sync-release X.Y.Z` in its description to the new version with descriptionEdits. That card starts the moment this one reaches Done, so do this before the end. The workflow keeps its name.
>
> Fix what the run turns up in this card, as /code-review does. Never file a board task for it, and never delete or move a task already filed.
>
> - Apply everything Step 1.5 found, its prose observations included (its point 2 says how). Those doc fixes ride the release commit.
> - Keep a list, as you go, of whatever would make the next release run smoother: a line of /release or of /release-workflow (`.claude/skills/release-workflow/SKILL.md`, which holds this brief) that the run proved wrong, such as a stale number, a command that failed as written or a wait that did not hold the turn; a step you had to work around; a fault in a script the release runs. Write none of it before Step 8, so the release commit carries only the release. After Step 8, make those edits. Run, scoped, each tests/unit file that reads a file you changed (Grep tests/unit for its path, and for a skill also for `'skills', '<name>'`), plus `tests/unit/writing-style-characters.test.ts`. Then land them on main with `/merge-back`. The owner accepts release-process fixes unreviewed. If `/merge-back` stops short, say where in the summary and leave the edits in place.
> - What this card cannot fix goes in the summary with its evidence. That covers a Step 1 failure you recorded as environmental, a red nightly the pre-flight reported, a marker Step 8 reported as predating its fix (Step 8 never rewrites one), a poster-gate still running or red, and any fix to product code or a test, which needs a PR this card does not make.
>
> End with a short summary (version, tag, the end-state check, Step 8's line, what the run fixed and the commit `/merge-back` landed, and what it left with the reason) and, as the last line, exactly:
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
- **The UI suite runs in the background on purpose.** Claude Code moves a call that passes its 10-minute cap to the background instead of ending it. v0.64.0 ran the suite in thirds, and two of them (10.0 and 11.5 minutes) were moved; the turn held only because each finished while the agent had other work. A fixed split goes stale as the suite grows, so the brief starts the suite in the background with a sentinel line and holds the turn with bounded polls of its log.
- **Step 7 stops at the jobs the site reads.** kangentic.com's `scripts/release-gate.mjs` reads the published release, its poster zip, npm and the deployed demo's `scenes.json`, never the run. `poster-gate` runs after all of them, nothing waits for it, and `/release` only reports it. In v0.64.0 it finished 8 minutes after `deploy-demo`. `tests/unit/release-workflow-gates.test.ts` fails when a job this brief waits for leaves release.yml or something starts waiting for `poster-gate`.
- **Executing only.** A release has nothing to review, test or merge after it: `/release` pushes the release commit and tag to main itself. Ending the route at Executing turns the column's own forward line into Done, with no column or automation change.
- **The project folder.** `/release` operates on the main checkout wherever it runs. A worktree only adds the trap its "Where this runs" section describes.
- **Fixes ship in the release card.** As in `/code-review`, a finding ships in the card that found it. v0.65.0's card filed task 1232 with four one-line doc fixes the release commit could have carried, and a filed task waits until someone picks it up. Doc fixes ride the release commit. A fix to the release process itself (a wrong line in `/release` or this brief, a release script) waits until after Step 8, so the release commit stays the release, and then lands through `/merge-back`. The owner accepts those unreviewed. That way each release leaves the next one a process that matches what actually happened. A product or test fix needs a PR, so the card reports it.
- **`Release X.Y.Z` on both boards.** The site card's title matches the earlier kangentic.com release cards, and its brief stays the one line `/sync-release` was written to take.
