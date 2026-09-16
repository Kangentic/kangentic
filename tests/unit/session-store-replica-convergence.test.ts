/**
 * The renderer session store is a REPLICA of main's session registry, kept
 * current by pushes (`session:status`, `session:exit`, `session:removed`,
 * `session:usage`, `session:activity`), by the renderer's own optimistic
 * writes (a To Do move evicts the task's rows before main has torn them
 * down), and by `syncSessions`, whose list can be stale by the time it lands.
 *
 * Every earlier round of this bug class fixed ONE writer or ONE push and
 * pinned that one path: the ghost `running` row after a To Do reset (#636),
 * the stale suspended row masking a live agent (one row per task), the index
 * left pointing at an evicted row, the handoff Resume flash (#638), and #661,
 * where the removal announcement itself re-seeded the row it reported gone.
 * None of those tests could see the next interleaving. This one states the
 * property those fixes were all reaching for and checks it over hundreds of
 * random interleavings:
 *
 *   Once main is quiescent and every push it generated has landed, the
 *   renderer holds exactly main's rows (same ids, same statuses), its task
 *   index agrees with its rows, and no per-session map holds an id main no
 *   longer has.
 *
 * The harness drives the REAL Zustand store with the REAL store actions,
 * through the same mapping `App.tsx` applies to each push (a status push
 * upserts, a non-intentional exit patches the status in place, an intentional
 * exit is ignored, a removal drops by id). That mapping is pinned by source
 * in the last describe so the model cannot silently drift from the app.
 *
 * Seeded PRNG (mulberry32), so a failure prints its seed and replays exactly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { ActivityState, Session, SessionStatus, SessionUsage } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store. `sessions.list` and the
// cache fetches are swapped per sync by the harness below.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      reconcile: async () => null,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
      getFirstOutput: async () => ({}),
      getMessageTrails: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
    },
  },
};

import { useSessionStore } from '../../src/renderer/stores/session-store';
import { withoutSessionsForTasks } from '../../src/renderer/stores/session-store/session-index';

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The model of main: a registry, plus the pushes it generates. Pushes are
// delivered to the renderer in emission order, which is the one ordering the
// IPC channel guarantees. The renderer's optimistic writes happen at the point
// in the sequence where the user gesture would fire them.
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-replica';

type RegistryRow = { id: string; taskId: string; status: SessionStatus };

function toSession(row: RegistryRow): Session {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: PROJECT_ID,
    pid: row.status === 'running' ? 100 : null,
    status: row.status,
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-16T15:00:00.000Z',
    exitCode: row.status === 'exited' ? 1 : null,
    resuming: false,
    agentSessionId: null,
  };
}

function makeUsage(sessionId: string): SessionUsage {
  return {
    model: { id: 'claude-opus-5', displayName: 'Opus 5' },
    contextWindow: {
      usedPercentage: 11,
      usedTokens: 1000,
      cacheTokens: 0,
      totalInputTokens: 800,
      totalOutputTokens: 200,
      contextWindowSize: 1000000,
    },
    cost: { totalCostUsd: sessionId.length / 100, totalDurationMs: 1000 },
  };
}

/** What App.tsx does with each push, in the same order main emits them. */
const renderer = {
  onStatus(session: Session): void {
    useSessionStore.getState().upsertSession(session);
  },
  onExit(sessionId: string, exitCode: number, intentional: boolean): void {
    const current = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
    if (intentional || current?.status === 'suspended') return;
    useSessionStore.getState().updateSessionStatus(sessionId, { status: 'exited', exitCode });
  },
  onRemoved(sessionId: string): void {
    useSessionStore.getState().removeSession(sessionId);
  },
  onUsage(sessionId: string, usage: SessionUsage): void {
    useSessionStore.getState().updateUsage(sessionId, usage);
  },
  onActivity(sessionId: string, state: ActivityState): void {
    useSessionStore.getState().updateActivity(sessionId, state, { kind: state === 'thinking' ? 'turn-active' : 'idle', since: 1 });
  },
  evictTask(taskId: string): void {
    // task-slice.ts moveTask, the todo-role branch.
    useSessionStore.setState((state) => ({ ...withoutSessionsForTasks(state.sessions, taskId) }));
  },
};

class MainModel {
  readonly registry = new Map<string, RegistryRow>();
  readonly usage = new Map<string, SessionUsage>();
  readonly activity = new Map<string, ActivityState>();
  private nextId = 1;
  /** Syncs whose list was issued but not yet answered, oldest first. */
  readonly pendingSyncs: Array<{ snapshot: Session[]; resolve: (sessions: Session[]) => void; done: Promise<boolean> }> = [];

