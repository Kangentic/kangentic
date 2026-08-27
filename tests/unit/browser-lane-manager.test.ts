import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { browserPartitionForTask } from '../../src/shared/browser-partition';

/**
 * Lane bookkeeping and lifetime.
 *
 * Electron is mocked, so this covers the parts that are ours: the per-task cap,
 * the cookie-jar choice, registration as `kind: 'lane'`, and - most importantly
 * - that every cleanup backstop actually destroys the window. The OSR mechanics
 * (does an offscreen window composite, does CDP capture resolve, does input
 * land) are not unit-testable at all; they were measured against a real
 * Electron 41.1.1 build and the results are recorded in the plan.
 */

interface FakeWindow {
  id: number;
  destroyed: boolean;
  webContents: {
    id: number;
    setFrameRate: (fps: number) => void;
    loadURL: (url: string) => Promise<void>;
    once: (event: string, handler: () => void) => void;
    isDestroyed: () => boolean;
  };
  isDestroyed: () => boolean;
  destroy: () => void;
}

let created: Array<{ options: Record<string, unknown>; window: FakeWindow }> = [];
let nextId = 100;
let loadShouldFail = false;

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      const id = (nextId += 1);
      const win: FakeWindow = {
        id,
        destroyed: false,
        webContents: {
          id,
          setFrameRate: vi.fn(),
          loadURL: vi.fn(async () => {
            if (loadShouldFail) throw new Error('ERR_CONNECTION_REFUSED');
          }),
          once: vi.fn(),
          isDestroyed: () => win.destroyed,
        },
        isDestroyed: () => win.destroyed,
        destroy: () => { win.destroyed = true; },
      };
      created.push({ options, window: win });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake stands in for a BrowserWindow
      return win as any;
    }
  },
  // openLane now syncs the task jar with the project identity jar before creating
  // the window; a minimal session stub lets that run without erroring.
  session: {
    fromPartition: () => ({
      cookies: { get: async () => [], set: async () => undefined, flushStore: async () => undefined, on: () => undefined },
    }),
  },
}));

const registered: Array<Record<string, unknown>> = [];
const unregistered: Array<{ sessionId: string; reason?: string }> = [];

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: (input: Record<string, unknown>) => { registered.push(input); },
    unregister: (sessionId: string, reason?: string) => { unregistered.push({ sessionId, reason }); },
    unregisterByWebContentsId: vi.fn(),
  },
}));

// openLane seeds the task jar from the project identity jar before creating
// the window, bounded by JAR_SEED_TIMEOUT_MS. Mocking the module directly
// (rather than the underlying session.cookies calls) lets tests control
// timing (a never-resolving sync) and assert call args/ordering precisely.
const fakeSyncJarFromIdentity = vi.fn();

vi.mock('../../src/main/browser/jar-seeder', () => ({
  syncJarFromIdentity: fakeSyncJarFromIdentity,
}));

const {
  openLane,
  destroyLane,
  destroyLanesForSession,
  destroyIdleLanes,
  destroyHandoffLanesForTask,
  hasHandoffLaneForTask,
  touchLane,
  LANE_IDLE_RECLAIM_MS,
  destroyAllLanes,
  laneCountForTask,
  laneIdsForTask,
  isLaneId,
  resetLanesForTests,
  MAX_LANES_PER_TASK,
  LANE_FRAME_RATE,
} = await import('../../src/main/browser/browser-lane-manager');

const input = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'task-1',
  projectId: 'project-1',
  ownerSessionId: 'session-1',
  url: 'http://localhost:4200',
  ...overrides,
});

beforeEach(() => {
  created = [];
  registered.length = 0;
  unregistered.length = 0;
  loadShouldFail = false;
  resetLanesForTests();
  fakeSyncJarFromIdentity.mockReset();
  fakeSyncJarFromIdentity.mockResolvedValue(undefined);
});

afterEach(() => {
  resetLanesForTests();
});

