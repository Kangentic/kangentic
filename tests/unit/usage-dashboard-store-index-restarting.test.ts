/**
 * Pins how the usage dashboard store handles an answer flagged `indexRestarting`
 * (main's retrieval worker was down, so the figures are an undercount).
 *
 * The contract, in one place:
 *  - A flagged payload is never cached, so figures already cached stay.
 *  - `indexRestarting` describes the ACTIVE key's last answer. Only an answer
 *    for the active key sets or clears it; an answer for a key the user has left
 *    leaves it, `loading`, `refreshing` and `error` alone (a late clean answer
 *    is still cached under its own key).
 *  - Moving to another key clears it. A same-key reload keeps it, because the
 *    dashboard polls with `force: true` and the notice would otherwise blink off
 *    and on every poll while the worker is down.
 *
 * Driven through the real store with a hand-held `usage.getDashboardStats`, so
 * each case chooses when a fetch resolves. The mock routes by period, since the
 * store dedupes in-flight fetches per key and call order alone would be fragile.
 * With no current project the effective scope is `all`, so the period alone
 * picks the cache key.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { UsageDashboardStats, UsageStatsScope, UsageTimePeriod } from '../../src/shared/types';

const getDashboardStats = vi.fn<(scope: UsageStatsScope, period: UsageTimePeriod) => Promise<UsageDashboardStats>>();

beforeAll(() => {
  vi.stubGlobal('window', {
    electronAPI: {
      config: { set: vi.fn() },
      usage: { getDashboardStats },
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

import {
  dashboardCacheKey,
  useUsageDashboardStore,
  type UsageDashboardStore,
} from '../../src/renderer/stores/usage-dashboard-store';

const LIVE_KEY = dashboardCacheKey('all', null, 'live');
const WEEK_KEY = dashboardCacheKey('all', null, 'week');

const INITIAL_DASHBOARD_STATE = {
  statsOpen: true,
  period: 'live',
  scopeKind: 'project',
  viewedProjectId: null,
  drill: null,
  customWindow: null,
  userTouched: false,
  cache: {},
  activeKey: null,
  loading: false,
  refreshing: false,
  error: null,
  indexRestarting: false,
} satisfies Partial<UsageDashboardStore>;

interface Deferred {
  promise: Promise<UsageDashboardStats>;
  resolve: (payload: UsageDashboardStats) => void;
  reject: (reason: Error) => void;
}

let payloadSerial = 0;

/** A distinct object per call, so `toBe` can tell one answer from another. The
 *  store reads only `indexRestarting`; the rest is figures it passes through. */
function makePayload(period: UsageTimePeriod, indexRestarting: boolean): UsageDashboardStats {
  payloadSerial += 1;
  return {
    period,
    generatedAtMs: payloadSerial,
    ...(indexRestarting ? { indexRestarting: true } : {}),
  } as unknown as UsageDashboardStats;
}

const cleanPayload = (period: UsageTimePeriod) => makePayload(period, false);
const flaggedPayload = (period: UsageTimePeriod) => makePayload(period, true);

// One queue of scripted answers per period; an empty queue answers clean.
const scriptedAnswers = new Map<UsageTimePeriod, Array<() => Promise<UsageDashboardStats>>>();
const heldFetches: Deferred[] = [];
const startedLoads: Array<Promise<void>> = [];

function script(period: UsageTimePeriod, answer: () => Promise<UsageDashboardStats>): void {
  const queue = scriptedAnswers.get(period) ?? [];
  queue.push(answer);
  scriptedAnswers.set(period, queue);
}

function answerWith(period: UsageTimePeriod, payload: UsageDashboardStats): void {
  script(period, () => Promise.resolve(payload));
}

function failWith(period: UsageTimePeriod, message: string): void {
  script(period, () => Promise.reject(new Error(message)));
}

/** The next fetch for `period` stays in flight until the test resolves it. */
function holdFetch(period: UsageTimePeriod): Deferred {
  let resolve: (payload: UsageDashboardStats) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<UsageDashboardStats>((settle, fail) => { resolve = settle; reject = fail; });
  const held = { promise, resolve, reject };
  heldFetches.push(held);
  script(period, () => promise);
  return held;
}

const state = () => useUsageDashboardStore.getState();

