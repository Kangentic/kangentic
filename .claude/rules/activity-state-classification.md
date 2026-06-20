---
paths:
  - "src/renderer/**"
  - "src/shared/activity-state.ts"
---
# Rule: classify ActivityState idle-vs-active only through the shared classifier

`ActivityState` is a three-value union (`'thinking' | 'idle' | 'permission'`), but the question
consumers actually ask is the binary Kangentic idle-vs-active distinction: does this session
require user interaction, or is the agent working on its own? When each consumer re-derives that
bucket inline by comparing string literals, nothing forces all "requires interaction" variants
(`'idle'` and `'permission'`) to be handled together. That is exactly how the sidebar
active/idle miscount shipped: `ProjectListItem` wrote `=== 'idle'` and silently bucketed a
`'permission'`-blocked session as active. A future fourth state would reintroduce the bug at
every inline site.

## The rule

The idle-vs-active bucket has a single source of truth: `src/shared/activity-state.ts`.

- To ask "does this session require user interaction?" (idle or permission), call
  `requiresUserInteraction(state)`. To ask "is the agent actively working?" (thinking), call
  `isActive(state)`. Both accept `ActivityState | undefined`.
- Never hand-roll the bucket by comparing an `ActivityState` value to a literal
  (`activity === 'idle'`, `=== 'permission'`, `=== 'thinking'`) in renderer code.
- New `ActivityState` variants are classified in the `ACTIVITY_DISPOSITION` table, which is
  `satisfies Record<ActivityState, ActivityDisposition>` so a missing classification fails the
  build.

Legitimate exception: a GRANULAR comparison that distinguishes specific states for an affordance
(not a bucket) is allowed - e.g. permission-specific message text, or the debug overlay rendering
each state. Mark such a line with `// activity-state-ok: <reason>` (on the line or the line
above). The debug overlay/timeline and the unrelated `BrowserTab` cache-clear state machine are
allowlisted in the test.

## Enforcement (self-maintaining)

- **Compile-time (primary):** the `satisfies Record<ActivityState, ActivityDisposition>` table in
  `src/shared/activity-state.ts` fails `npm run typecheck` (CI) the moment a new `ActivityState`
  variant is added without a disposition. This is the load-bearing guarantee against the bug that
  occurred.
- **Test:** `tests/unit/activity-state-classification.test.ts` scans `src/renderer/**` for inline
  `ActivityState`-literal comparisons and fails on a new hand-rolled bucket check (honoring the
  `// activity-state-ok` marker and the path allowlist). Runs in CI via `npm run test:unit`.
- **Review:** `/code-review` flags inline activity bucketing on renderer changes.

## Scope

Renderer consumers of the idle-vs-active bucket, plus the classifier module itself. The activity
engine's internal state machine (`src/main/activity-engine/**`, `predicate.ts`) PRODUCES
`ActivityState` and is its own source of truth - it is out of scope. Main-process consumers that
ask the same product question (e.g. `task-crud.ts`) should also use the shared helpers, but the
mechanical scan is scoped to the renderer, where the bug class and new UI consumers live.
