import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * gpu-health.ts - the counting/latch/decay/durable-record contract behind
 * DESKTOP-W and DESKTOP-15.
 *
 * The load-bearing assertions:
 *   - the escalation record is written exactly ONCE per latch (not once per
 *     death after the latch), the same discipline UtilityRestartPolicy uses;
 *   - the decay window forgets an isolated death, so a lone recoverable GPU
 *     crash (DESKTOP-15's shape) never latches;
 *   - Aptabase sees at most two events per run (first + latched), never one
 *     per death, for the same reason restart-policy.ts caps its own count -
 *     an unbounded per-crash tick is what made a handful of looping installs
 *     read as "71 crashes a day";
 *   - a corrupt or missing escalation file reads as nothing pending, and
 *     reading it does not itself clear it (clearing is the caller's job,
 *     done only after a successful report).
 */

const { mockTrackEvent, atomicWriteJsonSpy } = vi.hoisted(() => ({
  mockTrackEvent: vi.fn(),
  atomicWriteJsonSpy: vi.fn(),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: mockTrackEvent }));
// Delegates to the REAL atomicWriteJson by default, so every existing test in
// this file keeps exercising the real write path. Only the writeEscalation
// fallback test below overrides one call with mockImplementationOnce, which
// self-clears after that single call and falls back to the delegation.
vi.mock('../../src/main/config/board-config/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/board-config/atomic-write')>();
  atomicWriteJsonSpy.mockImplementation(actual.atomicWriteJson);
  return { ...actual, atomicWriteJson: atomicWriteJsonSpy };
});

import {
  recordGpuProcessGone,
  readPendingGpuEscalation,
  clearGpuEscalation,
  resetGpuHealthForTests,
} from '../../src/main/diagnostics/gpu-health';

const START_MS = 1_700_000_000_000;

/** A controllable clock, so no test depends on wall time. */
function makeClock(start = START_MS) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let tempDir: string;
let escalationPath: string;

