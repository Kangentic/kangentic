/**
 * `markRange` places the highlight on the first query token inside a snippet.
 * It strips double quotes from each token exactly as `escapeFtsMatchQuery`
 * does, so the word the database matched is the word that gets marked.
 *
 * Tier: Unit. The last test runs the real Command Terminal search on migrated
 * better-sqlite3 so the range is checked against what FTS5 returns.
 *
 * Red-green: restore the old tokenizer in `markRange` (no `replace(/"/g, '')`)
 * and the quoted cases go red: the token keeps its quote, is not found in the
 * snippet, and the range falls back to 0/0.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { markRange } from '../../src/main/retrieval/memory-search';
import { searchCommandTerminalConversations } from '../../src/main/retrieval/conversation/command-terminal-search';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('markRange', () => {
  const snippet = 'the rail fix landed';

  it('marks a plain word', () => {
    expect(markRange(snippet, 'rail')).toEqual({ start: 4, end: 8 });
  });

  it('marks the first word of a quoted phrase, without the quote', () => {
    const range = markRange(snippet, '"rail fix"');
    expect(range).toEqual({ start: 4, end: 8 });
    expect(snippet.slice(range.start, range.end)).toBe('rail');
  });

  it('skips a lone quote and marks the word after it', () => {
    const range = markRange(snippet, '" rail');
    expect(range).toEqual({ start: 4, end: 8 });
    expect(snippet.slice(range.start, range.end)).toBe('rail');
  });

  it('marks nothing for a query of only a quote, even when the snippet has one', () => {
    expect(markRange(snippet, '"')).toEqual({ start: 0, end: 0 });
    // A quote left in the token would find this one and mark it.
    expect(markRange('they said "rail"', '"')).toEqual({ start: 0, end: 0 });
  });

  it('marks nothing when the word is not in the snippet', () => {
    expect(markRange(snippet, 'absent')).toEqual({ start: 0, end: 0 });
  });
});

describe('searchCommandTerminalConversations: a quoted query', () => {
  it('returns a range that covers the matched word', () => {
    const database = openTestDatabase();
    openDatabases.push(database);
    runProjectMigrations(database);
    new RetrievalStore(database).upsertDocument(
      { corpus: 'command_terminal', docId: 'conversation-a', sessionId: null, taskId: null, agentSessionId: 'conversation-a', metaJson: null },
      [{ seq: 0, role: 'user', text: 'the rail fix landed', contentHash: 'hash-1', tokenEstimate: 5, tsStart: null, tsEnd: null, turnUuidStart: null, turnUuidEnd: null }],
    );

    const [hit] = searchCommandTerminalConversations(database, '"rail fix"');

    expect(hit.agentSessionId).toBe('conversation-a');
    expect(hit.matchEnd).toBeGreaterThan(hit.matchStart);
    expect(hit.snippet.slice(hit.matchStart, hit.matchEnd).toLowerCase()).toBe('rail');
  });
});
