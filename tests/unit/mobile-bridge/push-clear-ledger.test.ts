/**
 * Unit tests for src/main/mobile-bridge/push/push-clear-ledger.ts
 *
 * The ledger is pure bookkeeping (no timers, no I/O, no clock of its own;
 * every method that needs the time takes `now`), so these tests build it
 * directly and drive it with explicit timestamps. They pin the rules about
 * which clear is owed to whom:
 *
 * - resolve() keeps the newer notifiedAt when a key is already pending, and
 *   never queues a clear for a device that is watching from the app.
 * - removeIfUnchanged / markStandaloneSent / forgetIfUnchanged compare
 *   notifiedAt first, so a send that settles late never touches a newer
 *   record written for the same key while it was in flight.
 * - prune() drops what is older than PUSH_ENVELOPE_MAX_AGE_MS, outstanding by
 *   notifiedAt and pending by queuedAt.
 * - pickForMessage() puts entries no standalone clear has carried first.
 *
 * pending state has no public reader, so it is observed through
 * pickForMessage: its key order exposes queuedAt and whether an entry was
 * stamped as sent, and its entries expose the notifiedAt that was kept.
 *
 * How the PushNotifier drives the ledger is covered in push-notifier.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { PUSH_ENVELOPE_MAX_AGE_MS, type PushClearEntry } from '@kangentic/protocol';
import {
  PushClearLedger,
  type OutstandingNotification,
  type PushClearIdentity,
} from '../../../src/main/mobile-bridge/push/push-clear-ledger';

const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';
const DEVICE_C = 'device-c';
const PROJECT_ID = 'project-1';

function identityFor(taskId: string, overrides: Partial<PushClearIdentity> = {}): PushClearIdentity {
  return { category: 'input-required', projectId: PROJECT_ID, taskId, sessionId: `session-${taskId}`, ...overrides };
}

/** The ledger's per-device key: any string works, the notifier uses `${subject}|${category}`. */
function keyFor(taskId: string): string {
  return `${taskId}|input-required`;
}

function entryFor(taskId: string, notifiedAt: number): PushClearEntry {
  return { ...identityFor(taskId), notifiedAt };
}

function noConnectedDevices(): Set<string> {
  return new Set();
}

function matchesTask(taskId: string): (notification: OutstandingNotification) => boolean {
  return (notification) => notification.identity.taskId === taskId;
}

function dispatch(
  ledger: PushClearLedger,
  deviceId: string,
  taskId: string,
  notifiedAt: number,
  swimlaneId: string | undefined = 'lane-1',
): OutstandingNotification | undefined {
  return ledger.recordDispatched(deviceId, keyFor(taskId), identityFor(taskId), notifiedAt, swimlaneId);
}

/**
 * Dispatches a notification and resolves it at `now`, which queues a clear
 * for the device with queuedAt = now. Resolves by task, so keep one device
 * per task when other outstanding records must stay outstanding.
 */
function queueClear(ledger: PushClearLedger, deviceId: string, taskId: string, notifiedAt: number, now: number): void {
  dispatch(ledger, deviceId, taskId, notifiedAt);
  ledger.resolve(matchesTask(taskId), noConnectedDevices, now);
}

function fitsAtMost(count: number): (entries: PushClearEntry[]) => boolean {
  return (entries) => entries.length <= count;
}

function fitsAnything(): boolean {
  return true;
}

function pickedKeys(ledger: PushClearLedger, deviceId: string): string[] {
  return ledger.pickForMessage(deviceId, fitsAnything).picked.map((pick) => pick.key);
}

function pickedEntries(ledger: PushClearLedger, deviceId: string): PushClearEntry[] {
  return ledger.pickForMessage(deviceId, fitsAnything).picked.map((pick) => pick.entry);
}

