/**
 * Unit tests for the zombie reaper (dev-only boot sweep + production
 * per-worktree reap).
 *
 * Covers:
 *   - Self-skip: own PID never killed
 *   - Parent-skip: walked parent chain never killed
 *   - Path matching: worktree path + main checkout path patterns
 *   - Per-worktree scoped match: specific worktree path, trailing-separator
 *     boundary, and the two needles a scan can see (command line, executable
 *     path) - plus the cwd case it deliberately cannot
 *   - The DELIBERATE absence of an orphan gate on the per-worktree reap, and the
 *     Windows-only subtree dedupe that replaces it
 *   - Negative match: unrelated electron processes left alone
 *   - Defensive aborts: scan failure / self-walk failure return [] cleanly
 *   - Scan caches: a burst of reaps shares one OS enumeration, and the filtered
 *     cache never answers an unfiltered request
 *   - Windows output shapes parsed from fixtures, so they are covered on the
 *     Linux CI runner where PowerShell and Win32_Process do not exist
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSelfSkipSet,
  commandLineReferencesPath,
  normalizePath,
  findZombies,
  findWorktreePathProcesses,
  findWorktreePathHolders,
  processImageName,
  describeHolder,
  parseProcessRowsFromJson,
  reapWorktreeElectronZombies,
  reapProcessesForWorktree,
  scanProcessesCached,
  scanAllProcessesCached,
  scanLivePids,
  parseLivePidsFromJson,
  parseLivePidsFromPs,
  __resetScanCacheForTest,
  _internals,
  type ProcessRow,
} from '../../src/main/git/zombie-reaper';

const PROJECT_PATH = process.platform === 'win32'
  ? 'C:\\Users\\dev\\kangentic'
  : '/Users/dev/kangentic';

function asWorktreeCmd(slug: string, extra = ''): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${PROJECT_PATH}${sep}.kangentic${sep}worktrees${sep}${slug}${sep}node_modules${sep}electron${sep}dist${sep}electron.exe ${extra}`.trim();
}

function worktreePathFor(slug: string): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${PROJECT_PATH}${sep}.kangentic${sep}worktrees${sep}${slug}`;
}

function asWorktreeNodeCmd(slug: string): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `node ${PROJECT_PATH}${sep}.kangentic${sep}worktrees${sep}${slug}${sep}scripts${sep}run-tests.js`;
}

function asMainCheckoutCmd(extra = ''): string {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${PROJECT_PATH}${sep}node_modules${sep}electron${sep}dist${sep}electron.exe ${extra}`.trim();
}

/**
 * The complete live-pid set derived from `rows`. Reproduces the pre-fix
 * behavior (livePids === pids-in-rows) so the existing findZombies cases keep
 * asserting exactly what they did. The orphan-resolution cases pass an explicit
 * `livePids` that deliberately differs from `rows`.
 */
function allPids(rows: ProcessRow[]): Set<number> {
  return new Set(rows.map((row) => row.pid));
}

describe('buildSelfSkipSet', () => {
  it('includes the current PID', () => {
    const rows: ProcessRow[] = [{ pid: 100, ppid: 50, commandLine: 'node main.js' }];
    const skip = buildSelfSkipSet(rows, 100);
    expect(skip.has(100)).toBe(true);
  });

  it('walks the parent chain', () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 50, commandLine: 'electron' },
      { pid: 50, ppid: 10, commandLine: 'npm' },
      { pid: 10, ppid: 1, commandLine: 'shell' },
    ];
    const skip = buildSelfSkipSet(rows, 100);
    expect(skip.has(100)).toBe(true);
    expect(skip.has(50)).toBe(true);
    expect(skip.has(10)).toBe(true);
    expect(skip.has(1)).toBe(false); // ppid <= 1 stops walk
  });

  it('does not loop on cycles', () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 50, commandLine: 'a' },
      { pid: 50, ppid: 100, commandLine: 'b' }, // cycle!
    ];
    const skip = buildSelfSkipSet(rows, 100);
    expect(skip.has(100)).toBe(true);
    expect(skip.has(50)).toBe(true);
    // No infinite loop, returns
  });
});

