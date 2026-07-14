/**
 * Unit coverage for the module-scope `hasWarmedStatsDashboard` once-guard in
 * src/renderer/components/stats/LazyStatsDashboard.tsx. `warmStatsDashboard()`
 * (hover-intent prefetch) and `warmStatsDashboardOnIdle()` (idle prefetch,
 * routed through src/renderer/utils/on-idle.ts) both gate on the same
 * module-scope flag, so repeat calls - including the hover-then-idle race,
 * where the user hovers before the scheduled idle callback fires - collapse
 * into a single underlying `import('./StatsDashboardBody')` attempt.
 *
 * A NAIVE test would spy on a RESOLVING mock of './StatsDashboardBody' and
 * assert its factory ran once. That assertion is trivially true whether or
 * not the guard exists: empirically verified while authoring this file, a
 * successful ES dynamic import is memoized by the module system itself, so a
 * second `import()` of an already-resolved specifier never re-runs the
 * target's top-level code - with or without `hasWarmedStatsDashboard`. Such a
 * test could never go red for the guard being removed, which is exactly the
 * "test that cannot fail" antipattern.
 *
 * The distinguishing lever used below instead: an ES dynamic import job is
 * NOT memoized on REJECTION (also verified empirically here) - Node/V8 retry
 * the target module's factory on every subsequent `import()` of a specifier
 * that previously threw. So mocking './StatsDashboardBody' to throw makes
 * "how many times was import() actually invoked" directly observable as a
 * factory-execution count: the guarded code attempts the import once and
 * never tries again (count stays 1); reverting the guard (making the warm
 * unconditional) makes the SECOND call retry the already-failed import,
 * bumping the count to 2. That is a real, falsifiable red-green signal.
 *
 * `warmStatsDashboard()` fires the import via `void import(...)` with no
 * `.catch`, so triggering a real rejection produces a genuine Node
 * `unhandledRejection` - handled the same way as
 * tests/unit/diff-clipboard.test.ts and tests/unit/task-lifecycle-lock.test.ts:
 * install a listener for the duration of the test so Node does not treat it
 * as unhandled, and assert on what it captured instead of letting it escape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LAZY_MODULE_PATH = '../../src/renderer/components/stats/LazyStatsDashboard';

const hoisted = vi.hoisted(() => ({ factoryRuns: { count: 0 } }));

vi.mock('../../src/renderer/components/stats/StatsDashboardBody', () => {
  hoisted.factoryRuns.count += 1;
  throw new Error(`StatsDashboardBody load failure #${hoisted.factoryRuns.count} (test fixture)`);
});

/** Give the current macrotask queue a full turn so any promise rejection
 *  created by a `void import(...)` call has had a chance to surface (and be
 *  caught by the `unhandledRejection` listener) before we assert. */
function flushMicrotasksAndOneTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('LazyStatsDashboard warm once-guard', () => {
  const originalWindow = globalThis.window;
  let unhandledRejections: unknown[];

  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    hoisted.factoryRuns.count = 0;
    unhandledRejections = [];
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
    globalThis.window = originalWindow;
    vi.resetModules();
  });

  it('warmStatsDashboard() called twice attempts the underlying import only once', async () => {
    vi.resetModules();
    const lazyModule = await import(LAZY_MODULE_PATH);

    lazyModule.warmStatsDashboard();
    // Flush BEFORE the second call so the first import attempt has fully
    // rejected first. Two back-to-back calls with no flush in between would
    // both hit the SAME still-pending job (ES module dedup for an in-flight,
    // not-yet-settled specifier applies regardless of the guard), which would
    // make this assertion pass whether or not the guard exists - not a valid
    // red-green signal. Settling first is what makes a reverted guard's
    // retry-on-second-call observable.
    await flushMicrotasksAndOneTick();
    lazyModule.warmStatsDashboard();
    await flushMicrotasksAndOneTick();

    // Reverting the guard (removing the `if (hasWarmedStatsDashboard) return;`
    // early-return so both calls unconditionally call import()) makes this 2:
    // the first attempt rejects and is NOT memoized, so the second call
    // retries the factory instead of short-circuiting.
    expect(hoisted.factoryRuns.count).toBe(1);
    // Exactly one real import attempt was made (and rejected) - not zero.
    expect(unhandledRejections).toHaveLength(1);
  });

  it('a hover warm followed by a later-firing idle warm (the hover-then-idle race) still attempts the import only once', async () => {
    vi.resetModules();
    let capturedIdleCallback: (() => void) | null = null;
    // @ts-expect-error -- minimal window stub carrying only what onIdle reads
    globalThis.window = {
      requestIdleCallback: (callback: () => void) => {
        capturedIdleCallback = callback;
      },
    };
    const lazyModule = await import(LAZY_MODULE_PATH);

    // Idle warm is scheduled first (mirrors AppLayout mount) but does not
    // fire yet - requestIdleCallback only captures the callback here.
    lazyModule.warmStatsDashboardOnIdle();
    expect(capturedIdleCallback).not.toBeNull();
    expect(hoisted.factoryRuns.count).toBe(0);

    // The user hovers before idle fires: this is the real hover-intent path,
    // and it warms synchronously.
    lazyModule.warmStatsDashboard();
    await flushMicrotasksAndOneTick();
    expect(hoisted.factoryRuns.count).toBe(1);

    // Idle now fires later, after the hover already warmed it. The guard
    // must make this a genuine no-op: no second import attempt.
    capturedIdleCallback!();
    await flushMicrotasksAndOneTick();

    // Reverting the guard makes this 2: the idle callback would retry the
    // already-rejected import instead of short-circuiting.
    expect(hoisted.factoryRuns.count).toBe(1);
    expect(unhandledRejections).toHaveLength(1);
  });
});
