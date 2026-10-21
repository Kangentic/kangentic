import { describe, expect, it } from 'vitest';
import {
  initialState,
  reconcileInputs,
  reconcileWindow,
} from '../../src/renderer/components/conversation/use-conversation-paging';
import { buildPagingWindow, type HeldBlock } from '../../src/renderer/components/conversation/conversation-paging';
import type { ConversationExtent, TranscriptEntry } from '../../src/shared/types';

/**
 * The Conversation window's paging state as its inputs and its built window
 * imply it (`useConversationPaging`): what a reset, a re-windowed tail, a
 * Route row's visit and a search hit do to the pages the window holds. These
 * run during render, so each must leave the state itself alone when nothing
 * changes, or the window would render forever.
 */

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);

function entry(index: number): TranscriptEntry {
  return { kind: 'user', uuid: `A-${index}`, ts: BASE + index * MINUTE, text: `turn ${index}`, origin: { conversationId: 'A', position: index * 100 } };
}

function tailFrom(start: number, end: number): TranscriptEntry[] {
  const tail: TranscriptEntry[] = [{
    kind: 'system', uuid: `kangentic-truncated:A:${start * 100}`, ts: BASE + start * MINUTE, subtype: 'truncated', text: 'notice',
    earlierHistory: { conversationId: 'A', cursor: `j:${start * 100}`, position: start * 100 },
  }];
  for (let index = start; index < end; index += 1) tail.push(entry(index));
  return tail;
}

function page(from: number, to: number): HeldBlock {
  const entries: TranscriptEntry[] = [];
  for (let index = from; index < to; index += 1) entries.push(entry(index));
  return {
    conversationId: 'A', sourceToken: 'jsonl:token', startCursor: `j:${from * 100}`, endCursor: `j:${to * 100}`,
    startPosition: from * 100, endPosition: to * 100, reachedStart: from === 0, entries,
  };
}

const EXTENT: ConversationExtent = { conversationId: 'A', totalPosition: 5000, tailStartPosition: 4000, pageable: true, hasTimestamps: true };

describe('reconcileInputs', () => {
  const tail = tailFrom(40, 50);
  const inputs = { resetKey: 'window|all', openingTs: null, visitTs: null, enabled: true, tail };

  it('returns the state itself once it has caught up, so render does not loop', () => {
    const settled = reconcileInputs(initialState('window|all', null, 0, null), inputs);
    expect(reconcileInputs(settled, inputs)).toBe(settled);
  });

  it('drops every page and opens a column tab at its stay on a new tab', () => {
    const held = { ...reconcileInputs(initialState('window|all', null, 0, null), inputs), blocks: [page(30, 40)] };
    const reset = reconcileInputs(held, { ...inputs, resetKey: 'window|executing', openingTs: BASE + 5 * MINUTE });
    expect(reset.blocks).toEqual([]);
    expect(reset.anchorTs).toBe(BASE + 5 * MINUTE);
    expect(reset.target).toEqual({ ts: BASE + 5 * MINUTE, attempts: 0 });
    expect(reset.generation).toBe(held.generation + 1);
  });

  it('keeps the seam of a re-windowed tail as a block', () => {
    const held = { ...reconcileInputs(initialState('window|all', null, 0, null), inputs), blocks: [page(30, 40)] };
    const grown = reconcileInputs(held, { ...inputs, tail: tailFrom(45, 53) });
    expect(grown.blocks.map((block) => [block.startPosition, block.endPosition])).toContainEqual([4000, 4500]);
  });

  it('makes a Route row\'s visit a moment the window must hold, once', () => {
    const settled = reconcileInputs(initialState('window|executing', null, 0, null), { ...inputs, resetKey: 'window|executing' });
    const visit = BASE + 7 * MINUTE;
    const asked = reconcileInputs(settled, { ...inputs, resetKey: 'window|executing', visitTs: visit });
    expect(asked.target).toEqual({ ts: visit, attempts: 0 });
    expect(asked.anchorTs).toBe(visit);
    // Clearing the visit once it scrolled leaves the window where it is.
    const cleared = reconcileInputs({ ...asked, target: null }, { ...inputs, resetKey: 'window|executing', visitTs: null });
    expect(cleared.anchorTs).toBe(visit);
    expect(cleared.target).toBeNull();
  });
});

describe('reconcileWindow', () => {
  const tail = tailFrom(40, 50);

  it('marks a moment met once the window is built around it', () => {
    const state = { ...initialState('key', BASE + 45 * MINUTE, 0, null), seenTail: tail };
    const window = buildPagingWindow({ tail, conversations: [EXTENT], blocks: [], timelines: new Map(), anchorTs: state.anchorTs });
    const next = reconcileWindow(state, { window, enabled: true, turnUuid: null, tail });
    expect(next.target).toBeNull();
    expect(reconcileWindow(next, { window, enabled: true, turnUuid: null, tail })).toBe(next);
  });

  it('keeps a moment in unloaded history owed, for a jump to load', () => {
    const state = { ...initialState('key', BASE + 15 * MINUTE, 0, null), seenTail: tail };
    const window = buildPagingWindow({ tail, conversations: [EXTENT], blocks: [], timelines: new Map(), anchorTs: state.anchorTs });
    expect(reconcileWindow(state, { window, enabled: true, turnUuid: null, tail }).target).toEqual({ ts: BASE + 15 * MINUTE, attempts: 0 });
  });

  it('sends a window anchored in old pages back to the tail for a search hit the tail holds, once', () => {
    const state = { ...initialState('key', null, 0, null), blocks: [page(10, 20)], anchorTs: BASE + 15 * MINUTE, seenTail: tail };
    const window = buildPagingWindow({ tail, conversations: [EXTENT], blocks: state.blocks, timelines: new Map(), anchorTs: state.anchorTs });
    expect(window.timeByUuid.has('A-45')).toBe(false);
    const next = reconcileWindow(state, { window, enabled: true, turnUuid: 'A-45', tail });
    expect(next.blocks).toEqual([]);
    expect(next.anchorTs).toBe(Infinity);
    expect(next.locate).toEqual({ uuid: 'A-45', done: true });
    expect(reconcileWindow(next, { window, enabled: true, turnUuid: 'A-45', tail })).toBe(next);
  });
});
