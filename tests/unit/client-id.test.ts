import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  machineId: vi.fn(),
}));

vi.mock('node-machine-id', () => ({
  machineId: mocks.machineId,
}));

import { deriveClientId, resolveClientId } from '../../src/main/analytics/client-id';

describe('deriveClientId', () => {
  it('is deterministic for the same machine id and home dir', () => {
    const first = deriveClientId('machine-a', '/home/alice');
    const second = deriveClientId('machine-a', '/home/alice');
    expect(first).toBe(second);
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(deriveClientId('machine-a', '/home/alice')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across home directories on the same machine (per-user uniqueness)', () => {
    const alice = deriveClientId('machine-a', '/home/alice');
    const bob = deriveClientId('machine-a', '/home/bob');
    expect(alice).not.toBe(bob);
  });

  it('differs across machine ids for the same home dir', () => {
    const onMachineA = deriveClientId('machine-a', '/home/alice');
    const onMachineB = deriveClientId('machine-b', '/home/alice');
    expect(onMachineA).not.toBe(onMachineB);
  });
});

describe('resolveClientId', () => {
  let tempDir: string;
  let cacheFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-id-test-'));
    cacheFilePath = path.join(tempDir, 'analytics-client-id.json');
    mocks.machineId.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('derives from the machine id and caches the result', async () => {
    mocks.machineId.mockResolvedValue('hashed-machine-id');

    const clientId = await resolveClientId('/home/alice', cacheFilePath);

    expect(clientId).toBe(deriveClientId('hashed-machine-id', '/home/alice'));
    expect(JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'))).toEqual({ clientId });
  });

  it('returns the cached id without re-deriving on a second call', async () => {
    mocks.machineId.mockResolvedValue('hashed-machine-id');
    const first = await resolveClientId('/home/alice', cacheFilePath);

    mocks.machineId.mockClear();
    const second = await resolveClientId('/home/alice', cacheFilePath);

    expect(second).toBe(first);
    expect(mocks.machineId).not.toHaveBeenCalled();
  });

  it('falls back to a random id when the machine-id source is unavailable', async () => {
    mocks.machineId.mockRejectedValue(new Error('no machine id source'));

    const clientId = await resolveClientId('/home/alice', cacheFilePath);

    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'))).toEqual({ clientId });
  });
});
