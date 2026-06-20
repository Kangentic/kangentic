/**
 * Unit tests for the shared async session-history primitives
 * (src/main/agent/shared/history-scan.ts).
 *
 * These run against a real temp directory (under os.tmpdir, per the
 * cross-platform test-write rule) with deterministic mtimes set via utimesSync,
 * so mtime ranking and byte-bounding are exercised without depending on
 * filesystem timing. The per-adapter capability-discovery tests mock these
 * primitives; this suite is where their fs correctness is pinned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
  readTailBytes,
  readWholeFile,
  parseJsonlRecords,
} from '../../src/main/agent/shared/history-scan';

let root: string;

/** Set a file/dir mtime to a fixed epoch-second offset for deterministic ranking. */
function setMtime(target: string, epochSeconds: number): void {
  utimesSync(target, epochSeconds, epochSeconds);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'kng-history-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listMostRecentDirs', () => {
  it('returns subdirectories newest-first and capped at maxEntries', async () => {
    for (const [name, mtime] of [['old', 100], ['mid', 200], ['new', 300]] as const) {
      const dir = path.join(root, name);
      mkdirSync(dir);
      setMtime(dir, mtime);
    }

    const entries = await listMostRecentDirs(root, 2);

    expect(entries.map((entry) => path.basename(entry.fullPath))).toEqual(['new', 'mid']);
  });

  it('returns [] when the parent directory does not exist', async () => {
    const entries = await listMostRecentDirs(path.join(root, 'missing'), 5);
    expect(entries).toEqual([]);
  });

  it('ignores files, returning only directories', async () => {
    mkdirSync(path.join(root, 'a-dir'));
    writeFileSync(path.join(root, 'a-file.txt'), 'x');

    const entries = await listMostRecentDirs(root, 5);

    expect(entries.map((entry) => path.basename(entry.fullPath))).toEqual(['a-dir']);
  });

  it('ranks by an mtimeSubpath and drops entries lacking it when required', async () => {
    // `withChats` has a chats/ subdir; `noChats` does not. With
    // requireMtimeSubpath, only the former survives.
    const withChats = path.join(root, 'withChats');
    const noChats = path.join(root, 'noChats');
    mkdirSync(withChats);
    mkdirSync(noChats);
    const chats = path.join(withChats, 'chats');
    mkdirSync(chats);
    setMtime(chats, 500);

    const entries = await listMostRecentDirs(root, 5, {
      mtimeSubpath: 'chats',
      requireMtimeSubpath: true,
    });

    expect(entries.map((entry) => path.basename(entry.fullPath))).toEqual(['withChats']);
  });
});

describe('listMostRecentFiles', () => {
  it('returns matching files newest-first and capped at maxEntries', async () => {
    for (const [name, mtime] of [['a.jsonl', 100], ['b.jsonl', 300], ['c.jsonl', 200]] as const) {
      const file = path.join(root, name);
      writeFileSync(file, 'x');
      setMtime(file, mtime);
    }
    writeFileSync(path.join(root, 'skip.txt'), 'x');

    const entries = await listMostRecentFiles(root, (name) => name.endsWith('.jsonl'), 2);

    expect(entries.map((entry) => path.basename(entry.fullPath))).toEqual(['b.jsonl', 'c.jsonl']);
  });

  it('returns [] when the directory does not exist', async () => {
    const entries = await listMostRecentFiles(path.join(root, 'missing'), () => true, 5);
    expect(entries).toEqual([]);
  });
});

describe('readHeadBytes', () => {
  it('reads only the head up to maxBytes', async () => {
    const file = path.join(root, 'big.txt');
    writeFileSync(file, 'ABCDEFGHIJ');

    const head = await readHeadBytes(file, 4);

    expect(head).toBe('ABCD');
  });

  it('returns the whole file when it is smaller than maxBytes', async () => {
    const file = path.join(root, 'small.txt');
    writeFileSync(file, 'hi');

    expect(await readHeadBytes(file, 1024)).toBe('hi');
  });

  it('returns "" for a missing file', async () => {
    expect(await readHeadBytes(path.join(root, 'nope.txt'), 1024)).toBe('');
  });
});

describe('readTailBytes', () => {
  it('reads the tail and drops the truncated first partial line', async () => {
    const file = path.join(root, 'tail.jsonl');
    // 12 bytes: "111\n222\n333\n". Reading the last 6 bytes starts mid-record,
    // so the truncated leading fragment is dropped, leaving the final record.
    writeFileSync(file, '111\n222\n333\n');

    const tail = await readTailBytes(file, 6);

    expect(tail).toBe('333\n');
  });

  it('returns the whole file (no drop) when it fits within maxBytes', async () => {
    const file = path.join(root, 'small.jsonl');
    writeFileSync(file, '111\n222\n');

    expect(await readTailBytes(file, 1024)).toBe('111\n222\n');
  });

  it('returns "" for a missing file', async () => {
    expect(await readTailBytes(path.join(root, 'nope.jsonl'), 1024)).toBe('');
  });
});

describe('readWholeFile', () => {
  it('reads the entire file', async () => {
    const file = path.join(root, 'whole.json');
    writeFileSync(file, '{"model":"x"}');

    expect(await readWholeFile(file)).toBe('{"model":"x"}');
  });

  it('returns "" for a missing file', async () => {
    expect(await readWholeFile(path.join(root, 'nope.json'))).toBe('');
  });
});

describe('parseJsonlRecords', () => {
  it('parses object records and skips blank and unparseable lines', () => {
    const text = '{"a":1}\n\nnot json\n{"b":2}\n';
    const records = parseJsonlRecords(text, false);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips non-object JSON values (numbers, strings, arrays)', () => {
    const text = '42\n"hello"\n[1,2]\n{"ok":true}\n';
    const records = parseJsonlRecords(text, false);
    expect(records).toEqual([{ ok: true }]);
  });

  it('drops the last line when dropLastPartialLine is true', () => {
    // A head read that truncated mid-record: the final fragment must be dropped.
    const text = '{"a":1}\n{"b":2}\n{"trunc":';
    const records = parseJsonlRecords(text, true);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps the final record when dropLastPartialLine is false', () => {
    const text = '{"a":1}\n{"b":2}';
    const records = parseJsonlRecords(text, false);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
