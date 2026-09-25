import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initRunUptimeTracking,
  checkpointRunUptime,
  recordRunExit,
  previousRunLaunchProps,
  peekPreviousRun,
  previousRunLastAliveAt,
  bucketUptimeSeconds,
  resetRunUptimeForTests,
  RUN_UPTIME_CHECKPOINT_INTERVAL_MS,
} from '../../src/main/analytics/run-uptime';

/**
 * run-uptime.ts replaces the app_close event, which was fired from the quit
 * path and never landed (nothing sent from there can). Every write here is
 * synchronous by design, so these tests need no poller: the file holds the
 * final state the moment a call returns.
 */

const START_MS = 1_700_000_000_000;

let tempDir: string;
let runPath: string;

interface RunRecordOnDisk {
  uptimeSeconds?: unknown;
  exit?: unknown;
  at?: unknown;
}

function readRecord(): RunRecordOnDisk {
  return JSON.parse(fs.readFileSync(runPath, 'utf-8')) as RunRecordOnDisk;
}

/** A "next launch": fresh module state, same file. */
function relaunch(startedAtMs = START_MS + 86_400_000): void {
  resetRunUptimeForTests();
  initRunUptimeTracking(runPath, startedAtMs);
}

beforeEach(() => {
  resetRunUptimeForTests();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-run-uptime-'));
  runPath = path.join(tempDir, 'analytics-run.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('initRunUptimeTracking', () => {
  it('reports no previous run on a first launch and starts this run at zero, stamped with the launch instant', () => {
    initRunUptimeTracking(runPath, START_MS);

    expect(previousRunLaunchProps()).toEqual({});
    expect(readRecord()).toEqual({ uptimeSeconds: 0, exit: null, at: new Date(START_MS).toISOString() });
  });

  it('treats a corrupt record as no previous run, without throwing, and still starts this run stamped with the launch instant', () => {
    fs.writeFileSync(runPath, '{ not json');

    expect(() => initRunUptimeTracking(runPath, START_MS)).not.toThrow();
    expect(previousRunLaunchProps()).toEqual({});
    expect(readRecord()).toEqual({ uptimeSeconds: 0, exit: null, at: new Date(START_MS).toISOString() });
  });

  it('treats a wrong-shaped record (a string where the seconds belong) as no previous run', () => {
    fs.writeFileSync(runPath, JSON.stringify({ uptimeSeconds: '3600', exit: 'clean' }));

    initRunUptimeTracking(runPath, START_MS);

    expect(previousRunLaunchProps()).toEqual({});
  });

  it('does not throw when the record cannot be written', () => {
    const unwritablePath = path.join(tempDir, 'missing-dir', 'nested', 'analytics-run.json');

    expect(() => initRunUptimeTracking(unwritablePath, START_MS)).not.toThrow();
    expect(() => checkpointRunUptime(START_MS + 60_000)).not.toThrow();
    expect(() => recordRunExit('clean', START_MS + 120_000)).not.toThrow();
    expect(previousRunLaunchProps()).toEqual({});
  });
});

describe('checkpointRunUptime', () => {
  it('writes the elapsed seconds, rounded, with no exit, and stamps at with the exact checkpoint instant', () => {
    initRunUptimeTracking(runPath, START_MS);

    checkpointRunUptime(START_MS + 90_400);

    // uptimeSeconds rounds to the nearest second (90); at is the exact wall
    // clock instant of the checkpoint and keeps the sub-second 400ms. That
    // asymmetry is intentional: at is a moment, uptimeSeconds is a duration.
    expect(readRecord()).toEqual({
      uptimeSeconds: 90,
      exit: null,
      at: new Date(START_MS + 90_400).toISOString(),
    });
  });

  it('is a no-op before init', () => {
    expect(() => checkpointRunUptime(START_MS)).not.toThrow();
    expect(fs.existsSync(runPath)).toBe(false);
  });

  it('is a no-op after an exit has been recorded, so a late tick cannot reopen the run', () => {
    // The race class this guards: the checkpoint interval and the quit path
    // both write the same file. Every write is synchronous, so ordering is by
    // call order alone; this pins that a tick AFTER the exit write changes
    // nothing, whatever the timer does during teardown.
    initRunUptimeTracking(runPath, START_MS);
    recordRunExit('clean', START_MS + 10_000);

    checkpointRunUptime(START_MS + 70_000);

    // The late checkpoint must not overwrite `at` either: it stays the exit
    // instant (10_000), never the checkpoint's later instant (70_000).
    expect(readRecord()).toEqual({
      uptimeSeconds: 10,
      exit: 'clean',
      at: new Date(START_MS + 10_000).toISOString(),
    });
  });
});

describe('the next launch reads the previous run', () => {
  it('reports a clean exit with the exact seconds and its bucket', () => {
    initRunUptimeTracking(runPath, START_MS);
    checkpointRunUptime(START_MS + 60_000);
    recordRunExit('clean', START_MS + 3_600_000);

    relaunch();

    expect(previousRunLaunchProps()).toEqual({
      lastRunUptimeSeconds: 3600,
      lastRunUptime: '30m-2h',
      lastRunExit: 'clean',
    });
  });

  it('reports an abrupt exit (a crash, a kill, a power loss) with the last checkpointed seconds', () => {
    initRunUptimeTracking(runPath, START_MS);
    checkpointRunUptime(START_MS + 60_000);
    checkpointRunUptime(START_MS + 120_000);
    // No recordRunExit: the process died between checkpoints.

    relaunch();

    expect(previousRunLaunchProps()).toEqual({
      lastRunUptimeSeconds: 120,
      lastRunUptime: '1-5m',
      lastRunExit: 'abrupt',
    });
  });

  it('reports failsafe when the hard failsafe fired after the clean exit was recorded', () => {
    // performShutdown records `clean` first; the failsafe timer fires six
    // seconds later only when Electron's teardown hung, and its record must
    // win, because that run did not end cleanly.
    initRunUptimeTracking(runPath, START_MS);
    recordRunExit('clean', START_MS + 100_000);
    recordRunExit('failsafe', START_MS + 106_000);

    relaunch();

    expect(previousRunLaunchProps()).toMatchObject({
      lastRunUptimeSeconds: 106,
      lastRunExit: 'failsafe',
    });
  });

  it('resets the record for the new run, so a run that dies at once reports zero, not the run before', () => {
    initRunUptimeTracking(runPath, START_MS);
    recordRunExit('clean', START_MS + 500_000);

    relaunch();
    // The relaunch died before its first checkpoint.
    relaunch(START_MS + 2 * 86_400_000);

    expect(previousRunLaunchProps()).toEqual({
      lastRunUptimeSeconds: 0,
      lastRunUptime: '<1m',
      lastRunExit: 'abrupt',
    });
  });
});

describe('recordRunExit', () => {
  it('is a no-op before init (a shutdown that races ahead of whenReady)', () => {
    expect(() => recordRunExit('clean', START_MS)).not.toThrow();
    expect(fs.existsSync(runPath)).toBe(false);
  });
});

describe('peekPreviousRun', () => {
  it('returns null when the file does not exist, without throwing', () => {
    expect(() => peekPreviousRun(runPath)).not.toThrow();
    expect(peekPreviousRun(runPath)).toBeNull();
  });

  it('reads the previous run, surfacing at as lastAliveAt, on a round trip', () => {
    initRunUptimeTracking(runPath, START_MS);
    recordRunExit('clean', START_MS + 3_600_000);
    resetRunUptimeForTests();

    expect(peekPreviousRun(runPath)).toEqual({
      uptimeSeconds: 3600,
      exit: 'clean',
      lastAliveAt: new Date(START_MS + 3_600_000).toISOString(),
    });
  });

  it('reads a pre-upgrade record with no at key as lastAliveAt: null, without invalidating the rest of the record', () => {
    // Written by the currently shipped version, before `at` existed: only
    // uptimeSeconds and exit are on disk. A literal fixture, not a call
    // through the writers, since the writers can no longer produce this shape.
    fs.writeFileSync(runPath, JSON.stringify({ uptimeSeconds: 3600, exit: 'clean' }));

    expect(peekPreviousRun(runPath)).toEqual({
      uptimeSeconds: 3600,
      exit: 'clean',
      lastAliveAt: null,
    });
  });

  it('reads a non-string at as lastAliveAt: null rather than passing the wrong type through', () => {
    for (const malformedAt of [12345, null, { nested: true }]) {
      fs.writeFileSync(runPath, JSON.stringify({ uptimeSeconds: 42, exit: 'clean', at: malformedAt }));

      expect(peekPreviousRun(runPath)).toEqual({
        uptimeSeconds: 42,
        exit: 'clean',
        lastAliveAt: null,
      });
    }
  });

  it('does not start this run tracking: the peeked file is unchanged and module state keeps the run recorded elsewhere', () => {
    // A different path establishes a known previousRun in module state
    // first, so the assertions below fail if peekPreviousRun were a thin
    // wrapper over initRunUptimeTracking instead of a side-effect-free read.
    const otherPath = path.join(tempDir, 'other-run.json');
    const otherRunAt = new Date(START_MS).toISOString();
    fs.writeFileSync(otherPath, JSON.stringify({ uptimeSeconds: 111, exit: 'clean', at: otherRunAt }));
    initRunUptimeTracking(otherPath, START_MS + 500_000);
    expect(previousRunLastAliveAt()).toBe(otherRunAt);

    const peekedAt = new Date(START_MS + 999_000).toISOString();
    fs.writeFileSync(runPath, JSON.stringify({ uptimeSeconds: 999, exit: 'failsafe', at: peekedAt }));
    const fileBeforePeek = fs.readFileSync(runPath, 'utf-8');

    const peeked = peekPreviousRun(runPath);

    expect(peeked).toEqual({ uptimeSeconds: 999, exit: 'failsafe', lastAliveAt: peekedAt });
    expect(fs.readFileSync(runPath, 'utf-8')).toBe(fileBeforePeek);
    // Unaffected by the peek: still the run recorded at otherPath, not runPath's.
    expect(previousRunLastAliveAt()).toBe(otherRunAt);
  });
});

describe('previousRunLastAliveAt', () => {
  it('returns null before init', () => {
    expect(previousRunLastAliveAt()).toBeNull();
  });

  it('returns null on a first launch with no previous record, then the previous exit instant on the next launch', () => {
    initRunUptimeTracking(runPath, START_MS);
    expect(previousRunLastAliveAt()).toBeNull();

    recordRunExit('clean', START_MS + 3_600_000);
    relaunch();

    expect(previousRunLastAliveAt()).toBe(new Date(START_MS + 3_600_000).toISOString());
  });
});

describe('bucketUptimeSeconds', () => {
  it('buckets at the documented edges', () => {
    expect(bucketUptimeSeconds(0)).toBe('<1m');
    expect(bucketUptimeSeconds(59)).toBe('<1m');
    expect(bucketUptimeSeconds(60)).toBe('1-5m');
    expect(bucketUptimeSeconds(299)).toBe('1-5m');
    expect(bucketUptimeSeconds(300)).toBe('5-30m');
    expect(bucketUptimeSeconds(1799)).toBe('5-30m');
    expect(bucketUptimeSeconds(1800)).toBe('30m-2h');
    expect(bucketUptimeSeconds(7199)).toBe('30m-2h');
    expect(bucketUptimeSeconds(7200)).toBe('2-8h');
    expect(bucketUptimeSeconds(28_799)).toBe('2-8h');
    expect(bucketUptimeSeconds(28_800)).toBe('8h+');
    expect(bucketUptimeSeconds(500_000)).toBe('8h+');
  });
});

describe('RUN_UPTIME_CHECKPOINT_INTERVAL_MS', () => {
  it('checkpoints once a minute: the report is bucketed at minute granularity, so finer buys nothing', () => {
    expect(RUN_UPTIME_CHECKPOINT_INTERVAL_MS).toBe(60_000);
  });
});
