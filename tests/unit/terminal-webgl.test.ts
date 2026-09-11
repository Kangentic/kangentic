/**
 * Unit tests for `src/renderer/utils/terminal-webgl.ts`.
 *
 * The WebGL renderer recovers from context loss by re-acquiring on a backoff
 * schedule whose last slot repeats forever. Chromium refuses WebGL for the
 * page's domain for up to two minutes after a second GPU-process crash, so a
 * terminal on the DOM renderer for any reason other than a budget suspend must
 * always have a retry armed; there is no permanent fallback. These tests
 * inject a fake addon factory (capturing `onContextLoss`) and a fake terminal
 * so the state machine can be driven deterministically with fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  attachWebglRenderer,
  getTerminalRendererReport,
  applyWebglAttachmentPlan,
  onWebglAttachmentsChanged,
  notifyFontChanged,
} from '../../src/renderer/utils/terminal-webgl';

interface FakeAddon {
  lossHandlers: Array<() => void>;
  disposed: boolean;
  textureAtlasCleared: boolean;
  onContextLoss(handler: () => void): void;
  dispose(): void;
  clearTextureAtlas(): void;
  triggerLoss(): void;
}

function makeFakeAddon(): FakeAddon {
  const addon: FakeAddon = {
    lossHandlers: [],
    disposed: false,
    textureAtlasCleared: false,
    onContextLoss(handler: () => void) { addon.lossHandlers.push(handler); },
    // Deliberately does NOT clear lossHandlers: the real addon never clears its
    // 3s restore timer on dispose either, so a superseded addon can still report
    // a loss after the module has moved on.
    dispose() { addon.disposed = true; },
    clearTextureAtlas() { addon.textureAtlasCleared = true; },
    triggerLoss() { for (const handler of addon.lossHandlers) handler(); },
  };
  return addon;
}

/**
 * Builds a `createAddon` factory whose per-call behavior is scripted by `modes`
 * (one entry per call, 'ok' or 'throw'; calls past the end of the array default
 * to 'ok'). Only successful calls push a `FakeAddon` onto the returned `addons`
 * array, so `addons[n]` always lines up with the n-th SUCCESSFUL attach.
 * `callCount()` reports every call, successful or not.
 */
