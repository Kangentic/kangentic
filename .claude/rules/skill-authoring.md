---
paths:
  - ".claude/skills/**"
  - ".claude/agents/**"
---
# Rule: skill context (when to fork) and agent routing

Claude Code's `context: fork` skill-frontmatter field runs a skill in an isolated subagent: no
prior conversation history, the SKILL.md as its prompt, and only a final summary back to the main
loop. This gives fresh, unbiased context and keeps heavy intermediate output out of the main
session. Choosing it (or its alternatives) wrong makes skills slow, lossy, or unsafe.

## The rule

- **Fork** (`context: fork`, no `agent:` so it routes to the default general-purpose agent) when
  ALL hold: the skill is self-contained (derives everything from git, files, and args), produces
  heavy or noisy intermediate output, benefits from fresh / unbiased context, ends in a
  digestible summary, and has no mid-run user gate. No skill currently forks: `code-review`
  previously did, but moved to a main-loop driver + delegation (a forked driver spawning
  subagents would nest them). Its fresh-context independence is preserved by always running in an
  isolated session and delegating review judgment to fresh parallel subagents instead.
- **Do NOT fork** when ANY hold: it is a gated, mutating workflow (commit, rebase, push, tag,
  admin-merge) that needs main-loop visibility and confirmations; it is a knowledge-injection
  skill whose whole purpose is to enrich the MAIN context (`session-lifecycle`, `cross-platform`,
  `ipc-bridge`, `debug-activity`); it is active implementation tied to the current conversation;
  or it already delegates heavy work to a subagent (forking the driver risks subagent nesting,
  which is undocumented). `test` and `sync-docs` stay inline for this reason.
- **Active-implementation skills** verify by auto-spawning their auditor agent (delegation), not
  by forking: `add-ipc-endpoint` to `ipc-auditor`, `add-migration` to `migration-safety`, and
  `code-review` to its dimension auditors (`ipc-auditor`, `hmr-parity`, `platform-guard`,
  `session-debugger`, `migration-safety`) fanned out as parallel in-session subagents (the
  `Agent` tool) and synthesized in the main loop. `test` delegates to `test-builder` for coverage
  audits and test writing in a single in-session pass; `code-review` likewise delegates
  coverage-hole test-writing to `test-builder` in its Apply Phase (a read-only coverage finder in
  the fan-out identifies the red-green holes, then `test-builder` writes them), so `test-builder`
  stays the single source of truth for tier classification.
- **Never route a fixing or mutating skill to `agent: Explore` or `agent: Plan`** - those
  built-in agents are read-only and skip CLAUDE.md, so they would drop our conventions
  (single-command Bash, no em-dashes, no `any`). The default general-purpose fork loads CLAUDE.md
  and keeps the skill's `allowed-tools`.

## Enforcement (self-maintaining)

- **Review:** judgment-based, applied when authoring or editing a skill or agent. No mechanical
  test - skill routing is a design decision, not a code shape.

## Scope

Skill and agent authoring under `.claude/`. Does not govern product code.
