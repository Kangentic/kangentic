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
 * the notifier's send path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPushCategory, type PushCategory } from '@kangentic/protocol';
import { PATHS } from '../../config/paths';

const REGISTRATIONS_FILENAME = 'mobile-push-registrations.json';

export interface PushRegistration {
  expoPushToken: string;
  /** The device-generated 32-byte push-envelope key, hex-encoded (64 chars). */
  pushKeyHex: string;
  platform: 'android' | 'ios';
  registeredAt: string;
  /** The device's push preferences; undefined means every category (older or default registration). */
  categories?: PushCategory[];
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
  if (record.categories === undefined) return true;
  return Array.isArray(record.categories) && record.categories.every(isPushCategory);
}

export class PushRegistrationStore {
  /** Lazy in-memory mirror of the sidecar; null until the first load(). */
  private registrations: Map<string, PushRegistration> | null = null;

  private filePath(): string {
    return path.join(PATHS.configDir, REGISTRATIONS_FILENAME);
  }

  /** Reads the sidecar into memory, dropping malformed entries. Missing or corrupt files load as empty. */
  load(): Map<string, PushRegistration> {
    if (this.registrations) return this.registrations;
    const loaded = new Map<string, PushRegistration>();
    try {
      if (fs.existsSync(this.filePath())) {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [deviceId, entry] of Object.entries(parsed)) {
            if (isPushRegistration(entry)) loaded.set(deviceId, entry);
          }
        }
      }
    } catch (error) {
      console.warn('[mobile-bridge/push-registration-store] failed to load registrations, starting empty:', error);
    }
    this.registrations = loaded;
    return loaded;
  }

  private save(): void {
    if (!this.registrations) return;
    const stored: Record<string, PushRegistration> = {};
    for (const [deviceId, registration] of this.registrations) stored[deviceId] = registration;
    try {
      fs.mkdirSync(PATHS.configDir, { recursive: true });
      fs.writeFileSync(this.filePath(), JSON.stringify(stored, null, 2));
    } catch (error) {
      console.warn('[mobile-bridge/push-registration-store] failed to persist registrations:', error);
    }
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
