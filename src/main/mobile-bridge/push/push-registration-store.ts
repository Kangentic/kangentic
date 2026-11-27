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
 * the notifier's send path. A corrupt file (one that will not parse, or
 * is not an object) is set aside as `<file>.corrupt` and reported with a
 * fixed `load_cause`, so the next registration writes a clean file and a
 * phone told it holds none (`registrationState`) registers again. Sentry
 * DESKTOP-5H was one such file kept for two app runs, with every push
 * dropped in between. A file that is there and cannot be read is
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

/** Why a registrations file that read did not load, as the `load_cause` tag. */
export type PushRegistrationsLoadCause = 'empty' | 'nul_filled' | 'truncated' | 'invalid';

/** Whether the store holds a device's registration. `unknown` while the file is there and will not read. */
export type PushRegistrationState = 'registered' | 'absent' | 'unknown';

/**
 * The one error a corrupt registrations file reports as, whatever the cause,
 * so each `load_cause` is one Sentry issue. A parse failure rides as `cause`.
 */
export class PushRegistrationsCorruptError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The push registrations file is corrupt', options);
    this.name = 'PushRegistrationsCorruptError';
  }
}

/**
 * The shape of a file that would not load. NUL bytes are what an OS crash or a
 * power loss can leave in a file whose rename landed before its data did. A
 * file that opens a JSON value and never closes it was cut off mid-write,
 * which a bare write straight onto the target (0.63.0 and earlier) could do.
 */
function loadCauseOf(raw: string): PushRegistrationsLoadCause {
  const trimmed = raw.trim();
  if (trimmed === '') return 'empty';
  if (raw.includes('\0')) return 'nul_filled';
  if ((trimmed.startsWith('{') && !trimmed.endsWith('}')) || (trimmed.startsWith('[') && !trimmed.endsWith(']'))) {
    return 'truncated';
  }
  return 'invalid';
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
   * loads as empty and is kept. A corrupt one is set aside and reported, and
   * loads as empty and is kept. A file that is there and could not be read
   * loads as empty for this call only.
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // report-ok: setAsideCorruptFile reports it, as PushRegistrationsCorruptError
        // with this parse error as its cause.
        this.setAsideCorruptFile(raw, error);
        this.registrations = loaded;
        return loaded;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [deviceId, entry] of Object.entries(parsed)) {
          if (isPushRegistration(entry)) loaded.set(deviceId, entry);
        }
      } else {
        this.setAsideCorruptFile(raw, null);
      }
    }
    this.registrations = loaded;
    return loaded;
  }

  /**
   * Every paired phone gets no notifications until it registers again, so the
   * file is moved out of the way and the next registration writes a clean one.
   * The copy kept beside it is for diagnosis; a later corrupt file replaces it.
   */
  private setAsideCorruptFile(raw: string, parseError: unknown): void {
    const loadCause = loadCauseOf(raw);
    const filePath = this.filePath();
    try {
      fs.renameSync(filePath, `${filePath}.corrupt`);
    } catch (error) {
      // report-ok: the next registration replaces the corrupt file through
      // safeWriteJson, so a set-aside that failed loses only the copy kept for
      // diagnosis. The corrupt file itself is reported below.
      console.warn('[mobile-bridge/push-registration-store] could not set the corrupt registrations aside:', error);
    }
    const corruptError = new PushRegistrationsCorruptError(parseError === null ? undefined : { cause: parseError });
    // A file the machine left unreadable, not a code path, so it groups by cause.
    mobileBridgeReporter.report(corruptError, {
      tags: { stage: 'push_registrations_load', load_cause: loadCause },
      fingerprint: ['handled-env', corruptError.name, loadCause],
    });
    console.warn(`[mobile-bridge/push-registration-store] the registrations were corrupt (${loadCause}), set aside and starting empty`);
  }

  /** Whether this desktop holds `deviceId`'s registration, for the phone's bootstrap read. */
  registrationState(deviceId: string): PushRegistrationState {
    const registrations = this.load();
    // load() sets `unreadable` only on a read that failed while the file was there, and clears it on the next read that works.
    if (this.unreadable !== null) return 'unknown';
    return registrations.has(deviceId) ? 'registered' : 'absent';
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
