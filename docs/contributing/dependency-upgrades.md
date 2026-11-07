---
type: Guide
title: Dependency upgrades
description: How /upgrade-deps finds what can move, researches it, skips research already done so it can run as often as you like, and keeps one rolling board task, why following npm's latest would downgrade a crash fix, how the supply chain signals work, why green tests do not finish a migration, and what a run costs.
tags: [contributing, dependencies, npm, skills, board]
sources:
  - resource: .claude/skills/upgrade-deps/SKILL.md
  - resource: .claude/skills/upgrade-deps/apply.md
  - resource: .claude/agents/upgrade-researcher.md
  - resource: scripts/upgrade-deps.mjs
  - resource: scripts/upgrade-researcher-guard.js
---
# Dependency upgrades

`/upgrade-deps` researches every npm dependency with a newer eligible release and files the work on
the board. It changes no code. The task agent does the upgrade by following
`.claude/skills/upgrade-deps/apply.md`, and the task then runs through Code Review, Testing and Merge
like any other ([board test gate](board-test-gate.md)). Dependabot covers GitHub Actions only, so this
is the path for npm.

To stay with a task yourself, pause its automations and drag it straight to Executing. The agent still
starts with the description and briefs, and the card stays there, so no Apply findings message arrives
and nothing moves it to review. Nothing reaches Code Review, Testing or Merge until you resume
automations and move the card.

Run it as often as you like. Packages ship daily, so nothing here depends on the date: every run
targets the newest release, and research already done is skipped. `--dry-run` prints the planned task
and files nothing.

## Who does what

| Piece | Job |
|---|---|
| `scripts/upgrade-deps.mjs` | Reads the manifests, the lockfile, the registry and `npm audit`. Decides by version number what can move, and whether earlier research still answers it. |
| `upgrade-researcher` agent | Reads the release notes for every version crossed, checks how the repo uses the package, finds what can be removed or adopted, and writes a brief. |
| `/upgrade-deps` skill | Drives the run: spawns the researchers, plans the tasks, files them, and records them on the briefs. |
| `apply.md` | What the task agent follows to install, migrate, adopt, verify and commit. |

## Why a script decides what can move

`npm outdated` lists `node-pty` and all five `@xterm` packages as behind, because npm's `latest` for
them is older than the beta we run. Installing `node-pty@latest` swaps 1.2.0-beta.15 for 1.1.0 and
brings back the ConPTY exit crash that `tests/unit/node-pty-version-pin.test.ts` guards.

So the inventory never takes `latest` at face value. A target must be above the installed version. A
stable install never takes a prerelease or crosses its ceiling, which is `latest`, or a stable dist-tag
on the installed major when that is higher, because a project can trail `latest` behind a line it still
ships: `electron-builder` publishes 26.x under a `v26` tag. A prerelease install takes another
prerelease only of the same major.minor.patch, so when the stable release ships it moves there and
not on to the next line's beta. Renovate's `ignoreUnstable` draws the same line. A deprecated release
is skipped, and a package with nothing else to move to is reported as `deprecated`, because the fix
is to replace or remove it: `@types/uuid` 11 is a stub.

It also treats a `^0.x` minor as a major, because caret ranges do, and reports the peer conflicts one
group would add. Each group is checked alone against what is installed, so TypeScript 7 conflicting
with `typescript-eslint` blocks the `typescript` group and not eslint's patch.

A lockstep group moves whole. Publishing a set takes minutes and a `@types` package can lag its
library, so a run can catch members on different numbers. The inventory flags that, and the researcher
picks a set that matches.

## Supply chain signals

There is no age gate. A target can be minutes old, so `/upgrade-deps` does not wait for someone else
to catch a bad release. It looks instead. The inventory compares each target to what is installed for
what the 2026 attacks changed: a new dependency (axios), a new install script, a `binding.gyp` with no
script (Phantom Gyp), lost provenance, and a new publisher. Across about 40 moves it flags three, and
all three are real changes: `@lingui/message-utils` adds `@noble/hashes`, and TypeScript 7 adds 20
platform packages and a new publisher. A signal is a reason to look. It gives the group its own
researcher, who has to explain it or block the group. `apply.md` then runs `npm audit signatures`,
which took 9 s. That proves a package came through the registry intact. It does not prove a
maintainer's account was safe, and transitive packages get no research at all.

Research itself reads text anyone can publish, about packages that can be minutes old, so the agent
reads a package and never runs one. An instruction did not hold: on the first run an agent told to use
read-only commands extracted a release from that morning and loaded it in node. So
`scripts/upgrade-researcher-guard.js` is a hook in the agent's frontmatter. It is an allowlist that
fails closed, and it limits Bash to reads through npm, gh and git, and Write to the briefs folder.

## How research is reused

The registry is read on every run, so a release from an hour ago shows up. Only research is cached,
as one JSON brief per group in `.upgrade-deps/briefs/`, a gitignored folder in the root checkout.

Research never expires. A published version's release notes do not change, so the only things that
send a group back to an agent are a version moving, or `--refresh`. The inventory compares each brief
to what it just read and gives the group a state:

| State | When | Cost |
|---|---|---|
| `reuse` | Same versions | None |
| `blocked` | Same versions, and what the blocker waits on has not moved | None |
| `filed` | A board task already carries the brief | None |
| `recheck` | Blocked, and what it waited on moved | The blocker alone |
| `delta` | Brief exists for older versions | The new releases only |
| `research` | No usable brief | Everything |

