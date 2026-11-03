/**
 * The host installer (#913): what it asks a host, what it refuses, and the order it does things in.
 * The runner is faked, so this is the installer's own logic. The real thing over ssh into a real host
 * is the rig's (scripts/ssh-link-rig.mjs).
 */
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { HostInstallError, installHost, type HostAsset } from '../../src/main/remote/link/host-installer';
import type { SshRunResult, SshRunOptions } from '../../src/main/remote/link/ssh-run';

const SHA = 'a'.repeat(64);
const ASSET: HostAsset = { version: '0.52.0', sha256: SHA, arch: 'x64', filePath: '/mock/kangentic-host-0.52.0-linux-x64.tar.gz' };

const ok = (stdout = '', stderr = ''): SshRunResult => ({ code: 0, stdout, stderr });

interface FakeHostOptions {
  probe?: SshRunResult;
  present?: SshRunResult;
  upload?: SshRunResult;
}

function fakeHost(options: FakeHostOptions = {}) {
  const calls: Array<{ command: string; options?: SshRunOptions }> = [];
  const runner = vi.fn(async (command: string, runOptions?: SshRunOptions): Promise<SshRunResult> => {
    calls.push({ command, options: runOptions });
    if (command.includes('cat > "$upload"')) return options.upload ?? ok();
    if (command.includes('uname -s')) return options.probe ?? ok('Linux\nx86_64\n/home/dev\nglibc 2.39\n');
    return options.present ?? ok('');
  });
  return { runner, calls };
}

const stream = (): Readable => Readable.from([Buffer.from('asset bytes')]);

describe('installing the helper', () => {
  it('probes, sends the asset on stdin, and says how to start the relay', async () => {
    const host = fakeHost();
    const assetStream = stream();
    const installed = await installHost(host.runner, ASSET, () => assetStream);

    expect(installed).toEqual({
      directory: '/home/dev/.kangentic/host/0.52.0',
      relayCommand: "'/home/dev/.kangentic/host/0.52.0/node/bin/node' '/home/dev/.kangentic/host/0.52.0/app/host.js' relay --dir '/home/dev/.kangentic/host/run'",
      installed: true,
    });
    expect(host.calls).toHaveLength(3);
    const upload = host.calls[2];
    expect(upload.options?.stdin).toBe(assetStream);
    expect(upload.command).toContain(`expected='${SHA}'`);
    expect(upload.command).toContain("version='0.52.0'");
  });

  it('checks the checksum before it unpacks, and renames only a verified, complete version into place', async () => {
    const host = fakeHost();
    await installHost(host.runner, ASSET, stream);
    const script = host.calls[2].command;
    const order = ['cat > "$upload"', 'sha256sum', 'checksum mismatch', 'tar -xzf', 'chmod 755', 'test -x', '.complete', 'mv "$base/$version.partial" "$base/$version"'];
    const positions = order.map((fragment) => script.indexOf(fragment));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((first, second) => first - second));
  });

  it('does not send the asset again when that version is already complete with the same checksum', async () => {
    const host = fakeHost({ present: ok(`${SHA}\n`) });
    const installed = await installHost(host.runner, ASSET, () => { throw new Error('the asset must not be opened'); });
    expect(installed.installed).toBe(false);
    expect(host.calls).toHaveLength(2);
  });

  it('sends it again when the version on the host has a different checksum', async () => {
    const host = fakeHost({ present: ok(`${'b'.repeat(64)}\n`) });
    expect((await installHost(host.runner, ASSET, stream)).installed).toBe(true);
  });

  it('quotes a home directory that holds a quote', async () => {
    const host = fakeHost({ probe: ok("Linux\nx86_64\n/home/o'brien\nglibc 2.39\n"), present: ok(`${SHA}\n`) });
    const installed = await installHost(host.runner, ASSET, stream);
    expect(installed.relayCommand).toContain("'/home/o'\\''brien/.kangentic/host/0.52.0/node/bin/node'");
  });
});

describe('refusing a host', () => {
  async function refusal(options: FakeHostOptions, asset: HostAsset = ASSET): Promise<HostInstallError> {
    try {
      await installHost(fakeHost(options).runner, asset, stream);
    } catch (error) {
      expect(error).toBeInstanceOf(HostInstallError);
      return error as HostInstallError;
    }
    throw new Error('expected the install to be refused');
  }

  it('refuses a host that is not Linux, saying what it is', async () => {
    const error = await refusal({ probe: ok('Darwin\narm64\n/Users/dev\nnone\n') });
    expect(error.code).toBe('unsupported-os');
    expect(error.message).toContain('Linux host');
    expect(error.message).toContain('Darwin arm64');
  });

  it('refuses a CPU the build does not carry a helper for', async () => {
    const error = await refusal({ probe: ok('Linux\naarch64\n/home/dev\nglibc 2.39\n') });
    expect(error.code).toBe('unsupported-arch');
    expect(error.message).toContain('aarch64');
    expect(error.message).toContain('x86_64');
  });

  it('accepts arm64 when the build carries it', async () => {
    const host = fakeHost({ probe: ok('Linux\naarch64\n/home/dev\nglibc 2.39\n') });
    expect((await installHost(host.runner, { ...ASSET, arch: 'arm64' }, stream)).installed).toBe(true);
  });

  it('refuses musl and a glibc older than 2.28, and accepts 2.28', async () => {
    const musl = await refusal({ probe: ok('Linux\nx86_64\n/home/dev\nnone\n') });
    expect(musl.code).toBe('unsupported-libc');
    expect(musl.message).toContain('musl');
    const old = await refusal({ probe: ok('Linux\nx86_64\n/home/dev\nglibc 2.17\n') });
    expect(old.message).toContain('glibc 2.17');
    const host = fakeHost({ probe: ok('Linux\nx86_64\n/home/dev\nglibc 2.28\n') });
    expect((await installHost(host.runner, ASSET, stream)).installed).toBe(true);
  });

  it('shows ssh\'s own words when the probe cannot run', async () => {
    const error = await refusal({ probe: { code: 255, stdout: '', stderr: 'dev@build-box: Permission denied (publickey).\n' } });
    expect(error.message).toContain('dev@build-box: Permission denied (publickey).');
  });

  it('reports a checksum mismatch as one, with the host\'s numbers', async () => {
    const error = await refusal({ upload: { code: 65, stdout: '', stderr: `checksum mismatch: expected ${SHA}, got ${'c'.repeat(64)}\n` } });
    expect(error.code).toBe('checksum');
    expect(error.message).toContain('c'.repeat(64));
  });

  it('reports any other upload failure with the host\'s stderr', async () => {
    const error = await refusal({ upload: { code: 1, stdout: '', stderr: 'tar: Error is not recoverable\n' } });
    expect(error.code).toBe('failed');
    expect(error.message).toContain('tar: Error is not recoverable');
  });

  it('refuses a version or checksum that could carry shell syntax, before running anything', async () => {
    const host = fakeHost();
    await expect(installHost(host.runner, { ...ASSET, version: "1.0'; rm -rf ~; '" }, stream)).rejects.toBeInstanceOf(HostInstallError);
    await expect(installHost(host.runner, { ...ASSET, sha256: 'not a checksum' }, stream)).rejects.toBeInstanceOf(HostInstallError);
    expect(host.runner).not.toHaveBeenCalled();
  });
});
