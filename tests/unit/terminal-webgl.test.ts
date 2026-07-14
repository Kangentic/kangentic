/**
 * Unit tests for `src/renderer/utils/terminal-webgl.ts`.
 *
 * The WebGL renderer recovers from context loss by retrying re-initialization
 * with a backoff, then permanently falling back to the DOM renderer. These tests
 * inject a fake addon factory (capturing `onContextLoss`) and a fake terminal so
 * the retry state machine can be driven deterministically with fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  attachWebglRenderer,
  getTerminalRendererReport,
  applyWebglAttachmentPlan,
  onWebglAttachmentsChanged,
} from '../../src/renderer/utils/terminal-webgl';

interface FakeAddon {
  lossHandlers: Array<() => void>;
  disposed: boolean;
  onContextLoss(handler: () => void): void;
  dispose(): void;
  triggerLoss(): void;
}

function makeFakeAddon(): FakeAddon {
  const addon: FakeAddon = {
    lossHandlers: [],
    disposed: false,
    onContextLoss(handler: () => void) { addon.lossHandlers.push(handler); },
    dispose() { addon.disposed = true; },
    triggerLoss() { for (const handler of addon.lossHandlers) handler(); },
  };
  return addon;
}

/**
 * Builds a `createAddon` factory whose per-call behavior is scripted by `modes`
 * (one entry per call, 'ok' or 'throw'; calls past the end of the array default
 * to 'ok'). Only successful calls push a `FakeAddon` onto the returned `addons`
 * array, so `addons[n]` always lines up with the n-th SUCCESSFUL attach.
 */
function makeAddonFactory(modes: Array<'ok' | 'throw'>): { createAddon: () => FakeAddon; addons: FakeAddon[] } {
  const addons: FakeAddon[] = [];
  let callIndex = 0;
  const createAddon = (): FakeAddon => {
    const mode = modes[callIndex] ?? 'ok';
    callIndex += 1;
    if (mode === 'throw') {
      throw new Error('WebGL re-init failed');
    }
    const addon = makeFakeAddon();
    addons.push(addon);
    return addon;
  };
  return { createAddon, addons };
}

const fakeTerminal = { loadAddon: vi.fn() } as unknown as Terminal;
const RETRY_DELAYS = [2_000, 10_000];

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  warnSpy.mockRestore();
});

