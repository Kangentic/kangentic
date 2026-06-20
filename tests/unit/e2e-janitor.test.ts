/**
 * Unit tests for the E2E leak janitor.
 *
 * Covers:
 *   - deriveMainRepoRoot: worktree path strips to the main checkout, main
 *     checkout returned unchanged, casing preserved on win32.
 *   - findLeakedTestInstances: worktree + build-entry direct matches, the
 *     closure pass for children, the orphan and self-skip gates, and the
 *     critical negative that the dogfooding argv is never matched.
 *   - sweepLeakedElectronInstances: never throws, logs each kill, survives a
 *     single kill failure, and skips the scan entirely on GitHub Actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deriveMainRepoRoot,
  findLeakedTestInstances,
  sweepLeakedElectronInstances,
  _internals,
} from '../e2e/electron-janitor';
import type { ProcessRow } from '../../src/main/git/zombie-reaper';

const isWindows = process.platform === 'win32';
const PROJECT_PATH = isWindows ? 'C:\\Users\\dev\\kangentic' : '/Users/dev/kangentic';
const pathSeparator = isWindows ? '\\' : '/';

function join(...segments: string[]): string {
  return segments.join(pathSeparator);
}

/**
 * The complete live-pid set derived from `rows`. Reproduces the pre-fix
 * behavior (livePids === pids-in-rows) so the matching/closure/skip cases below
 * keep asserting exactly what they did before the orphan gate took an explicit
 * complete live set. The new orphan-resolution cases pass an explicit `livePids`
 * that deliberately DIFFERS from `rows` to exercise the fix.
 */
function allPids(rows: ProcessRow[]): Set<number> {
  return new Set(rows.map((row) => row.pid));
}

/** Main process of a worktree-launched app. */
function worktreeMainCmd(slug: string, extra = ''): string {
  const exe = join(
    PROJECT_PATH, '.kangentic', 'worktrees', slug, 'node_modules', 'electron', 'dist', 'electron.exe',
  );
  return `${exe} ${exe.replace('electron.exe', 'index.js')} ${extra}`.trim();
}

/** A GPU/utility child of a worktree-launched app (carries the worktree exe). */
function worktreeChildCmd(slug: string, type: string): string {
  const exe = join(
    PROJECT_PATH, '.kangentic', 'worktrees', slug, 'node_modules', 'electron', 'dist', 'electron.exe',
  );
  return `${exe} --type=${type} --user-data-dir=whatever`;
}

/** Main process of a main-checkout Playwright E2E run. */
function buildEntryMainCmd(extra = ''): string {
  const exe = join(PROJECT_PATH, 'node_modules', 'electron', 'dist', 'electron.exe');
  const entry = join(PROJECT_PATH, '.vite', 'build', 'index.js');
  return `${exe} ${entry} --cwd=${PROJECT_PATH} ${extra}`.trim();
}

/** A child of a main-checkout E2E run (bare main electron exe, --type). */
function buildEntryChildCmd(type: string): string {
  const exe = join(PROJECT_PATH, 'node_modules', 'electron', 'dist', 'electron.exe');
  return `${exe} --type=${type} --user-data-dir=whatever`;
}

/** The dogfooding `npm start` main: bare directory arg, no build entry. */
function dogfoodingMainCmd(): string {
  const exe = join(PROJECT_PATH, 'node_modules', 'electron', 'dist', 'electron.exe');
  return `${exe} ${PROJECT_PATH} --cwd=${PROJECT_PATH}`;
}

/** A non-electron child (e.g. a PTY shell) of a leaked main. */
function ptyShellChildCmd(): string {
  return isWindows ? 'C:\\Windows\\System32\\cmd.exe /c echo hi' : '/bin/sh -c "echo hi"';
}

/** A Playwright worker process: node running the @playwright/test CLI, no electron path. */
function playwrightWorkerCmd(): string {
  const cli = join(PROJECT_PATH, 'node_modules', '@playwright', 'test', 'cli.js');
  return `node ${cli} run-worker`;
}

describe('deriveMainRepoRoot', () => {
  it('strips a worktree checkout path back to the main repo root', () => {
    const checkout = join(PROJECT_PATH, '.kangentic', 'worktrees', 'feature-abc-1234');
    expect(deriveMainRepoRoot(checkout)).toBe(PROJECT_PATH);
  });

  it('returns a main checkout path unchanged', () => {
    expect(deriveMainRepoRoot(PROJECT_PATH)).toBe(PROJECT_PATH);
  });

  it('preserves original casing in the returned slice on win32', () => {
    if (!isWindows) return;
    const mixedCase = 'C:\\Users\\Dev\\Kangentic';
    const checkout = join(mixedCase, '.kangentic', 'worktrees', 'feature-abc-1234');
    expect(deriveMainRepoRoot(checkout)).toBe(mixedCase);
  });
});

