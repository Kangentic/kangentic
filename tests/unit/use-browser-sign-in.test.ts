/**
 * Unit coverage for the waiting half of a Connect dialog's browser sign-in
 * (src/renderer/components/backlog/connect/useBrowserSignIn.ts).
 *
 * The contract the Jira, Trello and Linear dialogs lean on:
 *
 *   - An unmount while a sign-in waits sends exactly one cancelSignIn, so main frees
 *     the port and timer. An unmount with nothing pending sends none.
 *   - `{ ok: true }` reports `saved` while mounted (even after cancel() moved past
 *     the attempt) and `stale` once unmounted, so a closed dialog never carries on.
 *   - A failure or cancel answer from an attempt that was moved past reports `stale`.
 *   - cancel() sends cancelSignIn only while a sign-in waits, and only once.
 *   - A rejected start reports the decorated message cleaned up, and reports the failure.
 *
 * The vitest config has no DOM environment and no @testing-library/react, so this
 * follows use-now.test.ts: `react` is mocked with a small harness that keeps useRef
 * slots and runs useEffect the way React does (after the render, cleanup first, only
 * when the deps changed). `window.electronAPI` is a stub on globalThis.
 *
 * Red-green: drop the cleanup's `if (!pendingRef.current) return;` and the
 * "nothing pending" unmount case fails; make the `saved` line always `saved` and
 * the unmounted-success case fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => ({
  refSlots: [] as Array<{ current: unknown }>,
  refIndex: 0,
  effects: [] as Array<{ deps: readonly unknown[] | undefined; cleanup: unknown }>,
  effectIndex: 0,
  queued: [] as Array<() => void>,
}));

const reportRendererFailure = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/utils/renderer-failure', () => ({ reportRendererFailure }));

function sameDeps(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (!previous || !next || previous.length !== next.length) return false;
  return next.every((dependency, index) => Object.is(dependency, previous[index]));
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const withHarnessHooks = {
    ...actual,
    useRef: <Value,>(initial: Value) => {
      const slot = harness.refIndex++;
      if (!(slot in harness.refSlots)) harness.refSlots[slot] = { current: initial };
      return harness.refSlots[slot] as { current: Value };
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const slot = harness.effectIndex++;
      const previous = harness.effects[slot];
      if (previous && sameDeps(previous.deps, deps)) return;
      harness.queued.push(() => {
        if (typeof previous?.cleanup === 'function') previous.cleanup();
        harness.effects[slot] = { deps, cleanup: effect() };
      });
    },
  };
  return { ...withHarnessHooks, default: withHarnessHooks };
});

import { useBrowserSignIn } from '../../src/renderer/components/backlog/connect/useBrowserSignIn';
import type { BrowserSignInAnswer } from '../../src/renderer/components/backlog/connect/useBrowserSignIn';

const cancelSignIn = vi.fn();
const reopenSignIn = vi.fn();

/** One render of the hook, then its queued effects. */
function renderSignIn() {
  harness.refIndex = 0;
  harness.effectIndex = 0;
  harness.queued = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the harness stands in for React's renderer: `react` is mocked, so this call is the render
  const result = useBrowserSignIn('jira');
  for (const run of harness.queued) run();
  return result;
}

/** Run every effect's cleanup, as React does when the component unmounts. */
function unmount(): void {
  for (const effect of harness.effects) {
    if (typeof effect?.cleanup === 'function') effect.cleanup();
  }
  harness.effects = [];
}

/** A start whose answer the test delivers by hand. */
function deferredStart() {
  let resolve!: (answer: BrowserSignInAnswer) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<BrowserSignInAnswer>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { start: () => promise, resolve, reject };
}

