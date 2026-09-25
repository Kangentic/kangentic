/**
 * Late-bound session-store handlers for project lifecycle events.
 *
 * `project-store` has to tell the session store when a project is deleted or
 * opened. Importing the session store to do it closes an import CYCLE, because
 * `session-store` imports `project-store` for the current project id (see
 * `.claude/rules/project-scoped-ipc.md` - every renderer-driven mutation stamps
 * it). Both sides only ever call `getState()`, so the cycle is harmless at
 * runtime, and it stood for a long time without anyone noticing.
 *
 * It is not harmless in dev. When `project-store`'s Pattern E self-accept runs
 * `import.meta.hot.invalidate()`, Vite finds the cycle and gives up on a hot
 * update:
 *
 *     page reload src/renderer/stores/project-store.ts (circular import invalidate)
 *
 * A full page reload destroys every live Browser pane `<webview>` guest (and
 * every `import.meta.hot.data` pin), so saving an unrelated store slice reset an
 * agent's browser mid-task. Routing these two calls through this module removes
 * the only cycle in the renderer store graph, so the same edit hot-updates
 * instead. Verified with `scripts/hmr-guest-probe.mjs`.
 *
 * `session-store` registers its handlers at module init; `project-store` imports
 * only this module. The `session-store` -> `project-store` edge stays (it still
 * reads the current project id), but it is now one-directional, which is what
 * removes the cycle - not the absence of both imports.
 */

interface SessionLifecycleHooks {
  /** Tear down the project's Command Terminal (transient) PTYs. */
  killTransientSessionForProject: (projectId: string) => Promise<void>;
  /** Clear the project's unseen-idle badges now that the user is looking at it. */
  markIdleSessionsSeen: (projectId: string) => void;
}

// The directive has to sit on the line DIRECTLY above the declaration: the
// hmr-resync test only scans the same line and the one before it. It is inert
// while the initializer is `null` (a trivial initializer short-circuits that
// check), and becomes load-bearing the moment someone seeds a default here.
// hmr-safe: re-registered on every session-store module evaluation, so a reset here is refilled by the same update that cleared it.
let registeredHooks: SessionLifecycleHooks | null = null;

/** Called once by session-store at module init. */
export function registerSessionLifecycleHooks(hooks: SessionLifecycleHooks): void {
  registeredHooks = hooks;
}

/**
 * Fire-and-forget, matching the original call sites: a project is going away, and
 * a failure to reap its terminals must not block the delete or the switch.
 */
export function killTransientSessionForProject(projectId: string): void {
  registeredHooks?.killTransientSessionForProject(projectId).catch(() => {});
}

export function markIdleSessionsSeen(projectId: string): void {
  registeredHooks?.markIdleSessionsSeen(projectId);
}
