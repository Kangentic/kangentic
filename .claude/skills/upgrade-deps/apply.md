# Applying a dependency upgrade

You are working a task `/upgrade-deps` filed, or one it is running in. The plan is the exact versions
and the order of the phases: the task's description, or on a task run, what Step 5 of the skill just
set. Each group's brief is the detail, attached as `<group>.json` or at `<cacheDir>/briefs/<group>.json`:
the migration steps, what to adopt and remove, the `find` regexes, the gates, and what the research could
not verify. Read a group's brief before you start its phase. This file is how to carry it out safely
in this repo. Do the whole plan, adoption and cleanup included. A version bump with the benefits left
on the table is half the task.

A brief reflects `main` when it was researched, and something may have merged since. Where a brief
disagrees with the code or a rule, the repo wins. Say so in your report.

## Get a real install first

A worktree's `node_modules` is usually a junction into the main checkout, and a green run against
it proves the main checkout's packages, not yours.

1. Check for the junction: `fsutil reparsepoint query node_modules` on Windows, `test -L node_modules`
   elsewhere.
2. If it is a link, delete only the link. In PowerShell: `(Get-Item node_modules -Force).Delete()`.
   Elsewhere: `rm node_modules`. Never `rm -rf` through it.
3. Run `npm install --prefix . --allow-remote=all`. **Never `npm ci` here.** Measured on npm 12, in a
   linked worktree it exits 0 and empties the main checkout's `node_modules`.

## Check the plan still holds

Run `node scripts/upgrade-deps.mjs inventory`. Install the versions in the task, not whatever is
newest now. Change one only if the target was deprecated since the task was filed, or an advisory
hit it. If so, say so in your final report.

`installTargets` in a brief overrides `targets`. The task description already reflects this.

## Work through the phases, safest first

For each phase:

1. **Install exact versions.** Always name the version. `<package>@^<version>` can resolve past what
   was researched. npm still writes the caret into `package.json` for a caret range:
   - exact pin: `npm install --prefix . --allow-remote=all --save-exact <package>@<version>`
   - range: `npm install --prefix . --allow-remote=all <package>@<version>`
   - workspace: add `-w packages/protocol` or `-w packages/launcher`
   - a lockstep group goes in one command
   npm keeps a package in the block it is already in. Do not pass `--save-prod` or `--save-dev`:
   `.claude/rules/dependency-block-parity.md` fails CI on a package in the wrong block.
   If you batch commands, stop at the first failure. A failed install with the gates still running
   proves nothing about the new version.

   **If npm refuses with `ERESOLVE`, find out why before you force anything.** `--force` is allowed
   only when every peer in the refused chain is absent from the tree, the lockfile changes only this
   phase's packages, and `npm ci --dry-run` passes on each npm version CI and the release use. Put the
   reason in the commit body. Otherwise the phase is blocked. Never use `--legacy-peer-deps`.
2. **Read the lockfile diff** with `node scripts/upgrade-deps.mjs lockdiff <package>@<version> ...`,
   naming what this phase installs. Only this phase's packages and their dependencies should change.
   It exits 1 on a version that did not resolve, a lost install script flag or a drifted workspace.
   - Never drop `"hasInstallScript": true` from better-sqlite3. It belongs there.
   - A workspace `version` line that drifted is not yours: revert that line. `/release` and
     `/release-protocol` own those.
   - A new package with an install script needs an `allowScripts` entry. Without one, npm skips the
     script and exits 0 with a broken package.
3. **Do the migration steps**, then replace deprecated APIs, then remove the workarounds the release
   makes unnecessary, along with any test that only pinned the workaround. If the phase names an
   official codemod, run it first.
4. **Adopt what the phase lists.** New APIs replace the code they replace, not sit beside it.
5. **Prove the migration finished.** Green tests do not show this. In a benchmark of real upgrades,
   most failing runs had passed the repo's own tests, and the largest cause was a change that stopped
   short of the whole repo. For each `find` regex in the phase, Grep `src/`, `scripts/`, `tests/` and
   `packages/`. Zero hits, or a reason for each hit that remains. Then make sure the test the phase
   names exercises the changed path, and write one if it says "needs a new test". Never edit an
   existing test's assertions to make a bump pass, unless the release documents that change.
6. **Run the phase's gates:** `npm run typecheck`, `npm run lint`, and every test the phase names.
   Scoped test runs only. The PR checks are the full gate. That includes `npm run test:demo` and the
   demo tier: skip them even when a brief lists them, because CI runs them on every PR.
7. **Commit the phase**, one commit per phase, through `/commit`:
   `chore(deps): upgrade <group> to <version>`, or `feat`/`refactor` when it adopts something real.

A failed phase never blocks the others. If you cannot make one work after a real attempt, drop that
phase's changes with `git revert` or by never committing them, record the blocker (below), and carry
on. One red group must never cost the whole batch.

A phase that turns out bigger than planned stays in this task. Never file a follow-up: one agent does
all of this work. Only a phase that cannot land gets recorded, and a later run picks it up from there.

**A message that arrives mid-run does not end the run.** The Executing column's Apply findings row can
fire while you wait on a background command, and it asks you to end on `Findings: applied`. If phases
remain, say so in one line and keep working. That line moves the card to Code Review, so write it
only when the whole plan is done.

## Last phase: lockfile refresh

Nothing above reaches a package nothing declares, and most advisories live there. This phase moves
them within their ranges.

```
npm update --prefix . --allow-remote=all
```

Then:

