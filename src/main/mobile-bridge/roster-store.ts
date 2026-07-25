import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config/paths';
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

export function loadRoster(identity: BridgeIdentity): DeviceRoster {
  const filePath = rosterPath();
  if (!fs.existsSync(filePath)) return emptyRoster(identity);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const stored = JSON.parse(raw) as StoredRoster;
    const masterSigningPublicKey = hexToBytes(stored.masterSigningPublicKeyHex);
    const devices = stored.devices
      .map(fromStoredEntry)
      .filter((entry) => verifyRosterEntry(masterSigningPublicKey, entry));
    return { masterSigningPublicKey, devices };
  } catch (error) {
    console.warn('[mobile-bridge/roster-store] failed to load roster, starting empty:', error);
    return emptyRoster(identity);
  }
}

function saveRoster(roster: DeviceRoster): void {
  fs.mkdirSync(PATHS.configDir, { recursive: true });
  const stored: StoredRoster = {
    masterSigningPublicKeyHex: bytesToHex(roster.masterSigningPublicKey),
    devices: roster.devices.map(toStoredEntry),
  };
  fs.writeFileSync(rosterPath(), JSON.stringify(stored, null, 2));
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
  const roster = loadRoster(identity);
  const entry = signRosterEntry(identity.masterSigningKeyPair.secretKey, entryInput);
  const nextRoster: DeviceRoster = {
    ...roster,
    devices: [...roster.devices.filter((device) => device.deviceId !== entryInput.deviceId), entry],
  };
  saveRoster(nextRoster);
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

/** Capabilities are part of the signed payload, so changing them re-signs the entry. Preserves the original pairedAt - a capability change (including the one-shot full-grant migration) is not a re-pairing. */
export function setDeviceCapabilities(identity: BridgeIdentity, deviceId: string, capabilities: CapabilityVerb[]): DeviceRoster {
  const roster = loadRoster(identity);
  const existing = roster.devices.find((device) => device.deviceId === deviceId);
  if (!existing) throw new Error(`No such paired device: ${deviceId}`);
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
  const roster = loadRoster(identity);
  const existing = roster.devices.find((device) => device.deviceId === deviceId);
  if (!existing) throw new Error(`No such paired device: ${deviceId}`);
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
  const roster = loadRoster(identity);
  const nextRoster: DeviceRoster = { ...roster, devices: roster.devices.filter((device) => device.deviceId !== deviceId) };
  saveRoster(nextRoster);
  return nextRoster;
}

export function clearRoster(): void {
  // rmSync with force ignores a missing file; the try/catch swallows a
  // transient Windows file lock so a best-effort clear never throws.
  try {
    fs.rmSync(rosterPath(), { force: true });
  } catch (error) {
    console.warn('[mobile-bridge/roster-store] failed to clear roster:', error);
  }
}