describe('openLane', () => {
  it('registers the lane so existing tools can target it by sessionId', async () => {
    // The whole point of living in the shared registry: withGuest needed no
    // change to drive a lane, and no tool needed a new argument.
    const result = await openLane(input());
    expect(result.ok).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ taskId: 'task-1', projectId: 'project-1', kind: 'lane' });
    expect(isLaneId(registered[0].sessionId as string)).toBe(true);
  });

  it('creates an OFFSCREEN, never-shown window', async () => {
    await openLane(input());
    const options = created[0].options as { show: boolean; webPreferences: Record<string, unknown> };
    expect(options.show).toBe(false);
    expect(options.webPreferences.offscreen).toBe(true);
  });

  it('throttles the frame rate so an unwatched animating page cannot burn CPU', async () => {
    // Offscreen rendering copies a FULL frame bitmap per paint, so the default
    // 60fps against a lane nobody is watching is the real cost risk.
    await openLane(input());
    expect(created[0].window.webContents.setFrameRate).toHaveBeenCalledWith(LANE_FRAME_RATE);
  });

  it('shares the task cookie jar (keyed by task identity) rather than minting a fresh one', async () => {
    // A private jar would land every worker on a sign-in wall for an app the
    // user is already authenticated into. The jar is keyed by project + task.
    await openLane(input());
    const options = created[0].options as { webPreferences: { partition: string } };
    expect(options.webPreferences.partition).toBe('persist:kng-project1-task1');
  });

  it('refuses past the per-task cap and names the lanes to reuse', async () => {
    for (let index = 0; index < MAX_LANES_PER_TASK; index += 1) {
      const created = await openLane(input());
      expect(created.ok).toBe(true);
    }
    const overflow = await openLane(input());
    expect(overflow).toMatchObject({ ok: false, kind: 'lane-limit' });
    if (overflow.ok) throw new Error('expected a refusal');
    // Actionable rather than a bare "no": a retrying agent needs to be told to
    // reuse the handle it already holds.
    expect(overflow.detail).toContain('reuse it by passing its sessionId');
    for (const laneId of laneIdsForTask('task-1')) expect(overflow.detail).toContain(laneId);
  });

  it('counts lanes per task, not globally', async () => {
    await openLane(input());
    await openLane(input({ taskId: 'task-2' }));
    expect(laneCountForTask('task-1')).toBe(1);
    expect(laneCountForTask('task-2')).toBe(1);
  });

  it('destroys the window and registers nothing when the URL fails to load', async () => {
    loadShouldFail = true;
    const result = await openLane(input());
    expect(result).toMatchObject({ ok: false, kind: 'lane-load-failed' });
    expect(registered).toHaveLength(0);
    expect(created[0].window.destroyed).toBe(true);
    expect(laneCountForTask('task-1')).toBe(0);
  });
});

