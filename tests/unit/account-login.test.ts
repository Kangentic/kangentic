import { describe, expect, it } from 'vitest';
import { AccountLoginRunner } from '../../src/main/accounts/account-login';

/**
 * The sign-in runner over a real PTY. With no pty host registered (a unit test), the spawn falls
 * back to node-pty in this process, so this runs the same `cmd.exe /c` launch on Windows and the
 * direct launch elsewhere that a real `claude auth login` gets, with `node` standing in for the CLI.
 */
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

describe('AccountLoginRunner', () => {
  it('runs the command in a terminal with the account env, relays its output, and reports its end', async () => {
    const { runner, output, ended } = runnerWith();
    const loginId = await runner.start('account-1', {
      cliPath: process.execPath,
      args: ['-e', 'console.log(process.env.ACCOUNT_HOME_PROBE)'],
      env: { ACCOUNT_HOME_PROBE: 'home-of-account-1' },
    });
    const result = await ended;
    expect(result).toEqual({ loginId, accountId: 'account-1', cancelled: false });
    expect(output.join('')).toContain('home-of-account-1');
  }, 30_000);

  it('keeps what was printed for a terminal that mounts late, and joins a sign-in already running', async () => {
    const { runner, ended } = runnerWith();
    const command = {
      cliPath: process.execPath,
      args: ['-e', "console.log('first-line');setTimeout(()=>{},60000)"],
      env: {},
    };
    const loginId = await runner.start('account-2', command);
    expect(await runner.start('account-2', command)).toBe(loginId);
    await expect.poll(() => runner.backlog(loginId), { timeout: 20_000 }).toContain('first-line');

    runner.cancel(loginId);
    expect(await ended).toEqual({ loginId, accountId: 'account-2', cancelled: true });
    expect(runner.loginIdFor('account-2')).toBeNull();
  }, 30_000);
});
