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