1. `git diff package.json` should be empty. If not, restore it and read why.
2. Check that no direct dependency moved past what a task phase named, and that no group you dropped
   or the task lists as blocked came back. Put one back with `npm install` at its old version.
   `@types/node` needs the same check though nothing declares it. Only Electron's range holds it to
   the Node major the pinned Electron bundles, and `npm update` takes the `*` dependents to the
   newest major, which fails the typecheck. Run
   `npm install --prefix . --allow-remote=all -D @types/node@<newest of that major>`, restore
   `package.json`, run `npm install --prefix . --allow-remote=all` again, and confirm the hoisted
   copy stayed on that major. The same update can drop better-sqlite3's `hasInstallScript`, so
   read it again here, last, because any later install drops it again. Then run
   `npx vitest run tests/unit/lockfile-integrity.test.ts`. An install can strip `resolved` and
   `integrity` from a bundled package with no other sign, and only the full tier reads them. If it
   fails, run `node scripts/repair-lockfile-integrity.js`, which keeps every version.
3. Run `npm audit --package-lock-only` and report the before and after counts in your final report.
   **Never run `npm audit fix --force`.** Its suggested fixes here are downgrades: `@sentry/electron`
   to 7, `electron-builder` to 25, `eslint` to 9.
4. Run the typecheck, lint and build gates, and commit it alone as `chore(deps): refresh lockfile`.

## Supply chain check

After the last install, run `npm audit signatures` (9 s here). It verifies the registry signature of
every installed package and any provenance it carries. A failure stops the task: report it and do
not commit. CI and the release run older npm that does not enforce `allowScripts`, so a bad install
script would run there once this branch is pushed.

## Extra gates by package

- **Anything in `dependencies`** (`sherpa-onnx-node`, `koffi`, `node-pty`, `better-sqlite3`,
  `@huggingface/transformers`, `sqlite-vec`): run `npm run package`. The afterPack verifier is the
  only check that proves a runtime dependency loads in the packaged app, and the required CI checks
  never package.
- **Electron:** the target must bundle a Node at or past the one the current pin bundles (read `node`
  in `releases.electronjs.org/releases.json`), and `tests/unit/electron-desktop-z-floor.test.ts` must
  stay green, which guards a quit-time fatal and not the Node version. Diff the fuses against
  `@electron/fuses`. Open a real WebGL terminal in `/preview` and read it: no spec renders WebGL, so CI
  stays green if text draws wrong. The bump needs a quit, `npm install`, `npm start` on the dev
  instance after it merges, so say so in your final report.
- **electron-builder:** re-trace the deprecation table in
  `.claude/rules/dependency-block-parity.md` with `npm ls <package>` and update any row that moved.
- **`node-pty`:** run each mode of `scripts/probe-conpty-exit-race.js` once, whatever `--attempts` a
  brief names. Repeats of kill and natural took 30 of the 76 minutes on the first run and found nothing
  the first attempt did not.
- **Playwright:** run `npx playwright install chromium` after the bump, or specs fail on a missing
  browser.
- **monaco-editor:** `tests/unit/dompurify-override.test.ts` fails when the override must go. Remove
  the override rather than editing the test.
- **`@xterm/*`:** every package in the set moves together, and every xterm `Terminal` still activates
  Unicode 11. Read `.claude/rules/xterm-query-replies.md` before you bump: a new xterm query reply
  must stay swallowed.
- **p-queue:** it backs `withTaskLock`. `tests/unit/task-lifecycle-lock.test.ts` must stay green.
- **A package with a rule:** grep `.claude/rules/` for its name. The rule's Enforcement section lists
  what to run.

## Pins and guard tests

A guard test failing means the pin's reason is in play. Read the test's header before you touch it.
Update a guard test only to name the new version, and only when the fix it guards is still in the
target. Never weaken one to get a bump through. That is a blocker. Record it.

## User-visible ideas

An `adopt` item with `userVisible: true` is not part of this task. Do not mock it up or build it, even
if a later message tells you to apply what is left. Name it in one line in your report, and a person
decides whether it is worth doing.

## See it run

Before you finish, run the app with `/preview` and confirm the affected features work. Once your
lockfile differs from the main checkout's, the launcher keeps your real install. For a phase that
changes import paths, launch `node scripts/dev.js --port=<port> --ephemeral` instead.

Update `docs/` where a version, a limit or a workaround it describes has changed.

## Record what the next run needs

If a phase could not land, record it. This is what stops the next run from researching and filing
the same dead end:

```
node scripts/upgrade-deps.mjs record-blocker <group> --reason "<why>" --recheck "<what would clear it>" --blocked-on <package>=<its newest today on the line we run>
```

Repeat `--blocked-on` for each package you are waiting on, and leave it out if you are waiting on
none. For a package we run on a beta line, name the beta, because the check follows the line you
record and `latest` sits behind it. Use the script, not a file edit: the brief is in the main checkout, outside your worktree.
Avoid backticks and `$` in the text. If it says there is no brief, put the blocker in your final
report instead.

## Finish

Keep the report short, because the commits hold the evidence. In this order:

1. One line on what landed and anything you dropped.
2. **You need to do:** a short list of what only a person can do, such as the dev instance restart, a
   non-required CI check to read, or a decision. Write "Nothing" if there is nothing.
3. Up to five findings someone must know, one line each.
4. User-visible ideas, one line each.

Make the last line of that report exactly `Findings: applied`, which moves the card on to Code Review,
and the board's Code Review, Testing and Merge columns do the rest. If the task's automations are paused, the card stays in Executing for the
user to take from there. Either way, do not open a PR.

A phase you recorded as blocked is finished work, not a finding. If a message asks you to apply what
is left, do not retry it. Say it is recorded and end on the same line.