  constructor(private readonly random: () => number) {}

  pick<T>(items: T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.random() * items.length)];
  }

  rows(): RegistryRow[] {
    return [...this.registry.values()];
  }

  rowsForTask(taskId: string): RegistryRow[] {
    return this.rows().filter((row) => row.taskId === taskId);
  }

  /** A spawn is one row per task: main removes a task's earlier row before
   *  registering the new one, and each step announces itself. */
  spawn(taskId: string): void {
    for (const previous of this.rowsForTask(taskId)) this.removeRow(previous.id);
    const row: RegistryRow = { id: `sess-${this.nextId++}`, taskId, status: 'running' };
    this.registry.set(row.id, row);
    this.activity.set(row.id, 'idle');
    renderer.onStatus(toSession(row));
  }

  suspend(sessionId: string): void {
    const row = this.registry.get(sessionId);
    if (!row || row.status !== 'running') return;
    // suspend(): status flips and is pushed BEFORE the PTY comes down; the
    // exit that follows is tagged intentional.
    row.status = 'suspended';
    this.activity.delete(row.id);
    renderer.onStatus(toSession(row));
    renderer.onExit(row.id, 1, true);
  }

  crash(sessionId: string): void {
    const row = this.registry.get(sessionId);
    if (!row || row.status !== 'running') return;
    // The natural exit path emits only 'exit', never a status push.
    row.status = 'exited';
    this.activity.delete(row.id);
    renderer.onExit(row.id, 1, false);
  }

  /** remove(): kill (an intentional exit if a PTY was live), then the
   *  removal announcement. The two can land in either order in practice
   *  (the deferred kill's exit fires after the row is gone), so the model
   *  randomizes it. */
  private removeRow(sessionId: string): void {
    const row = this.registry.get(sessionId);
    if (!row) return;
    const wasRunning = row.status === 'running';
    this.registry.delete(sessionId);
    this.usage.delete(sessionId);
    this.activity.delete(sessionId);
    const exitFirst = this.random() < 0.5;
    if (wasRunning && exitFirst) renderer.onExit(sessionId, -1, true);
    renderer.onRemoved(sessionId);
    if (wasRunning && !exitFirst) renderer.onExit(sessionId, -1, true);
  }

  /** The #661 shape: the renderer evicts the task's rows the instant the move
   *  starts, main tears the sessions down afterwards. */
  moveToTodo(taskId: string): void {
    renderer.evictTask(taskId);
    for (const row of this.rowsForTask(taskId)) this.removeRow(row.id);
  }

  /** Project delete, SESSION_RESET, an aborted spawn: main removes with no
   *  renderer eviction first. */
  removeDirect(sessionId: string): void {
    this.removeRow(sessionId);
  }

  /** The `cleanup_worktree` shape: kill + awaitExit, KEEP the registry row,
   *  then `announceSessionEnded` re-emits it on 'session-changed' with its
   *  resolved status. The kill's own exit is intentional, so the renderer
   *  ignores it and this status push is the ONLY thing that corrects the
   *  replica; a bare kill left the card spinning for an agent that was gone. */
  announceEnded(sessionId: string): void {
    const row = this.registry.get(sessionId);
    if (!row || row.status !== 'running') return;
    row.status = 'exited';
    renderer.onExit(sessionId, -1, true);
    renderer.onStatus(toSession(row));
  }

  usageTick(sessionId: string): void {
    const row = this.registry.get(sessionId);
    if (!row || row.status !== 'running') return;
    const usage = makeUsage(sessionId);
    this.usage.set(sessionId, usage);
    renderer.onUsage(sessionId, usage);
  }

  activityTick(sessionId: string): void {
    const row = this.registry.get(sessionId);
    if (!row || row.status !== 'running') return;
    const state: ActivityState = this.random() < 0.5 ? 'thinking' : 'idle';
    this.activity.set(sessionId, state);
    renderer.onActivity(sessionId, state);
  }

  /** Issue a sync whose list is answered later (`resolvePendingSync`), so
   *  events can land in the gap. The cache fetches answer with main's live
   *  maps at RESOLUTION time, which is when main would read them. */
  startSync(): void {
    const snapshot = this.rows().map(toSession);
    let resolveList: (sessions: Session[]) => void = () => {};
    const listPromise = new Promise<Session[]>((resolve) => { resolveList = resolve; });
    const api = (window as Record<string, unknown> & {
      electronAPI: { sessions: Record<string, () => Promise<unknown>> };
    }).electronAPI.sessions;
    api.list = () => listPromise;
    api.getUsage = async () => Object.fromEntries(this.usage);
    api.getActivity = async () => Object.fromEntries(this.activity);
    const done = useSessionStore.getState().syncSessions();
    this.pendingSyncs.push({ snapshot, resolve: resolveList, done });
  }

  async resolvePendingSync(): Promise<void> {
    const pending = this.pendingSyncs.shift();
    if (!pending) return;
    pending.resolve(pending.snapshot);
    await pending.done;
  }

  async resolveAllSyncs(): Promise<void> {
    while (this.pendingSyncs.length > 0) await this.resolvePendingSync();
  }
}

