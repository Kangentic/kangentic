---
paths:
  - "src/main/automations/**"
  - "src/shared/automation-manifest.ts"
  - "src/main/transition-engine/transition-engine.ts"
  - "src/main/config/board-config/**"
  - "src/renderer/components/dialogs/board-manager/**"
---
# Rule: an automation type is an adapter, declared once in the manifest

A column's automations are typed, and the type set will grow: Move to column, tracker write-back,
and a "when the agent finishes" trigger are all named follow-ups. The action system this replaces
put every type in one `switch` in `transition-engine.ts`, so adding one meant editing the engine,
the file format, the validator and the UI by hand, and the four drifted. `send_command` in the
list was dead for months because `executeSendCommand` returned when `task.session_id` was null,
and nobody noticed because nothing declared what a type needs.

The fix is the same shape `src/main/pr/` and `src/main/boards/` already use: a shared contract, a
registry, one folder per type, and a manifest the renderer reads.

## The rule

- **A type is declared exactly once**, in `AUTOMATION_MANIFEST` (`src/shared/automation-manifest.ts`):
  label, description, icon, `status`, `needs`, `fields`, `timeoutMs`, `retry`. That one entry
  drives the picker, the Edit automation dialog's fields, the `kangentic.json` validator, the row
  sentence and the docs table. Never hand-write a type's fields at a consumer.
- **The behavior lives in `src/main/automations/adapters/<type>/`**, implementing
  `AutomationAdapter`, and is registered in `automation-registry.ts`. No type-name branching
  anywhere else: not in the engine, not in the file format, not in the renderer. The manifest is
  how a consumer asks a question about a type.
- **An adapter never interpolates and never escapes.** The runner substitutes template variables
  before calling `execute`, applying each field's own `escape`. A task title can arrive from an
  imported GitHub issue, so it is not text this user wrote: `escape: 'none'` is legal only for
  prose an agent reads, and every other field declares `'shell'`, `'json'` or `'url'`.
- **An adapter never retries and never times out itself.** Both are declared on its manifest entry
  and enforced by the runner, so the policy is uniform and visible in one place. Nothing timed out
  before this: `withTaskLock` is a `PQueue` with no `timeout` and the move's Phase 3 holds it
  across the whole list, so one hung row wedged every later operation on that task until a restart.
- **A field key is never a reserved `kangentic.json` row key** (`name`, `type`, `enabled`). The
  file writes a row flat, which reads better in a committed file, and the reserved set will grow.
- **`describe(config)` must not throw on any input**, including `{}` and a config full of
  unsubstituted `{{variables}}`. A half-built draft renders through it: the picker adds an
  automation before it has a name or a value.
- **`canColumnRun` is the only answer to "will this run here"**, shared by the engine and the
  renderer, so the board and the engine can never disagree about what is about to happen.

## Enforcement (self-maintaining)

- **Load-time:** `automation-registry.ts` throws if the manifest keys and the registered ids
  disagree, so a manifest entry with no adapter (a picker option that throws when chosen) or an
  adapter with no manifest entry (no fields to render) fails on the first import rather than on a
  user's board.
- **Test:** `tests/unit/automation-adapter-parity.test.ts` runs over the REAL registry: ids match
  the manifest, every stable type has fields and a description under 110 characters, `spawn_agent`
  is the only legacy type, no retired action type resolves, `describe` survives `{}` and
  unsubstituted variables, the hanging types declare a timeout, only the webhook retries, and the
  set of fields that substitute raw values equals an explicit allowlist. That last one is the
  assertion with teeth: a new field that pairs `templateVariables` with `escape: 'none'` fails
  until someone adds it to the allowlist deliberately.
- **Test:** `tests/unit/automation-manifest-reserved-keys.test.ts` fails a field key that collides
  with a reserved row key, repeats within its type, is not a plain identifier, or declares options
  a field of that kind cannot render.
- Both run in CI via `npm run test:unit`.
- **Review:** `/code-review`'s always-on conventions finder flags type-name branching outside
  `adapters/`, the same criterion it already applies to agent, board and PR adapters (see
  [[agent-adapters-boundary]]).

## Scope

Automation types and their adapters. The three retired action types (`kill_session`,
`create_worktree`, `cleanup_worktree`) are deliberately absent from the registry rather than
present as legacy: each was a no-op or a duplicate of the move path, so the migration drops their
rows and the file reader warns and skips them. `spawn_agent` is the one legacy adapter, because a
custom `promptTemplate` has no other home.

Does not govern the trigger set. There are two triggers today, `enter` and `exit`, and the `trigger`
column is TEXT rather than a boolean precisely so a third is an adapter-shaped change and not a
migration.
