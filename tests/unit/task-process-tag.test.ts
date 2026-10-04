/**
 * The task process tag (src/main/pty/process-tag/task-process-tag.ts) and the
 * WSL reap (wsl-reap.ts): the spawn env, the id gate, the WSL spec parse, and
 * the in-distro script.
 */

import { describe, it, expect } from 'vitest';
import {
  TASK_PROCESS_TAG_ENV,
  addTaskProcessTag,
  isValidTaskTagValue,
  parseWslShellSpec,
} from '../../src/main/pty/process-tag/task-process-tag';
import { buildWslReapInvocation, parseDefaultDistro, parseRunningDistros, reapTaggedProcessesInWsl } from '../../src/main/pty/process-tag/wsl-reap';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const PROJECT = 'C:\\Users\\dev\\project';
const REAP_TASKS = [{ taskId: TASK, directories: [PROJECT] }];

describe('task process tag', () => {
  it('is KANGENTIC_TASK_ID, so agent CLIs that filter KEY, SECRET or TOKEN names pass it through', () => {
    expect(TASK_PROCESS_TAG_ENV).toBe('KANGENTIC_TASK_ID');
    expect(/KEY|SECRET|TOKEN/i.test(TASK_PROCESS_TAG_ENV)).toBe(false);
  });

  it('accepts a uuid and refuses anything else', () => {
    expect(isValidTaskTagValue(TASK)).toBe(true);
    expect(isValidTaskTagValue(TASK.toUpperCase())).toBe(true);
    for (const value of ['', 'task-1', `${TASK}; rm -rf /`, `'${TASK}'`, `${TASK} ${TASK}`]) {
      expect(isValidTaskTagValue(value)).toBe(false);
    }
  });

  it('adds the tag without disturbing the rest of the env', () => {
    const tagged = addTaskProcessTag({ KANGENTIC_EVENTS_PATH: '/x/events.jsonl' }, TASK, { wslShell: false });
    expect(tagged).toEqual({ KANGENTIC_EVENTS_PATH: '/x/events.jsonl', KANGENTIC_TASK_ID: TASK });
    expect(tagged.WSLENV).toBeUndefined();
  });

  it('lists the tag in WSLENV for a WSL shell, keeping what was already shared and never twice', () => {
    expect(addTaskProcessTag({}, TASK, { wslShell: true }).WSLENV).toBe('KANGENTIC_TASK_ID/u');
    expect(addTaskProcessTag({}, TASK, { wslShell: true, inheritedWslEnv: 'USERPROFILE/p:GOPATH/l' }).WSLENV)
      .toBe('USERPROFILE/p:GOPATH/l:KANGENTIC_TASK_ID/u');
    expect(addTaskProcessTag({ WSLENV: 'KANGENTIC_TASK_ID/u' }, TASK, { wslShell: true }).WSLENV).toBe('KANGENTIC_TASK_ID/u');
  });

  it('parses WSL shell specs and nothing else', () => {
    expect(parseWslShellSpec('wsl -d Ubuntu')).toEqual({ distro: 'Ubuntu' });
    expect(parseWslShellSpec('wsl.exe --distribution Debian')).toEqual({ distro: 'Debian' });
    expect(parseWslShellSpec('wsl')).toEqual({ distro: null });
    expect(parseWslShellSpec('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBeNull();
    expect(parseWslShellSpec('/bin/bash')).toBeNull();
  });
});

describe('WSL reap', () => {
  it('builds an invocation only from valid task ids with directories, and keeps directories out of the script text', () => {
    expect(buildWslReapInvocation([{ taskId: 'not-a-task-id', directories: [PROJECT] }])).toBeNull();
    expect(buildWslReapInvocation([{ taskId: TASK, directories: [] }])).toBeNull();
    const hostile = `C:\\x'; reboot; echo '`;
    const invocation = buildWslReapInvocation([
      { taskId: TASK, directories: [PROJECT, hostile] },
      { taskId: 'evil; reboot', directories: [PROJECT] },
    ])!;
    expect(invocation.args).toEqual([TASK, '2', PROJECT, hostile]);
    expect(invocation.script).not.toContain('reboot');
    expect(invocation.script).not.toContain(TASK);
    expect(invocation.script).toContain('grep -lsxzF "KANGENTIC_TASK_ID=$id" /proc/[0-9]*/environ');
    expect(invocation.script).toContain('wslpath -u "$1"');
  });

  it('clears its own tag before anything else runs, and fails on a grep without -z instead of finding nothing', () => {
    const lines = buildWslReapInvocation(REAP_TASKS)!.script.split('\n');
    expect(lines[0]).toBe('unset KANGENTIC_TASK_ID');
    expect(lines[1]).toMatch(/grep -qzx x .*exit 3/);
  });

  it('merges a task listed twice into one argument group, so one grep covers it', () => {
    const invocation = buildWslReapInvocation([
      { taskId: TASK, directories: [PROJECT] },
      { taskId: TASK, directories: [PROJECT, 'C:\\Users\\dev\\project\\.kangentic\\worktrees\\a'] },
    ])!;
    expect(invocation.args).toEqual([TASK, '2', PROJECT, 'C:\\Users\\dev\\project\\.kangentic\\worktrees\\a']);
  });

  it('reads the running distros from UTF-16 or UTF-8 output', () => {
    expect(parseRunningDistros('U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000')).toEqual(['Ubuntu']);
    expect(parseRunningDistros('Ubuntu\r\ndocker-desktop\r\n')).toEqual(['Ubuntu', 'docker-desktop']);
  });

  it('never boots the VM: skips the reap when the distro is not running', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
      calls.push(args);
      return args.includes('--running') ? 'docker-desktop\n' : '';
    };
    expect(await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, REAP_TASKS, exec)).toEqual([]);
    expect(calls).toEqual([['-l', '--running', '-q']]);
  });

  it('runs the script in the running distro, directories as arguments, and returns the pids it killed', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
      calls.push(args);
      return args.includes('--running') ? 'Ubuntu\n' : ' 4242 4243  4242\n';
    };
    expect(await reapTaggedProcessesInWsl({ distro: 'ubuntu' }, REAP_TASKS, exec)).toEqual([4242, 4243]);
    expect(calls[1].slice(0, 5)).toEqual(['-d', 'ubuntu', '-e', 'sh', '-c']);
    expect(calls[1].slice(6)).toEqual(['sh', TASK, '1', PROJECT]);
  });

  it('bounds a wedged wsl.exe at 5 s per listing and 10 s for the script, 20 s in all', async () => {
    const timeouts: Array<{ args: string[]; timeoutMs: number }> = [];
    const exec = async (_file: string, args: string[], options: { timeoutMs: number }) => {
      timeouts.push({ args, timeoutMs: options.timeoutMs });
      if (args.includes('--running')) return 'Ubuntu\n';
      if (args.includes('-v')) return '  NAME      STATE      VERSION\n* Ubuntu    Running    2\n';
      return '';
    };
    await reapTaggedProcessesInWsl({ distro: null }, REAP_TASKS, exec);
    expect(timeouts.map((call) => call.timeoutMs)).toEqual([5_000, 5_000, 10_000]);
    expect(timeouts[2].args[0]).toBe('-d');
    // A Done move awaits this reap before removing the worktree, and a bulk
    // delete holds each task's whole cleanup to 60 s.
    expect(timeouts.reduce((sum, call) => sum + call.timeoutMs, 0)).toBeLessThanOrEqual(20_000);
  });

  it('reads the default distro from the starred row of wsl -l -v', () => {
    const table = '  NAME              STATE           VERSION\r\n* Ubuntu            Stopped         2\r\n  docker-desktop    Running         2\r\n';
    expect(parseDefaultDistro(table)).toBe('Ubuntu');
    expect(parseDefaultDistro(table.replace(/\n/g, '\u0000\n'))).toBe('Ubuntu');
    expect(parseDefaultDistro('  NAME  STATE  VERSION\r\n  Ubuntu  Running  2\r\n')).toBeNull();
  });

  it('with no -d, never boots the default distro while only another one runs', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--running')) return 'docker-desktop\n';
      return '  NAME              STATE           VERSION\n* Ubuntu            Stopped         2\n  docker-desktop    Running         2\n';
    };
    expect(await reapTaggedProcessesInWsl({ distro: null }, REAP_TASKS, exec)).toEqual([]);
    expect(calls).toEqual([['-l', '--running', '-q'], ['-l', '-v']]);
  });

  it('with no -d, runs the script in the default distro by name when it is running', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--running')) return 'Ubuntu\n';
      if (args.includes('-v')) return '  NAME      STATE      VERSION\n* Ubuntu    Running    2\n';
      return '4242\n';
    };
    expect(await reapTaggedProcessesInWsl({ distro: null }, REAP_TASKS, exec)).toEqual([4242]);
    expect(calls[2].slice(0, 5)).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-c']);
  });

  it('never throws when wsl.exe fails, and hands the failure to the caller instead of swallowing it', async () => {
    const exec = async () => { throw new Error('wsl.exe missing'); };
    const failures: unknown[] = [];
    await expect(reapTaggedProcessesInWsl({ distro: null }, REAP_TASKS, exec, (error) => failures.push(error))).resolves.toEqual([]);
    expect(failures).toEqual([new Error('wsl.exe missing')]);
  });

  it('reports no failure for a distro that is simply not running', async () => {
    const failures: unknown[] = [];
    const exec = async (_file: string, args: string[]) => (args.includes('--running') ? '' : '');
    expect(await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, REAP_TASKS, exec, (error) => failures.push(error))).toEqual([]);
    expect(failures).toEqual([]);
  });
});