describe('PushClearLedger.resolve with a key already pending', () => {
  it('keeps the pending clear when an outstanding record with an older notifiedAt resolves onto it', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-1', 2000, 100);
    dispatch(ledger, DEVICE_A, 'task-1', 1000);

    const devicesWithNewClears = ledger.resolve(matchesTask('task-1'), noConnectedDevices, 200);

    expect(devicesWithNewClears).toEqual([]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([entryFor('task-1', 2000)]);
    // The older record was still consumed: resolving takes it out of outstanding either way.
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1')).toEqual([]);
  });

  it('keeps the pending clear when the outstanding record has the same notifiedAt', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-1', 2000, 100);
    dispatch(ledger, DEVICE_A, 'task-1', 2000);

    const devicesWithNewClears = ledger.resolve(matchesTask('task-1'), noConnectedDevices, 200);

    expect(devicesWithNewClears).toEqual([]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([entryFor('task-1', 2000)]);
  });

  it('replaces the pending clear when the outstanding record has a newer notifiedAt', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-1', 1000, 100);
    dispatch(ledger, DEVICE_A, 'task-1', 2000);

    const devicesWithNewClears = ledger.resolve(matchesTask('task-1'), noConnectedDevices, 200);

    expect(devicesWithNewClears).toEqual([DEVICE_A]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([entryFor('task-1', 2000)]);
  });
});

describe('PushClearLedger.resolve with connected devices', () => {
  it('drops the outstanding record of a connected device, queues nothing for it, and returns only devices that gained a clear', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000);
    dispatch(ledger, DEVICE_B, 'task-1', 1001);
    dispatch(ledger, DEVICE_C, 'task-2', 1002);
    const getConnectedDeviceIds = vi.fn(() => new Set([DEVICE_A]));

    const devicesWithNewClears = ledger.resolve(matchesTask('task-1'), getConnectedDeviceIds, 100);

    expect(devicesWithNewClears).toEqual([DEVICE_B]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([]);
    expect(pickedEntries(ledger, DEVICE_B)).toEqual([entryFor('task-1', 1001)]);
    // Neither matching record is outstanding any more, the connected device's included.
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1')).toEqual([]);
    // The device whose record did not match was left alone.
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-2')).toHaveLength(1);
    expect(pickedEntries(ledger, DEVICE_C)).toEqual([]);

    // A second resolve with nobody connected has nothing left to queue for the device that was.
    expect(ledger.resolve(matchesTask('task-1'), noConnectedDevices, 200)).toEqual([]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([]);
  });

  it('does not ask which devices are connected when no outstanding record matches', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000);
    dispatch(ledger, DEVICE_B, 'task-2', 1001);
    const getConnectedDeviceIds = vi.fn(() => new Set<string>());

    const devicesWithNewClears = ledger.resolve(matchesTask('task-unrelated'), getConnectedDeviceIds, 100);

    expect(devicesWithNewClears).toEqual([]);
    expect(getConnectedDeviceIds).not.toHaveBeenCalled();
  });

  it('asks which devices are connected once, however many devices match', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000);
    dispatch(ledger, DEVICE_B, 'task-1', 1001);
    dispatch(ledger, DEVICE_C, 'task-1', 1002);
    const getConnectedDeviceIds = vi.fn(() => new Set<string>());

    const devicesWithNewClears = ledger.resolve(matchesTask('task-1'), getConnectedDeviceIds, 100);

    expect(devicesWithNewClears).toEqual([DEVICE_A, DEVICE_B, DEVICE_C]);
    expect(getConnectedDeviceIds).toHaveBeenCalledTimes(1);
  });
});

