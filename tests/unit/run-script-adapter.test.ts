/**
 * The run_script adapter, driven for real.
 *
 * It spawns an ordinary child process rather than a PTY, and that is the whole
 * point of this file. The first implementation reused `SessionManager.spawn`,
 * which opens an INTERACTIVE shell and types the command into it; the shell
 * then returns to its prompt and lives forever, so the script's completion was
 * unobservable and its exit code unobtainable. A preview caught it: a script
 * that finished in well under a second was recorded as "Gave up after 60s", and
 * on the enter path, where the default budget is five minutes, it would have
 * held the task lock for five minutes.
 *
 * No typecheck or lint can see that, so these run real scripts through the real
 * adapter and assert on the exit code and the wall clock.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { runScriptAdapter } from '../../src/main/automations/adapters/run-script';
import { resolveScriptInvocation } from '../../src/main/pty/spawn/script-invocation';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import { AutomationTimeoutError } from '../../src/main/automations/shared/automation-errors';
import type { Task } from '../../src/shared/types';

// A shell that exists on every runner: Windows CI and dev machines have
// cmd.exe, Linux and macOS have /bin/sh. Both take the non-interactive form.
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

function makeContext(overrides: { signal?: AbortSignal; templateVars?: Record<string, string> } = {}): AutomationContext {
  return {
    task: { id: 'task-1', title: 'A task' } as Task,
    column: { name: 'Executing' },
    trigger: 'enter',
    cwd: os.tmpdir(),
    projectId: 'project-1',
    templateVars: overrides.templateVars ?? { title: 'A task', toColumn: 'Executing' },
    sessionHost: { getShell: async () => SHELL },
    signal: overrides.signal ?? new AbortController().signal,
    runId: 'run-1',
    // The adapter reads none of the rest; the cast keeps the fake to what it uses.
  } as unknown as AutomationContext;
}

describe('run_script', () => {
  it('resolves as soon as a fast script exits, not when its budget expires', async () => {
    const startedAt = Date.now();
    // A 1-minute budget. Under the PTY implementation this returned after 60
    // seconds with a timeout; the elapsed assertion is what separates the two.
    const result = await runScriptAdapter.execute({ script: 'exit 0', timeoutMinutes: 1 }, makeContext());

    expect(result.detail).toBe('exit 0');
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('reports a non-zero exit as a failure, with the code', async () => {
    await expect(
      runScriptAdapter.execute({ script: 'exit 3', timeoutMinutes: 1 }, makeContext()),
    ).rejects.toThrow('Script exited with code 3.');
  });

  it('rejects with a typed timeout when the script outlives its budget', async () => {
    // The smallest budget the field allows is 1 minute, but `resolveTimeoutMs`
    // only floors at zero, so a fractional value exercises the real path
    // quickly. A sleep long enough to be killed, short enough not to hang CI.
    const sleep = process.platform === 'win32'
      ? 'ping -n 30 127.0.0.1 > nul'
      : 'sleep 30';
    await expect(
      runScriptAdapter.execute({ script: sleep, timeoutMinutes: 0.01 }, makeContext()),
    ).rejects.toBeInstanceOf(AutomationTimeoutError);
  }, 20_000);

  it('rejects when the move is superseded mid-script', async () => {
    const controller = new AbortController();
    const sleep = process.platform === 'win32'
      ? 'ping -n 30 127.0.0.1 > nul'
      : 'sleep 30';
    const pending = runScriptAdapter.execute(
      { script: sleep, timeoutMinutes: 1 },
      makeContext({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow('superseded');
  }, 20_000);

  it('rejects rather than hangs when the shell cannot be started', async () => {
    const context = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overriding one method of the structural fake
    (context as any).sessionHost = { getShell: async () => 'no-such-shell-anywhere' };
    await expect(
      runScriptAdapter.execute({ script: 'exit 0', timeoutMinutes: 1 }, context),
    ).rejects.toThrow();
  });

  it('does nothing at all for an empty script', async () => {
    const result = await runScriptAdapter.execute({ script: '   ' }, makeContext());
    expect(result.detail).toBe('No script to run.');
  });

  it('exports every template variable as a KANGENTIC_ environment variable', async () => {
    // The lossless path, and the one the field hint points at: `escape: 'shell'`
    // STRIPS the characters that could break out of a quote, so a title with a
    // semicolon survives here and not in the substituted text.
    const probe = process.platform === 'win32'
      ? 'if "%KANGENTIC_TO_COLUMN%"=="Executing" (exit 0) else (exit 9)'
      : '[ "$KANGENTIC_TO_COLUMN" = "Executing" ] || exit 9';
    const result = await runScriptAdapter.execute({ script: probe, timeoutMinutes: 1 }, makeContext());
    expect(result.detail).toBe('exit 0');
  });
});

describe('resolveScriptInvocation', () => {
  it('gives PowerShell the non-interactive form, with no profile', () => {
    const { args } = resolveScriptInvocation('pwsh', 'Get-Date');
    // `-Command` is what makes it run and EXIT; the interactive form omits it
    // and the shell sits at its prompt forever.
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-Command']);
    expect(args[3]).toContain('Get-Date');
  });

  it('makes PowerShell propagate the child exit code it otherwise swallows', () => {
    const { args } = resolveScriptInvocation('pwsh', 'node -e "process.exit(7)"');
    // Without this, `-Command` reports its own success as 0 or 1, so a script
    // that exited 7 is recorded as "exited with code 1". Measured: 7 with,
    // 1 without.
    expect(args[3]).toContain('exit $LASTEXITCODE');
  });

  it('leaves cmd and POSIX shells alone, because both propagate natively', () => {
    expect(resolveScriptInvocation('cmd.exe', 'x').args.join(' ')).not.toContain('LASTEXITCODE');
    expect(resolveScriptInvocation('/bin/bash', 'x').args.join(' ')).not.toContain('LASTEXITCODE');
  });

  it('gives cmd its /c form', () => {
    expect(resolveScriptInvocation('cmd.exe', 'echo hi').args).toEqual(['/d', '/s', '/c', 'echo hi']);
  });

  it('gives a POSIX shell -c', () => {
    expect(resolveScriptInvocation('/bin/bash', 'echo hi').args).toEqual(['-c', 'echo hi']);
    expect(resolveScriptInvocation('/usr/bin/fish', 'echo hi').args).toEqual(['-c', 'echo hi']);
  });

  it('runs a WSL script inside the distro and exits', () => {
    const { exe, args } = resolveScriptInvocation('wsl -d Ubuntu', 'echo hi');
    expect(exe).toBe('wsl.exe');
    expect(args).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lc', 'echo hi']);
  });

  it('never returns the interactive argv, which is what kept the shell alive', () => {
    for (const shell of ['pwsh', 'cmd.exe', '/bin/bash', '/bin/zsh']) {
      const { args } = resolveScriptInvocation(shell, 'echo hi');
      expect(args).not.toContain('--login');
      // The script rides in the argv, so nothing is left to type into a live
      // shell. PowerShell's last argument also carries the exit-code
      // propagation, hence `toContain` rather than an equality check.
      expect(args[args.length - 1]).toContain('echo hi');
    }
  });
});