A blocked brief names the packages it waits on and their versions, so the check is a comparison and
needs no agent, even for a package nothing here declares. A run with nothing new spawns nothing. A
deep pass writes a draft as it goes, which the next pass continues and never reuses as an answer.

A filed group stays tied to its task when a new release moves its target. The run checks the task
first, updates it if it is still in To Do, and leaves it alone if work has started.

Briefs sit in the root checkout because every worktree of a clone can reach it. They get their own
folder because the alternatives each fail. `.kangentic/` is the app's: a project delete removes it, and
a worktree's copy goes with a preview exit. `.claude/` is a protected path, so a background agent cannot
write there unattended. The cost is that a brief is local to one machine. Another machine does the
research again, which is the worst that losing a brief can do. They are not committed because a run
that files nothing must still be reusable tomorrow, and a research run commits nothing.
A brief's `targets` is its cache key and always holds what the inventory asked for. When a task should
install something else, the brief says so in `installTargets`.

## One task, one agent

A run files one task and one agent does all of it, whatever its size. It never splits a group out and
never files a follow-up. The first full run filed the fewest tasks it judged safe and got four, three of
them in sequence. Tasks in sequence wait on a merge each, and tasks in parallel conflict in
`package-lock.json`, so a split only added waiting. The cost of one task is one large PR.

Each group is a phase with its own commit, ordered safest first with the terminal stack last. `apply.md`
drops a phase that cannot pass its gates and carries on, so a red group late in the run leaves every
commit before it standing.

The task rolls, because a run can come as often as you like. A run adds to the upgrade task waiting in
To Do. While one is past To Do, a run reports what could move and stops, and the first run after that
task merges picks it up.

Blocked groups get no phase, and the task lists them. The description is the plan, and each group's
brief is attached, because the attachments reach the agent's opening prompt anyway. Descriptions stay
under 25,000 characters, which leaves room for the briefs' paths. The field allows 27,500, and the
paths ride the same command line: past the shell's limit the spawn refuses the start, except on an
agent that can take the prompt typed
([A prompt too long for its command line](../architecture/sessions/spawn-flow.md#a-prompt-too-long-for-its-command-line)).

What a release adds is part of the job: workarounds it makes removable, deprecated APIs, new APIs that
replace our code, and new features. Anything a person would see is the task's last section, because it
starts from a mockup someone reviews. The agent publishes the mockup and builds nothing until you
approve it. Executing's Apply findings row tells an agent to take its recommended option, so `apply.md`
says that message is no approval. With automations on, the card then moves to review without the
feature, so pause them if you want it in the same PR.

The last upgrade phase is a lockfile refresh, because nothing else reaches a package nothing declares,
and most advisories live there. It stays in range and gets its own commit.

## Which model does what

The rule is to match the model to what a miss would cost.

| Stage | Model | Effort |
|---|---|---|
| Orchestrator, which judges the briefs and orders the phases | Opus | The session's |
| Research, low-risk batches | Haiku | Medium |
| Research, other risky groups | Sonnet | High |
| Research, `electron`, `node-pty`, `xterm`, a runtime major | Opus | High |
| Planning, Executing, Code Review | Opus | High |
| Testing, on an upgrade task | Opus, through the `Upgrade` Board Profile | High |

Research agents do not change code. Haiku costs a twentieth of Sonnet per token and is fine at reading,
but it over-flags and misjudges reach. On the first full run it cleared 8 of its 16 low-risk groups, and
the other 8 went to Sonnet, which reversed most of its alarms: all four of `vite`'s breaking changes,
`vitest`'s three, and a recommendation to hold `@tanstack/react-virtual` back. Two it cleared were sent
back too, for claiming an advisory cleared and for calling a shipped package dev-only. So treat a Haiku
brief as a cheap first read, and redo anything that is not simple on Sonnet before planning. The critical groups
earn Opus: that pass found the Electron 45.2.3 regression that would have drawn every WebGL terminal
at the wrong font on a green CI. Filed tasks set no model pins, because a pin lasts the
task's whole life and would bypass the columns. Testing needs the profile because `/pull-request` fixes
code there when CI fails. The agent keeps all the work in its one task, so everything significant
stays on the column's model.

## Why green tests are not the finish line

The [DepBench](https://arxiv.org/abs/2608.30300) study gave coding agents 203 real dependency upgrades
and the best setup solved 51%, with npm among the hardest ecosystems. Excluding runtime exceptions,
the largest failure was a migration that stopped short of the whole repo, and 61.8% of the failures
analyzed had passed the repo's visible tests first. So each breaking change in a brief carries a `find`
regex and a named test, and `apply.md` requires zero hits, or a reason for each, before a phase commits.

## What it costs

An inventory takes about 3 s and reads about 184 MB of registry metadata. The abbreviated format is
2.5x faster, but it has no publish dates or publisher, so the signals could not be computed from it.
Agent tokens are the real cost: 43k for a patch and 98k for a small major, measured. The depth guidance
in the agent cut a pass from 191k to 43k. The first full run, 28 groups from nothing, took 25 agents and
3.6M tokens, about a third of it on the four Opus groups. A second run took 3 s and no agents. Replaying
a daily run across 30 days of our real releases gave 1.8 groups a day with a new target, at most 6, and
12 days with none, so a repeat run pays only for what changed.