describe('findZombies', () => {
  it('matches a worktree-path electron process when parent is dead', () => {
    // ppid=1 (init/system) means parent died; this is a true orphan
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(result[0].reason).toBe('worktree-orphan');
  });

  it('matches a main-checkout electron process when parent is dead', () => {
    const rows: ProcessRow[] = [
      { pid: 300, ppid: 1, commandLine: asMainCheckoutCmd('--type=gpu-process') },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(300);
    expect(result[0].reason).toBe('main-checkout-orphan');
  });

  it('skips electron process when parent is still alive (sibling-process safety)', () => {
    // ppid=999 IS in the row list = parent alive = NOT a zombie. This
    // protects the dogfooding npm start window, concurrent Playwright
    // workers, and /preview instances from being killed.
    const rows: ProcessRow[] = [
      { pid: 999, ppid: 1, commandLine: 'npm start (live parent)' },
      { pid: 300, ppid: 999, commandLine: asMainCheckoutCmd('--type=gpu-process') },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('skips PIDs in the self-skip set', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
      { pid: 300, ppid: 1, commandLine: asMainCheckoutCmd() },
    ];
    const result = findZombies(rows, PROJECT_PATH, new Set([200, 300]), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not match an unrelated electron process from a different checkout', () => {
    const otherProject = process.platform === 'win32'
      ? 'C:\\Users\\dev\\some-other-app\\node_modules\\electron\\dist\\electron.exe'
      : '/Users/dev/some-other-app/node_modules/electron/dist/electron.exe';
    const rows: ProcessRow[] = [{ pid: 400, ppid: 1, commandLine: otherProject }];
    const result = findZombies(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not match an empty CommandLine', () => {
    const rows: ProcessRow[] = [{ pid: 500, ppid: 1, commandLine: '' }];
    const result = findZombies(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('case-insensitive match on Windows', () => {
    if (process.platform !== 'win32') return;
    const lowercased = asWorktreeCmd('feature-abc-1234').toLowerCase();
    const uppercased = lowercased.replace('c:\\users\\dev', 'C:\\Users\\Dev');
    const rows: ProcessRow[] = [{ pid: 600, ppid: 1, commandLine: uppercased }];
    const result = findZombies(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(1);
  });

  // Orphan-resolution layer: the boot sweep must also spare a live worktree app
  // from a concurrent run whose supervising parent is a non-enumerated image
  // (absent from the filtered matching scan, present in the complete live set).
  it('spares a worktree electron whose parent is absent from rows but in the complete live set', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 700, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const livePids = new Set([200, 700]);
    const result = findZombies(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toHaveLength(0);
  });

  it('still reaps a worktree electron whose parent is absent from BOTH scans (truly dead)', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 700, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const livePids = new Set([200]);
    const result = findZombies(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('worktree-orphan');
  });
});

describe('reapWorktreeElectronZombies', () => {
  let scanSpy: ReturnType<typeof vi.spyOn>;
  let liveSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // vi.spyOn reuses an existing spy on the same property - restore
    // first so each test gets a clean spy with no carried call history.
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    scanSpy = vi.spyOn(_internals, 'scanProcesses');
    // Spy the complete liveness scan so it never spawns a real process in unit
    // tests; default to a non-empty set so cases pass the fail-safe gate. The
    // orphans below all have ppid <= 4, which read as orphans regardless of the
    // set's contents, so any non-empty default works.
    liveSpy = vi.spyOn(_internals, 'scanLivePids').mockResolvedValue(new Set([1]));
    killSpy = vi.spyOn(_internals, 'killProcess').mockResolvedValue(undefined);
  });

  it('returns empty array when scan throws', async () => {
    scanSpy.mockRejectedValue(new Error('powershell not found'));

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when the complete liveness scan rejects', async () => {
    // Promise.all rejects when either leg rejects. The outer catch fires, kills
    // nothing, and returns [] (fail closed). This mirrors the "scan throws" test
    // but exercises the liveSpy rejection leg rather than the scanSpy one.
    scanSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);
    liveSpy.mockRejectedValue(new Error('ps not found'));

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when scan returns no rows', async () => {
    scanSpy.mockResolvedValue([]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('aborts and kills nothing when the complete liveness scan returns empty', async () => {
    // A would-be worktree-orphan is present, but the complete liveness scan
    // failed. Fail closed: kill nothing rather than treat everything as orphaned.
    scanSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);
    liveSpy.mockResolvedValue(new Set());

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills a worktree-orphan electron process', async () => {
    scanSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(200);
  });

  it('kills a main-checkout-orphan electron process', async () => {
    scanSpy.mockResolvedValue([
      { pid: 300, ppid: 1, commandLine: asMainCheckoutCmd('--type=gpu-process') },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(300);
    expect(killSpy).toHaveBeenCalledWith(300);
  });

  it('skips own PID even if it matches the path pattern', async () => {
    scanSpy.mockResolvedValue([
      { pid: process.pid, ppid: 1, commandLine: asMainCheckoutCmd() },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('skips parent PID even if it matches the path pattern', async () => {
    scanSpy.mockResolvedValue([
      { pid: process.pid, ppid: 9999, commandLine: 'node child' },
      { pid: 9999, ppid: 1, commandLine: asMainCheckoutCmd() },
    ]);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('continues sweeping when one kill fails', async () => {
    scanSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-1') },
      { pid: 201, ppid: 1, commandLine: asWorktreeCmd('feature-2') },
    ]);
    killSpy
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce(undefined);

    const result = await reapWorktreeElectronZombies({ projectPath: PROJECT_PATH });

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1); // only the successful kill
    expect(result[0].pid).toBe(201);
  });
});

describe('findWorktreePathProcesses', () => {
  const worktreePath = worktreePathFor('feature-abc-1234');

  it('matches an orphaned electron process under the specific worktree path', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(result[0].reason).toBe('worktree-path-orphan');
  });

  it('matches an orphaned node process under the worktree (not only electron)', () => {
    const rows: ProcessRow[] = [
      { pid: 210, ppid: 1, commandLine: asWorktreeNodeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(210);
  });

  it('does NOT match a prefix-sibling worktree (trailing-separator boundary)', () => {
    // worktrees/feature-abc-1234 must never match worktrees/feature-abc-1234-x.
    const rows: ProcessRow[] = [
      { pid: 220, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234-extra') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(0);
  });

  it('spares a supervised pinner (orphan gate), leaving it to the holder scan', () => {
    // The gate is kill-safety: this path can reach a process Kangentic never
    // spawned - a terminal left `cd`'d into the worktree, an editor. It is safe
    // to be this careful only because the session-end reap already ends what a
    // session started; see session-tree-reap.ts. The supervised case is not
    // dropped, it is NAMED - see the findWorktreePathHolders suite below.
    const rows: ProcessRow[] = [
      { pid: 999, ppid: 1, commandLine: 'bash run-functions.sh (live parent)' },
      { pid: 200, ppid: 999, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    expect(findWorktreePathProcesses(rows, worktreePath, new Set())).toHaveLength(0);
  });

  it('kills an orphan whose parent is dead, even under the unfiltered scan', () => {
    // The gate reads liveness from the rows it is given. Under the unfiltered
    // scan that set is COMPLETE, so a missing parent means genuinely dead rather
    // than merely un-enumerated - which is what makes the gate above trustworthy
    // instead of an accident of the electron/node filter.
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 999, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    expect(findWorktreePathProcesses(rows, worktreePath, new Set()).map((m) => m.pid))
      .toEqual([200]);
  });

  it('matches on executablePath when the command line carries no path at all', () => {
    // The reported incident's shape: `func.exe start --port 5003 --useHttps`.
    const rows: ProcessRow[] = [
      {
        pid: 230,
        ppid: 1,
        commandLine: 'func.exe start --port 5003 --useHttps',
        executablePath: `${worktreePath}${process.platform === 'win32' ? '\\' : '/'}tools${process.platform === 'win32' ? '\\' : '/'}func.exe`,
      },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result.map((match) => match.pid)).toEqual([230]);
  });

  it('cannot see a pinner that references the worktree only through its cwd', () => {
    // Not a gap to fix here: `Win32_Process` has no working-directory property,
    // so no scan can find this process after the fact. It is the exact shape of
    // the motivating incident, and the reason the session-end reap (which walks
    // the parent chain while the session still lives) is the primary mechanism
    // and this function is only the backstop.
    const rows: ProcessRow[] = [
      { pid: 240, ppid: 1, commandLine: 'func start --port 5003' },
    ];
    expect(findWorktreePathProcesses(rows, worktreePath, new Set())).toHaveLength(0);
  });
  it('skips PIDs in the self-skip set', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set([200]));
    expect(result).toHaveLength(0);
  });

  it('does not match an empty CommandLine', () => {
    const rows: ProcessRow[] = [{ pid: 200, ppid: 1, commandLine: '' }];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(0);
  });

  it('case-insensitive match on Windows', () => {
    if (process.platform !== 'win32') return;
    const uppercased = asWorktreeCmd('feature-abc-1234').replace('c:\\users\\dev', 'C:\\Users\\Dev');
    const rows: ProcessRow[] = [{ pid: 200, ppid: 1, commandLine: uppercased }];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
  });

  it('findZombies SPARES a row whose complete livePids includes the shell parent (boot-sweep safety)', () => {
    // Both entry points now resolve liveness against a COMPLETE set, so both
    // spare a supervised process. They used to diverge: findWorktreePathProcesses
    // was fed the electron/node-filtered rows, so a pwsh-parented pinner read as
    // an orphan and was killed. `scanAllProcesses` removed that divergence, which
    // is what let the orphan gate stay on the reap path honestly rather than by
    // accident. Bug #258 is the boot-sweep half of the same story.
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 888, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const completeLivePids = new Set([200, 888]); // 888 is the live shell parent
    const result = findZombies(rows, PROJECT_PATH, new Set(), completeLivePids);
    expect(result).toHaveLength(0);
  });
});

describe('findWorktreePathHolders', () => {
  const worktreePath = worktreePathFor('feature-abc-1234');

  it('names a LIVE supervised process that the orphan-gated finder skips', () => {
    // The discriminating case, and the reason this function exists. In the
    // incident it was written for, the directory was pinned by a dev server the
    // user had started, so it had a live parent and the reap named nothing
    // while the create hung with no explanation. Naming a process is not
    // killing one, so the kill-safety orphan gate does not apply.
    const rows: ProcessRow[] = [
      { pid: 999, ppid: 1, commandLine: 'supervisor' },
      { pid: 200, ppid: 999, commandLine: asWorktreeNodeCmd('feature-abc-1234') },
    ];

    expect(findWorktreePathProcesses(rows, worktreePath, new Set())).toHaveLength(0);

    const holders = findWorktreePathHolders(rows, worktreePath, new Set());
    expect(holders).toHaveLength(1);
    expect(holders[0].pid).toBe(200);
    expect(holders[0].image).toBe('node');
  });

  it('honors the trailing-separator boundary and the self-skip set', () => {
    const sibling: ProcessRow[] = [
      { pid: 220, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234-extra') },
    ];
    expect(findWorktreePathHolders(sibling, worktreePath, new Set())).toHaveLength(0);

    const own: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    expect(findWorktreePathHolders(own, worktreePath, new Set([200]))).toHaveLength(0);
    expect(findWorktreePathHolders(own, worktreePath, new Set())).toHaveLength(1);
  });

  it('does not match an empty command line', () => {
    const rows: ProcessRow[] = [{ pid: 200, ppid: 1, commandLine: '' }];
    expect(findWorktreePathHolders(rows, worktreePath, new Set())).toHaveLength(0);
  });

  it('names a holder found only by executablePath, so reporting is never narrower than the reap', () => {
    // The two must match on the same needles. A process we would kill but could
    // not name surfaces to the user as an unexplained removal failure.
    const separator = process.platform === 'win32' ? '\\' : '/';
    const byExe: ProcessRow[] = [{
      pid: 230,
      ppid: 1,
      commandLine: 'func.exe start --port 5003',
      executablePath: `${worktreePath}${separator}tools${separator}func.exe`,
    }];
    expect(findWorktreePathHolders(byExe, worktreePath, new Set()).map((h) => h.pid))
      .toEqual([230]);
  });
});

describe('commandLineReferencesPath', () => {
  // Found in a preview, not by reading the code: a live node.exe holding a
  // worktree was reported as `holders=none` because its path argument had no
  // trailing slash, so the trailing-separator needle never matched.
  const needle = `${normalizePath(worktreePathFor('feature-abc-1234'))}/`;

  it('matches a path naming the worktree ROOT at end of string', () => {
    const root = needle.slice(0, -1);
    expect(commandLineReferencesPath(`node -e "..." ${root}`, needle)).toBe(true);
  });

  it('matches the worktree ROOT followed by whitespace or a closing quote', () => {
    const root = needle.slice(0, -1);
    expect(commandLineReferencesPath(`code ${root} --wait`, needle)).toBe(true);
    expect(commandLineReferencesPath(`cmd /c cd "${root}"`, needle)).toBe(true);
  });

  it('still matches a path BELOW the worktree', () => {
    expect(commandLineReferencesPath(`node ${needle}server.js`, needle)).toBe(true);
  });

  it('still rejects a prefix-sibling worktree, which is what the separator is for', () => {
    const sibling = `${normalizePath(worktreePathFor('feature-abc-1234-extra'))}`;
    expect(commandLineReferencesPath(`node ${sibling}/server.js`, needle)).toBe(false);
    expect(commandLineReferencesPath(`node ${sibling}`, needle)).toBe(false);
  });

  it('does not match an unrelated path or an empty command line', () => {
    expect(commandLineReferencesPath('node /somewhere/else/server.js', needle)).toBe(false);
    expect(commandLineReferencesPath('', needle)).toBe(false);
  });

  it('terminates on a repeated near-miss instead of looping', () => {
    const sibling = `${normalizePath(worktreePathFor('feature-abc-1234-extra'))}`;
    expect(commandLineReferencesPath(`${sibling} ${sibling} ${sibling}`, needle)).toBe(false);
  });
});

describe('the root-reference fix reaches both halves of the reaper', () => {
  const worktreePath = worktreePathFor('feature-abc-1234');

  it('names AND (when orphaned) reaps a holder that references the worktree root', () => {
    // The reporting and killing paths must move together: a holder we would
    // kill but could not name surfaces as an unexplained removal failure.
    const rows: ProcessRow[] = [
      { pid: 250, ppid: 1, commandLine: `node -e "serve" ${worktreePath}` },
    ];
    expect(findWorktreePathHolders(rows, worktreePath, new Set()).map((h) => h.pid))
      .toEqual([250]);
    expect(findWorktreePathProcesses(rows, worktreePath, new Set()).map((m) => m.pid))
      .toEqual([250]);
  });
});

describe('processImageName / describeHolder', () => {
  it('takes the basename of the first token, quoted or not', () => {
    expect(processImageName('"C:\\Program Files\\nodejs\\node.exe" server.js')).toBe('node.exe');
    expect(processImageName('/usr/local/bin/node server.js')).toBe('node');
    expect(processImageName('node')).toBe('node');
    expect(processImageName('   ')).toBe('');
  });

  it('falls back to the pid alone when there is no readable image', () => {
    expect(describeHolder({ pid: 42, image: 'node.exe', commandLine: 'x' })).toBe('node.exe (pid 42)');
    expect(describeHolder({ pid: 42, image: '', commandLine: '' })).toBe('pid 42');
  });
});

describe('reapProcessesForWorktree', () => {
  const worktreePath = worktreePathFor('feature-abc-1234');
  let scanCachedSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetScanCacheForTest();
    // The UNFILTERED scan: a pinning dev server is rarely node or electron.
    scanCachedSpy = vi.spyOn(_internals, 'scanAllProcessesCached');
    killSpy = vi.spyOn(_internals, 'killProcess').mockResolvedValue(undefined);
  });

  it('kills an orphaned process pinning the worktree', async () => {
    scanCachedSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(killSpy).toHaveBeenCalledWith(200);
  });

  it('returns [] without killing when the scan throws', async () => {
    scanCachedSpy.mockRejectedValue(new Error('powershell not found'));

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('never kills own PID or the parent chain', async () => {
    scanCachedSpy.mockResolvedValue([
      { pid: process.pid, ppid: 9999, commandLine: asWorktreeCmd('feature-abc-1234') },
      { pid: 9999, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
    ]);

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(result).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('continues sweeping when one kill fails', async () => {
    scanCachedSpy.mockResolvedValue([
      { pid: 200, ppid: 1, commandLine: asWorktreeCmd('feature-abc-1234') },
      { pid: 201, ppid: 1, commandLine: asWorktreeNodeCmd('feature-abc-1234') },
    ]);
    killSpy
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValueOnce(undefined);

    const result = await reapProcessesForWorktree({ worktreePath });

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(201);
  });
});

describe('scanProcessesCached', () => {
  let scanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetScanCacheForTest();
    scanSpy = vi.spyOn(_internals, 'scanProcesses');
  });

  it('scans once for two calls within the TTL', async () => {
    scanSpy.mockResolvedValue([{ pid: 1, ppid: 0, commandLine: 'init' }]);

    const first = await scanProcessesCached(1500);
    const second = await scanProcessesCached(1500);

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not cache an empty (failed) scan', async () => {
    scanSpy.mockResolvedValueOnce([]);
    scanSpy.mockResolvedValueOnce([{ pid: 1, ppid: 0, commandLine: 'init' }]);

    const first = await scanProcessesCached(1500);
    const second = await scanProcessesCached(1500);

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(scanSpy).toHaveBeenCalledTimes(2);
  });

  it('does not let the filtered cache satisfy an unfiltered request', async () => {
    // The two caches are separate on purpose: a filtered scan answering an
    // unfiltered request would reintroduce the electron/node-only blind spot the
    // per-worktree reap exists to close.
    scanSpy.mockResolvedValue([{ pid: 1, ppid: 0, commandLine: 'init' }]);
    const allScanSpy = vi.spyOn(_internals, 'scanAllProcesses')
      .mockResolvedValue([{ pid: 2, ppid: 0, commandLine: 'func.exe start' }]);

    await scanProcessesCached(1500);
    const unfiltered = await scanAllProcessesCached(1500);

    expect(allScanSpy).toHaveBeenCalledTimes(1);
    expect(unfiltered.map((row) => row.pid)).toEqual([2]);
  });
});

/**
 * The Windows shapes, covered on Linux CI where neither PowerShell nor
 * `Win32_Process` exists. The cases below are hand-authored to isolate one
 * shape each; `the real captured format` at the end replays bytes captured from
 * a Windows host, which is what pins the format itself.
 */
describe('parseProcessRowsFromJson', () => {
  it('parses an array of rows including ExecutablePath', () => {
    const rows = parseProcessRowsFromJson(JSON.stringify([
      { ProcessId: 100, ParentProcessId: 4, CommandLine: 'a.exe', ExecutablePath: 'C:\\a\\a.exe' },
      { ProcessId: 200, ParentProcessId: 100, CommandLine: 'b.exe', ExecutablePath: 'C:\\b\\b.exe' },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0].executablePath).toBe('C:\\a\\a.exe');
    expect(rows[1].ppid).toBe(100);
  });

  it('accepts the single-row object form PowerShell emits for one match', () => {
    const rows = parseProcessRowsFromJson(JSON.stringify(
      { ProcessId: 100, ParentProcessId: 4, CommandLine: 'a.exe', ExecutablePath: 'C:\\a\\a.exe' },
    ));
    expect(rows.map((row) => row.pid)).toEqual([100]);
  });

  it('leaves executablePath undefined when the field is null, not empty string', () => {
    // A protected process returns null. Undefined means "unknown", which the
    // matcher must not read as "not under the needle".
    const rows = parseProcessRowsFromJson(JSON.stringify(
      [{ ProcessId: 100, ParentProcessId: 4, CommandLine: null, ExecutablePath: null }],
    ));
    expect(rows[0].executablePath).toBeUndefined();
    expect(rows[0].commandLine).toBe('');
  });

  it('drops a row with no ProcessId rather than losing the whole scan', () => {
    const rows = parseProcessRowsFromJson(JSON.stringify([
      { ParentProcessId: 4, CommandLine: 'orphaned row' },
      { ProcessId: 200, ParentProcessId: 4, CommandLine: 'good row' },
    ]));
    expect(rows.map((row) => row.pid)).toEqual([200]);
  });

  it('returns [] on empty or malformed stdout', () => {
    expect(parseProcessRowsFromJson('')).toEqual([]);
    expect(parseProcessRowsFromJson('{ truncated')).toEqual([]);
  });

  /**
   * The shape tests above are hand-authored, so they only prove the parser
   * handles what we BELIEVE PowerShell emits. This one replays bytes actually
   * captured from `Get-CimInstance Win32_Process | Select-Object
   * ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json
   * -Compress` on a Windows 11 host, so property casing, null encoding, and the
   * array-vs-object top level are pinned to the real format rather than to our
   * reading of it. Line 1 of the fixture is the multi-row capture, line 2 the
   * single-row capture. Rows are vendor and system processes only, no user
   * paths. If PowerShell ever changes the shape, re-capture the fixture and this
   * test names the drift the same day.
   */
  describe('the real captured format', () => {
    const fixtureLines = fs
      .readFileSync(path.join(__dirname, '..', 'fixtures', 'win32-process-rows.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '');

    it('parses the captured multi-row array', () => {
      const rows = parseProcessRowsFromJson(fixtureLines[0]);

      expect(rows.map((row) => row.pid)).toEqual([4, 7568, 7592, 9448]);
      expect(rows.map((row) => row.ppid)).toEqual([0, 6168, 7220, 9304]);
      // A System process reports both string fields as JSON null. Undefined
      // means "unknown", which the matcher must not read as "not under the
      // needle"; an empty commandLine is what the matcher skips on.
      expect(rows[0].executablePath).toBeUndefined();
      expect(rows[0].commandLine).toBe('');
      // A quoted path with spaces, and an argument carrying a pipe name, both
      // survive intact - the matcher normalizes, it does not tokenize.
      expect(rows[2].commandLine).toContain('"C:\\Program Files\\Microsoft GameInput');
      expect(rows[2].commandLine).toContain('\\\\.\\pipe\\GameInputServiceSession');
      expect(rows[2].executablePath).toBe('C:\\Program Files\\Microsoft GameInput\\x64\\GameInputRedistService.exe');
      // An image-name-only command line still resolves its path via
      // ExecutablePath, which is the second needle the matcher checks.
      expect(rows[3].commandLine).toBe('ZSATray.exe');
      expect(rows[3].executablePath).toBe('C:\\Program Files\\Zscaler\\ZSATray\\ZSATray.exe');
    });

    it('parses the captured single-row object, which PowerShell does not wrap in an array', () => {
      expect(fixtureLines[1].startsWith('{')).toBe(true);
      const rows = parseProcessRowsFromJson(fixtureLines[1]);

      expect(rows).toHaveLength(1);
      expect(rows[0].pid).toBe(9448);
      expect(rows[0].ppid).toBe(9304);
      expect(rows[0].executablePath).toBe('C:\\Program Files\\Zscaler\\ZSATray\\ZSATray.exe');
    });

    it('finds a captured row as a holder when the worktree is its executable path', () => {
      // End to end through the real bytes: parse, then match. Proves the parsed
      // shape is what `findWorktreePathHolders` actually consumes, not just that
      // the fields are populated.
      const rows = parseProcessRowsFromJson(fixtureLines[0]);
      const holders = findWorktreePathHolders(rows, 'C:\\Program Files\\Zscaler\\ZSATray', new Set());

      expect(holders.map((holder) => holder.pid)).toEqual([9448]);
      expect(holders[0].image).toBe('ZSATray.exe');
    });
  });
});

describe('parseLivePidsFromJson', () => {
  // The win32 live-pid parse, extracted pure so all the ConvertTo-Json shapes
  // are testable on Linux CI without spawning PowerShell.
  it('parses an array of bare integers', () => {
    expect(parseLivePidsFromJson('[123,456]')).toEqual(new Set([123, 456]));
  });

  it('parses a single bare integer (ConvertTo-Json emits a scalar for one row)', () => {
    expect(parseLivePidsFromJson('789')).toEqual(new Set([789]));
  });

  it('parses a single wrapped { ProcessId } object', () => {
    expect(parseLivePidsFromJson('{"ProcessId":789}')).toEqual(new Set([789]));
  });

  it('parses an array of wrapped { ProcessId } objects', () => {
    expect(parseLivePidsFromJson('[{"ProcessId":1},{"ProcessId":2}]')).toEqual(new Set([1, 2]));
  });

  it('skips non-numeric ProcessId values', () => {
    expect(parseLivePidsFromJson('[{"ProcessId":"x"},{"ProcessId":5}]')).toEqual(new Set([5]));
  });

  it('returns an empty Set for truncated/malformed JSON (fails closed)', () => {
    expect(parseLivePidsFromJson('[123,')).toEqual(new Set());
  });

  it('returns an empty Set for empty input', () => {
    expect(parseLivePidsFromJson('')).toEqual(new Set());
  });
});

describe('parseLivePidsFromPs', () => {
  // The POSIX live-pid parse, extracted pure so the ps output shapes are
  // testable on any platform (including Windows CI) without spawning ps.
  // Mirrors the parseLivePidsFromJson describe block for the win32 path.

  it('parses normal multi-line integer output', () => {
    expect(parseLivePidsFromPs('  123\n  456\n  789\n')).toEqual(new Set([123, 456, 789]));
  });

  it('handles leading-whitespace lines (ps indents pids on some platforms)', () => {
    // ps -ax -o pid= emits right-aligned pid fields with leading spaces.
    expect(parseLivePidsFromPs('   42\n  100\n')).toEqual(new Set([42, 100]));
  });

  it('skips pure-whitespace and empty lines', () => {
    expect(parseLivePidsFromPs('\n   \n100\n\n')).toEqual(new Set([100]));
  });

  it('skips non-numeric lines without throwing', () => {
    // A corrupt ps line should be silently dropped, not cause a throw.
    expect(parseLivePidsFromPs('abc\n123\nxyz\n456\n')).toEqual(new Set([123, 456]));
  });

  it('returns an empty Set for empty input', () => {
    expect(parseLivePidsFromPs('')).toEqual(new Set());
  });
});

describe('scanLivePids', () => {
  // End-to-end smoke: a real platform scan (Get-CimInstance on win32, ps on
  // POSIX) must enumerate the running test process. Generous timeout so a loaded
  // machine does not flake the assertion.
  it('returns a non-empty set that includes the current process', async () => {
    const live = await scanLivePids(5000);
    expect(live).toBeInstanceOf(Set);
    expect(live.has(process.pid)).toBe(true);
  });
});