beforeEach(() => {
  resetGpuHealthForTests();
  mockTrackEvent.mockClear();
  // mockClear, not mockReset: mockReset would strip the delegation to the
  // real atomicWriteJson set up above, silently switching every other test
  // in this file onto the fs.writeFileSync fallback without going red.
  atomicWriteJsonSpy.mockClear();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-gpu-health-'));
  escalationPath = path.join(tempDir, 'gpu-health.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('recordGpuProcessGone', () => {
  it('writes no escalation before the cap is reached', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 5, '0.41.0', { now: clock.now });
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 1, '0.41.0', { now: clock.now });

    expect(fs.existsSync(escalationPath)).toBe(false);
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('writes the escalation the moment the default cap (3) is reached, carrying the latching death', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 5, '0.41.0', { now: clock.now });
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 1, '0.41.0', { now: clock.now });
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'abnormal-exit', 2, '0.41.0', { now: clock.now });

    const escalation = readPendingGpuEscalation(escalationPath);
    expect(escalation).toEqual({
      reason: 'abnormal-exit',
      exitCode: 2,
      count: 3,
      firstAt: new Date(START_MS).toISOString(),
      lastAt: new Date(START_MS + 2_000).toISOString(),
      appVersion: '0.41.0',
      featureStatus: {},
    });
  });

  it('keeps updating count, lastAt, and reason/exitCode on every further death after the latch (a chronic looper is distinguishable from a run that latched once and ended)', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 2 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 2, '0.41.0', options);
    const latchedRecord = readPendingGpuEscalation(escalationPath);
    expect(latchedRecord?.count).toBe(2);

    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'killed', 9, '0.41.0', options);

    const updatedRecord = readPendingGpuEscalation(escalationPath);
    expect(updatedRecord).not.toEqual(latchedRecord);
    expect(updatedRecord).toEqual({
      reason: 'killed',
      exitCode: 9,
      count: 3,
      firstAt: latchedRecord?.firstAt,
      lastAt: new Date(START_MS + 2_000).toISOString(),
      appVersion: '0.41.0',
      featureStatus: {},
    });
  });

  it('reads GPU feature status only once a write is actually about to happen, not on every death', () => {
    const clock = makeClock();
    const getFeatureStatus = vi.fn(() => ({ gpu_compositing: 'enabled' }));
    const options = { now: clock.now, maxCrashes: 3, getFeatureStatus };

    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    expect(getFeatureStatus).not.toHaveBeenCalled();

    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    expect(getFeatureStatus).toHaveBeenCalledTimes(1);
    expect(readPendingGpuEscalation(escalationPath)?.featureStatus).toEqual({
      gpu_compositing: 'enabled',
    });
  });

  it('forgets an isolated death once the decay window passes, so a single recoverable crash never latches (DESKTOP-15 shape)', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(300_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(300_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    // Three deaths total, but never fewer than 300s apart, so the count
    // never accumulated past one at any point.
    expect(fs.existsSync(escalationPath)).toBe(false);
  });

  it('latches once three deaths land inside the decay window, even split across resets by an earlier decay', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(300_000); // decays the lone crash above
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    const escalation = readPendingGpuEscalation(escalationPath);
    expect(escalation?.count).toBe(3);
  });

  it('sends at most two Aptabase events per run (first + latched), never one per death', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    // A fourth death after the latch must not tick a third event.
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenNthCalledWith(1, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'first',
    });
    expect(mockTrackEvent).toHaveBeenNthCalledWith(2, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'latched',
    });
  });

  /**
   * The sibling of the test above, across a decay boundary. The existing
   * "sends at most two Aptabase events per run" test never crosses a decay
   * reset, and the existing decay-boundary test ("latches once three deaths
   * land inside the decay window...") never asserts on trackEvent - so
   * nothing pinned that a SECOND escalation incident, later in the same run,
   * does not tick a third and fourth gpu_process_gone event. trackedPhases is
   * the module-level per-run gate that makes this true; decayIfQuiet
   * deliberately does not clear it (see the module's own comment above
   * `trackedPhases`), which is exactly what this test pins.
   *
   * Both incidents are asserted independently (firstAt, count) before the
   * trackEvent count check, so "called exactly twice" is conditional on two
   * REAL escalations having occurred, not on the second group failing to
   * latch at all.
   */
  it('sends exactly two Aptabase events across a run with two decay-separated latch incidents, never a third or fourth', () => {
    const clock = makeClock();
    const options = { now: clock.now, maxCrashes: 3, decayMs: 300_000 };

    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    const firstEscalation = readPendingGpuEscalation(escalationPath);
    expect(firstEscalation?.firstAt).toBe(new Date(START_MS).toISOString());
    expect(firstEscalation?.count).toBe(3);

    // Longer than decayMs, so the in-memory crash count resets before the
    // next death lands - but trackedPhases must survive this reset.
    clock.advance(300_001);
    const secondIncidentStartMs = clock.now();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);
    clock.advance(1_000);
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', options);

    const secondEscalation = readPendingGpuEscalation(escalationPath);
    // A genuinely new incident (a fresh firstAt after the decay reset), not a
    // stale read of the first record.
    expect(secondEscalation?.firstAt).toBe(new Date(secondIncidentStartMs).toISOString());
    expect(secondEscalation?.count).toBe(3);
    expect(secondEscalation?.firstAt).not.toBe(firstEscalation?.firstAt);

    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenNthCalledWith(1, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'first',
    });
    expect(mockTrackEvent).toHaveBeenNthCalledWith(2, 'gpu_process_gone', {
      reason: 'crashed',
      exitCode: 1,
      phase: 'latched',
    });
  });

  it('respects a configured maxCrashes and decayMs instead of always using the defaults', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 });

    expect(readPendingGpuEscalation(escalationPath)?.count).toBe(1);
  });

  it('normalizes a null/undefined exit code to null on the escalation record', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'launch-failed', undefined, '0.41.0', { now: clock.now, maxCrashes: 1 });

    expect(readPendingGpuEscalation(escalationPath)?.exitCode).toBeNull();
  });

  it('creates the target directory if it does not exist yet (a fresh install before configDir is created)', () => {
    const nestedPath = path.join(tempDir, 'not-yet-created', 'gpu-health.json');
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(nestedPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();
    expect(readPendingGpuEscalation(nestedPath)?.count).toBe(1);
  });
});

/**
 * writeEscalation's own doc comment claims "Never throws". Three guarded
 * paths back that claim; this suite exercises the two that matter most for a
 * running app (an unwritable directory, and an atomic-write failure that
 * still has to leave a readable record) plus the "even the fallback fails"
 * give-up case.
 */
