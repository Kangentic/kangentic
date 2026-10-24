/**
 * The Earlier list's hand-off to a Command Terminal window
 * (`transient-session-slice.ts`): a row asks a slot to resume a conversation,
 * the slot's window takes the request exactly once, and a request no window
 * took is dropped when that slot's window closes, so the next terminal opened
 * there starts fresh instead of resuming a conversation nobody asked for.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: null })),
  },
}));

import { createTransientSessionSlice, transientKey } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';

function makeSliceStore() {
  let state: Record<string, unknown> = { transientSessions: {}, sessions: [] };
  const get = () => state as unknown as SessionStore;
  const set = (updater: Partial<SessionStore> | ((prev: SessionStore) => Partial<SessionStore>)) => {
    const partial = typeof updater === 'function' ? updater(state as unknown as SessionStore) : updater;
    state = { ...state, ...partial };
  };
  const sliceCreator = createTransientSessionSlice(undefined);
  const slice = sliceCreator(set as unknown as Parameters<typeof sliceCreator>[0], get, {} as unknown as Parameters<typeof sliceCreator>[2]);
  state = { ...state, ...slice };
  return { slice, getState: () => state as unknown as SessionStore };
}

describe('Command Terminal resume requests', () => {
  it('hands a slot its request once, and nothing after', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalResume('proj-1', 'slot-2', 'conversation-a');
    expect(getState().takeCommandTerminalResume('proj-1', 'slot-1')).toBeNull();
    expect(getState().takeCommandTerminalResume('proj-1', 'slot-2')).toBe('conversation-a');
    expect(getState().takeCommandTerminalResume('proj-1', 'slot-2')).toBeNull();
  });

  it('keeps projects apart', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalResume('proj-1', 'slot-1', 'conversation-a');
    expect(getState().takeCommandTerminalResume('proj-2', 'slot-1')).toBeNull();
    expect(getState().takeCommandTerminalResume('proj-1', 'slot-1')).toBe('conversation-a');
  });

  it('a second ask for the same slot is a new request the window sees', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalResume('proj-1', 'slot-1', 'conversation-a');
    const firstNonce = getState().pendingCommandTerminalResumes[transientKey('proj-1', 'slot-1')].nonce;
    getState().requestCommandTerminalResume('proj-1', 'slot-1', 'conversation-b');
    const pending = getState().pendingCommandTerminalResumes[transientKey('proj-1', 'slot-1')];
    expect(pending).toEqual({ agentSessionId: 'conversation-b', nonce: firstNonce + 1 });
  });

  it("drops a request whose slot has no window, and only that project's", () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalResume('proj-1', 'slot-1', 'conversation-a');
    getState().requestCommandTerminalResume('proj-1', 'slot-3', 'conversation-b');
    getState().requestCommandTerminalResume('proj-2', 'slot-3', 'conversation-c');

    getState().dropCommandTerminalResumesExcept('proj-1', new Set(['slot-1']));

    expect(getState().takeCommandTerminalResume('proj-1', 'slot-3')).toBeNull();
    expect(getState().takeCommandTerminalResume('proj-1', 'slot-1')).toBe('conversation-a');
    expect(getState().takeCommandTerminalResume('proj-2', 'slot-3')).toBe('conversation-c');
  });

  it('leaves the map untouched when nothing is orphaned', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalResume('proj-1', 'slot-1', 'conversation-a');
    const before = getState().pendingCommandTerminalResumes;
    getState().dropCommandTerminalResumesExcept('proj-1', new Set(['slot-1']));
    expect(getState().pendingCommandTerminalResumes).toBe(before);
  });
});
