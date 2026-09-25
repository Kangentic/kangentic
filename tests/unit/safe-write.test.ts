import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeWriteJson } from '../../src/main/safe-write';
import {
  setSyncWriteFailureNotifier,
  __resetForTest,
} from '../../src/main/config/write-failure-notice';

// Covers the guard at the center of .claude/rules/guarded-sync-writes.md: mkdir +
// write-to-temp + rename, all inside one try, never throwing. tmpDir writes stay under
// os.tmpdir() per .claude/rules/cross-platform-parity.md.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-safe-write-'));
  __resetForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  __resetForTest();
});

describe('safeWriteJson', () => {
  it('creates the target directory, writes the content, and returns true', () => {
    const filePath = path.join(tmpDir, 'nested', 'value.json');

    const result = safeWriteJson(filePath, { hello: 'world' }, 'test_source');

    expect(result).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ hello: 'world' });
  });

  it('leaves no `.tmp.<pid>` file behind on success', () => {
    const filePath = path.join(tmpDir, 'value.json');

    safeWriteJson(filePath, { a: 1 }, 'test_source');

    const entries = fs.readdirSync(tmpDir);
    expect(entries).toEqual(['value.json']);
  });

  it('forwards the mode option without throwing', () => {
    const filePath = path.join(tmpDir, 'secret.json');

    const result = safeWriteJson(filePath, { token: 'x' }, 'test_source', { mode: 0o600 });

    expect(result).toBe(true);
    // Exact permission bits are POSIX-only (Windows does not honor the owner/group/other
    // split the same way), matching the tolerance convention in cross-platform-parity.md.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('returns false and cleans up its temp file when the rename target cannot be replaced', () => {
    // A rename onto an existing, non-empty directory fails on every OS (EISDIR on
    // POSIX, an equivalent refusal on Windows), which is a reliable way to make the
    // write-to-temp succeed but the final rename fail, without depending on
    // permission semantics.
    const filePath = path.join(tmpDir, 'blocked.json');
    fs.mkdirSync(filePath, { recursive: true });
    fs.writeFileSync(path.join(filePath, 'occupant'), '');

    const notifier: string[] = [];
    setSyncWriteFailureNotifier((message) => notifier.push(message));

    const result = safeWriteJson(filePath, { a: 1 }, 'test_source');

    expect(result).toBe(false);
    expect(notifier).toHaveLength(1);
    // The blocking directory is untouched, and the temp file it could not
    // replace is not left behind on disk.
    expect(fs.statSync(filePath).isDirectory()).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual(['blocked.json']);
  });

  it('re-arms the failure latch after a later successful write to the same source', () => {
    const filePath = path.join(tmpDir, 'blocked.json');
    fs.mkdirSync(filePath, { recursive: true });
    fs.writeFileSync(path.join(filePath, 'occupant'), '');

    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));

    expect(safeWriteJson(filePath, { a: 1 }, 'test_source')).toBe(false);
    expect(notifications).toHaveLength(1);

    // A successful write for the SAME source clears the latch.
    expect(safeWriteJson(path.join(tmpDir, 'ok.json'), { a: 1 }, 'test_source')).toBe(true);

    // So a later failure of that source reports again.
    expect(safeWriteJson(filePath, { a: 1 }, 'test_source')).toBe(false);
    expect(notifications).toHaveLength(2);
  });
});
