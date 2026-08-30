---
paths:
  - "src/renderer/**"
---
# Rule: HMR dev-mode parity (patterns A-E)

The team dogfoods Kangentic from `npm start` daily, so a Vite Fast Refresh during a real
session must be visually and behaviourally indistinguishable from a fresh production boot. Five
primitives cover every HMR-sensitive surface; mixing them up causes flaky behavior that only
surfaces in dev, the exact failure mode this project cannot tolerate. Pick the right pattern up
front rather than reaching for ad-hoc fixes later.

## The rule

| Pattern | When to reach for it | How to apply | Example sites |
|---|---|---|---|
| **A. Preserve** | Module-scope state (timers, AbortControllers, caches, counters, scroll positions) that must survive a reload | `let x = import.meta.hot?.data?.x ?? <default>;` plus `import.meta.hot?.dispose((d) => { d.x = x; })` | `task-slice.ts` (`moveGenerations`), `session-store.ts` (`syncController`, transient sessions), `useTerminal.ts` (`savedScrollPositions`), `toast-store.ts`, `hmr-generation.ts`, `auto-name-scheduler.ts` |
| **B. Re-sync** | Zustand stores whose truth lives in the main process (IPC-backed) | Add a `load*` / `sync*` call to the `vite:afterUpdate` handler in `App.tsx` | `loadBoard()`, `loadBacklog()`, `loadConfig()`, `loadProjects()`, `syncSessions()` |
| **C. Re-key remount** | Stateful third-party React subtrees whose subscriptions go stale across Fast Refresh (every `<DndContext>`) | `const hmrGeneration = useHmrGeneration();` then `<DndContext key={hmrGeneration}>` | All 5 `<DndContext>` sites: `KanbanBoard`, `BacklogView`, `PrioritiesPopover`, `ProjectSidebar`, `ShortcutsTab` |
| **D. Cleanup** | Imperative DOM or global state no React component owns | Add the clear to the top of the `vite:afterUpdate` handler | `.drop-highlight` class removal in `App.tsx` |
| **E. Pin instance** | A Zustand store whose only runtime export is the non-component hook, so the module is not a Fast Refresh boundary and a re-eval can hand a SECOND store to part of the tree | `const make = () => create<T>(init); export const useX = import.meta.hot?.data?.x ?? make();` plus `import.meta.hot.data.x = useX; import.meta.hot.accept(() => import.meta.hot.invalidate())` | `board-store.ts`, `backlog-store.ts`, `announcements-store.ts`, and the rest of `PATTERN_E_STORES` in `tests/unit/hmr-resync.test.ts` (the authoritative list) |

**Decision tree:**

1. New IPC-backed Zustand store, or a new `load*` / `sync*` method on an existing one? Pattern
   B: add a call in `App.tsx`'s `vite:afterUpdate` handler.
2. Is that store's only runtime export the non-component hook (`export const useXStore =
   create(...)`, no component exports)? Then the module is not a Fast Refresh boundary, so a
   re-eval (a slice edit, or an edit to a store it imports) can construct a second instance while
   the mounted view stays subscribed to the first. Pattern E: pin the instance via
   `import.meta.hot.data` and self-accept with `accept(() => invalidate())`. Pair with Pattern B.

   **The self-accept is unsafe inside an import CYCLE.** Vite answers an `invalidate()` raised
   from a module that participates in a cycle by abandoning the hot update:

   ```
   page reload src/renderer/stores/project-store.ts (circular import invalidate)
   ```

   A full page reload destroys every live Browser pane `<webview>` guest AND every
   `import.meta.hot.data` pin, so it is strictly worse than the stale closures the self-accept
   exists to prevent. Two stores hit this. `project-store` <-> `session-store` was broken outright
   (`stores/session-lifecycle-hooks.ts` late-binds the two session actions project-store needed, so
   neither imports the other) and is now guarded by
   `tests/unit/renderer-store-import-cycles.test.ts`. `session-store` sits in a SECOND cycle that
   cannot be designed away - it needs the arrival-focus arbiter, which needs to know which terminal
   the user is looking at, which needs session state - so it PINS WITHOUT SELF-ACCEPTING, and says
   so at the pin. Prefer breaking the cycle; drop the self-accept only when the cycle is intrinsic,
   and write down which one it is.
3. New `<DndContext>` or other React component wrapping a third-party library with internal
   subscription state? Pattern C: pair it with `useHmrGeneration()` and `key={hmrGeneration}`.
4. New module-scope `let` / `const` mutable state (Maps, Sets, AbortControllers, counters) under
   `src/renderer/stores/` or `src/renderer/utils/`? Pattern A: preserve via
   `import.meta.hot.data`, or annotate the declaration with `// hmr-safe: <reason>` if
   reset-on-HMR is intentional.
