/**
 * The task process tag (src/main/pty/process-tag/task-process-tag.ts) and the
 * WSL reap (wsl-reap.ts): the spawn env, the id gate, the WSL spec parse, and
 * the in-distro script.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TASK_PROCESS_TAG_ENV,
  addTaskProcessTag,
  isValidTaskTagValue,
  parseWslShellSpec,
} from '../../src/main/pty/process-tag/task-process-tag';
import {
  WSL_SCRIPT_TIMEOUT_MS,
  WSL_TASK_ARGUMENT_BUDGET,
  batchWslReapTasks,
  buildWslReapInvocation,
  parseDefaultDistro,
  parseRunningDistros,
  reapTaggedProcessesInWsl,
  type WslExec,
  type WslReapTask,
} from '../../src/main/pty/process-tag/wsl-reap';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const PROJECT = 'C:\\Users\\dev\\project';
const REAP_TASKS = [{ taskId: TASK, directories: [PROJECT] }];

/** CreateProcess refuses a Windows command line longer than this. */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
/** `-d`, the distro, `-e`, `sh`, `-c`, the script, `sh`: the task arguments follow. */
const TASK_ARGUMENTS_START = 7;

/** One task per index, each with its project and a `.kangentic\worktrees\<slug>` directory. */
function buildRealisticReapTasks(count: number): WslReapTask[] {
  return Array.from({ length: count }, (_unused, index) => {
    const project = `C:\\Users\\dev\\projects\\service-${index}`;
    return {
      taskId: `3f2b8c1e-5d7a-4c9b-8e1f-${index.toString(16).padStart(12, '0')}`,
      directories: [project, `${project}\\.kangentic\\worktrees\\implement-board-filter-${index}`],
    };
  });
}

interface ScriptCall {
  args: string[];
  timeoutMs: number;
}

/**
 * A fake `exec` for a running Ubuntu distro: it answers the running listing and
 * records every script call, handing each to `runScript` (call number from 1)
 * for its output.
 */
function createRunningDistro(runScript: (call: ScriptCall, callNumber: number) => string = () => ''): { exec: WslExec; scriptCalls: ScriptCall[] } {
  const scriptCalls: ScriptCall[] = [];
  const exec: WslExec = async (_file, args, options) => {
    if (args.includes('--running')) return 'Ubuntu\n';
    const call = { args, timeoutMs: options.timeoutMs };
    scriptCalls.push(call);
    return runScript(call, scriptCalls.length);
  };
  return { exec, scriptCalls };
}

/** The task groups (id, then its directories) a script call carries as arguments. */
function readTaskGroups(call: ScriptCall): Map<string, string[]> {
  const taskArguments = call.args.slice(TASK_ARGUMENTS_START);
  const groups = new Map<string, string[]>();
  let position = 0;
  while (position < taskArguments.length) {
    const directoryCount = Number(taskArguments[position + 1]);
    groups.set(taskArguments[position], taskArguments.slice(position + 2, position + 2 + directoryCount));
    position += 2 + directoryCount;
  }
  return groups;
}