describe('PushClearLedger stale picks', () => {
  it('removeIfUnchanged removes a delivered entry whose notifiedAt is unchanged', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-1', 1000, 100);
    const picked = ledger.pickForMessage(DEVICE_A, fitsAnything).picked;

    ledger.removeIfUnchanged(DEVICE_A, picked);

    expect(pickedEntries(ledger, DEVICE_A)).toEqual([]);
  });

  it('removeIfUnchanged skips a key re-queued with a different notifiedAt since the pick', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-1', 1000, 100);
    const stalePick = ledger.pickForMessage(DEVICE_A, fitsAnything).picked;
    // Strictly newer, so resolve() really replaces the pending entry while the message is in flight.
    queueClear(ledger, DEVICE_A, 'task-1', 2000, 200);

    ledger.removeIfUnchanged(DEVICE_A, stalePick);

    expect(pickedEntries(ledger, DEVICE_A)).toEqual([entryFor('task-1', 2000)]);
  });

  it('markStandaloneSent stamps an entry whose notifiedAt is unchanged, so it sorts after the unsent ones', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-1', 1000, 100);
    queueClear(ledger, DEVICE_A, 'task-2', 1001, 200);
    expect(pickedKeys(ledger, DEVICE_A)).toEqual([keyFor('task-2'), keyFor('task-1')]);
    const newestPick = ledger.pickForMessage(DEVICE_A, fitsAnything).picked.filter((pick) => pick.key === keyFor('task-2'));

    ledger.markStandaloneSent(DEVICE_A, newestPick, 300);

    // task-2 is still the newest queued, but a standalone clear carried it, so task-1 goes first.
    expect(pickedKeys(ledger, DEVICE_A)).toEqual([keyFor('task-1'), keyFor('task-2')]);
  });

  it('markStandaloneSent skips a key re-queued with a different notifiedAt since the pick', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'task-2', 1500, 100);
    queueClear(ledger, DEVICE_A, 'task-1', 1000, 150);
    const stalePick = ledger.pickForMessage(DEVICE_A, fitsAnything).picked.filter((pick) => pick.key === keyFor('task-1'));
    // Re-queued with a strictly newer notifiedAt and the newest queuedAt among the unsent entries.
    queueClear(ledger, DEVICE_A, 'task-1', 2000, 200);

    ledger.markStandaloneSent(DEVICE_A, stalePick, 300);

    // The new entry is still unsent, so it keeps first place. A stamped one would sort behind task-2.
    expect(pickedKeys(ledger, DEVICE_A)).toEqual([keyFor('task-1'), keyFor('task-2')]);
  });

  it('removeIfUnchanged and markStandaloneSent ignore a device with nothing pending', () => {
    const ledger = new PushClearLedger();
    const orphanPick = [{ key: keyFor('task-1'), entry: entryFor('task-1', 1000) }];

    expect(() => ledger.removeIfUnchanged(DEVICE_A, orphanPick)).not.toThrow();
    expect(() => ledger.markStandaloneSent(DEVICE_A, orphanPick, 100)).not.toThrow();
  });
});

describe('PushClearLedger.prune', () => {
  const NOW = 10 * PUSH_ENVELOPE_MAX_AGE_MS;
  const CUTOFF = NOW - PUSH_ENVELOPE_MAX_AGE_MS;

  it('drops outstanding records by notifiedAt, keeping one exactly at the cutoff', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-at-cutoff', CUTOFF);
    dispatch(ledger, DEVICE_A, 'task-before-cutoff', CUTOFF - 1);
    dispatch(ledger, DEVICE_A, 'task-fresh', NOW);

    ledger.prune(NOW);

    expect(ledger.outstandingForTask(PROJECT_ID, 'task-at-cutoff')).toHaveLength(1);
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-before-cutoff')).toEqual([]);
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-fresh')).toHaveLength(1);
  });

  it('drops pending clears by queuedAt rather than notifiedAt, keeping one exactly at the cutoff', () => {
    const ledger = new PushClearLedger();
    // An ancient notifiedAt survives because the clear was only queued at the cutoff.
    queueClear(ledger, DEVICE_A, 'task-at-cutoff', 1, CUTOFF);
    // A fresh notifiedAt does not save a clear that was queued before the cutoff.
    queueClear(ledger, DEVICE_A, 'task-before-cutoff', NOW, CUTOFF - 1);
    queueClear(ledger, DEVICE_A, 'task-fresh', 1, NOW);

    ledger.prune(NOW);

    expect(pickedKeys(ledger, DEVICE_A)).toEqual([keyFor('task-fresh'), keyFor('task-at-cutoff')]);
  });
});

