/**
 * Unit coverage for the terminal Ctrl+V paste path's main-process helpers
 * (`src/main/ipc/helpers/clipboard-image.ts`).
 *
 * `NativeImage` is faked rather than mocked wholesale: `capClipboardImage` only
 * touches getSize / resize / isEmpty, so a small stand-in covers the real surface
 * without needing Electron.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeImage } from 'electron';
import { capClipboardImage, pruneClipboardTempDir } from '../../src/main/ipc/helpers/clipboard-image';
import { IMAGE_LONG_EDGE_CAP } from '../../src/shared/image-fidelity';

// ---------------------------------------------------------------------------
// capClipboardImage
// ---------------------------------------------------------------------------

class FakeImage {
  resizeCalls: { width?: number; height?: number; quality?: string }[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly resizeEmpty = false,
  ) {}

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  isEmpty(): boolean { return false; }

  resize(options: { width?: number; height?: number; quality?: string }): NativeImage {
    this.resizeCalls.push(options);
    if (this.resizeEmpty) return { isEmpty: () => true } as unknown as NativeImage;
    const resized = new FakeImage(options.width ?? this.width, options.height ?? this.height);
    resized.resizeCalls = this.resizeCalls;
    return resized as unknown as NativeImage;
  }
}

function cap(image: FakeImage): FakeImage {
  return capClipboardImage(image as unknown as NativeImage) as unknown as FakeImage;
}

describe('capClipboardImage', () => {
  it('caps an oversized grab at the long-edge cap', () => {
    const image = new FakeImage(3840, 2160);

    const result = cap(image);

    expect(image.resizeCalls).toEqual([{ width: IMAGE_LONG_EDGE_CAP, height: 1125, quality: 'best' }]);
    expect(result.getSize()).toEqual({ width: IMAGE_LONG_EDGE_CAP, height: 1125 });
  });

  it('caps by the long edge on a portrait grab', () => {
    const image = new FakeImage(1500, 4000);

    cap(image);

    expect(image.resizeCalls).toEqual([{ width: 750, height: IMAGE_LONG_EDGE_CAP, quality: 'best' }]);
  });

  it('returns an already-small image untouched, without re-encoding it', () => {
    const image = new FakeImage(1200, 800);

    const result = cap(image);

    expect(image.resizeCalls).toEqual([]);
    expect(result).toBe(image);
  });

  it('falls back to the original when resize returns empty', () => {
    // Never hand an empty image to toPNG(): a paste that writes a zero-byte file
    // is worse than a paste that costs a few extra bytes.
    const image = new FakeImage(3840, 2160, true);

    const result = cap(image);

    expect(result.isEmpty()).toBe(false);
    expect(result.getSize()).toEqual({ width: 3840, height: 2160 });
  });
});

// ---------------------------------------------------------------------------
// pruneClipboardTempDir
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let tempDir: string;

/** Write a file and stamp its mtime to `ageMs` before NOW. */
function writeAged(name: string, ageMs: number): void {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, 'png-bytes');
  const seconds = (NOW - ageMs) / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

function remaining(): string[] {
  return fs.readdirSync(tempDir).sort();
}

beforeEach(() => {
  // Under os.tmpdir(), never a hardcoded absolute root: the latter is writable on
  // a developer's Windows drive and EACCES on the Linux CI runner.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prune-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('pruneClipboardTempDir', () => {
  it('keeps recent pastes', () => {
    writeAged('pasted-image-1.png', 1 * HOUR_MS);
    writeAged('pasted-image-2.png', 5 * HOUR_MS);

    pruneClipboardTempDir(tempDir, { now: NOW });

    expect(remaining()).toEqual(['pasted-image-1.png', 'pasted-image-2.png']);
  });

  it('deletes pastes older than the age limit', () => {
    writeAged('pasted-image-fresh.png', 1 * HOUR_MS);
    writeAged('pasted-image-stale.png', 30 * HOUR_MS);

    pruneClipboardTempDir(tempDir, { now: NOW });

    expect(remaining()).toEqual(['pasted-image-fresh.png']);
  });

  it('enforces the count cap by dropping the oldest first', () => {
    for (let index = 0; index < 6; index++) {
      writeAged(`pasted-image-${index}.png`, index * HOUR_MS);
    }

    pruneClipboardTempDir(tempDir, { now: NOW, maxFiles: 3 });

    expect(remaining()).toEqual(['pasted-image-0.png', 'pasted-image-1.png', 'pasted-image-2.png']);
  });

  it('never touches a file it did not write', () => {
    // The temp directory is shared ground. Deleting by age alone would reach into
    // whatever else happens to be sitting there.
    writeAged('important-user-file.png', 100 * HOUR_MS);
    writeAged('screenshot.png', 100 * HOUR_MS);
    writeAged('pasted-image-old.png', 100 * HOUR_MS);

    pruneClipboardTempDir(tempDir, { now: NOW });

    expect(remaining()).toEqual(['important-user-file.png', 'screenshot.png']);
  });

  it('leaves directories alone', () => {
    fs.mkdirSync(path.join(tempDir, 'pasted-image-dir'));
    writeAged('pasted-image-old.png', 100 * HOUR_MS);

    pruneClipboardTempDir(tempDir, { now: NOW });

    expect(remaining()).toEqual(['pasted-image-dir']);
  });

  it('does not throw when the directory does not exist', () => {
    expect(() => pruneClipboardTempDir(path.join(tempDir, 'nope'), { now: NOW })).not.toThrow();
  });

  it('applies the age limit and the count cap together', () => {
    writeAged('pasted-image-a.png', 1 * HOUR_MS);
    writeAged('pasted-image-b.png', 2 * HOUR_MS);
    writeAged('pasted-image-c.png', 3 * HOUR_MS);
    writeAged('pasted-image-d.png', 100 * HOUR_MS);

    pruneClipboardTempDir(tempDir, { now: NOW, maxFiles: 2 });

    expect(remaining()).toEqual(['pasted-image-a.png', 'pasted-image-b.png']);
  });
});

