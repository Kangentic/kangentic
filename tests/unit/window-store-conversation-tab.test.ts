/**
 * Unit tests for `ManagedWindow.conversationTab`, the one-shot tab request a
 * conversation window carries from a Route pill.
 *
 * A pill on the completed task view asks for a column's tab, optionally scrolled
 * to one stay. When a conversation window for that session is already open, the
 * store must re-aim it rather than open a second one, and it must do so for the
 * tab and the scroll target INDEPENDENTLY: a re-open that names only a tab must
 * not erase a pending scroll target, and the reverse. `clearConversationTab` is
 * the consumer's acknowledgement, and it must leave the rest of the window alone.
 *
 * The request is renderer-only and transient, so it also must never reach the
 * persisted workspace (a restored window opens on All).
 *
 * Tier: Unit (vitest, no DOM, no Electron - the store is plain Zustand).
 */
import { describe, it, expect } from 'vitest';
import { createWindowManagerStore } from '../../src/renderer/window-manager/store/window-store';
import type { ConversationTabRequest } from '../../src/shared/types';

function makeStore() {
  return createWindowManagerStore({ idPrefix: 'test', kind: 'conversation' }).store;
}

const ANCHOR = 'session-anchor-1';
const OTHER_ANCHOR = 'session-anchor-2';
const TURN_UUID = 'turn-uuid-7';
const OTHER_TURN_UUID = 'turn-uuid-9';
const REVIEW_TAB: ConversationTabRequest = {
  swimlaneId: 'swimlane-review',
  visitStartedAt: '2026-10-20T18:11:00.000Z',
};
const EXECUTING_TAB: ConversationTabRequest = { swimlaneId: 'swimlane-executing' };

function openConversation(
  store: ReturnType<typeof makeStore>,
  anchor: string,
  extra: { scrollToTurnUuid?: string; conversationTab?: ConversationTabRequest } = {},
): string {
  return store.getState().openWindow({
    kind: 'conversation',
    anchor,
    sessionId: anchor,
    title: 'Conversation',
    ...extra,
  });
}

describe('openWindow: a new conversation window', () => {
  it('carries the tab and the turn it was opened with', () => {
    const store = makeStore();
    const id = openConversation(store, ANCHOR, { scrollToTurnUuid: TURN_UUID, conversationTab: REVIEW_TAB });

    const created = store.getState().windows[id];
    expect(created.conversationTab).toEqual(REVIEW_TAB);
    expect(created.scrollToTurnUuid).toBe(TURN_UUID);
  });

  it('leaves both properties absent on a plain open', () => {
    // Absent, not undefined: a window with no request must show All.
    const store = makeStore();
    const id = openConversation(store, ANCHOR);

    const created = store.getState().windows[id];
    expect('conversationTab' in created).toBe(false);
    expect('scrollToTurnUuid' in created).toBe(false);
  });
});

describe('openWindow: an already-open conversation window', () => {
  it('keeps the turn it had when a re-open names only a tab', () => {
    const store = makeStore();
    const first = openConversation(store, ANCHOR, { scrollToTurnUuid: TURN_UUID });

    const second = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });

    expect(second).toBe(first);
    expect(Object.keys(store.getState().windows)).toHaveLength(1);
    const reopened = store.getState().windows[first];
    expect(reopened.conversationTab).toEqual(REVIEW_TAB);
    expect(reopened.scrollToTurnUuid).toBe(TURN_UUID);
  });

  it('keeps the tab it had when a re-open names only a turn', () => {
    const store = makeStore();
    const first = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });

    const second = openConversation(store, ANCHOR, { scrollToTurnUuid: TURN_UUID });

    expect(second).toBe(first);
    expect(Object.keys(store.getState().windows)).toHaveLength(1);
    const reopened = store.getState().windows[first];
    expect(reopened.conversationTab).toEqual(REVIEW_TAB);
    expect(reopened.scrollToTurnUuid).toBe(TURN_UUID);
  });

  it('switches to the newer tab and turn when a re-open names both', () => {
    const store = makeStore();
    const first = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB, scrollToTurnUuid: TURN_UUID });

    openConversation(store, ANCHOR, { conversationTab: EXECUTING_TAB, scrollToTurnUuid: OTHER_TURN_UUID });

    const reopened = store.getState().windows[first];
    expect(reopened.conversationTab).toEqual(EXECUTING_TAB);
    expect(reopened.scrollToTurnUuid).toBe(OTHER_TURN_UUID);
  });

  it('leaves the window and its request untouched when a re-open names neither', () => {
    const store = makeStore();
    const first = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB, scrollToTurnUuid: TURN_UUID });
    const before = store.getState().windows;

    openConversation(store, ANCHOR);

    // The already-focused no-op stays cheap: no new windows object to re-render on.
    expect(store.getState().windows).toBe(before);
    expect(store.getState().windows[first].conversationTab).toEqual(REVIEW_TAB);
  });

  it('re-aims only the window for that anchor', () => {
    const store = makeStore();
    const target = openConversation(store, ANCHOR);
    const bystander = openConversation(store, OTHER_ANCHOR);

    openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });

    expect(store.getState().windows[target].conversationTab).toEqual(REVIEW_TAB);
    expect('conversationTab' in store.getState().windows[bystander]).toBe(false);
  });
});

