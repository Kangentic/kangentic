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
import { buildWslReapInvocation, parseRunningDistros, reapTaggedProcessesInWsl } from '../../src/main/pty/process-tag/wsl-reap';

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
    expect(invocation.script).toContain('grep -qxF "KANGENTIC_TASK_ID=$id"');
    expect(invocation.script).toContain('wslpath -u "$1"');
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
