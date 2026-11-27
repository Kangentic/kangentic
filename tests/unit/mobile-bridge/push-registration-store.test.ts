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
 * file I/O occurs, and PATHS is mocked to a stable fake configDir. The
 * corrupt-file describe at the bottom passes the spies through to the real
 * fs over a temporary folder, because what it proves is what is on disk.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());
const writeFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, data: string) => void>());
const mkdirSyncSpy = vi.hoisted(() => vi.fn());
const renameSyncSpy = vi.hoisted(() => vi.fn<(fromPath: string, toPath: string) => void>());
const pathsState = vi.hoisted(() => ({ configDir: '/mock/config' }));
const reportHandledError = vi.hoisted(() => vi.fn());

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
      renameSync: renameSyncSpy,
    },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: mkdirSyncSpy,
    renameSync: renameSyncSpy,
  };
});

vi.mock('../../../src/main/config/paths', () => ({
  PATHS: {
    get configDir() {
      return pathsState.configDir;
    },
  },
}));

vi.mock('../../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

import { PushRegistrationStore, type PushRegistration } from '../../../src/main/mobile-bridge/push/push-registration-store';
import { mobileBridgeReporter } from '../../../src/main/mobile-bridge/mobile-bridge-report';

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
  pathsState.configDir = '/mock/config';
  existsSyncSpy.mockReset().mockReturnValue(false);
  // No file, as on first run: the read throws ENOENT.
  readFileSyncSpy.mockReset().mockImplementation(() => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT', syscall: 'open' });
  });
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  renameSyncSpy.mockReset();
  reportHandledError.mockReset();
  mobileBridgeReporter.reset();
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
        'device-bad-accepts-clears': { ...valid, acceptsClears: 'yes' },
        'device-not-object': 'nope',
      }),
    );
    const store = new PushRegistrationStore();
    expect(store.list()).toEqual([{ deviceId: 'device-good', ...valid }]);
  });

  it('loads a stored acceptsClears opt-in, and leaves it absent for a registration that never set it', () => {
    const optedIn = registrationFixture({ acceptsClears: true });
    const older = registrationFixture();
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ 'device-new': optedIn, 'device-old': older }));
    const store = new PushRegistrationStore();
    expect(store.list().find((entry) => entry.deviceId === 'device-new')?.acceptsClears).toBe(true);
    expect(store.list().find((entry) => entry.deviceId === 'device-old')).not.toHaveProperty('acceptsClears');
  });

  it('round-trips a registration with categories, and one without', () => {
    const store = new PushRegistrationStore();
    store.upsert('device-1', registrationFixture({ categories: ['turn-complete', 'session-failed'] }));
    store.upsert('device-2', registrationFixture());
    expect(store.list().find((entry) => entry.deviceId === 'device-1')?.categories).toEqual(['turn-complete', 'session-failed']);
    expect(store.list().find((entry) => entry.deviceId === 'device-2')?.categories).toBeUndefined();
  });
});

