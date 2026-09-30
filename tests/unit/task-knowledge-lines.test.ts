/**
 * The Knowledge Graph's lines under a task in `kangentic_find_task` and
 * `kangentic_get_current_task` (src/main/agent/commands/task-knowledge-lines.ts).
 *
 * The agent reads the message text and never the data object, so these lines
 * are the only way a summary, a linked commit or a changed file reaches it.
 * Pure: the reader is a stub, no database.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TASK_KNOWLEDGE_MATCH_LIMIT,
  taskKnowledgeFor,
  taskKnowledgeLines,
} from '../../src/main/agent/commands/task-knowledge-lines';
import type { TaskKnowledge } from '../../src/main/retrieval/task-knowledge';
import type { TaskKnowledgeRead } from '../../src/main/agent/commands/types';

function knowledge(overrides: Partial<TaskKnowledge> = {}): TaskKnowledge {
  return {
    summary: null,
    commits: [],
    commitCount: 0,
    changedFiles: [],
    changedFileCount: 0,
    ...overrides,
  };
}

/** A commit whose sha is 40 hex digits, so the line has to cut it to ten. */
function commit(prefix: string, subject: string, committedAt: string): TaskKnowledge['commits'][number] {
  return { sha: `${prefix}${'0'.repeat(40 - prefix.length)}`, subject, committedAt };
}

