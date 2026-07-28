/**
 * Unit coverage for scripts/preview-exit-record.js - the shared contract
 * between scripts/dev.js (writes { pid, exitCode } as the first statement of
 * cleanup(), before ephemeral mode removes the worktree's .kangentic/
 * directory) and scripts/worktree-preview.js's --wait watcher (classifies
 * why a preview exited from that record plus PID liveness).
 *
 * Three concerns, three describe groups:
 *  - normalizeWorktreeKey/exitRecordPath: pure path functions, no filesystem
 *    writes, plain object fixtures.
 *  - classifyPreviewExit: pure logic, plain object fixtures.
 *  - writeExitRecord/readExitRecord/clearExitRecord: real filesystem I/O
 *    under a per-test fs.mkdtempSync(os.tmpdir()) directory, because
 *    classifyPreviewExit passing proves nothing about whether a record is
 *    ever actually written to or parsed back from disk.
 *  - scripts/dev.js cleanup() ordering: a static source-order check (no
 *    filesystem writes, just fs.readFileSync) pinning that writeExitRecord()
 *    runs before the ephemeral .kangentic/ removal - see that describe
 *    block's comment for why the order is load-bearing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// scripts/preview-exit-record.js is CJS (a build/dev script, not bundled
// src - the esbuild-cjs-imports rule scopes to src/, not scripts/);
// vite-node's require/import interop lets these named exports come through
// a plain ES import, mirroring tests/unit/assert-vendor-chunks-lazy.test.ts
// importing scripts/build.js the same way.
import {
  normalizeWorktreeKey,
  exitRecordPath,
  writeExitRecord,
  readExitRecord,
  clearExitRecord,
  classifyPreviewExit,
} from '../../scripts/preview-exit-record.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

const isWindows = process.platform === 'win32';
const WORKTREE_A = isWindows ? 'C:\\Users\\dev\\kangentic\\.kangentic\\worktrees\\task-a' : '/Users/dev/kangentic/.kangentic/worktrees/task-a';
const WORKTREE_B = isWindows ? 'C:\\Users\\dev\\kangentic\\.kangentic\\worktrees\\task-b' : '/Users/dev/kangentic/.kangentic/worktrees/task-b';

// A Windows-shaped literal, asserted on EVERY platform. Off win32 the
// backslash-normalization tests would otherwise be tautologies: WORKTREE_A is
// a POSIX path there, so "contains no backslash" is trivially true and the
// branch that actually does the replacing never gets exercised on Linux CI.
// normalizeWorktreeKey is a pure string/path function, so feeding it a
// foreign-shaped path is safe on any host.
const WINDOWS_SHAPED_PATH = 'C:\\Users\\dev\\kangentic\\worktrees\\task-a';

describe('normalizeWorktreeKey', () => {
  it('normalizes backslashes to forward slashes on every platform', () => {
    expect(normalizeWorktreeKey(WINDOWS_SHAPED_PATH)).not.toContain('\\');
  });

  it('is stable under trailing-slash and relative-vs-resolved differences', () => {
    expect(normalizeWorktreeKey(`${WORKTREE_A}${isWindows ? '\\' : '/'}.`)).toBe(
      normalizeWorktreeKey(WORKTREE_A)
    );
  });

  (isWindows ? it : it.skip)('is case-insensitive on win32', () => {
    expect(normalizeWorktreeKey(WORKTREE_A.toUpperCase())).toBe(normalizeWorktreeKey(WORKTREE_A.toLowerCase()));
  });

  (isWindows ? it.skip : it)('is case-sensitive off win32', () => {
    expect(normalizeWorktreeKey(WORKTREE_A.toUpperCase())).not.toBe(normalizeWorktreeKey(WORKTREE_A.toLowerCase()));
  });
});

describe('exitRecordPath', () => {
  it('resolves under the OS temp directory', () => {
    expect(exitRecordPath(WORKTREE_A, 5174).startsWith(os.tmpdir())).toBe(true);
  });

  // Asserted unconditionally: on Linux CI the old form compared WORKTREE_A to
  // itself, so it proved nothing. Backslash-vs-forward-slash spellings of one
  // path must collapse to one key on every platform, or dev.js and the --wait
  // watcher could key the same worktree to two different record files.
  it('is identical for separator-only spelling differences of the same worktree', () => {
    expect(exitRecordPath(WINDOWS_SHAPED_PATH, 5174)).toBe(
      exitRecordPath(WINDOWS_SHAPED_PATH.replace(/\\/g, '/'), 5174)
    );
  });

  (isWindows ? it : it.skip)('is identical for casing-only differences on win32', () => {
    expect(exitRecordPath(WORKTREE_A.toUpperCase(), 5174)).toBe(exitRecordPath(WORKTREE_A, 5174));
  });

  it('differs for different ports on the same worktree', () => {
    expect(exitRecordPath(WORKTREE_A, 5174)).not.toBe(exitRecordPath(WORKTREE_A, 5175));
  });

  it('differs for different worktrees on the same port', () => {
    expect(exitRecordPath(WORKTREE_A, 5174)).not.toBe(exitRecordPath(WORKTREE_B, 5174));
  });
});

describe('classifyPreviewExit', () => {
  it('reports clean when the matching record has exitCode 0', () => {
    const verdict = classifyPreviewExit({
      record: { pid: 100, exitCode: 0 },
      watchedPid: 100,
      processAlive: false,
      stopRequested: false,
    });
    expect(verdict).toEqual({ status: 'clean', code: 0 });
  });

  it('reports crashed when the matching record has a non-zero exitCode', () => {
    const verdict = classifyPreviewExit({
      record: { pid: 100, exitCode: 1 },
      watchedPid: 100,
      processAlive: false,
      stopRequested: false,
    });
    expect(verdict).toEqual({ status: 'crashed', code: 2 });
  });

  it('reports clean when the process is gone with no record but a stop was requested', () => {
    const verdict = classifyPreviewExit({
      record: null,
      watchedPid: 100,
      processAlive: false,
      stopRequested: true,
    });
    expect(verdict).toEqual({ status: 'clean', code: 0 });
  });

  it('reports vanished when the process is gone with no record and no stop was requested', () => {
    const verdict = classifyPreviewExit({
      record: null,
      watchedPid: 100,
      processAlive: false,
      stopRequested: false,
    });
    expect(verdict).toEqual({ status: 'vanished', code: 3 });
  });

  it('keeps polling (null) while the process is alive and there is no record', () => {
    const verdict = classifyPreviewExit({
      record: null,
      watchedPid: 100,
      processAlive: true,
      stopRequested: false,
    });
    expect(verdict).toBeNull();
  });

  it('ignores a stale record from a different PID while the current process is alive', () => {
    const verdict = classifyPreviewExit({
      record: { pid: 99, exitCode: 0 },
      watchedPid: 100,
      processAlive: true,
      stopRequested: false,
    });
    expect(verdict).toBeNull();
  });

  it('falls back to the liveness-based verdict when the record belongs to a different PID and the process is gone', () => {
    const verdict = classifyPreviewExit({
      record: { pid: 99, exitCode: 0 },
      watchedPid: 100,
      processAlive: false,
      stopRequested: true,
    });
    expect(verdict).toEqual({ status: 'clean', code: 0 });
  });

  // A matching record is terminal and takes priority over BOTH processAlive
  // and stopRequested - the function checks the record branch first and
  // returns unconditionally from it. This matters beyond the ordinary
  // wind-down race (dev.js writes the record, then exits, so processAlive
  // usually catches up a poll later anyway): the module's own doc comment
  // calls out that a hard-killed PID can be recycled by the OS for an
  // unrelated process, which would read back as "still alive" indefinitely.
  // Once a definitive record exists, the watcher must trust it rather than
  // stall on that recycled PID's liveness.
  it.each([
    { exitCode: 0, expectedStatus: 'clean', expectedCode: 0 },
    { exitCode: 1, expectedStatus: 'crashed', expectedCode: 2 },
  ])(
    'treats a matching record as authoritative even while liveness still reads alive (exitCode $exitCode)',
    ({ exitCode, expectedStatus, expectedCode }) => {
      const verdict = classifyPreviewExit({
        record: { pid: 100, exitCode },
        watchedPid: 100,
        processAlive: true,
        stopRequested: false,
      });
      expect(verdict).toEqual({ status: expectedStatus, code: expectedCode });
    },
  );
});

describe('writeExitRecord / readExitRecord / clearExitRecord (filesystem round trip)', () => {
  // A fresh mkdtemp'd worktree directory and a unique port per test: the
  // record path is a hash of (normalized worktree dir, port), so distinct
  // directories and ports guarantee distinct record files even when tests
  // run with repeat-each or across parallel worker processes.
  let nextPort = 45000;
  let temporaryWorktreeDirectory: string;
  let port: number;

  beforeEach(() => {
    temporaryWorktreeDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kangentic-preview-record-test-'),
    );
    port = nextPort;
    nextPort += 1;
  });

  afterEach(() => {
    clearExitRecord(temporaryWorktreeDirectory, port);
    fs.rmSync(temporaryWorktreeDirectory, { recursive: true, force: true });
  });

  it('round trips a written record back through readExitRecord', () => {
    writeExitRecord(temporaryWorktreeDirectory, port, { pid: 4242, exitCode: 0 });
    const record = readExitRecord(temporaryWorktreeDirectory, port);
    expect(record).toEqual({ pid: 4242, exitCode: 0 });
  });

  it('returns null when no record has ever been written for this worktree/port', () => {
    const record = readExitRecord(temporaryWorktreeDirectory, port);
    expect(record).toBeNull();
  });

  it('returns null on malformed/truncated JSON', () => {
    const recordPath = exitRecordPath(temporaryWorktreeDirectory, port);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, '{ "pid": 100, "exitCode": ');
    const record = readExitRecord(temporaryWorktreeDirectory, port);
    expect(record).toBeNull();
  });

  // The guard is a conjunction (typeof pid === 'number' && typeof exitCode
  // === 'number'). A single wrong-typed field pins only half of it - a
  // revert of just the exitCode half of the conjunction would stay green
  // against a pid-only case. Cover both halves independently.
  it.each([
    { pid: '100', exitCode: 0 },
    { pid: 100, exitCode: '0' },
  ])('returns null when fields are wrong-typed: %j', (malformedFields) => {
    const recordPath = exitRecordPath(temporaryWorktreeDirectory, port);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(malformedFields));
    const record = readExitRecord(temporaryWorktreeDirectory, port);
    expect(record).toBeNull();
  });

  it('clearExitRecord removes the file, and a second clear on an already-gone record does not throw', () => {
    writeExitRecord(temporaryWorktreeDirectory, port, { pid: 4242, exitCode: 0 });
    clearExitRecord(temporaryWorktreeDirectory, port);
    expect(readExitRecord(temporaryWorktreeDirectory, port)).toBeNull();
    expect(() => clearExitRecord(temporaryWorktreeDirectory, port)).not.toThrow();
  });
});

describe('scripts/dev.js cleanup(): writeExitRecord runs before the ephemeral .kangentic/ removal', () => {
  // Ephemeral mode's cleanup() deletes the worktree's entire .kangentic/
  // directory, including the PID file the --wait watcher polls for. If
  // writeExitRecord() ran AFTER that removal instead of before it, a crash
  // (or even a clean exit) could hit the removal, delete the PID file, and
  // let the watcher observe "PID file gone, no record on disk" - which
  // classifyPreviewExit reads as 'vanished' rather than the record-backed
  // 'clean'/'crashed' verdict. The inline comment at the top of cleanup()
  // names this by design; this test makes the ordering unmergeable instead
  // of just documented.
  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  }

  function extractFunctionBody(source: string, functionName: string): string {
    const declarationPattern = new RegExp(`function\\s+${functionName}\\s*\\(`, 'g');
    const declarationMatches = [...source.matchAll(declarationPattern)];
    expect(
      declarationMatches.length,
      `Expected exactly one 'function ${functionName}(' declaration in the source so the `
        + `extraction target is unambiguous; found ${declarationMatches.length}.`,
    ).toBe(1);
    const declarationIndex = declarationMatches[0].index;
    const openBraceIndex = source.indexOf('{', declarationIndex);
    expect(openBraceIndex, `No opening brace found after 'function ${functionName}(' declaration.`).toBeGreaterThan(-1);
    let braceDepth = 0;
    for (let sourceIndex = openBraceIndex; sourceIndex < source.length; sourceIndex++) {
      const character = source[sourceIndex];
      if (character === '{') braceDepth += 1;
      else if (character === '}') {
        braceDepth -= 1;
        if (braceDepth === 0) {
          return source.slice(openBraceIndex, sourceIndex + 1);
        }
      }
    }
    throw new Error(`Unbalanced braces while extracting function '${functionName}' body.`);
  }

  it('writeExitRecord( precedes the ephemeral block\'s .kangentic-removing rmSync(', () => {
    const devJsSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/dev.js'), 'utf-8');
    const cleanupBodyRaw = extractFunctionBody(devJsSource, 'cleanup');
    // Strip comment-only lines before locating anchors: cleanup()'s own
    // comments reference '.kangentic' and 'ephemeral' in prose, so indexOf
    // against the raw body could match a comment instead of the code it
    // describes and silently pass regardless of the real statement order.
    const cleanupBodyCode = cleanupBodyRaw
      .split('\n')
      .filter((line) => !isCommentLine(line))
      .join('\n');

    const writeExitRecordIndex = cleanupBodyCode.indexOf('writeExitRecord(');
    const ephemeralBlockIndex = cleanupBodyCode.indexOf('if (ephemeral)');
    expect(writeExitRecordIndex, 'cleanup() must call writeExitRecord(...).').toBeGreaterThan(-1);
    expect(ephemeralBlockIndex, "cleanup() must have an 'if (ephemeral)' block.").toBeGreaterThan(-1);

    const ephemeralRemovalIndex = cleanupBodyCode.indexOf('rmSync(dir', ephemeralBlockIndex);
    expect(
      ephemeralRemovalIndex,
      "Expected the ephemeral block to remove '.kangentic'/'.vite' via fs.rmSync(dir, ...).",
    ).toBeGreaterThan(-1);

    expect(
      writeExitRecordIndex,
      'writeExitRecord(...) must run BEFORE the ephemeral .kangentic/ removal in cleanup(): '
        + 'ephemeral mode deletes the worktree\'s entire .kangentic/ directory (including the PID '
        + 'file) on exit, so a --wait watcher polling for "the PID file is gone" has no way to '
        + 'distinguish a clean exit from a crash unless the { pid, exitCode } record already '
        + 'exists on disk (under os.tmpdir(), outside .kangentic/) by the time that directory '
        + 'disappears. If this ordering is reversed, a crash can delete the record\'s only source '
        + 'before it is ever written, and the watcher misclassifies every ephemeral crash as '
        + "'vanished' instead of 'crashed'. See scripts/preview-exit-record.js.",
    ).toBeLessThan(ephemeralRemovalIndex);
  });
});
