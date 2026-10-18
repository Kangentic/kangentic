/**
 * PushNotifier's memory of what it told each device, so it can take it back.
 * Pure bookkeeping (no timers, no I/O, no clock of its own) so the notifier
 * keeps the triggers and the sends, and this keeps the rules about which
 * clear is owed to whom.
 *
 * Two maps per device, both keyed like the notifier's cooldown minus the
 * device (`${subject}|${category}`):
 *
 * - outstanding: a notification dispatched to the device that has not
 *   resolved yet. Recorded at dispatch rather than on Expo's answer, so a
 *   resolution that lands while the POST (and its network retry) is in
 *   flight still finds it; a send that fails takes back only its own record
 *   and restores the one it replaced.
 * - pending: a clear owed to the device. It leaves when a message carrying it
 *   is delivered (removeIfUnchanged), or after PUSH_ENVELOPE_MAX_AGE_MS,
 *   which is also how long a phone accepts the message that carries it.
 *
 * Both are compared by notifiedAt before anything is taken out, so a send
 * that settles late never removes a newer record written for the same key
 * while it was in flight.
 */
import { PUSH_ENVELOPE_MAX_AGE_MS, type PushClearEntry } from '@kangentic/protocol';

/** A clear entry's identity: everything but notifiedAt, copied from the sealed envelope. */
export type PushClearIdentity = Omit<PushClearEntry, 'notifiedAt'>;

export interface OutstandingNotification {
  identity: PushClearIdentity;
  /** The dispatched envelope's sentAt. */
  notifiedAt: number;
  /** The task's lane when notified. Absent for a Command Terminal, whose taskId names no task row. */
  swimlaneId?: string;
}

interface PendingClear {
  entry: PushClearEntry;
  queuedAt: number;
  /** Set once a standalone clear carrying this entry was accepted (iOS keeps it pending after that). */
  standaloneSentAt?: number;
}

/** A pending clear picked for one message, with the key it is filed under. */
export interface PickedClear {
  key: string;
  entry: PushClearEntry;
}

export interface ClearPick {
  picked: PickedClear[];
  /** True when an entry no standalone clear has carried yet did not fit. */
  unsentLeft: boolean;
}

function toEntry(notification: OutstandingNotification): PushClearEntry {
  return { ...notification.identity, notifiedAt: notification.notifiedAt };
}

export class PushClearLedger {
  private readonly outstanding = new Map<string, Map<string, OutstandingNotification>>();
  private readonly pending = new Map<string, Map<string, PendingClear>>();

  private outstandingFor(deviceId: string): Map<string, OutstandingNotification> {
    let notifications = this.outstanding.get(deviceId);
    if (!notifications) {
      notifications = new Map();
      this.outstanding.set(deviceId, notifications);
    }
    return notifications;
  }

  private pendingFor(deviceId: string): Map<string, PendingClear> {
    let clears = this.pending.get(deviceId);
    if (!clears) {
      clears = new Map();
      this.pending.set(deviceId, clears);
    }
    return clears;
  }

  /** Records a notification just dispatched, replacing any older one under the same key. Returns the record it replaced. */
  recordDispatched(
    deviceId: string,
    key: string,
    identity: PushClearIdentity,
    notifiedAt: number,
    swimlaneId: string | undefined,
  ): OutstandingNotification | undefined {
    const notifications = this.outstandingFor(deviceId);
    const replaced = notifications.get(key);
    notifications.set(key, { identity, notifiedAt, ...(swimlaneId !== undefined ? { swimlaneId } : {}) });
    return replaced;
  }

  /**
   * A send that failed takes back its own record, never a newer one dispatched
   * under the same key since. It puts back the record it replaced, because
   * that older notification is still on the phone and still owed its clear.
   */
  forgetIfUnchanged(deviceId: string, key: string, notifiedAt: number, replaced: OutstandingNotification | undefined): void {
    const notifications = this.outstanding.get(deviceId);
    if (notifications?.get(key)?.notifiedAt !== notifiedAt) return;
    if (replaced) notifications.set(key, replaced);
    else notifications.delete(key);
  }

  /**
   * Moves every outstanding notification `matches` accepts into its device's
   * pending clears, keeping the newer notifiedAt when the key is already
   * pending. A device `getConnectedDeviceIds` names is watching from the app,
   * which reconciles its own notifications, so its matches are dropped and
   * nothing is queued for it. Returns the devices that gained a pending clear.
   */
  resolve(matches: (notification: OutstandingNotification) => boolean, getConnectedDeviceIds: () => Set<string>, now: number): string[] {
    const devicesWithNewClears: string[] = [];
    let connectedDeviceIds: Set<string> | null = null;
    for (const [deviceId, notifications] of this.outstanding) {
      let gainedClear = false;
      for (const [key, notification] of notifications) {
        if (!matches(notification)) continue;
        notifications.delete(key);
        connectedDeviceIds ??= getConnectedDeviceIds();
        if (connectedDeviceIds.has(deviceId)) continue;
        const clears = this.pendingFor(deviceId);
        const existing = clears.get(key);
        if (existing && existing.entry.notifiedAt >= notification.notifiedAt) continue;
        clears.set(key, { entry: toEntry(notification), queuedAt: now });
        gainedClear = true;
      }
      if (gainedClear) devicesWithNewClears.push(deviceId);
    }
    return devicesWithNewClears;
  }

