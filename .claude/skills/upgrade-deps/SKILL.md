---
name: upgrade-deps
description: Research every npm dependency with a newer eligible release, reading each changelog and migration guide and what the release lets us remove or adopt, and file the upgrade as the fewest board tasks that are safe. Reuses earlier research when nothing moved or a known blocker still stands. Use for "update our packages", "upgrade dependencies", or "what can we upgrade". It files tasks and changes no code. The task agent does the upgrade by following apply.md.
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(node:*), Bash(npm:*), Bash(git:*), Bash(gh:*), Agent
argument-hint: [--dry-run] [--refresh] [package or group ...]
---

# Upgrade deps

Find every npm dependency that can move, research what each move means for this repo, and put the
work on the board. This skill stops at the task. It edits no code, installs nothing and pushes
nothing.

Run it as often as you like. Timing never matters: every run checks the newest releases, and work
already done is skipped. A run with nothing new costs one inventory and no agents.

**Usage:** `/upgrade-deps [--dry-run] [--refresh] [package or group ...]`

- `--dry-run` researches and prints the planned tasks but files nothing. Research is still cached.
- `--refresh` ignores the cache and researches every group again.
- Naming packages or groups limits the run to those groups.

**Arguments:** $ARGUMENTS

Run it from the main checkout on an up-to-date `main`, in an Opus session, because this session
decides what is too big to share a task. It reads the tree it is in, so a worktree behind `main`
reports versions that already moved, and its agents write to the main checkout's cache.

## What it covers, and what never moves

The root `package.json` and both workspace packages (`packages/launcher`, `packages/protocol`).
Packages nothing declares move in a lockfile refresh, the last phase of every task. GitHub Actions
stay with Dependabot. Everything else is up for a full upgrade, majors and exact pins included,
unless one of these stops it:

- **A downgrade.** `npm outdated` lists `node-pty` and every `@xterm` package because their `latest`
  sits behind the beta we run. Those betas carry fixes (`tests/unit/node-pty-version-pin.test.ts`).
  They move along their own channel. The inventory enforces this, so never pick a version by hand
  from `npm outdated`.
- **A peer range nothing satisfies.** It goes on the record as blocked, with what would clear it.
- **A pin whose reason still holds** and which the target would break. An exact pin moves only to
  another exact pin.

## Step 1: Inventory

```
node scripts/upgrade-deps.mjs inventory
```

Pass `--refresh` through if given. It reads the registry on every run, so a release from an hour ago
shows up. Only research is cached. A field that is absent means no. Read:

- `groups`: what can move. Each lockstep group carries its `members` (`installed`, `target`,
  `published`, `pinned`, `runtime`, `kind`), its `peerConflicts`, a `research` state, `hasBrief`, and
  any `task`. `targetsDisagree` means the members' newest releases do not match, so the researcher
  picks a matching set. `signals` means a member's target changed what the 2026 npm attacks changed:
  a new dependency, install script or `binding.gyp`, lost provenance, or a new publisher. A `kind` of
  `deprecated` means there is no upgrade, and the work is to replace or remove the package.
- `cacheDir`: where briefs live. It is the same folder from any worktree.
- `errors`: packages the registry would not answer. Report them. A package missing from the run
  is not up to date.

## Step 2: Work out what needs research

If the arguments named packages or groups, work only on those from here on, and leave the rest out
of the report. The `research` state says how much of the earlier work still stands:

| State | Meaning | Action |
|---|---|---|
| `reuse` | Same versions | Read the brief. No agent. |
| `blocked` | Same versions, and what the blocker waits on has not moved | Report it. No agent. |
| `filed` | A board task carries this brief | Confirm the task in Step 3. No agent. |
| `recheck` | Blocked, and what it waited on moved | One agent tests the blocker alone. |
| `delta` | A brief exists for older versions | One agent covers only the new releases. |
| `research` | No usable brief | The full pass. |