function load(options?: { force?: boolean }): Promise<void> {
  const loadPromise = state().loadDashboardStats(options);
  startedLoads.push(loadPromise);
  return loadPromise;
}

function viewWeek(): void {
  useUsageDashboardStore.setState({ period: 'week' });
}

/** Starts a held live fetch, then moves to the week key. The returned load is
 *  the live one the user has now left. */
function leaveLiveForWeek(): { heldLive: Deferred; liveLoad: Promise<void> } {
  const heldLive = holdFetch('live');
  const liveLoad = load();
  viewWeek();
  return { heldLive, liveLoad };
}

beforeEach(() => {
  getDashboardStats.mockReset();
  getDashboardStats.mockImplementation((_scope, period) => {
    const answer = scriptedAnswers.get(period)?.shift();
    return answer ? answer() : Promise.resolve(cleanPayload(period));
  });
  useUsageDashboardStore.setState(INITIAL_DASHBOARD_STATE);
});

afterEach(async () => {
  // inFlightFetches is module state with no reset, so nothing may stay pending.
  for (const held of heldFetches) held.resolve(cleanPayload('live'));
  await Promise.all(startedLoads);
  heldFetches.length = 0;
  startedLoads.length = 0;
  scriptedAnswers.clear();
});

describe('usage dashboard store: a flagged answer for the active key', () => {
  it('is not cached on a cold key, and clears loading and error', async () => {
    const held = holdFetch('live');
    const loadPromise = load();
    expect(state().activeKey).toBe(LIVE_KEY);
    expect(state().loading).toBe(true);
    // An error left on screen by something else must not outlive the answer.
    useUsageDashboardStore.setState({ error: 'earlier failure' });

    held.resolve(flaggedPayload('live'));
    await loadPromise;

    expect(state().cache[LIVE_KEY]).toBeUndefined();
    expect(Object.keys(state().cache)).toEqual([]);
    expect(state().indexRestarting).toBe(true);
    expect(state().loading).toBe(false);
    expect(state().refreshing).toBe(false);
    expect(state().error).toBeNull();
  });

  it('leaves the cached figures on a warm key exactly as they were', async () => {
    const goodPayload = cleanPayload('live');
    answerWith('live', goodPayload);
    await load();
    const cachedEntry = state().cache[LIVE_KEY];
    expect(cachedEntry.payload).toBe(goodPayload);

    const held = holdFetch('live');
    const reload = load({ force: true });
    expect(state().refreshing).toBe(true);
    held.resolve(flaggedPayload('live'));
    await reload;

    // Same entry object: neither the payload nor fetchedAt was replaced.
    expect(state().cache[LIVE_KEY]).toBe(cachedEntry);
    expect(state().indexRestarting).toBe(true);
    expect(state().refreshing).toBe(false);
    expect(state().loading).toBe(false);
    expect(state().error).toBeNull();
  });
});

describe('usage dashboard store: the restart notice across loads', () => {
  it('survives a same-key forced reload, in flight and after a flagged answer', async () => {
    answerWith('live', flaggedPayload('live'));
    await load();
    expect(state().indexRestarting).toBe(true);

    const held = holdFetch('live');
    const poll = load({ force: true });
    // Only the notice is asserted here: a flagged key is never cached, so the
    // poll reports a cold load each time.
    expect(state().indexRestarting).toBe(true);

    held.resolve(flaggedPayload('live'));
    await poll;
    expect(state().indexRestarting).toBe(true);
  });

  it('clears the moment the user moves to a key that has to fetch', async () => {
    answerWith('live', flaggedPayload('live'));
    await load();
    expect(state().indexRestarting).toBe(true);

    const held = holdFetch('week');
    viewWeek();
    const weekLoad = load();

    expect(state().activeKey).toBe(WEEK_KEY);
    expect(state().indexRestarting).toBe(false);

    held.resolve(cleanPayload('week'));
    await weekLoad;
    expect(state().indexRestarting).toBe(false);
  });

  it('clears on a move to a key whose cache is still fresh, with no fetch', async () => {
    answerWith('live', cleanPayload('live'));
    await load();
    expect(state().cache[LIVE_KEY]).toBeDefined();

    viewWeek();
    answerWith('week', flaggedPayload('week'));
    await load();
    expect(state().activeKey).toBe(WEEK_KEY);
    expect(state().indexRestarting).toBe(true);
    expect(getDashboardStats).toHaveBeenCalledTimes(2);

    useUsageDashboardStore.setState({ period: 'live' });
    await load();

    expect(state().activeKey).toBe(LIVE_KEY);
    expect(state().indexRestarting).toBe(false);
    expect(state().loading).toBe(false);
    expect(state().refreshing).toBe(false);
    expect(getDashboardStats).toHaveBeenCalledTimes(2);
  });

  it('is cleared by a clean answer for the active key, which is then cached', async () => {
    answerWith('live', flaggedPayload('live'));
    await load();
    expect(state().indexRestarting).toBe(true);

    const goodPayload = cleanPayload('live');
    answerWith('live', goodPayload);
    await load({ force: true });

    expect(state().indexRestarting).toBe(false);
    expect(state().cache[LIVE_KEY].payload).toBe(goodPayload);
  });

  it('is cleared by a thrown fetch for the active key, which sets the error', async () => {
    answerWith('live', flaggedPayload('live'));
    await load();
    expect(state().indexRestarting).toBe(true);

    failWith('live', 'index read failed');
    await load({ force: true });

    expect(state().indexRestarting).toBe(false);
    expect(state().error).toBe('index read failed');
    expect(state().loading).toBe(false);
    expect(state().refreshing).toBe(false);
  });
});

