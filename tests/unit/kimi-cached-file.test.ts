/**
 * The cache behind Kimi Code's session index and config reads. The id capture
 * polls the index once a second, so it must not parse an unchanged file each
 * time, and a file the CLI changes must never be served stale: a stale index
 * misses the new session, a stale config shows an old model name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedFileReader } from '../../src/main/agent/adapters/kimi/cached-file';

const EMPTY = 'EMPTY';

let directory: string;
let filePath: string;
let parseCalls: number;

function parse(text: string): string {
  parseCalls += 1;
  return `parsed:${text}`;
}

/** Write the file and pin its mtime, so a test controls what the cache compares. */
function writeFile(text: string, mtimeSeconds: number): void {
  fs.writeFileSync(filePath, text);
  fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-cached-'));
  filePath = path.join(directory, 'index.jsonl');
  parseCalls = 0;
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('cachedFileReader', () => {
  it('parses once while the size and mtime hold', () => {
    writeFile('one', 1_000_000);
    const read = cachedFileReader(parse, EMPTY);
    expect(read(filePath)).toBe('parsed:one');
    expect(read(filePath)).toBe('parsed:one');
    expect(read(filePath)).toBe('parsed:one');
    expect(parseCalls).toBe(1);
  });

  it('parses again after an append', () => {
    writeFile('one', 1_000_000);
    const read = cachedFileReader(parse, EMPTY);
    read(filePath);
    fs.appendFileSync(filePath, 'two');
    fs.utimesSync(filePath, 1_000_000, 1_000_000);
    expect(read(filePath)).toBe('parsed:onetwo');
    expect(parseCalls).toBe(2);
  });

  it('parses again after a rewrite of the same size with a changed mtime', () => {
    writeFile('aaaa', 1_000_000);
    const read = cachedFileReader(parse, EMPTY);
    expect(read(filePath)).toBe('parsed:aaaa');
    writeFile('bbbb', 1_000_010);
    expect(read(filePath)).toBe('parsed:bbbb');
    expect(parseCalls).toBe(2);
  });

  it('answers empty for a missing file and forgets its entry, so the file back is read again', () => {
    writeFile('one', 1_000_000);
    const read = cachedFileReader(parse, EMPTY);
    expect(read(filePath)).toBe('parsed:one');
    fs.rmSync(filePath);
    expect(read(filePath)).toBe(EMPTY);
    expect(parseCalls).toBe(1);
    // Same size and mtime as the entry the read dropped: only a forgotten
    // entry makes this parse again.
    writeFile('one', 1_000_000);
    expect(read(filePath)).toBe('parsed:one');
    expect(parseCalls).toBe(2);
  });

  it('answers empty for a parse that throws, and tries again on the next read', () => {
    writeFile('one', 1_000_000);
    let attempts = 0;
    const read = cachedFileReader((text: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('torn record');
      return `parsed:${text}`;
    }, EMPTY);
    expect(read(filePath)).toBe(EMPTY);
    expect(read(filePath)).toBe('parsed:one');
    expect(attempts).toBe(2);
  });

  it('keeps one entry per file', () => {
    const otherPath = path.join(directory, 'other.jsonl');
    writeFile('one', 1_000_000);
    fs.writeFileSync(otherPath, 'two');
    const read = cachedFileReader(parse, EMPTY);
    expect(read(filePath)).toBe('parsed:one');
    expect(read(otherPath)).toBe('parsed:two');
    expect(read(filePath)).toBe('parsed:one');
    expect(parseCalls).toBe(2);
  });
});
