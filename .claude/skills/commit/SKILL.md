---
description: Create a LOCAL commit only - stage and commit on the current branch with no push and no rebase. Use for "commit" / "commit changes" / "commit current changes" / "save my work". NOT for pushing, landing, or merging back (use /pull-request or /merge-back for that).
allowed-tools: Read, Glob, Grep, Bash(git:*), Write
argument-hint: [commit message]
---

# Commit

Create a local commit of the current changes. Does NOT push, rebase, fetch, or run
heavy validation. The point is a fast, safe snapshot of the working tree (for example,
to protect changes before testing in `/preview`, or to capture changes made while
testing). To push and land, move the task through the board (Tests runs `/pull-request`, Ship It runs
`/merge-pull-request`), or use `/merge-back` for a direct quick-push.

**Usage:** `/commit [commit message]`

- `/commit` - auto-generates a conventional-commit message from the diff
- `/commit fix the resize race` - uses the provided text, prepending a type prefix if missing

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git in another directory use `git -C <path>`, never `cd <path> &&
git ...` (triggers an unbypassable security prompt). Never use `$(...)` or backtick command
substitution. Never write to `.git/` (in worktrees `.git` is a file, not a directory).

This skill never pushes, rebases, fetches, force-pushes, or amends. It only stages and creates a
new local commit. If the user wants any of those, stop and point them at the PR flow (`/pull-request`) or `/merge-back` for a direct quick-push.

## Step 0 - Confirm intent

If the user has not already explicitly approved committing in this turn, ask once before
proceeding (never commit without an explicit go-ahead). If they approved, continue.

Do NOT run `npm ci`, `npm install`, `npm run typecheck`, or `npm run lint` here. A local commit
is a snapshot and must stay fast; running `npm ci` would also break the `node_modules` junction a
running `/preview` relies on. Full validation happens at push time (CI's PR checks via `/pull-request`, or `/merge-back` before a direct push).

## Step 1 - Inspect the working tree

1. Run `git rev-parse --abbrev-ref HEAD` to get the branch. If `HEAD` (detached), warn and stop.
2. Run `git status --porcelain`. If empty, report "nothing to commit" and stop.
3. Show the user `git status` and `git diff --stat` so they can see what will be committed.

## Step 2 - Determine the commit message

Use conventional-commit format (`type(scope): subject`), matching `/merge-back`.

- If a message argument was provided:
  - If it already starts with a conventional prefix (`feat:`, `fix:`, `refactor:`, `chore:`,
    `docs:`, `test:`, `style:`, `perf:`, `ci:`, `build:`, optionally with `!` before the colon
    and an optional `(scope)`), use it as-is.
  - Otherwise analyze the diff to pick the right type and prepend it (e.g. `added dark mode`
    becomes `feat: added dark mode`).
- If no argument was provided, read the diff (`git diff` and `git diff --cached`) and draft a
  concise conventional-commit message:
  - `feat:` new capability, `fix:` bug fix, `refactor:` no behavior change, `chore:` maintenance,
    `docs:` docs only, `test:` tests only, `style:` formatting, `perf:` performance, `ci:` CI,
    `build:` build system. Add `!` for a breaking change. Scope is optional but encouraged for
    multi-area changes.
- No em-dashes (U+2014) or `--` as punctuation in the message (see `.claude/rules/text-formatting.md`).

## Step 3 - Stage and commit

1. Write the commit message with the **Write tool** to the relative path
   `.kangentic/COMMIT_MSG.tmp` (resolved from CWD, never an absolute or system-temp path).
   `.kangentic/` is gitignored, so it is never staged and needs no cleanup.
2. Stage everything: `git add -A`

   If the tree holds changes this session did not write, a `/code-review` pass may still be running
   in this worktree, or it finished and deliberately left a mixed-authorship path uncommitted -
   either way `git add -A` would sweep a state you did not author. See the Code Review note in
   `.claude/skills/pull-request/SKILL.md` **Pre-flight Checks**, and confirm with the user first.
3. Commit: `git commit -F .kangentic/COMMIT_MSG.tmp`

## Step 4 - Report

Report the new commit's short hash and subject, the branch it landed on, and the file count.
Remind the user this is a local commit only - when they are ready to push, move the task to the Tests column (`/pull-request`) or run `/merge-back` for a direct quick-push.