const TASKS = ['task-a', 'task-b', 'task-c', 'task-d'];

async function runSequence(seed: number, steps: number): Promise<void> {
  const random = mulberry32(seed);
  const main = new MainModel(random);
  for (let step = 0; step < steps; step++) {
    const roll = random();
    const anyRow = main.pick(main.rows());
    const runningRow = main.pick(main.rows().filter((row) => row.status === 'running'));
    if (roll < 0.22) main.spawn(main.pick(TASKS)!);
    else if (roll < 0.34 && runningRow) main.suspend(runningRow.id);
    else if (roll < 0.40 && runningRow) main.crash(runningRow.id);
    else if (roll < 0.52 && anyRow) main.moveToTodo(anyRow.taskId);
    else if (roll < 0.56 && runningRow) main.announceEnded(runningRow.id);
    else if (roll < 0.64 && anyRow) main.removeDirect(anyRow.id);
    else if (roll < 0.76 && runningRow) main.usageTick(runningRow.id);
    else if (roll < 0.84 && runningRow) main.activityTick(runningRow.id);
    else if (roll < 0.92) main.startSync();
    else await main.resolvePendingSync();
    // A sync may await inside syncSessions; let the store's own microtasks
    // settle between steps so the interleaving is the one we intend.
    await Promise.resolve();
  }
  await main.resolveAllSyncs();
  assertConverged(main, seed);
}

