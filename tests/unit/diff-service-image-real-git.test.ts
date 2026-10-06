/**
 * DiffService.getImageContent's fingerprints against a real repository
 * (src/main/git/diff-service.ts). The mocked suite in diff-service.test.ts pins
 * the logic; this file pins what it depends on and the mocks only assume:
 * that `git rev-parse --verify` resolves both an index spec (`:path`) and a
 * commit spec (`<oid>:path`) to the blob id, that a real `stat` feeds a stable
 * disk fingerprint, and that an `unchanged` answer survives the structured
 * clone Electron's IPC applies. If any of those broke, every image side would
 * read as unreadable or be resent on every refresh while the mocked tests
 * stayed green.
 *
 * Runs the real `git` binary against a temp directory, mirroring
 * worktree-base-branch.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DiffService, RECENT_WRITE_WINDOW_MS } from '../../src/main/git/diff-service';
import type { GitFileImageInput, GitImageSide } from '../../src/shared/types';

/** Starts like a PNG and holds a NUL byte, so git treats it as binary and never converts line endings. */
function imageBytes(marker: number, length = 32): Buffer {
  const bytes = Buffer.alloc(length, marker);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).copy(bytes);
  return bytes;
}

const BEFORE = imageBytes(0x41);
const AFTER = imageBytes(0x42);
const REWRITTEN = imageBytes(0x43, 48);
const IMAGE_PATH = 'img/a.png';
/** Far outside RECENT_WRITE_WINDOW_MS, so a matching disk fingerprint is trusted. */
const SETTLED_AGE_MS = 10 * 60 * 1000;

let repository: string;

function run(args: string[]): string {
  return execFileSync('git', args, { cwd: repository, windowsHide: true }).toString().trim();
}

function writeImage(bytes: Buffer, mtimeMs: number): void {
  const absolutePath = path.join(repository, IMAGE_PATH);
  fs.writeFileSync(absolutePath, bytes);
  const mtime = new Date(mtimeMs);
  fs.utimesSync(absolutePath, mtime, mtime);
}

function fingerprintOf(side: GitImageSide | null): string | undefined {
  return side === null || side.kind === 'unreadable' ? undefined : side.fingerprint;
}

function bytesOf(side: GitImageSide | null): Buffer {
  if (side === null || side.kind !== 'bytes') throw new Error(`expected a bytes side, got ${side === null ? 'null' : side.kind}`);
  return Buffer.from(side.bytes);
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-image-fingerprint-'));
  // `git init -b` needs git >= 2.28 (2020), the floor worktree-base-branch.test.ts already sets.
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'dev@example.com']);
  run(['config', 'user.name', 'Dev']);
  run(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(repository, 'img'));
  writeImage(BEFORE, Date.now() - SETTLED_AGE_MS);
  run(['add', '-A']);
  run(['commit', '-m', 'add the image']);
});

afterEach(async () => {
  vi.useRealTimers();
  // Retry rather than a single rmSync: on Windows a handle the just-exited git
  // process held a beat longer surfaces as EBUSY/EPERM, which `force` does not cover.
  await fs.promises.rm(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('getImageContent fingerprints against a real repository', () => {
  function workingInput(knownFingerprints?: GitFileImageInput['knownFingerprints']): GitFileImageInput {
    return { projectPath: repository, baseBranch: 'main', filePath: IMAGE_PATH, status: 'M', scope: 'working', knownFingerprints };
  }

  it('working scope: reads the index blob and the disk file, then answers unchanged for both', async () => {
    writeImage(AFTER, Date.now() - SETTLED_AGE_MS);
    const service = new DiffService(repository);

    const first = await service.getImageContent(workingInput());

    expect(bytesOf(first.original).equals(BEFORE)).toBe(true);
    expect(bytesOf(first.modified).equals(AFTER)).toBe(true);
    const indexBlobId = run(['rev-parse', `:${IMAGE_PATH}`]);
    expect(fingerprintOf(first.original)).toBe(`blob:${indexBlobId}`);
    expect(fingerprintOf(first.modified)).toMatch(/^file:32:\d+(\.\d+)?$/);

    const second = await service.getImageContent(workingInput({
      original: fingerprintOf(first.original),
      modified: fingerprintOf(first.modified),
    }));

    expect(second.original).toEqual({ kind: 'unchanged', fingerprint: fingerprintOf(first.original) });
    expect(second.modified).toEqual({ kind: 'unchanged', fingerprint: fingerprintOf(first.modified) });
    // What Electron's IPC does to the answer on its way to the renderer.
    expect(structuredClone(second)).toEqual(second);
  });

  it('a rewritten disk file reads again while the unchanged index blob does not', async () => {
    writeImage(AFTER, Date.now() - SETTLED_AGE_MS);
    const service = new DiffService(repository);
    const first = await service.getImageContent(workingInput());

    writeImage(REWRITTEN, Date.now() - SETTLED_AGE_MS + 1000);
    const second = await service.getImageContent(workingInput({
      original: fingerprintOf(first.original),
      modified: fingerprintOf(first.modified),
    }));

    expect(second.original?.kind).toBe('unchanged');
    expect(bytesOf(second.modified).equals(REWRITTEN)).toBe(true);
  });

  it('a disk file written inside the recent-write window is reread even with a matching fingerprint', async () => {
    const writtenAtMs = Date.now() - SETTLED_AGE_MS;
    writeImage(AFTER, writtenAtMs);
    const service = new DiffService(repository);
    const first = await service.getImageContent(workingInput());
    const actualMtimeMs = fs.statSync(path.join(repository, IMAGE_PATH)).mtimeMs;

    // Only Date is faked, so git and the filesystem still run. The clock now
    // reads just after the file's real modified time, inside the window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(actualMtimeMs + Math.floor(RECENT_WRITE_WINDOW_MS / 4));
    const second = await service.getImageContent(workingInput({ modified: fingerprintOf(first.modified) }));

    expect(bytesOf(second.modified).equals(AFTER)).toBe(true);
    expect(fingerprintOf(second.modified)).toBe(fingerprintOf(first.modified));
  });

  it('commit selection: both sides are blobs, and their ids answer unchanged', async () => {
    // A modified time distinct from the committed file's: same size and same
    // time is exactly what git's own index treats as unchanged, so `add` would
    // skip the new bytes and the commit would be empty.
    writeImage(AFTER, Date.now() - SETTLED_AGE_MS + 5000);
    run(['add', '-A']);
    run(['commit', '-m', 'change the image']);
    const commitOid = run(['rev-parse', 'HEAD']);
    const service = new DiffService(repository);
    const input: GitFileImageInput = { projectPath: repository, baseBranch: 'main', filePath: IMAGE_PATH, status: 'M', commitOid };

    const first = await service.getImageContent(input);

    expect(bytesOf(first.original).equals(BEFORE)).toBe(true);
    expect(bytesOf(first.modified).equals(AFTER)).toBe(true);
    expect(fingerprintOf(first.original)).toBe(`blob:${run(['rev-parse', `${commitOid}^:${IMAGE_PATH}`])}`);
    expect(fingerprintOf(first.modified)).toBe(`blob:${run(['rev-parse', `${commitOid}:${IMAGE_PATH}`])}`);

    const second = await service.getImageContent({
      ...input,
      knownFingerprints: { original: fingerprintOf(first.original), modified: fingerprintOf(first.modified) },
    });

    expect(second.original?.kind).toBe('unchanged');
    expect(second.modified?.kind).toBe('unchanged');
  });
});