  /** Points every outstanding notification `matches` accepts at a new lane, without resolving it. */
  rebaseline(matches: (notification: OutstandingNotification) => boolean, swimlaneId: string): void {
    for (const notifications of this.outstanding.values()) {
      for (const notification of notifications.values()) {
        if (matches(notification)) notification.swimlaneId = swimlaneId;
      }
    }
  }

  /** Every outstanding notification for a task, across devices: what the board listener checks a move against. */
  outstandingForTask(projectId: string, taskId: string): OutstandingNotification[] {
    const found: OutstandingNotification[] = [];
    for (const notifications of this.outstanding.values()) {
      for (const notification of notifications.values()) {
        if (notification.identity.taskId === taskId && notification.identity.projectId === projectId) found.push(notification);
      }
    }
    return found;
  }

  /**
   * Picks pending clears for one message, as many as `fits` accepts. Entries
   * no standalone clear has carried yet come first, newest first, then the
   * already-sent ones in whatever room is left: an iOS backlog larger than
   * one message would otherwise resend the same newest entries every time and
   * never reach the older ones.
   */
  pickForMessage(deviceId: string, fits: (entries: PushClearEntry[]) => boolean): ClearPick {
    const clears = this.pending.get(deviceId);
    if (!clears || clears.size === 0) return { picked: [], unsentLeft: false };
    const newestFirst = (left: [string, PendingClear], right: [string, PendingClear]): number => right[1].queuedAt - left[1].queuedAt;
    const unsent = [...clears].filter(([, clear]) => clear.standaloneSentAt === undefined).sort(newestFirst);
    const alreadySent = [...clears].filter(([, clear]) => clear.standaloneSentAt !== undefined).sort(newestFirst);
    const picked: PickedClear[] = [];
    let unsentLeft = false;
    for (const [key, clear] of [...unsent, ...alreadySent]) {
      const candidate = [...picked.map((pick) => pick.entry), clear.entry];
      if (fits(candidate)) {
        picked.push({ key, entry: clear.entry });
      } else if (clear.standaloneSentAt === undefined) {
        unsentLeft = true;
      }
    }
    return { picked, unsentLeft };
  }

  /** Stamps entries a standalone clear carried, keeping them pending. Skips any key re-queued with a newer entry since. */
  markStandaloneSent(deviceId: string, picked: PickedClear[], now: number): void {
    const clears = this.pending.get(deviceId);
    if (!clears) return;
    for (const pick of picked) {
      const clear = clears.get(pick.key);
      if (clear && clear.entry.notifiedAt === pick.entry.notifiedAt) clear.standaloneSentAt = now;
    }
  }

  /** Removes delivered entries. Skips any key re-queued with a newer entry while the message was in flight. */
  removeIfUnchanged(deviceId: string, picked: PickedClear[]): void {
    const clears = this.pending.get(deviceId);
    if (!clears) return;
    for (const pick of picked) {
      if (clears.get(pick.key)?.entry.notifiedAt === pick.entry.notifiedAt) clears.delete(pick.key);
    }
  }

  dropPending(deviceId: string): void {
    this.pending.delete(deviceId);
  }

  /** Forgets a device entirely: its registration is gone or no longer takes clears. */
  dropDevice(deviceId: string): void {
    this.outstanding.delete(deviceId);
    this.pending.delete(deviceId);
  }

  /** Drops what is past the phone's own freshness window: outstanding by notifiedAt, pending by queuedAt. */
  prune(now: number): void {
    const cutoff = now - PUSH_ENVELOPE_MAX_AGE_MS;
    for (const [deviceId, notifications] of this.outstanding) {
      for (const [key, notification] of notifications) {
        if (notification.notifiedAt < cutoff) notifications.delete(key);
      }
      if (notifications.size === 0) this.outstanding.delete(deviceId);
    }
    for (const [deviceId, clears] of this.pending) {
      for (const [key, clear] of clears) {
        if (clear.queuedAt < cutoff) clears.delete(key);
      }
      if (clears.size === 0) this.pending.delete(deviceId);
    }
  }

  clear(): void {
    this.outstanding.clear();
    this.pending.clear();
  }
}
