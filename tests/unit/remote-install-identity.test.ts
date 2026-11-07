/**
 * `readInstallId`: the stable id a host's helper uses to tell this installation reconnecting from
 * another computer taking over (#913). If it changed every launch, a host holding this install's
 * sessions would refuse the next connection as a different installation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readInstallId } from '../../src/main/remote/install-identity';

const UUID_PATTERN = /^[0-9a-f-]{36}$/;
let configDirectory: string;

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-install-id-'));
});
afterEach(() => {
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

describe('readInstallId', () => {
  it('returns the same id on every call, kept in the config folder', () => {
    const log = vi.fn();
    const first = readInstallId(configDirectory, log);
    const second = readInstallId(configDirectory, log);

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(configDirectory, 'remote-install-id'), 'utf8').trim()).toBe(first);
    expect(log).not.toHaveBeenCalled();
  });

  it('creates the config folder when it does not exist yet', () => {
    const nested = path.join(configDirectory, 'not', 'yet');
    const id = readInstallId(nested, vi.fn());
    expect(fs.readFileSync(path.join(nested, 'remote-install-id'), 'utf8')).toBe(id);
  });

  it('replaces a file with garbage in it by a fresh UUID, and keeps that one from then on', () => {
    const file = path.join(configDirectory, 'remote-install-id');
    fs.writeFileSync(file, 'not-an-id');

    const id = readInstallId(configDirectory, vi.fn());

    expect(id).toMatch(UUID_PATTERN);
    expect(id).not.toBe('not-an-id');
    expect(readInstallId(configDirectory, vi.fn())).toBe(id);
  });

  it('still returns a UUID and says so through log when the id cannot be kept', () => {
    // A directory where the file should be makes the write fail on every OS.
    fs.mkdirSync(path.join(configDirectory, 'remote-install-id'));
    const log = vi.fn();

    const id = readInstallId(configDirectory, log);

    expect(id).toMatch(UUID_PATTERN);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/could not keep the installation id/);
  });

  it.runIf(process.platform !== 'win32')('writes the id file readable by its owner only', () => {
    readInstallId(configDirectory, vi.fn());
    const mode = fs.statSync(path.join(configDirectory, 'remote-install-id')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
