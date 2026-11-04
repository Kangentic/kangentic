/**
 * Capability discovery for OpenCode: parses `opencode --help` for `--model`
 * support. OpenCode has no session-history scan (the storage layout is
 * embedded in opencode-server and not stable enough to parse from disk).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

// Real target resolution and execution by default; the WSL test overrides both
// once, so the distro branch is reached without a distro on the machine.
vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...actual,
    resolveCliTarget: vi.fn(actual.resolveCliTarget),
    execCliForTarget: vi.fn(actual.execCliForTarget),
  };
});

import { execFile, exec } from 'node:child_process';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { discoverOpenCodeCapabilities, discoverOpenCodeModels, parseOpenCodeModels } from '../../src/main/agent/adapters/opencode/capability-discovery';

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

/**
 * `opencode models --verbose` at v1.18.31 (`packages/opencode/src/cli/cmd/models.ts`):
 * each `<providerID>/<modelID>` line is followed by that model's
 * `JSON.stringify(model, null, 2)`. Built from the source; trimmed to the fields
 * the parser reads plus a nested object, which is what makes the block end hard
 * to find.
 */
const VERBOSE_MODELS = [
  'opencode/big-pickle',
  '{',
  '  "id": "big-pickle",',
  '  "providerID": "opencode",',
  '  "name": "Big Pickle",',
  '  "limit": {',
  '    "context": 200000,',
  '    "output": 128000',
  '  }',
  '}',
  'anthropic/claude-sonnet-4-5',
  '{',
  '  "id": "claude-sonnet-4-5",',
  '  "name": "Claude Sonnet 4.5",',
  '  "cost": {',
  '    "input": 3,',
  '    "cache": { "read": 0.3, "write": 3.75 }',
  '  }',
  '}',
  'openrouter/anthropic/claude-sonnet-4.5',
  '{',
  '  "id": "anthropic/claude-sonnet-4.5",',
  '  "name": "Claude Sonnet 4.5"',
  '}',
  '',
].join('\r\n');

describe('parseOpenCodeModels', () => {
  it('lists each provider/model id in the CLI\'s order, named by its own name field', () => {
    expect(parseOpenCodeModels(VERBOSE_MODELS)).toEqual({
      models: ['opencode/big-pickle', 'anthropic/claude-sonnet-4-5', 'openrouter/anthropic/claude-sonnet-4.5'],
      displayNames: {
        'opencode/big-pickle': 'Big Pickle',
        // Two providers serve one name, so each says whose it is.
        'anthropic/claude-sonnet-4-5': 'Claude Sonnet 4.5 (anthropic)',
        'openrouter/anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5 (openrouter)',
      },
    });
  });

  it('reads the plain listing, and skips the refresh notice', () => {
    expect(parseOpenCodeModels('Models cache refreshed\nanthropic/claude-sonnet-4-5\nopenai/gpt-5\n')).toEqual({
      models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'],
      displayNames: {},
    });
  });

  it('leaves a model unnamed when its block does not parse, and still reads the next', () => {
    const output = ['a/one', '{', '  "name": broken', '}', 'b/two', '{', '  "name": "Two"', '}'].join('\n');
    expect(parseOpenCodeModels(output)).toEqual({ models: ['a/one', 'b/two'], displayNames: { 'b/two': 'Two' } });
  });

  it('reads the verbatim output of OpenCode 1.18.31 models --verbose', () => {
    const capture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'opencode-models-verbose.txt'), 'utf-8');
    expect(parseOpenCodeModels(capture)).toEqual({
      models: ['opencode/beam-free', 'opencode/big-pickle'],
      displayNames: { 'opencode/beam-free': 'Beam Free', 'opencode/big-pickle': 'Big Pickle' },
    });
  });

  it('lists a duplicated id line once', () => {
    const output = ['a/one', '{', '  "name": "One"', '}', 'a/one', '{', '  "name": "One"', '}', 'b/two'].join('\n');
    expect(parseOpenCodeModels(output)).toEqual({ models: ['a/one', 'b/two'], displayNames: { 'a/one': 'One' } });
  });

  it('lists nothing for empty output', () => {
    expect(parseOpenCodeModels('')).toEqual({ models: [], displayNames: {} });
  });
});

describe('discoverOpenCodeModels', () => {
  it('runs `models --verbose` and parses it', async () => {
    setHelpOutput(VERBOSE_MODELS);
    const inventory = await discoverOpenCodeModels('/usr/bin/opencode');
    expect(inventory?.models).toHaveLength(3);
    const call = process.platform === 'win32' ? execMock.mock.calls[0][0] : execFileMock.mock.calls[0][1];
    expect(String(call)).toContain('models');
    expect(String(call)).toContain('--verbose');
  });

  it('runs `models --verbose` inside the distro for a CLI in a WSL distro, and parses its output', async () => {
    const target: CliTarget = {
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxCliPath: '/home/dev/.local/bin/opencode',
      facts: {
        distro: 'Ubuntu',
        homeLinux: '/home/dev',
        homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
        uncRoot: '\\\\wsl.localhost\\Ubuntu',
        interactivePath: '/usr/bin',
        env: {},
        networkingMode: 'unknown',
      },
    };
    vi.mocked(resolveCliTarget).mockResolvedValueOnce(target);
    vi.mocked(execCliForTarget).mockResolvedValueOnce({ stdout: VERBOSE_MODELS, stderr: '' });
    const inventory = await discoverOpenCodeModels('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\opencode');
    expect(vi.mocked(execCliForTarget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execCliForTarget).mock.calls[0][0]).toBe(target);
    expect(vi.mocked(execCliForTarget).mock.calls[0][1]).toEqual(['models', '--verbose']);
    expect(inventory?.models).toEqual(['opencode/big-pickle', 'anthropic/claude-sonnet-4-5', 'openrouter/anthropic/claude-sonnet-4.5']);
    // The local exec paths are not taken for a distro CLI.
    expect(execMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('answers null when the run fails or lists nothing, which keeps the free-form input', async () => {
    setHelpOutput('');
    expect(await discoverOpenCodeModels('/usr/bin/opencode')).toBeNull();
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('timeout')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);
    expect(await discoverOpenCodeModels('/usr/bin/opencode')).toBeNull();
  });
});
