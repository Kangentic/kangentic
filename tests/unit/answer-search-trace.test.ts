import { describe, expect, it } from 'vitest';
import { searchDocKeys } from '../../src/main/agent/mcp-http/answer-search-trace';

/**
 * What an Ask answer run's search rings on the map: the conversations of the
 * sessions it returned, and of the tasks its commit hits are linked to.
 */
describe('searchDocKeys', () => {
  const bySession = new Map([
    ['session-a', ['conversation::a1', 'conversation::a2']],
    ['session-b', ['conversation::b1']],
  ]);
  const byTask = new Map([
    ['task-1', ['conversation::a1', 'conversation::t1']],
    ['task-2', ['conversation::t2']],
  ]);

  it('rings the returned sessions\' conversations', () => {
    expect(searchDocKeys({ query: 'q', sessionIds: ['session-a', 'session-b'] }, bySession, byTask))
      .toEqual(['conversation::a1', 'conversation::a2', 'conversation::b1']);
  });

  it('adds the conversations of the tasks a commit hit is linked to, each once', () => {
    expect(searchDocKeys({ query: 'q', sessionIds: ['session-a'], taskIds: ['task-1', 'task-2'] }, bySession, byTask))
      .toEqual(['conversation::a1', 'conversation::a2', 'conversation::t1', 'conversation::t2']);
  });

  it('skips a session or task with no conversation on the map', () => {
    expect(searchDocKeys({ query: 'q', sessionIds: ['session-gone'], taskIds: ['task-gone'] }, bySession, byTask)).toEqual([]);
  });
});
