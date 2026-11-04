/**
 * How the helper runs a program on the host for an agent CLI's own probe (#913): a trust check, a chat id,
 * a listing. The CLI is found by the user's shell, so a CLI installed under nvm is found, and a startup
 * file that prints a banner must not become part of the answer (a probe reads JSON).
 *
 * What a user loses if it breaks: a Codex session on a host runs with no activity tracking (its hook trust
 * could not be read), or a probe reads a banner as the answer and fails with a parse error.
 *
 * The real runs need a POSIX shell, which a host always has; the pure parts run everywhere.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planHostCommand, readBracketedOutput, runHostCommand } from '../../src/main/remote/helper/host-command';

describe('the shell a probe runs through', () => {
  const request = { file: 'codex', args: ['app-server', '--listen', 'stdio://'] };

  it.each(['/bin/bash', '/usr/bin/zsh', '/usr/bin/ksh'])('runs %s interactively and as a login shell, so .bashrc and .zshrc apply', (shell) => {
    const plan = planHostCommand(shell, request);
    expect(plan.file).toBe(shell);
    expect(plan.args[0]).toBe('-ilc');
    // The program and its arguments are separate arguments after the script, never part of its text.
    expect(plan.args.slice(2)).toEqual(['codex', 'app-server', '--listen', 'stdio://']);
    expect(plan.args[1]).not.toContain('codex');
  });

  it.each(['/bin/sh', '/usr/bin/dash'])('runs %s as a login shell only: dash rejects -i with -c in some builds', (shell) => {
    expect(planHostCommand(shell, request).args[0]).toBe('-lc');
  });

  it.each(['/usr/bin/fish', '/usr/bin/nu', '/bin/tcsh', '/opt/odd/shell'])('hands %s\'s probe to sh, which can run the script', (shell) => {
    const plan = planHostCommand(shell, request);
    expect(plan.file).toBe('/bin/sh');
    expect(plan.args[0]).toBe('-lc');
  });

  it('keeps what a caller sends out of the script, so an argument that looks like shell is only an argument', () => {
    const hostile = planHostCommand('/bin/bash', { file: 'tool', args: ['$(touch /tmp/x)', '; rm -rf ~', '"quoted"'] });
    expect(hostile.args[1]).not.toContain('touch');
    expect(hostile.args[1]).not.toContain('rm -rf');
    expect(hostile.args.slice(2)).toEqual(['tool', '$(touch /tmp/x)', '; rm -rf ~', '"quoted"']);
  });
});

describe('reading the program\'s output out of the shell\'s', () => {
  it('drops whatever a startup file printed before the program and keeps the exit status', () => {
    const raw = 'Welcome to the box\nnvm is ready\n__KANGENTIC_BEGIN__\n{"ok":true}\n\n__KANGENTIC_END__ 0\n';
    expect(readBracketedOutput(raw)).toEqual({ output: '{"ok":true}\n', status: 0 });
  });

  it('returns output that has no trailing newline whole', () => {
    expect(readBracketedOutput('__KANGENTIC_BEGIN__\nabc\n__KANGENTIC_END__ 3\n')).toEqual({ output: 'abc', status: 3 });
  });

  it('reads an empty output', () => {
    expect(readBracketedOutput('__KANGENTIC_BEGIN__\n\n__KANGENTIC_END__ 0\n')).toEqual({ output: '', status: 0 });
  });

  it('says the status is unknown when the closing marker never came', () => {
    expect(readBracketedOutput('__KANGENTIC_BEGIN__\npartial')).toEqual({ output: 'partial', status: null });
  });

  it('says nothing ran when the opening marker never came', () => {
    expect(readBracketedOutput('bash: cannot start\n')).toEqual({ output: '', status: null });
  });

  it('reads the status from the closing line only, so a logout script that prints cannot hide it', () => {
    expect(readBracketedOutput('__KANGENTIC_BEGIN__\nabc\n__KANGENTIC_END__ 0\nlogout\nbye\n')).toEqual({ output: 'abc', status: 0 });
  });
});

describe.skipIf(process.platform === 'win32')('running a program on a POSIX host', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  function makeHome(): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-command-'));
    folders.push(folder);
    return folder;
  }

  /** A stand-in for the user's bash that prints a banner first, as a noisy .bashrc does, then runs the script. */
  function makeNoisyShell(home: string): string {
    const shell = path.join(home, 'bash');
    fs.writeFileSync(shell, '#!/bin/sh\nshift\necho "banner from .bashrc"\nexec /bin/sh -c "$@"\n', { mode: 0o755 });
    return shell;
  }

  const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' };

  it('returns the program\'s output and exit code, and not the shell\'s banner', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'printf', args: ['%s', 'hello'], timeoutMs: 10_000 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '', timedOut: false });
  });

  it('reports a non-zero exit as an answer with the output it printed', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'sh', args: ['-c', 'echo out; echo err 1>&2; exit 7'], timeoutMs: 10_000 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result.code).toBe(7);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toContain('err');
  });

  it('writes the stdin it was given and closes it', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'cat', args: [], stdin: '{"id":1}\n', timeoutMs: 10_000 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result.stdout).toBe('{"id":1}\n');
    expect(result.code).toBe(0);
  });

  it('starts in the folder it was given with the host\'s environment plus the request\'s', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'sh', args: ['-c', 'pwd; echo "$ONLY_FOR_THIS_RUN"'], env: { ONLY_FOR_THIS_RUN: 'yes' }, timeoutMs: 10_000 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result.stdout.split('\n')[0]).toBe(fs.realpathSync(home));
    expect(result.stdout.split('\n')[1]).toBe('yes');
  });

  it('stops a program that outlives its timeout, and says so', async () => {
    const home = makeHome();
    const started = Date.now();
    const result = await runHostCommand(
      { file: 'sleep', args: ['30'], timeoutMs: 300 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('answers a program that is not installed with the shell\'s own exit status, not a crash', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'definitely-not-installed-anywhere', args: [], timeoutMs: 10_000 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/not found/);
  });

  it('names the problem when the user\'s shell is not where the host says it is', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'true', args: [], timeoutMs: 10_000 },
      { shellPath: path.join(home, 'bash'), cwd: home, baseEnv },
    );
    expect(result.code).toBeNull();
    expect(result.error).toMatch(/ENOENT/);
  });

  it('says the folder is missing, never that the program is not installed', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'true', args: [], timeoutMs: 10_000 },
      { shellPath: makeNoisyShell(home), cwd: path.join(home, 'no-such-folder'), baseEnv },
    );
    expect(result.code).toBeNull();
    expect(result.error).toMatch(/does not exist on this host/);
    expect(result.error).not.toMatch(/ENOENT/);
  });

  it('answers once the shell has exited even when a background process still holds the output', async () => {
    const home = makeHome();
    const started = Date.now();
    // The program starts something that keeps the inherited output open long after it returns.
    const result = await runHostCommand(
      { file: 'sh', args: ['-c', '(sleep 20 &) ; echo done'], timeoutMs: 15_000 },
      { shellPath: makeNoisyShell(home), cwd: home, baseEnv },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('done\n');
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('runs an unknown shell\'s probe through sh instead of failing', async () => {
    const home = makeHome();
    const result = await runHostCommand(
      { file: 'true', args: [], timeoutMs: 10_000 },
      { shellPath: path.join(home, 'tcsh'), cwd: home, baseEnv },
    );
    expect(result.code).toBe(0);
  });
});
