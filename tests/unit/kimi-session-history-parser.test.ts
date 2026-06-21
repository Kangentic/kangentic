/**
 * Unit tests for KimiSessionHistoryParser.
 *
 * Covers:
 *   - locate() polling: file appears after N failed attempts
 *   - locate() multi-hash-dir fallthrough: first hash has wrong UUID, second has match
 *   - locate() permission-denied resilience: fs.existsSync throws on one hash dir, scan continues
 *   - captureSessionIdFromFilesystem() polling: dir appears mid-poll within mtime window
 *   - captureSessionIdFromFilesystem() mtime filter: stale/in-window/future directories
 *
 * fs is fully mocked so no real ~/.kimi directory is accessed.
 * Timers are faked via vi.useFakeTimers() + vi.runAllTimersAsync() so the
 * 500ms sleep between attempts doesn't add wall-clock time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { kimiWorkDirHash } from '../../src/main/agent/adapters/kimi/work-dir-hash';

// ── Mutable mock state ────────────────────────────────────────────────────────

let mockReaddirSync: (filePath: string) => string[] = () => [];
let mockExistsSync: (filePath: string) => boolean = () => false;
let mockStatSync: (filePath: string) => { mtimeMs: number } = () => ({ mtimeMs: Date.now() });

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      readdirSync: (filePath: string) => mockReaddirSync(filePath),
      existsSync: (filePath: string) => mockExistsSync(filePath),
      statSync: (filePath: string) => mockStatSync(filePath),
    },
  };
});

const { KimiSessionHistoryParser } = await import(
  '../../src/main/agent/adapters/kimi/session-history-parser'
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSIONS_ROOT = path.join(os.homedir(), '.kimi', 'sessions');
const SESSION_UUID = 'aabbccdd-1234-5678-abcd-000011112222';

/**
 * Derive the absolute wire.jsonl path for a given hash directory + UUID.
 */
function wirePathFor(hash: string, uuid: string): string {
  return path.join(SESSIONS_ROOT, hash, uuid, 'wire.jsonl');
}

// ── locate() ─────────────────────────────────────────────────────────────────