describe('taskKnowledgeLines', () => {
  it('prints a finished task\'s written summary with the day it was written', () => {
    const lines = taskKnowledgeLines(
      knowledge({ summary: { text: 'Made the relay reconnect after a router restart.', writtenAt: '2026-09-20T18:30:00.000Z' } }),
      true,
      true,
    );
    expect(lines).toContain('  summary (2026-09-20): Made the relay reconnect after a router restart.');
  });

  it('says a finished task has no summary yet while summaries are on', () => {
    expect(taskKnowledgeLines(knowledge(), true, true)).toContain('  summary: not written yet');
  });

  it('says why a finished task has no summary while summaries are off', () => {
    expect(taskKnowledgeLines(knowledge(), true, false)).toContain(
      '  summary: none written (Task summaries are switched off in Settings > Knowledge Graph)',
    );
  });

  it('prints a written summary whatever the switch says', () => {
    // The switch stops new summaries; the ones already written keep helping.
    const lines = taskKnowledgeLines(
      knowledge({ summary: { text: 'Fixed the pairing code.', writtenAt: '2026-08-01T00:00:00.000Z' } }),
      true,
      false,
    );
    expect(lines).toEqual(['  summary (2026-08-01): Fixed the pairing code.', '  commits: none linked to this task']);
  });

  it('gives an unfinished task no summary line, written or not', () => {
    expect(taskKnowledgeLines(knowledge(), false, true)).toEqual([]);
    expect(taskKnowledgeLines(knowledge(), false, false)).toEqual([]);
    const written = knowledge({ summary: { text: 'Left over from an earlier Done.', writtenAt: '2026-08-01T00:00:00.000Z' } });
    expect(taskKnowledgeLines(written, false, true)).toEqual([]);
  });

  it('says a finished task has no linked commits, and stays silent for an unfinished one', () => {
    expect(taskKnowledgeLines(knowledge(), true, true)).toContain('  commits: none linked to this task');
    expect(taskKnowledgeLines(knowledge(), false, true).join('\n')).not.toContain('commits');
  });

  it('lists the commits newest first by ten-character sha, day and subject', () => {
    const lines = taskKnowledgeLines(
      knowledge({
        commits: [
          commit('a1b2c3d4e5', 'fix(relay): back off on reconnect (PR 812)', '2026-09-19T10:00:00.000Z'),
          commit('f6e5d4c3b2', 'feat(relay): pair by QR code', '2026-09-12T08:00:00.000Z'),
        ],
        commitCount: 2,
      }),
      false,
      true,
    );
    expect(lines).toEqual([
      '  commits linked by subject (2, newest first): a1b2c3d4e5 2026-09-19 fix(relay): back off on reconnect (PR 812); f6e5d4c3b2 2026-09-12 feat(relay): pair by QR code',
    ]);
  });

  it('counts the commits it does not list', () => {
    const lines = taskKnowledgeLines(
      knowledge({
        commits: [
          commit('a1b2c3d4e5', 'one', '2026-09-19T10:00:00.000Z'),
          commit('b1b2c3d4e5', 'two', '2026-09-18T10:00:00.000Z'),
          commit('c1b2c3d4e5', 'three', '2026-09-17T10:00:00.000Z'),
        ],
        commitCount: 5,
      }),
      false,
      true,
    );
    expect(lines[0]).toMatch(/^ {2}commits linked by subject \(5, newest first\): .*three; and 2 more$/);
  });

  it('lists the changed files most-changed first, and counts the ones it does not list', () => {
    const shown = ['src/a.ts', 'src/b.ts', 'README.md'];
    expect(taskKnowledgeLines(knowledge({ changedFiles: shown, changedFileCount: 3 }), false, true)).toEqual([
      '  changed files (3, most-changed first): src/a.ts, src/b.ts, README.md',
    ]);
    expect(taskKnowledgeLines(knowledge({ changedFiles: shown, changedFileCount: 11 }), false, true)).toEqual([
      '  changed files (11, most-changed first): src/a.ts, src/b.ts, README.md; and 8 more',
    ]);
  });

  it('prints nothing for an unfinished task the index knows nothing about', () => {
    expect(taskKnowledgeLines(knowledge(), false, true)).toEqual([]);
  });

  it('orders the lines summary, commits, changed files', () => {
    const lines = taskKnowledgeLines(
      knowledge({
        summary: { text: 'Done.', writtenAt: '2026-09-20T00:00:00.000Z' },
        commits: [commit('a1b2c3d4e5', 'fix: one', '2026-09-19T10:00:00.000Z')],
        commitCount: 1,
        changedFiles: ['src/a.ts'],
        changedFileCount: 1,
      }),
      true,
      true,
    );
    expect(lines.map((line) => line.trim().split(/[ (:]/)[0])).toEqual(['summary', 'commits', 'changed']);
  });
});

describe('taskKnowledgeFor', () => {
  const tasks = (count: number, finished = false) =>
    Array.from({ length: count }, (_unused, index) => ({ id: `task-${index}`, finished }));

  function reading(byTask: Map<string, TaskKnowledge>, summariesOn = true): (taskIds: string[]) => TaskKnowledgeRead {
    return vi.fn((): TaskKnowledgeRead => ({ indexOn: true, summariesOn, byTask }));
  }

  it('adds no lines and no notes when the context has no reader', () => {
    const result = taskKnowledgeFor(undefined, tasks(2, true));
    expect(result.linesByTask.size).toBe(0);
    expect(result.knowledgeByTask.size).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it('does not read for an empty match list', () => {
    const read = reading(new Map());
    const result = taskKnowledgeFor(read, []);
    expect(read).not.toHaveBeenCalled();
    expect(result.notes).toEqual([]);
  });

  it('keys each task\'s lines by its id, using the finished flag and the summaries switch', () => {
    const byTask = new Map([['task-0', knowledge()], ['task-1', knowledge()]]);
    const on = taskKnowledgeFor(reading(byTask, true), [{ id: 'task-0', finished: true }, { id: 'task-1', finished: false }]);
    expect(on.linesByTask.get('task-0')).toEqual(['  summary: not written yet', '  commits: none linked to this task']);
    // Nothing to say about an unfinished task the index has nothing for.
    expect(on.linesByTask.has('task-1')).toBe(false);
    // ...but its knowledge is still handed back for the data object.
    expect(on.knowledgeByTask.get('task-1')).toBe(byTask.get('task-1'));

    const off = taskKnowledgeFor(reading(byTask, false), [{ id: 'task-0', finished: true }]);
    expect(off.linesByTask.get('task-0')?.[0]).toContain('switched off in Settings > Knowledge Graph');
  });

  it('reads only the first five matches and says so for the rest', () => {
    expect(TASK_KNOWLEDGE_MATCH_LIMIT).toBe(5);
    const all = tasks(6, true);
    const byTask = new Map(all.map((task) => [task.id, knowledge()]));
    const read = reading(byTask);

    const result = taskKnowledgeFor(read, all);

    expect(read).toHaveBeenCalledWith(['task-0', 'task-1', 'task-2', 'task-3', 'task-4']);
    expect([...result.linesByTask.keys()]).toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-4']);
    expect(result.linesByTask.has('task-5')).toBe(false);
    expect(result.notes).toEqual([
      'Summaries, commits and changed files show for the first 5 matches. Look one up by displayId for its details.',
    ]);
  });

  it('adds no limit note at exactly five matches', () => {
    const all = tasks(5, true);
    const result = taskKnowledgeFor(reading(new Map(all.map((task) => [task.id, knowledge()]))), all);
    expect(result.linesByTask.size).toBe(5);
    expect(result.notes).toEqual([]);
  });

  it('says the index is off, and prints no lines, when the reader reports it off', () => {
    const read = vi.fn((): TaskKnowledgeRead => ({ indexOn: false }));
    const result = taskKnowledgeFor(read, tasks(6, true));
    expect(read).toHaveBeenCalledOnce();
    expect(result.linesByTask.size).toBe(0);
    expect(result.knowledgeByTask.size).toBe(0);
    // The off note replaces the limit note: nothing is shown for any match.
    expect(result.notes).toEqual([
      'The Knowledge Graph index is off (Settings > Knowledge Graph), so no summary, linked commits or changed files are shown.',
    ]);
  });

  it('leaves a task the reader had no entry for without lines', () => {
    // The reader answers an empty map when the index read failed.
    const result = taskKnowledgeFor(reading(new Map()), tasks(2, true));
    expect(result.linesByTask.size).toBe(0);
    expect(result.notes).toEqual([]);
  });
});