describe('PushClearLedger.pickForMessage', () => {
  /**
   * Four pending clears. The two already carried by a standalone clear are
   * queued at 100 and 400, so the newest entry overall is an already-sent one
   * and a plain newest-first sort would put it first.
   */
  function ledgerWithMixedBacklog(): PushClearLedger {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'sent-old', 1000, 100);
    queueClear(ledger, DEVICE_A, 'unsent-old', 1001, 200);
    queueClear(ledger, DEVICE_A, 'unsent-new', 1002, 300);
    queueClear(ledger, DEVICE_A, 'sent-new', 1003, 400);
    const alreadySent = ledger
      .pickForMessage(DEVICE_A, fitsAnything)
      .picked.filter((pick) => pick.key === keyFor('sent-old') || pick.key === keyFor('sent-new'));
    ledger.markStandaloneSent(DEVICE_A, alreadySent, 500);
    return ledger;
  }

  it('returns an empty pick for a device with nothing pending', () => {
    const ledger = new PushClearLedger();

    expect(ledger.pickForMessage(DEVICE_A, fitsAnything)).toEqual({ picked: [], unsentLeft: false });
  });

  it('puts entries no standalone clear has carried first, newest queuedAt first, then the already-sent ones', () => {
    const ledger = ledgerWithMixedBacklog();

    const pick = ledger.pickForMessage(DEVICE_A, fitsAnything);

    expect(pick.picked.map((picked) => picked.key)).toEqual([
      keyFor('unsent-new'),
      keyFor('unsent-old'),
      keyFor('sent-new'),
      keyFor('sent-old'),
    ]);
    expect(pick.unsentLeft).toBe(false);
  });

  it('sets unsentLeft when an unsent entry does not fit', () => {
    const ledger = ledgerWithMixedBacklog();

    const pick = ledger.pickForMessage(DEVICE_A, fitsAtMost(1));

    expect(pick.picked.map((picked) => picked.key)).toEqual([keyFor('unsent-new')]);
    expect(pick.unsentLeft).toBe(true);
  });

  it('leaves unsentLeft false when only already-sent entries do not fit', () => {
    const ledger = ledgerWithMixedBacklog();

    const roomForUnsentOnly = ledger.pickForMessage(DEVICE_A, fitsAtMost(2));
    expect(roomForUnsentOnly.picked.map((picked) => picked.key)).toEqual([keyFor('unsent-new'), keyFor('unsent-old')]);
    expect(roomForUnsentOnly.unsentLeft).toBe(false);

    const roomForOneSent = ledger.pickForMessage(DEVICE_A, fitsAtMost(3));
    expect(roomForOneSent.picked.map((picked) => picked.key)).toEqual([
      keyFor('unsent-new'),
      keyFor('unsent-old'),
      keyFor('sent-new'),
    ]);
    expect(roomForOneSent.unsentLeft).toBe(false);
  });

  it('leaves unsentLeft false when nothing fits and every entry was already sent', () => {
    const ledger = new PushClearLedger();
    queueClear(ledger, DEVICE_A, 'sent-only', 1000, 100);
    ledger.markStandaloneSent(DEVICE_A, ledger.pickForMessage(DEVICE_A, fitsAnything).picked, 200);

    const pick = ledger.pickForMessage(DEVICE_A, fitsAtMost(0));

    expect(pick).toEqual({ picked: [], unsentLeft: false });
  });
});

