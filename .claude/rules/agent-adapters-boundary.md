---
paths:
  - "src/**"
---
# Rule: no agent-specific branching outside `src/main/agent/adapters/`

Per-agent behavior (Claude vs Codex vs Droid vs others) belongs in the adapter for that agent.
Branching on an agent's name elsewhere (`agent === 'droid'`, `agentType === 'codex'`) scatters
agent knowledge across the codebase and breaks the adapter abstraction: adding an agent then
means hunting down conditionals instead of writing one adapter.

## The rule

Never branch on a specific agent's name or id outside `src/main/agent/adapters/`. Instead:

1. Declare a capability or value on the `AgentAdapter` (e.g. `supportsSummarize`, `promptVia`,
   or a method).
2. Surface it through a generic shape (a flag on the agent's config or IPC payload).
3. Have the renderer and IPC read the generic flag, never the agent name.

Example: auto-name support is exposed via the optional `summarize?()` method on `AgentAdapter`;
the renderer gates the button on a generic `supportsSummarize` flag, not on `agent === 'claude'`.

## Enforcement (self-maintaining)

- **Review:** `/code-review`'s always-on conventions finder is seeded with the "no agent-specific
  code outside `adapters/`" criterion, so it flags agent-name (and provider-name) branching outside
  an adapters folder on every review, whatever files changed. The `migration-safety` agent does
  not check this: it is the database migration and schema validator.
- **Test (PR connectors):** `tests/unit/pr-connector-gate.test.ts` runs over the REAL
  `registeredPRConnectors` array and fails a connector that claims another provider's remote, that
  implements `resolveByCommit` without declaring `verifiesCommitOwnership`, or that reports a
  merge-readiness value outside the normalized `PRMergeReadiness` enum (a pasted adapter leaking
  a raw `BLOCKED` or `succeeded` through `ResolvedPR`). It is the mechanical backstop for the PR
  half of this rule. Runs in CI via `npm run test:unit`.
- The agent half has no dedicated mechanical test yet. A scan for agent-name string comparisons
  outside `src/main/agent/adapters/` is a candidate future test; agent and provider names appear
  legitimately in config keys, fixtures, and doc strings, so it is its own job.

## Scope

Agent adapters (`src/main/agent/adapters/`). Two parallel adapter systems follow the same
principle for their own providers: the board adapters (`src/main/boards/adapters/`) and the PR
connectors (`src/main/pr/adapters/`, contract in `src/main/pr/shared/pr-connector.ts`, registry in
`src/main/pr/pr-registry.ts`). For the PR connectors the principle has a concrete shape: each
connector normalizes its own platform's vocabulary (PR state, merge readiness) into the shared
enums inside its adapter, raw platform fields are fetched by the shared board clients but mapped
only in the connector, and the generic layer (`pr-linking.ts`, `pr-refresh.ts`,
`shared/pr-dispatch.ts`, the IPC handlers, the renderer) never branches on a provider and never
sees a raw platform string.
