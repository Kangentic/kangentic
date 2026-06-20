---
paths:
  - "src/shared/types.ts"
  - "src/shared/ipc-channels.ts"
  - "src/shared/template-vars.ts"
  - "src/main/db/migrations/**"
  - "src/main/agent/adapters/**"
  - "src/renderer/components/settings/**"
---
# Rule: documentation tracks source (anchor parity)

`docs/` is anchored to source: union types, IPC channels, DB columns, config keys, settings tabs,
adapter capabilities, and template variables are enumerated in docs and must not drift from the
code that defines them. The `/sync-docs` skill owns the full source-to-doc mapping and the anchor
list; this rule is the in-context reminder that fires when you touch an anchor source file.

## The rule

When you change an anchor source file (a union / interface / default in `src/shared/types.ts`,
an IPC channel, a DB migration, an adapter capability, a settings tab or registry entry, or a
template variable), the docs that enumerate it must be updated to match.

- You do not have to hand-edit docs mid-task: the PR and push skills (`/pull-request`,
  `/merge-pull-request`, `/merge-back`) run the targeted doc-anchor check automatically, and the
  `doc-auditor` agent reports missing or extra anchor items.
- But keep the relationship in mind, and run `/sync-docs` (or note the affected docs) when a
  change adds or removes an enumerable item.
- The canonical mapping, anchor list, and workflow live in `.claude/skills/sync-docs/SKILL.md`.
  Do not duplicate that list here; update it there.

## Enforcement (self-maintaining)

- **Agent:** the `doc-auditor` agent mechanically counts anchor items in source vs docs and
  reports the diff.
- **Workflow:** `/sync-docs` (run standalone) performs the full update pass; its targeted anchor
  check also runs automatically inside `/pull-request`, `/merge-pull-request`, and `/merge-back`.

## Scope

Source-to-doc anchor parity. App or skill-internal docs and prose that is not anchored to an
enumerable source structure are handled by `/sync-docs`'s prose-audit pass, not this rule.
