import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSyncSpanLabelSink } from '../../src/main/diagnostics/event-loop-lag';
import { loadBetterSqlite3 } from '../../src/main/agent/shared/sqlite-loader';
import { withGooseDatabase } from '../../src/main/agent/adapters/goose/session-store';
import { withDatabase as withOpenCodeDatabase } from '../../src/main/agent/adapters/opencode/transcript-parser';
import { splitJsonlLines } from '../../src/main/agent/shared/jsonl-history-page';
import { parseGeminiTranscript } from '../../src/main/agent/adapters/gemini/transcript-parser';
import { aiderTranscriptUsage, parseAiderTranscript } from '../../src/main/agent/adapters/aider/transcript-parser';
import { aiderHistoryPath } from '../../src/main/agent/adapters/aider/history-paths';

/**
 * Pins a label the retrieval worker's event-loop watchdog names, for the spans the
 * `transcript:parse-` scan in event-loop-watchdog.test.ts cannot see: the SQLite
 * readers (`transcript:read-goose`, `transcript:read-opencode`), the line splitter
 * (`transcript:split-lines`), Gemini's legacy single-object branch, and the two
 * Aider sites. A hold in one of these reads as "outside any labelled step" in a
 * crash report when its span is gone.
 *
 * The label sink stands in for a real held loop: `current` is the span in force
 * right now, so a callback or a `JSON.parse` spy running inside the work reads it.
 * Each test fails if its span is removed, because `current` is then null (or the
 * label never appears in the sink's sequence).
 */

let current: string | null = null;
let seen: Array<string | null> = [];
let directory: string;

beforeEach(() => {
  current = null;
  seen = [];
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-sync-spans-'));
  setSyncSpanLabelSink((label) => {
    current = label;
    seen.push(label);
  });
});

afterEach(() => {
  setSyncSpanLabelSink(null);
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** A real SQLite file with one table, so the readers open it for real. */
function createDatabaseFile(fileName: string): string {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) throw new Error('better-sqlite3 failed to load');
  const dbPath = path.join(directory, fileName);
  const database = new DatabaseConstructor(dbPath);
  database.exec('CREATE TABLE sample (id INTEGER)');
  database.close();
  return dbPath;
}

describe('SQLite transcript readers', () => {
  it('names transcript:read-goose while the read callback runs', () => {
    const dbPath = createDatabaseFile('sessions.db');
    let labelDuringRead: string | null = 'not-run';
    const result = withGooseDatabase(dbPath, 'fallback', () => {
      labelDuringRead = current;
      return 'read';
    });
    expect(result).toBe('read');
    expect(labelDuringRead).toBe('transcript:read-goose');
    expect(current).toBeNull();
  });

  it('names transcript:read-opencode while the read callback runs', () => {
    const dbPath = createDatabaseFile('opencode.db');
    let labelDuringRead: string | null = 'not-run';
    const result = withOpenCodeDatabase(dbPath, 'fallback', () => {
      labelDuringRead = current;
      return 'read';
    });
    expect(result).toBe('read');
    expect(labelDuringRead).toBe('transcript:read-opencode');
    expect(current).toBeNull();
  });
});

describe('splitJsonlLines', () => {
  it('names transcript:split-lines while the text is split', () => {
    const labelsWhileSplitting: Array<string | null> = [];
    const watchedText = {
      get length(): number {
        labelsWhileSplitting.push(current);
        return 4;
      },
      split: (separator: string): string[] => {
        labelsWhileSplitting.push(current);
        return 'a\nb\n'.split(separator);
      },
    } as unknown as string;

    const lines = splitJsonlLines(watchedText, 0, 0);

    expect(lines.map((line) => line.text)).toEqual(['a', 'b']);
    expect(labelsWhileSplitting.length).toBeGreaterThan(0);
    expect(new Set(labelsWhileSplitting)).toEqual(new Set(['transcript:split-lines']));
  });
});

describe('parseGeminiTranscript legacy single-object form', () => {
  it('names transcript:parse-gemini while the one object is parsed', async () => {
    const sentinel = 'legacy-gemini-sentinel';
    const transcriptPath = path.join(directory, 'legacy.json');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      sessionId: 'legacy-session',
      messages: [{ id: 'message-1', type: 'user', timestamp: '2026-11-03T10:00:00.000Z', content: sentinel }],
    }));
    const originalParse = JSON.parse;
    const labelsWhileParsing: Array<string | null> = [];
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.includes(sentinel)) labelsWhileParsing.push(current);
      return originalParse(text, reviver);
    });

    const entries = await parseGeminiTranscript('legacy-session', transcriptPath);

    expect(entries.length).toBeGreaterThan(0);
    expect(labelsWhileParsing.length).toBeGreaterThan(0);
    expect(new Set(labelsWhileParsing)).toEqual(new Set(['transcript:parse-gemini']));
  });
});

describe('Aider transcript spans', () => {
  const SESSION_ID = 'aider-session';
  const HISTORY = [
    '# aider chat started at 2026-11-03 10:00:00',
    '',
    '#### hello',
    '',
    'hi there',
    '',
    '> Tokens: 1.2k sent, 300 received.',
    '',
  ].join('\n');

  function writeHistory(): void {
    fs.writeFileSync(aiderHistoryPath(directory, SESSION_ID), HISTORY);
  }

  it('names transcript:parse-aider around parseAiderTranscript\'s parse', async () => {
    writeHistory();
    const result = await parseAiderTranscript(SESSION_ID, directory);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(seen).toContain('transcript:parse-aider');
    expect(current).toBeNull();
  });

  it('names transcript:parse-aider around aiderTranscriptUsage\'s summary, on its own', async () => {
    writeHistory();
    const usage = await aiderTranscriptUsage(SESSION_ID, directory);
    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(seen).toContain('transcript:parse-aider');
    expect(current).toBeNull();
  });
});
