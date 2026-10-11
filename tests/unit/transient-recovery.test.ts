import { describe, it, expect } from 'vitest';
import {
  planTransientRecovery,
  findAdoptableTransientSession,
} from '../../src/renderer/stores/session-store/transient-recovery';
import type { TransientSessionEntry } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { Session } from '../../src/shared/types';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

/** A live Command Terminal PTY row as `sessions.list()` delivers it. */
function transientSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    taskId: overrides.id,
    projectId: PROJECT_A,
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-09-08T12:00:00.000Z',
    exitCode: null,
    resuming: false,
    transient: true,
    commandTerminalSlot: null,
    commandTerminalBranch: null,
    commandTerminalLabel: null,
    isolatedSwimlaneId: null,
    agentSessionId: null,
    ...overrides,
  };
}

/** A task agent's session row: never transient, never paired to a slot. */
function taskSession(id: string): Session {
  return transientSession({ id, transient: false });
}

function transientMap(entries: TransientSessionEntry[]): Record<string, TransientSessionEntry> {
  const map: Record<string, TransientSessionEntry> = {};
  for (const entry of entries) map[`${entry.projectId}::${entry.slot}`] = entry;
  return map;
}

describe('planTransientRecovery', () => {
  it('re-pairs each survivor to the slot main recorded, not to a dense position', () => {
    // The whole point of carrying commandTerminalSlot. The old `slot-${index + 1}`
    // guess would have produced slot-1 / slot-2 here, so a window titled "Command
    // Terminal 2" would show the terminal that actually ran as number 5.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'sess-2', commandTerminalSlot: 'slot-2', commandTerminalBranch: 'main' }),
        transientSession({ id: 'sess-5', commandTerminalSlot: 'slot-5', commandTerminalBranch: 'feature/x' }),
      ],
      transientSessions: {},
    });

    expect(recovered).not.toBeNull();
    expect(recovered![`${PROJECT_A}::slot-2`]).toEqual({
      projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2', branch: 'main',
    });
    expect(recovered![`${PROJECT_A}::slot-5`]).toEqual({
      projectId: PROJECT_A, slot: 'slot-5', sessionId: 'sess-5', branch: 'feature/x',
    });
    expect(Object.keys(recovered!)).toHaveLength(2);
  });

  it('pairs survivors whose ids sort the opposite way to their slots', () => {
    // The existing hard-reload fixture is green only because its ids happen to
    // sort into slot order. Reverse that and the old uuid sort mis-pairs both.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'zzz', commandTerminalSlot: 'slot-1' }),
        transientSession({ id: 'aaa', commandTerminalSlot: 'slot-2' }),
      ],
      transientSessions: {},
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('zzz');
    expect(recovered![`${PROJECT_A}::slot-2`].sessionId).toBe('aaa');
  });

  it('keeps a live paired entry and re-homes a survivor that claims the same slot', () => {
    // The reported production failure. A post-reload spawn took slot-1 while the
    // survivor stamped slot-1 was still running. Last-wins would orphan one of
    // them; the live window keeps its slot and the survivor moves to slot-2.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'survivor', commandTerminalSlot: 'slot-1', startedAt: '2026-09-08T19:45:39.000Z' }),
        transientSession({ id: 'fresh-spawn', commandTerminalSlot: 'slot-1', startedAt: '2026-09-08T19:53:54.000Z' }),
      ],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'fresh-spawn', branch: 'main' },
      ]),
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('fresh-spawn');
    expect(recovered![`${PROJECT_A}::slot-2`].sessionId).toBe('survivor');
    // Neither PTY is left unreachable, which is the actual bug.
    const pairedIds = Object.values(recovered!).map((entry) => entry.sessionId).sort();
    expect(pairedIds).toEqual(['fresh-spawn', 'survivor']);
  });

  it('recovers a project that is not the current one', () => {
    // The old block was wrapped in `if (currentProjectId)`, so a background
    // project's terminals were never re-paired. The planner has no such concept.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'a-1', projectId: PROJECT_A, commandTerminalSlot: 'slot-1' }),
        transientSession({ id: 'b-1', projectId: PROJECT_B, commandTerminalSlot: 'slot-1' }),
      ],
      transientSessions: {},
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('a-1');
    expect(recovered![`${PROJECT_B}::slot-1`].sessionId).toBe('b-1');
  });

  it('is not blocked by a project that already has one tracked entry', () => {
    // The `alreadyTracked` gate: one entry made the whole project look recovered,
    // so a second survivor stayed orphaned forever.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'tracked', commandTerminalSlot: 'slot-1' }),
        transientSession({ id: 'orphan', commandTerminalSlot: 'slot-2' }),
      ],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'tracked', branch: 'main' },
      ]),
    });

    expect(recovered![`${PROJECT_A}::slot-2`].sessionId).toBe('orphan');
  });

  it('gives unslotted survivors the lowest free slots, oldest first', () => {
    // A null slot is a real case (a session spawned before the slot plumbing, or
    // by a path that sends none), so it must still be paired rather than dropped.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'newer', startedAt: '2026-09-08T12:00:02.000Z' }),
        transientSession({ id: 'older', startedAt: '2026-09-08T12:00:01.000Z' }),
      ],
      transientSessions: {},
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('older');
    expect(recovered![`${PROJECT_A}::slot-2`].sessionId).toBe('newer');
  });

  it('breaks a startedAt tie by id so the pairing is deterministic', () => {
    const recovered = planTransientRecovery({
      sessions: [transientSession({ id: 'hr-sess-2' }), transientSession({ id: 'hr-sess-1' })],
      transientSessions: {},
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('hr-sess-1');
    expect(recovered![`${PROJECT_A}::slot-2`].sessionId).toBe('hr-sess-2');
  });

  it('lets a slotted survivor keep its slot while an unslotted one fills around it', () => {
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'slotted', commandTerminalSlot: 'slot-1', startedAt: '2026-09-08T12:00:02.000Z' }),
        transientSession({ id: 'unslotted', startedAt: '2026-09-08T12:00:01.000Z' }),
      ],
      transientSessions: {},
    });

    // Exact re-pairs are assigned before any lowest-free fill, so the unslotted
    // row cannot take slot-1 out from under the row that actually ran there.
    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('slotted');
    expect(recovered![`${PROJECT_A}::slot-2`].sessionId).toBe('unslotted');
  });

  it('re-pairs a named survivor without copying its name: the window title reads the session row', () => {
    // Main names a Command Terminal and keeps the name on its session row, so
    // the pairing entry carries none and a recovered terminal keeps its name
    // through the replica alone.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'named', commandTerminalSlot: 'slot-1', commandTerminalLabel: 'Fix the parser' }),
      ],
      transientSessions: {},
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('named');
    expect(recovered![`${PROJECT_A}::slot-1`]).not.toHaveProperty('label');
  });

  it('preserves an already-paired entry verbatim, including the branch the HEAD tracker corrected', () => {
    // syncSessions is Pattern B, so this runs on every Fast Refresh, and
    // rewriting the entry from the row would put the spawn-time branch back.
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'paired', commandTerminalSlot: 'slot-1', commandTerminalBranch: 'main' }),
        transientSession({ id: 'orphan', commandTerminalSlot: 'slot-2' }),
      ],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'paired', branch: 'feature/live-head' },
      ]),
    });

    expect(recovered![`${PROJECT_A}::slot-1`].branch).toBe('feature/live-head');
  });

  it('frees a stale entry slot for a survivor that claims it', () => {
    const recovered = planTransientRecovery({
      sessions: [
        { ...transientSession({ id: 'dead' }), status: 'exited' },
        transientSession({ id: 'survivor', commandTerminalSlot: 'slot-1' }),
      ],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'dead', branch: 'main' },
      ]),
    });

    expect(recovered![`${PROJECT_A}::slot-1`].sessionId).toBe('survivor');
  });

  it('returns null when every survivor is already paired', () => {
    // Reference identity matters: this is the common case on every sync, and a
    // fresh object would re-render every transient consumer for nothing.
    const recovered = planTransientRecovery({
      sessions: [transientSession({ id: 'sess-1', commandTerminalSlot: 'slot-1' })],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-1', branch: 'main' },
      ]),
    });

    expect(recovered).toBeNull();
  });

  it('returns null when there are no live transient sessions', () => {
    const recovered = planTransientRecovery({
      sessions: [taskSession('task-1'), { ...transientSession({ id: 'gone' }), status: 'exited' }],
      transientSessions: {},
    });

    expect(recovered).toBeNull();
  });

  it('never pairs a task agent session', () => {
    const recovered = planTransientRecovery({
      sessions: [taskSession('task-1'), transientSession({ id: 'terminal', commandTerminalSlot: 'slot-1' })],
      transientSessions: {},
    });

    expect(Object.keys(recovered!)).toEqual([`${PROJECT_A}::slot-1`]);
  });

  it('leaves other projects\' entries untouched', () => {
    const existing = transientMap([
      { projectId: PROJECT_B, slot: 'slot-1', sessionId: 'b-1', branch: 'main' },
    ]);
    const recovered = planTransientRecovery({
      sessions: [
        transientSession({ id: 'a-1', projectId: PROJECT_A, commandTerminalSlot: 'slot-1' }),
        transientSession({ id: 'b-1', projectId: PROJECT_B, commandTerminalSlot: 'slot-1' }),
      ],
      transientSessions: existing,
    });

    expect(recovered![`${PROJECT_B}::slot-1`]).toEqual(existing[`${PROJECT_B}::slot-1`]);
  });
});