describe('findLeakedTestInstances', () => {
  it('matches an orphaned worktree main as worktree-instance', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: worktreeMainCmd('feature-abc-1234') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 200, reason: 'worktree-instance' });
  });

  it('closure-matches a worktree GPU child of a matched main', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: worktreeMainCmd('feature-abc-1234') },
      { pid: 201, ppid: 200, commandLine: worktreeChildCmd('feature-abc-1234', 'gpu-process') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    const child = result.find((leak) => leak.pid === 201);
    expect(child?.reason).toBe('child-of-leak');
  });

  it('closure is transitive (grandchild of a matched main)', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: worktreeMainCmd('feature-abc-1234') },
      { pid: 201, ppid: 200, commandLine: worktreeChildCmd('feature-abc-1234', 'gpu-process') },
      { pid: 202, ppid: 201, commandLine: worktreeChildCmd('feature-abc-1234', 'utility') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result.map((leak) => leak.pid).sort()).toEqual([200, 201, 202]);
  });

  it('matches an orphaned main-checkout E2E main as e2e-build-entry', () => {
    const rows: ProcessRow[] = [
      { pid: 300, ppid: 1, commandLine: buildEntryMainCmd() },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 300, reason: 'e2e-build-entry' });
  });

  it('closure-matches the children of a main-checkout E2E main', () => {
    const rows: ProcessRow[] = [
      { pid: 300, ppid: 1, commandLine: buildEntryMainCmd() },
      { pid: 301, ppid: 300, commandLine: buildEntryChildCmd('gpu-process') },
      { pid: 302, ppid: 300, commandLine: buildEntryChildCmd('utility') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result.map((leak) => leak.pid).sort()).toEqual([300, 301, 302]);
  });

  it('NEVER matches the dogfooding argv, even when orphaned', () => {
    const rows: ProcessRow[] = [
      { pid: 400, ppid: 1, commandLine: dogfoodingMainCmd() },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not match dogfooding children with a live parent', () => {
    const rows: ProcessRow[] = [
      { pid: 400, ppid: 100, commandLine: dogfoodingMainCmd() },
      { pid: 100, ppid: 1, commandLine: 'node scripts/dev.js' },
      { pid: 401, ppid: 400, commandLine: buildEntryChildCmd('gpu-process') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not match a worktree main with a live parent, nor its children', () => {
    const rows: ProcessRow[] = [
      { pid: 500, ppid: 50, commandLine: 'node playwright-worker' },
      { pid: 50, ppid: 1, commandLine: 'node cli.js' },
      { pid: 200, ppid: 500, commandLine: worktreeMainCmd('feature-abc-1234') },
      { pid: 201, ppid: 200, commandLine: worktreeChildCmd('feature-abc-1234', 'gpu-process') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not match a worktree path from a different checkout', () => {
    const otherRoot = isWindows ? 'C:\\Users\\dev\\other-app' : '/Users/dev/other-app';
    const exe = join(
      otherRoot, '.kangentic', 'worktrees', 'x', 'node_modules', 'electron', 'dist', 'electron.exe',
    );
    const rows: ProcessRow[] = [{ pid: 600, ppid: 1, commandLine: `${exe} ${exe}` }];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('skipPids suppresses a direct match and its closure', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: worktreeMainCmd('feature-abc-1234') },
      { pid: 201, ppid: 200, commandLine: worktreeChildCmd('feature-abc-1234', 'gpu-process') },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set([200]), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not closure-match a non-electron child of a matched main', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: worktreeMainCmd('feature-abc-1234') },
      { pid: 201, ppid: 200, commandLine: ptyShellChildCmd() },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result.map((leak) => leak.pid)).toEqual([200]);
  });

  it('ignores an empty commandLine', () => {
    const rows: ProcessRow[] = [{ pid: 700, ppid: 1, commandLine: '' }];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('never matches a Playwright worker, even orphaned', () => {
    // The worker's argv carries the @playwright CLI path but no electron module
    // path, so it fails both pass-1 needle conjunctions and (with no condemned
    // parent) the closure too.
    const rows: ProcessRow[] = [
      { pid: 900, ppid: 1, commandLine: playwrightWorkerCmd() },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(0);
  });

  it('does not closure-match a bare main-checkout child under a WORKTREE root (PID-reuse guard)', () => {
    // A dead worktree main's pid (200) is reused by a process whose own argv is
    // the bare main-checkout dogfooding main. Pass 2's bare-repo-electron branch
    // is restricted to build-entry roots, so this worktree-rooted closure must
    // NOT pull the bare-repo process in - dogfooding untouchability is absolute.
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 1, commandLine: worktreeMainCmd('feature-abc-1234') },
      { pid: 400, ppid: 200, commandLine: dogfoodingMainCmd() },
    ];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result.map((leak) => leak.pid)).toEqual([200]);
  });

  it('matches case-insensitively on win32', () => {
    if (!isWindows) return;
    const cmd = worktreeMainCmd('feature-abc-1234').replace('c:\\users\\dev', 'C:\\Users\\Dev');
    const rows: ProcessRow[] = [{ pid: 800, ppid: 1, commandLine: cmd }];
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), allPids(rows));
    expect(result).toHaveLength(1);
  });

  // Orphan-resolution layer: the cross-worktree-reap regression. The complete
  // `livePids` differs from the matching `rows` pids. The pre-fix code derived
  // livePids from rows, so it could not express these and would mis-kill the
  // first one. Bug #258.
  it('spares a live worktree main whose parent is absent from rows but in the complete live set', () => {
    // ppid 700 is the pwsh/cmd supervisor of another worktree's Playwright run.
    // The image-filtered matching scan never lists it, so it is absent from
    // `rows`; the complete liveness scan does, so it is in `livePids`.
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 700, commandLine: worktreeMainCmd('feature-abc-1234') },
    ];
    const livePids = new Set([200, 700]);
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toHaveLength(0);
  });

  it('still reaps a worktree main whose parent is absent from BOTH scans (truly dead)', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 700, commandLine: worktreeMainCmd('feature-abc-1234') },
    ];
    // 700 is dead: absent from the complete live set too.
    const livePids = new Set([200]);
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toMatchObject([{ pid: 200, reason: 'worktree-instance' }]);
  });

  it('spares a worktree child whose parent main is missing from rows but alive in the complete set', () => {
    // The main (pid 200) row was dropped from the filtered scan under load; only
    // its GPU child survives in `rows`. The main is alive per the complete scan.
    const rows: ProcessRow[] = [
      { pid: 201, ppid: 200, commandLine: worktreeChildCmd('feature-abc-1234', 'gpu-process') },
    ];
    const livePids = new Set([200, 201]);
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toHaveLength(0);
  });

  it('treats ppid <= 4 as orphan even when that pid is in the complete live set', () => {
    const rows: ProcessRow[] = [
      { pid: 200, ppid: 4, commandLine: worktreeMainCmd('feature-abc-1234') },
    ];
    // System pid 4 present in the live set must not flip the ppid > 4 clause.
    const livePids = new Set([200, 4]);
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toHaveLength(1);
  });

  it('never matches the dogfooding argv even with a non-enumerated live parent', () => {
    const rows: ProcessRow[] = [
      { pid: 400, ppid: 700, commandLine: dogfoodingMainCmd() },
    ];
    const livePids = new Set([400, 700]);
    const result = findLeakedTestInstances(rows, PROJECT_PATH, new Set(), livePids);
    expect(result).toHaveLength(0);
  });
});