// Sentry DESKTOP-5H: a file that would not parse was kept, the empty map became
// the mirror, and every push was dropped until the phone happened to register
// again. The file is now set aside, so the next registration writes a clean one.
describe('PushRegistrationStore with a corrupt file on disk', () => {
  let configDir = '';
  let registrationsFile = '';

  beforeEach(() => {
    configDir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-push-registrations-'));
    pathsState.configDir = configDir;
    registrationsFile = path.join(configDir, 'mobile-push-registrations.json');
    existsSyncSpy.mockImplementation(actualFs.existsSync);
    readFileSyncSpy.mockImplementation(((filePath: string, encoding: BufferEncoding) => actualFs.readFileSync(filePath, encoding)));
    writeFileSyncSpy.mockImplementation(actualFs.writeFileSync as (filePath: string, data: string) => void);
    mkdirSyncSpy.mockImplementation(actualFs.mkdirSync);
    renameSyncSpy.mockImplementation(actualFs.renameSync);
  });

  afterEach(() => {
    actualFs.rmSync(configDir, { recursive: true, force: true });
  });

  /** The tags of the one report that was sent. */
  function onlyReport(): { tags: Record<string, string>; fingerprint: unknown } {
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [, tags, , fingerprint] = reportHandledError.mock.calls[0];
    return { tags: tags as Record<string, string>, fingerprint };
  }

  const corruptSeeds: Array<{ loadCause: string; content: string }> = [
    { loadCause: 'empty', content: '' },
    { loadCause: 'empty', content: '  \n' },
    { loadCause: 'nul_filled', content: '\0'.repeat(64) },
    { loadCause: 'truncated', content: '{"device-1": {"expoPushToken": "Expo' },
    { loadCause: 'truncated', content: '[{"device-1": ' },
    { loadCause: 'invalid', content: '[]' },
    { loadCause: 'invalid', content: 'null' },
    { loadCause: 'invalid', content: '42' },
  ];

  it.each(corruptSeeds)('sets a $loadCause file aside, reports why, and the next registration writes a clean file', ({ loadCause, content }) => {
    actualFs.writeFileSync(registrationsFile, content);

    const store = new PushRegistrationStore();
    expect(store.list()).toEqual([]);

    expect(actualFs.existsSync(registrationsFile)).toBe(false);
    expect(actualFs.readFileSync(`${registrationsFile}.corrupt`, 'utf8')).toBe(content);
    const { tags, fingerprint } = onlyReport();
    expect(tags).toMatchObject({
      source: 'mobile_bridge',
      stage: 'push_registrations_load',
      load_cause: loadCause,
      error_name: 'PushRegistrationsCorruptError',
    });
    expect(fingerprint).toEqual(['handled-env', 'PushRegistrationsCorruptError', loadCause]);

    const registration = registrationFixture();
    store.upsert('device-1', registration);
    expect(JSON.parse(actualFs.readFileSync(registrationsFile, 'utf8'))).toEqual({ 'device-1': registration });

    reportHandledError.mockClear();
    expect(new PushRegistrationStore().list()).toEqual([{ deviceId: 'device-1', ...registration }]);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('carries the parse error as the cause of a file that will not parse, and no cause for a non-object value', () => {
    actualFs.writeFileSync(registrationsFile, '{"device-1": ');
    new PushRegistrationStore().list();
    const parseFailure = onlyReport();
    expect(parseFailure.tags.error_name).toBe('PushRegistrationsCorruptError');
    expect(parseFailure.tags.cause_name).toBe('SyntaxError');

    reportHandledError.mockClear();
    actualFs.rmSync(`${registrationsFile}.corrupt`, { force: true });
    actualFs.writeFileSync(registrationsFile, 'null');
    new PushRegistrationStore().list();
    const nonObject = onlyReport();
    expect(nonObject.tags.error_name).toBe('PushRegistrationsCorruptError');
    expect(nonObject.tags.cause_name).toBeUndefined();
  });

  it('replaces an earlier .corrupt copy with the newer corrupt file', () => {
    actualFs.writeFileSync(`${registrationsFile}.corrupt`, 'old corrupt content');
    actualFs.writeFileSync(registrationsFile, '{"newer": ');

    expect(new PushRegistrationStore().list()).toEqual([]);

    expect(actualFs.readFileSync(`${registrationsFile}.corrupt`, 'utf8')).toBe('{"newer": ');
    expect(actualFs.existsSync(registrationsFile)).toBe(false);
    expect(onlyReport().tags.load_cause).toBe('truncated');
  });

  it('still loads empty, reports once and recovers on the next write when the set-aside rename fails', () => {
    const corruptContent = '{"device-1": ';
    actualFs.writeFileSync(registrationsFile, corruptContent);
    renameSyncSpy.mockImplementation((fromPath: string, toPath: string) => {
      if (String(toPath).endsWith('.corrupt')) {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY', syscall: 'rename' });
      }
      actualFs.renameSync(fromPath, toPath);
    });

    const store = new PushRegistrationStore();
    expect(() => store.list()).not.toThrow();
    expect(store.list()).toEqual([]);

    const { tags, fingerprint } = onlyReport();
    expect(tags).toMatchObject({ stage: 'push_registrations_load', load_cause: 'truncated' });
    expect(fingerprint).toEqual(['handled-env', 'PushRegistrationsCorruptError', 'truncated']);
    expect(actualFs.readFileSync(registrationsFile, 'utf8')).toBe(corruptContent);
    expect(actualFs.existsSync(`${registrationsFile}.corrupt`)).toBe(false);

    const registration = registrationFixture();
    store.upsert('device-1', registration);
    expect(JSON.parse(actualFs.readFileSync(registrationsFile, 'utf8'))).toEqual({ 'device-1': registration });
    expect(new PushRegistrationStore().list()).toEqual([{ deviceId: 'device-1', ...registration }]);
  });

  it('says whether it holds a device, and says it does not know while the file will not read', () => {
    const store = new PushRegistrationStore();
    store.upsert('device-1', registrationFixture());
    expect(store.registrationState('device-1')).toBe('registered');
    expect(store.registrationState('device-2')).toBe('absent');

    readFileSyncSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', syscall: 'open' });
    });
    const lockedStore = new PushRegistrationStore();
    expect(lockedStore.registrationState('device-2')).toBe('unknown');
    // A file that is there and could not be read may be whole, so it is never set aside.
    expect(actualFs.existsSync(registrationsFile)).toBe(true);
    expect(lockedStore.registrationState('device-1')).toBe('registered');
  });
});
