/**
 * Unit tests for copyEventBridgeInto: the workspace copy of the event bridge
 * that Qwen (on Windows) and Antigravity name in their hook commands. The copy
 * is checked on every spawn and rewritten only when its bytes differ from the
 * app's bridge, so an app update never leaves a stale copy and a spawn never
 * rewrites the file another session's hook is running.
 *
 * resolveBridgeScript is pointed at a scratch file, so the source bytes are
 * known and nothing outside os.tmpdir() is read or written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fakeBridgeSource: string;
const resolvedBridgeNames: string[] = [];
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => {
    resolvedBridgeNames.push(name);
    return fakeBridgeSource;
  }),
}));

import { copyBridgeInto, copyEventBridgeInto } from '../../src/main/agent/shared/workspace-bridge-copy';
import { isKangenticHookCommand } from '../../src/main/agent/shared/hook-utils';

const COPY_NAME = 'test-event-bridge.cjs';

// Bytes that are not valid UTF-8 (0xff) with an embedded NUL and a CRLF, so a
// text round trip or a length-only comparison would not pass for them.
const SOURCE_BYTES = Buffer.from([0x23, 0x21, 0xff, 0x00, 0x0d, 0x0a, 0x7e]);

describe('copyEventBridgeInto', () => {
  let scratchRoot: string;
  let workspaceDirectory: string;
  let copyPath: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-bridge-copy-'));
    workspaceDirectory = path.join(scratchRoot, 'workspace');
    fs.mkdirSync(workspaceDirectory);
    fakeBridgeSource = path.join(scratchRoot, 'event-bridge-source.js');
    fs.writeFileSync(fakeBridgeSource, SOURCE_BYTES);
    copyPath = path.join(workspaceDirectory, '.kangentic', COPY_NAME);
  });

  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('creates the .kangentic directory and the copy with the source bytes, and returns the copy path', () => {
    expect(fs.existsSync(path.join(workspaceDirectory, '.kangentic'))).toBe(false);

    const returnedPath = copyEventBridgeInto(workspaceDirectory, COPY_NAME);

    expect(returnedPath).toBe(copyPath);
    expect(fs.readFileSync(copyPath).equals(SOURCE_BYTES)).toBe(true);
  });

  it('leaves a copy whose bytes match the source untouched', () => {
    // The pin for "rewritten only when its bytes differ": an old modification
    // time on an identical copy must survive the call. A call that rewrites the
    // file unconditionally stamps a new time, because the source (created just
    // now in beforeEach) is newer than the copy, and that holds whether the
    // platform's copy keeps the source's time (Windows) or stamps its own (POSIX).
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.writeFileSync(copyPath, SOURCE_BYTES);
    const oldModifiedTime = new Date('2001-01-01T00:00:00.000Z');
    fs.utimesSync(copyPath, oldModifiedTime, oldModifiedTime);
    const modifiedTimeBefore = fs.statSync(copyPath).mtimeMs;
    expect(fs.statSync(fakeBridgeSource).mtimeMs, 'fixture: the source must be newer than the copy').toBeGreaterThan(modifiedTimeBefore);

    const returnedPath = copyEventBridgeInto(workspaceDirectory, COPY_NAME);

    expect(returnedPath).toBe(copyPath);
    expect(fs.statSync(copyPath).mtimeMs).toBe(modifiedTimeBefore);
    expect(fs.readFileSync(copyPath).equals(SOURCE_BYTES)).toBe(true);
  });

  it('replaces a copy whose bytes differ from the source', () => {
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    // A stale bridge from an older app: different content and a different length.
    fs.writeFileSync(copyPath, 'stale bridge from an older app version');

    const returnedPath = copyEventBridgeInto(workspaceDirectory, COPY_NAME);

    expect(returnedPath).toBe(copyPath);
    expect(fs.readFileSync(copyPath).equals(SOURCE_BYTES)).toBe(true);
  });

  it('replaces a stale copy that has the same length as the source', () => {
    // A length-only or mtime-only comparison would keep this one.
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    const sameLengthStaleBytes = Buffer.alloc(SOURCE_BYTES.length, 0x41);
    fs.writeFileSync(copyPath, sameLengthStaleBytes);

    copyEventBridgeInto(workspaceDirectory, COPY_NAME);

    expect(fs.readFileSync(copyPath).equals(SOURCE_BYTES)).toBe(true);
  });

  it('throws when there is no copy and the source cannot be read', () => {
    fakeBridgeSource = path.join(scratchRoot, 'does-not-exist.js');

    expect(() => copyEventBridgeInto(workspaceDirectory, COPY_NAME)).toThrow(/ENOENT/);
    expect(fs.existsSync(copyPath)).toBe(false);
  });

  it('throws when a copy exists and the source cannot be read, leaving the copy as it was', () => {
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.writeFileSync(copyPath, 'copy from an earlier spawn');
    fakeBridgeSource = path.join(scratchRoot, 'does-not-exist.js');

    expect(() => copyEventBridgeInto(workspaceDirectory, COPY_NAME)).toThrow(/ENOENT/);
    expect(fs.readFileSync(copyPath, 'utf-8')).toBe('copy from an earlier spawn');
  });

  it('throws when the .kangentic directory cannot be created', () => {
    // A FILE named .kangentic: mkdir cannot make the directory and the copy
    // cannot be written under it.
    fs.writeFileSync(path.join(workspaceDirectory, '.kangentic'), 'a file, not a directory');

    expect(() => copyEventBridgeInto(workspaceDirectory, COPY_NAME)).toThrow(/\.kangentic/);
  });
});

describe('copyBridgeInto (task #859)', () => {
  let scratchRoot: string;
  let workspaceDirectory: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-bridge-copy-'));
    workspaceDirectory = path.join(scratchRoot, 'workspace');
    fs.mkdirSync(workspaceDirectory);
    fakeBridgeSource = path.join(scratchRoot, 'hint-bridge-source.js');
    fs.writeFileSync(fakeBridgeSource, SOURCE_BYTES);
    resolvedBridgeNames.length = 0;
  });

  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('copies the background shell hint bridge, resolving that script by name', () => {
    const copy = copyBridgeInto(workspaceDirectory, 'background-shell-hint-bridge', 'qwen-background-shell-hint-bridge.cjs');
    expect(copy).toBe(path.join(workspaceDirectory, '.kangentic', 'qwen-background-shell-hint-bridge.cjs'));
    expect(fs.readFileSync(copy).equals(SOURCE_BYTES)).toBe(true);
    expect(resolvedBridgeNames).toEqual(['background-shell-hint-bridge']);
  });

  it('refuses a copy name that does not contain the script name, which hook cleanup could not recognize', () => {
    expect(() => copyBridgeInto(workspaceDirectory, 'background-shell-hint-bridge', 'qwen-hint.cjs')).toThrow(/must contain/);
    expect(fs.existsSync(path.join(workspaceDirectory, '.kangentic'))).toBe(false);
  });

  it('names a copy that hook cleanup recognizes as Kangentic-injected', () => {
    const copy = copyBridgeInto(workspaceDirectory, 'background-shell-hint-bridge', 'qwen-background-shell-hint-bridge.cjs');
    const relative = path.relative(workspaceDirectory, copy).split(path.sep).join('/');
    expect(isKangenticHookCommand(`node ${relative} eyJsYXVuY2giOnt9fQ==`)).toBe(true);
  });
});