describe('attachWebglRenderer', () => {
  it('reports the webgl renderer on a successful attach', () => {
    const dispose = attachWebglRenderer(fakeTerminal, 'k-attach', {
      createAddon: makeFakeAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(getTerminalRendererReport()['k-attach'].renderer).toBe('webgl');
    expect(getTerminalRendererReport()['k-attach'].contextLossCount).toBe(0);
    dispose();
    expect(getTerminalRendererReport()['k-attach']).toBeUndefined();
  });

  it('falls back to DOM on context loss then recovers after the first backoff', () => {
    const addons: FakeAddon[] = [];
    const dispose = attachWebglRenderer(fakeTerminal, 'k-recover', {
      createAddon: () => { const addon = makeFakeAddon(); addons.push(addon); return addon; },
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    const afterLoss = getTerminalRendererReport()['k-recover'];
    expect(afterLoss.renderer).toBe('dom');
    expect(afterLoss.contextLossCount).toBe(1);
    expect(afterLoss.permanentDomFallback).toBe(false);
    expect(addons[0].disposed).toBe(true);

    // Re-init is scheduled for +2000ms; nothing before then.
    vi.advanceTimersByTime(1_999);
    expect(getTerminalRendererReport()['k-recover'].renderer).toBe('dom');
    vi.advanceTimersByTime(1);
    expect(getTerminalRendererReport()['k-recover'].renderer).toBe('webgl');
    expect(addons).toHaveLength(2);
    dispose();
  });

  it('uses the second, longer backoff for a second loss', () => {
    const addons: FakeAddon[] = [];
    const dispose = attachWebglRenderer(fakeTerminal, 'k-second', {
      createAddon: () => { const addon = makeFakeAddon(); addons.push(addon); return addon; },
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    vi.advanceTimersByTime(2_000); // recovered on addon[1]
    expect(getTerminalRendererReport()['k-second'].renderer).toBe('webgl');

    addons[1].triggerLoss();
    expect(getTerminalRendererReport()['k-second'].contextLossCount).toBe(2);
    // Second backoff is 10s: not recovered at 2s...
    vi.advanceTimersByTime(2_000);
    expect(getTerminalRendererReport()['k-second'].renderer).toBe('dom');
    // ...recovered at 10s total.
    vi.advanceTimersByTime(8_000);
    expect(getTerminalRendererReport()['k-second'].renderer).toBe('webgl');
    expect(addons).toHaveLength(3);
    dispose();
  });

  it('gives up permanently after the retries are exhausted', () => {
    const addons: FakeAddon[] = [];
    const dispose = attachWebglRenderer(fakeTerminal, 'k-permanent', {
      createAddon: () => { const addon = makeFakeAddon(); addons.push(addon); return addon; },
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    vi.advanceTimersByTime(2_000);
    addons[1].triggerLoss();
    vi.advanceTimersByTime(10_000);
    // Third loss exceeds the 2 retry slots -> permanent DOM, no timer armed.
    addons[2].triggerLoss();
    const status = getTerminalRendererReport()['k-permanent'];
    expect(status.renderer).toBe('dom');
    expect(status.contextLossCount).toBe(3);
    expect(status.permanentDomFallback).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('advances to the next backoff slot when a scheduled retry itself fails, and only sets permanentDomFallback once slots are exhausted', () => {
    // Initial attach succeeds; the FIRST scheduled retry (after the loss) throws;
    // the SECOND scheduled retry also throws. A failed non-final retry must not
    // set permanentDomFallback and must arm the next backoff slot instead of
    // leaving the terminal stuck on DOM with no further retry scheduled.
    const { createAddon, addons } = makeAddonFactory(['ok', 'throw', 'throw']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-retry-fail', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(getTerminalRendererReport()['k-retry-fail'].renderer).toBe('webgl');

    addons[0].triggerLoss();
    expect(getTerminalRendererReport()['k-retry-fail'].contextLossCount).toBe(1);

    // First scheduled retry (at +2000ms) itself throws inside tryAttach.
    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    const afterFirstRetryFailure = getTerminalRendererReport()['k-retry-fail'];
    expect(afterFirstRetryFailure.renderer).toBe('dom');
    expect(afterFirstRetryFailure.permanentDomFallback).toBe(false);
    // Not the final slot yet: the next backoff must be armed.
    expect(vi.getTimerCount()).toBe(1);

    // Second (final) scheduled retry also throws: slots exhausted -> permanent.
    vi.advanceTimersByTime(RETRY_DELAYS[1]);
    const afterSecondRetryFailure = getTerminalRendererReport()['k-retry-fail'];
    expect(afterSecondRetryFailure.renderer).toBe('dom');
    expect(afterSecondRetryFailure.permanentDomFallback).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    dispose();
  });

  it('recovers if the next backoff slot succeeds after an earlier scheduled retry failed', () => {
    const { createAddon, addons } = makeAddonFactory(['ok', 'throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-retry-recover', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    // First scheduled retry throws; must advance to the next slot rather than
    // giving up.
    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    expect(getTerminalRendererReport()['k-retry-recover'].permanentDomFallback).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    // Second scheduled retry succeeds.
    vi.advanceTimersByTime(RETRY_DELAYS[1]);
    const status = getTerminalRendererReport()['k-retry-recover'];
    expect(status.renderer).toBe('webgl');
    expect(status.permanentDomFallback).toBe(false);
    expect(addons).toHaveLength(2); // initial attach + the recovered retry

    dispose();
  });

  it('records a permanent DOM fallback when WebGL construction throws', () => {
    const dispose = attachWebglRenderer(fakeTerminal, 'k-unavailable', {
      createAddon: () => { throw new Error('WebGL unavailable'); },
      retryDelaysMs: RETRY_DELAYS,
    });
    const status = getTerminalRendererReport()['k-unavailable'];
    expect(status.renderer).toBe('dom');
    expect(status.permanentDomFallback).toBe(true);
    expect(status.contextLossCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('dispose cancels a pending retry and drops the report entry', () => {
    const addons: FakeAddon[] = [];
    const dispose = attachWebglRenderer(fakeTerminal, 'k-dispose', {
      createAddon: () => { const addon = makeFakeAddon(); addons.push(addon); return addon; },
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss(); // schedules a retry at +2000ms
    expect(vi.getTimerCount()).toBe(1);

    dispose();
    expect(vi.getTimerCount()).toBe(0); // retry cancelled
    expect(getTerminalRendererReport()['k-dispose']).toBeUndefined();

    // Advancing past the would-be retry does nothing (no new addon).
    vi.advanceTimersByTime(10_000);
    expect(addons).toHaveLength(1);
  });
});

describe('budget suspend/resume', () => {
  const emptyPlan = { attachKeys: new Set<string>(), suspendKeys: new Set<string>() };
  const suspendPlan = (...keys: string[]) => ({ ...emptyPlan, suspendKeys: new Set(keys) });
  const attachPlan = (...keys: string[]) => ({ ...emptyPlan, attachKeys: new Set(keys) });

  it('suspend keeps the status entry and never counts as a context loss', () => {
    const { createAddon, addons } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-suspend', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(getTerminalRendererReport()['k-suspend'].renderer).toBe('webgl');

    applyWebglAttachmentPlan(suspendPlan('k-suspend'));
    const status = getTerminalRendererReport()['k-suspend'];
    expect(status.renderer).toBe('dom');
    expect(status.suspendedByBudget).toBe(true);
    expect(status.contextLossCount).toBe(0);
    expect(status.permanentDomFallback).toBe(false);
    expect(addons[0].disposed).toBe(true);
    dispose();
  });

  it('suspend cancels a pending context-loss retry so it cannot fire while suspended', () => {
    const { createAddon, addons } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-suspend-retry', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss(); // arms the +2000ms retry
    expect(vi.getTimerCount()).toBe(1);

    applyWebglAttachmentPlan(suspendPlan('k-suspend-retry'));
    expect(vi.getTimerCount()).toBe(0);

    // Advancing past every backoff slot re-attaches nothing.
    vi.advanceTimersByTime(20_000);
    expect(addons).toHaveLength(1);
    const status = getTerminalRendererReport()['k-suspend-retry'];
    expect(status.renderer).toBe('dom');
    expect(status.suspendedByBudget).toBe(true);
    expect(status.permanentDomFallback).toBe(false);
    dispose();
  });

  it('ignores a loss event that fires after a suspend', () => {
    const { createAddon, addons } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-late-loss', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    applyWebglAttachmentPlan(suspendPlan('k-late-loss'));
    addons[0].triggerLoss(); // stray loss from the already-disposed addon

    const status = getTerminalRendererReport()['k-late-loss'];
    expect(status.contextLossCount).toBe(0);
    expect(status.permanentDomFallback).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('resume re-attaches a suspended terminal', () => {
    const { createAddon, addons } = makeAddonFactory(['ok', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-resume', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    applyWebglAttachmentPlan(suspendPlan('k-resume'));
    applyWebglAttachmentPlan(attachPlan('k-resume'));

    const status = getTerminalRendererReport()['k-resume'];
    expect(status.renderer).toBe('webgl');
    expect(status.suspendedByBudget).toBe(false);
    expect(addons).toHaveLength(2);
    dispose();
  });

  it('a failed resume stays budget-suspended without escalating, and a later resume recovers', () => {
    const { createAddon, addons } = makeAddonFactory(['ok', 'throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-resume-fail', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    applyWebglAttachmentPlan(suspendPlan('k-resume-fail'));
    applyWebglAttachmentPlan(attachPlan('k-resume-fail')); // tryAttach throws

    const afterFailure = getTerminalRendererReport()['k-resume-fail'];
    expect(afterFailure.renderer).toBe('dom');
    expect(afterFailure.suspendedByBudget).toBe(true);
    expect(afterFailure.permanentDomFallback).toBe(false);
    expect(afterFailure.contextLossCount).toBe(0);
    // No retry ladder armed: the coordinator's next plan application retries.
    expect(vi.getTimerCount()).toBe(0);

    applyWebglAttachmentPlan(attachPlan('k-resume-fail')); // succeeds
    const afterRecovery = getTerminalRendererReport()['k-resume-fail'];
    expect(afterRecovery.renderer).toBe('webgl');
    expect(afterRecovery.suspendedByBudget).toBe(false);
    expect(addons).toHaveLength(2);
    dispose();
  });

  it('suspend and resume are no-ops for a permanently-DOM terminal', () => {
    const dispose = attachWebglRenderer(fakeTerminal, 'k-permanent-plan', {
      createAddon: () => { throw new Error('WebGL unavailable'); },
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(getTerminalRendererReport()['k-permanent-plan'].permanentDomFallback).toBe(true);

    applyWebglAttachmentPlan(suspendPlan('k-permanent-plan'));
    expect(getTerminalRendererReport()['k-permanent-plan'].suspendedByBudget).toBe(false);

    applyWebglAttachmentPlan(attachPlan('k-permanent-plan'));
    const status = getTerminalRendererReport()['k-permanent-plan'];
    expect(status.renderer).toBe('dom');
    expect(status.permanentDomFallback).toBe(true);
    dispose();
  });

  it('an over-budget initial attach starts suspended without requesting a context', () => {
    const first = makeAddonFactory(['ok']);
    const disposeFirst = attachWebglRenderer(fakeTerminal, 'k-cap-1', {
      createAddon: first.createAddon,
      retryDelaysMs: RETRY_DELAYS,
      attachBudget: 1,
    });
    expect(getTerminalRendererReport()['k-cap-1'].renderer).toBe('webgl');

    const secondFactory = vi.fn(makeFakeAddon);
    const disposeSecond = attachWebglRenderer(fakeTerminal, 'k-cap-2', {
      createAddon: secondFactory,
      retryDelaysMs: RETRY_DELAYS,
      attachBudget: 1,
    });

    const status = getTerminalRendererReport()['k-cap-2'];
    expect(status.renderer).toBe('dom');
    expect(status.suspendedByBudget).toBe(true);
    expect(status.permanentDomFallback).toBe(false);
    expect(secondFactory).not.toHaveBeenCalled();

    disposeFirst();
    disposeSecond();
  });

  it('applies suspends before resumes so the live count never overshoots the cap', () => {
    const first = makeAddonFactory(['ok']);
    const disposeFirst = attachWebglRenderer(fakeTerminal, 'k-swap-1', {
      createAddon: first.createAddon,
      retryDelaysMs: RETRY_DELAYS,
      attachBudget: 1,
    });
    // Second starts suspended (over the cap of 1); its factory records whether
    // the first addon was already freed when the resume acquires.
    const secondAddons: FakeAddon[] = [];
    let firstFreedAtAcquire = false;
    const disposeSecond = attachWebglRenderer(fakeTerminal, 'k-swap-2', {
      createAddon: () => {
        firstFreedAtAcquire = first.addons[0].disposed;
        const addon = makeFakeAddon();
        secondAddons.push(addon);
        return addon;
      },
      retryDelaysMs: RETRY_DELAYS,
      attachBudget: 1,
    });
    expect(getTerminalRendererReport()['k-swap-2'].suspendedByBudget).toBe(true);

    applyWebglAttachmentPlan({ attachKeys: new Set(['k-swap-2']), suspendKeys: new Set(['k-swap-1']) });

    expect(getTerminalRendererReport()['k-swap-1'].renderer).toBe('dom');
    expect(getTerminalRendererReport()['k-swap-1'].suspendedByBudget).toBe(true);
    expect(getTerminalRendererReport()['k-swap-2'].renderer).toBe('webgl');
    expect(secondAddons).toHaveLength(1);
    expect(firstFreedAtAcquire).toBe(true);

    disposeFirst();
    disposeSecond();
  });

  it('leaves keys the plan does not name untouched', () => {
    const { createAddon } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-unnamed', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    applyWebglAttachmentPlan(suspendPlan('k-some-other-key'));
    expect(getTerminalRendererReport()['k-unnamed'].renderer).toBe('webgl');
    expect(getTerminalRendererReport()['k-unnamed'].suspendedByBudget).toBe(false);
    dispose();
  });

  it('notifies attachment listeners on register and dispose, and unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = onWebglAttachmentsChanged(listener);

    const { createAddon } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-notify', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    const { createAddon: createAgain } = makeAddonFactory(['ok']);
    const disposeAgain = attachWebglRenderer(fakeTerminal, 'k-notify-2', {
      createAddon: createAgain,
      retryDelaysMs: RETRY_DELAYS,
    });
    disposeAgain();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('resume on an already-attached terminal is a no-op (does not rebuild the live WebGL context)', () => {
    const { createAddon, addons } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-resume-noop', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(getTerminalRendererReport()['k-resume-noop'].renderer).toBe('webgl');
    expect(addons).toHaveLength(1);

    // The coordinator re-applies its plan on every run, so attachKeys usually
    // still names terminals that are already live. Resuming an already-attached
    // terminal must NOT dispose and rebuild its addon (the common hot path).
    applyWebglAttachmentPlan(attachPlan('k-resume-noop'));
    applyWebglAttachmentPlan(attachPlan('k-resume-noop'));

    expect(getTerminalRendererReport()['k-resume-noop'].renderer).toBe('webgl');
    expect(addons).toHaveLength(1);
    expect(addons[0].disposed).toBe(false);
    dispose();
  });
});
