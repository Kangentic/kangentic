/**
 * Guards the `_sessionByTaskId` invariant declared on `CoreSessionSlice`:
 * "Rebuilt whenever `sessions` changes."
 *
 * Four board-store call sites evict sessions when a task leaves an active column,
 * is deleted, or is bulk-deleted. Each of them used to filter the `sessions` array
 * alone and leave the index untouched, which broke that invariant in the one
 * direction nothing else repairs: the array lost the session while the index kept
 * a live taskId pointing at it.
 *
 * `TaskCard` resolves a task's session THROUGH that index, so the consequence was
 * user-visible and looked like a hang - drag a task back to To Do and its card kept
 * rendering the dead session's activity mark and "Sonnet 5 / 10%" context footer,
 * as though the agent were still attached, until some unrelated `syncSessions()`
 * happened to rebuild the map. Observed live: `sessions.length === 3` while
 * `_sessionByTaskId.size === 4`, the extra entry naming a session that no longer
 * existed anywhere in the array.
 *
 * These test the shared helper the four sites now route through, so a fifth
 * eviction site cannot reintroduce the split.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../../src/shared/types';
import { buildSessionByTaskId, withoutSessionsForTasks } from '../../src/renderer/stores/session-store/session-index';

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeSession(id: string, taskId: string): Session {
  return {
    id,
    taskId,
    projectId: 'project-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
  } as Session;
}

describe('withoutSessionsForTasks', () => {
  const sessions = [
    makeSession('sess-a', 'task-a'),
    makeSession('sess-b', 'task-b'),
    makeSession('sess-c', 'task-c'),
  ];

  it('drops the evicted task from BOTH the array and the index', () => {
    const next = withoutSessionsForTasks(sessions, 'task-b');

    expect(next.sessions.map((session) => session.id)).toEqual(['sess-a', 'sess-c']);
    expect(next._sessionByTaskId.has('task-b')).toBe(false);
    // The invariant, stated directly: the index describes exactly the array.
    expect(next._sessionByTaskId.size).toBe(next.sessions.length);
  });

  it('accepts a Set for the bulk-delete path', () => {
    const next = withoutSessionsForTasks(sessions, new Set(['task-a', 'task-c']));

    expect(next.sessions.map((session) => session.id)).toEqual(['sess-b']);
    expect(next._sessionByTaskId.size).toBe(1);
    expect(next._sessionByTaskId.get('task-b')?.id).toBe('sess-b');
  });

  it('leaves the surviving sessions and their index entries intact', () => {
    const next = withoutSessionsForTasks(sessions, 'task-b');

    expect(next._sessionByTaskId.get('task-a')).toBe(sessions[0]);
    expect(next._sessionByTaskId.get('task-c')).toBe(sessions[2]);
  });

  it('is a no-op for a task with no session', () => {
    const next = withoutSessionsForTasks(sessions, 'task-unknown');

    expect(next.sessions).toHaveLength(3);
    expect(next._sessionByTaskId.size).toBe(3);
  });

  it('matches a full rebuild of the remaining sessions', () => {
    const next = withoutSessionsForTasks(sessions, 'task-a');
    const rebuilt = buildSessionByTaskId(next.sessions);

    expect([...next._sessionByTaskId.keys()]).toEqual([...rebuilt.keys()]);
  });
});

describe('session eviction call sites', () => {
  // The helper only helps if the eviction sites actually use it. A site that
  // hand-rolls `sessions: state.sessions.filter(...)` reintroduces the split
  // silently - it type-checks, and the bug only shows on a card that nobody
  // re-renders.
  const EVICTION_SITES = [
    'src/renderer/stores/board-store/task-slice.ts',
    'src/renderer/stores/board-store/archived-tasks-slice.ts',
  ];

  it.each(EVICTION_SITES)('%s evicts sessions through the shared helper', (relativePath) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');

    expect(
      /sessions:\s*\w+\.sessions\.filter\(/.test(source),
      `${relativePath} filters the sessions array directly. That leaves _sessionByTaskId `
      + 'pointing at an evicted session, and TaskCard resolves its session through that '
      + 'index - so the card keeps rendering a dead agent\'s activity mark and context '
      + 'footer until an unrelated syncSessions() repairs the map. Use '
      + 'withoutSessionsForTasks(sessions, taskIds), which returns both halves.',
    ).toBe(false);

    expect(source.includes('withoutSessionsForTasks')).toBe(true);
  });
});
