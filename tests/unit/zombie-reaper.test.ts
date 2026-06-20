/**
 * Unit tests for the zombie reaper (dev-only boot sweep + production
 * per-worktree reap).
 *
 * Covers:
 *   - Self-skip: own PID never killed
 *   - Parent-skip: walked parent chain never killed
 *   - Path matching: worktree path + main checkout path patterns
 *   - Per-worktree scoped match: specific worktree path, trailing-separator
 *     boundary, orphan gate, node-and-electron processes
 *   - Negative match: unrelated electron processes left alone
 *   - Defensive aborts: scan failure / self-walk failure return [] cleanly
 *   - Scan cache: a burst of reaps shares one OS enumeration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSelfSkipSet,
  findZombies,
  findWorktreePathProcesses,
  reapWorktreeElectronZombies,
  reapProcessesForWorktree,
  scanProcessesCached,
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

  it('skips a process whose parent is still alive (orphan gate)', () => {
    const rows: ProcessRow[] = [
      { pid: 999, ppid: 1, commandLine: 'playwright worker (live parent)' },
      { pid: 200, ppid: 999, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(0);
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

  // Design-intent contrast: findWorktreePathProcesses uses NARROW liveness
  // (livePids derived from rows only), while findZombies takes an EXPLICIT
  // COMPLETE livePids. This is deliberate: the Done-move reap must still end
  // a shell-parented pinner (e.g. a pwsh.exe parent not enumerated in the
  // electron/node-only rows), whereas the boot sweep must spare a live app
  // from a concurrent worktree whose supervising parent is non-enumerated.
  // Bug #258 fixed the boot sweep; the Done-move path is intentionally unchanged.
  it('reaps a shell-parented pinner whose ppid is absent from the rows-derived live set (deliberate narrow liveness)', () => {
    // ppid=888 is a pwsh.exe supervisor; it is NOT in rows (the scan filters to
    // electron.exe/node.exe only on Windows), so it is absent from the internal
    // livePids. findWorktreePathProcesses treats it as dead => reaps the pinner.
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 888, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const result = findWorktreePathProcesses(rows, worktreePath, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
    expect(result[0].reason).toBe('worktree-path-orphan');
  });

  it('findZombies SPARES the same row when the complete livePids includes the shell parent (boot-sweep safety)', () => {
    // Contrast with the narrow-liveness test above: if we pass the SAME row to
    // findZombies with a complete livePids that includes ppid=888, the boot sweep
    // correctly spares the process (it is not a true orphan). This documents the
    // intentional design divergence between the two entry points.
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 888, commandLine: asWorktreeCmd('feature-abc-1234') },
    ];
    const completeLivePids = new Set([200, 888]); // 888 is the live shell parent
    const result = findZombies(rows, PROJECT_PATH, new Set(), completeLivePids);
    expect(result).toHaveLength(0);
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
    scanCachedSpy = vi.spyOn(_internals, 'scanProcessesCached');
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
