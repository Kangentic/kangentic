/**
 * Every agent that declares it runs from a WSL distro (`supportsWslCli`) starts
 * its headless runs there too (#286), checked over the REAL registry: a
 * Knowledge Graph answer and a title summary handed the CLI's
 * `\\wsl.localhost` path must start `wsl.exe -d <distro>` with the CLI's Linux
 * path, never the share path itself, which Windows cannot run.
 *
 * The run is caught where every runner starts its process (the pty host's
 * `spawnOffMainCli`), so the check holds whatever runner an adapter uses, and
 * the start throws so nothing runs. Capability discovery's one-shot probes
 * (`--help`, a model list) go through the off-main exec drop-in, which is
 * caught the same way: whatever it runs for a distro path is `wsl.exe`. `process.platform` is faked as win32 and
 * the distro's facts are a fixture, so this runs on every OS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const started = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);
const executed = vi.hoisted(() => [] as string[]);
vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  return {
    ...actual,
    execAsync: async (command: string) => {
      executed.push(command);
      throw new Error('stopped at the start, as the test intends');
    },
    execFileAsync: async (file: string, args: readonly string[] = []) => {
      executed.push([file, ...args].join(' '));
      throw new Error('stopped at the start, as the test intends');
    },
  };
});
vi.mock('../../src/main/utility-process/off-main-cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-cli')>();
  return {
    ...actual,
    spawnOffMainCli: (command: string, args: string[]) => {
      started.push({ command, args });
      throw new Error('stopped at the start, as the test intends');
    },
  };
});
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  const facts = {
    distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as const,
  };
  return { ...actual, resolveWslDistroFacts: async () => facts, peekWslDistroFacts: () => facts };
});

import { agentRegistry } from '../../src/main/agent/agent-registry';

const realPlatform = process.platform;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  started.length = 0;
  executed.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const WSL_AGENTS = agentRegistry.list()
  .map((name) => agentRegistry.get(name))
  .filter((adapter): adapter is NonNullable<typeof adapter> => adapter?.supportsWslCli === true);

function expectStartedInDistro(linuxCliPath: string): void {
  expect(started.length).toBeGreaterThan(0);
  const run = started[0];
  expect(run.command.endsWith('wsl.exe')).toBe(true);
  expect(run.args.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
  expect(run.args).toContain(linuxCliPath);
  expect(run.args.join(' ')).not.toContain('wsl.localhost');
}

describe('headless runs of agents that run from a WSL distro', () => {
  for (const adapter of WSL_AGENTS) {
    const uncCliPath = `\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\${adapter.name}`;
    const linuxCliPath = `/home/dev/.local/bin/${adapter.name}`;

    if (adapter.answerFromContext) {
      it(`${adapter.name}: an answer starts the CLI inside the distro`, async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-wsl-answer-${adapter.name}-`));
        temporaryDirectories.push(cwd);
        // A model, since some agents refuse an answer without one (Ollama).
        await expect(adapter.answerFromContext!('What changed?', uncCliPath, cwd, 'test-model')).rejects.toThrow();
        expectStartedInDistro(linuxCliPath);
      });
    }

    if (adapter.discoverCapabilities) {
      it(`${adapter.name}: capability discovery runs nothing but wsl.exe, and never the share path`, async () => {
        await adapter.discoverCapabilities!(uncCliPath).catch(() => undefined);
        for (const command of executed) {
          expect(command, command).not.toContain('wsl.localhost');
          expect(command.split(' ')[0].endsWith('wsl.exe'), command).toBe(true);
        }
      });
    }

    if (adapter.summarize) {
      it(`${adapter.name}: a title summary starts the CLI inside the distro`, async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-wsl-summary-${adapter.name}-`));
        temporaryDirectories.push(cwd);
        await expect(adapter.summarize!('fix the login race', uncCliPath, cwd)).rejects.toThrow();
        expectStartedInDistro(linuxCliPath);
      });
    }
  }
});
