/**
 * The Electron pin must carry the fix for Sentry DESKTOP-Z.
 *
 * DESKTOP-Z is a fatal at quit on Windows, in the main process, on a Node platform
 * worker thread. V8's `MemoryPool::ReleasePooledChunksTask` re-posts itself through
 * `NodePlatform::PostDelayedTaskOnWorkerThreadImpl`. When that lands after the
 * platform's `DelayedTaskScheduler` has closed its uv loop at shutdown, `uv_async_send`
 * reaches a closed handle, libuv's `PostQueuedCompletionStatus` fails against the
 * destroyed completion port, and `uv_fatal_error` kills the process on its way out.
 *
 * The fix is upstream: nodejs/node#61999, backported to Electron as
 * electron/electron#52956 ("fix: crash on windows when v8 posts a delayed worker task
 * during shutdown"), which drops late posts once the scheduler has stopped. It shipped
 * in 43.5.0 (#53013) and 44.1.0 (#53201), and every 45 release carries it from main.
 * 42.10.0 has it too (#53014), but 42 reaches end of life on 2026-10-20, so it is not
 * accepted here. No 41.x release has it.
 *
 * No app-side shutdown change reaches this crash, so the pin is the fix, and this test
 * is what keeps a downgrade from quietly bringing it back. The race itself cannot be
 * reproduced in a test: it needs a V8 worker task to land inside the shutdown window.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parseExactVersion(version: string): ParsedVersion | null {
  const match = EXACT_VERSION.exec(version);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * True when this Electron release carries electron/electron#52956. 43.5.0 and 44.1.0
 * are the first releases of their majors with it; 45 and later have it from main.
 */
export function carriesDesktopZFix(version: string): boolean {
  const parsed = parseExactVersion(version);
  if (parsed === null) return false;
  if (parsed.major >= 45) return true;
  if (parsed.major === 44) return parsed.minor >= 1;
  if (parsed.major === 43) return parsed.minor >= 5;
  return false;
}

describe('Electron pin carries the DESKTOP-Z fix (electron/electron#52956)', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { devDependencies?: Record<string, string> };
  const lockfile = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
  ) as { packages: Record<string, { version?: string }> };

  const pinned = manifest.devDependencies?.electron ?? '';
  const locked = lockfile.packages['node_modules/electron']?.version ?? '';

  it('pins electron to an exact version', () => {
    expect(
      parseExactVersion(pinned),
      `devDependencies.electron is "${pinned}". It must be an exact version with no range operator, `
      + 'so the release that ships is the one this test checked.',
    ).not.toBeNull();
  });

  it('the lockfile installs the pinned version', () => {
    expect(locked, 'package-lock.json disagrees with the electron pin in package.json').toBe(pinned);
  });

  it('the pinned version carries the fix', () => {
    expect(
      carriesDesktopZFix(pinned),
      `electron ${pinned} does not carry electron/electron#52956, the fix for Sentry DESKTOP-Z `
      + '(a fatal at quit on Windows when V8 posts a delayed worker task during shutdown). '
      + 'Pin 43.5.0 or later, 44.1.0 or later, or any 45+ release.',
    ).toBe(true);
  });

  it('rejects releases without the fix and accepts releases with it', () => {
    // Drives the predicate over literals, so a slip that makes it accept everything
    // (or nothing) fails here instead of passing the pin check vacuously.
    for (const version of ['41.10.7', '42.10.0', '43.4.9', '44.0.3', '44.1', '^44.1.0', '']) {
      expect(carriesDesktopZFix(version), version).toBe(false);
    }
    for (const version of ['43.5.0', '43.7.7', '44.1.0', '44.5.1', '45.0.0']) {
      expect(carriesDesktopZFix(version), version).toBe(true);
    }
  });
});