describe('KimiSessionHistoryParser.locate()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the wire.jsonl path on the first attempt when the file is already present', async () => {
    mockReaddirSync = () => ['abc123hash'];
    mockExistsSync = () => true;

    const resultPromise = KimiSessionHistoryParser.locate({
      agentSessionId: SESSION_UUID,
      cwd: '/projects/foo',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(wirePathFor('abc123hash', SESSION_UUID));
  });

  it('returns null after exhausting all attempts when the file never appears', async () => {
    mockReaddirSync = () => ['abc123hash'];
    mockExistsSync = () => false;

    const resultPromise = KimiSessionHistoryParser.locate({
      agentSessionId: SESSION_UUID,
      cwd: '/projects/foo',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it('finds the file after N failed attempts (file appears on attempt N)', async () => {
    let callCount = 0;
    const successOnAttempt = 3;

    mockReaddirSync = () => ['abc123hash'];
    mockExistsSync = (_filePath: string) => {
      callCount++;
      // Each locate() attempt calls existsSync once for the single hash dir.
      return callCount >= successOnAttempt;
    };

    const resultPromise = KimiSessionHistoryParser.locate({
      agentSessionId: SESSION_UUID,
      cwd: '/projects/foo',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(wirePathFor('abc123hash', SESSION_UUID));
    // Must have polled at least 3 times.
    expect(callCount).toBeGreaterThanOrEqual(successOnAttempt);
  });

  it('walks past first hash dir when UUID is absent there and finds it in the second', async () => {
    // Two hash dirs: first has a different session UUID, second has the target.
    const firstHash = 'hash0000000000000001';
    const secondHash = 'hash0000000000000002';
    const otherUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    mockReaddirSync = () => [firstHash, secondHash];
    mockExistsSync = (filePath: string) => {
      // Only the second hash dir has the target UUID wire.jsonl.
      return filePath === wirePathFor(secondHash, SESSION_UUID);
    };

    const resultPromise = KimiSessionHistoryParser.locate({
      agentSessionId: SESSION_UUID,
      cwd: '/projects/foo',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(wirePathFor(secondHash, SESSION_UUID));
    // Sanity: the other UUID path is NOT the one returned.
    expect(result).not.toContain(otherUuid);
    expect(result).not.toContain(firstHash);
  });

  it('skips a hash dir where fs.existsSync throws (permission denied) and continues scanning', async () => {
    const deniedHash = 'hashDenied';
    const allowedHash = 'hashAllowed';

    mockReaddirSync = () => [deniedHash, allowedHash];
    mockExistsSync = (filePath: string) => {
      if (filePath.includes(deniedHash)) {
        throw new Error('EACCES: permission denied');
      }
      // The allowed hash dir has the file.
      return filePath === wirePathFor(allowedHash, SESSION_UUID);
    };

    const resultPromise = KimiSessionHistoryParser.locate({
      agentSessionId: SESSION_UUID,
      cwd: '/projects/foo',
    });
    await vi.runAllTimersAsync();

    // Should still find the file in the second (allowed) hash dir.
    const result = await resultPromise;
    expect(result).toBe(wirePathFor(allowedHash, SESSION_UUID));
  });

  it('returns null when readdirSync throws on the sessions root', async () => {
    mockReaddirSync = (_filePath: string) => {
      throw new Error('ENOENT: no such file or directory');
    };

    const resultPromise = KimiSessionHistoryParser.locate({
      agentSessionId: SESSION_UUID,
      cwd: '/projects/foo',
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeNull();
  });
});

// ── captureSessionIdFromFilesystem() ─────────────────────────────────────────

describe('KimiSessionHistoryParser.captureSessionIdFromFilesystem()', () => {
  // The capture is scoped to the spawn's OWN work_dir hash, so the mocked
  // sessions live under md5(resolve(cwd)) - the same digest the real Kimi CLI
  // (and mock-kimi) writes under. A session under any other hash belongs to a
  // different work_dir and must be ignored.
  const CWD = '/projects/foo';
  const WORK_DIR_HASH = kimiWorkDirHash(path.resolve(CWD));
  const FOREIGN_HASH = kimiWorkDirHash(path.resolve('/projects/other'));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the UUID immediately when a matching dir exists within the mtime window', async () => {
    const spawnedAt = new Date(1_000_000_000_000); // arbitrary fixed epoch ms
    const inWindowMtime = spawnedAt.getTime(); // exactly at spawn time - always in window

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return [SESSION_UUID];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: inWindowMtime });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 5,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(SESSION_UUID);
  });

  it('returns null after max attempts when no session dir ever appears', async () => {
    mockReaddirSync = () => [];

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: CWD,
      maxAttempts: 3,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it('finds the session dir after it appears mid-poll (dir absent then present)', async () => {
    const spawnedAt = new Date(2_000_000_000_000);
    const inWindowMtime = spawnedAt.getTime() + 5_000; // 5s after spawn

    let pollCount = 0;

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) {
        pollCount++;
        // Dir only exists starting from poll 3.
        return pollCount >= 3 ? [WORK_DIR_HASH] : [];
      }
      if (filePath.includes(WORK_DIR_HASH)) return [SESSION_UUID];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: inWindowMtime });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 10,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(SESSION_UUID);
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it('excludes dirs with mtime before the floor (spawnedAt - 30s)', async () => {
    const spawnedAt = new Date(3_000_000_000_000);
    const staleMs = spawnedAt.getTime() - 60_000; // 60s before spawn - below floor

    // All hex chars - valid RFC4122 pattern so the UUID passes the regex filter.
    const staleUuid = '51a1e000-0000-0000-0000-000000000000';

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return [staleUuid];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: staleMs });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    // Stale dir is outside the window, so nothing matched.
    expect(result).toBeNull();
  });

  it('excludes dirs with mtime after the ceiling (spawnedAt + 30s)', async () => {
    const spawnedAt = new Date(3_000_000_000_000);
    const futureMs = spawnedAt.getTime() + 60_000; // 60s after spawn - above ceiling

    // All hex chars - valid RFC4122 pattern so the UUID passes the regex filter.
    const futureUuid = 'f00001ee-0000-0000-0000-000000000000';

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return [futureUuid];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: futureMs });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it('includes a dir with mtime exactly inside the +-30s window', async () => {
    const spawnedAt = new Date(4_000_000_000_000);
    const inWindowMtime = spawnedAt.getTime() + 15_000; // 15s after spawn - inside window

    // All hex characters, valid RFC4122 8-4-4-4-12 pattern.
    const targetUuid = 'aa110000-0000-0000-0000-000000000001';

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return [targetUuid];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: inWindowMtime });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(targetUuid);
  });

  it('returns the most recently created session when multiple in-window dirs exist', async () => {
    const spawnedAt = new Date(5_000_000_000_000);

    // All hex characters, valid RFC4122 pattern.
    const olderUuid = '0ade0000-0000-0000-0000-000000000000';
    const newerUuid = 'aebe0000-0000-0000-0000-000000000001';

    const olderMtime = spawnedAt.getTime() + 5_000;
    const newerMtime = spawnedAt.getTime() + 20_000;

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return [olderUuid, newerUuid];
      return [];
    };
    mockStatSync = (filePath: string) => ({
      mtimeMs: filePath.includes(newerUuid) ? newerMtime : olderMtime,
    });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    // Most recently created (highest mtime) is newerUuid.
    expect(result).toBe(newerUuid);
  });

  it('skips non-UUID entries in the session dirs (future-proof)', async () => {
    const spawnedAt = new Date(6_000_000_000_000);
    const inWindowMtime = spawnedAt.getTime();

    // A hash dir containing a UUID entry AND non-UUID metadata files.
    const goodUuid = 'cccccccc-1234-5678-abcd-ffffffffffff';

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return ['metadata.json', goodUuid, '.DS_Store'];
      return [];
    };

    // Spy that records every statSync call so we can assert non-UUID entries
    // are filtered BEFORE statSync is called (cheaper than statting every
    // entry just to throw it away). This produces clearer failure messages
    // than a defensive throw inside the mock.
    const statSyncSpy = vi.fn((_filePath: string) => ({ mtimeMs: inWindowMtime }));
    mockStatSync = statSyncSpy;

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(goodUuid);

    // Positive assertion: the UUID dir was statted.
    const calledPaths = statSyncSpy.mock.calls.map((args) => args[0]);
    expect(calledPaths.some((filePath) => filePath.includes(goodUuid))).toBe(true);

    // Negative assertions: non-UUID entries were filtered out before statSync.
    expect(calledPaths.some((filePath) => filePath.includes('metadata.json'))).toBe(false);
    expect(calledPaths.some((filePath) => filePath.includes('.DS_Store'))).toBe(false);
  });

  // --- work_dir scoping (the stray-session race regression guard) ------------

  it('ignores a newer in-window session under a different work_dir hash', async () => {
    // The exact contamination this fix prevents: a concurrent Kimi spawn (or a
    // -w-less probe) plants a NEWER session under a DIFFERENT work_dir hash.
    // A global newest-across-all-hashes scan would return the foreign UUID and
    // poison --resume. The scoped scan must return only this work_dir's session.
    const spawnedAt = new Date(7_000_000_000_000);

    const ownUuid = '0117c0de-0000-0000-0000-000000000001';
    const foreignUuid = 'f04e1011-0000-0000-0000-000000000002';

    const ownMtime = spawnedAt.getTime() + 2_000;
    const foreignMtime = spawnedAt.getTime() + 20_000; // newer, also in window

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [WORK_DIR_HASH, FOREIGN_HASH];
      if (filePath.includes(WORK_DIR_HASH)) return [ownUuid];
      if (filePath.includes(FOREIGN_HASH)) return [foreignUuid];
      return [];
    };
    mockStatSync = (filePath: string) => ({
      mtimeMs: filePath.includes(foreignUuid) ? foreignMtime : ownMtime,
    });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(ownUuid);
    expect(result).not.toBe(foreignUuid);
  });

  it('returns null when only a different work_dir hash has a fresh session', async () => {
    const spawnedAt = new Date(8_000_000_000_000);
    const foreignUuid = 'f04e1011-0000-0000-0000-000000000003';

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [FOREIGN_HASH];
      if (filePath.includes(FOREIGN_HASH)) return [foreignUuid];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: spawnedAt.getTime() });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it('matches the non-local-kaos <kaos>_<hash> variant directory', async () => {
    const spawnedAt = new Date(9_000_000_000_000);
    const kaosUuid = 'aa05aa05-0000-0000-0000-000000000004';
    const kaosHashDir = `kaos_${WORK_DIR_HASH}`;

    mockReaddirSync = (filePath: string) => {
      if (filePath === SESSIONS_ROOT) return [kaosHashDir];
      if (filePath.includes(kaosHashDir)) return [kaosUuid];
      return [];
    };
    mockStatSync = () => ({ mtimeMs: spawnedAt.getTime() });

    const resultPromise = KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: CWD,
      maxAttempts: 2,
    });
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe(kaosUuid);
  });
});
