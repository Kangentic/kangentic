/**
 * Aider capability discovery: `--model` read from `aider --help`, no model
 * list and no effort levels (see the module comment for the doc reasons).
 *
 * The help text is a real capture: `aider --help` from Aider 0.86.2, run with
 * `uvx --from aider-chat aider --help` and sanitized of the machine's paths
 * (tests/fixtures/aider-help-0.86.2.txt). No session was started and no model
 * was called. exec and execFile are mocked the way
 * antigravity-adapter.test.ts mocks them, with the real util.promisify around
 * them, so a mock answers through the trailing callback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(), execFile: vi.fn() };
});

// A test can make resolveCliTarget reject (a WSL distro whose facts cannot be
// read); every other test gets the real one.
let resolveCliTargetFailure: Error | null = null;
// A test can also stand in a resolved WSL target, whose help goes through
// execCliForTarget (recorded here) instead of a local exec.
let resolvedCliTargetOverride: object | null = null;
const execCliForTargetCalls: Array<{ target: unknown; cliArguments: string[] }> = [];
vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...original,
    resolveCliTarget: (...resolveArguments: Parameters<typeof original.resolveCliTarget>) => {
      if (resolveCliTargetFailure) return Promise.reject(resolveCliTargetFailure);
      if (resolvedCliTargetOverride) return Promise.resolve(resolvedCliTargetOverride);
      return original.resolveCliTarget(...resolveArguments);
    },
    execCliForTarget: async (target: unknown, cliArguments: string[]) => {
      execCliForTargetCalls.push({ target, cliArguments });
      return { stdout: '  --model MODEL         Specify the model to use for the main chat', stderr: '' };
    },
  };
});

import { exec, execFile } from 'node:child_process';
import {
  discoverAiderCapabilities,
  helpListsModelFlag,
  resetAiderCapabilityCacheForTests,
} from '../../src/main/agent/adapters/aider/capability-discovery';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';

/** `aider --help` as Aider 0.86.2 prints it. */
const AIDER_HELP = fs.readFileSync(path.resolve(__dirname, '../fixtures/aider-help-0.86.2.txt'), 'utf-8');

/**
 * The real help with the `--model MODEL` option and usage lines removed. What
 * is left still names the flag: the flags that start with it (`--models`,
 * `--model-settings-file`, `--model-metadata-file`), and other flags' help
 * that mentions it ("default depends on --model", "deprecated, use --model").
 */
const HELP_WITHOUT_MODEL = AIDER_HELP
  .split('\n')
  .filter((line) => !/--model MODEL\b/.test(line))
  .join('\n');

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

function respondWith(stdout: string): void {
  const respond = (...invocationArguments: unknown[]): void => {
    (invocationArguments[invocationArguments.length - 1] as ExecCallback)(null, { stdout, stderr: '' });
  };
  execMock.mockImplementation(respond);
  execFileMock.mockImplementation(respond);
}

function respondWithFailure(error: Error): void {
  const reject = (...invocationArguments: unknown[]): void => {
    (invocationArguments[invocationArguments.length - 1] as ExecCallback)(error);
  };
  execMock.mockImplementation(reject);
  execFileMock.mockImplementation(reject);
}

function probeCallCount(): number {
  return execMock.mock.calls.length + execFileMock.mock.calls.length;
}

describe('the real Aider 0.86.2 help', () => {
  // Every flag the session builder and the answer run emit, against what the
  // CLI itself prints. A flag Aider drops or renames fails here first.
  const flagsKangenticSends = [
    '--model', '--reasoning-effort', '--chat-history-file', '--restore-chat-history', '--no-restore-chat-history',
    '--message', '--message-file', '--chat-mode', '--architect', '--yes-always', '--no-auto-commits',
    '--no-suggest-shell-commands', '--notifications', '--notifications-command', '--no-git', '--no-pretty',
    '--no-stream', '--no-check-update', '--no-show-model-warnings', '--input-history-file',
  ];

  it.each(flagsKangenticSends)('lists %s', (flag) => {
    const escaped = flag.replace(/[-]/g, '\\-');
    expect(AIDER_HELP).toMatch(new RegExp(`(?:^|[\\s\\[,|])${escaped}(?=[\\s\\],|])`, 'm'));
  });

  it('has no bare --yes flag, only --yes-always', () => {
    expect(AIDER_HELP).not.toMatch(/(?:^|[\s[,|])--yes(?=[\s\],|])/m);
  });
});

describe('helpListsModelFlag', () => {
  it('finds --model in the help text', () => {
    expect(helpListsModelFlag(AIDER_HELP)).toBe(true);
  });

  it('does not take --models, --model-settings-file or another flag mentioning --model for it', () => {
    expect(HELP_WITHOUT_MODEL).toMatch(/depends on --model\)/);
    expect(HELP_WITHOUT_MODEL).toMatch(/use --model\)/);
    expect(helpListsModelFlag(HELP_WITHOUT_MODEL)).toBe(false);
  });
});

