/**
 * Capability discovery for OpenCode: parses `opencode --help` for `--model`
 * support. OpenCode has no session-history scan (the storage layout is
 * embedded in opencode-server and not stable enough to parse from disk).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile, exec } from 'node:child_process';
import { discoverOpenCodeCapabilities } from '../../src/main/agent/adapters/opencode/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
});

describe('discoverOpenCodeCapabilities', () => {
  it('detects --model flag from --help output', async () => {
    setHelpOutput(`
  -m, --model        model to use in the format of provider/model
  -c, --continue     continue the last session
`);
    const capabilities = await discoverOpenCodeCapabilities('/usr/bin/opencode');
    expect(capabilities.supportsModelOverride).toBe(true);
  });

  it('reports no --model when help text omits the flag', async () => {
    setHelpOutput('Usage: opencode\n  -h, --help    Show help\n');
    const capabilities = await discoverOpenCodeCapabilities('/usr/bin/opencode');
    expect(capabilities.supportsModelOverride).toBe(false);
  });

  // OpenCode 2's root help has no `--model`: its TUI takes the model from
  // config, where a V2 spawn puts it. Reading the help alone would hide the
  // model picker for every V2 user.
  it('supports the model override on OpenCode 2, whose help has no --model', async () => {
    setHelpOutput('Usage: opencode [directory]\n  --standalone  Run with a private server\n  --prompt      Prompt to use\n');
    const capabilities = await discoverOpenCodeCapabilities('/usr/bin/opencode', 'v2.2.5');
    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('returns empty effortLevels (OpenCode uses agents, not effort)', async () => {
    setHelpOutput('  -m, --model Model\n');
    const capabilities = await discoverOpenCodeCapabilities('/usr/bin/opencode');
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('defaults supportsModelOverride to false when help invocation throws', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverOpenCodeCapabilities('/missing/opencode');
    expect(capabilities.supportsModelOverride).toBe(false);
  });
});
