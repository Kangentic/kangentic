import { describe, it, expect, vi } from 'vitest';
import { navigateToVite, type ViteNavigationOptions, type ViteNavigationPage } from '../ui/vite-navigation-retry';

// Pins the retry loop navigateToVite (tests/ui/vite-navigation-retry.ts) runs for gotoVite: an
// unreached goto waits for the server and goes again, a superseded goto adopts the navigation that
// took its place, a fatal one is rethrown. vite-navigation-retry.test.ts pins only the classifier,
// so swapping the `superseded` and `unreached` handling, or the adopt step's load wait, passed
// every test. The case that matters most is a superseded `net::ERR_ABORTED` on a page already at
// the url, which must wait for the next load event, never trust the old document's load state.
//
// The fake page models one Chromium page: goto plays back scripted outcomes, url() returns what the
// test set, waitForLoadState resolves at once (the old document already fired load), and
// waitForEvent returns whatever the test scripted. The fake owns the load counter that gotoVite's
// page.on('load') listener owns in the real caller.
//
// Tier: Unit.

const VITE_URL = 'http://localhost:5174';
const NORMALIZED_VITE_URL = 'http://localhost:5174/';
const ATTEMPTS = 3;
const ADOPT_TIMEOUT_MS = 4000;

/** What isTimeoutError recognizes, standing in for Playwright's errors.TimeoutError. */
class FakeTimeoutError extends Error {}

/**
 * The message a caller of `page.goto` receives for a failure whose core message is `coreMessage`.
 * Same shape as the fixtures in vite-navigation-retry.test.ts, read from a live `page.goto`.
 */
function gotoFailure(coreMessage: string): Error {
  const dimmedLogLine = `\u001b[2m  - navigating to "${NORMALIZED_VITE_URL}", waiting until "load"\u001b[22m`;
  return new Error(`page.goto: ${coreMessage}\nCall log:\n${dimmedLogLine}\n`);
}

function supersededByReload(): Error {
  return gotoFailure(`net::ERR_ABORTED at ${NORMALIZED_VITE_URL}`);
}

function interruptedBySameUrl(): Error {
  return gotoFailure(`Navigation to "${NORMALIZED_VITE_URL}" is interrupted by another navigation to "${NORMALIZED_VITE_URL}"`);
}

function connectRefused(): Error {
  return gotoFailure(`net::ERR_CONNECTION_REFUSED at ${NORMALIZED_VITE_URL}`);
}

/** One scripted goto: it resolves, or rejects with `error`, after optionally firing a load. */
interface ScriptedGoto {
  error?: Error;
  loadFiresDuringGoto?: boolean;
}

/** One scripted waitForEvent('load'): the promise that call returns. */
type ScriptedLoadWait = () => Promise<unknown>;

function createFakeChromiumPage(script: { gotos: ScriptedGoto[]; loadWaits?: ScriptedLoadWait[]; currentUrl?: string }) {
  const pendingGotos = [...script.gotos];
  const pendingLoadWaits = [...(script.loadWaits ?? [])];
  const state = { loadCount: 0, currentUrl: script.currentUrl ?? NORMALIZED_VITE_URL };
  const page = {
    goto: vi.fn(async (url: string) => {
      const step = pendingGotos.shift();
      if (!step) throw new Error(`unscripted goto to ${url}`);
      if (step.loadFiresDuringGoto) state.loadCount += 1;
      if (step.error) throw step.error;
      return null;
    }),
    url: () => state.currentUrl,
    waitForLoadState: vi.fn<ViteNavigationPage['waitForLoadState']>(async () => undefined),
    waitForEvent: vi.fn(async (eventName: 'load', waitOptions: { timeout: number }) => {
      const loadWait = pendingLoadWaits.shift();
      if (!loadWait) throw new Error(`unscripted waitForEvent(${eventName}, ${waitOptions.timeout})`);
      return loadWait();
    }),
  };
  return { page, state, loadCount: () => state.loadCount };
}

