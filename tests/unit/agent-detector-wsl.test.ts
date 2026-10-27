/**
 * Detection of a CLI installed inside a WSL distro (#286). Windows can neither
 * run the Linux binary nor follow the distro's symlinks, so a configured
 * `\\wsl.localhost\...` path is probed inside the distro, on the PATH its
 * interactive shell gives the user, and a failure carries the distro's own
 * error. The platform, the distro facts and wsl.exe are injected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('which', () => ({ default: vi.fn() }));
vi.mock('../../src/main/agent/shared/exec-version', () => ({ execVersion: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(false) } };
});

import { AgentDetector, type AgentDetectorConfig, type AgentDetectorDependencies } from '../../src/main/agent/shared/agent-detector';
import { execVersion } from '../../src/main/agent/shared/exec-version';
import type { WslDistroFacts } from '../../src/main/agent/shared/wsl-distro';

const FACTS: WslDistroFacts = {
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/home/dev/.nvm/versions/node/v24.22.1/bin:/usr/bin',
  env: {},
  networkingMode: 'nat',
};
const CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';

function makeDetector(supportsWslCli: boolean, dependencies: AgentDetectorDependencies): AgentDetector {
  return new AgentDetector(
    { binaryName: 'claude', supportsWslCli, parseVersion: (raw) => raw.replace(/\s*\(Claude Code\)\s*$/, '').trim() || null },
    { platform: 'win32', resolveFacts: async () => FACTS, ...dependencies },
  );
}

describe('AgentDetector - a CLI inside a WSL distro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('probes --version inside the distro on the interactive PATH and reports the distro', async () => {
    const runWsl = vi.fn(async () => ({ stdout: '2.1.311 (Claude Code)\n', stderr: '' }));
    const result = await makeDetector(true, { runWsl }).detect(CLI_PATH);

    expect(result).toEqual({ found: true, path: CLI_PATH, version: '2.1.311', cliTarget: { kind: 'wsl', distro: 'Ubuntu' } });
    const [file, args] = runWsl.mock.calls[0] as unknown as [string, string[]];
    expect(file.toLowerCase().endsWith('wsl.exe')).toBe(true);
    expect(args).toEqual(['-d', 'Ubuntu', '-e', 'env', `PATH=${FACTS.interactivePath}`, '/home/dev/.local/bin/claude', '--version']);
    // Neither Windows-side check runs: it cannot see the distro's symlinked CLI.
    expect(execVersion).not.toHaveBeenCalled();
  });

  it('carries the error the distro printed when the CLI cannot start', async () => {
    const runWsl = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { code: 127, stderr: "/usr/bin/env: 'node': No such file or directory\n" });
    });
    const result = await makeDetector(true, { runWsl }).detect('\\\\wsl.localhost\\Ubuntu\\home\\dev\\bin\\codex');

    expect(result).toMatchObject({
      found: false,
      cliTarget: { kind: 'wsl', distro: 'Ubuntu' },
      detectionError: "/usr/bin/env: 'node': No such file or directory",
    });
  });

  it('carries the distro error when its facts cannot be read', async () => {
    const runWsl = vi.fn();
    const result = await makeDetector(true, {
      runWsl,
      resolveFacts: async () => { throw new Error('There is no distribution with the supplied name.'); },
    }).detect(CLI_PATH);

    expect(result).toMatchObject({ found: false, detectionError: 'There is no distribution with the supplied name.' });
    expect(runWsl).not.toHaveBeenCalled();
  });

  // Awaited one after another on purpose: concurrent calls share one in-flight
  // detection, which would run wsl.exe once with or without a cache.
  it('does not cache a failed facts read, so the next detection reads the distro again', async () => {
    const runWsl = vi.fn(async () => ({ stdout: '2.1.311 (Claude Code)\n', stderr: '' }));
    const resolveFacts = vi.fn<(distro: string) => Promise<WslDistroFacts>>()
      .mockRejectedValueOnce(new Error('There is no distribution with the supplied name.'))
      .mockResolvedValue(FACTS);
    const detector = makeDetector(true, { runWsl, resolveFacts });

    const failed = await detector.detect(CLI_PATH);
    expect(failed).toMatchObject({ found: false, path: CLI_PATH, detectionError: 'There is no distribution with the supplied name.' });
    expect(resolveFacts).toHaveBeenCalledTimes(1);
    expect(runWsl).not.toHaveBeenCalled();
    expect(detector.getCachedVersion(CLI_PATH)).toBeNull();

    const recovered = await detector.detect(CLI_PATH);
    expect(resolveFacts).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual({ found: true, path: CLI_PATH, version: '2.1.311', cliTarget: { kind: 'wsl', distro: 'Ubuntu' } });
    expect(runWsl).toHaveBeenCalledTimes(1);
  });

  it('carries a facts read that rejected with something other than an Error as its text', async () => {
    const result = await makeDetector(true, {
      runWsl: vi.fn(),
      resolveFacts: async () => { throw 'the distro is still booting'; },
    }).detect(CLI_PATH);

    expect(result).toMatchObject({ found: false, detectionError: 'the distro is still booting' });
  });

  it('caches a successful detection, so a repeat does not run wsl.exe again', async () => {
    const runWsl = vi.fn(async () => ({ stdout: '2.1.311 (Claude Code)\n', stderr: '' }));
    const resolveFacts = vi.fn(async () => FACTS);
    const detector = makeDetector(true, { runWsl, resolveFacts });

    const first = await detector.detect(CLI_PATH);
    const second = await detector.detect(CLI_PATH);

    expect(first.found).toBe(true);
    expect(second).toBe(first);
    expect(runWsl).toHaveBeenCalledTimes(1);
    expect(resolveFacts).toHaveBeenCalledTimes(1);
    expect(detector.getCachedVersion(CLI_PATH)).toBe('2.1.311');
  });

  describe('a CLI that prints its version some other way, and output that is not a version', () => {
    const OZ_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\oz';
    // Rejects anything that does not open with a dotted version, unlike the
    // permissive parser makeDetector gives.
    const semverOnly: AgentDetectorConfig['parseVersion'] = (raw) => /^\d+\.\d+\.\d+/.exec(raw)?.[0] ?? null;

    function makeStrictDetector(runWsl: AgentDetectorDependencies['runWsl'], versionArgs?: readonly string[]): AgentDetector {
      return new AgentDetector(
        { binaryName: 'oz', supportsWslCli: true, parseVersion: semverOnly, ...(versionArgs ? { versionArgs } : {}) },
        { platform: 'win32', resolveFacts: async () => FACTS, runWsl },
      );
    }

    it('runs the config\'s versionArgs in the distro in place of --version', async () => {
      const runWsl = vi.fn(async () => ({ stdout: '0.4.2\n', stderr: '' }));
      const result = await makeStrictDetector(runWsl, ['dump-debug-info']).detect(OZ_PATH);

      expect(result).toMatchObject({ found: true, version: '0.4.2' });
      const [, args] = runWsl.mock.calls[0] as unknown as [string, string[]];
      expect(args).toEqual(['-d', 'Ubuntu', '-e', 'env', `PATH=${FACTS.interactivePath}`, '/home/dev/.local/bin/oz', 'dump-debug-info']);
      expect(args).not.toContain('--version');
    });

    it('asks for --version when the config names no versionArgs', async () => {
      const runWsl = vi.fn(async () => ({ stdout: '0.4.2\n', stderr: '' }));
      await makeStrictDetector(runWsl).detect(OZ_PATH);

      const [, args] = runWsl.mock.calls[0] as unknown as [string, string[]];
      expect(args.slice(-2)).toEqual(['/home/dev/.local/bin/oz', '--version']);
    });

    it('reports empty output when the CLI prints nothing on either stream', async () => {
      const runWsl = vi.fn(async () => ({ stdout: '  \n', stderr: '' }));
      const result = await makeStrictDetector(runWsl).detect(OZ_PATH);

      expect(result).toEqual({ found: false, path: OZ_PATH, version: null, cliTarget: { kind: 'wsl', distro: 'Ubuntu' }, detectionError: 'empty output' });
    });

    it('reports the first line of output the parser rejects, not all of it', async () => {
      const runWsl = vi.fn(async () => ({ stdout: 'Usage: oz [options]\r\nRun oz --help for the full list\r\n', stderr: '' }));
      const result = await makeStrictDetector(runWsl).detect(OZ_PATH);

      expect(result).toEqual({ found: false, path: OZ_PATH, version: null, cliTarget: { kind: 'wsl', distro: 'Ubuntu' }, detectionError: 'Usage: oz [options]' });
    });

    it('reads stderr when stdout is empty, and reports its first line when that is rejected too', async () => {
      const accepted = await makeStrictDetector(vi.fn(async () => ({ stdout: '', stderr: '0.4.2\n' }))).detect(OZ_PATH);
      expect(accepted).toMatchObject({ found: true, version: '0.4.2' });

      const rejected = await makeStrictDetector(vi.fn(async () => ({ stdout: '', stderr: 'error: unknown option\nsecond line\n' }))).detect(OZ_PATH);
      expect(rejected).toMatchObject({ found: false, version: null, detectionError: 'error: unknown option' });
    });
  });

  it('reports the path unsupported for an adapter that does not run from WSL, probing nothing', async () => {
    const runWsl = vi.fn();
    const result = await makeDetector(false, { runWsl }).detect(CLI_PATH);

    expect(result).toEqual({ found: false, path: CLI_PATH, version: null, cliTarget: { kind: 'wsl', distro: 'Ubuntu' }, unsupportedTarget: true });
    expect(runWsl).not.toHaveBeenCalled();
    expect(execVersion).not.toHaveBeenCalled();
  });

  it('treats the same string as an ordinary path off Windows', async () => {
    const runWsl = vi.fn();
    const detector = new AgentDetector(
      { binaryName: 'claude', supportsWslCli: true, parseVersion: (raw) => raw || null },
      { platform: 'linux', resolveFacts: async () => FACTS, runWsl },
    );
    const result = await detector.detect(CLI_PATH);

    expect(result).toMatchObject({ found: false, path: CLI_PATH, detectionError: 'the file does not exist on disk' });
    expect(result.cliTarget).toBeUndefined();
    expect(runWsl).not.toHaveBeenCalled();
  });
});