describe('lane cleanup backstops', () => {
  it('destroys the window and unregisters on an explicit close', async () => {
    const lane = await openLane(input());
    if (!lane.ok) throw new Error('expected a lane');
    expect(destroyLane(lane.laneId)).toBe(true);
    expect(created[0].window.destroyed).toBe(true);
    // Reported as a lane teardown, not a renderer unmount. A lane has no
    // renderer, and a wrong reason points an investigation at the wrong
    // process - which is precisely what the reason enum exists to prevent.
    expect(unregistered).toContainEqual({ sessionId: lane.laneId, reason: 'lane-destroyed' });
    // Idempotent: a second close is a no-op, not a throw.
    expect(destroyLane(lane.laneId)).toBe(false);
  });

  it('destroys only the owning session"s lanes', async () => {
    // Session end is the GUARANTEE, because only one of the ten supported agent
    // CLIs has a SubagentStop hook to fire a faster signal.
    await openLane(input({ ownerSessionId: 'session-a' }));
    await openLane(input({ ownerSessionId: 'session-b' }));
    expect(destroyLanesForSession('session-a')).toBe(1);
    expect(laneCountForTask('task-1')).toBe(1);
  });

  it('closes only the AUTO hand-off lanes, never one the agent asked for', async () => {
    // Closing an agent's deliberately-requested lane because a human opened an
    // unrelated pane would be the same class of bug this whole task is about.
    const requested = await openLane(input());
    const handedOff = await openLane(input({ handoff: true }));
    if (!requested.ok || !handedOff.ok) throw new Error('expected two lanes');

    expect(destroyHandoffLanesForTask('task-1')).toBe(1);
    expect(laneIdsForTask('task-1')).toEqual([requested.laneId]);
  });

  it('reclaims only lanes idle past the threshold', async () => {
    const lane = await openLane(input());
    if (!lane.ok) throw new Error('expected a lane');
    expect(destroyIdleLanes(60_000, Date.now())).toBe(0);
    expect(destroyIdleLanes(60_000, Date.now() + 61_000)).toBe(1);
  });

  it('spares a lane a drive has touched', async () => {
    // Without touchLane, `lastUsedAt` would be frozen at creation and the
    // reclaim would close lanes an agent is actively working in. withGuest
    // calls it on every drive, which is what makes the threshold mean "idle"
    // rather than "old".
    const lane = await openLane(input());
    if (!lane.ok) throw new Error('expected a lane');

    // Age it past the threshold, then drive it. The touch has to move the clock
    // forward WITH the lane, which is why the system time advances before it
    // rather than the check being handed a future timestamp.
    vi.setSystemTime(Date.now() + 61_000);
    expect(destroyIdleLanes(60_000)).toBe(1);

    const second = await openLane(input());
    if (!second.ok) throw new Error('expected a second lane');
    vi.setSystemTime(Date.now() + 61_000);
    touchLane(second.laneId);
    expect(destroyIdleLanes(60_000)).toBe(0);
  });

  it('touching an unknown session is a harmless no-op', () => {
    // Every drive calls this, and most drives are against ordinary panes.
    expect(() => touchLane('session-that-is-not-a-lane')).not.toThrow();
  });

  it('reclaims abandoned lanes before refusing at the cap', async () => {
    // A long-lived session that opened and forgot lanes must not be refused a
    // new one over renderer processes nothing is using.
    for (let index = 0; index < MAX_LANES_PER_TASK; index += 1) {
      await openLane(input());
    }
    expect(laneCountForTask('task-1')).toBe(MAX_LANES_PER_TASK);

    // Age every existing lane past the reclaim threshold.
    vi.setSystemTime(Date.now() + LANE_IDLE_RECLAIM_MS + 1_000);

    const fresh = await openLane(input());
    expect(fresh.ok).toBe(true);
    expect(laneCountForTask('task-1')).toBe(1);
  });

  it('destroys everything synchronously on shutdown', async () => {
    await openLane(input());
    await openLane(input({ taskId: 'task-2' }));
    destroyAllLanes();
    expect(created.every((entry) => entry.window.destroyed)).toBe(true);
    expect(laneCountForTask('task-1')).toBe(0);
    expect(laneCountForTask('task-2')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Jar seeding: openLane syncs the task's cookie jar from the project identity
// jar BEFORE the offscreen guest attaches, bounded by JAR_SEED_TIMEOUT_MS so a
// stalled sync degrades to an unseeded lane rather than hanging
// kangentic_browser_open_pane. Appended last (fake-timer block) so it cannot
// interact with the vi.setSystemTime drift the idle-reclaim tests above rely
// on; vi.useRealTimers() at the end restores real timers for any later file.
// ---------------------------------------------------------------------------

describe('openLane jar seeding', () => {
  it('syncs the task jar from the project identity BEFORE constructing the window', async () => {
    let windowCountDuringSync = -1;
    fakeSyncJarFromIdentity.mockImplementation(async () => {
      windowCountDuringSync = created.length;
    });

    const result = await openLane(input());

    expect(result.ok).toBe(true);
    // The sync ran while no BrowserWindow had been created yet.
    expect(windowCountDuringSync).toBe(0);
    expect(fakeSyncJarFromIdentity).toHaveBeenCalledWith(
      browserPartitionForTask('project-1', 'task-1'),
      'project-1',
    );
  });

  it('does not hang openLane when syncJarFromIdentity never resolves; the JAR_SEED_TIMEOUT_MS cap lets it proceed', async () => {
    fakeSyncJarFromIdentity.mockReturnValue(new Promise<void>(() => {}));
    vi.useFakeTimers();
    try {
      const resultPromise = openLane(input());

      // Just under the cap: openLane must still be blocked on the seed,
      // meaning the window has not been constructed yet.
      await vi.advanceTimersByTimeAsync(2_999);
      expect(created).toHaveLength(0);

      // The cap elapses: openLane proceeds to create the window even though
      // syncJarFromIdentity is still pending forever.
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
