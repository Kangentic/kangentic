---
paths:
  - "src/main/retrieval/**"
  - "src/main/ipc/handlers/**"
---
# Rule: only the central embedding engine embeds

Embedding inference used to be triggered by lifecycle/navigation events: `startForProject` ran
an inline embed pass on every project open, and turn-boundary live-index, finalize, and a
`getStatus`-polled heal each did the same. Switching back to a project whose active task was
churning embedded the freshly-indexed chunks right at navigation time - a felt hardware spike
(GPU power draw, or a multi-second CPU burn) correlated with the click, not with any real-time
constraint. See the central-background-embedding task for the full history; commit `5eac2f93`
(#352) fixed the *cold-load* spikes this rule's refactor could not (warm-holding the worker) -
this rule is about the *residual*: the legitimate inference cost of embedding itself.

## The rule

`src/main/retrieval/embedder/embed-engine.ts` is the **only** place in the app that:

1. Constructs an `EmbedClient` (`new EmbedClient(...)`).
2. Calls `.embed(...)` on it to embed chunks in bulk.
3. Decides *when* to embed (its own self-paced, duty-cycle-throttled drain loop).

Everywhere else - lifecycle hooks (session finalize, live turn-boundary index, project open),
IPC handlers (`src/main/ipc/handlers/**`), and config-change reconciliation - may only:

- **Index** (a cheap diff-upsert via `ConversationIndexer`) and then call
  `embedEngine.markDirty(projectId)` to flag that project has pending chunks. This must happen
  unconditionally (regardless of whether semantic search is currently enabled) - the engine's own
  gates decide whether to act on it, so a premature "semantic is off" check at the call site would
  permanently drop the flag instead of deferring it.
- **Query** through `retrievalService.getEmbedder(context)` (which delegates to
  `embedEngine.getEmbedder`) for the interactive search / MCP recall path. A live user query
  always takes priority over the background drain in the shared worker (see
  `EmbedWorkerClient.waitForInteractiveIdle()` in `embed-client.ts`).
- **Reconcile** via `retrievalService.reconcileEmbedWorker(context)` (warm-hold gate + dirty
  re-mark on a semantic/model/acceleration change).

A project switch must never perform synchronous embedding work. If you find yourself writing
`await embedPass(...)` or `client.embed(...)` in a lifecycle hook or an IPC handler, that is the
regression this rule exists to catch - route the chunk-producing event through `markDirty`
instead and let the engine's drain loop pick it up in the background.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/central-embedding-engine-boundary.test.ts` statically scans `src/main` and
  fails if `new EmbedClient(` appears outside `embed-engine.ts`, if the deleted `embedPass`/
  `scheduleEmbedHeal` functions ever reappear as a call/declaration, or if any file under
  `src/main/ipc/handlers/**` calls `.embed(` directly. Runs in CI via `npm run test:unit`.
- **Tests:** `tests/unit/embed-engine.test.ts` pins the drain loop's scheduling contract (the
  duty-cycle pacer math, FIFO-within-a-project / round-robin-across-projects draining, and
  crash/transient resume) via the engine's own DI seam (`createEmbedEngine(deps)`).
- **Review:** `/code-review` should flag any new inline embed trigger during a change to
  `src/main/retrieval/**` or `src/main/ipc/handlers/**`.

## Scope

`src/main/retrieval/**` (the retrieval/embedding subsystem) and `src/main/ipc/handlers/**` (the
lifecycle/config call sites that produce chunks or toggle semantic search). Does not cover the
renderer, which only ever reads `MemoryStatus` via `getStatus()` and never triggers embedding
itself.
