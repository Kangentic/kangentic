import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../../src/shared/types';

/**
 * A mobile `transcript-window` request asks for the last handful of entries,
 * but resolving it walks EVERY session of the task - and a `--resume` writes a
 * new transcript file that replays its parent's entire history, so a task
 * resumed five times owns five near-identical files. Measured on a live
 * board: 267MB behind one task, 319MB across one Home-feed refresh.
 *
 * `resolveTaskTranscript` therefore revalidates a task by STAT alone before
 * parsing anything, using signatures recorded in the stitch memo itself. That
 * independence from the file cache is the point: the file cache is a bounded
 * LRU, and these tests pin that the fast path still works after it has been
 * evicted, which is precisely the busy-board case that was re-parsing
 * hundreds of megabytes per refresh.
 */

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { resolveTaskTranscript, resetForTests } from '../../src/main/agent/transcript-service';
import { getCachedTranscript } from '../../src/main/agent/transcript-cache';
import { agentRegistry } from '../../src/main/agent/agent-registry';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-1',
    cwd: '/work/project',
    started_at: '2026-06-01T12:00:00Z',
    exited_at: null,
    status: 'running',
    ...overrides,
  } as unknown as SessionRecord;
}

function makeFakeDb(records: SessionRecord[]): Database.Database {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ? OR agent_session_id = ?')) {
            const requestedId = args[0] as string;
            return records.find((record) => record.id === requestedId || record.agent_session_id === requestedId);
          }
          if (sql.includes('SELECT title FROM tasks WHERE id = ?')) return { title: 'Fast Path Task' };
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: () => {
          if (sql.includes('FROM sessions WHERE task_id = ?')) return [...records].reverse();
          // The index fallback, reached when a live parse yields nothing.
          if (sql.includes('FROM memory_chunks')) return [];
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  } as unknown as Database.Database;
}

const getBySessionType = vi.mocked(agentRegistry.getBySessionType);

describe('resolveTaskTranscript stat-only fast path', () => {
  let tmpDir: string;
  let transcriptFilePath: string;
  let parseTranscript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-fast-path-'));
    transcriptFilePath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptFilePath, JSON.stringify({ turn: 'first' }));
    parseTranscript = vi.fn(async () => ({
      entries: [{ kind: 'user' as const, uuid: 'turn-1', ts: 1, text: 'hello' }],
      sourcePath: transcriptFilePath,
    }));
    getBySessionType.mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript,
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves an unchanged task without parsing any transcript file', async () => {
    const db = makeFakeDb([makeRecord()]);

    const first = await resolveTaskTranscript(db, 'session-1');
    expect(parseTranscript).toHaveBeenCalledTimes(1);

    const second = await resolveTaskTranscript(db, 'session-1');

    expect(second!.entries).toBe(first!.entries);
    expect(second!.revision).toBe(first!.revision);
    expect(parseTranscript).toHaveBeenCalledTimes(1);
  });

  /**
   * The busy-board case. The file cache is a bounded LRU, so on a board with
   * many live sessions a task's own entry is routinely evicted between
   * refreshes. Before the memo carried its own signatures, that eviction
   * forced a full re-parse of every file behind the task.
   */
  it('still avoids parsing after the file cache has evicted this session', async () => {
    const db = makeFakeDb([makeRecord()]);
    const first = await resolveTaskTranscript(db, 'session-1');
    expect(parseTranscript).toHaveBeenCalledTimes(1);

    // Push this session out of the file-level LRU with unrelated traffic.
    for (let index = 0; index < 70; index += 1) {
      const otherFile = path.join(tmpDir, `other-${index}.jsonl`);
      fs.writeFileSync(otherFile, `filler-${index}`);
      await getCachedTranscript('claude_agent', `other-${index}`, async () => ({
        entries: [],
        sourcePath: otherFile,
      }));
    }

    const afterEviction = await resolveTaskTranscript(db, 'session-1');

    expect(afterEviction!.entries).toBe(first!.entries);
    expect(parseTranscript).toHaveBeenCalledTimes(1);
  });

  it('re-parses and re-stitches when a contributing file genuinely changes', async () => {
    const db = makeFakeDb([makeRecord()]);
    const first = await resolveTaskTranscript(db, 'session-1');

    fs.writeFileSync(transcriptFilePath, JSON.stringify({ turn: 'first-plus-a-second-turn-changing-the-size' }));
    parseTranscript.mockResolvedValueOnce({
      entries: [
        { kind: 'user' as const, uuid: 'turn-1', ts: 1, text: 'hello' },
        { kind: 'user' as const, uuid: 'turn-2', ts: 2, text: 'new turn' },
      ],
      sourcePath: transcriptFilePath,
    });

    const second = await resolveTaskTranscript(db, 'session-1');

    expect(parseTranscript).toHaveBeenCalledTimes(2);
    expect(second!.revision).toBe(first!.revision + 1);
    expect(second!.entries.some((entry) => entry.uuid === 'turn-2')).toBe(true);
  });

  /** A file that disappears must fail the stat check, never serve a stale stitch. */
  it('falls back to a full resolve when a recorded file is gone', async () => {
    const db = makeFakeDb([makeRecord()]);
    await resolveTaskTranscript(db, 'session-1');

    fs.rmSync(transcriptFilePath);
    parseTranscript.mockResolvedValueOnce({ entries: [], sourcePath: null });

    await resolveTaskTranscript(db, 'session-1');

    expect(parseTranscript).toHaveBeenCalledTimes(2);
  });

  /** A newly-added session changes the task's shape, so the memo must not answer. */
  it('does not answer from the memo when the task gains a session', async () => {
    const db = makeFakeDb([makeRecord()]);
    await resolveTaskTranscript(db, 'session-1');
    expect(parseTranscript).toHaveBeenCalledTimes(1);

    const secondFile = path.join(tmpDir, 'transcript-2.jsonl');
    fs.writeFileSync(secondFile, JSON.stringify({ turn: 'resumed' }));
    const grown = makeFakeDb([makeRecord(), makeRecord({ id: 'session-2', agent_session_id: 'agent-2' })]);

    await resolveTaskTranscript(grown, 'session-1');

    expect(parseTranscript.mock.calls.length).toBeGreaterThan(1);
  });
});
