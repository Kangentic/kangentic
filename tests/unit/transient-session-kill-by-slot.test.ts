/**
 * The renderer side of "main owns a Command Terminal's end".
 *
 * Main announces every terminal's removal (`session-removed`), and the
 * removal subscriber (`useCloseCommandWindowOnRemoval`) closes the window of a
 * terminal whose (project, slot) entry still points at the removed session:
 * that is an end main started (a phone's Stop, the agent exiting). For that to
 * be a reliable signal, a window ending its OWN terminal (Stop, a branch
 * switch) must let go of the entry before the kill reaches main, which is what
 * `killTransientSessionBySlot` pins here.
 *
 * Also pins `selectLiveCommandTerminalSlots`, which keeps the layer's "next
 * free slot" from asking main for a slot a phone's terminal already holds.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: null })),
  },
}));

import {
  createTransientSessionSlice,
  selectLiveCommandTerminalSlots,
  transientKey,
  type TransientSessionEntry,
} from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';
import type { Session } from '../../src/shared/types';

function makeSliceStore(initial: Record<string, TransientSessionEntry>) {
  let state: Pick<SessionStore, 'transientSessions'> & Record<string, unknown> = {
    transientSessions: initial,
    sessions: [],
    _sessionByTaskId: new Map(),
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionActivityReason: {},
    sessionEvents: {},
    seenIdleSessions: {},
    sessionMessageTrails: {},
    commandBarVisible: false,
  };
  const get = () => state as unknown as SessionStore;
  const set = (updater: Partial<SessionStore> | ((prev: SessionStore) => Partial<SessionStore>)) => {
    const partial = typeof updater === 'function' ? updater(state as unknown as SessionStore) : updater;
    if (partial !== (state as unknown)) state = { ...state, ...partial };
  };
  const sliceCreator = createTransientSessionSlice(undefined);
  const slice = sliceCreator(set as unknown as Parameters<typeof sliceCreator>[0], get, {} as unknown as Parameters<typeof sliceCreator>[2]);
  // The kill calls the slice's own clearTransientSessionById through get().
  state = { ...state, ...slice, transientSessions: initial };
  return { slice, getState: () => state };
}

function installKillTransient(impl: (sessionId: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const killTransient = vi.fn(impl);
  (globalThis as unknown as { window: Record<string, unknown> }).window =
    (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = { sessions: { killTransient } };
  return killTransient;
}

const ENTRY: TransientSessionEntry = { projectId: 'proj-1', slot: 'slot-2', sessionId: 'term-2', branch: 'main' };

describe('killTransientSessionBySlot', () => {
  it('lets go of the entry BEFORE the kill reaches main, so the removal push reads as the window\'s own end', async () => {
    let entryPresentWhenKilled: boolean | null = null;
    const { slice, getState } = makeSliceStore({ [transientKey('proj-1', 'slot-2')]: ENTRY });
    installKillTransient(async () => {
      // Main emits session-removed inside this call; the subscriber looks for
      // an entry at that moment.
      entryPresentWhenKilled = transientKey('proj-1', 'slot-2') in getState().transientSessions;
    });

    const outcome = await slice.killTransientSessionBySlot('proj-1', 'slot-2');

    expect(outcome).toBe('killed');
    expect(entryPresentWhenKilled).toBe(false);
    expect(getState().transientSessions).toEqual({});
  });

  it('reports a rejected kill as failed, with the entry already let go', async () => {
    const { slice, getState } = makeSliceStore({ [transientKey('proj-1', 'slot-2')]: ENTRY });
    installKillTransient(async () => { throw new Error('main refused'); });

    expect(await slice.killTransientSessionBySlot('proj-1', 'slot-2')).toBe('failed');
    expect(getState().transientSessions).toEqual({});
  });

  it('issues no kill for a slot with no entry', async () => {
    const { slice } = makeSliceStore({});
    const killTransient = installKillTransient(async () => {});

    expect(await slice.killTransientSessionBySlot('proj-1', 'slot-2')).toBe('no-session');
    expect(killTransient).not.toHaveBeenCalled();
  });
});

describe('selectLiveCommandTerminalSlots', () => {
  function row(overrides: Partial<Session> & { id: string }): Session {
    return {
      taskId: overrides.id,
      projectId: 'proj-1',
      pid: 1,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/project',
      startedAt: '2026-10-11T12:00:00.000Z',
      exitCode: null,
      resuming: false,
      transient: true,
      commandTerminalSlot: null,
      ...overrides,
    };
  }

  it('collects the live terminal slots of one project only, leaving out exited rows and task sessions', () => {
    const slots = selectLiveCommandTerminalSlots([
      row({ id: 'phone-started', commandTerminalSlot: 'slot-1' }),
      row({ id: 'desktop', commandTerminalSlot: 'slot-3' }),
      row({ id: 'ended', commandTerminalSlot: 'slot-2', status: 'exited' }),
      row({ id: 'other-project', commandTerminalSlot: 'slot-4', projectId: 'proj-2' }),
      row({ id: 'task-agent', commandTerminalSlot: null, transient: false }),
    ], 'proj-1');

    expect([...slots].sort()).toEqual(['slot-1', 'slot-3']);
  });

  it('counts a queued terminal as holding its slot, the way main reserves it', () => {
    // Main's reserveCommandTerminalSlot counts every non-exited transient row, a
    // queued one included. A selector that only counted `running` rows would offer
    // a slot a queued phone terminal already holds, and main would refuse the
    // spawn with slot-taken.
    const slots = selectLiveCommandTerminalSlots([
      row({ id: 'queued-phone-started', commandTerminalSlot: 'slot-2', status: 'queued' }),
      row({ id: 'running-desktop', commandTerminalSlot: 'slot-1' }),
      row({ id: 'ended', commandTerminalSlot: 'slot-3', status: 'exited' }),
      row({ id: 'queued-other-project', commandTerminalSlot: 'slot-4', status: 'queued', projectId: 'proj-2' }),
    ], 'proj-1');

    expect([...slots].sort()).toEqual(['slot-1', 'slot-2']);
  });

  it('is empty with no project open', () => {
    expect(selectLiveCommandTerminalSlots([row({ id: 'a', commandTerminalSlot: 'slot-1' })], null).size).toBe(0);
  });
});
