import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../../src/shared/types';

/**
 * `resolveTaskTranscript` memoizes its expensive per-task stitch (dedup by
 * uuid, chronological sort, boundary-divider insertion) keyed on a
 * fingerprint of every contributing session's `entries` array IDENTITY (see
 * `tokenForEntries`'s WeakMap in transcript-service.ts). That identity is
 * governed by `getCachedTranscript`'s real stat-validated file cache
 * (transcript-cache.ts): the SAME array reference comes back when a
 * session's native transcript file is byte-for-byte unchanged (mtime+size
 * match), and a genuinely NEW array reference comes back the moment the file
 * changes. These tests exercise that real file cache (via `os.tmpdir()`
 * fixtures) rather than mocking array identity directly, so they prove the
 * actual dependency the memo relies on, not an assumption about it.
 *
 * Covers the two NEW, currently-untested cases: an idle poll (nothing on
 * disk changed) must short-circuit to the SAME `entries` reference and SAME
 * `revision`; a genuine change must bump `revision` and re-stitch.
 */

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { resolveTaskTranscript, resetForTests } from '../../src/main/agent/transcript-service';
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

function makeFakeDb(record: SessionRecord): Database.Database {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ? OR agent_session_id = ?')) {
            const requestedId = args[0] as string;
            return requestedId === record.id || requestedId === record.agent_session_id
              ? record
              : undefined;
          }
          if (sql.includes('SELECT title FROM tasks WHERE id = ?')) {
            return { title: 'Revision Memo Task' };
          }
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE task_id = ?')) {
            return [record];
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  } as unknown as Database.Database;
}

const getBySessionType = vi.mocked(agentRegistry.getBySessionType);

describe('resolveTaskTranscript revision stitch memo', () => {
  let tmpDir: string;
  let transcriptFilePath: string;
  let parseTranscript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-revision-'));
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

  it('returns a real entries array and revision >= 1 on the first call for a task', async () => {
    const db = makeFakeDb(makeRecord());

    const result = await resolveTaskTranscript(db, 'session-1');

    expect(result).not.toBeNull();
    expect(result!.entries.length).toBeGreaterThan(0);
    expect(result!.revision).toBeGreaterThanOrEqual(1);
  });

  it('short-circuits to the SAME entries reference and SAME revision when every contributing session file is unchanged', async () => {
    const db = makeFakeDb(makeRecord());

    const first = await resolveTaskTranscript(db, 'session-1');
    const second = await resolveTaskTranscript(db, 'session-1');

    expect(second!.entries).toBe(first!.entries);
    expect(second!.revision).toBe(first!.revision);
    // The file-level cache itself should also have short-circuited the
    // adapter call on the second poll, which is what gives the stitched
    // entries array its stable identity in the first place.
    expect(parseTranscript).toHaveBeenCalledTimes(1);
  });

  it('bumps revision and returns a freshly-stitched entries array when an underlying session file genuinely changes', async () => {
    const db = makeFakeDb(makeRecord());

    const first = await resolveTaskTranscript(db, 'session-1');

    // Grow the file's byte size so the stat-validated file cache misses on
    // the next read, forcing a genuine re-parse (and thus a new entries
    // array reference for that session).
    fs.writeFileSync(
      transcriptFilePath,
      JSON.stringify({ turn: 'first-and-then-a-second-turn-that-changed-the-file-size' }),
    );
    parseTranscript.mockResolvedValueOnce({
      entries: [
        { kind: 'user' as const, uuid: 'turn-1', ts: 1, text: 'hello' },
        { kind: 'user' as const, uuid: 'turn-2', ts: 2, text: 'a genuinely new turn' },
      ],
      sourcePath: transcriptFilePath,
    });

    const second = await resolveTaskTranscript(db, 'session-1');

    expect(second!.revision).toBe(first!.revision + 1);
    expect(second!.entries).not.toBe(first!.entries);
    expect(second!.entries.some((entry) => entry.uuid === 'turn-2')).toBe(true);
  });
});
