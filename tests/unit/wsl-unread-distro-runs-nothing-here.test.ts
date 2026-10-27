/**
 * A CLI path into a WSL distro whose facts cannot be read (the distro is
 * missing, or still booting) is never run or read as this machine's (#286).
 * Codex's capability discovery reports nothing rather than running `--help`
 * on the path here or scanning this machine's `~/.codex`, and Claude's warm
 * answer session, opened synchronously before detection has read the distro,
 * refuses so the pool answers with a fresh run, which reads it. Every process
 * start is caught, and `process.platform` is faked as win32.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const started = vi.hoisted(() => [] as string[]);
vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  return {
    ...actual,
    execAsync: async (command: string) => { started.push(command); return { stdout: '', stderr: '' }; },
    execFileAsync: async (file: string) => { started.push(file); return { stdout: '', stderr: '' }; },
  };
});
vi.mock('../../src/main/utility-process/off-main-cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-cli')>();
  return { ...actual, spawnOffMainCli: (command: string) => { started.push(command); throw new Error('no process starts in this test'); } };
});
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  return {
    ...actual,
    resolveWslDistroFacts: async () => { throw new Error('There is no distribution with the supplied name.'); },
    peekWslDistroFacts: () => null,
  };
});

import { discoverCodexCapabilities } from '../../src/main/agent/adapters/codex/capability-discovery';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude';
import type { AnswerSessionInput } from '../../src/main/agent/agent-adapter';

const realPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  started.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('a distro CLI path whose distro cannot be read', () => {
  it('gives Codex no capabilities and runs nothing', async () => {
    await expect(discoverCodexCapabilities('\\\\wsl.localhost\\Gone\\home\\dev\\.local\\bin\\codex'))
      .resolves.toEqual({ supportsModelOverride: false, effortLevels: [] });
    expect(started).toEqual([]);
  });

  it('opens no warm Claude answer session, so the answer takes a fresh run', () => {
    const input = {
      cliPath: '\\\\wsl.localhost\\Gone\\home\\dev\\.local\\bin\\claude',
      cwd: 'C:\\Users\\dev\\answers',
      runDirectory: 'C:\\Users\\dev\\answers\\run-1',
      model: null,
      effort: null,
    } as unknown as AnswerSessionInput;
    expect(() => new ClaudeAdapter().openAnswerSession(input)).toThrow('not read yet');
    expect(started).toEqual([]);
  });
});
