import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord, TranscriptDeltaResponse, TranscriptEntry, TranscriptGetResponse } from '../../src/shared/types';
import { applyTranscriptDelta } from '../../src/shared/types';

/**
 * The viewer's reply from the retrieval worker (`taskTranscriptJson`) against
 * the real stitch and the real stat-validated file cache: an append sends
 * only the new entries, the patched result equals a whole read, an unchanged
 * entry keeps its object across parses, and a re-stitch that came out the
 * same (a file touched with nothing new) keeps its revision.
 */

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { resolveTaskTranscript, resetForTests } from '../../src/main/agent/transcript-service';
import { taskTranscriptJson } from '../../src/main/retrieval/worker/transcript-methods';
import { agentRegistry } from '../../src/main/agent/agent-registry';

const record = {
  id: 'session-1',
  task_id: 'task-1',
  session_type: 'claude_agent',
  isolated_swimlane_id: null,
  agent_session_id: 'agent-1',
  cwd: '/work/project',
  started_at: '2026-06-01T12:00:00Z',
  exited_at: null,
  status: 'running',
} as unknown as SessionRecord;

const db = {
  prepare(sql: string) {
    return {
      get: (...args: unknown[]) => {
        if (sql.includes('FROM sessions WHERE id = ? OR agent_session_id = ?')) {
          return args[0] === record.id || args[0] === record.agent_session_id ? record : undefined;
        }
        if (sql.includes('SELECT title FROM tasks WHERE id = ?')) return { title: 'Delta Task' };
        throw new Error(`unexpected get SQL: ${sql}`);
      },
      all: () => {
        if (sql.includes('FROM sessions WHERE task_id = ?')) return [record];
        throw new Error(`unexpected all SQL: ${sql}`);
      },
    };
  },
} as unknown as Database.Database;

describe('the viewer reply: deltas over a stable stitch', () => {
  let tmpDir: string;
  let transcriptFilePath: string;
  // What the fake parser returns, appended to the SAME array as Claude's
  // incremental parse does; `freshObjects` makes every entry a new object,
  // as a parser with no incremental path does.
  let parsed: TranscriptEntry[];
  let freshObjects: boolean;

  beforeEach(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-delta-'));
    transcriptFilePath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptFilePath, 'a');
    parsed = [
      { kind: 'user', uuid: 'u1', ts: 1, text: 'first question' },
      { kind: 'assistant', uuid: 'a1', ts: 2, blocks: [{ type: 'text', text: 'first answer' }] },
    ];
    freshObjects = false;
    vi.mocked(agentRegistry.getBySessionType).mockReturnValue({
      displayName: 'Claude Code',
      parseTranscript: vi.fn(async () => ({
        entries: freshObjects ? parsed.map((entry) => JSON.parse(JSON.stringify(entry)) as TranscriptEntry) : parsed,
        sourcePath: transcriptFilePath,
      })),
    } as unknown as ReturnType<typeof agentRegistry.getBySessionType>);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Grow the file so the stat-validated cache re-parses. */
  function touchFile(): void {
    fs.appendFileSync(transcriptFilePath, 'b');
  }

  it('sends only the appended entries, and the patched result equals a whole read', async () => {
    const first = await resolveTaskTranscript(db, 'session-1');
    const whole = JSON.parse(taskTranscriptJson(first!, undefined)) as TranscriptGetResponse;
    expect(whole.entries).toHaveLength(2);

    parsed.push({ kind: 'user', uuid: 'u2', ts: 3, text: 'second question' });
    touchFile();
    const second = await resolveTaskTranscript(db, 'session-1');
    expect(second!.revision).toBe(first!.revision + 1);
    // The entries the stitch kept are the same objects.
    expect(second!.entries[0]).toBe(first!.entries[0]);
    expect(second!.entries[1]).toBe(first!.entries[1]);

    const delta = JSON.parse(taskTranscriptJson(second!, first!.revision)) as TranscriptDeltaResponse;
    expect(delta).toMatchObject({ delta: true, baseRevision: first!.revision, revision: second!.revision, length: 3 });
    expect(delta.upserts).toEqual([[2, { kind: 'user', uuid: 'u2', ts: 3, text: 'second question' }]]);

    const fresh = JSON.parse(taskTranscriptJson(second!, undefined)) as TranscriptGetResponse;
    expect(applyTranscriptDelta(whole.entries, delta)).toEqual(fresh.entries);
  });

  it('keeps the revision when a re-parse yields the same content, even as new objects', async () => {
    const first = await resolveTaskTranscript(db, 'session-1');
    freshObjects = true;
    touchFile();
    const second = await resolveTaskTranscript(db, 'session-1');

    expect(second!.revision).toBe(first!.revision);
    expect(second!.entries).toBe(first!.entries);
    expect(JSON.parse(taskTranscriptJson(second!, first!.revision))).toEqual({ unchanged: true, revision: first!.revision });
  });

  it('answers whole when the caller holds a revision no longer kept', async () => {
    const first = await resolveTaskTranscript(db, 'session-1');
    const reply = JSON.parse(taskTranscriptJson(first!, first!.revision + 100)) as TranscriptGetResponse;
    expect(reply.entries).toHaveLength(2);
    expect('delta' in reply).toBe(false);
  });

  it('answers whole when more than half the entries changed', async () => {
    const first = await resolveTaskTranscript(db, 'session-1');
    parsed.splice(0, parsed.length,
      { kind: 'user', uuid: 'x1', ts: 1, text: 'replaced' },
      { kind: 'user', uuid: 'x2', ts: 2, text: 'replaced too' });
    touchFile();
    const second = await resolveTaskTranscript(db, 'session-1');
    const reply = JSON.parse(taskTranscriptJson(second!, first!.revision)) as TranscriptGetResponse;
    expect('delta' in reply).toBe(false);
    expect(reply.entries.map((entry) => entry.uuid)).toEqual(['x1', 'x2']);
  });
});
