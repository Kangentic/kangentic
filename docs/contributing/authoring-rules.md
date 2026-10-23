---
type: Guide
title: Authoring a rule
description: How to codify a convention as a .claude/rules file in this repo, including always-on versus paths-scoped loading, measuring the context a rule adds with measure-rule-load.js, the read-trigger gap, the required sections, and choosing the strongest enforcement.
tags: [contributing, rules, claude-code, conventions]
sources:
  - resource: scripts/measure-rule-load.js
  - resource: tests/unit/rules-index-parity.test.ts
---
# Authoring a rule

When you codify a new convention, add it as a `.claude/rules/*.md` file following the existing ones
(for example `board-config-parity.md`).

1. **One concern per file**, with a descriptive kebab-case filename.
2. **Decide loading, and measure what it costs.** Always-on rules (no frontmatter) load every
   session, so reserve them for universal, file-independent conventions (tool use, house style,
   security); we run 4, totalling about 12k characters. Everything subsystem-specific gets `paths:`
   frontmatter so it loads only when a matching file enters context. The number to watch is not that
   always-on count but the union an ordinary edit pulls in, because a rule scoped to `src/renderer/**`
   matches nearly every renderer file: measured on 2026-09-21, a board-card edit loads 129k
   characters of CLAUDE.md plus rules, a PTY edit 65k. `node scripts/measure-rule-load.js` prints it
   per subsystem (`--verbose` names each rule). Run it when you add a rule or widen a glob. If your
   change moves a subsystem's number a lot, narrow the glob or split the rule rather than accepting
   it. This is a procedure, not a gate: there is no measured point at which the union starts hurting,
   so a pass/fail threshold would be invented. The one real gate is on CLAUDE.md alone, where the
   harness supplies the limit.
3. **Mind the read-trigger gap.** A path-scoped rule loads when a matching file is *read into
   context*, not when Claude *creates* a new file in that path. So (a) any convention that must hold
   at file-creation time (universal style, security) belongs in an always-on rule, a lint rule, or a
   hook, never path-scoped-only; and (b) every path-scoped rule should have a CI backstop (a
   `tests/unit/` test, an ESLint rule, or a review-time auditor agent) so a missed load is still
   caught.
4. **Structure:** a one-paragraph context (the problem or the bug it prevents), `## The rule`
   (prescriptive), `## Enforcement (self-maintaining)`, and `## Scope`.
5. **Name an enforcement, strongest available.** A `PreToolUse` hook blocks 100%; a `tests/unit/`
   check or ESLint rule both run in CI; a review-time auditor agent or `/code-review` is the
   probabilistic fallback. Flag explicitly where mechanical coverage is missing. Do not stack three
   redundant enforcers on one rule.
6. **Update the rules index in CLAUDE.md** with a one-line pointer, and add a backlink from the
   enforcing agent or skill so the rule stays the single source of truth.
   `tests/unit/rules-index-parity.test.ts` fails when a rule is missing from the index.
7. **Scaling.** Rules are discovered recursively, so when the flat list grows large, group them into
   `.claude/rules/<subsystem>/` subdirectories (for example `frontend/`, `backend/`). There is no
   per-rule local override; machine-specific overrides go in `CLAUDE.local.md`.
