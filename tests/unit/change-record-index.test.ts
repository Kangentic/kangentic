/**
 * The `change` corpus: the files a session changed, read from its conversation's
 * own indexed text, and a sweep that re-derives a session only when its
 * conversation was re-indexed.
 *
 * better-sqlite3 cannot load under vitest's system Node, so the sweep runs
 * against a scripted `prepare()` that answers by SQL shape and records writes.
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import {
  changedFilesFromChunkTexts,
  changeRecordChunks,
  pathWords,
  repoRelativePath,
  CHANGE_RECORD_VERSION,
} from '../../src/main/retrieval/change/change-record';
import { sweepChangeRecords } from '../../src/main/retrieval/change/change-indexer';
import { SLICE_BUDGET_MS } from '../../src/main/retrieval/timed-slices';

const TOOLS = [
  { tool: 'Edit', pathField: 'file_path' },
  { tool: 'Write', pathField: 'file_path' },
  { tool: 'NotebookEdit', pathField: 'notebook_path' },
];

describe('changedFilesFromChunkTexts', () => {
  it('reads the path from each file-changing tool line, wherever the field sits in the input', () => {
    const text = [
      'Assistant: fixing the pane',
      'Tool: Edit {"replace_all":false,"file_path":"C:\\\\repo\\\\src\\\\TerminalPane.tsx","old_string":"a"',
      'Tool: Write {"file_path":"/repo/docs/guide.md","content":"# Guide"}',
      'Tool: Read {"file_path":"/repo/src/unrelated.ts"}',
      'Tool: Edit {"file_path":"C:\\\\repo\\\\src\\\\TerminalPane.tsx","old_string":"b"',
      'Tool: NotebookEdit {"notebook_path":"/repo/analysis.ipynb","new_source":"x"',
    ].join('\n');

    const files = changedFilesFromChunkTexts([text], TOOLS);

    expect([...files]).toEqual([
      ['C:\\repo\\src\\TerminalPane.tsx', 2],
      ['/repo/docs/guide.md', 1],
      ['/repo/analysis.ipynb', 1],
    ]);
  });

  it('skips a path the 200-character cut left without its closing quote', () => {
    const files = changedFilesFromChunkTexts(['Tool: Edit {"file_path":"/repo/src/a-very-long-path-that-was-cu…'], TOOLS);
    expect(files.size).toBe(0);
  });

  it('reads nothing for an agent that declares no file-changing tools', () => {
    expect(changedFilesFromChunkTexts(['Tool: Edit {"file_path":"/repo/a.ts"}'], []).size).toBe(0);
  });
});

describe('repoRelativePath', () => {
  it('reads a worktree path from after the worktree, whichever worktree it was', () => {
    expect(repoRelativePath('C:\\dev\\app\\.kangentic\\worktrees\\529\\src\\main\\a.ts', null)).toBe('src/main/a.ts');
    expect(repoRelativePath('/home/dev/app/.kangentic/worktrees/fix-x/src/b.ts', '/home/dev/app')).toBe('src/b.ts');
  });

  it('strips the project root from a file in the main checkout', () => {
    expect(repoRelativePath('/home/dev/app/src/c.ts', '/home/dev/app')).toBe('src/c.ts');
  });

  it('keeps a relative path, and drops a file outside the project', () => {
    expect(repoRelativePath('src/d.ts', '/home/dev/app')).toBe('src/d.ts');
    expect(repoRelativePath('/home/dev/.claude/plans/plan.md', '/home/dev/app')).toBeNull();
  });

  it('drops a relative path that climbs out of the repository, since it names no file in it', () => {
    expect(repoRelativePath('../notes/plan.md', '/home/dev/app')).toBeNull();
    expect(repoRelativePath('../../secrets.txt', null)).toBeNull();
    expect(repoRelativePath('..\\outside\\a.ts', '/home/dev/app')).toBeNull();
    expect(repoRelativePath('..', '/home/dev/app')).toBeNull();
    // A plain relative path still passes through.
    expect(repoRelativePath('src/f.ts', '/home/dev/app')).toBe('src/f.ts');
    // A name that merely starts with two dots is a file, not the parent directory.
    expect(repoRelativePath('..hidden/g.ts', '/home/dev/app')).toBe('..hidden/g.ts');
  });

  it('drops runtime scratch and git internals, which are not the repository\'s work', () => {
    expect(repoRelativePath('/home/dev/app/.kangentic/worktrees/7/.kangentic/COMMIT_MSG.tmp', null)).toBeNull();
    expect(repoRelativePath('/home/dev/app/.git/info/exclude', '/home/dev/app')).toBeNull();
    expect(repoRelativePath('/home/dev/app/node_modules/pkg/index.js', '/home/dev/app')).toBeNull();
  });
});

describe('the change document', () => {
  it('names a path by the words it is made of', () => {
    expect(pathWords('src/renderer/components/terminal/TerminalPane.tsx')).toEqual(['renderer', 'components', 'terminal', 'pane']);
    expect(pathWords('src/main/pty/session-manager.ts')).toEqual(['main', 'pty', 'session', 'manager']);
  });

  it('lists the most-changed files first, each with its words', () => {
    const chunks = changeRecordChunks([
      { path: 'src/a.ts', changes: 1 },
      { path: 'src/main/pty/session-manager.ts', changes: 5 },
    ], 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Files changed:\nsrc/main/pty/session-manager.ts (main pty session manager)\nsrc/a.ts');
    expect(chunks[0].tsStart).toBe(100);
  });

  it('splits a long list across chunks, each under the size and each with the header', () => {
    const files = Array.from({ length: 80 }, (_unused, index) => ({ path: `src/feature/module-number-${index}/component.ts`, changes: 1 }));
    const chunks = changeRecordChunks(files, null);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('Files changed:\n')).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(1600);
    }
  });

  it('has no chunks for a session that changed nothing', () => {
    expect(changeRecordChunks([], null)).toEqual([]);
  });
});

interface Call { sql: string; args: unknown[] }

function fakeIndex(state: {
  conversations: Array<{ docId: string; sessionId: string; indexedAt: string }>;
  signatures?: Array<{ docId: string; sourcePath: string; sourceMtimeMs: number }>;
  chunkText: string;
  /** Chunks each conversation holds, all with `chunkText`. One when unset. */
  chunkCount?: number;
  /** Runs on every page read, as a page's cost on the clock. */
  onPageRead?: () => void;
}): { db: Database.Database; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const answer = (args: unknown[]): unknown[] => {
        calls.push({ sql, args });
        if (sql.includes("WHERE corpus = 'conversation'") && sql.includes('memory_index_state')) return state.conversations;
        if (sql.includes('FROM memory_index_state WHERE corpus = ?')) return state.signatures ?? [];
        if (sql.includes('FROM memory_chunks WHERE corpus = ? AND doc_id = ? AND seq > ?')) {
          state.onPageRead?.();
          const [, , afterSeq, limit] = args as [string, string, number, number];
          const total = state.chunkCount ?? 1;
          const rows = [];
          for (let seq = afterSeq + 1; seq < total && rows.length < limit; seq += 1) {
            rows.push({ seq, text: state.chunkText, sessionId: 'session-1', taskId: 'task-1', tsEnd: 20 + seq });
          }
          return rows;
        }
        if (sql.includes('FROM sessions WHERE id = ?')) return [{ sessionType: 'claude_agent' }];
        return [];
      };
      return {
        all: (...args: unknown[]) => answer(args),
        get: (...args: unknown[]) => answer(args)[0],
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
          return { changes: 1, lastInsertRowid: 1 };
        },
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
  return { db, calls };
}

