---
type: Guide
title: Shared agent instructions
description: "How Claude Code and Cursor read one set of instructions in this repo: AGENTS.md imported by CLAUDE.md, the skills and subagents both load from .claude/, the Cursor rules generated from .claude/rules/ and why they are gitignored, and what is still unverified in Cursor."
tags: [contributing, agents, claude-code, cursor, rules]
sources:
  - resource: scripts/cursor-rules.js
  - resource: scripts/lib/claude-rules.js
  - resource: tests/unit/cursor-rules.test.ts
  - resource: tests/unit/rules-index-parity.test.ts
---
# Shared agent instructions

Claude Code and Cursor both work in this repository, and both read the same instructions. Each file
has one home. The one thing Cursor cannot read in place, the rules, is generated for it rather than
copied by hand.

## What each tool reads

- **`AGENTS.md`** holds the shared instructions: project structure, commands, architecture notes,
  and the conventions index. Cursor and the Cursor CLI read it as a rule. Claude Code reads it
  through the `@AGENTS.md` import on the first line of `CLAUDE.md`.
- **`CLAUDE.md`** holds the import and the notes that bind only Claude Code: the
  `bash-single-command.md` rule, which governs its Bash tool, and `CLAUDE.local.md` for local
  overrides. The Cursor CLI reads the root `CLAUDE.md` too, so each note there names Claude Code.
- **`.claude/skills/`** is read by both. Cursor loads it for compatibility and requires a `name` in
  each skill's frontmatter, so every `SKILL.md` names its directory.
- **`.claude/agents/`** is read by both. Cursor documents `name`, `description`, `model`, `readonly`
  and `is_background`, and no `tools` field, so the eight agents whose `tools:` is only
  `Read, Glob, Grep` also carry `readonly: true`. Claude Code ignores a subagent key it does not
  recognize, without an error.
- **`.claude/rules/`** is read only by Claude Code. Cursor reads `.mdc` files in `.cursor/rules/`
  and nothing else, so `scripts/cursor-rules.js` writes them.

## Why an import, and not a copy or a symlink

Claude Code reads `AGENTS.md` directly only when no `CLAUDE.md` exists. Keeping `CLAUDE.md` for
the Claude-only notes means it has to import `AGENTS.md`, which is what Claude Code's docs
recommend when both files exist. An import loads with the file that imports it, and Claude Code
never reads the same `AGENTS.md` twice.

A symlink from `CLAUDE.md` to `AGENTS.md` would leave nowhere for the Claude-only notes, and a
Windows clone checks a committed symlink out as a one-line text file unless `core.symlinks` is on.

A hand copy of `.claude/` under `.cursor/` was tried first. Nothing kept it in sync, two notes
needed hand mirroring within a day, and Cursor gives `.cursor/agents/` precedence over
`.claude/agents/` for the same name, so a stale copy would silently replace the live agent.

## The generated Cursor rules

`scripts/cursor-rules.js` writes `.cursor/rules/<name>.mdc` for every `.claude/rules/<name>.md`,
subfolders included:

- `paths:` becomes one `globs:` line, comma-separated as Cursor documents it, with
  `alwaysApply: false`. A rule with no `paths:` loads every session in Claude Code, so it becomes
  `alwaysApply: true`.
- The `description` is the rule's `# Rule:` title. The body is copied byte for byte.
- A comment after the frontmatter names the source file, so an agent in Cursor edits the rule
  rather than the copy.
- Rules in `CLAUDE_CODE_ONLY_RULES` get no copy. Today that is `bash-single-command.md`.

It runs from three places: `npm run cursor:rules`, `prepare` (every `npm install`, which a fresh
task worktree needs before anything else), and `scripts/dev.js` (every `npm start`, which catches a
pull that changed a rule with no reinstall). It rewrites a file only when its text changed. It
removes a generated file whose rule is gone, and leaves any `.mdc` a developer wrote by hand.

The output is gitignored on purpose. A committed copy would need a parity test, and then every edit
to a team rule would have to rerun the script or fail CI. What CI checks instead is the translation:
`tests/unit/cursor-rules.test.ts` translates every live rule, so a rule the translator cannot carry
fails there first. It refuses a rule with no `# Rule:` title and a `paths:` entry holding a comma or
a brace, since a comma-separated list cannot carry either. Split such an entry into one per pattern.

A new rule that binds only Claude Code goes in two places: `CLAUDE_CODE_ONLY_RULES` in the script,
and the "Always-on rules (Claude Code only)" list in `CLAUDE.md`.
`tests/unit/rules-index-parity.test.ts` holds the two lists equal.

## The size budget

`AGENTS.md` and `CLAUDE.md` both load into every Claude Code session and every subagent's fixed
floor. `tests/unit/rules-index-parity.test.ts` fails when the two together pass 40,000 characters,
the point Claude Code warns at for one file. `node scripts/measure-rule-load.js` reports the two as
one floor.

## Working in Cursor

`npm install` writes the rules. After a pull that changed `.claude/rules/`, `npm start` or
`npm run cursor:rules` refreshes them. Edit the rule under `.claude/rules/`, never the copy.

`.cursor/mcp.json` is not committed. Kangentic's own Cursor adapter merges its MCP entry into that
file while a Cursor session runs in the folder, so a committed copy would show as changed for the
whole session. A file the adapter creates itself, it keeps out of `git status`.

## Not yet verified in Cursor

- How Cursor treats `model: sonnet` and `model: haiku` in `.claude/agents/`. It documents only
  `inherit` and its own model ids.
- Whether `readonly: true` holds the eight read-only agents to read-only in practice.
- Whether Cursor picks up a rule generated after its session started, as when an agent runs
  `npm install` in a fresh worktree mid-session.