/** Length of an argument list the way the batching counts it: each argument plus a space and two quotes. */
function countArgumentCharacters(argumentList: readonly string[]): number {
  return argumentList.reduce((sum, argument) => sum + argument.length + 3, 0);
}

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

  // The startup sweep passes every archived and To Do task at once. Measured:
  // 210 tasks with a worktree each failed with ENAMETOOLONG in one wsl.exe call.
  describe('batching the tasks across wsl.exe calls', () => {
    const manyTasks = buildRealisticReapTasks(400);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // A fixture that fits fewer batches than a test needs would let it pass
    // vacuously, so each test that stops or counts batches states what it needs.
    function expectBatchCountOfAtLeast(minimum: number): void {
      expect(batchWslReapTasks(manyTasks).length).toBeGreaterThanOrEqual(minimum);
    }

    it('splits 400 tasks into script calls that each fit one Windows command line, with every task in exactly one call', async () => {
      expectBatchCountOfAtLeast(2);
      const { exec, scriptCalls } = createRunningDistro();
      await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec);

      expect(scriptCalls.length).toBeGreaterThan(1);
      for (const call of scriptCalls) {
        // The whole argument list is the task budget plus the script and its few fixed flags.
        const fixedArgumentCharacters = countArgumentCharacters(call.args.slice(0, TASK_ARGUMENTS_START));
        expect(countArgumentCharacters(call.args)).toBeLessThanOrEqual(WSL_TASK_ARGUMENT_BUDGET + fixedArgumentCharacters);
        expect(countArgumentCharacters(['wsl.exe', ...call.args])).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
      }

      const taskIdsPerCall = scriptCalls.flatMap((call) => [...readTaskGroups(call).keys()]);
      expect(taskIdsPerCall).toHaveLength(manyTasks.length);
      expect(new Set(taskIdsPerCall).size).toBe(manyTasks.length);
      // Each task arrives whole: its id, then all of its directories, in the one call.
      const mergedGroups = new Map(scriptCalls.flatMap((call) => [...readTaskGroups(call)]));
      for (const task of manyTasks) {
        expect(mergedGroups.get(task.taskId)).toEqual([...task.directories]);
      }
    });

    it('hands the first batch the whole 10 s and each later batch what the earlier calls left', async () => {
      expectBatchCountOfAtLeast(3);
      let clock = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const elapsedByCall = [3_000, 2_500];
      const { exec, scriptCalls } = createRunningDistro((_call, callNumber) => {
        clock += elapsedByCall[callNumber - 1] ?? 0;
        return '';
      });
      const failures: unknown[] = [];

      await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      expect(WSL_SCRIPT_TIMEOUT_MS).toBe(10_000);
      expect(scriptCalls.slice(0, 3).map((call) => call.timeoutMs)).toEqual([10_000, 7_000, 4_500]);
      expect(failures).toEqual([]);
    });

    it('gives a second batch the 1,000 ms a 9,000 ms first batch left, then runs no batch with nothing left', async () => {
      expectBatchCountOfAtLeast(3);
      let clock = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const elapsedByCall = [9_000, 1_000];
      const { exec, scriptCalls } = createRunningDistro((_call, callNumber) => {
        clock += elapsedByCall[callNumber - 1] ?? 0;
        return '';
      });
      const failures: unknown[] = [];

      await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      // The third batch would start with exactly 0 ms left, so it never runs.
      expect(scriptCalls.map((call) => call.timeoutMs)).toEqual([10_000, 1_000]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(Error);
    });

    it('runs no later batch after a call that overran the whole budget', async () => {
      expectBatchCountOfAtLeast(2);
      let clock = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const { exec, scriptCalls } = createRunningDistro(() => {
        clock += 12_000;
        return '';
      });
      const failures: unknown[] = [];

      await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      expect(scriptCalls.map((call) => call.timeoutMs)).toEqual([10_000]);
      expect(failures).toHaveLength(1);
    });

    it('stops at the first failing batch, reports it once, and still returns what the earlier batch killed', async () => {
      // Three batches, so the third would have run had the second not stopped it.
      expectBatchCountOfAtLeast(3);
      const wslFailure = new Error('wsl.exe timed out');
      const { exec, scriptCalls } = createRunningDistro((_call, callNumber) => {
        if (callNumber === 2) throw wslFailure;
        return ' 4242 4243\n';
      });
      const failures: unknown[] = [];

      const killedPids = await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      expect(scriptCalls).toHaveLength(2);
      expect(failures).toEqual([wslFailure]);
      expect(killedPids).toEqual([4242, 4243]);
    });

    it('asks keepTask for each batch just before its script runs, so a task refused meanwhile is left out of that batch', async () => {
      const batches = batchWslReapTasks(manyTasks);
      expect(batches.length).toBeGreaterThanOrEqual(2);
      const secondBatch = batches[1];
      const refusedTaskId = secondBatch[Math.floor(secondBatch.length / 2)].taskId;
      let firstScriptHasRun = false;
      const { exec, scriptCalls } = createRunningDistro(() => {
        firstScriptHasRun = true;
        return '';
      });
      // Refused only once the first batch has run: asking for every task up front would still keep it.
      const keepTask = (taskId: string): boolean => !(firstScriptHasRun && taskId === refusedTaskId);

      await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, () => {}, keepTask);

      const taskIdsPerCall = scriptCalls.map((call) => [...readTaskGroups(call).keys()]);
      expect(taskIdsPerCall).toHaveLength(batches.length);
      expect(taskIdsPerCall[0]).toEqual(batches[0].map((task) => task.taskId));
      expect(taskIdsPerCall[1]).toEqual(secondBatch.map((task) => task.taskId).filter((taskId) => taskId !== refusedTaskId));
      expect(taskIdsPerCall.flat()).not.toContain(refusedTaskId);
    });

    it('skips a batch whose every task keepTask refuses, without spending any of the budget', async () => {
      const batches = batchWslReapTasks(manyTasks);
      const refusedTaskIds = new Set(batches[0].map((task) => task.taskId));
      const { exec, scriptCalls } = createRunningDistro();

      await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, () => {}, (taskId) => !refusedTaskIds.has(taskId));

      expect(scriptCalls).toHaveLength(batches.length - 1);
      expect(scriptCalls[0].timeoutMs).toBe(10_000);
      expect(readTaskGroups(scriptCalls[0]).has(batches[1][0].taskId)).toBe(true);
    });
  });
});