const deps = (db: Database.Database) => ({
  getDb: () => db,
  toolsFor: (sessionType: string) => (sessionType === 'claude_agent' ? TOOLS : []),
  now: () => '2026-09-28T00:00:00.000Z',
  clock: () => 0,
  yieldToEventLoop: async () => undefined,
});

describe('sweepChangeRecords', () => {
  const indexedAt = '2026-09-27T10:00:00.000Z';
  const chunkText = 'Tool: Edit {"file_path":"/home/dev/app/.kangentic/worktrees/7/src/main/pty/session-manager.ts","old_string":"x"';

  it('derives a conversation\'s changes under its own document id, owned by its session', async () => {
    const { db, calls } = fakeIndex({ conversations: [{ docId: 'agent-1', sessionId: 'session-1', indexedAt }], chunkText });

    const result = await sweepChangeRecords('project', '/home/dev/app', () => true, deps(db));

    expect(result).toEqual({ indexed: 1 });
    const insert = calls.find((call) => call.sql.includes('INSERT INTO memory_chunks'));
    // corpus, doc_id, seq, session_id, task_id, agent_session_id, role, text
    expect(insert?.args.slice(0, 6)).toEqual(['change', 'agent-1', 0, 'session-1', 'task-1', 'agent-1']);
    expect(insert?.args[7]).toBe('Files changed:\nsrc/main/pty/session-manager.ts (main pty session manager)');
    const state = calls.find((call) => call.sql.includes('INSERT INTO memory_index_state'));
    expect(state?.args.slice(0, 5)).toEqual(['change', 'agent-1', 'session-1', `change-record-v${CHANGE_RECORD_VERSION}`, Date.parse(indexedAt)]);
  });

  it('reads no chunk when every conversation is as it was last derived', async () => {
    const { db, calls } = fakeIndex({
      conversations: [{ docId: 'agent-1', sessionId: 'session-1', indexedAt }],
      signatures: [{ docId: 'agent-1', sourcePath: `change-record-v${CHANGE_RECORD_VERSION}`, sourceMtimeMs: Date.parse(indexedAt) }],
      chunkText,
    });

    const result = await sweepChangeRecords('project', '/home/dev/app', () => true, deps(db));

    expect(result).toEqual({ indexed: 0 });
    expect(calls.some((call) => call.sql.includes('FROM memory_chunks WHERE corpus = ? AND doc_id = ?'))).toBe(false);
    expect(calls.some((call) => /INSERT|DELETE/.test(call.sql))).toBe(false);
  });

  it('re-derives a conversation re-indexed since, and records that it changed nothing when it did not', async () => {
    const { db, calls } = fakeIndex({
      conversations: [{ docId: 'agent-1', sessionId: 'session-1', indexedAt: '2026-09-28T09:00:00.000Z' }],
      signatures: [{ docId: 'agent-1', sourcePath: `change-record-v${CHANGE_RECORD_VERSION}`, sourceMtimeMs: Date.parse(indexedAt) }],
      chunkText: 'Assistant: only talk, no edits',
    });

    const result = await sweepChangeRecords('project', '/home/dev/app', () => true, deps(db));

    expect(result).toEqual({ indexed: 1 });
    expect(calls.some((call) => call.sql.includes('INSERT INTO memory_chunks'))).toBe(false);
    expect(calls.find((call) => call.sql.includes('INSERT INTO memory_index_state'))?.args[4]).toBe(Date.parse('2026-09-28T09:00:00.000Z'));
  });

  it('reads a long conversation a page at a time, yielding between pages, and counts every edit', async () => {
    let nowMs = 0;
    const { db, calls } = fakeIndex({
      conversations: [{ docId: 'agent-1', sessionId: 'session-1', indexedAt }],
      chunkText,
      chunkCount: 5000,
      // Each page costs half a slice's budget, so a slice holds two.
      onPageRead: () => { nowMs += SLICE_BUDGET_MS / 2; },
    });
    let yields = 0;

    const result = await sweepChangeRecords('project', '/home/dev/app', () => true, {
      ...deps(db),
      clock: () => nowMs,
      yieldToEventLoop: async () => { yields += 1; },
    });

    expect(result).toEqual({ indexed: 1 });
    const pageReads = calls.filter((call) => call.sql.includes('AND seq > ?'));
    expect(pageReads.length).toBeGreaterThan(2);
    // No page reads the whole conversation, and the reads yield between them.
    expect(Math.max(...pageReads.map((call) => call.args[3] as number))).toBeLessThan(5000);
    expect(yields).toBeGreaterThanOrEqual(Math.floor(pageReads.length / 2) - 1);
    // Edits merged across every page into one file.
    const insert = calls.find((call) => call.sql.includes('INSERT INTO memory_chunks'));
    expect(insert?.args[7]).toBe('Files changed:\nsrc/main/pty/session-manager.ts (main pty session manager)');
    expect(calls.filter((call) => call.sql.includes('INSERT INTO memory_index_state'))).toHaveLength(1);
  });
});
