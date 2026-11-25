import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config/paths';
import { reportSyncWriteFailure } from '../config/write-failure-notice';
import { safeWriteJson } from '../safe-write';
import {
  bytesToHex,
  hexToBytes,
  signRosterEntry,
  verifyRosterEntry,
  type CapabilityVerb,
  type DeviceRoster,
  type RosterDeviceEntry,
} from '@kangentic/protocol';
import type { BridgeIdentity } from './identity';
import { mobileBridgeReporter } from './mobile-bridge-report';
import { RefusalError } from '../../shared/refusal';

/**
 * Persists the signed device roster to a global JSON file (like the
 * device identity, this represents the desktop installation, not any one
 * project). The roster - not the relay - is the source of truth for
 * who is paired; every entry read back off disk is re-verified against
 * the roster's own master signing key before being trusted, so a
 * corrupted or hand-edited roster file degrades to "that device drops
 * out" rather than silently trusting tampered data.
 */
const ROSTER_FILENAME = 'mobile-bridge-roster.json';

/** The write-failure latch's name for the roster: one notice per outage, whichever step failed. */
const ROSTER_WRITE_SOURCE = 'mobile_bridge_roster';

interface StoredRosterEntry {
  deviceId: string;
  staticPublicKeyHex: string;
  displayName: string;
  capabilities: CapabilityVerb[];
  pairedAt: string;
  expiresAt: string | null;
  signatureHex: string;
}

interface StoredRoster {
  masterSigningPublicKeyHex: string;
  devices: StoredRosterEntry[];
}

function rosterPath(): string {
  return path.join(PATHS.configDir, ROSTER_FILENAME);
}

function toStoredEntry(entry: RosterDeviceEntry): StoredRosterEntry {
  return {
    deviceId: entry.deviceId,
    staticPublicKeyHex: bytesToHex(entry.staticPublicKey),
    displayName: entry.displayName,
    capabilities: entry.capabilities,
    pairedAt: entry.pairedAt,
    expiresAt: entry.expiresAt,
    signatureHex: bytesToHex(entry.signature),
  };
}

function fromStoredEntry(stored: StoredRosterEntry): RosterDeviceEntry {
  return {
    deviceId: stored.deviceId,
    staticPublicKey: hexToBytes(stored.staticPublicKeyHex),
    displayName: stored.displayName,
    capabilities: stored.capabilities,
    pairedAt: stored.pairedAt,
    expiresAt: stored.expiresAt,
    signature: hexToBytes(stored.signatureHex),
  };
}

function emptyRoster(identity: BridgeIdentity): DeviceRoster {
  return { masterSigningPublicKey: identity.masterSigningKeyPair.publicKey, devices: [] };
}

/** A read that failed because there is no file: the path, or a folder on it, does not exist. */
export function isAbsentFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * One read of the roster file. `unreadable` holds the error when the file is
 * there and the read itself failed (a lock, a permission, a volume that went
 * away): the file may be whole, so nothing may be written over it on the
 * strength of this read. A file that reads but will not parse has nothing left
 * to keep, and is an empty roster like a missing one.
 */
interface RosterRead {
  roster: DeviceRoster;
  unreadable: unknown;
}

function readRoster(identity: BridgeIdentity, reportUnreadable: boolean): RosterRead {
  let raw: string;
  try {
    raw = fs.readFileSync(rosterPath(), 'utf8');
  } catch (error) {
    // No file is the normal state before the first pairing.
    if (isAbsentFile(error)) return { roster: emptyRoster(identity), unreadable: null };
    // Every paired phone reads as unpaired for as long as this lasts. A caller
    // about to write reports it as the write that could not be made instead.
    if (reportUnreadable) mobileBridgeReporter.report(error, { tags: { stage: 'roster_load' } });
    console.warn('[mobile-bridge/roster-store] the roster could not be read:', error);
    return { roster: emptyRoster(identity), unreadable: error };
  }
  try {
    const stored = JSON.parse(raw) as StoredRoster;
    const masterSigningPublicKey = hexToBytes(stored.masterSigningPublicKeyHex);
    const devices = stored.devices
      .map(fromStoredEntry)
      .filter((entry) => verifyRosterEntry(masterSigningPublicKey, entry));
    return { roster: { masterSigningPublicKey, devices }, unreadable: null };
  } catch (error) {
    // The file is there and will not parse, so every paired phone is unpaired
    // and has to pair again.
    mobileBridgeReporter.report(error, { tags: { stage: 'roster_load' } });
    console.warn('[mobile-bridge/roster-store] failed to parse the roster, starting empty:', error);
    return { roster: emptyRoster(identity), unreadable: null };
  }
}

export function loadRoster(identity: BridgeIdentity): DeviceRoster {
  return readRoster(identity, true).roster;
}

/**
 * The roster a change is applied to, and whether the change may be saved.
 *
 * A read that failed fell back to an empty roster. Saving a change made to that
 * would replace a file that may be whole with one device, or none, and unpair
 * every other phone. So the change is not saved, and the user is told the way a
 * failed write tells them (`reportSyncWriteFailure`): to them it is the same
 * thing, a pairing or a revoke that did not reach the disk.
 */
function rosterToChange(identity: BridgeIdentity): { roster: DeviceRoster; maySave: boolean } {
  const { roster, unreadable } = readRoster(identity, false);
  if (unreadable === null) return { roster, maySave: true };
  reportSyncWriteFailure(unreadable, ROSTER_WRITE_SOURCE, { stage: 'read_before_write' });
  return { roster, maySave: false };
}

