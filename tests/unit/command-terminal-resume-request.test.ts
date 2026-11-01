/**
 * The Earlier list's hand-off to a Command Terminal window
 * (`transient-session-slice.ts`): a row asks a slot to resume a conversation,
 * the slot's window takes the request exactly once, and a request no window
 * took is dropped when that slot's window closes, so the next terminal opened
 * there starts fresh instead of resuming a conversation nobody asked for. The
 * same slice also hands a slot's window the action a Running row's menu asked
 * for (`requestCommandTerminalWindowAction`).
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

/**
 * The Running row's menu hand-off to a Command Terminal window: a row asks a
 * slot's window to do something once it is in front (rename, commands, switch
 * branch, toggle changes), and the window takes the request exactly once.
 */
describe('Command Terminal window action requests', () => {
  it('hands a slot its action once, and nothing after', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalWindowAction('proj-1', 'slot-2', 'rename');
    expect(getState().takeCommandTerminalWindowAction('proj-1', 'slot-2')).toBe('rename');
    expect(getState().takeCommandTerminalWindowAction('proj-1', 'slot-2')).toBeNull();
    // Taking cleared the entry, it did not just report it.
    expect(getState().pendingCommandTerminalWindowActions[transientKey('proj-1', 'slot-2')]).toBeUndefined();
  });

  it('answers null when nothing was requested', () => {
    const { slice, getState } = makeSliceStore();
    expect(getState().takeCommandTerminalWindowAction('proj-1', 'slot-1')).toBeNull();
    slice.requestCommandTerminalWindowAction('proj-1', 'slot-1', 'commands');
    // Another project's slot of the same name has no request either.
    expect(getState().takeCommandTerminalWindowAction('proj-2', 'slot-1')).toBeNull();
  });

  it('keeps two slots apart, each with its own entry', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalWindowAction('proj-1', 'slot-1', 'rename');
    getState().requestCommandTerminalWindowAction('proj-1', 'slot-2', 'switch-branch');
    const pending = getState().pendingCommandTerminalWindowActions;
    expect(pending[transientKey('proj-1', 'slot-1')]).toEqual({ action: 'rename', nonce: 1 });
    expect(pending[transientKey('proj-1', 'slot-2')]).toEqual({ action: 'switch-branch', nonce: 1 });

    expect(getState().takeCommandTerminalWindowAction('proj-1', 'slot-2')).toBe('switch-branch');
    // Taking slot-2's action left slot-1's pending.
    expect(getState().takeCommandTerminalWindowAction('proj-1', 'slot-1')).toBe('rename');
  });

  it('a second ask for the same slot is a new request the window sees, with the later action', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalWindowAction('proj-1', 'slot-1', 'rename');
    getState().requestCommandTerminalWindowAction('proj-1', 'slot-1', 'toggle-changes');
    expect(getState().pendingCommandTerminalWindowActions[transientKey('proj-1', 'slot-1')])
      .toEqual({ action: 'toggle-changes', nonce: 2 });
    expect(getState().takeCommandTerminalWindowAction('proj-1', 'slot-1')).toBe('toggle-changes');
  });

  it('an ask for the same action twice still changes the entry, so a window watching the map sees it', () => {
    const { slice, getState } = makeSliceStore();
    slice.requestCommandTerminalWindowAction('proj-1', 'slot-1', 'rename');
    const before = getState().pendingCommandTerminalWindowActions;
    getState().requestCommandTerminalWindowAction('proj-1', 'slot-1', 'rename');
    const after = getState().pendingCommandTerminalWindowActions;
    expect(after).not.toBe(before);
    expect(after[transientKey('proj-1', 'slot-1')]).toEqual({ action: 'rename', nonce: 2 });
  });
});