Research never expires. Only a version moving, or `--refresh`, sends a group back to an agent, so do
not research a `reuse` group again because you are unsure, or because the brief is old. Read it.

## Step 3: Check the board

Search active tasks for earlier upgrade work:

```
kangentic_search_tasks query: "Upgrade deps", status: "active"
```

Note which upgrade task, if any, is waiting in To Do, and which is in progress. Step 5 uses both, so
that running this often never piles up tasks.

For every group with a `task`, whatever its `research` state, find that task with
`kangentic_find_task` and `task.displayId`. A new release moves a filed group to `delta`, and it still
belongs to that task:

- **Still in To Do:** research it as its state says, then update that task in Step 6 rather than
  filing another.
- **Further along:** skip its research, leave the group alone, and name the task in the report. A
  release that lands mid-task waits for the next run.
- **Done or deleted, and the group still shows as movable:** the work did not land. Set the brief's
  `task` to `null`. Treat a `filed` group as `reuse`, and research a `delta` group as usual.

## Step 4: Research

Spawn `upgrade-researcher` agents in parallel, in one message:

- **Critical groups get one agent each on Opus,** with `model: "opus"`: `electron`, `node-pty`,
  `xterm`, and any `runtime` group of kind `major`. A miss here can ship a crash.
- **Other risky groups get one agent each on the agent's default, Sonnet at high effort:** any group
  whose `kind` is `major` or `deprecated`, or that is `pinned` or `runtime`, or has `signals`,
  `peerConflicts`, an `advisory` or an `inheritedAdvisory`. `electron-builder` always gets its own
  agent too.
- **Everything else goes in batches of up to six groups on Haiku,** with `model: "haiku"` and
  `effort: "medium"`. A patch to a dev tool needs its release notes read, not an investigation.

When the batches finish, read their briefs and **escalate**. Haiku is trusted for groups that turned
out simple, not for judging hard ones. Send a group to one agent on the default, with state `research`
and its brief as the prior brief, if the brief has any of these:

- `risk` above `low`, or `verdict: blocked`
- a change that needs a source edit, or that moves a package we ship. A range in `package.json` or a
  lockfile line for a dev tool is not one, even when the brief marks it as affecting us
- a value in `installTargets`, which means it wants something other than the newest release
- anything in `adopt` or `workaroundsToRemove`
- an unverified claim about how the repo uses the package
- a claim about an advisory that `npm audit` does not back

Each prompt carries, per group: the name, every member's `installed`, `target`, `published`, `pinned`,
`runtime`, `signals` and `deprecated`, the `peerConflicts`, any `advisory` or `inheritedAdvisory`, the
`research` state, and the absolute path `<cacheDir>/briefs/<group>.json`. Say whether a prior brief
exists at that path.
For Electron, add: check `node` in `releases.electronjs.org/releases.json` for the Node the target
bundles, and whether the fuses changed.

The agents write their briefs to disk as they finish, so a stopped run keeps its work. Run the
inventory again to pick up where it stopped. Do not research anything yourself in the main loop.

## Step 5: Plan the tasks

Read every brief with `verdict: ready`. Use the fewest tasks that are safe. **Default to one.**
Two upgrade tasks running at once conflict in `package-lock.json`, so a split costs a rebase as well
as a PR. Groups become phases inside the task, each with its own commit.

**Keep one rolling task.** This skill runs as often as you like, so a run must not file a task each
time:

- If an upgrade task is waiting in To Do, add the new groups to it as phases.
- If an upgrade task is in progress and none is waiting, file one follow-up that starts
  `Start after #<N> merges.` Later runs add to that follow-up.
- If neither exists, file a task.

Split a group into its own task only when one of these is true, and write the reason down:

- It needs a gate the rest do not, and a failure there would hold them: Electron's restart cycle,
  or a native runtime major that needs `npm run package` and a load check.
- Its migration is large enough to swamp the review of everything else: a major with changes across
  many files, or `risk: high`.
