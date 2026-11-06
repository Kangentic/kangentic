/**
 * A `run_script` row on a remote project. It used to run on this computer in the empty stand-in and record exit 0 for
 * work that never happened. The scripts here run through the helper's real command runner on POSIX, so a script's
 * folder, variables, exit code and output are what a host would give.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScriptAdapter } from '../../src/main/automations/adapters/run-script';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import { runHostCommand } from '../../src/main/remote/helper/host-command';
import { setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { boundedHostEnvironment, hostScriptRunner } from '../../src/main/remote/host-script';
import { setHostAccessLookup, type HostAccess } from '../../src/main/remote/host-transfer';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const SHELL = path.resolve('/mock/config/remote-projects/p1');
const STAND_IN = path.join(SHELL, '.kangentic', 'worktrees', '12');

function contextWith(run: AutomationContext['runOnHost'], signal: AbortSignal = new AbortController().signal, templateVars: Record<string, string> = { title: 'A task' }): AutomationContext {
  return { cwd: STAND_IN, runOnHost: run, signal, templateVars, sessionHost: { getShell: vi.fn(async () => 'bash') } } as unknown as AutomationContext;
}

function access(runCommand: (request: HostCommandRequest) => Promise<HostCommandResult>): HostAccess {
  return { hostId: 'host-1', runCommand, pathPresence: vi.fn(), removeFiles: vi.fn(), listeningPorts: vi.fn() };
}

afterEach(() => {
  setRemoteProjectLookup(null);
  setHostAccessLookup(null);
});

describe('a script on a remote project', () => {
  beforeEach(() => {
    setRemoteProjectLookup((projectPath) => (projectPath === SHELL ? { hostId: 'host-1', path: '/home/dev/proj' } : null));
  });

  it('runs in the task\'s folder on the host, with the script an argument and the variables in the environment', async () => {
    let asked: HostCommandRequest | null = null;
    setHostAccessLookup(() => access(async (request) => { asked = request; return { code: 0, stdout: '', stderr: '', timedOut: false }; }));

    const result = await runScriptAdapter.execute({ script: 'npm test; echo "$(whoami)"', timeoutMinutes: 2 }, contextWith(hostScriptRunner(SHELL, STAND_IN)));

    expect(result.detail).toBe('exit 0 on the host');
    expect(asked).toMatchObject({ file: 'sh', cwd: '/home/dev/proj/.kangentic/worktrees/12', env: { KANGENTIC_TITLE: 'A task' }, timeoutMs: 120_000 });
    const { args } = asked as unknown as HostCommandRequest;
    expect(args[1]).not.toContain('npm test');
    expect(args[3]).toBe('npm test; echo "$(whoami)"');
  });

  it('never starts a shell on this computer', async () => {
    setHostAccessLookup(() => access(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })));
    const context = contextWith(hostScriptRunner(SHELL, STAND_IN));

    await runScriptAdapter.execute({ script: 'exit 0', timeoutMinutes: 1 }, context);

    expect(context.sessionHost.getShell).not.toHaveBeenCalled();
  });

  it('fails on a non-zero exit, a timeout, and a host that could not run it', async () => {
    const answers: HostCommandResult[] = [
      { code: 3, stdout: '', stderr: '', timedOut: false },
      { code: null, stdout: '', stderr: '', timedOut: true },
      { code: null, stdout: '', stderr: '', timedOut: false, error: 'The folder does not exist on this host' },
    ];
    setHostAccessLookup(() => access(async () => answers.shift() as HostCommandResult));
    const context = contextWith(hostScriptRunner(SHELL, STAND_IN));

    await expect(runScriptAdapter.execute({ script: 'x', timeoutMinutes: 1 }, context)).rejects.toThrow('code 3');
    await expect(runScriptAdapter.execute({ script: 'x', timeoutMinutes: 1 }, context)).rejects.toThrow('did not finish');
    await expect(runScriptAdapter.execute({ script: 'x', timeoutMinutes: 1 }, context)).rejects.toThrow('does not exist on this host');
  });

  it('stops waiting when the move is superseded', async () => {
    setHostAccessLookup(() => access(() => new Promise(() => undefined)));
    const controller = new AbortController();

    const pending = runScriptAdapter.execute({ script: 'sleep 100', timeoutMinutes: 1 }, contextWith(hostScriptRunner(SHELL, STAND_IN), controller.signal));
    controller.abort();

    await expect(pending).rejects.toThrow('superseded');
  });

  it('says which variable it could not carry', async () => {
    setHostAccessLookup(() => access(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })));

    const result = await runScriptAdapter.execute(
      { script: 'exit 0', timeoutMinutes: 1 },
      contextWith(hostScriptRunner(SHELL, STAND_IN), undefined, { title: 'A task', agentReply: 'x'.repeat(200_000) }),
    );

    expect(result.detail).toContain('KANGENTIC_AGENT_REPLY');
  });

  it('reads a host with no connection as a failure, never a pass', async () => {
    const context = contextWith(hostScriptRunner(SHELL, STAND_IN));

    await expect(runScriptAdapter.execute({ script: 'exit 0', timeoutMinutes: 1 }, context)).rejects.toThrow('not available');
  });
});

describe('a project on this computer', () => {
  it('has no host runner, so its scripts run here as before', () => {
    expect(hostScriptRunner(path.resolve('/mock/local'), path.resolve('/mock/local'))).toBeNull();
    expect(hostScriptRunner(null, path.resolve('/mock/local'))).toBeNull();
  });
});

describe('the environment that crosses to a host', () => {
  it('keeps what fits, leaves out one long value alone, and names it', () => {
    const { fits, omitted } = boundedHostEnvironment({ A: 'short', B: 'x'.repeat(40_000), C: 'also short' });

    expect(fits).toEqual({ A: 'short', C: 'also short' });
    expect(omitted).toEqual(['B']);
  });

  it('stays inside a frame however many values there are', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [`V${index}`, 'x'.repeat(20_000)]));

    const { fits, omitted } = boundedHostEnvironment(many);

    expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThan(200 * 1024);
    expect(omitted.length).toBeGreaterThan(0);
  });
});

const hasPosixShell = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasPosixShell)('on a real shell', () => {
  let scratch: string;
  let worktree: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-script-'));
    const home = path.join(scratch, 'home');
    worktree = path.join(home, 'proj', '.kangentic', 'worktrees', '12');
    fs.mkdirSync(worktree, { recursive: true });
    setRemoteProjectLookup((projectPath) => (projectPath === SHELL ? { hostId: 'host-1', path: path.join(home, 'proj') } : null));
    setHostAccessLookup(() => access((request) => runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? home, baseEnv: { PATH: process.env.PATH, HOME: home } })));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('runs in the worktree, reads its variable, and leaves its work there', async () => {
    const result = await runScriptAdapter.execute(
      { script: 'printf "%s" "$KANGENTIC_TITLE" > made.txt', timeoutMinutes: 1 },
      contextWith(hostScriptRunner(SHELL, STAND_IN)),
    );

    expect(result.detail).toBe('exit 0 on the host');
    expect(fs.readFileSync(path.join(worktree, 'made.txt'), 'utf8')).toBe('A task');
  });

  it('passes the script\'s exit code back', async () => {
    await expect(runScriptAdapter.execute({ script: 'exit 7', timeoutMinutes: 1 }, contextWith(hostScriptRunner(SHELL, STAND_IN)))).rejects.toThrow('code 7');
  });

  it('survives a script that prints more than a reply holds', async () => {
    const result = await runScriptAdapter.execute({ script: 'head -c 2000000 /dev/zero | tr "\\0" x', timeoutMinutes: 1 }, contextWith(hostScriptRunner(SHELL, STAND_IN)));

    expect(result.detail).toBe('exit 0 on the host');
  });

  it('gives a script that reads its stdin an immediate end', async () => {
    const result = await runScriptAdapter.execute({ script: 'cat', timeoutMinutes: 1 }, contextWith(hostScriptRunner(SHELL, STAND_IN)));

    expect(result.detail).toBe('exit 0 on the host');
  });
});
