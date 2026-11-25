/**
 * Persists per-device push registrations (Expo push token + the device's
 * push-envelope key) to a JSON sidecar in the app's global config dir,
 * following roster-store.ts's file-in-PATHS.configDir pattern: like the
 * identity and the roster, a push registration belongs to the desktop
 * installation, not to any one project. The push key here is the
 * device-GENERATED symmetric envelope key (see the protocol package's
 * crypto/push-envelope.ts), stored hex-encoded; it authorizes nothing on
 * its own - a stolen file lets an attacker read notifications only if
 * they can also intercept the Expo delivery for that exact device.
 *
 * Loading is tolerant: a missing or corrupt file, or a malformed entry,
 * degrades to "that registration drops out" rather than throwing into
 * the notifier's send path. A file that is there and cannot be read is
 * different: it may be whole, so it is read again on the next call and
 * nothing is written over it until a read succeeds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPushCategory, type PushCategory } from '@kangentic/protocol';
import { PATHS } from '../../config/paths';
import { reportSyncWriteFailure } from '../../config/write-failure-notice';
import { safeWriteJson } from '../../safe-write';
import { mobileBridgeReporter } from '../mobile-bridge-report';
import { isAbsentFile } from '../roster-store';

const REGISTRATIONS_FILENAME = 'mobile-push-registrations.json';

/** The write-failure latch's name for this file: one notice per outage, whichever step failed. */
const REGISTRATIONS_WRITE_SOURCE = 'mobile_push_registrations';

export interface PushRegistration {
  expoPushToken: string;
  /** The device-generated 32-byte push-envelope key, hex-encoded (64 chars). */
  pushKeyHex: string;
  platform: 'android' | 'ios';
  registeredAt: string;
  /** The device's push preferences; undefined means every category (older or default registration). */
  categories?: PushCategory[];
  /** True when the device opted into sealed clears; undefined means it never did (an older app). */
  acceptsClears?: boolean;
}

export interface PushRegistrationEntry extends PushRegistration {
  deviceId: string;
}

function isPushRegistration(value: unknown): value is PushRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.expoPushToken !== 'string' ||
    typeof record.pushKeyHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.pushKeyHex) ||
    (record.platform !== 'android' && record.platform !== 'ios') ||
    typeof record.registeredAt !== 'string'
  ) {
    return false;
  }
  if (record.acceptsClears !== undefined && typeof record.acceptsClears !== 'boolean') return false;
  if (record.categories === undefined) return true;
  return Array.isArray(record.categories) && record.categories.every(isPushCategory);
}

export class PushRegistrationStore {
  /** Lazy in-memory mirror of the sidecar; null until the first load(). */
  private registrations: Map<string, PushRegistration> | null = null;

  private filePath(): string {
    return path.join(PATHS.configDir, REGISTRATIONS_FILENAME);
  }

  /**
   * The error of the last read that failed while the file was there, or null.
   * The file may be whole, so that read is not kept as the mirror: the next
   * call reads again, and until one succeeds nothing is written over the file.
   */
  private unreadable: unknown = null;

  /**
   * Reads the sidecar into memory, dropping malformed entries. A missing file
   * and one that will not parse load as empty and are kept. A file that is there
   * and could not be read loads as empty for this call only.
   */
  load(): Map<string, PushRegistration> {
    if (this.registrations) return this.registrations;
    const loaded = new Map<string, PushRegistration>();
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.filePath(), 'utf8');
      this.unreadable = null;
    } catch (error) {
      if (!isAbsentFile(error)) {
        // Every paired phone gets no notifications for as long as this lasts,
        // and nothing on the desktop says so.
        mobileBridgeReporter.report(error, { tags: { stage: 'push_registrations_load' } });
        console.warn('[mobile-bridge/push-registration-store] the registrations could not be read:', error);
        this.unreadable = error;
        return loaded;
      }
      this.unreadable = null;
    }
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [deviceId, entry] of Object.entries(parsed)) {
            if (isPushRegistration(entry)) loaded.set(deviceId, entry);
          }
        }
      } catch (error) {
        // The file will not parse, so every paired phone stops getting
        // notifications until it registers again.
        mobileBridgeReporter.report(error, { tags: { stage: 'push_registrations_load' } });
        console.warn('[mobile-bridge/push-registration-store] failed to parse registrations, starting empty:', error);
      }
    }
    this.registrations = loaded;
    return loaded;
  }

  private save(): void {
    if (!this.registrations) {
      // The read behind this change failed, so the change was made to an empty
      // stand-in. Saving that would drop every other phone's registration from a
      // file that may be whole. The user is told as for a write that failed.
      if (this.unreadable !== null) {
        reportSyncWriteFailure(this.unreadable, REGISTRATIONS_WRITE_SOURCE, { stage: 'read_before_write' });
      }
      return;
    }
    const stored: Record<string, PushRegistration> = {};
    for (const [deviceId, registration] of this.registrations) stored[deviceId] = registration;
    // Degrades rather than throws, like the roster: a register or a revoke must
    // not reject on an unwritable config directory. The write is atomic, and a
    // failure is reported once through the shared write-failure latch
    // (safe-write.ts), which also tells the user.
    safeWriteJson(this.filePath(), stored, REGISTRATIONS_WRITE_SOURCE);
  }

  upsert(deviceId: string, registration: PushRegistration): void {
    this.load().set(deviceId, registration);
    this.save();
  }

  /** Removes a device's registration. A no-op (no write) when none exists - callers hook this from revocation unconditionally. */
  remove(deviceId: string): void {
    if (!this.load().delete(deviceId)) return;
    this.save();
  }

  list(): PushRegistrationEntry[] {
    return Array.from(this.load(), ([deviceId, registration]) => ({ deviceId, ...registration }));
  }
}
