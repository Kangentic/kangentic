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
import type { PtyKillReport } from '../../src/main/pty/shutdown/session-shutdown';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

/**
 * Slices from `searchFromIndex` through the matching close brace of the
 * first brace-delimited block that starts at or after it, counting brace
 * depth rather than assuming any particular indentation.
 *
 * A plain substring search for a closing brace (e.g. `source.indexOf('  }',
 * start)`) matches ANY closing brace indented two or more spaces, including
 * one that belongs to a nested block inside the target handler - not only
 * the handler's own closing brace. That boundary is coincidental: a future
 * edit that adds any indented nested block (an if, an object literal, a
 * callback) before the handler's real end silently truncates the region
 * before reaching it, and an assertion checking for the ABSENCE of some
 * later text then passes for the wrong reason - it never saw that text, not
 * because the text is not there.
 *
 * Ignores brace characters inside single, double, or template-literal quotes
 * so a string containing a brace cannot desynchronize the depth count.
 */
function sliceBalancedBlock(source: string, searchFromIndex: number): string {
  const openBraceIndex = source.indexOf('{', searchFromIndex);
  if (openBraceIndex === -1) {
    throw new Error('sliceBalancedBlock: no opening brace found at or after searchFromIndex');
  }

  let braceDepth = 0;
  let activeQuoteCharacter: string | null = null;
  for (let characterIndex = openBraceIndex; characterIndex < source.length; characterIndex += 1) {
    const character = source[characterIndex];

    if (activeQuoteCharacter) {
      if (character === '\\') {
        characterIndex += 1; // skip an escaped character, including an escaped quote
      } else if (character === activeQuoteCharacter) {
        activeQuoteCharacter = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      activeQuoteCharacter = character;
      continue;
    }

    if (character === '{') {
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(searchFromIndex, characterIndex + 1);
      }
    }
  }

  throw new Error('sliceBalancedBlock: unbalanced braces after searchFromIndex');
}

function makeDeferredDrain() {
  let resolveDrain: (result: PtyExitDrainResult) => void = () => undefined;
  let rejectDrain: (error: Error) => void = () => undefined;
  const promise = new Promise<PtyExitDrainResult>((resolve, reject) => {
    resolveDrain = resolve;
    rejectDrain = reject;
  });
  return { promise, resolveDrain, rejectDrain };
}

function makeHarness(
  ptyKillReport: PtyKillReport,
  overrides: { osInitiated?: boolean; cleanupRan?: boolean } = {},
) {
  const deferred = makeDeferredDrain();
  const log = vi.fn();
  const dependencies = {
    performShutdown: vi.fn(() => overrides.cleanupRan ?? true),
    isOsInitiatedShutdown: vi.fn(() => overrides.osInitiated ?? false),
    getPtyKillReport: vi.fn(() => ptyKillReport),
    drainPtyExitCallbacks: vi.fn(() => deferred.promise),
    hideAllWindows: vi.fn(),
    requestQuit: vi.fn(),
    log,
  };
  const handler = createBeforeQuitHandler(dependencies);
  const event = { preventDefault: vi.fn() };
  return { dependencies, handler, event, deferred, log };
}

/** A clean probed drain result, for tests that only care about the re-quit. */
const CLEAN_DRAIN: PtyExitDrainResult = {
  timedOut: false,
  elapsedMs: 80,
  lingeringPids: [],
  unprobedKillCount: 0,
};