function makeAddonFactory(modes: Array<'ok' | 'throw'>): {
  createAddon: () => FakeAddon;
  addons: FakeAddon[];
  callCount: () => number;
} {
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
  return { createAddon, addons, callCount: () => callIndex };
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
    const status = getTerminalRendererReport()['k-attach'];
    expect(status.renderer).toBe('webgl');
    expect(status.contextLossCount).toBe(0);
    expect(status.failedAttempts).toBe(0);
    expect(status.retryArmed).toBe(false);
    expect(status).not.toHaveProperty('permanentDomFallback');
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
    expect(afterLoss.failedAttempts).toBe(1);
    expect(afterLoss.retryArmed).toBe(true);
    expect(addons[0].disposed).toBe(true);

    // Re-init is scheduled for +2000ms; nothing before then.
    vi.advanceTimersByTime(1_999);
    expect(getTerminalRendererReport()['k-recover'].renderer).toBe('dom');
    vi.advanceTimersByTime(1);
    const afterRecovery = getTerminalRendererReport()['k-recover'];
    expect(afterRecovery.renderer).toBe('webgl');
    expect(afterRecovery.failedAttempts).toBe(0);
    expect(afterRecovery.retryArmed).toBe(false);
    expect(addons).toHaveLength(2);
    dispose();
  });

  it('a loss after a recovery restarts the schedule at the first slot', () => {
    const addons: FakeAddon[] = [];
    const dispose = attachWebglRenderer(fakeTerminal, 'k-second', {
      createAddon: () => { const addon = makeFakeAddon(); addons.push(addon); return addon; },
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    vi.advanceTimersByTime(2_000); // recovered on addon[1]
    expect(getTerminalRendererReport()['k-second'].renderer).toBe('webgl');

    // A successful attach resets the consecutive-failure count, so the next
    // loss is a fresh event with the transient 2s slot, not the 10s one.
    addons[1].triggerLoss();
    const afterSecondLoss = getTerminalRendererReport()['k-second'];
    expect(afterSecondLoss.contextLossCount).toBe(2);
    expect(afterSecondLoss.failedAttempts).toBe(1);
    vi.advanceTimersByTime(1_999);
    expect(getTerminalRendererReport()['k-second'].renderer).toBe('dom');
    vi.advanceTimersByTime(1);
    expect(getTerminalRendererReport()['k-second'].renderer).toBe('webgl');
    expect(addons).toHaveLength(3);
    dispose();
  });

  it('keeps retrying after the schedule is exhausted, repeating the last delay', () => {
    // Initial attach succeeds; the next three attempts throw; the fifth
    // succeeds. With two slots the third failure must NOT latch the terminal:
    // the last slot repeats until an attempt succeeds.
    const { createAddon, addons } = makeAddonFactory(['ok', 'throw', 'throw', 'throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-tail', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(RETRY_DELAYS[0]); // attempt 1 throws
    let status = getTerminalRendererReport()['k-tail'];
    expect(status.renderer).toBe('dom');
    expect(status.failedAttempts).toBe(2);
    expect(status.retryArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(RETRY_DELAYS[1]); // attempt 2 throws: slots exhausted
    status = getTerminalRendererReport()['k-tail'];
    expect(status.renderer).toBe('dom');
    expect(status.failedAttempts).toBe(3);
    expect(status.retryArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    // The last slot repeats: nothing at +9999, attempt 3 at +10000 (throws).
    vi.advanceTimersByTime(RETRY_DELAYS[1] - 1);
    expect(getTerminalRendererReport()['k-tail'].failedAttempts).toBe(3);
    vi.advanceTimersByTime(1);
    expect(getTerminalRendererReport()['k-tail'].failedAttempts).toBe(4);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(RETRY_DELAYS[1]); // attempt 4 succeeds
    status = getTerminalRendererReport()['k-tail'];
    expect(status.renderer).toBe('webgl');
    expect(status.failedAttempts).toBe(0);
    expect(status.retryArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(addons).toHaveLength(2);
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
    expect(getTerminalRendererReport()['k-retry-recover'].retryArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    // Second scheduled retry succeeds.
    vi.advanceTimersByTime(RETRY_DELAYS[1]);
    const status = getTerminalRendererReport()['k-retry-recover'];
    expect(status.renderer).toBe('webgl');
    expect(status.retryArmed).toBe(false);
    expect(status.failedAttempts).toBe(0);
    expect(addons).toHaveLength(2); // initial attach + the recovered retry

    dispose();
  });

  it('arms the retry schedule when the initial attach throws', () => {
    // A terminal opened while Chromium is refusing WebGL (blocked after a GPU
    // crash) must enter the same schedule as a loss, not latch on DOM.
    const { createAddon, addons } = makeAddonFactory(['throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-unavailable', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    const status = getTerminalRendererReport()['k-unavailable'];
    expect(status.renderer).toBe('dom');
    expect(status.contextLossCount).toBe(0);
    expect(status.failedAttempts).toBe(1);
    expect(status.retryArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    const recovered = getTerminalRendererReport()['k-unavailable'];
    expect(recovered.renderer).toBe('webgl');
    expect(recovered.failedAttempts).toBe(0);
    expect(recovered.retryArmed).toBe(false);
    expect(addons).toHaveLength(1);
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

  it('the default schedule probes at 2, 12, 42, 72, 132, 252 and then every 120 seconds', () => {
    // No retryDelaysMs injected: this pins the production schedule. Six probes
    // throw, the seventh (at 372s) succeeds.
    const { createAddon, addons, callCount } = makeAddonFactory([
      'ok', 'throw', 'throw', 'throw', 'throw', 'throw', 'throw', 'ok',
    ]);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-default-schedule', { createAddon });
    expect(callCount()).toBe(1);

    addons[0].triggerLoss();
    const boundariesMs = [2_000, 12_000, 42_000, 72_000, 132_000, 252_000, 372_000];
    let elapsedMs = 0;
    for (let index = 0; index < boundariesMs.length; index += 1) {
      const boundaryMs = boundariesMs[index];
      vi.advanceTimersByTime(boundaryMs - 1 - elapsedMs);
      expect(callCount()).toBe(index + 1);
      vi.advanceTimersByTime(1);
      expect(callCount()).toBe(index + 2);
      elapsedMs = boundaryMs;
    }
    expect(getTerminalRendererReport()['k-default-schedule'].renderer).toBe('webgl');
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('ignores a loss reported by a superseded addon', () => {
    const addons: FakeAddon[] = [];
    const dispose = attachWebglRenderer(fakeTerminal, 'k-stale-addon', {
      createAddon: () => { const addon = makeFakeAddon(); addons.push(addon); return addon; },
      retryDelaysMs: RETRY_DELAYS,
    });

    addons[0].triggerLoss();
    vi.advanceTimersByTime(RETRY_DELAYS[0]); // recovered on addons[1]
    expect(getTerminalRendererReport()['k-stale-addon'].renderer).toBe('webgl');

    // The disposed addon's late loss callback must not touch the live one.
    addons[0].triggerLoss();
    const status = getTerminalRendererReport()['k-stale-addon'];
    expect(status.renderer).toBe('webgl');
    expect(status.contextLossCount).toBe(1);
    expect(status.retryArmed).toBe(false);
    expect(addons[1].disposed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  it('disposes the addon it handed to xterm when loadAddon throws', () => {
    // The real WebGL2 throw comes from WebglAddon.activate(), inside
    // terminal.loadAddon(), AFTER xterm's AddonManager has pushed the addon
    // onto its list. Disposing it is what splices that entry back out.
    const throwingTerminal = {
      loadAddon: vi.fn(() => { throw new Error('WebGL2 not supported'); }),
    } as unknown as Terminal;
    const { createAddon, addons } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(throwingTerminal, 'k-load-throws', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    expect(addons).toHaveLength(1);
    expect(addons[0].disposed).toBe(true);
    const status = getTerminalRendererReport()['k-load-throws'];
    expect(status.renderer).toBe('dom');
    expect(status.failedAttempts).toBe(1);
    expect(status.retryArmed).toBe(true);
    dispose();
  });

  it('falls back to the default schedule when retryDelaysMs is an empty array', () => {
    // An empty array must not be read at index -1: `retryDelaysMs[-1]` is
    // undefined, which would arm setTimeout with an undefined delay (fires on
    // the next tick) instead of falling back to DEFAULT_RETRY_DELAYS_MS.
    const { createAddon, callCount } = makeAddonFactory(['throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-empty-schedule', {
      createAddon,
      retryDelaysMs: [],
    });

    const status = getTerminalRendererReport()['k-empty-schedule'];
    expect(status.retryArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    // The default schedule's first slot is 2000ms.
    vi.advanceTimersByTime(1_999);
    expect(callCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(callCount()).toBe(2);
    expect(getTerminalRendererReport()['k-empty-schedule'].renderer).toBe('webgl');
    dispose();
  });
});

describe('notifyFontChanged', () => {
  it('clears the texture atlas of a live webgl attachment', () => {
    const { createAddon, addons } = makeAddonFactory(['ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-font-live', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    notifyFontChanged('k-font-live');

    expect(addons[0].textureAtlasCleared).toBe(true);
    dispose();
  });

  it('is a safe no-op for a terminal on the DOM renderer after a failed attach', () => {
    const dispose = attachWebglRenderer(fakeTerminal, 'k-font-dom', {
      createAddon: () => { throw new Error('WebGL unavailable'); },
      retryDelaysMs: RETRY_DELAYS,
    });

    expect(() => notifyFontChanged('k-font-dom')).not.toThrow();
    dispose();
  });

  it('is a safe no-op for an unknown renderer key', () => {
    expect(() => notifyFontChanged('k-font-unregistered')).not.toThrow();
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
    expect(status.failedAttempts).toBe(0);
    expect(status.retryArmed).toBe(false);
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
    expect(status.retryArmed).toBe(false);
    // The failure count survives the suspend (see the mid-block test below).
    expect(status.failedAttempts).toBe(1);
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
    expect(status.failedAttempts).toBe(0);
    expect(status.retryArmed).toBe(false);
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

  it('a failed resume arms the retry schedule instead of staying passively suspended', () => {
    // The coordinator wants this terminal live; a failed acquisition on resume
    // is the same situation as a failed retry after a loss, and a page with no
    // coordinator (the Agent Monitor pop-out) would otherwise never retry.
    const { createAddon, addons, callCount } = makeAddonFactory(['ok', 'throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-resume-fail', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });

    applyWebglAttachmentPlan(suspendPlan('k-resume-fail'));
    applyWebglAttachmentPlan(attachPlan('k-resume-fail')); // tryAttach throws

    const afterFailure = getTerminalRendererReport()['k-resume-fail'];
    expect(afterFailure.renderer).toBe('dom');
    expect(afterFailure.suspendedByBudget).toBe(false);
    expect(afterFailure.retryArmed).toBe(true);
    expect(afterFailure.failedAttempts).toBe(1);
    expect(afterFailure.contextLossCount).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    // Re-applying the plan before the timer fires is a no-op: probe timing must
    // not follow window focus (the coordinator re-applies on every change).
    applyWebglAttachmentPlan(attachPlan('k-resume-fail'));
    expect(callCount()).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    const afterRecovery = getTerminalRendererReport()['k-resume-fail'];
    expect(afterRecovery.renderer).toBe('webgl');
    expect(afterRecovery.suspendedByBudget).toBe(false);
    expect(afterRecovery.retryArmed).toBe(false);
    expect(addons).toHaveLength(2);
    dispose();
  });

  it('suspend applies to a terminal mid-schedule and resume probes again', () => {
    const { createAddon, addons, callCount } = makeAddonFactory(['throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-mid-schedule', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(getTerminalRendererReport()['k-mid-schedule'].retryArmed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    applyWebglAttachmentPlan(suspendPlan('k-mid-schedule'));
    const suspendedStatus = getTerminalRendererReport()['k-mid-schedule'];
    expect(suspendedStatus.suspendedByBudget).toBe(true);
    expect(suspendedStatus.retryArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // No probe while suspended, however long it stays that way.
    vi.advanceTimersByTime(20_000);
    expect(callCount()).toBe(1);

    applyWebglAttachmentPlan(attachPlan('k-mid-schedule'));
    const resumedStatus = getTerminalRendererReport()['k-mid-schedule'];
    expect(resumedStatus.renderer).toBe('webgl');
    expect(resumedStatus.suspendedByBudget).toBe(false);
    expect(resumedStatus.failedAttempts).toBe(0);
    expect(addons).toHaveLength(1);
    dispose();
  });

  it('suspend does not reset failedAttempts, so a resume mid-block continues the schedule', () => {
    // A user flipping window focus during Chromium's block must not restart
    // every affected schedule at 2s: the resume failure takes the NEXT slot.
    const { createAddon, addons, callCount } = makeAddonFactory(['ok', 'throw', 'throw', 'ok']);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-keep-failures', {
      createAddon,
      retryDelaysMs: [2_000, 10_000, 30_000],
    });

    addons[0].triggerLoss(); // failure 1
    vi.advanceTimersByTime(2_000); // failure 2, next slot 10s
    expect(getTerminalRendererReport()['k-keep-failures'].failedAttempts).toBe(2);

    applyWebglAttachmentPlan(suspendPlan('k-keep-failures'));
    expect(getTerminalRendererReport()['k-keep-failures'].failedAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    applyWebglAttachmentPlan(attachPlan('k-keep-failures')); // failure 3, slot 30s
    expect(getTerminalRendererReport()['k-keep-failures'].failedAttempts).toBe(3);
    expect(callCount()).toBe(3);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(29_999);
    expect(callCount()).toBe(3);
    vi.advanceTimersByTime(1);
    expect(callCount()).toBe(4);
    expect(getTerminalRendererReport()['k-keep-failures'].renderer).toBe('webgl');
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
    expect(status.retryArmed).toBe(false);
    expect(secondFactory).not.toHaveBeenCalled();

    disposeFirst();
    disposeSecond();
  });

  it('a retry that finds the page over budget parks the terminal as budget-suspended and notifies listeners', () => {
    const listener = vi.fn();
    const unsubscribe = onWebglAttachmentsChanged(listener);
    // Cleanup runs in a finally: the listener registry is module state, and a
    // listener leaked by a failed assertion would flip the no-coordinator
    // branch for every later test in this file.
    let disposeParked: (() => void) | null = null;
    let disposeLive: (() => void) | null = null;
    try {
      // The parked terminal mounts FIRST (under budget, its attach throws, it
      // arms a retry), then a second terminal takes the only slot.
      const parked = makeAddonFactory(['throw']);
      disposeParked = attachWebglRenderer(fakeTerminal, 'k-park-b', {
        createAddon: parked.createAddon,
        retryDelaysMs: RETRY_DELAYS,
        attachBudget: 1,
      });
      expect(getTerminalRendererReport()['k-park-b'].retryArmed).toBe(true);

      const live = makeAddonFactory(['ok']);
      disposeLive = attachWebglRenderer(fakeTerminal, 'k-park-a', {
        createAddon: live.createAddon,
        retryDelaysMs: RETRY_DELAYS,
        attachBudget: 1,
      });
      expect(getTerminalRendererReport()['k-park-a'].renderer).toBe('webgl');
      const notifiesBefore = listener.mock.calls.length;

      vi.advanceTimersByTime(RETRY_DELAYS[0]);
      const status = getTerminalRendererReport()['k-park-b'];
      expect(status.renderer).toBe('dom');
      expect(status.suspendedByBudget).toBe(true);
      expect(status.retryArmed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // Parking never asked for a context past the cap.
      expect(parked.callCount()).toBe(1);
      expect(listener.mock.calls.length).toBe(notifiesBefore + 1);
    } finally {
      disposeLive?.();
      disposeParked?.();
      unsubscribe();
    }
  });

  it('a plan re-applied from the park notification can resume the parked terminal in the same tick', () => {
    // The coordinator re-applies its plan synchronously inside the
    // attachment-changed notification. If the plan prefers the parked terminal,
    // it suspends the other one and resumes this one before the retry timer
    // callback returns, so the callback's state must be committed before the
    // notify.
    const parked = makeAddonFactory(['throw', 'ok']);
    const live = makeAddonFactory(['ok']);
    const unsubscribe = onWebglAttachmentsChanged(() => {
      // The listener also fires on the two mounts; act only once the park
      // has actually happened.
      if (getTerminalRendererReport()['k-reent-b']?.suspendedByBudget) {
        applyWebglAttachmentPlan({ attachKeys: new Set(['k-reent-b']), suspendKeys: new Set(['k-reent-a']) });
      }
    });
    // Cleanup runs in a finally for the same reason as the park test above.
    let disposeParked: (() => void) | null = null;
    let disposeLive: (() => void) | null = null;
    try {
      disposeParked = attachWebglRenderer(fakeTerminal, 'k-reent-b', {
        createAddon: parked.createAddon,
        retryDelaysMs: RETRY_DELAYS,
        attachBudget: 1,
      });
      disposeLive = attachWebglRenderer(fakeTerminal, 'k-reent-a', {
        createAddon: live.createAddon,
        retryDelaysMs: RETRY_DELAYS,
        attachBudget: 1,
      });
      expect(getTerminalRendererReport()['k-reent-a'].renderer).toBe('webgl');

      vi.advanceTimersByTime(RETRY_DELAYS[0]);
      const parkedStatus = getTerminalRendererReport()['k-reent-b'];
      expect(parkedStatus.renderer).toBe('webgl');
      expect(parkedStatus.suspendedByBudget).toBe(false);
      expect(parkedStatus.failedAttempts).toBe(0);
      const liveStatus = getTerminalRendererReport()['k-reent-a'];
      expect(liveStatus.renderer).toBe('dom');
      expect(liveStatus.suspendedByBudget).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      disposeLive?.();
      disposeParked?.();
      unsubscribe();
    }
  });

  it('a page with no attachment listener waits out a tail slot instead of parking', () => {
    // No listener is registered here: this is the Agent Monitor pop-out, which
    // hosts terminals without a coordinator. A parked terminal there would
    // never be resumed, so the retry waits for a slot to free up instead.
    const parked = makeAddonFactory(['throw', 'ok']);
    const disposeParked = attachWebglRenderer(fakeTerminal, 'k-nolistener-b', {
      createAddon: parked.createAddon,
      retryDelaysMs: RETRY_DELAYS,
      attachBudget: 1,
    });
    const live = makeAddonFactory(['ok']);
    const disposeLive = attachWebglRenderer(fakeTerminal, 'k-nolistener-a', {
      createAddon: live.createAddon,
      retryDelaysMs: RETRY_DELAYS,
      attachBudget: 1,
    });

    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    const waiting = getTerminalRendererReport()['k-nolistener-b'];
    expect(waiting.renderer).toBe('dom');
    expect(waiting.suspendedByBudget).toBe(false);
    expect(waiting.retryArmed).toBe(true);
    expect(waiting.failedAttempts).toBe(1); // waiting is not a failure
    expect(vi.getTimerCount()).toBe(1);
    expect(parked.callCount()).toBe(1);

    disposeLive(); // frees the slot
    vi.advanceTimersByTime(RETRY_DELAYS[1] - 1);
    expect(parked.callCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(getTerminalRendererReport()['k-nolistener-b'].renderer).toBe('webgl');
    disposeParked();
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

describe('logging', () => {
  it('warns on each failure through the first pass, once for the steady state, then only on recovery', () => {
    // Every warn is a Sentry breadcrumb; a WebGL-less environment must not fill
    // the ring with a line per probe. Seven throws, then success.
    const { createAddon, addons } = makeAddonFactory([
      'ok', 'throw', 'throw', 'throw', 'throw', 'throw', 'throw', 'throw', 'ok',
    ]);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-log', {
      createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    warnSpy.mockClear();

    addons[0].triggerLoss();
    expect(warnSpy).toHaveBeenCalledTimes(1); // the loss itself
    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    expect(warnSpy).toHaveBeenCalledTimes(2); // failure in slot 2
    vi.advanceTimersByTime(RETRY_DELAYS[1]);
    expect(warnSpy).toHaveBeenCalledTimes(3); // the one steady-state line

    for (let slot = 0; slot < 5; slot += 1) vi.advanceTimersByTime(RETRY_DELAYS[1]);
    expect(warnSpy).toHaveBeenCalledTimes(3); // silent while the tail repeats

    vi.advanceTimersByTime(RETRY_DELAYS[1]);
    expect(getTerminalRendererReport()['k-log'].renderer).toBe('webgl');
    expect(warnSpy).toHaveBeenCalledTimes(4); // recovered
    dispose();
  });

  it('logs a distinct message for each failure kind: context loss, re-init failure, and initial unavailability', () => {
    // Content, not just count: the call-count test above would still pass if
    // all three kinds collapsed onto one shared warn string.
    const loss = makeAddonFactory(['ok']);
    const disposeLoss = attachWebglRenderer(fakeTerminal, 'k-msg-loss', {
      createAddon: loss.createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    warnSpy.mockClear();
    loss.addons[0].triggerLoss();
    expect(String(warnSpy.mock.calls[0]![0])).toContain(
      'WebGL context lost (1) for k-msg-loss; retrying in 2000ms',
    );
    disposeLoss();

    const reinit = makeAddonFactory(['ok', 'throw']);
    const disposeReinit = attachWebglRenderer(fakeTerminal, 'k-msg-reinit', {
      createAddon: reinit.createAddon,
      retryDelaysMs: RETRY_DELAYS,
    });
    reinit.addons[0].triggerLoss();
    warnSpy.mockClear();
    vi.advanceTimersByTime(RETRY_DELAYS[0]); // the scheduled retry throws
    expect(String(warnSpy.mock.calls[0]![0])).toContain(
      'WebGL re-init failed for k-msg-reinit; retrying in 10000ms',
    );
    disposeReinit();

    warnSpy.mockClear();
    const disposeUnavailable = attachWebglRenderer(fakeTerminal, 'k-msg-unavailable', {
      createAddon: () => { throw new Error('WebGL unavailable'); },
      retryDelaysMs: RETRY_DELAYS,
    });
    expect(String(warnSpy.mock.calls[0]![0])).toContain(
      'WebGL unavailable for k-msg-unavailable; retrying in 2000ms',
    );
    disposeUnavailable();
  });
});

describe('invariant', () => {
  const emptyPlan = { attachKeys: new Set<string>(), suspendKeys: new Set<string>() };

  it('a DOM terminal that is not budget-suspended always has exactly one retry armed', () => {
    const expectArmed = (key: string): void => {
      const status = getTerminalRendererReport()[key];
      expect(status.renderer).toBe('dom');
      expect(status.suspendedByBudget).toBe(false);
      expect(status.retryArmed).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    };

    // (a) a context loss
    const loss = makeAddonFactory(['ok']);
    const disposeLoss = attachWebglRenderer(fakeTerminal, 'k-inv-loss', { createAddon: loss.createAddon, retryDelaysMs: RETRY_DELAYS });
    loss.addons[0].triggerLoss();
    expectArmed('k-inv-loss');
    disposeLoss();
    expect(vi.getTimerCount()).toBe(0);

    // (b) a failed retry
    const retry = makeAddonFactory(['ok', 'throw']);
    const disposeRetry = attachWebglRenderer(fakeTerminal, 'k-inv-retry', { createAddon: retry.createAddon, retryDelaysMs: RETRY_DELAYS });
    retry.addons[0].triggerLoss();
    vi.advanceTimersByTime(RETRY_DELAYS[0]);
    expectArmed('k-inv-retry');
    disposeRetry();
    expect(vi.getTimerCount()).toBe(0);

    // (c) a failed resume
    const resume = makeAddonFactory(['ok', 'throw']);
    const disposeResume = attachWebglRenderer(fakeTerminal, 'k-inv-resume', { createAddon: resume.createAddon, retryDelaysMs: RETRY_DELAYS });
    applyWebglAttachmentPlan({ ...emptyPlan, suspendKeys: new Set(['k-inv-resume']) });
    applyWebglAttachmentPlan({ ...emptyPlan, attachKeys: new Set(['k-inv-resume']) });
    expectArmed('k-inv-resume');
    disposeResume();
    expect(vi.getTimerCount()).toBe(0);

    // (d) an initial attach failure
    const initial = makeAddonFactory(['throw']);
    const disposeInitial = attachWebglRenderer(fakeTerminal, 'k-inv-initial', { createAddon: initial.createAddon, retryDelaysMs: RETRY_DELAYS });
    expectArmed('k-inv-initial');
    disposeInitial();
    expect(vi.getTimerCount()).toBe(0);
  });
});
