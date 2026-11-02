---
type: Guide
title: Shared agent instructions
description: "How Claude Code and Cursor read one set of instructions in this repo: AGENTS.md imported by CLAUDE.md, the skills both load from .claude/, the Cursor rules and subagents generated from .claude/ and why they are gitignored, what to check when Cursor does not load something, and what is still unverified in Cursor."
tags: [contributing, agents, claude-code, cursor, rules]
sources:
  - resource: scripts/cursor-rules.js
  - resource: scripts/lib/claude-rules.js
  - resource: tests/unit/cursor-rules.test.ts
  - resource: tests/unit/rules-index-parity.test.ts
---
# Shared agent instructions

Claude Code and Cursor both work in this repository, and both read the same instructions. Each file
has one home. The two things Cursor cannot use as written, the rules and the subagents, are
generated for it rather than copied by hand, and `.claude/` stays exactly as Claude Code wants it.

## What each tool reads

- **`AGENTS.md`** holds the shared instructions: project structure, commands, architecture notes,
  and the conventions index. Cursor and the Cursor CLI read it as a rule. Claude Code reads it
  through the `@AGENTS.md` import on the first line of `CLAUDE.md`.
- **`CLAUDE.md`** holds the import and the notes that bind only Claude Code: the
  `bash-single-command.md` rule, which governs its Bash tool, and `CLAUDE.local.md` for local
  overrides. The Cursor CLI reads the root `CLAUDE.md` too, so each note there names Claude Code.
  Cursor sends `AGENTS.md` and `CLAUDE.md` once only when they are identical, a symlink or a hard
  link (release 3.26). Ours differ on purpose, so Cursor loads both. Its docs describe no `@` import
  inside `CLAUDE.md`, so the `@AGENTS.md` line is read as text and `AGENTS.md` is not loaded twice.
  The cost is the few hundred characters of `CLAUDE.md`.
- **`.claude/skills/`** is read by both. Cursor loads it for compatibility and requires a `name` in
  each skill's frontmatter, so every `SKILL.md` names its directory.
- **`.claude/agents/`** is read by Claude Code as written, with `model: haiku` or `sonnet` routing
  the cheaper checks. Cursor loads it too, but its docs name only `inherit` or a specific model ID
  for `model` and give no format for `description`, and a contributor's run on Cursor showed three
  problems:
  `model: haiku` started Claude Haiku 4.5 and stopped when the account could not use it, a subagent
  with no model chosen ran on the file's model and not the session's, and the multi-line
  `description: |` printed as the character `|`. Those are observations, and a third-party tutorial
  reports an unlisted model value silently falling back to `inherit` instead, so what Cursor does
  with `haiku` is not settled. The generated copy avoids the question by never naming a model.
  Cursor's subagents doc says `.cursor/` wins over `.claude/` for the same name, so
  `scripts/cursor-rules.js` writes a copy there.
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
`.claude/agents/` for the same name, so a stale copy would silently replace the live agent. The
generated subagents use that same precedence on purpose. They are rewritten on every install and
start, and each carries a marker, so a copy cannot go stale.

## The generated Cursor rules and agents

`scripts/cursor-rules.js` writes `.cursor/rules/<name>.mdc` for every `.claude/rules/<name>.md`,
subfolders included:

- `paths:` becomes one `globs:` line, comma-separated as Cursor documents it, with
  `alwaysApply: false`. A rule with no `paths:` loads every session in Claude Code, so it becomes
  `alwaysApply: true`.
- The `description` is the rule's `# Rule:` title. The body is copied byte for byte.
- A comment after the frontmatter names the source file, so an agent in Cursor edits the rule
  rather than the copy.
- Rules in `CLAUDE_CODE_ONLY_RULES` get no copy. Today that is `bash-single-command.md`.

It also writes `.cursor/agents/<name>.md` for every `.claude/agents/<name>.md`:

- `name` is kept. `description` is flattened to one quoted line, so a `|` block no longer prints as
  `|`. `model` is always `inherit`, so the subagent runs on the session's model.
- `readonly: true` is set when the agent's `tools:` name only `Read`, `Glob` and `Grep`
  (`READ_ONLY_TOOLS` in the script). Cursor documents no `tools` field, and `readonly` is how a
  read-only agent stays read-only there. The flag is derived, not stored in `.claude/agents/`, so
  those files carry no Cursor-only key. An agent with other tools, or none listed, is not marked.
- `tools:`, `effort:` and the original `model:` are left out. The prompt body is copied byte for
  byte, after the same marker comment.
- Cursor then runs every subagent on the session's model. Claude Code keeps the `haiku` and
  `sonnet` routing, because it reads `.claude/agents/`.

It runs from three places: `npm run cursor:rules`, `prepare` (every `npm install`, which a fresh
task worktree needs before anything else), and `scripts/dev.js` (every `npm start`, which catches a
pull that changed a rule or agent with no reinstall). It rewrites a file only when its text changed.
It removes a generated file whose source is gone. It never overwrites or removes a file a developer
wrote by hand, including one with the name of a generated file: only a file that carries the
generated marker is its to rewrite.