describe('writeEscalation failure paths (the "Never throws" contract)', () => {
  it('does not throw and writes nothing when the escalation directory cannot be created (a path component is an existing file, not a directory)', () => {
    // fs.mkdirSync(dirname, { recursive: true }) cannot create a directory
    // inside something that is itself a plain file - the mkdir call throws,
    // and the guarded catch must swallow it before anything is written.
    const blockingFilePath = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(blockingFilePath, 'this is a file, not a directory');
    const blockedEscalationPath = path.join(blockingFilePath, 'nested', 'gpu-health.json');
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(blockedEscalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();
    expect(fs.existsSync(blockedEscalationPath)).toBe(false);
    expect(readPendingGpuEscalation(blockedEscalationPath)).toBeNull();
  });

  it('falls back to a plain writeFileSync and still leaves a readable record when atomicWriteJson throws', () => {
    // Consumed after this one call, so every OTHER test in the file keeps
    // going through the real atomicWriteJson via the delegating mock.
    atomicWriteJsonSpy.mockImplementationOnce(() => {
      throw new Error('rename failed mid-write');
    });
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();

    // Proves the fallback actually engaged, not merely that nothing threw:
    // atomicWriteJson was attempted (and failed) before the record became
    // readable via the plain fs.writeFileSync path.
    expect(atomicWriteJsonSpy).toHaveBeenCalledTimes(1);
    expect(readPendingGpuEscalation(escalationPath)).toEqual({
      reason: 'crashed',
      exitCode: 1,
      count: 1,
      firstAt: new Date(START_MS).toISOString(),
      lastAt: new Date(START_MS).toISOString(),
      appVersion: '0.41.0',
      featureStatus: {},
    });
  });

  it('gives up silently when the writeFileSync fallback also fails (a directory sits where the record file should go)', () => {
    // No mocking needed: a directory at the escalation path makes the real
    // atomicWriteJson fail naturally (its tmp-file write succeeds, but
    // renaming a file onto an existing directory throws), and then the plain
    // fs.writeFileSync fallback fails the same way writing directly to it -
    // exercising both guarded catches with real fs behavior.
    fs.mkdirSync(escalationPath);
    const clock = makeClock();

    expect(() =>
      recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 }),
    ).not.toThrow();
  });
});

describe('readPendingGpuEscalation', () => {
  it('returns null when no file exists', () => {
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('treats a corrupt file as nothing pending, without throwing', () => {
    fs.writeFileSync(escalationPath, '{ not json');
    expect(() => readPendingGpuEscalation(escalationPath)).not.toThrow();
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('treats a wrong-shaped record (a string where count belongs) as nothing pending', () => {
    fs.writeFileSync(
      escalationPath,
      JSON.stringify({ reason: 'crashed', exitCode: 1, count: 'three', firstAt: 'x', lastAt: 'y', appVersion: '0.41.0' }),
    );
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('tolerates a missing or wrong-shaped featureStatus as {} rather than invalidating the whole record', () => {
    fs.writeFileSync(
      escalationPath,
      JSON.stringify({ reason: 'crashed', exitCode: 1, count: 3, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0' }),
    );
    expect(readPendingGpuEscalation(escalationPath)?.featureStatus).toEqual({});

    fs.writeFileSync(
      escalationPath,
      JSON.stringify({
        reason: 'crashed', exitCode: 1, count: 3, firstAt: 'x', lastAt: 'y', appVersion: '0.41.0',
        featureStatus: ['not', 'an', 'object'],
      }),
    );
    expect(readPendingGpuEscalation(escalationPath)?.featureStatus).toEqual({});
  });

  it('does not clear the file merely by reading it', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 });

    readPendingGpuEscalation(escalationPath);
    readPendingGpuEscalation(escalationPath);

    expect(fs.existsSync(escalationPath)).toBe(true);
  });
});

describe('clearGpuEscalation', () => {
  it('removes an existing escalation file', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 1 });
    expect(fs.existsSync(escalationPath)).toBe(true);

    clearGpuEscalation(escalationPath);

    expect(fs.existsSync(escalationPath)).toBe(false);
    expect(readPendingGpuEscalation(escalationPath)).toBeNull();
  });

  it('does not throw when there is nothing to clear', () => {
    expect(() => clearGpuEscalation(escalationPath)).not.toThrow();
  });
});

describe('a fresh run after resetGpuHealthForTests (the real cross-launch shape)', () => {
  it('starts a clean count even with an unread escalation still on disk from a prior run', () => {
    const clock = makeClock();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 2 });
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 2 });
    expect(readPendingGpuEscalation(escalationPath)?.count).toBe(2);

    // Simulate the boot report reading and clearing it, then a fresh
    // process (module state reset) hitting a single, isolated death.
    clearGpuEscalation(escalationPath);
    resetGpuHealthForTests();
    recordGpuProcessGone(escalationPath, 'crashed', 1, '0.41.0', { now: clock.now, maxCrashes: 2 });

    expect(fs.existsSync(escalationPath)).toBe(false);
  });
});
