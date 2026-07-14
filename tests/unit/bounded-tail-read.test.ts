import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBoundedTail } from '../../src/main/agent/commands/bounded-tail-read';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kang-tail-read-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('readBoundedTail', () => {
  it('returns the whole file untruncated when under the cap', () => {
    const content = 'line one\nline two\nline three';
    const filePath = writeFile('small.jsonl', content);

    const result = readBoundedTail(filePath, 1024);

    expect(result.content).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(Buffer.byteLength(content));
  });

  it('returns the tail window with the leading partial line dropped when over the cap', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `{"event":"E${index}","pad":"${'x'.repeat(40)}"}`);
    const content = lines.join('\n');
    const filePath = writeFile('big.jsonl', content);
    const cap = 500;

    const result = readBoundedTail(filePath, cap);

    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(Buffer.byteLength(content));
    expect(result.content.length).toBeLessThan(cap);
    // The seek lands mid-line; the partial first line must be gone, so every
    // returned line is intact JSON.
    const returnedLines = result.content.split('\n').filter((line) => line.length > 0);
    expect(returnedLines.length).toBeGreaterThan(0);
    for (const line of returnedLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // The window is the END of the file.
    expect(returnedLines[returnedLines.length - 1]).toBe(lines[lines.length - 1]);
  });

  it('does not truncate a file exactly at the cap', () => {
    const content = 'a'.repeat(64);
    const filePath = writeFile('exact.txt', content);

    const result = readBoundedTail(filePath, 64);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('returns the raw window when the tail contains no newline', () => {
    const content = 'b'.repeat(200);
    const filePath = writeFile('one-line.txt', content);

    const result = readBoundedTail(filePath, 50);

    expect(result.truncated).toBe(true);
    expect(result.content).toBe('b'.repeat(50));
  });

  it('throws on a missing file (callers keep their own error semantics)', () => {
    expect(() => readBoundedTail(path.join(tempDir, 'nope.jsonl'), 1024)).toThrow();
  });
});