describe('usage dashboard store: a late answer for a key the user left', () => {
  it('flagged: leaves the new key loading and the notice off', async () => {
    const { heldLive, liveLoad } = leaveLiveForWeek();
    const heldWeek = holdFetch('week');
    const weekLoad = load();
    expect(state().activeKey).toBe(WEEK_KEY);
    expect(state().loading).toBe(true);

    heldLive.resolve(flaggedPayload('live'));
    await liveLoad;

    expect(state().indexRestarting).toBe(false);
    expect(state().loading).toBe(true);
    expect(state().refreshing).toBe(false);
    expect(state().error).toBeNull();
    expect(state().cache[LIVE_KEY]).toBeUndefined();

    heldWeek.resolve(cleanPayload('week'));
    await weekLoad;
    expect(state().loading).toBe(false);
    expect(state().indexRestarting).toBe(false);
  });

  it('flagged, after the new key answered clean: the notice stays off', async () => {
    const { heldLive, liveLoad } = leaveLiveForWeek();
    const weekPayload = cleanPayload('week');
    answerWith('week', weekPayload);
    await load();
    expect(state().cache[WEEK_KEY].payload).toBe(weekPayload);

    heldLive.resolve(flaggedPayload('live'));
    await liveLoad;

    expect(state().indexRestarting).toBe(false);
    expect(state().loading).toBe(false);
    expect(state().refreshing).toBe(false);
    expect(state().error).toBeNull();
  });

  it('flagged: leaves the error the new key is showing', async () => {
    const { heldLive, liveLoad } = leaveLiveForWeek();
    failWith('week', 'week read failed');
    await load();
    expect(state().error).toBe('week read failed');

    heldLive.resolve(flaggedPayload('live'));
    await liveLoad;

    expect(state().error).toBe('week read failed');
    expect(state().indexRestarting).toBe(false);
  });

  it('clean: is cached under its own key and leaves a flagged new key flagged', async () => {
    const { heldLive, liveLoad } = leaveLiveForWeek();
    answerWith('week', flaggedPayload('week'));
    await load();
    expect(state().indexRestarting).toBe(true);

    const latePayload = cleanPayload('live');
    heldLive.resolve(latePayload);
    await liveLoad;

    expect(state().cache[LIVE_KEY].payload).toBe(latePayload);
    expect(state().cache[WEEK_KEY]).toBeUndefined();
    expect(state().activeKey).toBe(WEEK_KEY);
    expect(state().indexRestarting).toBe(true);
  });

  it('thrown: leaves a flagged new key flagged and sets no error', async () => {
    const { heldLive, liveLoad } = leaveLiveForWeek();
    answerWith('week', flaggedPayload('week'));
    await load();
    expect(state().indexRestarting).toBe(true);

    heldLive.reject(new Error('late failure'));
    await liveLoad;

    expect(state().indexRestarting).toBe(true);
    expect(state().error).toBeNull();
  });
});
