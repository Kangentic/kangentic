/**
 * The session store's open-conversation signal: `setConversationSessionId(id, tab)`.
 *
 * Every entry point that opens the conversation viewer (the Route pills, the
 * kebab item, the search palette) raises this one signal, and
 * `useConversationWindowBridge` turns it into a window. Three properties carry
 * the Route tabs:
 *
 *   1. EVERY non-null call bumps `conversationRequestId`, including a repeat of
 *      the id already open. The bridge keys its effect on the pair, so a second
 *      Route pill for a conversation that is already open re-runs it and switches
 *      the window's tab. Keyed on the id alone, the repeat would do nothing.
 *   2. The tab rides with its own request and defaults to null. A call with no
 *      tab must not inherit the previous call's tab, or a plain "View
 *      conversation" would reopen on whatever column was last asked for.
 *   3. Clearing (null id) is not a request: it leaves the counter where it was,
 *      so closing a conversation never looks like a new open.
 *
 * Drives the real Zustand store with `window.electronAPI` stubbed, the way
 * session-store-remove-session.test.ts does. The bridge hook is covered in
 * conversation-window-bridge.test.ts, which needs module mocks this file must
 * not carry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ConversationTabRequest } from '../../src/shared/types';

// Stub window before importing the store, so the module graph sees it.
(globalThis as Record<string, unknown>).window = { electronAPI: {} };

import { useSessionStore } from '../../src/renderer/stores/session-store';

const SESSION_ID = 'session-open-1';
const OTHER_SESSION_ID = 'session-open-2';
const REVIEW_TAB: ConversationTabRequest = {
  swimlaneId: 'swimlane-review',
  visitStartedAt: '2026-10-20T18:11:00.000Z',
};
const EXECUTING_TAB: ConversationTabRequest = { swimlaneId: 'swimlane-executing' };

function readSignal() {
  const state = useSessionStore.getState();
  return {
    conversationSessionId: state.conversationSessionId,
    conversationTab: state.conversationTab,
    conversationRequestId: state.conversationRequestId,
  };
}

beforeEach(() => {
  useSessionStore.setState({ conversationSessionId: null, conversationTab: null, conversationRequestId: 0 });
});

describe('setConversationSessionId: opening', () => {
  it('sets the session and the tab and bumps the request id by one', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);

    expect(readSignal()).toEqual({
      conversationSessionId: SESSION_ID,
      conversationTab: REVIEW_TAB,
      conversationRequestId: 1,
    });
  });

  it('defaults the tab to null when none is given', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID);

    expect(readSignal()).toEqual({
      conversationSessionId: SESSION_ID,
      conversationTab: null,
      conversationRequestId: 1,
    });
  });

  it('bumps the request id on a repeat of the same session', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);
    useSessionStore.getState().setConversationSessionId(SESSION_ID, EXECUTING_TAB);

    // Two asks, two bumps: the bridge re-runs for the second and switches the tab.
    expect(readSignal()).toEqual({
      conversationSessionId: SESSION_ID,
      conversationTab: EXECUTING_TAB,
      conversationRequestId: 2,
    });
  });

  it('bumps the request id on a repeat of the same session and the same tab', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);

    expect(useSessionStore.getState().conversationRequestId).toBe(2);
  });

  it('bumps the request id when the session changes', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID);
    useSessionStore.getState().setConversationSessionId(OTHER_SESSION_ID);

    expect(readSignal()).toEqual({
      conversationSessionId: OTHER_SESSION_ID,
      conversationTab: null,
      conversationRequestId: 2,
    });
  });

  it('does not carry the previous request\'s tab into a call that names none', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);

    useSessionStore.getState().setConversationSessionId(SESSION_ID);

    expect(useSessionStore.getState().conversationTab).toBeNull();
  });
});

describe('setConversationSessionId: clearing', () => {
  it('nulls the session and the tab and leaves the request id where it was', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);
    useSessionStore.getState().setConversationSessionId(SESSION_ID, REVIEW_TAB);
    expect(useSessionStore.getState().conversationRequestId).toBe(2);

    useSessionStore.getState().setConversationSessionId(null);

    expect(readSignal()).toEqual({
      conversationSessionId: null,
      conversationTab: null,
      conversationRequestId: 2,
    });
  });

  it('does not bump the request id when clearing a signal that was never set', () => {
    useSessionStore.getState().setConversationSessionId(null);

    expect(readSignal()).toEqual({
      conversationSessionId: null,
      conversationTab: null,
      conversationRequestId: 0,
    });
  });

  it('ignores a tab passed alongside a null session', () => {
    useSessionStore.getState().setConversationSessionId(null, REVIEW_TAB);

    expect(readSignal()).toEqual({
      conversationSessionId: null,
      conversationTab: null,
      conversationRequestId: 0,
    });
  });

  it('counts the next open from where the clear left off', () => {
    useSessionStore.getState().setConversationSessionId(SESSION_ID);
    useSessionStore.getState().setConversationSessionId(null);
    useSessionStore.getState().setConversationSessionId(SESSION_ID);

    expect(useSessionStore.getState().conversationRequestId).toBe(2);
  });
});