- It is so uncertain that the safe bumps should land first.

Split tasks run **in sequence**. Order them safest first, and start each later description with
`Start after #<N> merges.` Three tasks is a lot. More than four means you are splitting by package
instead of by risk. Only the last task in a sequence carries the lockfile refresh.

A blocked group gets no task. It goes in the task's "Not in this task" section and in the report, so
nobody wonders where it went.

**User-visible work gets its own task, never a phase.** Any `adopt` item with `userVisible: true` from
a `ready` brief goes in one separate `Upgrade deps: user-visible features` task, created with
`automationsDisabled: true`. It starts from a mockup a person reviews, and the Executing column's Apply
findings row tells an agent to take its recommended option and carry on, so inside an upgrade task it
would get built unreviewed. `Needs owner:` does not stop that row. Pausing automations does, and it
leaves plan approval with the user. Skip this task if there are no such items, and add to it on later
runs while it waits in To Do.

## Step 6: File the tasks

With `--dry-run`, print the planned titles and descriptions and stop here.

Otherwise create each task in To Do with `kangentic_create_task`, with `profile: "Upgrade"` and no
`column`. Title it `Upgrade deps: <what moves>`, and attach the brief of every group in it, as
`attachments: [{ filePath: "<cacheDir>/briefs/<group>.json" }, ...]`. Then set the label `dependencies`
in a separate labels-only `kangentic_update_task` call, because labels on a long create can drop.

To change an open task from Step 3, use `kangentic_update_task` with `descriptionEdits`, and pass the
new or changed briefs in `attachments`, which adds to what is there. Remove a superseded copy with
`kangentic_remove_task_attachment`.

Attach the briefs rather than copy them into the description, because the attachment paths reach the
agent's opening prompt anyway. Keep the description to the plan a person reads on the card, and under
25,000 characters. The field allows 50,000, but on Windows the opening prompt travels on the command
line, which fails between 32,000 and 32,800 characters.

The `Upgrade` Board Profile puts the Testing column on Opus, because `/pull-request` fixes code there
when CI fails and an upgrade's fixes are app changes. If the board has no such profile, file without
one and say so in the report.

**Set no `autoCommand`, `modelOverride`, `effortOverride`, `agentOverride` or `permissionMode`.** The
columns decide how a task runs: code changes go through Planning, Executing and Code Review on Opus at
high effort. A pin lasts the task's whole life, so it would bypass that and lock the permission mode
too, and `autoCommand` replaces the commands the board runs as the task moves.

Each description stands alone, because the task agent shares no context with this run:

```markdown
Follow `.claude/skills/upgrade-deps/apply.md`. Install exactly the versions below. Each group's full
research is attached as `<group>.json`: read it before you start that phase.

## Phases

### 1. <group>: <installed> to <target>  (risk: low)
<the brief's summary>
Must change: <the source edits in a line, or "nothing">

### 2. ...

### Last: lockfile refresh

## Not in this task
Blocked: <group, reason, what clears it>
User-visible: <item, and the task that holds it>
```

Paraphrase, and never write a contributor's path, because the board is mirrored publicly.

After each task exists, record it on its briefs, so the next run knows it is handled. In each
brief, set `"task": { "displayId": <number>, "filedAt": "<UTC ISO timestamp>" }`.

## Step 7: Report

End with what the user needs to act on, short:

- The tasks filed or updated, with their numbers and how many groups each holds.
- Blocked groups, each with its reason and what clears it.
- What the run reused, as a count: "11 groups from the cache, 4 researched".
- Any registry errors, and anything an agent could not verify.

If everything is current, blocked or already filed, say that in one line and file nothing.

## Rules

- This skill never edits source, runs an install, commits or pushes.
- Never start a filed task, and never move it. The user drags it when they want it.
- Every version in a task comes from a brief, and every brief's versions come from the inventory.
- One command per Bash call.