The output is gitignored on purpose. A committed copy would need a parity test, and then every edit
to a team rule or agent would have to rerun the script or fail CI. What CI checks instead is the
translation: `tests/unit/cursor-rules.test.ts` translates every live rule and agent, so one the
translator cannot carry fails there first. It refuses a rule with no `# Rule:` title, a `paths:`
entry holding a comma or a brace (a comma-separated list cannot carry either, so split such an entry
into one per pattern), and an agent with no description or a name that is not lowercase letters and
hyphens. The script reads the few frontmatter keys it needs itself, so it adds no YAML dependency
to `prepare`.

A new rule that binds only Claude Code goes in two places: `CLAUDE_CODE_ONLY_RULES` in the script,
and the "Always-on rules (Claude Code only)" list in `CLAUDE.md`.
`tests/unit/rules-index-parity.test.ts` holds the two lists equal.

## The size budget

`AGENTS.md` and `CLAUDE.md` both load into every Claude Code session and every subagent's fixed
floor. `tests/unit/rules-index-parity.test.ts` fails when the two together pass 40,000 characters,
the point Claude Code warns at for one file. `node scripts/measure-rule-load.js` reports the two as
one floor.

## Working in Cursor

`npm install` writes the rules and the subagents. After a pull that changed `.claude/rules/` or
`.claude/agents/`, `npm start` or `npm run cursor:rules` refreshes them. Edit the file under
`.claude/`, never the copy.

`.cursor/mcp.json` is not committed. Kangentic's own Cursor adapter merges its MCP entry into that
file while a Cursor session runs in the folder, so a committed copy would show as changed for the
whole session. A file the adapter creates itself, it keeps out of `git status`.

## When Cursor does not load something

- **No skills and no subagents.** Cursor Settings, Agents, Third-Party Imports, "Include
  Third-Party Plugins, Skills, and Other Configs" must be on. It is on by default, and a
  contributor's was off: Cursor then listed none of the 18 skills and none of the subagents, and
  deleting `.cursor/` did not switch it over to `.claude/`. The setting is the only way the skills
  reach Cursor, since they are not copied. With it off, the generated rules and subagents still
  load. A forum thread says it applies to the editor and not the CLI, which always loads them, and
  that it brings in personal `~/.claude/skills` and `~/.claude/agents` as well.
- **No rules or subagents under `.cursor/`.** Run `npm run cursor:rules`. An install with scripts
  turned off (`npm ci --ignore-scripts`) skips `prepare`, which is what writes them. Expect one
  `.mdc` in `.cursor/rules/` for each rule except `bash-single-command.md`, and one file in
  `.cursor/agents/` for each agent.
- **Files that are there but unused.** `.cursor/rules/` and `.cursor/agents/` are gitignored, and
  Cursor's ignore doc says it ignores `.gitignore`d files, without saying whether rules or
  subagents are exempt. A contributor's current Cursor loaded both. Forum reports describe
  gitignored rule files skipped on some versions (one regression around 2.1.50 on macOS, for
  rules listed in `.git/info/exclude`), so check the Cursor version first. `.cursorignore` blocks
  access and does not re-include anything, so it is no fix.
- **Cloud agents and Bugbot.** They work from a clone, which has no gitignored files. They get
  `AGENTS.md`, `CLAUDE.md` and `.claude/` as pushed, and the generated rules and subagents exist
  only if the environment's install step runs `npm install` or `npm run cursor:rules`. Without
  that, their subagents load as written, `model: haiku` included. This follows from how Cursor
  describes the install step and has not been run.
- **A `globs` value.** The generator writes it the way Cursor documents it, comma-separated, and
  quotes it when a plain scalar would not parse (a leading `*` is a YAML alias). Forum posts
  disagree on whether a YAML list works better, so the documented form is the one used. Every
  generated rule parses as strict YAML.

## Verified in Cursor, and still open

A contributor checked the generated setup on a Grok 4.7 session. The 18 skills each loaded once,
all from `.claude/skills/`. The 10 subagents each loaded once from `.cursor/agents/`, which
replaced `.claude/agents/` for the same name, each with a full-sentence description. `doc-auditor`
with no model chosen ran on the session's model and did not start Claude Haiku 4.5, and a write
was refused with Cursor's "ask mode" wording. The `@AGENTS.md` line in `CLAUDE.md` stayed literal,
`AGENTS.md` loaded once, and the generated `writing-style` rule was in effect.

The contributor's subagent list showed no model and no read-only mark beside a name. The model
showed on the run.

Still open:

- Whether a path-scoped rule (one with `globs`) attaches when a matching file is in context. Only
  an always-on rule was observed.
- Whether the Cursor CLI behaves the same as the editor for the setting above and for `CLAUDE.md`.
- Whether Cursor picks up a rule generated after its session started, as when an agent runs
  `npm install` in a fresh worktree mid-session.
