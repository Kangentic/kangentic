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

import { AgentDetector, type AgentDetectorDependencies } from '../../src/main/agent/shared/agent-detector';
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
