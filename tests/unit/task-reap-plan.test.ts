/**
 * The task reap's kill plan (src/main/pty/process-tag/reap-plan.ts): which
 * processes one scan lets a terminal transition kill, and which it must never
 * touch. Several fixtures are the shapes measured on GitHub's Linux, macOS and
 * Windows runners (tmux, pm2, console hosts, visible apps, daemons).
 */

import { describe, it, expect } from 'vitest';
import { buildProtectedPids, isInsideDirectory, normalizeDirectory, planReap, planReapDetailed, type ReapTaskScope } from '../../src/main/pty/process-tag/reap-plan';
import type { ScannedProcess } from '../../src/main/pty/process-tag/process-scan';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const MAIN_PID = 1000;
const PROJECT = '/home/dev/project';
const WORKTREE = `${PROJECT}/.kangentic/worktrees/task-1`;

type ProcessOptions = Partial<Omit<ScannedProcess, 'pid' | 'ppid'>> & { tag?: string | null };

function scanned(pid: number, ppid: number, options: ProcessOptions = {}): ScannedProcess {
  const { tag, ...rest } = options;
  return {
    pid,
    ppid,
    startKey: `start-${pid}`,
    startedAtMs: null,
    tagValue: tag === undefined ? null : tag,
    workingDirectory: WORKTREE,
    ...rest,
  };
}

function tasks(entries: Array<[string, ReapTaskScope]> = [[TASK, { directories: [PROJECT], worktreePath: WORKTREE }]]): Map<string, ReapTaskScope> {
  return new Map(entries);
}

function plannedPids(processes: ScannedProcess[], options: { liveRootPids?: number[]; reaped?: Map<string, ReapTaskScope>; caseInsensitive?: boolean } = {}): number[] {
  return planReap({
    processes,
    tasks: options.reaped ?? tasks(),
    mainPid: MAIN_PID,
    liveRootPids: options.liveRootPids ?? [],
    caseInsensitivePaths: options.caseInsensitive ?? false,
  })
    .map((target) => target.pid)
    .sort((left, right) => left - right);
}

const main = scanned(MAIN_PID, 900, { workingDirectory: '/home/dev' });

