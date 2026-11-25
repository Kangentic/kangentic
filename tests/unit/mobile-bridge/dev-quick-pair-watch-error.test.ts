/**
 * DevQuickPair's pairing-directory watch: an 'error' on the handle must not throw in main
 * (Sentry DESKTOP-58 class), must release the dead watcher so the next reconcile arms again,
 * and a late error from an old handle must not release the watcher that replaced it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

type FakeWatchHandle = EventEmitter & { close: ReturnType<typeof vi.fn> };
const createdHandles: FakeWatchHandle[] = [];

vi.mock('node:fs', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  return {
    default: {
      watch: vi.fn(() => {
        const handle = Object.assign(new NodeEventEmitter(), { close: vi.fn() });
        createdHandles.push(handle);
        return handle;
      }),
      // No phone.json, so reconcile never reads the roster.
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    },
  };
});

vi.mock('../../../src/main/safe-write', () => ({ safeWriteJson: vi.fn() }));
vi.mock('../../../src/main/mobile-bridge/roster-store', () => ({
  addOrReplaceDevice: vi.fn(),
  loadRoster: vi.fn(() => ({ devices: [] })),
}));

import fs from 'node:fs';
import { DevQuickPair } from '../../../src/main/mobile-bridge/dev-quick-pair';
import type { BridgeIdentity } from '../../../src/main/mobile-bridge/identity';

function createQuickPair(): DevQuickPair {
  const identity = { staticKeyPair: { publicKey: new Uint8Array(32) } } as unknown as BridgeIdentity;
  return new DevQuickPair({
    getIdentity: () => identity,
    getRelayUrl: () => 'wss://relay.example.test',
    onRosterChanged: vi.fn(),
  });
}

describe('DevQuickPair pairing directory watch error', () => {
  beforeEach(() => {
    createdHandles.length = 0;
    vi.mocked(fs.watch).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes and releases a watch that errors, so the next reconcile arms a new one', () => {
    const quickPair = createQuickPair();
    quickPair.reconcile(true);
    expect(fs.watch).toHaveBeenCalledTimes(1);

    const unknownError = Object.assign(new Error('UNKNOWN: unknown error, watch'), { code: 'UNKNOWN' });
    expect(() => createdHandles[0].emit('error', unknownError)).not.toThrow();
    expect(createdHandles[0].close).toHaveBeenCalledTimes(1);

    quickPair.reconcile(true);
    expect(fs.watch).toHaveBeenCalledTimes(2);
  });

  it('does not release the replacement watcher when the old handle errors late', () => {
    const quickPair = createQuickPair();
    quickPair.reconcile(true);
    createdHandles[0].emit('error', Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }));
    quickPair.reconcile(true);
    expect(fs.watch).toHaveBeenCalledTimes(2);

    expect(() => createdHandles[0].emit('error', Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }))).not.toThrow();
    // The live watcher was not closed by the stale error, and a third reconcile reuses it.
    expect(createdHandles[1].close).not.toHaveBeenCalled();
    quickPair.reconcile(true);
    expect(fs.watch).toHaveBeenCalledTimes(2);
  });
});
