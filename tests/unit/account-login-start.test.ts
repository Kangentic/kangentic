import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/utility-process/off-main-pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-pty')>();
  return { ...actual, spawnOffMainPty: vi.fn(actual.spawnOffMainPty) };
});

import { AccountLoginRunner } from '../../src/main/accounts/account-login';
import { spawnOffMainPty } from '../../src/main/utility-process/off-main-pty';

function runnerWith() {
  const output: string[] = [];
  let resolveEnded: (ended: { loginId: string; accountId: string; cancelled: boolean }) => void = () => undefined;
  const ended = new Promise<{ loginId: string; accountId: string; cancelled: boolean }>((resolve) => { resolveEnded = resolve; });
  const runner = new AccountLoginRunner({
    onOutput: (_loginId, data) => { output.push(data); },
    onEnded: (loginId, accountId, cancelled) => resolveEnded({ loginId, accountId, cancelled }),
  });
  return { runner, output, ended };
}

const created: string[] = [];

afterEach(() => {
  vi.mocked(spawnOffMainPty).mockClear();
  for (const folder of created.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('AccountLoginRunner.start', () => {
  it('returns one login id and spawns one terminal for two starts made together', async () => {
    const { runner, ended } = runnerWith();
    const command = {
      cliPath: process.execPath,
      args: ['-e', 'setTimeout(()=>{},60000)'],
      env: {},
    };

    const [first, second] = await Promise.all([runner.start('account-3', command), runner.start('account-3', command)]);

    expect(second).toBe(first);
    expect(spawnOffMainPty).toHaveBeenCalledTimes(1);
    expect(runner.loginIdFor('account-3')).toBe(first);

    runner.cancel(first);
    expect(await ended).toEqual({ loginId: first, accountId: 'account-3', cancelled: true });
  }, 30_000);
});

describe.runIf(process.platform === 'win32')('AccountLoginRunner with a .cmd shim', () => {
  it('starts a shim whose folder name holds a space and cmd special characters', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-login-shim-'));
    created.push(parent);
    const shimFolder = path.join(parent, 'a & (b)');
    fs.mkdirSync(shimFolder, { recursive: true });
    const shim = path.join(shimFolder, 'agent.cmd');
    fs.writeFileSync(shim, '@echo off\necho shim-ran %1\n');

    const { runner, output, ended } = runnerWith();
    await runner.start('account-4', { cliPath: shim, args: ['hello'], env: {} });

    const result = await ended;
    expect(result.cancelled).toBe(false);
    expect(output.join('')).toContain('shim-ran');
    expect(output.join('')).toContain('hello');
  }, 30_000);
});