function createOptions(loadCount: () => number) {
  const warnings: string[] = [];
  const waitForServer = vi.fn(async () => undefined);
  const options: ViteNavigationOptions = {
    attempts: ATTEMPTS,
    adoptTimeoutMs: ADOPT_TIMEOUT_MS,
    loadCount,
    isTimeoutError: (error) => error instanceof FakeTimeoutError,
    waitForServer,
    describeNavigations: () => 'navigations: none',
    warn: (line) => {
      warnings.push(line);
    },
  };
  return { options, warnings, waitForServer };
}

/** A promise the test settles by hand. */
function createDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Reports whether `promise` has settled, without waiting for it. */
function trackSettled(promise: Promise<unknown>): () => boolean {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  promise.then(markSettled, markSettled);
  return () => settled;
}

/** Lets every queued microtask run, so a loop that can progress without outside help has done so. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('navigateToVite', () => {
  it('resolves after one goto, with no warning and no wait for the server, when the goto succeeds', async () => {
    const fake = createFakeChromiumPage({ gotos: [{}] });
    const { options, warnings, waitForServer } = createOptions(fake.loadCount);

    await navigateToVite(fake.page, VITE_URL, options);

    expect(fake.page.goto).toHaveBeenCalledTimes(1);
    expect(fake.page.goto).toHaveBeenCalledWith(VITE_URL);
    expect(warnings).toEqual([]);
    expect(waitForServer).not.toHaveBeenCalled();
  });

  it('rethrows a fatal failure as the same error after one goto, without adopting or waiting for the server', async () => {
    const timedOut = gotoFailure('Timeout 30000ms exceeded.');
    const fake = createFakeChromiumPage({ gotos: [{ error: timedOut }] });
    const { options, waitForServer } = createOptions(fake.loadCount);

    await expect(navigateToVite(fake.page, VITE_URL, options)).rejects.toBe(timedOut);

    expect(fake.page.goto).toHaveBeenCalledTimes(1);
    expect(fake.page.waitForLoadState).not.toHaveBeenCalled();
    expect(fake.page.waitForEvent).not.toHaveBeenCalled();
    expect(waitForServer).not.toHaveBeenCalled();
  });

  it('waits for the server and goes again after an unreached goto, and says which goto it was', async () => {
    const fake = createFakeChromiumPage({ gotos: [{ error: connectRefused() }, {}] });
    const { options, warnings, waitForServer } = createOptions(fake.loadCount);

    await navigateToVite(fake.page, VITE_URL, options);

    expect(fake.page.goto).toHaveBeenCalledTimes(2);
    expect(waitForServer).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('goto 1 of 3 was unreached');
    expect(warnings[0]).toContain('navigations: none');
    expect(fake.page.waitForLoadState).not.toHaveBeenCalled();
    expect(fake.page.waitForEvent).not.toHaveBeenCalled();
  });

  it('rethrows the last error after exactly `attempts` gotos when every goto is unreached', async () => {
    const lastRefusal = connectRefused();
    const fake = createFakeChromiumPage({ gotos: [{ error: connectRefused() }, { error: connectRefused() }, { error: lastRefusal }] });
    const { options, waitForServer } = createOptions(fake.loadCount);

    await expect(navigateToVite(fake.page, VITE_URL, options)).rejects.toBe(lastRefusal);

    expect(fake.page.goto).toHaveBeenCalledTimes(ATTEMPTS);
    expect(waitForServer).toHaveBeenCalledTimes(ATTEMPTS - 1);
  });

  it('does not resolve on the old document when a goto is superseded and no load has fired since it began', async () => {
    // The bug this pins: ERR_ABORTED rejects before the new document commits, so the page still
    // reports the OLD document's load state and url. waitForLoadState would resolve at once there.
    // Under that variant this test fails three ways: waitForEvent is never called, waitForLoadState
    // is, and the promise settles before the load deferred is resolved.
    const newDocumentLoaded = createDeferred();
    const fake = createFakeChromiumPage({
      gotos: [{ error: supersededByReload() }],
      loadWaits: [() => newDocumentLoaded.promise],
    });
    const { options, warnings, waitForServer } = createOptions(fake.loadCount);

    const navigation = navigateToVite(fake.page, VITE_URL, options);
    const hasSettled = trackSettled(navigation);
    await drainMicrotasks();

    expect(fake.page.waitForEvent).toHaveBeenCalledTimes(1);
    expect(fake.page.waitForEvent).toHaveBeenCalledWith('load', { timeout: ADOPT_TIMEOUT_MS });
    expect(fake.page.waitForLoadState).not.toHaveBeenCalled();
    expect(hasSettled()).toBe(false);

    newDocumentLoaded.resolve();
    await navigation;

    expect(fake.page.goto).toHaveBeenCalledTimes(1);
    expect(waitForServer).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('goto 1 of 3 was superseded');
  });

  it('checks the load state instead of waiting for an event when a load fired during the superseded goto', async () => {
    const fake = createFakeChromiumPage({ gotos: [{ error: interruptedBySameUrl(), loadFiresDuringGoto: true }] });
    const { options, waitForServer } = createOptions(fake.loadCount);

    await navigateToVite(fake.page, VITE_URL, options);

    expect(fake.page.waitForLoadState).toHaveBeenCalledTimes(1);
    expect(fake.page.waitForLoadState).toHaveBeenCalledWith('load', { timeout: ADOPT_TIMEOUT_MS });
    expect(fake.page.waitForEvent).not.toHaveBeenCalled();
    expect(fake.page.goto).toHaveBeenCalledTimes(1);
    expect(waitForServer).not.toHaveBeenCalled();
  });

  it('warns, waits for the server and goes again when the superseding navigation does not load in time', async () => {
    const fake = createFakeChromiumPage({
      gotos: [{ error: supersededByReload() }, {}],
      loadWaits: [() => Promise.reject(new FakeTimeoutError('Timeout 4000ms exceeded.'))],
    });
    const { options, warnings, waitForServer } = createOptions(fake.loadCount);

    await navigateToVite(fake.page, VITE_URL, options);

    expect(fake.page.goto).toHaveBeenCalledTimes(2);
    expect(waitForServer).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(`did not reach load within ${ADOPT_TIMEOUT_MS} ms`);
  });

  it('warns naming the url and goes again when the superseding navigation loads but ends at another url', async () => {
    const fake = createFakeChromiumPage({ gotos: [{ error: supersededByReload() }, {}] });
    fake.page.waitForEvent.mockImplementationOnce(async () => {
      fake.state.currentUrl = 'about:blank';
    });
    const { options, warnings, waitForServer } = createOptions(fake.loadCount);

    await navigateToVite(fake.page, VITE_URL, options);

    expect(fake.page.goto).toHaveBeenCalledTimes(2);
    expect(waitForServer).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('ended at about:blank');
  });

  it('rethrows the last goto error after three gotos when a superseded goto is never adopted', async () => {
    const lastAbort = supersededByReload();
    const timeOut = (): Promise<unknown> => Promise.reject(new FakeTimeoutError('Timeout 4000ms exceeded.'));
    const fake = createFakeChromiumPage({
      gotos: [{ error: supersededByReload() }, { error: supersededByReload() }, { error: lastAbort }],
      loadWaits: [timeOut, timeOut, timeOut],
    });
    const { options, waitForServer } = createOptions(fake.loadCount);

    await expect(navigateToVite(fake.page, VITE_URL, options)).rejects.toBe(lastAbort);

    expect(fake.page.goto).toHaveBeenCalledTimes(3);
    expect(fake.page.waitForEvent).toHaveBeenCalledTimes(3);
    expect(waitForServer).toHaveBeenCalledTimes(2);
  });

  it('propagates an error from the load wait that is not a timeout, with no further goto', async () => {
    const targetClosed = new Error('Target page, context or browser has been closed');
    const fake = createFakeChromiumPage({
      gotos: [{ error: supersededByReload() }],
      loadWaits: [() => Promise.reject(targetClosed)],
    });
    const { options, waitForServer } = createOptions(fake.loadCount);

    await expect(navigateToVite(fake.page, VITE_URL, options)).rejects.toBe(targetClosed);

    expect(fake.page.goto).toHaveBeenCalledTimes(1);
    expect(waitForServer).not.toHaveBeenCalled();
  });
});