describe('PushClearLedger.forgetIfUnchanged', () => {
  it('recordDispatched returns the record it replaced, and undefined when there was none', () => {
    const ledger = new PushClearLedger();

    const firstReplaced = dispatch(ledger, DEVICE_A, 'task-1', 1000, 'lane-old');
    const secondReplaced = dispatch(ledger, DEVICE_A, 'task-1', 2000, 'lane-new');

    expect(firstReplaced).toBeUndefined();
    expect(secondReplaced).toEqual({ identity: identityFor('task-1'), notifiedAt: 1000, swimlaneId: 'lane-old' });
  });

  it('restores the record the failed send replaced, so a later resolve still queues a clear for the older notification', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000, 'lane-old');
    const replaced = dispatch(ledger, DEVICE_A, 'task-1', 2000, 'lane-new');

    ledger.forgetIfUnchanged(DEVICE_A, keyFor('task-1'), 2000, replaced);

    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1')).toEqual([
      { identity: identityFor('task-1'), notifiedAt: 1000, swimlaneId: 'lane-old' },
    ]);
    const devicesWithNewClears = ledger.resolve(matchesTask('task-1'), noConnectedDevices, 300);
    expect(devicesWithNewClears).toEqual([DEVICE_A]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([entryFor('task-1', 1000)]);
  });

  it('deletes the record when the failed send replaced nothing', () => {
    const ledger = new PushClearLedger();
    const replaced = dispatch(ledger, DEVICE_A, 'task-1', 1000);
    expect(replaced).toBeUndefined();

    ledger.forgetIfUnchanged(DEVICE_A, keyFor('task-1'), 1000, replaced);

    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1')).toEqual([]);
    expect(ledger.resolve(matchesTask('task-1'), noConnectedDevices, 100)).toEqual([]);
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([]);
  });

  it('does not delete a newer record written under the key since', () => {
    const ledger = new PushClearLedger();
    const firstReplaced = dispatch(ledger, DEVICE_A, 'task-1', 1000);
    dispatch(ledger, DEVICE_A, 'task-1', 2000);

    // The first send fails after the second was dispatched.
    ledger.forgetIfUnchanged(DEVICE_A, keyFor('task-1'), 1000, firstReplaced);

    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1').map((notification) => notification.notifiedAt)).toEqual([2000]);
  });

  it('does not restore over a newer record written under the key since', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000);
    const secondReplaced = dispatch(ledger, DEVICE_A, 'task-1', 2000);
    dispatch(ledger, DEVICE_A, 'task-1', 3000);

    // The second send fails after the third was dispatched: its replaced record (1000) must not come back.
    ledger.forgetIfUnchanged(DEVICE_A, keyFor('task-1'), 2000, secondReplaced);

    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1').map((notification) => notification.notifiedAt)).toEqual([3000]);
  });

  it('ignores a device with nothing outstanding', () => {
    const ledger = new PushClearLedger();
    const replacedElsewhere = dispatch(ledger, DEVICE_B, 'task-1', 1000);

    expect(() => ledger.forgetIfUnchanged(DEVICE_A, keyFor('task-1'), 1000, replacedElsewhere)).not.toThrow();
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-1')).toHaveLength(1);
  });
});

describe('PushClearLedger.rebaseline', () => {
  it('moves only the matching outstanding records to the new lane, across devices, without resolving them', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000, 'lane-1');
    dispatch(ledger, DEVICE_A, 'task-2', 1001, 'lane-1');
    dispatch(ledger, DEVICE_B, 'task-1', 1002, 'lane-1');

    ledger.rebaseline(matchesTask('task-1'), 'lane-2');

    const laneOf = (taskId: string): Array<string | undefined> =>
      ledger.outstandingForTask(PROJECT_ID, taskId).map((notification) => notification.swimlaneId);
    expect(laneOf('task-1')).toEqual(['lane-2', 'lane-2']);
    expect(laneOf('task-2')).toEqual(['lane-1']);
    // Rebaselining is not a resolution: nothing was queued.
    expect(pickedEntries(ledger, DEVICE_A)).toEqual([]);
    expect(pickedEntries(ledger, DEVICE_B)).toEqual([]);
  });
});

describe('PushClearLedger.outstandingForTask', () => {
  it('filters by both projectId and taskId, across devices', () => {
    const ledger = new PushClearLedger();
    dispatch(ledger, DEVICE_A, 'task-1', 1000);
    dispatch(ledger, DEVICE_B, 'task-1', 1001);
    ledger.recordDispatched(DEVICE_A, 'other-project-key', identityFor('task-1', { projectId: 'project-2' }), 1002, 'lane-1');
    dispatch(ledger, DEVICE_A, 'task-2', 1003);

    const ofProjectOne = ledger.outstandingForTask(PROJECT_ID, 'task-1');
    const ofProjectTwo = ledger.outstandingForTask('project-2', 'task-1');

    expect(ofProjectOne.map((notification) => notification.notifiedAt).sort((left, right) => left - right)).toEqual([1000, 1001]);
    expect(ofProjectTwo.map((notification) => notification.notifiedAt)).toEqual([1002]);
    expect(ledger.outstandingForTask(PROJECT_ID, 'task-3')).toEqual([]);
  });
});