describe('planReap: two signals, the tag and the directory', () => {
  it('kills a tagged process working in the worktree or the project, wherever it was reparented', () => {
    const processes = [
      main,
      scanned(2001, 1, { tag: TASK }),
      scanned(2002, 777, { tag: TASK, workingDirectory: `${WORKTREE}/packages/web` }),
      scanned(2003, 1, { tag: TASK, workingDirectory: PROJECT }),
    ];
    expect(plannedPids(processes)).toEqual([2001, 2002, 2003]);
  });

  it('spares a tagged process working outside the task: daemons that moved to / or home, and the Gradle and git credential stores (measured)', () => {
    const processes = [
      main,
      scanned(2001, 1, { tag: TASK, workingDirectory: '/' }),
      scanned(2002, 1, { tag: TASK, workingDirectory: '/home/dev' }),
      scanned(2003, 1, { tag: TASK, workingDirectory: '/home/dev/.gradle/daemon/9.8.0' }),
      scanned(2004, 1, { tag: TASK, workingDirectory: '/tmp/kng-singleton-x' }),
      scanned(2005, 1, { tag: TASK, workingDirectory: `${PROJECT}-sibling` }),
    ];
    expect(plannedPids(processes)).toEqual([]);
  });

  it('never kills a tagged process whose directory could not be read', () => {
    expect(plannedPids([main, scanned(2001, 1, { tag: TASK, workingDirectory: null })])).toEqual([]);
  });

  it('leaves another task, an untagged process, and a cleared tag alone', () => {
    const processes = [
      main,
      scanned(2001, 1, { tag: OTHER_TASK }),
      scanned(2002, 1, { tag: null }),
      scanned(2003, 1, { tag: '' }),
    ];
    expect(plannedPids(processes)).toEqual([]);
  });

  it('uses each task\'s own directories, never another reaped task\'s', () => {
    const reaped = tasks([
      [TASK, { directories: [PROJECT], worktreePath: WORKTREE }],
      [OTHER_TASK, { directories: ['/home/dev/other'], worktreePath: null }],
    ]);
    const processes = [
      main,
      scanned(2001, 1, { tag: OTHER_TASK, workingDirectory: PROJECT }),
      scanned(2002, 1, { tag: OTHER_TASK, workingDirectory: '/home/dev/other' }),
    ];
    expect(plannedPids(processes, { reaped })).toEqual([2002]);
  });

  it('kills nothing when no task is given, or a task has no directories', () => {
    expect(plannedPids([main, scanned(2001, 1, { tag: TASK })], { reaped: new Map() })).toEqual([]);
    expect(plannedPids([main, scanned(2001, 1, { tag: TASK })], { reaped: tasks([[TASK, { directories: [], worktreePath: null }]]) })).toEqual([]);
  });

  it('never kills pids 0 to 4', () => {
    expect(plannedPids([scanned(4, 0, { tag: TASK }), scanned(3, 0, { tag: TASK })])).toEqual([]);
  });

  it('compares Windows paths across separators, case, a trailing backslash and a long-path prefix', () => {
    const reaped = tasks([[TASK, { directories: ['C:\\Users\\dev\\project'], worktreePath: null }]]);
    const processes = [
      main,
      scanned(2001, 1, { tag: TASK, workingDirectory: 'c:\\users\\DEV\\Project\\.kangentic\\worktrees\\task-1\\' }),
      scanned(2002, 1, { tag: TASK, workingDirectory: '\\\\?\\C:\\Users\\dev\\project\\src' }),
      scanned(2003, 1, { tag: TASK, workingDirectory: 'C:\\' }),
    ];
    expect(plannedPids(processes, { reaped, caseInsensitive: true })).toEqual([2001, 2002]);
  });

  it('reads a long-path UNC working directory, in either case of the prefix, as the share it names', () => {
    // `\\?\UNC\srv\share\proj` is `\\srv\share\proj`. Stripping only `\\?\` would leave
    // `UNC\srv\share\proj`, which is inside no task directory, so the task's process would survive.
    const reaped = tasks([[TASK, { directories: ['\\\\srv\\share\\proj'], worktreePath: null }]]);
    const processes = [
      main,
      // Positive control: the plain UNC form of the same directory.
      scanned(2001, 1, { tag: TASK, workingDirectory: '\\\\srv\\share\\proj\\src' }),
      scanned(2002, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\srv\\share\\proj\\src' }),
      // The prefix is matched without regard to case, whatever `caseInsensitivePaths` says.
      scanned(2003, 1, { tag: TASK, workingDirectory: '\\\\?\\unc\\srv\\share\\proj\\src' }),
      // The project's own directory, written with the prefix and a trailing separator.
      scanned(2004, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\srv\\share\\proj\\' }),
      // Negative controls: a prefix sibling, another server, and the bare share.
      scanned(2005, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\srv\\share\\proj2\\src' }),
      scanned(2006, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\other\\share\\proj\\src' }),
      scanned(2007, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\srv\\share' }),
    ];
    expect(plannedPids(processes, { reaped, caseInsensitive: true })).toEqual([2001, 2002, 2003, 2004]);
  });

  it('matches the long-path UNC prefix without regard to case even when the paths themselves are case-sensitive', () => {
    const reaped = tasks([[TASK, { directories: ['\\\\srv\\share\\proj'], worktreePath: null }]]);
    const processes = [
      main,
      scanned(2001, 1, { tag: TASK, workingDirectory: '\\\\?\\unc\\srv\\share\\proj\\src' }),
      scanned(2002, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\srv\\share\\proj\\src' }),
      // Positive control that the names after the prefix are still compared by case here.
      scanned(2003, 1, { tag: TASK, workingDirectory: '\\\\?\\UNC\\SRV\\share\\proj\\src' }),
    ];
    expect(plannedPids(processes, { reaped, caseInsensitive: false })).toEqual([2001, 2002]);
  });
});

describe('planReap: a shared process is spared with everything under it', () => {
  it('kills a tagged dev server and its tagged children (nohup npm run dev)', () => {
    const processes = [
      main,
      scanned(2001, 1, { tag: TASK }),
      scanned(2002, 2001, { tag: TASK }),
      scanned(2003, 2002, { tag: TASK }),
    ];
    expect(plannedPids(processes)).toEqual([2001, 2002, 2003]);
  });

  it('spares pm2\'s daemon, and the task\'s own app under it, when it also runs an app the user started later (measured on Linux)', () => {
    const processes = [
      main,
      scanned(2689, 1, { tag: TASK }),
      scanned(2701, 2689, { tag: TASK }),
      scanned(2727, 2689, { tag: null }),
    ];
    expect(plannedPids(processes)).toEqual([]);
  });

  it('kills pm2\'s daemon when everything it runs is the task\'s', () => {
    const processes = [main, scanned(2689, 1, { tag: TASK }), scanned(2701, 2689, { tag: TASK })];
    expect(plannedPids(processes)).toEqual([2689, 2701]);
  });

  it('treats a cleared-tag child as the opt-out: it is never killed, and it saves its parent', () => {
    const processes = [main, scanned(2001, 1, { tag: TASK }), scanned(2002, 2001, { tag: '' })];
    expect(plannedPids(processes)).toEqual([]);
  });

  it('spares a parent whose child carries another task\'s tag or works outside the task', () => {
    expect(plannedPids([main, scanned(2001, 1, { tag: TASK }), scanned(2002, 2001, { tag: OTHER_TASK })])).toEqual([]);
    expect(plannedPids([main, scanned(2001, 1, { tag: TASK }), scanned(2002, 2001, { tag: TASK, workingDirectory: '/srv' })])).toEqual([]);
  });

  it('takes no evidence from a Windows console host, a child whose directory is unknown, or one whose environment is unreadable', () => {
    const processes = [
      main,
      // Measured on Windows: node and its conhost.exe, tagged, in C:\Windows.
      scanned(3560, 7744, { tag: TASK }),
      scanned(6656, 3560, { tag: TASK, role: 'console-host', workingDirectory: '/windows' }),
      // A zombie or setuid helper: no directory.
      scanned(3561, 3560, { tag: null, workingDirectory: null }),
      // A withheld Apple tool between two tagged processes, in the worktree.
      scanned(3562, 3560, { tag: null, environmentWithheld: true }),
      scanned(3563, 3562, { tag: TASK }),
    ];
    expect(plannedPids(processes)).toEqual([3560, 3562, 3563]);
  });
});

describe('planReap: protected, never killed, with everything under them', () => {
  it('a tmux server, which copies its environment into every later session (measured on Linux and macOS)', () => {
    const processes = [
      main,
      scanned(2662, 1, { tag: TASK, role: 'multiplexer' }),
      scanned(2663, 2662, { tag: TASK }),
      // A session the user opened later, from an untagged client, in the worktree.
      scanned(2667, 2662, { tag: TASK }),
      scanned(2670, 2662, { tag: TASK, workingDirectory: '/' }),
    ];
    expect(plannedPids(processes)).toEqual([]);
  });

  it('a visible app and everything under it: Chrome, its helpers and renderers, an editor', () => {
    const processes = [
      main,
      scanned(2950, 1, { tag: TASK, role: 'visible-app' }),
      scanned(2955, 2950, { tag: TASK }),
      scanned(2956, 2950, { tag: TASK }),
      scanned(7252, 3472, { tag: TASK, role: 'visible-app' }),
      // Chrome's crash handler is reparented to init: not under the app, and killed.
      scanned(2958, 1, { tag: TASK }),
    ];
    expect(plannedPids(processes)).toEqual([2958]);
  });

  it('a visible app under a dev server does not save the dev server', () => {
    const processes = [main, scanned(2001, 1, { tag: TASK }), scanned(2002, 2001, { tag: TASK, role: 'visible-app' })];
    expect(plannedPids(processes)).toEqual([2001]);
  });
});

describe('planReap, macOS withheld-environment orphans in the worktree', () => {
  function withheld(pid: number, ppid: number, workingDirectory: string | null): ScannedProcess {
    return scanned(pid, ppid, { environmentWithheld: true, workingDirectory });
  }

  it('kills a withheld orphan working in the worktree, and its descendants there, tagged or not', () => {
    const processes = [
      main,
      withheld(2001, 1, `${WORKTREE}/server`),
      scanned(2002, 2001, { tag: null, workingDirectory: `${WORKTREE}/server` }),
      withheld(2003, 1, WORKTREE),
    ];
    expect(plannedPids(processes)).toEqual([2001, 2002, 2003]);
  });

  it('leaves a withheld orphan in the project but outside the worktree, outside both, or with no directory, alone', () => {
    const processes = [
      main,
      withheld(2001, 1, PROJECT),
      withheld(2002, 1, '/home/dev'),
      withheld(2003, 1, `${WORKTREE}0`),
      withheld(2004, 1, null),
    ];
    expect(plannedPids(processes)).toEqual([]);
  });

  it('leaves a withheld process with a live parent alone: the user\'s own shell cd\'d into the worktree', () => {
    expect(plannedPids([main, scanned(300, 1, { tag: null }), withheld(301, 300, WORKTREE)])).toEqual([]);
  });

  it('spares a withheld orphan whose subtree holds another task\'s process', () => {
    expect(plannedPids([main, withheld(2001, 1, WORKTREE), scanned(2002, 2001, { tag: OTHER_TASK })])).toEqual([]);
  });

  it('spares a withheld orphan whose child cleared the tag, and reports the orphan as shared: the opt-out saves its parent', () => {
    const plan = detailed([
      main,
      withheld(2001, 1, WORKTREE),
      // A readable environment with the tag cleared on purpose, in the worktree.
      scanned(2002, 2001, { tag: '', workingDirectory: WORKTREE }),
    ]);
    expect(plan.targets).toEqual([]);
    expect(plan.roots).toEqual([]);
    expect(plan.kept.map((kept) => [kept.process.pid, kept.reason, kept.taskId])).toEqual([[2001, 'shared', TASK]]);
  });

  it('still takes an untagged child of a withheld orphan with it: no tag is not a cleared one', () => {
    const plan = detailed([
      main,
      withheld(2001, 1, WORKTREE),
      scanned(2002, 2001, { tag: null, workingDirectory: WORKTREE }),
    ]);
    expect(plan.targets.map((target) => target.pid)).toEqual([2001, 2002]);
    expect(plan.roots.map((root) => root.process.pid)).toEqual([2001]);
    expect(plan.kept).toEqual([]);
  });

  it('never collects a cleared-tag child through a withheld orphan, even when its own environment is unknown', () => {
    // Synthetic: no reader reports a cleared tag together with a withheld
    // environment. It keeps this on the collection filter alone, because the
    // shared check takes no evidence from a child whose environment is unknown.
    const plan = detailed([
      main,
      withheld(2001, 1, WORKTREE),
      scanned(2002, 2001, { tag: '', environmentWithheld: true, workingDirectory: WORKTREE }),
    ]);
    expect(plan.targets.map((target) => target.pid)).toEqual([2001]);
    expect(plan.kept).toEqual([]);
  });

  it('trusts a readable environment over the directory: untagged and cleared-tag orphans in the worktree survive', () => {
    expect(plannedPids([main, scanned(2001, 1, { tag: null }), scanned(2002, 1, { tag: '' })])).toEqual([]);
  });
});

describe('normalizeDirectory', () => {
  it('turns a long-path UNC prefix into the share it names, and a long-path drive prefix into the bare drive path', () => {
    expect(normalizeDirectory('\\\\?\\UNC\\srv\\share\\proj', false)).toBe('//srv/share/proj');
    expect(normalizeDirectory('\\\\?\\unc\\srv\\share\\proj', false)).toBe('//srv/share/proj');
    expect(normalizeDirectory('//?/UNC/srv/share/proj/', false)).toBe('//srv/share/proj');
    expect(normalizeDirectory('\\\\?\\C:\\Users\\dev\\project\\', false)).toBe('C:/Users/dev/project');
    // The plain forms are left as they are, apart from the separators and the trailing one.
    expect(normalizeDirectory('\\\\srv\\share\\proj', false)).toBe('//srv/share/proj');
    expect(normalizeDirectory('/home/dev/project/', false)).toBe('/home/dev/project');
  });

  it('reads the `\\\\.\\` device prefix as it reads `\\\\?\\`', () => {
    expect(normalizeDirectory('\\\\.\\UNC\\srv\\share\\proj', false)).toBe('//srv/share/proj');
    expect(normalizeDirectory('//./unc/srv/share/proj/', false)).toBe('//srv/share/proj');
    expect(normalizeDirectory('\\\\.\\C:\\Users\\dev\\project', false)).toBe('C:/Users/dev/project');
  });

  it('lowercases only when the file system ignores case', () => {
    expect(normalizeDirectory('\\\\?\\UNC\\SRV\\Share\\Proj', true)).toBe('//srv/share/proj');
    expect(normalizeDirectory('\\\\?\\UNC\\SRV\\Share\\Proj', false)).toBe('//SRV/Share/Proj');
  });
});

describe('isInsideDirectory', () => {
  it('accepts the root and below, never a prefix sibling, a filesystem root or a drive root', () => {
    expect(isInsideDirectory(WORKTREE, `${WORKTREE}/`)).toBe(true);
    expect(isInsideDirectory(`${WORKTREE}/a/b`, WORKTREE)).toBe(true);
    expect(isInsideDirectory(`${WORKTREE}-other`, WORKTREE)).toBe(false);
    expect(isInsideDirectory('/anything', '/')).toBe(false);
    expect(isInsideDirectory('C:\\anything', 'C:\\')).toBe(false);
    expect(isInsideDirectory('/anything', '')).toBe(false);
  });

  it('puts a share path inside its root whichever device prefix either one is written with', () => {
    expect(isInsideDirectory('\\\\srv\\share\\proj\\src', '\\\\.\\UNC\\srv\\share\\proj')).toBe(true);
    expect(isInsideDirectory('\\\\.\\UNC\\srv\\share\\proj\\src', '\\\\srv\\share\\proj')).toBe(true);
    expect(isInsideDirectory('\\\\.\\UNC\\srv\\share\\proj\\src', '\\\\?\\UNC\\srv\\share\\proj')).toBe(true);
    // Negative control: a sibling on the same share.
    expect(isInsideDirectory('\\\\srv\\share\\proj2', '\\\\.\\UNC\\srv\\share\\proj')).toBe(false);
  });

  it('is case-sensitive only when asked to be', () => {
    expect(isInsideDirectory('/Home/Dev/Project', '/home/dev/project', true)).toBe(true);
    expect(isInsideDirectory('/Home/Dev/Project', '/home/dev/project', false)).toBe(false);
  });
});

describe('buildProtectedPids', () => {
  it('protects main, its ancestors, and its live descendants, tagged or not', () => {
    const processes = [
      scanned(800, 1),
      scanned(900, 800),
      main,
      // The pty host, its PTY shell, and the agent under it: a live session.
      scanned(1100, MAIN_PID),
      scanned(1200, 1100, { tag: TASK }),
      scanned(1300, 1200, { tag: TASK }),
    ];
    const protectedPids = buildProtectedPids({ processes, mainPid: MAIN_PID, liveRootPids: [] });
    for (const pid of [800, 900, MAIN_PID, 1100, 1200, 1300]) expect(protectedPids.has(pid)).toBe(true);
    expect(plannedPids(processes)).toEqual([]);
  });

  it('protects a PTY root the host still holds, and its tree, even when main cannot reach it', () => {
    // A young PTY parked on its deferred kill: main nulled its handle, but the
    // host still holds it, and its agent carries the same tag as the leftovers.
    const processes = [
      main,
      scanned(3000, 2999, { tag: TASK }),
      scanned(3001, 3000, { tag: TASK }),
      scanned(4000, 1, { tag: TASK }),
    ];
    expect(plannedPids(processes, { liveRootPids: [3000] })).toEqual([4000]);
  });

  it('on Windows, does not follow a recycled ppid to a process older than its supposed parent', () => {
    // 5000 is a live process that recycled the pid of a dead launcher. 5001 is
    // the dead launcher's real child (older than 5000) and must not be adopted
    // into main's protected tree through 5000.
    const processes = [
      scanned(MAIN_PID, 900, { startedAtMs: 100, workingDirectory: '/home/dev' }),
      scanned(5000, MAIN_PID, { startedAtMs: 500 }),
      scanned(5001, 5000, { tag: TASK, startedAtMs: 200 }),
      scanned(5002, 5000, { tag: TASK, startedAtMs: 600 }),
    ];
    const protectedPids = buildProtectedPids({ processes, mainPid: MAIN_PID, liveRootPids: [] });
    expect(protectedPids.has(5001)).toBe(false);
    expect(protectedPids.has(5002)).toBe(true);
    expect(plannedPids(processes)).toEqual([5001]);
  });

  it('on Windows, does not treat an older process as the child of a tagged one through a recycled pid', () => {
    const processes = [
      scanned(MAIN_PID, 900, { startedAtMs: 100, workingDirectory: '/home/dev' }),
      scanned(6000, 1, { tag: TASK, startedAtMs: 900 }),
      // Its ppid names 6000, but it started before 6000 existed: not a child,
      // so neither killed with 6000 nor evidence that 6000 is shared.
      scanned(6001, 6000, { tag: null, startedAtMs: 300 }),
      scanned(6002, 6000, { tag: TASK, startedAtMs: 950 }),
    ];
    expect(plannedPids(processes)).toEqual([6000, 6002]);
  });
});

function detailed(processes: ScannedProcess[], options: { liveRootPids?: number[]; reaped?: Map<string, ReapTaskScope> } = {}) {
  return planReapDetailed({
    processes,
    tasks: options.reaped ?? tasks(),
    mainPid: MAIN_PID,
    liveRootPids: options.liveRootPids ?? [],
    caseInsensitivePaths: false,
  });
}

describe('planReapDetailed: what the report names', () => {
  it('names the top of each stopped tree once, never the processes under it', () => {
    const plan = detailed([
      main,
      // npm, the shell it ran, and vite under that: one dev server to the user.
      scanned(2001, 1, { tag: TASK }),
      scanned(2002, 2001, { tag: TASK }),
      scanned(2003, 2002, { tag: TASK }),
      scanned(2101, 1, { tag: TASK, workingDirectory: PROJECT }),
    ]);
    expect(plan.targets.map((target) => target.pid).sort()).toEqual([2001, 2002, 2003, 2101]);
    expect(plan.roots.map((root) => [root.process.pid, root.taskId])).toEqual([[2001, TASK], [2101, TASK]]);
  });

  it('names the task\'s own windows and tmux servers as left running, top only', () => {
    const plan = detailed([
      main,
      scanned(2001, 1, { tag: TASK, role: 'visible-app' }),
      // Linux GUI children map the toolkit too; the window's process is enough.
      scanned(2002, 2001, { tag: TASK, role: 'visible-app' }),
      scanned(2101, 1, { tag: TASK, role: 'multiplexer' }),
      // A pane in that server, which may be the user's own.
      scanned(2102, 2101, { tag: TASK }),
    ]);
    expect(plan.targets).toEqual([]);
    expect(plan.kept.map((kept) => [kept.process.pid, kept.reason])).toEqual([[2001, 'window'], [2101, 'multiplexer']]);
  });

  it('names a shared root as left running, and nothing under it', () => {
    const plan = detailed([
      main,
      // pm2's daemon, running the task's app and one the user started later.
      scanned(2001, 1, { tag: TASK }),
      scanned(2002, 2001, { tag: TASK }),
      scanned(2003, 2001, { tag: null }),
    ]);
    expect(plan.targets).toEqual([]);
    expect(plan.kept.map((kept) => [kept.process.pid, kept.reason, kept.taskId])).toEqual([[2001, 'shared', TASK]]);
  });

  it('still names a window the task opened from a dev server it stopped', () => {
    const plan = detailed([
      main,
      scanned(2001, 1, { tag: TASK }),
      scanned(2002, 2001, { tag: TASK, role: 'visible-app' }),
    ]);
    expect(plan.roots.map((root) => root.process.pid)).toEqual([2001]);
    expect(plan.kept.map((kept) => kept.process.pid)).toEqual([2002]);
  });

  it('never names Kangentic\'s tree, a held PTY, another task, or a window outside the task\'s directories', () => {
    const plan = detailed([
      main,
      scanned(2001, MAIN_PID, { tag: TASK, role: 'visible-app' }),
      scanned(3000, 7777, { tag: TASK, role: 'multiplexer' }),
      scanned(4001, 1, { tag: OTHER_TASK, role: 'visible-app' }),
      scanned(4002, 1, { tag: TASK, role: 'visible-app', workingDirectory: '/' }),
      scanned(4003, 1, { tag: null, role: 'visible-app' }),
    ], { liveRootPids: [3000] });
    expect(plan.kept).toEqual([]);
    expect(plan.roots).toEqual([]);
  });

  it('reports a macOS withheld orphan under the task whose worktree it works in', () => {
    const plan = detailed([
      main,
      scanned(2001, 1, { tag: null, environmentWithheld: true }),
    ]);
    expect(plan.roots.map((root) => [root.process.pid, root.taskId])).toEqual([[2001, TASK]]);
  });
});