5. Imperatively setting a class, attribute, or global handle React will not tear down? Pattern
   D: add the clear to the `vite:afterUpdate` handler.

**Anti-patterns:** do not combine A and C on the same state; do not add an undocumented ad-hoc HMR
workaround (surface the gap and extend this catalog deliberately); do not gate Pattern A behind
`process.env.NODE_ENV` (`import.meta.hot` is `undefined` in production builds, so the guards
already collapse to no-ops).

## Enforcement (self-maintaining)

- **Test:** `tests/unit/hmr-resync.test.ts` enforces four things: every IPC-backed store's
  `load*` / `sync*` is called in `App.tsx`'s `vite:afterUpdate` (B); every module-scope mutable
  declaration under the watched dirs has `import.meta.hot.dispose(` or a `// hmr-safe:` opt-out
  (A); every `<DndContext>` has `key={hmrGeneration}` (C); and each instance-pinned store
  (the test's `PATTERN_E_STORES` array - extend it whenever a store adopts the pin) reads and
  writes its instance in `import.meta.hot.data` and self-accepts (E). Runs in CI via
  `npm run test:unit`.
- **Test (cycles):** `tests/unit/renderer-store-import-cycles.test.ts` fails on any value-import
  cycle under `src/renderer/stores/**`, naming the loop. This is the mechanical guard for the
  circular-import reload above; it follows value imports only, since `import type` is erased and
  cannot create a runtime edge. Runs in CI via `npm run test:unit`.
- **Review:** the `hmr-parity` agent audits all five patterns; `hmr-integrity` is the narrow
  Pattern B store-registration check.

- **Test (hook-shaped locals):** `tests/unit/hook-shaped-locals.test.ts` fails on any INDENTED
  `const`/`let` whose name starts with `use` + an uppercase letter, under `src/renderer/**`.
  react-refresh's Babel transform reads such a call as a custom hook, cannot put a local binding
  in the component's refresh signature, and falls back to `forceReset: true` - so React REMOUNTS
  the component on every Fast Refresh of its module instead of preserving state. Five window-manager
  components had `const useStore = useLayerStore()`, which is why every task-detail window was
  rebuilt (and every live pane guest destroyed) whenever anything in its import chain refreshed,
  with no page reload and no bailout to point at. Opt out per line with `// hook-local-ok: <reason>`.
  Runs in CI via `npm run test:unit`.

**The `use` prefix is load-bearing on locals, not stylistic.** This is the third and subtlest of the
three ways a dev-mode save killed a Browser pane guest, and the only one with no visible symptom in
the HMR log at all - the pane simply came back as a new element. Bisecting it needed the probe:
editing `AppLayout.tsx` did NOT remount (the memoized frame skipped the render entirely), editing
`WindowFrame.tsx` did, and renaming one local fixed it.

## Scope

Renderer code under `src/renderer/`. Main-process state is not subject to HMR (esbuild does not
Fast-Refresh the main process).

`config-store.ts` shares Pattern E's shape (its only runtime export is the non-component hook) and
is a candidate for the same instance pinning; it currently relies on Pattern B re-sync. Extend the
Pattern E test's store list when pinning it.

`session-store.ts` IS pinned, and is the one store that pins without self-accepting (see the
decision tree's step 2). It also keeps its Pattern A dispose stash: the pin means the initializer
does not re-run on a Fast Refresh, so the stash covers only the transition with no pinned instance
to inherit (the first HMR after a cold boot or a full reload), plus `syncController`, which is
module state and has no instance to ride.

## Measuring it

Do not reason about whether an HMR change preserves a live Browser pane - measure:

```
node scripts/hmr-guest-probe.mjs
```

It boots a headless Vite dev server on the real renderer config, mounts a task's Browser pane
against the UI-tier mock, registers a guest, hides it (the held state), makes a comment-only edit
to a target file, and reports whether the page reloaded, whether the guest's `webContentsId`
survived, whether the pane REMOUNTED (a new element, which a DOM-presence check cannot see), and
Vite's own reload reason. It exits non-zero when the guest dies. `--file <path>` targets a
different module, which is how a remount is bisected to the module that causes it.

Two traps it exists to avoid. Vite's reload reason prints only to the DEV SERVER terminal, so a
`/preview` session cannot show it; the probe captures it with a `customLogger`. And
`vite.config.mts` ignores the RELATIVE glob `**/.kangentic/**`, so in a worktree checkout (which
lives at `<repo>/.kangentic/worktrees/<n>`) that glob swallows the whole source tree and the
watcher never fires - the probe uses `scripts/dev.js`'s absolute-path ignores instead, which is
also what the dogfooded `npm start` runs.