describe('discoverAiderCapabilities', () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    resolveCliTargetFailure = null;
    resolvedCliTargetOverride = null;
    execCliForTargetCalls.length = 0;
    resetAiderCapabilityCacheForTests();
  });

  it('reads a WSL Aider help through its distro, not a local exec', async () => {
    const wslTarget = { distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/aider' };
    resolvedCliTargetOverride = wslTarget;
    const capabilities = await discoverAiderCapabilities('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\aider');
    expect(capabilities.supportsModelOverride).toBe(true);
    expect(execCliForTargetCalls).toEqual([{ target: wslTarget, cliArguments: ['--help'] }]);
    expect(probeCallCount()).toBe(0);
  });

  it('reports no override without throwing when the CLI target cannot be resolved, and probes again later', async () => {
    resolveCliTargetFailure = new Error('wsl facts unreadable');
    respondWith(AIDER_HELP);
    await expect(discoverAiderCapabilities('/usr/bin/aider')).resolves.toEqual({ supportsModelOverride: false, effortLevels: [] });
    expect(probeCallCount()).toBe(0);

    resolveCliTargetFailure = null;
    expect((await discoverAiderCapabilities('/usr/bin/aider')).supportsModelOverride).toBe(true);
    expect(probeCallCount()).toBe(1);
  });

  it('shares one help probe between concurrent calls for the same cliPath', async () => {
    respondWith(AIDER_HELP);
    const [first, second] = await Promise.all([
      discoverAiderCapabilities('/usr/bin/aider'),
      discoverAiderCapabilities('/usr/bin/aider'),
    ]);
    expect(probeCallCount()).toBe(1);
    expect(first).toEqual(second);
    expect(first.supportsModelOverride).toBe(true);
  });

  it('shares the in-flight probe even when a concurrent call passes forceRefresh', async () => {
    respondWith(AIDER_HELP);
    const [plain, forced] = await Promise.all([
      discoverAiderCapabilities('/usr/bin/aider'),
      discoverAiderCapabilities('/usr/bin/aider', true),
    ]);
    expect(probeCallCount()).toBe(1);
    expect(plain.supportsModelOverride).toBe(true);
    expect(forced.supportsModelOverride).toBe(true);
  });

  it('probes again on forceRefresh once the shared probe has settled', async () => {
    respondWith(AIDER_HELP);
    await Promise.all([
      discoverAiderCapabilities('/usr/bin/aider'),
      discoverAiderCapabilities('/usr/bin/aider'),
    ]);
    expect(probeCallCount()).toBe(1);
    await discoverAiderCapabilities('/usr/bin/aider', true);
    expect(probeCallCount()).toBe(2);
  });

  it('runs the help through a quoted cmd command on win32', async () => {
    respondWith(AIDER_HELP);
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await discoverAiderCapabilities('C:\\Users\\dev\\Scripts\\aider.exe');
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
    const command = execMock.mock.calls[0][0] as string;
    expect(command.startsWith('"C:\\Users\\dev\\Scripts\\aider.exe"')).toBe(true);
    expect(command.endsWith('--help')).toBe(true);
  });

  it('reports model override support, no model list and no effort levels', async () => {
    respondWith(AIDER_HELP);
    await expect(discoverAiderCapabilities('/usr/bin/aider')).resolves.toEqual({
      supportsModelOverride: true,
      effortLevels: [],
    });
  });

  it('reports no override when the help lists no --model', async () => {
    respondWith(HELP_WITHOUT_MODEL);
    expect((await discoverAiderCapabilities('/usr/bin/aider')).supportsModelOverride).toBe(false);
  });

  it('never throws when the help probe fails, and does not cache the failure', async () => {
    respondWithFailure(new Error('ENOENT: aider not found'));
    await expect(discoverAiderCapabilities('/usr/bin/aider')).resolves.toEqual({ supportsModelOverride: false, effortLevels: [] });

    respondWith(AIDER_HELP);
    expect((await discoverAiderCapabilities('/usr/bin/aider')).supportsModelOverride).toBe(true);
  });

  it('caches per cliPath, and reads the help again on forceRefresh or a new path', async () => {
    respondWith(AIDER_HELP);
    await discoverAiderCapabilities('/usr/bin/aider');
    await discoverAiderCapabilities('/usr/bin/aider');
    expect(probeCallCount()).toBe(1);

    await discoverAiderCapabilities('/usr/bin/aider', true);
    expect(probeCallCount()).toBe(2);

    await discoverAiderCapabilities('/opt/aider/bin/aider');
    expect(probeCallCount()).toBe(3);
  });

  it('is what the adapter reports', async () => {
    respondWith(AIDER_HELP);
    expect((await new AiderAdapter().discoverCapabilities('/usr/bin/aider')).supportsModelOverride).toBe(true);
  });
});