// ---------------------------------------------------------------------------
// pruneClipboardTempDir - best-effort swallow around a single locked file
//
// This runs on the user-visible paste path, so a file held open by another
// process (Windows EPERM/EBUSY on fs.statSync or fs.rmSync) must never turn
// into a thrown error, and must never stop the OTHER stale files from being
// cleaned up. Real files on disk are never locked in this test environment,
// so the lock is simulated by spying on fs.statSync / fs.rmSync and throwing
// for one specific file only, passing every other call through to the real
// implementation.
// ---------------------------------------------------------------------------

describe('pruneClipboardTempDir - best-effort swallow of a locked file', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips a file whose statSync throws (EPERM/EBUSY) without aborting the scan of the rest', () => {
    writeAged('pasted-image-a.png', 30 * HOUR_MS);
    writeAged('pasted-image-locked.png', 30 * HOUR_MS);
    writeAged('pasted-image-c.png', 30 * HOUR_MS);

    const realStatSync = fs.statSync;
    const statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const [target] = args;
      if (String(target).endsWith('pasted-image-locked.png')) {
        throw new Error('EBUSY: resource busy or locked, stat');
      }
      return realStatSync(...args);
    });

    expect(() => pruneClipboardTempDir(tempDir, { now: NOW })).not.toThrow();

    // Proves the spy actually intercepted the locked file - without this, the
    // assertions below would pass vacuously even if statSync was never called
    // for it at all.
    expect(
      statSyncSpy.mock.calls.some((call) => String(call[0]).endsWith('pasted-image-locked.png')),
    ).toBe(true);

    // The locked file's stat threw, so its entry was skipped entirely and it
    // is never considered for deletion. The other two files are equally
    // stale (30h > the 24h default max age) and must still be deleted: one
    // locked file failing to stat must not abort the scan of the rest.
    expect(remaining()).toEqual(['pasted-image-locked.png']);
  });

  it('skips a file whose rmSync throws (EPERM/EBUSY) without aborting deletion of the rest', () => {
    // Deletion iterates newest-first by mtime, so the locked file (30h old,
    // the newest of this stale trio) is processed BEFORE the older two (40h,
    // 50h). If the rmSync catch were ever removed, the thrown error would
    // propagate straight out of pruneClipboardTempDir and the two files later
    // in iteration order would never be reached - this ordering makes that
    // failure mode observable.
    writeAged('pasted-image-locked.png', 30 * HOUR_MS);
    writeAged('pasted-image-mid.png', 40 * HOUR_MS);
    writeAged('pasted-image-old.png', 50 * HOUR_MS);

    const realRmSync = fs.rmSync;
    const rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation((...args: Parameters<typeof fs.rmSync>) => {
      const [target] = args;
      if (String(target).endsWith('pasted-image-locked.png')) {
        throw new Error('EPERM: operation not permitted, unlink');
      }
      return realRmSync(...args);
    });

    expect(() => pruneClipboardTempDir(tempDir, { now: NOW })).not.toThrow();

    // Proves the spy actually intercepted the locked file's delete attempt.
    expect(
      rmSyncSpy.mock.calls.some((call) => String(call[0]).endsWith('pasted-image-locked.png')),
    ).toBe(true);

    // The locked file's delete failed and stays on disk; the two other stale
    // files, later in iteration order, still got removed.
    expect(remaining()).toEqual(['pasted-image-locked.png']);
  });
});
