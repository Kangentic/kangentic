/**
 * The OS machine id read behind the analytics client id
 * (src/main/analytics/machine-id.ts).
 *
 * It replaced the node-machine-id package, which starts its command from the
 * thread that calls it. An existing install's client id is derived from this
 * value, so a parse that drifts from the package's gives every user a new id
 * and splits their history in two. Each case below is real command output in
 * the shape the OS prints it, with the id the package derived from that shape.
 * The two reads were compared once on a Windows machine before the package was
 * removed, and matched.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock('../../src/main/utility-process/off-main-exec', () => ({
  execFileAsync: mocks.execFileAsync,
}));

import {
  linuxMachineIdSource,
  parseMacPlatformUuid,
  parseWindowsMachineGuid,
  readHashedMachineId,
} from '../../src/main/analytics/machine-id';

const REG_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
  '    MachineGuid    REG_SZ    1A2B3C4D-0000-4000-8000-ABCDEF012345',
  '',
  '',
].join('\r\n');

const IOREG_OUTPUT = [
  '+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>',
  '  +-o J314sAP  <class IOPlatformExpertDevice, id 0x100000110, registered, matched, active>',
  '      {',
  '        "IOPlatformSerialNumber" = "C02ABCDEFGH1"',
  '        "IOPlatformUUID" = "ABCDEF01-2345-4678-9ABC-DEF012345678"',
  '        "manufacturer" = <"Apple Inc.">',
  '      }',
  '',
].join('\n');

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

beforeEach(() => {
  mocks.execFileAsync.mockReset();
});

describe('parseWindowsMachineGuid', () => {
  it('takes the value after REG_SZ, lowercased with no whitespace', () => {
    expect(parseWindowsMachineGuid(REG_OUTPUT)).toBe('1a2b3c4d-0000-4000-8000-abcdef012345');
  });

  it('refuses output with no value in it', () => {
    expect(() => parseWindowsMachineGuid('ERROR: The system was unable to find the specified registry key or value.')).toThrow();
  });
});

describe('parseMacPlatformUuid', () => {
  it('takes the rest of the IOPlatformUUID line, lowercased with no quotes', () => {
    expect(parseMacPlatformUuid(IOREG_OUTPUT)).toBe('abcdef01-2345-4678-9abc-def012345678');
  });

  it('refuses output with no UUID in it', () => {
    expect(() => parseMacPlatformUuid('+-o Root  <class IORegistryEntry>')).toThrow();
  });
});

describe('linuxMachineIdSource', () => {
  it('reads the first file when both are there', () => {
    expect(linuxMachineIdSource(['0123ABCdef\n', '9999\n'], 'build-host')).toBe('0123abcdef');
  });

  it('reads the second file when the first is missing', () => {
    expect(linuxMachineIdSource([null, 'ABCdef\n'], 'build-host')).toBe('abcdef');
  });

  it('reads past an empty first file, as cat prints nothing for it', () => {
    expect(linuxMachineIdSource(['', 'second\n'], 'build-host')).toBe('second');
  });

  it('falls back to the host name when neither file can be read', () => {
    expect(linuxMachineIdSource([null, null], 'Build-Host')).toBe('build-host');
  });

  it('joins a file with no trailing newline to what cat printed next', () => {
    expect(linuxMachineIdSource(['abc', 'def\n'], 'build-host')).toBe('abcdef');
    expect(linuxMachineIdSource(['abc', null], 'build-host')).toBe('abcbuild-host');
  });
});

describe('readHashedMachineId', () => {
  it('asks the registry on Windows and hashes the GUID', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: REG_OUTPUT, stderr: '' });

    const hashed = await readHashedMachineId(3000, 'win32');

    expect(hashed).toBe(sha256('1a2b3c4d-0000-4000-8000-abcdef012345'));
    const [file, args, options] = mocks.execFileAsync.mock.calls[0] as [string, string[], { timeout: number }];
    expect(file.toLowerCase().endsWith('reg.exe')).toBe(true);
    expect(args).toEqual(['QUERY', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    expect(options.timeout).toBe(3000);
  });

  it('asks ioreg on macOS and hashes the UUID', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: IOREG_OUTPUT, stderr: '' });

    const hashed = await readHashedMachineId(3000, 'darwin');

    expect(hashed).toBe(sha256('abcdef01-2345-4678-9abc-def012345678'));
    expect(mocks.execFileAsync.mock.calls[0].slice(0, 2)).toEqual(['ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']]);
  });

  it('starts no process on Linux', async () => {
    const hashed = await readHashedMachineId(3000, 'linux');

    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it('rejects when the command fails, so the caller falls back to a random id', async () => {
    mocks.execFileAsync.mockRejectedValue(new Error('spawn reg.exe ENOENT'));

    await expect(readHashedMachineId(3000, 'win32')).rejects.toThrow('ENOENT');
  });

  it('rejects on a platform it has no source for', async () => {
    await expect(readHashedMachineId(3000, 'aix')).rejects.toThrow('Unsupported platform');
  });
});
