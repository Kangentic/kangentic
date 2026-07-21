/**
 * Unit tests for src/main/mobile-bridge/push/push-registration-store.ts
 *
 * The sidecar must round-trip registrations, tolerate a missing or
 * corrupt file (degrading to empty instead of throwing into the
 * notifier's send path), drop malformed entries on load, and make
 * remove() a write-free no-op for an absent device (revocation calls it
 * unconditionally). The revoke hookup itself (MobileBridgeService
 * clearing the registration) is covered in mobile-bridge-service.test.ts.
 *
 * Mocking mirrors roster-store.test.ts: node:fs is mocked so no real
 * file I/O occurs, and PATHS is mocked to a stable fake configDir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());
const writeFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, data: string) => void>());
const mkdirSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncSpy,
      readFileSync: readFileSyncSpy,
      writeFileSync: writeFileSyncSpy,
      mkdirSync: mkdirSyncSpy,
    },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: mkdirSyncSpy,
  };
});

vi.mock('../../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

import { PushRegistrationStore, type PushRegistration } from '../../../src/main/mobile-bridge/push/push-registration-store';

function registrationFixture(overrides: Partial<PushRegistration> = {}): PushRegistration {
  return {
    expoPushToken: 'ExponentPushToken[abc]',
    pushKeyHex: 'ab'.repeat(32),
    platform: 'android',
    registeredAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  existsSyncSpy.mockReset().mockReturnValue(false);
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
});

describe('PushRegistrationStore', () => {
  it('loads empty when the sidecar does not exist', () => {
    const store = new PushRegistrationStore();
    expect(store.list()).toEqual([]);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('upsert persists and list returns the device-keyed entries', () => {
    const store = new PushRegistrationStore();
    const registration = registrationFixture();
    store.upsert('device-1', registration);

    expect(store.list()).toEqual([{ deviceId: 'device-1', ...registration }]);
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const [filePath, written] = writeFileSyncSpy.mock.calls[0];
    expect(String(filePath)).toContain('mobile-push-registrations.json');
    expect(JSON.parse(written)).toEqual({ 'device-1': registration });
  });

  it('upsert replaces an existing registration for the same device', () => {
    const store = new PushRegistrationStore();
    store.upsert('device-1', registrationFixture());
    store.upsert('device-1', registrationFixture({ expoPushToken: 'ExponentPushToken[new]' }));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].expoPushToken).toBe('ExponentPushToken[new]');
  });

  it('remove deletes and persists; removing an absent device never writes', () => {
    const store = new PushRegistrationStore();
    store.upsert('device-1', registrationFixture());
    writeFileSyncSpy.mockClear();

    store.remove('device-1');
    expect(store.list()).toEqual([]);
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);

    writeFileSyncSpy.mockClear();
    store.remove('device-ghost');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('loads a persisted sidecar back', () => {
    const registration = registrationFixture();
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ 'device-1': registration }));
    const store = new PushRegistrationStore();
    expect(store.list()).toEqual([{ deviceId: 'device-1', ...registration }]);
  });

  it('tolerates a corrupt file (loads empty instead of throwing)', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('{not json');
    const store = new PushRegistrationStore();
    expect(store.list()).toEqual([]);
  });

  it('drops malformed entries on load and keeps the valid ones', () => {
    const valid = registrationFixture();
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        'device-good': valid,
        'device-no-token': { pushKeyHex: 'ab'.repeat(32), platform: 'android', registeredAt: 'x' },
        'device-bad-key': { ...valid, pushKeyHex: 'not-hex' },
        'device-bad-platform': { ...valid, platform: 'windows' },
        'device-bad-categories': { ...valid, categories: ['turn-complete', 'not-a-real-category'] },
        'device-not-object': 'nope',
      }),
    );
    const store = new PushRegistrationStore();
    expect(store.list()).toEqual([{ deviceId: 'device-good', ...valid }]);
  });

  it('round-trips a registration with categories, and one without', () => {
    const store = new PushRegistrationStore();
    store.upsert('device-1', registrationFixture({ categories: ['turn-complete', 'session-failed'] }));
    store.upsert('device-2', registrationFixture());
    expect(store.list().find((entry) => entry.deviceId === 'device-1')?.categories).toEqual(['turn-complete', 'session-failed']);
    expect(store.list().find((entry) => entry.deviceId === 'device-2')?.categories).toBeUndefined();
  });
});