function assertConverged(main: MainModel, seed: number): void {
  const label = `seed ${seed}`;
  const state = useSessionStore.getState();
  const expectedRows = main.rows().map((row) => ({ id: row.id, status: row.status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actualRows = state.sessions.map((session) => ({ id: session.id, status: session.status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  expect(actualRows, `${label}: renderer rows differ from main's registry`).toEqual(expectedRows);

  // The task index agrees with the rows: one entry per task that has a row,
  // pointing at one of that task's rows, and no entry for a task without one.
  const tasksWithRows = new Set(state.sessions.map((session) => session.taskId));
  expect([...state._sessionByTaskId.keys()].sort(), `${label}: index keys`).toEqual([...tasksWithRows].sort());
  for (const [taskId, indexed] of state._sessionByTaskId) {
    expect(state.sessions.some((session) => session.id === indexed.id && session.taskId === taskId), `${label}: index for ${taskId}`).toBe(true);
  }

  const liveIds = new Set(main.rows().map((row) => row.id));
  const keyedMaps: Array<[string, Record<string, unknown>]> = [
    ['sessionUsage', state.sessionUsage],
    ['sessionActivity', state.sessionActivity],
    ['sessionActivityReason', state.sessionActivityReason],
    ['sessionEvents', state.sessionEvents],
    ['sessionFirstOutput', state.sessionFirstOutput],
    ['seenIdleSessions', state.seenIdleSessions],
    ['sessionMessageTrails', state.sessionMessageTrails],
  ];
  for (const [name, map] of keyedMaps) {
    const strays = Object.keys(map).filter((sessionId) => !liveIds.has(sessionId));
    expect(strays, `${label}: ${name} holds ids main no longer has`).toEqual([]);
  }
  if (state.activeSessionId !== null) {
    expect(liveIds.has(state.activeSessionId), `${label}: activeSessionId points at a removed session`).toBe(true);
  }
}

function resetStore(): void {
  useSessionStore.setState({
    sessions: [],
    _sessionByTaskId: new Map(),
    activeSessionId: null,
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionActivityReason: {},
    sessionEvents: {},
    seenIdleSessions: {},
    sessionMessageTrails: {},
    spawnProgress: {},
    pendingCommandLabel: {},
  });
}

describe('the renderer session store converges on main\'s registry', () => {
  beforeEach(resetStore);

  it('the measured #661 sequence: evict, intentional exit, removal', () => {
    const main = new MainModel(mulberry32(661));
    main.spawn('task-a');
    main.usageTick(main.rows()[0].id);
    main.moveToTodo('task-a');
    assertConverged(main, 661);
    expect(useSessionStore.getState().sessions).toEqual([]);
  });

  it('the #80 sequence: a status push landing after the eviction, then the removal', () => {
    const main = new MainModel(mulberry32(80));
    main.spawn('task-a');
    const row = main.rows()[0];
    renderer.evictTask('task-a');
    // The mid-grace status push that resurrected the row as running.
    renderer.onStatus(toSession(row));
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    main.removeDirect(row.id);
    assertConverged(main, 80);
  });

  it('a kill that KEEPS its row is corrected by announceSessionEnded, not left running', () => {
    // The cleanup_worktree seam. The kill's exit is intentional, so App.tsx
    // ignores it; without the announcement the replica stays on 'running' and
    // the card keeps its spinner for an agent that is gone. Main-side tests
    // pin that the announcement fires; this pins that the renderer acts on it.
    const main = new MainModel(mulberry32(424));
    main.spawn('task-a');
    const row = main.rows()[0];
    main.usageTick(row.id);

    main.announceEnded(row.id);

    assertConverged(main, 424);
    const replicaRow = useSessionStore.getState().sessions.find((session) => session.id === row.id);
    expect(replicaRow?.status).toBe('exited');
    // The row is KEPT, so its usage stays readable beside the finished terminal.
    expect(row.id in useSessionStore.getState().sessionUsage).toBe(true);
  });

  it('a stale sync straddling a To Do move does not resurrect the removed row', async () => {
    const main = new MainModel(mulberry32(3));
    main.spawn('task-a');
    main.spawn('task-b');
    main.startSync();
    await Promise.resolve();
    main.moveToTodo('task-a');
    await main.resolveAllSyncs();
    assertConverged(main, 3);
    expect(useSessionStore.getState().sessions.map((session) => session.taskId)).toEqual(['task-b']);
  });

  it('holds over random interleavings of spawns, suspends, crashes, moves, removals, ticks, and stale syncs', async () => {
    // Each seed replays exactly; a failure names the seed to reproduce.
    for (let seed = 1; seed <= 300; seed++) {
      resetStore();
      await runSequence(seed, 40);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The model above is only as honest as App.tsx's push handling. Pin the
// mapping by source so a handler rewrite cannot leave this test modelling an
// app that no longer exists.
// ---------------------------------------------------------------------------

describe('App.tsx routes each session push the way the model assumes', () => {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/App.tsx'), 'utf8');

  function handlerBody(subscription: string): string {
    const start = appSource.indexOf(subscription);
    expect(start, `${subscription} is subscribed in App.tsx`).toBeGreaterThan(-1);
    // Up to the next `sessions.on` subscription (or the end of the effect).
    const rest = appSource.slice(start + subscription.length);
    const next = rest.search(/\n\s+\/\/ .*\n\s+if \(sessions\.on|\n\s+if \(sessions\.on|\n\s+const monitorApi/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('a status push upserts, and only upserts', () => {
    const body = handlerBody('sessions.onStatus(');
    expect(body).toContain('upsertSession(session)');
    expect(body).not.toContain('removeSession(');
  });

  it('a removal push drops by id, and only drops', () => {
    const body = handlerBody('sessions.onRemoved(');
    expect(body).toContain('removeSession(sessionId)');
    expect(body).not.toContain('upsertSession(');
  });

  it('a removal push routes through the same coalescer as the status push', () => {
    // So a removal and a status push for the same id apply in arrival order
    // (session-replica-contract.md). The two assertions above alone pass
    // against a revert that calls removeSession(sessionId) unwrapped, since
    // neither checks for enqueueSessionUpdate; this one ties the wrapping to
    // the removeSession call specifically, not merely to its presence
    // somewhere in the handler body.
    const body = handlerBody('sessions.onRemoved(');
    expect(body).toMatch(/enqueueSessionUpdate\(\s*\(\)\s*=>\s*\{?\s*removeSession\(sessionId\)/);
  });

  it('an intentional exit is ignored; a crash patches the status in place', () => {
    const body = handlerBody('sessions.onExit(');
    expect(body).toMatch(/if \(intentional \|\| currentSession\?\.status === 'suspended'\) return;/);
    expect(body).toContain("updateSessionStatus(sessionId, { status: 'exited', exitCode })");
    expect(body).not.toContain('upsertSession(');
  });
});
