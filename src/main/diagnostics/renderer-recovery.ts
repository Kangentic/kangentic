import type { HostMemorySample } from '../../shared/types';

/**
 * DESKTOP-16 bounded-reload guard for the main window's `render-process-gone`
 * handler in `src/main/index.ts`. A machine still starved of commit will
 * kill a freshly reloaded renderer too, so cap how many times one window may
 * self-heal in a rolling window before giving up and telling the user why,
 * rather than spinning forever. Extracted from index.ts (which runs real
 * startup side effects on import and cannot itself be unit-tested) so the
 * decision logic is pure and testable, the same reasoning behind
 * `host-memory.ts`'s pressure evaluator living in its own module.
 */

/** Electron's `render-process-gone` reason union, named once here so the
 *  gate and its tests share one spelling. */
export type RendererDeathReason = Electron.RenderProcessGoneDetails['reason'];

export const RENDERER_RELOAD_WINDOW_MS = 10 * 60_000;
export const RENDERER_RELOAD_MAX = 3;

export interface RendererReloadGate {
  /** True when a reload should be attempted, in which case the attempt is
   *  recorded as a side effect of the call (check-and-consume, matching the
   *  other stateful evaluators in this codebase). False past the bound - the
   *  caller should stop reloading and explain instead. `now` is injectable
   *  for tests. */
  tryReload: (now?: number) => boolean;
}

export function createRendererReloadGate(): RendererReloadGate {
  let timestamps: number[] = [];
  return {
    tryReload: (now = Date.now()) => {
      timestamps = timestamps.filter((timestamp) => now - timestamp < RENDERER_RELOAD_WINDOW_MS);
      if (timestamps.length >= RENDERER_RELOAD_MAX) return false;
      timestamps.push(now);
      return true;
    },
  };
}

/**
 * True for the two `render-process-gone` reasons worth trying to recover
 * from. Never `'clean-exit'` or `'killed'`: those are (or closely resemble)
 * our own intentional actions, and reloading in response would fight
 * whatever caused them rather than recover from a genuine crash.
 *
 * Typed against Electron's own reason union rather than `string`, so a typo
 * in a literal below is a compile error and a reason added by an Electron
 * upgrade is visible here rather than silently falling through to false.
 */
export function isRecoverableRendererDeath(reason: RendererDeathReason): boolean {
  return reason === 'oom' || reason === 'crashed';
}

/** One line for the give-up dialog naming the last known commit headroom, or
 *  null when there is no sample yet or the platform has no commit reading -
 *  in which case the caller omits the line entirely rather than printing a
 *  confusing "unknown". */
export function formatHostMemoryDetailLine(sample: HostMemorySample | null): string | null {
  if (!sample || sample.commitRemainingBytes === null) return null;
  const remainingMb = Math.round(sample.commitRemainingBytes / (1024 * 1024));
  return `Free system memory (commit) at the time: ${remainingMb} MB.`;
}
