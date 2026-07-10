import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair, generateX25519KeyPair } from '../../../packages/protocol/src/crypto/primitives';
import {
  findRosterDevice,
  isRosterEntryExpired,
  rosterDeviceCapabilitySet,
  signRosterEntry,
  verifyRosterEntry,
  type DeviceRoster,
} from '../../../packages/protocol/src/roster/roster';

function buildSignedEntry(masterSigningSecretKey: Uint8Array, overrides: Partial<Parameters<typeof signRosterEntry>[1]> = {}) {
  const device = generateX25519KeyPair();
  return signRosterEntry(masterSigningSecretKey, {
    deviceId: 'device-1',
    staticPublicKey: device.publicKey,
    displayName: "My iPhone",
    capabilities: ['read-board', 'read-stream'],
    pairedAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  });
}

describe('device roster signing', () => {
  it('signs and verifies a roster entry against the master signing key', () => {
    const master = generateEd25519KeyPair();
    const entry = buildSignedEntry(master.secretKey);
    expect(verifyRosterEntry(master.publicKey, entry)).toBe(true);
  });

  it('rejects an entry signed by a different key', () => {
    const master = generateEd25519KeyPair();
    const otherMaster = generateEd25519KeyPair();
    const entry = buildSignedEntry(master.secretKey);
    expect(verifyRosterEntry(otherMaster.publicKey, entry)).toBe(false);
  });

  it('rejects a tampered entry (capability escalation after signing)', () => {
    const master = generateEd25519KeyPair();
    const entry = buildSignedEntry(master.secretKey, { capabilities: ['read-board'] });
    const escalated = { ...entry, capabilities: [...entry.capabilities, 'answer-permission-prompt' as const] };
    expect(verifyRosterEntry(master.publicKey, escalated)).toBe(false);
  });

  it('rejects a tampered displayName (field-boundary confusion is not exploitable)', () => {
    const master = generateEd25519KeyPair();
    const entry = buildSignedEntry(master.secretKey, { deviceId: 'ab', displayName: 'c' });
    const shifted = { ...entry, deviceId: 'a', displayName: 'bc' };
    expect(verifyRosterEntry(master.publicKey, shifted)).toBe(false);
  });

  it('capability set round-trips through the roster entry', () => {
    const master = generateEd25519KeyPair();
    const entry = buildSignedEntry(master.secretKey, { capabilities: ['move-task', 'send-user-message'] });
    const set = rosterDeviceCapabilitySet(entry);
    expect(set.has('move-task')).toBe(true);
    expect(set.has('read-diff')).toBe(false);
  });

  it('findRosterDevice locates an entry by deviceId', () => {
    const master = generateEd25519KeyPair();
    const entry = buildSignedEntry(master.secretKey, { deviceId: 'phone-a' });
    const roster: DeviceRoster = { masterSigningPublicKey: master.publicKey, devices: [entry] };
    expect(findRosterDevice(roster, 'phone-a')).toBe(entry);
    expect(findRosterDevice(roster, 'phone-b')).toBeUndefined();
  });

  it('isRosterEntryExpired reflects expiresAt', () => {
    const master = generateEd25519KeyPair();
    const noExpiry = buildSignedEntry(master.secretKey, { expiresAt: null });
    const expired = buildSignedEntry(master.secretKey, { expiresAt: '2020-01-01T00:00:00.000Z' });
    const future = buildSignedEntry(master.secretKey, { expiresAt: '2099-01-01T00:00:00.000Z' });

    const now = new Date('2026-07-10T00:00:00.000Z');
    expect(isRosterEntryExpired(noExpiry, now)).toBe(false);
    expect(isRosterEntryExpired(expired, now)).toBe(true);
    expect(isRosterEntryExpired(future, now)).toBe(false);
  });
});