describe('findAdoptableTransientSession', () => {
  it('finds a live unpaired PTY stamped with this slot', () => {
    const adoptable = findAdoptableTransientSession(
      [transientSession({ id: 'orphan', commandTerminalSlot: 'slot-2', commandTerminalBranch: 'main' })],
      {},
      PROJECT_A,
      'slot-2',
    );

    expect(adoptable?.id).toBe('orphan');
  });

  it('ignores a PTY that is already paired to some window', () => {
    const adoptable = findAdoptableTransientSession(
      [transientSession({ id: 'paired', commandTerminalSlot: 'slot-1' })],
      transientMap([{ projectId: PROJECT_A, slot: 'slot-1', sessionId: 'paired', branch: 'main' }]),
      PROJECT_A,
      'slot-1',
    );

    expect(adoptable).toBeNull();
  });

  it('never adopts a PTY belonging to a different slot', () => {
    // Attaching to the wrong slot puts someone else's conversation under this
    // window's title, silently. Spawning is the correct outcome here.
    const adoptable = findAdoptableTransientSession(
      [transientSession({ id: 'other', commandTerminalSlot: 'slot-3' })],
      {},
      PROJECT_A,
      'slot-1',
    );

    expect(adoptable).toBeNull();
  });

  it('never adopts across projects, or a dead or unslotted PTY', () => {
    const sessions = [
      transientSession({ id: 'other-project', projectId: PROJECT_B, commandTerminalSlot: 'slot-1' }),
      { ...transientSession({ id: 'dead', commandTerminalSlot: 'slot-1' }), status: 'exited' as const },
      transientSession({ id: 'unslotted' }),
      taskSession('task-1'),
    ];

    expect(findAdoptableTransientSession(sessions, {}, PROJECT_A, 'slot-1')).toBeNull();
  });
});
