/**
 * The before-quit handler state machine
 * (src/main/pty/shutdown/before-quit-handler.ts) and its wiring into
 * src/main/index.ts.
 *
 * The handler is the one sanctioned event.preventDefault() in the quit path:
 * it holds the quit only for the bounded PTY exit-callback drain (Sentry
 * DESKTOP-C) and then re-issues app.quit(). The behavioural half drives the
 * pure handler with stubbed dependencies. The static half scans index.ts,
 * which makes top-level electron calls and cannot be imported by a unit test
 * (the same constraint and approach as tests/unit/startup-gate.test.ts).
 *
 * Tier: Unit.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { createBeforeQuitHandler } from '../../src/main/pty/shutdown/before-quit-handler';
import type { PtyExitDrainResult } from '../../src/main/pty/shutdown/exit-callback-drain';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

function makeDeferredDrain() {
  let resolveDrain: (result: PtyExitDrainResult) => void = () => undefined;
  let rejectDrain: (error: Error) => void = () => undefined;
  const promise = new Promise<PtyExitDrainResult>((resolve, reject) => {
    resolveDrain = resolve;
    rejectDrain = reject;
  });
  return { promise, resolveDrain, rejectDrain };
}

function makeHarness(killedPtyPids: number[]) {
  const deferred = makeDeferredDrain();
  const dependencies = {
    performShutdown: vi.fn(),
    getKilledPtyPids: vi.fn(() => killedPtyPids),
    drainPtyExitCallbacks: vi.fn(() => deferred.promise),
    hideAllWindows: vi.fn(),
    requestQuit: vi.fn(),
  };
  const handler = createBeforeQuitHandler(dependencies);
  const event = { preventDefault: vi.fn() };
  return { dependencies, handler, event, deferred };
}

/** Let the drain's then-callbacks run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createBeforeQuitHandler', () => {
  it('holds the first quit for the drain, then re-quits once and lets the second pass through', async () => {
    const { dependencies, handler, event, deferred } = makeHarness([4242, 4343]);

    handler(event);

    expect(dependencies.performShutdown).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.hideAllWindows).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledWith([4242, 4343]);
    // Nothing re-quits until the drain settles.
    expect(dependencies.requestQuit).not.toHaveBeenCalled();

    deferred.resolveDrain({ timedOut: false, elapsedMs: 80, lingeringPids: [] });
    await flushMicrotasks();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);

    // The re-quit's before-quit pass: cleanup is re-entered (its own guard
    // makes it a no-op) and Electron must NOT be held again.
    const secondEvent = { preventDefault: vi.fn() };
    handler(secondEvent);
    expect(dependencies.performShutdown).toHaveBeenCalledTimes(2);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('is byte-for-byte the plain synchronous quit when no PTY was killed', () => {
    const { dependencies, handler, event } = makeHarness([]);

    handler(event);
    expect(dependencies.performShutdown).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.drainPtyExitCallbacks).not.toHaveBeenCalled();
    expect(dependencies.hideAllWindows).not.toHaveBeenCalled();
    expect(dependencies.requestQuit).not.toHaveBeenCalled();

    // A later pass (an OS retry, a second Cmd+Q) proceeds too.
    const secondEvent = { preventDefault: vi.fn() };
    handler(secondEvent);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps holding a repeated quit while the drain is running, without restarting the drain', async () => {
    const { dependencies, handler, event, deferred } = makeHarness([4242]);

    handler(event);
    const impatientEvent = { preventDefault: vi.fn() };
    handler(impatientEvent);

    expect(impatientEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);

    deferred.resolveDrain({ timedOut: true, elapsedMs: 1500, lingeringPids: [4242] });
    await flushMicrotasks();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('still re-quits exactly once when the drain rejects', async () => {
    const { dependencies, handler, event, deferred } = makeHarness([4242]);

    handler(event);
    deferred.rejectDrain(new Error('drain failed'));
    await flushMicrotasks();

    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
    const afterEvent = { preventDefault: vi.fn() };
    handler(afterEvent);
    expect(afterEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('still re-quits exactly once when the drain throws synchronously', () => {
    const { dependencies, handler, event } = makeHarness([4242]);
    dependencies.drainPtyExitCallbacks.mockImplementation(() => {
      throw new Error('drain constructor exploded');
    });

    expect(() => handler(event)).not.toThrow();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('does not let a window that refuses to hide block the drain', () => {
    const { dependencies, handler, event } = makeHarness([4242]);
    dependencies.hideAllWindows.mockImplementation(() => {
      throw new Error('window already destroyed');
    });

    expect(() => handler(event)).not.toThrow();
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);
  });

  /**
   * Pins the read order: performShutdown() must run BEFORE getKilledPtyPids()
   * is read, because in the real wiring (src/main/index.ts) performShutdown is
   * what assigns the module-level killedPtyPids as a side effect - reading it
   * first would always see the empty pre-shutdown array. makeHarness's other
   * tests stub getKilledPtyPids over a CONSTANT array, so they cannot tell
   * "read after performShutdown" apart from "read before"; this test makes the
   * stub order-sensitive so it can. Red-green: swapping the two statements at
   * the top of the handler in before-quit-handler.ts (reading
   * dependencies.getKilledPtyPids() before calling
   * dependencies.performShutdown()) turns this red, because
   * drainPtyExitCallbacks would then be called with the stale empty array
   * instead of [4242].
   */
  it('reads getKilledPtyPids AFTER performShutdown, mirroring the real wiring where performShutdown assigns killedPtyPids as a side effect', () => {
    let pids: number[] = [];
    const dependencies = {
      performShutdown: vi.fn(() => {
        pids = [4242];
      }),
      getKilledPtyPids: vi.fn(() => pids),
      drainPtyExitCallbacks: vi.fn(() => new Promise<PtyExitDrainResult>(() => undefined)),
      hideAllWindows: vi.fn(),
      requestQuit: vi.fn(),
    };
    const handler = createBeforeQuitHandler(dependencies);
    const event = { preventDefault: vi.fn() };

    handler(event);

    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledWith([4242]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('the before-quit drain is wired into src/main/index.ts', () => {
  it('registers the handler for before-quit and re-quits through app.quit, never process.exit', () => {
    const start = INDEX_SOURCE.indexOf("app.on('before-quit', createBeforeQuitHandler(");
    expect(
      start,
      "src/main/index.ts must register app.on('before-quit') through createBeforeQuitHandler; a bare performShutdown() handler reintroduces the DESKTOP-C crash-on-quit race",
    ).toBeGreaterThan(-1);

    // The registration ends at its own `}));`; slicing to a fixed length would
    // run into the SIGINT/SIGTERM block that follows, which legitimately
    // calls process.exit (no loop turn is needed there).
    const end = INDEX_SOURCE.indexOf('}));', start);
    expect(end, 'the createBeforeQuitHandler registration must close with `}));`').toBeGreaterThan(start);
    const handlerRegion = INDEX_SOURCE.slice(start, end);
    expect(
      handlerRegion,
      'the drain must re-enter the quit with app.quit() so Electron runs its own teardown (process.exit skips it and is the zombie-child failure mode the synchronous-shutdown rule exists for)',
    ).toContain('requestQuit: () => app.quit()');
    expect(handlerRegion).not.toContain('process.exit');
  });

  it('feeds the pids the synchronous cleanup actually killed into the drain', () => {
    expect(
      INDEX_SOURCE,
      'performShutdown must capture syncShutdownCleanup() return value; dropping it leaves the drain with nothing to wait on and the quit unprotected',
    ).toContain('killedPtyPids = syncShutdownCleanup(');
    expect(INDEX_SOURCE).toContain('getKilledPtyPids: () => (osInitiatedShutdown ? [] : killedPtyPids)');
  });

  it('never holds an OS-initiated shutdown', () => {
    // Windows session-end and the powerMonitor shutdown event both route
    // through performShutdown; each must disarm the drain first so a logout
    // is never answered with a prevented quit.
    const flagSets = INDEX_SOURCE.match(/osInitiatedShutdown = true;/g) ?? [];
    expect(
      flagSets.length,
      'both OS-initiated shutdown paths (Windows session-end, powerMonitor shutdown) must set osInitiatedShutdown = true before performShutdown(), or a logout is answered with a held quit; a third OS path needs the same disarm and this count bumped',
    ).toBe(2);
  });

  it('keeps the signal path synchronous (SIGINT/SIGTERM exit without running the loop)', () => {
    const signalBlock = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("for (const signal of ['SIGINT', 'SIGTERM'] as const)"), INDEX_SOURCE.length);
    expect(signalBlock).toContain('if (performShutdown()) process.exit(0);');
  });
});
