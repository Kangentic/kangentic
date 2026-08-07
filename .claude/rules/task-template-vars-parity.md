---
paths:
  - "src/shared/task-template-vars.ts"
  - "src/main/agent/shared/task-template-resolvers.ts"
  - "src/main/agent/shared/template-utils.ts"
  - "src/main/ipc/helpers/agent-spawn.ts"
  - "src/main/transition-engine/transition-engine.ts"
  - "src/renderer/components/dialogs/BoardManagerDialog.tsx"
  - "docs/transition-engine.md"
  - "docs/architecture.md"
---
# Rule: task-template-variable parity (chips + resolvers + docs track one catalog)

Two template contexts (a column/per-task `auto_command` and a `spawn_agent` action's
`promptTemplate`) both interpolate `{{keyword}}` placeholders against a task. The keyword set used
to be declared four times with no link between them: `buildAutoCommandVars` (6 keys, in
`agent-spawn.ts`), the engine's inline `templateVars` object (10 keys, duplicated at two call
sites in `transition-engine.ts`), the UI chip list (`TEMPLATE_VARIABLES` in
`BoardManagerDialog.tsx`, 5 keys), and two docs tables. They drifted silently: the UI never
surfaced `{{baseBranch}}`, and `{{baseBranch}}` itself resolved to `task.base_branch || ''` -
empty for the ~99% of tasks with no per-task override, instead of falling through to the
project's configured default. Every automated Code Review auto-command silently ran with no base
ref for over a week before anyone noticed.

The fix is one source of truth: `src/shared/task-template-vars.ts` (`TASK_TEMPLATE_VAR_NAMES` /
`TASK_TEMPLATE_VARS`) declares the 10 keywords once; `src/main/agent/shared/task-template-resolvers.ts`
(`TASK_TEMPLATE_RESOLVERS`, a `Record<TaskTemplateVarName, ...>`) resolves each one exactly once;
the UI chips render from the shared catalog; and both docs tables are checked against it.

## The rule

When you add, rename, or remove a task-template keyword:

1. **Catalog:** add/rename/remove the entry in `TASK_TEMPLATE_VAR_NAMES` and `TASK_TEMPLATE_VARS`
   (`src/shared/task-template-vars.ts`). This is the only hand-edited list.
2. **Resolver:** add/rename/remove the matching key in `TASK_TEMPLATE_RESOLVERS`
   (`src/main/agent/shared/task-template-resolvers.ts`). The `Record<TaskTemplateVarName, ...>`
   shape makes a missing resolver a `tsc` failure, not a silent gap.
3. **UI:** nothing to edit - `BoardManagerDialog.tsx`'s "Template variable" picker maps
   `TASK_TEMPLATE_VARS` directly, rendering each entry's `chip` and `description`. Because it
   shows the description too, a new keyword's `description` is user-facing copy, not just a docs
   string: keep it to one line (the menu clamps it).
4. **Docs:** document the new keyword in both `docs/transition-engine.md` (Template Variables)
   and `docs/architecture.md` (Action Types). This couples to [[docs-stay-in-sync]].
5. **Resolution semantics are per-keyword, not a blanket rule.** `{{baseBranch}}` resolves to the
   EFFECTIVE base (`task.base_branch ?? defaultBaseBranch ?? 'main'`); `{{worktreePath}}` and
   `{{branchName}}` stay raw reads of the task column (empty is correct for a task with no
   worktree/branch, and must NOT fall back to a project-level value). Do not "fix" a raw-read
   keyword to match `{{baseBranch}}`'s fallback behavior.
6. **`auto_command` and `promptTemplate` share drop-and-collapse interpolation**
   (`interpolateTaskTemplate` in `template-utils.ts`): an empty-valued or unknown `{{key}}` is
   dropped and horizontal whitespace collapses (newlines are preserved). The collapse applies to
   ALL literal text in the template, not only the run a dropped placeholder left behind, so a
   hand-aligned `/foo  --flag` delivers as `/foo --flag`; substituted values are exempt and are
   inserted verbatim. This is deliberately scoped - `send_command` / `run_script` / `webhook` keep
   the general `interpolateTemplate` (unknown left as a literal placeholder), so do not switch
   them to `interpolateTaskTemplate` without a considered reason.
7. **Only the interpolation MECHANICS are scoped, not the resolved VALUES.** `executeAction`
   builds one `resolveTaskTemplateVars` object and feeds every action type from it, so
   `send_command` / `run_script` / `webhook` also see `{{baseBranch}}` resolved to the effective
   default (they previously saw `task.base_branch || ''`). That uniformity is intended - a base
   ref should mean the same thing in every action - but it means a change to a resolver's
   semantics fans out beyond the two drop-and-collapse contexts. Weigh that blast radius when
   editing `TASK_TEMPLATE_RESOLVERS`.

## Enforcement (self-maintaining)

- **Compile-time:** `TASK_TEMPLATE_RESOLVERS: Record<TaskTemplateVarName, ...>` fails
  `npm run typecheck` the moment a catalog name has no resolver.
- **Test (mechanical, CI):** `tests/unit/task-template-vars-parity.test.ts` asserts (a) every
  catalog name has a resolver and vice versa; (b) `TASK_TEMPLATE_VARS` covers exactly the catalog
  names, and that the dialog maps the catalog rather than hardcoding chips of its own; (c) every
  chip is documented in both `docs/transition-engine.md` and
  `docs/architecture.md`; plus red-green coverage of the `{{baseBranch}}` effective-default fix
  and the `interpolateTaskTemplate` drop-and-collapse semantics (including that a substituted
  value containing literal `{{...}}` text is never re-scanned). Runs in CI via `npm run test:unit`.
- **Review:** `/code-review` flags a new task-template keyword added to only one of the catalog /
  resolver / docs, and the `doc-auditor` agent reports a chip missing from the docs tables.

## Scope

The task-template keyword system (`auto_command` and `spawn_agent` `promptTemplate`) and its two
enumerating surfaces (the Automation tab's chip list, and the two docs tables). The Shortcut
command template system (`src/shared/template-vars.ts`, `{{cwd}}` / `{{branchName}}` /
`{{taskTitle}}` / `{{projectPath}}`) is a separate, unrelated system and out of scope. The general
`interpolateTemplate` used by `send_command` / `run_script` / `webhook` keeps its own (unscoped,
literal-passthrough) behavior and is not governed by the drop-and-collapse rule above.
