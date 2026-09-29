/**
 * Where the camera goes once an answer lands: the conversations of the tasks
 * the answer is about, inside the map's filters, and nothing when none of them
 * is on the map (the camera then frames the lit set as before).
 */

import { describe, it, expect } from 'vitest';
import { answerFocusIndices } from '../../src/renderer/components/knowledge-graph/answer-focus';

const indexByDocKey = new Map([
  ['conversation::a', 0],
  ['conversation::b', 1],
  ['conversation::c', 2],
  ['conversation::d', 3],
]);

describe('answerFocusIndices', () => {
  it('frames every conversation of every row, once each, in row order', () => {
    const rows = [
      { docKeys: ['conversation::c', 'conversation::a'] },
      { docKeys: ['conversation::a', 'conversation::d'] },
    ];
    expect(answerFocusIndices(rows, indexByDocKey, null)).toEqual([2, 0, 3]);
  });

  it('stays inside the map filters', () => {
    const rows = [{ docKeys: ['conversation::a', 'conversation::b'] }];
    expect(answerFocusIndices(rows, indexByDocKey, new Set([1]))).toEqual([1]);
  });

  it('is null when no row has a conversation on the map', () => {
    expect(answerFocusIndices([], indexByDocKey, null)).toBeNull();
    // A task with no recorded conversation, and one filtered out.
    expect(answerFocusIndices([{ docKeys: [] }, { docKeys: ['conversation::z'] }], indexByDocKey, null)).toBeNull();
    expect(answerFocusIndices([{ docKeys: ['conversation::a'] }], indexByDocKey, new Set([3]))).toBeNull();
  });
});