describe('useBrowserSignIn', () => {
  beforeEach(() => {
    harness.refSlots = [];
    harness.effects = [];
    harness.queued = [];
    cancelSignIn.mockReset().mockResolvedValue(undefined);
    reopenSignIn.mockReset().mockResolvedValue(undefined);
    reportRendererFailure.mockReset();
    (globalThis as unknown as { window: unknown }).window = {
      electronAPI: { backlog: { jira: { cancelSignIn, reopenSignIn } } },
    };
  });

  describe('unmount', () => {
    it('sends exactly one cancelSignIn when a sign-in is still waiting', () => {
      const { run } = renderSignIn();
      void run(() => new Promise<BrowserSignInAnswer>(() => {}));

      unmount();

      expect(cancelSignIn).toHaveBeenCalledTimes(1);
    });

    it('sends no cancelSignIn when nothing is pending', () => {
      renderSignIn();

      unmount();

      expect(cancelSignIn).not.toHaveBeenCalled();
    });
  });

  describe('a successful answer', () => {
    it('reports stale when it lands after the hook unmounted', async () => {
      const { run } = renderSignIn();
      const signIn = deferredStart();
      const outcome = run(signIn.start);

      unmount();
      signIn.resolve({ ok: true });

      await expect(outcome).resolves.toEqual({ kind: 'stale' });
    });

    it('reports saved while mounted, even after cancel() moved past the attempt', async () => {
      const { run, cancel } = renderSignIn();
      const signIn = deferredStart();
      const outcome = run(signIn.start);

      cancel();
      signIn.resolve({ ok: true });

      await expect(outcome).resolves.toEqual({ kind: 'saved' });
    });
  });

  describe('a failure or cancel answer', () => {
    it('reports stale for an attempt cancel() moved past', async () => {
      const { run, cancel } = renderSignIn();
      const failing = deferredStart();
      const failedOutcome = run(failing.start);
      cancel();
      failing.resolve({ ok: false, cancelled: false, error: 'x' });
      await expect(failedOutcome).resolves.toEqual({ kind: 'stale' });

      const cancelling = deferredStart();
      const cancelledOutcome = run(cancelling.start);
      cancel();
      cancelling.resolve({ ok: false, cancelled: true });
      await expect(cancelledOutcome).resolves.toEqual({ kind: 'stale' });
    });

    it('reports stale for an attempt a newer run moved past', async () => {
      const { run } = renderSignIn();
      const first = deferredStart();
      const firstOutcome = run(first.start);
      const second = deferredStart();
      const secondOutcome = run(second.start);

      first.resolve({ ok: false, cancelled: false, error: 'x' });
      second.resolve({ ok: false, cancelled: false, error: 'y' });

      await expect(firstOutcome).resolves.toEqual({ kind: 'stale' });
      await expect(secondOutcome).resolves.toEqual({ kind: 'failed', error: 'y' });
    });

    it('reports failed with the error for the current attempt', async () => {
      const { run } = renderSignIn();

      await expect(run(async () => ({ ok: false, cancelled: false, error: 'x' }))).resolves.toEqual({
        kind: 'failed',
        error: 'x',
      });
    });

    it('reports cancelled for the current attempt the user cancelled', async () => {
      const { run } = renderSignIn();

      await expect(run(async () => ({ ok: false, cancelled: true }))).resolves.toEqual({ kind: 'cancelled' });
    });
  });

  describe('cancel()', () => {
    it('sends no cancelSignIn after the sign-in already resolved', async () => {
      const { run, cancel } = renderSignIn();
      await run(async () => ({ ok: true }));

      cancel();

      expect(cancelSignIn).not.toHaveBeenCalled();
    });

    it('sends one cancelSignIn while waiting, and a second cancel() sends no more', () => {
      const { run, cancel } = renderSignIn();
      void run(() => new Promise<BrowserSignInAnswer>(() => {}));

      cancel();
      cancel();

      expect(cancelSignIn).toHaveBeenCalledTimes(1);
    });
  });

  describe('a rejected start', () => {
    it('reports failed with the decorated message cleaned up, and reports the failure', async () => {
      const { run } = renderSignIn();
      const rejection = new Error("Error invoking remote method 'boards:jira:signIn': Error: boom");

      const outcome = await run(() => Promise.reject(rejection));

      expect(outcome).toEqual({ kind: 'failed', error: 'boom' });
      expect(reportRendererFailure).toHaveBeenCalledWith('jira-connect', 'sign-in', rejection);
    });
  });
});