describe('sweepLeakedElectronInstances', () => {
  // The orchestrator derives the real repo root from __dirname, so these tests
  // mock the (separately unit-tested) predicate and assert only the scan ->
  // find -> kill -> log wiring.
  let scanSpy: ReturnType<typeof vi.spyOn>;
  let liveSpy: ReturnType<typeof vi.spyOn>;
  let findSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scanSpy = vi.spyOn(_internals, 'scanProcesses');
    // Default to a non-empty complete live set so the existing happy-path cases
    // pass through the fail-safe gate unchanged.
    liveSpy = vi.spyOn(_internals, 'scanLivePids').mockResolvedValue(new Set([200, 300]));
    findSpy = vi.spyOn(_internals, 'findLeakedTestInstances');
    killSpy = vi.spyOn(_internals, 'killProcess').mockResolvedValue(undefined);
    // These tests run on CI, where GITHUB_ACTIONS=true would make the sweep
    // skip before scanning. Force it false so the scan/kill path is exercised;
    // the skip itself is covered by its own test below.
    vi.spyOn(_internals, 'isGitHubActions').mockReturnValue(false);
  });

  it('skips the scan entirely on GitHub Actions', async () => {
    vi.spyOn(_internals, 'isGitHubActions').mockReturnValue(true);

    await sweepLeakedElectronInstances('setup');

    expect(scanSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('resolves without throwing and kills nothing when the scan rejects', async () => {
    scanSpy.mockRejectedValue(new Error('powershell not found'));

    await expect(sweepLeakedElectronInstances('setup')).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('resolves without throwing and kills nothing when the complete liveness scan rejects', async () => {
    // Promise.all rejects when either leg rejects. The outer catch fires, the
    // predicate is never called, kill is never called, and the function resolves
    // undefined (fail closed). Mirrors the "scan rejects" test but exercises the
    // liveSpy rejection leg rather than the scanSpy one.
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 1, commandLine: 'electron' }]);
    liveSpy.mockRejectedValue(new Error('ps not found'));

    await expect(sweepLeakedElectronInstances('teardown')).resolves.toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills each leak and logs pid and reason', async () => {
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 1, commandLine: 'electron' }]);
    findSpy.mockReturnValue([
      { pid: 200, commandLine: 'electron.exe leaked', reason: 'worktree-instance' },
    ]);

    await sweepLeakedElectronInstances('teardown');

    expect(killSpy).toHaveBeenCalledWith(200);
    const killLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('killed pid=200'));
    expect(killLine).toContain('reason=worktree-instance');
  });

  it('continues sweeping when one kill fails', async () => {
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 1, commandLine: 'electron' }]);
    findSpy.mockReturnValue([
      { pid: 200, commandLine: 'a', reason: 'worktree-instance' },
      { pid: 300, commandLine: 'b', reason: 'e2e-build-entry' },
    ]);
    killSpy.mockRejectedValueOnce(new Error('access denied')).mockResolvedValueOnce(undefined);

    await sweepLeakedElectronInstances('teardown');

    expect(killSpy).toHaveBeenCalledTimes(2);
  });

  it('does not re-kill child-of-leak on win32 (covered by parent tree-kill); kills it on POSIX', async () => {
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 1, commandLine: 'electron' }]);
    findSpy.mockReturnValue([
      { pid: 200, commandLine: 'main', reason: 'worktree-instance' },
      { pid: 201, commandLine: 'child', reason: 'child-of-leak' },
    ]);

    await sweepLeakedElectronInstances('teardown');

    // The condemned main is always killed directly.
    expect(killSpy).toHaveBeenCalledWith(200);
    if (process.platform === 'win32') {
      // taskkill /T on pid 200 already reaped 201, so it is not re-killed.
      expect(killSpy).not.toHaveBeenCalledWith(201);
      const coveredLine = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('pid=201') && line.includes('child-of-leak'));
      expect(coveredLine).toContain('covered by parent');
    } else {
      // POSIX has no tree-kill, so the closure child must be killed directly.
      expect(killSpy).toHaveBeenCalledWith(201);
    }
  });

  it('aborts the sweep and kills nothing when the complete liveness scan returns empty', async () => {
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 1, commandLine: 'electron' }]);
    liveSpy.mockResolvedValue(new Set());
    findSpy.mockReturnValue([{ pid: 200, commandLine: 'x', reason: 'worktree-instance' }]);

    await sweepLeakedElectronInstances('setup');

    // Fail closed: never run the predicate, never kill, and say why.
    expect(findSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    const abortLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('aborting sweep'));
    expect(abortLine).toBeDefined();
  });

  it('passes the complete live set through to the predicate as the last arg', async () => {
    scanSpy.mockResolvedValue([{ pid: 201, ppid: 700, commandLine: 'electron' }]);
    liveSpy.mockResolvedValue(new Set([201, 700]));
    findSpy.mockReturnValue([]);

    await sweepLeakedElectronInstances('teardown');

    expect(findSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(Set),
      new Set([201, 700]),
    );
  });

  it('correlation-logs the resolved ppid and parent-absent fact for a kill', async () => {
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 700, commandLine: 'electron.exe leaked' }]);
    // 700 (the dead parent) is absent from the complete live set.
    liveSpy.mockResolvedValue(new Set([200]));
    findSpy.mockReturnValue([
      { pid: 200, commandLine: 'electron.exe leaked', reason: 'worktree-instance' },
    ]);

    await sweepLeakedElectronInstances('teardown');

    const killLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('killed pid=200'));
    expect(killLine).toContain('ppid=700');
    expect(killLine).toContain('parent-absent-from-live-scan=true');
  });

  it('logs parent-absent-from-live-scan=false when the resolved ppid IS present in the complete live set', async () => {
    // The scan row for pid 200 has ppid 700. liveSpy returns a set that includes
    // 700, so parentAbsent = !livePids.has(700) = false. The correlation log must
    // emit "parent-absent-from-live-scan=false". This exercises the false branch
    // of the parentAbsent computation (the existing test only covers the true branch).
    scanSpy.mockResolvedValue([{ pid: 200, ppid: 700, commandLine: 'electron.exe leaked' }]);
    liveSpy.mockResolvedValue(new Set([200, 700])); // 700 IS alive in the complete set
    findSpy.mockReturnValue([
      { pid: 200, commandLine: 'electron.exe leaked', reason: 'worktree-instance' },
    ]);

    await sweepLeakedElectronInstances('teardown');

    const killLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('killed pid=200'));
    expect(killLine).toContain('ppid=700');
    expect(killLine).toContain('parent-absent-from-live-scan=false');
  });
});
