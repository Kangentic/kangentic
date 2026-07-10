/**
 * The signed device roster: the desktop's master Ed25519 signing key signs
 * each paired phone's X25519 static public key into an entry carrying a
 * per-device capability set. The roster - not the relay - is the source
 * of truth for who is paired (anchoring trust in a desktop-held key is the
 * fix for the Signal Sesame / DIMVA-2021 rogue-device-linking weakness of
 * trusting a server for this).
 *
 * This module only provides the DATA SHAPE and the sign/verify primitives.
 * The actual roster store (persistence, revoke-and-rekey policy) lives in
 * the desktop bridge module (src/main/mobile-bridge/roster-store.ts) --
 * "revocation = drop the device AND rotate channel keys" is an operational
 * policy the desktop enforces, not something this package can express on
 * its own.
 */
import { concatBytes, ed25519Sign, ed25519Verify } from '../crypto/primitives';
import { capabilitySetFromArray, capabilitySetToArray, type CapabilitySet, type CapabilityVerb } from '../capabilities/verbs';

export interface RosterDeviceEntry {
  /** Stable identifier for this device, independent of display name - derived from its static public key by the caller. */
  deviceId: string;
  /** The device's X25519 static identity public key (32 bytes). */
  staticPublicKey: Uint8Array;
  displayName: string;
  capabilities: CapabilityVerb[];
  /** ISO 8601. */
  pairedAt: string;
  /** ISO 8601, or null for no expiry (Tailscale-style per-device key expiry is opt-in). */
  expiresAt: string | null;
  /** Ed25519 signature over encodeForSigning(this entry minus signature), by the roster's master signing key. */
  signature: Uint8Array;
}

export interface DeviceRoster {
  /** The desktop's Ed25519 master signing public key - the roster's root of trust. */
  masterSigningPublicKey: Uint8Array;
  devices: RosterDeviceEntry[];
}

function uint32LengthPrefixed(bytes: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, bytes.length, false);
  return concatBytes(prefix, bytes);
}

/**
 * A deterministic, unambiguous byte encoding of a roster entry (minus its
 * signature) for signing/verification. Every field is length-prefixed so
 * concatenation cannot be reinterpreted across a field boundary (e.g.
 * deviceId="ab"+displayName="c" cannot collide with deviceId="a"+displayName="bc").
 */
export function encodeRosterEntryForSigning(entry: Omit<RosterDeviceEntry, 'signature'>): Uint8Array {
  const encoder = new TextEncoder();
  const sortedCapabilities = entry.capabilities.slice().sort().join(',');
  return concatBytes(
    uint32LengthPrefixed(encoder.encode(entry.deviceId)),
    uint32LengthPrefixed(entry.staticPublicKey),
    uint32LengthPrefixed(encoder.encode(entry.displayName)),
    uint32LengthPrefixed(encoder.encode(sortedCapabilities)),
    uint32LengthPrefixed(encoder.encode(entry.pairedAt)),
    uint32LengthPrefixed(encoder.encode(entry.expiresAt ?? '')),
  );
}

export function signRosterEntry(masterSigningSecretKey: Uint8Array, entry: Omit<RosterDeviceEntry, 'signature'>): RosterDeviceEntry {
  const signature = ed25519Sign(encodeRosterEntryForSigning(entry), masterSigningSecretKey);
  return { ...entry, signature };
}

export function verifyRosterEntry(masterSigningPublicKey: Uint8Array, entry: RosterDeviceEntry): boolean {
  return ed25519Verify(entry.signature, encodeRosterEntryForSigning(entry), masterSigningPublicKey);
}

export function isRosterEntryExpired(entry: RosterDeviceEntry, now: Date): boolean {
  if (entry.expiresAt === null) return false;
  return new Date(entry.expiresAt).getTime() <= now.getTime();
}

export function findRosterDevice(roster: DeviceRoster, deviceId: string): RosterDeviceEntry | undefined {
  return roster.devices.find((device) => device.deviceId === deviceId);
}

export function rosterDeviceCapabilitySet(entry: RosterDeviceEntry): CapabilitySet {
  return capabilitySetFromArray(entry.capabilities);
}

export function capabilitySetToRosterCapabilities(capabilities: CapabilitySet): CapabilityVerb[] {
  return capabilitySetToArray(capabilities);
}