/** Let the drain's then-callbacks run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createBeforeQuitHandler', () => {
  it('holds the first quit for the drain, then re-quits once and lets the second pass through', async () => {
    const { dependencies, handler, event, deferred, log } =
      makeHarness({ pids: [4242, 4343], killedCount: 2 });

    handler(event);

    expect(dependencies.performShutdown).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.hideAllWindows).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks)
      .toHaveBeenCalledWith({ pids: [4242, 4343], killedCount: 2 });
    // Nothing re-quits until the drain settles.
    expect(dependencies.requestQuit).not.toHaveBeenCalled();

    deferred.resolveDrain(CLEAN_DRAIN);
    await flushMicrotasks();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);

    // The re-quit's before-quit pass: cleanup is re-entered (its own guard
    // makes it a no-op) and Electron must NOT be held again.
    const secondEvent = { preventDefault: vi.fn() };
    handler(secondEvent);
    expect(dependencies.performShutdown).toHaveBeenCalledTimes(2);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);

    // The breadcrumbs are skip-only: the ordinary held-then-re-quit path must
    // stay silent across both passes, or every quit adds noise to the trail
    // the skip reasons exist to make readable.
    expect(log).not.toHaveBeenCalled();
  });

  it('is byte-for-byte the plain synchronous quit when no PTY was killed', () => {
    const { dependencies, handler, event, log } = makeHarness({ pids: [], killedCount: 0 });

    handler(event);
    expect(dependencies.performShutdown).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.drainPtyExitCallbacks).not.toHaveBeenCalled();
    expect(dependencies.hideAllWindows).not.toHaveBeenCalled();
    expect(dependencies.requestQuit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[SHUTDOWN] pty-drain:skip reason=no-pty-killed');

    // A later pass (an OS retry, a second Cmd+Q) proceeds too.
    const secondEvent = { preventDefault: vi.fn() };
    handler(secondEvent);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
  });

  /**
   * The regression this hardening exists for. killAllSessions used to report
   * only pids, so a killed PTY whose child pid was unreadable contributed
   * nothing and the handler skipped the drain for the WHOLE shutdown: the quit
   * proceeded straight into node::Stop() with an exit callback still in flight.
   * Red-green: a `pids.length === 0` skip condition leaves preventDefault
   * uncalled here.
   */
  it('holds the quit for a kill it cannot probe, instead of skipping the drain', () => {
    const { dependencies, handler, event, log } = makeHarness({ pids: [], killedCount: 2 });

    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks)
      .toHaveBeenCalledWith({ pids: [], killedCount: 2 });
    expect(log).not.toHaveBeenCalled();
  });

  it('skips the drain and names the reason when an OS-initiated shutdown disarmed it', () => {
    // The disarm arrives as its own signal rather than as an empty pid list,
    // which is what makes this breadcrumb distinguishable from
    // reason=no-pty-killed in a Sentry trail.
    const { dependencies, handler, event, log } =
      makeHarness({ pids: [4242], killedCount: 1 }, { osInitiated: true });

    handler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.drainPtyExitCallbacks).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[SHUTDOWN] pty-drain:skip reason=os-initiated-shutdown');

    const secondEvent = { preventDefault: vi.fn() };
    handler(secondEvent);
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('notes a cleanup that had already run under another entry point, and still drains', () => {
    // performShutdown returning false means another path already ran the
    // cleanup, so the report describes THAT pass. Its routine producer is the
    // macOS/Linux powerMonitor shutdown, which calls performShutdown() and then
    // app.quit(). Draining anyway is deliberate: skipping would silently disarm
    // the crash protection, which is the bug class this change fixes.
    const { dependencies, handler, event, log } =
      makeHarness({ pids: [4242], killedCount: 1 }, { cleanupRan: false });

    handler(event);

    expect(log).toHaveBeenCalledWith('[SHUTDOWN] pty-drain:note cleanup-ran-earlier');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);
  });

  it('still drains an inconsistent report that lists pids but counts no kills', () => {
    const { dependencies, handler, event } = makeHarness({ pids: [4242], killedCount: 0 });

    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);
  });

  it('keeps holding a repeated quit while the drain is running, without restarting the drain', async () => {
    const { dependencies, handler, event, deferred } = makeHarness({ pids: [4242], killedCount: 1 });

    handler(event);
    const impatientEvent = { preventDefault: vi.fn() };
    handler(impatientEvent);

    expect(impatientEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);

    deferred.resolveDrain({
      timedOut: true, elapsedMs: 1500, lingeringPids: [4242], unprobedKillCount: 0,
    });
    await flushMicrotasks();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('still re-quits exactly once when the drain rejects', async () => {
    const { dependencies, handler, event, deferred } = makeHarness({ pids: [4242], killedCount: 1 });

    handler(event);
    deferred.rejectDrain(new Error('drain failed'));
    await flushMicrotasks();

    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
    const afterEvent = { preventDefault: vi.fn() };
    handler(afterEvent);
    expect(afterEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('still re-quits exactly once when the drain throws synchronously', () => {
    const { dependencies, handler, event } = makeHarness({ pids: [4242], killedCount: 1 });
    dependencies.drainPtyExitCallbacks.mockImplementation(() => {
      throw new Error('drain constructor exploded');
    });

    expect(() => handler(event)).not.toThrow();
    expect(dependencies.requestQuit).toHaveBeenCalledTimes(1);
  });

  it('does not let a window that refuses to hide block the drain', () => {
    const { dependencies, handler, event } = makeHarness({ pids: [4242], killedCount: 1 });
    dependencies.hideAllWindows.mockImplementation(() => {
      throw new Error('window already destroyed');
    });

    expect(() => handler(event)).not.toThrow();
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);
  });

  /**
   * Pins the read order: performShutdown() must run BEFORE getPtyKillReport()
   * is read, because in the real wiring (src/main/index.ts) performShutdown is
   * what assigns the module-level ptyKillReport as a side effect - reading it
   * first would always see the empty pre-shutdown report. makeHarness's other
   * tests stub getPtyKillReport over a CONSTANT report, so they cannot tell
   * "read after performShutdown" apart from "read before"; this test makes the
   * stub order-sensitive so it can. Red-green: swapping the two statements at
   * the top of the handler in before-quit-handler.ts (reading
   * dependencies.getPtyKillReport() before calling
   * dependencies.performShutdown()) turns this red, because
   * drainPtyExitCallbacks would then be called with the stale zero report
   * instead of the real one.
   */
  it('reads getPtyKillReport AFTER performShutdown, mirroring the real wiring where performShutdown assigns ptyKillReport as a side effect', () => {
    let report: PtyKillReport = { pids: [], killedCount: 0 };
    const { dependencies, handler, event } = makeHarness(report);
    dependencies.performShutdown.mockImplementation(() => {
      report = { pids: [4242], killedCount: 1 };
      return true;
    });
    dependencies.getPtyKillReport.mockImplementation(() => report);

    handler(event);

    expect(dependencies.drainPtyExitCallbacks)
      .toHaveBeenCalledWith({ pids: [4242], killedCount: 1 });
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
    expect(
      handlerRegion,
      'the drain must receive killedCount as well as pids, or a kill with an unreadable child pid is drained as if nothing had been killed at all',
    ).toContain('killedCount: report.killedCount');
  });

  it('feeds the whole kill report the synchronous cleanup produced into the drain', () => {
    expect(
      INDEX_SOURCE,
      'performShutdown must capture syncShutdownCleanup() return value; dropping it leaves the drain with nothing to wait on and the quit unprotected',
    ).toContain('ptyKillReport = syncShutdownCleanup(');
    expect(
      INDEX_SOURCE,
      'the handler must read the whole kill report; feeding it only the pids lets a PTY whose child pid was unreadable skip the drain for the entire shutdown',
    ).toContain('getPtyKillReport: () => ptyKillReport');
    expect(
      INDEX_SOURCE,
      'the OS-shutdown disarm must reach the handler as its own signal, not be smuggled through an empty pid list, so the skip is logged with a distinguishable reason',
    ).toContain('isOsInitiatedShutdown: () => osShutdownCannotBeDelayed');
  });

  /**
   * Each OS-shutdown route must pick a side, and the two sides are opposites.
   * Deliberately NOT an occurrence count of the flag assignment: after the
   * macOS/Linux path stopped setting it there is exactly one assignment, and
   * asserting "exactly one" would pass for a new unpreventable OS path that
   * forgot the disarm entirely. Pinning the pairing per handler is what
   * actually forces a fourth route to choose.
   */
  it('disarms the drain only for an OS shutdown that cannot be delayed', () => {
    // Matched on the event name alone, not on the receiver: the handler is
    // attached per window inside createWindow, so its receiver expression is
    // not stable across refactors of where it is registered.
    const windowsStart = INDEX_SOURCE.indexOf(".on('session-end'");
    expect(windowsStart, "the Windows 'session-end' handler must exist").toBeGreaterThan(-1);
    const windowsRegion = INDEX_SOURCE.slice(windowsStart, INDEX_SOURCE.indexOf('});', windowsStart));
    expect(
      windowsRegion,
      "Windows session-end is documented as unpreventable ('there is no way to prevent the session from ending'), so it must disarm the drain rather than hold a logout the OS will not wait for",
    ).toContain('osShutdownCannotBeDelayed = true;');
    expect(
      windowsRegion,
      'Windows session-end cannot be prevented, so calling preventDefault there would hold the quit against an OS that is not waiting',
    ).not.toContain('preventDefault');

    const powerMonitorStart = INDEX_SOURCE.indexOf("powerMonitor.on('shutdown'");
    expect(powerMonitorStart, "the powerMonitor 'shutdown' handler must exist").toBeGreaterThan(-1);
    const powerMonitorRegion = sliceBalancedBlock(INDEX_SOURCE, powerMonitorStart);
    expect(
      powerMonitorRegion,
      'Electron documents a preventDefault() on the macOS/Linux shutdown event that asks the OS to delay; without it every reboot with a live PTY races node-pty exit callbacks against node::Stop() (Sentry DESKTOP-E)',
    ).toContain('preventDefault');
    expect(
      powerMonitorRegion,
      'the region must span the whole handler body, proven by reaching its last statement; a ' +
        'coincidental substring boundary could stop short of this line and hide a later ' +
        'regression from the assertion below',
    ).toContain('app.quit();');
    expect(
      powerMonitorRegion,
      'the macOS/Linux path asks the OS to wait and then drains, so it must NOT set the disarm flag; setting it re-opens the DESKTOP-E route',
    ).not.toContain('osShutdownCannotBeDelayed = true;');
  });

  it('keeps the signal path synchronous (SIGINT/SIGTERM exit without running the loop)', () => {
    const signalBlock = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("for (const signal of ['SIGINT', 'SIGTERM'] as const)"), INDEX_SOURCE.length);
    expect(signalBlock).toContain('if (performShutdown()) process.exit(0);');
  });
});
