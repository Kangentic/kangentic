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
 *
 * The second half pins the LIVE PREFERENCE shared by `findSessionForTask` and the
 * index builder. Main listed a stale suspended row ahead of a task's running PTY;
 * the task-detail hook took the first array match (the Resume overlay) while the
 * card took the last (`map.set`, the running spinner). Both now resolve through
 * one preference that ignores array order.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../../src/shared/types';
import {
  buildSessionByTaskId,
  findSessionForTask,
  withoutSessionsForTasks,
} from '../../src/renderer/stores/session-store/session-index';

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeSession(id: string, taskId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    taskId,
    projectId: 'project-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
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

describe('findSessionForTask / buildSessionByTaskId - live preference', () => {
  // The observed registry order: the stale suspended row started first and was
  // listed first; the running row that replaced it came seven seconds later.
  const stale = makeSession('sess-stale', 'task-a', { status: 'suspended', startedAt: '2026-09-04T14:25:26.340Z' });
  const live = makeSession('sess-live', 'task-a', { status: 'running', startedAt: '2026-09-04T14:25:33.601Z' });

  it.each([
    ['stale row first, as main listed it', [stale, live]],
    ['live row first', [live, stale]],
  ])('resolves the running row over a suspended sibling (%s)', (_label, sessions) => {
    expect(findSessionForTask(sessions, 'task-a')).toBe(live);
    expect(buildSessionByTaskId(sessions).get('task-a')).toBe(live);
  });

  it('when both rows are live (running vs queued), the later-started one wins, whatever the order', () => {
    const olderQueued = makeSession('sess-older-queued', 'task-a', { status: 'queued', startedAt: '2026-09-04T14:08:26.000Z' });
    const newerRunning = makeSession('sess-newer-running', 'task-a', { status: 'running', startedAt: '2026-09-04T14:18:31.000Z' });

    expect(findSessionForTask([olderQueued, newerRunning], 'task-a')).toBe(newerRunning);
    expect(findSessionForTask([newerRunning, olderQueued], 'task-a')).toBe(newerRunning);
    expect(buildSessionByTaskId([olderQueued, newerRunning]).get('task-a')).toBe(newerRunning);
    expect(buildSessionByTaskId([newerRunning, olderQueued]).get('task-a')).toBe(newerRunning);
  });

  it('prefers a queued row over a suspended one (a respawn waiting for a slot)', () => {
    const queued = makeSession('sess-queued', 'task-a', { status: 'queued', startedAt: '2026-09-04T14:25:33.601Z' });

    expect(findSessionForTask([stale, queued], 'task-a')).toBe(queued);
    expect(findSessionForTask([queued, stale], 'task-a')).toBe(queued);
  });

  it('prefers a live row even when the stale one started later', () => {
    const laterStale = makeSession('sess-later-stale', 'task-a', { status: 'suspended', startedAt: '2026-09-04T15:00:00.000Z' });

    expect(findSessionForTask([live, laterStale], 'task-a')).toBe(live);
    expect(findSessionForTask([laterStale, live], 'task-a')).toBe(live);
  });

  it('breaks a tie between two stale rows on the later startedAt, whatever the order', () => {
    const older = makeSession('sess-older', 'task-a', { status: 'suspended', startedAt: '2026-09-04T14:08:26.000Z' });
    const newer = makeSession('sess-newer', 'task-a', { status: 'suspended', startedAt: '2026-09-04T14:18:31.000Z' });

    expect(findSessionForTask([older, newer], 'task-a')).toBe(newer);
    expect(findSessionForTask([newer, older], 'task-a')).toBe(newer);
    expect(buildSessionByTaskId([older, newer]).get('task-a')).toBe(newer);
  });

  it('returns undefined for a task with no session and ignores other tasks', () => {
    const other = makeSession('sess-other', 'task-other');

    expect(findSessionForTask([other, stale], 'task-nowhere')).toBeUndefined();
    expect(findSessionForTask([other, stale], 'task-a')).toBe(stale);
  });

  it('the index and the selector agree on every task', () => {
    const sessions = [
      stale,
      makeSession('sess-b', 'task-b'),
      live,
      makeSession('sess-c-old', 'task-c', { status: 'exited', startedAt: '2026-09-04T13:00:00.000Z' }),
      makeSession('sess-c-new', 'task-c', { status: 'suspended', startedAt: '2026-09-04T14:00:00.000Z' }),
    ];
    const index = buildSessionByTaskId(sessions);

    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      expect(index.get(taskId)).toBe(findSessionForTask(sessions, taskId));
    }
    expect(index.get('task-c')?.id).toBe('sess-c-new');
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

// ---------------------------------------------------------------------------
// No first-wins `sessions.find(...)` task lookup anywhere in the renderer
// ---------------------------------------------------------------------------

/**
 * `preferSessionForTask` / `findSessionForTask` exist because a bare
 * `sessions.find((candidate) => candidate.taskId === taskId)` is first-wins:
 * when two rows share a taskId - a stale suspended placeholder listed ahead of
 * a fresh running spawn - a first-match resolver can pick the stale one over
 * the live one. Six renderer call sites were converted to findSessionForTask;
 * this scan walks every file under src/renderer/ so a reintroduced first-wins
 * lookup (at one of those six sites, or a brand-new one) fails immediately
 * instead of shipping a silent "Resume session" painted over a running agent.
 */
describe('session-by-task lookups: no first-wins sessions.find(...) reintroduction', () => {
  const SCAN_DIR = 'src/renderer';
  const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
  const FIRST_WINS_LOOKUP = /sessions\s*\.find\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.taskId\s*===/;

  function collectRendererSourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectRendererSourceFiles(fullPath));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('no renderer file resolves a task session with a first-wins sessions.find(...)', () => {
    const offenders: string[] = [];
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);
    for (const filePath of collectRendererSourceFiles(absoluteDir)) {
      const relative = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = FIRST_WINS_LOOKUP.exec(content);
      if (!match) continue;
      const lineNumber = content.slice(0, match.index).split('\n').length;
      offenders.push(`${relative}:${lineNumber}`);
    }
    expect(
      offenders,
      'A renderer file resolves a task\'s session with a first-wins sessions.find((candidate) => ' +
      'candidate.taskId === taskId). Two registry rows can exist for one task (a stale suspended ' +
      'placeholder ahead of a fresh running spawn), and a first-match lookup can resolve the stale ' +
      'row instead of the live one. Use findSessionForTask from ' +
      'src/renderer/stores/session-store/session-index.ts instead.\n' +
      `Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