describe('clearConversationTab', () => {
  it('removes the tab and leaves the turn and the rest of the window alone', () => {
    const store = makeStore();
    const id = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB, scrollToTurnUuid: TURN_UUID });

    store.getState().clearConversationTab(id);

    const cleared = store.getState().windows[id];
    expect('conversationTab' in cleared).toBe(false);
    expect(cleared.scrollToTurnUuid).toBe(TURN_UUID);
    expect(cleared.anchor).toBe(ANCHOR);
    expect(cleared.kind).toBe('conversation');
  });

  it('clears only the named window', () => {
    const store = makeStore();
    const first = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });
    const second = openConversation(store, OTHER_ANCHOR, { conversationTab: EXECUTING_TAB });

    store.getState().clearConversationTab(first);

    expect('conversationTab' in store.getState().windows[first]).toBe(false);
    expect(store.getState().windows[second].conversationTab).toEqual(EXECUTING_TAB);
  });

  it('is a no-op that keeps the same windows object when there is no tab to clear', () => {
    const store = makeStore();
    const id = openConversation(store, ANCHOR, { scrollToTurnUuid: TURN_UUID });
    const before = store.getState().windows;

    store.getState().clearConversationTab(id);

    expect(store.getState().windows).toBe(before);
  });

  it('is a no-op that keeps the same windows object for an unknown id', () => {
    const store = makeStore();
    openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });
    const before = store.getState().windows;

    store.getState().clearConversationTab('no-such-window');

    expect(store.getState().windows).toBe(before);
  });

  it('is idempotent', () => {
    const store = makeStore();
    const id = openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });
    store.getState().clearConversationTab(id);
    const afterFirstClear = store.getState().windows;

    store.getState().clearConversationTab(id);

    expect(store.getState().windows).toBe(afterFirstClear);
  });
});

describe('conversationTab never reaches the persisted workspace', () => {
  // Transient by contract, like `openedByAgent` and `skipEnterAnimation`. A tab
  // that survived a restore would reopen a conversation on a column the user
  // chose in an earlier run, with no pill on screen to explain why.
  it('is not serialized', () => {
    const store = makeStore();
    openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });

    const serialized = store.getState().serializeWorkspace();

    // The window itself IS persisted, so an empty blob cannot pass this vacuously.
    expect(serialized.windows).toHaveLength(1);
    expect(serialized.windows[0].taskId).toBe(ANCHOR);
    expect(serialized.windows[0].kind).toBe('conversation');
    const serializedText = JSON.stringify(serialized);
    expect(serializedText).not.toContain('conversationTab');
    expect(serializedText).not.toContain(REVIEW_TAB.swimlaneId as string);
    expect(serializedText).not.toContain(REVIEW_TAB.visitStartedAt as string);
  });

  it('is not restored', () => {
    const store = makeStore();
    openConversation(store, ANCHOR, { conversationTab: REVIEW_TAB });
    const serialized = store.getState().serializeWorkspace();

    const restored = makeStore();
    restored.getState().applyWorkspace(
      serialized,
      (anchor: string) => anchor,
      () => true,
    );

    const rebuilt = Object.values(restored.getState().windows);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].kind).toBe('conversation');
    expect('conversationTab' in rebuilt[0]).toBe(false);
  });
});
