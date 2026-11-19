/**
 * Codex `identify` with no `auth.json` asks `codex login status` (exit 0 = signed in, 1 = signed
 * out, anything else = no answer), under the account's CODEX_HOME and CODEX_SQLITE_HOME.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  stdout: { resume: ReturnType<typeof vi.fn> };
  stderr: { resume: ReturnType<typeof vi.fn> };
}

const spawnCli = vi.fn();
const stopCli = vi.fn();
vi.mock('../../src/main/agent/shared/cli-print', () => ({ spawnCli, stopCli }));

const { CODEX_ACCOUNT_SUPPORT, codexLoginEvidence } = await import('../../src/main/agent/adapters/codex/accounts');

let home: string;
let child: FakeChild;

async function identifyThen(settle: () => void) {
  const pending = CODEX_ACCOUNT_SUPPORT.identify('codex', home);
  await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1));
  settle();
  return pending;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-account-'));
  child = Object.assign(new EventEmitter(), { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } }) as FakeChild;
  spawnCli.mockReset();
  stopCli.mockReset();
  spawnCli.mockReturnValue(child);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Codex identify without auth.json', () => {
  it('reads exit 0 as signed in, and runs login status under both home variables', async () => {
    const identity = await identifyThen(() => child.emit('exit', 0));
    expect(identity.signedIn).toBe(true);
    const [, args, , env] = spawnCli.mock.calls[0];
    expect(args).toEqual(['login', 'status']);
    expect(env).toEqual({ CODEX_HOME: home, CODEX_SQLITE_HOME: home });
  });

  it('reads exit 1 as signed out', async () => {
    const identity = await identifyThen(() => child.emit('exit', 1));
    expect(identity.signedIn).toBe(false);
  });

  // No answer is not a signed-out answer: the account keeps its status (`IdentityReadError`).
  it.each([
    ['a spawn error', () => child.emit('error', new Error('spawn ENOENT'))],
    ['another exit code', () => child.emit('exit', 2)],
    ['an exit by signal', () => child.emit('exit', null)],
  ])('gives no answer on %s', async (_label, settle) => {
    await expect(identifyThen(settle)).rejects.toMatchObject({ name: 'IdentityReadError', reason: 'run-failed' });
  });

  it('gives no answer when login status times out, and stops the run', async () => {
    vi.useFakeTimers();
    try {
      const pending = CODEX_ACCOUNT_SUPPORT.identify('codex', home);
      const outcome = expect(pending).rejects.toMatchObject({ name: 'IdentityReadError', reason: 'run-failed' });
      await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(20_000);
      await outcome;
      expect(stopCli).toHaveBeenCalledWith(child);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The session-id reports ask this for a session whose id never came. A
// signed-out Codex opens on its sign-in screen, which draws a frame and makes no
// conversation (measured on 0.163.0: no `auth.json`, and `login status` exits 1).
describe('Codex login evidence', () => {
  beforeEach(() => {
    // Codex's own home, which `CODEX_HOME` moves: the session ran with no account folder.
    vi.stubEnv('CODEX_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function evidenceThen(settle: () => void) {
    const pending = codexLoginEvidence({ cliPath: 'codex' });
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1));
    settle();
    return pending;
  }

  it('reads a home that holds a login as signed in, without running the CLI', async () => {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-0000' }));
    await expect(codexLoginEvidence({ cliPath: 'codex' })).resolves.toBe('signed_in');
    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('asks the CLI when the home holds none, with no home variable of its own, and reads exit 1 as signed out', async () => {
    await expect(evidenceThen(() => child.emit('exit', 1))).resolves.toBe('signed_out');
    const [cliPath, args, , env] = spawnCli.mock.calls[0];
    expect([cliPath, args, env]).toEqual(['codex', ['login', 'status'], undefined]);
  });

  it('reads exit 0 as signed in: a login the CLI keeps outside auth.json', async () => {
    await expect(evidenceThen(() => child.emit('exit', 0))).resolves.toBe('signed_in');
  });

  it.each([
    ['a spawn error', () => child.emit('error', new Error('spawn ENOENT'))],
    ['another exit code', () => child.emit('exit', 2)],
  ])('reads unknown, never signed out, on %s', async (_label, settle) => {
    await expect(evidenceThen(settle)).resolves.toBe('unknown');
  });

  describe('for a session that ran in an account folder', () => {
    let accountFolder: string;

    beforeEach(() => {
      accountFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-account-folder-'));
    });

    afterEach(() => {
      fs.rmSync(accountFolder, { recursive: true, force: true });
    });

    it('reads the login in that folder, not Codex\'s own home, without running the CLI', async () => {
      // The own home holds none and a `login status` there would say signed out.
      fs.writeFileSync(path.join(accountFolder, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-0000' }));
      await expect(codexLoginEvidence({ cliPath: 'codex', accountHome: accountFolder })).resolves.toBe('signed_in');
      expect(spawnCli).not.toHaveBeenCalled();
    });

    it('reads signed out from that folder when the own home holds a login, and runs login status under the folder', async () => {
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-0000' }));
      const pending = codexLoginEvidence({ cliPath: 'codex', accountHome: accountFolder });
      await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1));
      child.emit('exit', 1);
      await expect(pending).resolves.toBe('signed_out');
      const [, args, , env] = spawnCli.mock.calls[0];
      expect(args).toEqual(['login', 'status']);
      expect(env).toEqual({ CODEX_HOME: accountFolder, CODEX_SQLITE_HOME: accountFolder });
    });

    it.each([
      ['null', { cliPath: 'codex', accountHome: null }],
      ['omitted', { cliPath: 'codex' }],
    ])('reads Codex\'s own home when the account home is %s', async (_label, options) => {
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-0000' }));
      await expect(codexLoginEvidence(options)).resolves.toBe('signed_in');
      expect(spawnCli).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['in a distro', { cliPath: 'codex', cliTarget: { kind: 'wsl' as const, distro: 'TestDistro', homeLinux: '/home/dev' } }],
    ['with no command to run', { cliPath: null }],
  ])('reads unknown for a CLI %s, and asks nothing', async (_label, options) => {
    await expect(codexLoginEvidence(options)).resolves.toBe('unknown');
    expect(spawnCli).not.toHaveBeenCalled();
  });
});