function saveRoster(roster: DeviceRoster): void {
  const stored: StoredRoster = {
    masterSigningPublicKeyHex: bytesToHex(roster.masterSigningPublicKey),
    devices: roster.devices.map(toStoredEntry),
  };
  // Degrades rather than throws: a pair/rename/revoke must not reject on an
  // unwritable config directory. The shared write-failure-notice latch tells
  // the user once (see safe-write.ts).
  safeWriteJson(rosterPath(), stored, ROSTER_WRITE_SOURCE);
}

export interface AddDeviceInput {
  deviceId: string;
  staticPublicKey: Uint8Array;
  displayName: string;
  capabilities: CapabilityVerb[];
  expiresAt: string | null;
}

/** Signs `entryInput` and splices it into the roster in place of any existing entry for the same deviceId. The shared tail of addOrReplaceDevice/setDeviceCapabilities/setDeviceDisplayName - what differs between them is only which fields change and whether pairedAt gets restamped. */
function replaceDeviceEntry(identity: BridgeIdentity, entryInput: Omit<RosterDeviceEntry, 'signature'>): DeviceRoster {
  const { roster, maySave } = rosterToChange(identity);
  const entry = signRosterEntry(identity.masterSigningKeyPair.secretKey, entryInput);
  const nextRoster: DeviceRoster = {
    ...roster,
    devices: [...roster.devices.filter((device) => device.deviceId !== entryInput.deviceId), entry],
  };
  if (maySave) saveRoster(nextRoster);
  return nextRoster;
}

export function addOrReplaceDevice(identity: BridgeIdentity, input: AddDeviceInput): DeviceRoster {
  return replaceDeviceEntry(identity, {
    deviceId: input.deviceId,
    staticPublicKey: input.staticPublicKey,
    displayName: input.displayName,
    capabilities: input.capabilities,
    pairedAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  });
}

/**
 * The paired device a rename or a capability change signs again, or null when
 * the roster would not read. Whether the device is paired is unknown then, and
 * its entry cannot be signed again without the key the file holds, so the
 * change is dropped and the user is told as for any change that did not reach
 * the disk (`rosterToChange`). Only a roster that did read can say a device is
 * not paired, which is the refusal.
 */
function deviceToChange(identity: BridgeIdentity, deviceId: string): { roster: DeviceRoster; existing: RosterDeviceEntry | null } {
  const { roster, maySave } = rosterToChange(identity);
  if (!maySave) return { roster, existing: null };
  const existing = roster.devices.find((device) => device.deviceId === deviceId);
  if (!existing) throw new RefusalError(`No such paired device: ${deviceId}`);
  return { roster, existing };
}

/** Capabilities are part of the signed payload, so changing them re-signs the entry. Preserves the original pairedAt - a capability change (including the one-shot full-grant migration) is not a re-pairing. */
export function setDeviceCapabilities(identity: BridgeIdentity, deviceId: string, capabilities: CapabilityVerb[]): DeviceRoster {
  const { roster, existing } = deviceToChange(identity, deviceId);
  if (!existing) return roster;
  return replaceDeviceEntry(identity, {
    deviceId: existing.deviceId,
    staticPublicKey: existing.staticPublicKey,
    displayName: existing.displayName,
    capabilities,
    pairedAt: existing.pairedAt,
    expiresAt: existing.expiresAt,
  });
}

/** Display name is part of the signed payload too, so renaming re-signs the entry. Preserves the original pairedAt - a rename is not a re-pairing. */
export function setDeviceDisplayName(identity: BridgeIdentity, deviceId: string, displayName: string): DeviceRoster {
  const { roster, existing } = deviceToChange(identity, deviceId);
  if (!existing) return roster;
  return replaceDeviceEntry(identity, {
    deviceId: existing.deviceId,
    staticPublicKey: existing.staticPublicKey,
    displayName,
    capabilities: existing.capabilities,
    pairedAt: existing.pairedAt,
    expiresAt: existing.expiresAt,
  });
}

/**
 * Revocation = drop the device from the roster AND rotate the desktop's
 * own static identity key. Removal without rekey is not revocation: a
 * revoked device that already completed a Noise KK handshake could
 * otherwise still authenticate against future sessions as long as the
 * desktop's static key is unchanged, since KK's mutual authentication
 * only proves possession of the OLD key pair, which revocation from the
 * roster alone does not invalidate. This function only owns the roster
 * side; the caller (mobile-bridge-service) is responsible for rotating
 * and re-persisting the identity and restarting the relay connection.
 */
export function revokeDevice(identity: BridgeIdentity, deviceId: string): DeviceRoster {
  const { roster, maySave } = rosterToChange(identity);
  const nextRoster: DeviceRoster = { ...roster, devices: roster.devices.filter((device) => device.deviceId !== deviceId) };
  if (maySave) saveRoster(nextRoster);
  return nextRoster;
}

export function clearRoster(): void {
  // rmSync with force ignores a missing file.
  try {
    fs.rmSync(rosterPath(), { force: true });
  } catch (error) {
    // report-ok: a transient Windows file lock leaves the roster in place and
    // the clear does not throw. Nothing in the app calls this clear yet, only
    // tests, so no flow depends on it.
    console.warn('[mobile-bridge/roster-store] failed to clear roster:', error);
  }
}
