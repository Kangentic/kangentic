/**
 * Orphaned-process reaper. Two entry points share one scan/skip/kill core
 * (the E2E leak janitor in tests/e2e/electron-janitor.ts is a third consumer
 * of the core primitives - scanProcesses, buildSelfSkipSet, killProcess,
 * normalizePath - with its own leak predicate):
 *
 *   1. `reapWorktreeElectronZombies` - DEV-ONLY boot-time sweep. Scans for
 *      orphaned Electron processes whose CommandLine references this checkout's
 *      worktree node_modules or main checkout node_modules. Triggered before
 *      pruneStaleWorktreeProjects so any zombie holding a worktree directory's
 *      file handles (or a stale OpenSSH ControlMaster socket that blocks `git
 *      fetch`) gets cleared before the next instance reuses those resources.
 *      Wired only inside `if (__KANGENTIC_DEV__)` blocks and dropped from
 *      production builds via esbuild dead-code elimination. Production NSIS
 *      installs run from %LOCALAPPDATA%\Kangentic and never match the
 *      worktree/checkout path patterns it looks for, so it would be a no-op.
 *
 *   2. `reapProcessesForWorktree` - PRODUCTION per-worktree reap, called LAZILY
 *      on the failure path of a worktree removal (`WorktreeManager.removeWorktree`):
 *      only a delete that a held handle actually blocked runs this scan, so a
 *      clean Done-move never pays for it. Scans for orphaned processes pinning the
 *      SPECIFIC worktree path being deleted, kills them, and lets the caller retry
 *      the removal. Unlike the boot sweep this ships in all builds: a user's agent
 *      can leave a zombie Electron/node behind (E2E `_electron.launch()`,
 *      `/preview`) just as a developer's can, and the worktree-path needle is
 *      precise enough that production processes (which never run from a
 *      `.kangentic/worktrees/` path) can never match.
 *
 * Safety contract for the TWO ENTRY POINTS IN THIS MODULE (the E2E leak janitor
 * in tests/e2e/electron-janitor.ts defines its OWN contract: same self-skip and
 * a pass-1 orphan gate, but its closure pass deliberately kills LIVE children of
 * already-condemned parents to match Windows `taskkill /T` on POSIX - see that
 * file's header):
 *   - Self-skip: own PID and walked parent PIDs are never killed.
 *   - Orphan gate: a process whose parent is still alive is never killed (it is
 *     actively supervised - a live Playwright worker, the dogfooding `npm start`
 *     window, a `/preview` window). See `hasLiveParent`. The boot sweep
 *     (`reapWorktreeElectronZombies`) resolves liveness against the COMPLETE
 *     `scanLivePids` set (every process image), so a live app from a concurrent
 *     worktree whose supervising parent is a non-enumerated image is correctly
 *     spared (bug #258). The per-worktree Done-move reap
 *     (`findWorktreePathProcesses`) DELIBERATELY keeps the narrow electron/node
 *     liveness so it can still end a shell-parented pinner - see that function's
 *     header.
 *   - Path needle: only processes whose CommandLine references the matched path
 *     are candidates. The per-worktree needle carries a trailing separator so
 *     `worktrees/foo` never matches `worktrees/foo-bar`.
 *   - Defensive: any scan/walk failure aborts the reaper with an empty return
 *     (including an empty complete-liveness scan, which would otherwise read
 *     every process as orphaned), so a broken `Get-CimInstance` can never
 *     escalate into a wrong-process kill.
 *   - Time-capped: `scanTimeoutMs` bounds the OS-level enumeration (boot sweep
 *     1500ms; per-worktree 5000ms, since a cold PowerShell `Get-CimInstance`
 *     start often exceeds 1500ms - the too-tight cap is why a prior incident's
 *     app restart failed to clear the zombies).
 */

import { spawn, type SpawnOptions } from 'node:child_process';

export interface ZombieScanOptions {
  /** Filesystem root to match orphan paths against (worktrees + node_modules). */
  projectPath: string;
  /** Time cap on the OS-level enumeration. Default 1500ms. */
  scanTimeoutMs?: number;
}

export interface ReapedProcess {
  pid: number;
  commandLine: string;
  reason: 'worktree-orphan' | 'main-checkout-orphan' | 'worktree-path-orphan';
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  commandLine: string;
}

/** Options for the per-worktree production reap. */
export interface WorktreeReapOptions {
  /** Absolute path of the worktree being removed. */
  worktreePath: string;
  /**
   * Time cap on the OS-level enumeration. Default 5000ms - higher than the boot
   * sweep's 1500ms because a cold PowerShell `Get-CimInstance` start can exceed
   * that and silently return no rows.
   */
  scanTimeoutMs?: number;
}

const DEFAULT_SCAN_TIMEOUT_MS = 1500;
const DEFAULT_WORKTREE_SCAN_TIMEOUT_MS = 5000;

/**
 * Short-lived cache of the last successful process scan. The startup retry pass
 * reaps once per Done-task in a loop (each a separate `removeWorktree` ->
 * `reapProcessesForWorktree` scan), so a 5s TTL collapses that burst to a single
 * PowerShell invocation. Empty/failed scans are never cached: a cold-start
 * timeout must not poison the next 5s.
 */
let cachedScan: { rows: ProcessRow[]; capturedAt: number } | null = null;
const SCAN_CACHE_TTL_MS = 5_000;

/**
 * Normalize a path for case-insensitive substring comparison on Windows
 * and forward-slash matching on every platform. Returns lowercase on
 * Windows, original case elsewhere.
 */
export function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * True when `row`'s parent is still alive in this scan. The orphan gate of every
 * pass-1 matcher (here and in the E2E janitor): a live parent means the process
 * is actively supervised and must not be killed. `ppid <= 4` covers init/system
 * on every platform (1 on Unix, 0/4 on Windows for System/csrss), so such a
 * parent is treated as "not a real supervisor" rather than alive.
 */
export function hasLiveParent(row: ProcessRow, livePids: Set<number>): boolean {
  return row.ppid > 4 && livePids.has(row.ppid);
}

/**
 * Scan running processes via the platform-native enumerator. Returns an
 * empty array on any failure so the reaper degrades to a no-op rather
 * than throwing during boot.
 *
 * Exposed for unit-test replacement via the `_internals` export below.
 */
export async function scanProcesses(scanTimeoutMs: number): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    return scanProcessesWindows(scanTimeoutMs);
  }
  return scanProcessesUnix(scanTimeoutMs);
}

/**
 * Enumerate the pids of EVERY live process (not just electron/node) into the set
 * the orphan gate consults as its source of truth. The matching scan
 * (`scanProcesses`) is image-filtered for speed because only electron/node argv
 * carries our path needles, but the LIVENESS check must see every image: a live
 * process whose parent is a non-enumerated image (a `pwsh.exe`/`cmd.exe`
 * supervisor of another worktree's Playwright run) otherwise reads as an orphan
 * and is wrongly killed. On POSIX `ps -ax` already lists every process, so this
 * brings Windows to parity rather than adding new behavior there.
 *
 * Returns an empty Set on any failure (timeout, non-zero exit, parse error,
 * empty stdout). Callers MUST treat an empty Set as "scan failed" and refuse to
 * kill, because an empty live set makes every process read as orphaned.
 *
 * Exposed for unit-test replacement via the `_internals` export below.
 */
export async function scanLivePids(scanTimeoutMs: number): Promise<Set<number>> {
  if (process.platform === 'win32') {
    return scanLivePidsWindows(scanTimeoutMs);
  }
  return scanLivePidsUnix(scanTimeoutMs);
}

async function scanLivePidsWindows(scanTimeoutMs: number): Promise<Set<number>> {
  // Unfiltered, single-column projection: every live pid, no CommandLine. Far
  // cheaper to serialize than the matching scan, so far less likely to truncate
  // under load. Keep it a single `ConvertTo-Json -Compress` document: a
  // truncated stream then fails JSON.parse and degrades to an empty Set (caller
  // fails closed) rather than yielding a partial-but-valid set that silently
  // drops a parent. Do NOT switch to streaming / per-object output.
  const psCommand =
    'Get-CimInstance Win32_Process ' +
    '| Select-Object ProcessId ' +
    '| ConvertTo-Json -Compress';
  let stdout: string;
  try {
    stdout = await runCommandWithTimeout(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { timeoutMs: scanTimeoutMs, windowsHide: true },
    );
  } catch {
    return new Set();
  }
  return parseLivePidsFromJson(stdout);
}

async function scanLivePidsUnix(scanTimeoutMs: number): Promise<Set<number>> {
  let stdout: string;
  try {
    stdout = await runCommandWithTimeout('ps', ['-ax', '-o', 'pid='], { timeoutMs: scanTimeoutMs });
  } catch {
    return new Set();
  }
  return parseLivePidsFromPs(stdout);
}

/**
 * Parse the stdout of the POSIX live-pid scan (`ps -ax -o pid=`) into a set of
 * pids. Pure and extracted so the line-parse logic is unit-testable on any
 * platform without spawning `ps`. Mirrors `parseLivePidsFromJson` for the win32
 * path. Each line is a whitespace-trimmed integer; empty lines, whitespace-only
 * lines, and non-numeric lines are skipped. Returns an empty Set on empty input;
 * never throws.
 */
export function parseLivePidsFromPs(stdout: string): Set<number> {
  const result = new Set<number>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isFinite(pid)) result.add(pid);
  }
  return result;
}

/**
 * Parse the stdout of the Windows live-pid scan into a set of pids. Pure and
 * extracted so the win32 JSON shapes are unit-testable on Linux CI without
 * spawning PowerShell. The `Select-Object ProcessId` pipeline emits a single
 * `{ ProcessId }` object for one row or an array of them for many; the parser
 * also accepts a bare integer or an array of bare integers defensively. Returns
 * an empty Set on empty or malformed input; never throws.
 */
export function parseLivePidsFromJson(stdout: string): Set<number> {
  const result = new Set<number>();
  if (!stdout) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return result;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (typeof item === 'number') {
      if (Number.isFinite(item)) result.add(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const candidate = (item as { ProcessId?: unknown }).ProcessId;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        result.add(candidate);
      }
    }
  }
  return result;
}

/**
 * `scanProcesses` with a 5s TTL cache. Returns the cached rows when fresh,
 * otherwise scans and stores the result. A scan that returns no rows (failure
 * or genuinely empty) is not cached, so a transient failure does not suppress
 * the next 5s of reaps.
 */
export async function scanProcessesCached(scanTimeoutMs: number): Promise<ProcessRow[]> {
  if (cachedScan && Date.now() - cachedScan.capturedAt < SCAN_CACHE_TTL_MS) {
    return cachedScan.rows;
  }
  const rows = await _internals.scanProcesses(scanTimeoutMs);
  if (rows.length > 0) {
    cachedScan = { rows, capturedAt: Date.now() };
  }
  return rows;
}

/** Test-only: clear the scan cache between cases. */
export function __resetScanCacheForTest(): void {
  cachedScan = null;
}

async function scanProcessesWindows(scanTimeoutMs: number): Promise<ProcessRow[]> {
  // Filter to electron.exe + node.exe only. CommandLine includes the full
  // arg vector with paths, which is what we substring-match against.
  // ConvertTo-Json -Compress to keep stdout small.
  const psCommand =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='node.exe'\" " +
    "| Select-Object ProcessId,ParentProcessId,CommandLine " +
    "| ConvertTo-Json -Compress";
  const stdout = await runCommandWithTimeout(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { timeoutMs: scanTimeoutMs, windowsHide: true },
  );
  if (!stdout) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: ProcessRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const typedRow = row as {
      ProcessId?: number;
      ParentProcessId?: number;
      CommandLine?: string | null;
    };
    if (typeof typedRow.ProcessId !== 'number') continue;
    result.push({
      pid: typedRow.ProcessId,
      ppid: typeof typedRow.ParentProcessId === 'number' ? typedRow.ParentProcessId : 0,
      commandLine: typeof typedRow.CommandLine === 'string' ? typedRow.CommandLine : '',
    });
  }
  return result;
}

async function scanProcessesUnix(scanTimeoutMs: number): Promise<ProcessRow[]> {
  // `ps -ax` lists every process; `-o pid=,ppid=,command=` strips headers and
  // separates fields with whitespace. command= is last so it can contain spaces.
  const stdout = await runCommandWithTimeout(
    'ps',
    ['-ax', '-o', 'pid=,ppid=,command='],
    { timeoutMs: scanTimeoutMs },
  );
  if (!stdout) return [];
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, command] = match;
    rows.push({
      pid: Number.parseInt(pidStr, 10),
      ppid: Number.parseInt(ppidStr, 10),
      commandLine: command,
    });
  }
  return rows;
}

/**
 * Build the set of PIDs that must NEVER be killed: own PID + walked
 * parent chain. The walk follows ppid pointers up to a depth ceiling to
 * avoid infinite loops on corrupt data.
 */
export function buildSelfSkipSet(rows: ProcessRow[], ownPid: number): Set<number> {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);

  const skip = new Set<number>([ownPid]);
  let cursor = byPid.get(ownPid);
  let depth = 0;
  while (cursor && depth < 32) {
    if (skip.has(cursor.ppid)) break;
    if (cursor.ppid <= 1) break;
    skip.add(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
    depth += 1;
  }
  return skip;
}

/**
 * Filter the process list to actual zombie candidates. A process matches
 * when its CommandLine substring contains EITHER the worktree pattern
 * (preview / Playwright orphans) OR the main-checkout pattern (normal
 * `npm run dev` shutdown leaks) AND the process is genuinely orphaned
 * (parent is dead or init).
 *
 * The orphan check is critical for cross-process safety: without it the
 * reaper would kill SIBLING electron instances (concurrent Playwright
 * runs, the dogfooding `npm start` window, /preview windows). Only
 * processes whose parent has terminated are true zombies that warrant
 * cleanup.
 *
 * `livePids` MUST be the COMPLETE set of live pids (from `scanLivePids`), not
 * the electron/node-only matching scan: a live process whose supervising parent
 * is a non-enumerated image otherwise reads as an orphan and is wrongly killed.
 */
export function findZombies(
  rows: ProcessRow[],
  projectPath: string,
  skipPids: Set<number>,
  livePids: Set<number>,
): ReapedProcess[] {
  const normalizedRoot = normalizePath(projectPath);
  const worktreeNeedle = `${normalizedRoot}/.kangentic/worktrees/`;
  const mainCheckoutNeedle = `${normalizedRoot}/node_modules/electron/`;

  const reaped: ReapedProcess[] = [];
  for (const row of rows) {
    if (skipPids.has(row.pid)) continue;
    const haystack = normalizePath(row.commandLine);
    if (!haystack) continue;

    // Orphan gate: skip processes whose parent is still alive. A live parent
    // means the process is actively supervised (Playwright worker, dogfooding
    // npm start, /preview window) and must not be touched.
    if (hasLiveParent(row, livePids)) continue;

    if (haystack.includes(worktreeNeedle) && haystack.includes('/node_modules/electron/')) {
      reaped.push({
        pid: row.pid,
        commandLine: row.commandLine,
        reason: 'worktree-orphan',
      });
      continue;
    }
    if (haystack.includes(mainCheckoutNeedle)) {
      reaped.push({
        pid: row.pid,
        commandLine: row.commandLine,
        reason: 'main-checkout-orphan',
      });
    }
  }
  return reaped;
}

/**
 * Filter the process list to orphans pinning a SPECIFIC worktree directory.
 * A process matches when its CommandLine contains the normalized worktree path
 * (with a trailing separator so a prefix-sibling like `worktrees/foo-bar` never
 * matches `worktrees/foo`) AND it is genuinely orphaned (parent dead or init).
 *
 * Unlike `findZombies` this does not require `/node_modules/electron/` in the
 * command line: an orphaned `node.exe` test runner pins the directory just as
 * hard, and on Windows the scan is already filtered to electron.exe/node.exe.
 *
 * The orphan gate is the same cross-process-safety guarantee as `findZombies`:
 * a live parent means the process is actively supervised. Killing the orphaned
 * root with `taskkill /T` (Windows) or relying on Chromium parent-death exit
 * (POSIX) clears its gpu/utility children too.
 *
 * Note the gate's reach is bounded by what the scan enumerates. On Windows the
 * scan lists only electron.exe/node.exe, so a LIVE but shell-parented pinner
 * (e.g. a `playwright`/`vitest` runner launched directly from pwsh, whose parent
 * pwsh.exe is not in the table) reads as an orphan and IS killed here. That is
 * intended at this call site: this runs only when a task is moved to Done, and a
 * Done move is meant to end every process the task left pinning its worktree.
 * It is NOT a general "kill anything supervised" path - it fires once, scoped to
 * one worktree path, behind the per-task lock.
 */
export function findWorktreePathProcesses(
  rows: ProcessRow[],
  worktreePath: string,
  skipPids: Set<number>,
): ReapedProcess[] {
  let needle = normalizePath(worktreePath);
  if (!needle.endsWith('/')) needle = `${needle}/`;
  // Deliberate narrow liveness (NOT the complete `scanLivePids` set that
  // `findZombies` takes): this per-worktree Done-move reap is meant to end even a
  // shell-parented pinner whose parent image the filtered scan never enumerates.
  // See this function's header and the module header (bug #258).
  const livePids = new Set(rows.map((row) => row.pid));

  const reaped: ReapedProcess[] = [];
  for (const row of rows) {
    if (skipPids.has(row.pid)) continue;
    const haystack = normalizePath(row.commandLine);
    if (!haystack) continue;

    if (hasLiveParent(row, livePids)) continue;

    if (haystack.includes(needle)) {
      reaped.push({
        pid: row.pid,
        commandLine: row.commandLine,
        reason: 'worktree-path-orphan',
      });
    }
  }
  return reaped;
}

/**
 * Kill a process and its children. Best-effort; failures are logged and
 * swallowed so one stuck PID doesn't abort the whole sweep.
 */
export async function killProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // /T walks the child tree, /F is force. Synchronous via spawn is
    // fine here because we want to know if it failed.
    try {
      await runCommandWithTimeout(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeoutMs: 2000, windowsHide: true },
      );
    } catch (error) {
      console.warn(`[REAPER] taskkill failed for pid=${pid}:`, error);
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may already be dead
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process exited cleanly during the SIGTERM grace window
  }
}

/**
 * Top-level orchestration: scan, build skip set, find zombies, kill.
 * Always returns the (possibly empty) list of reaped processes; never
 * throws to the caller. Errors are logged and treated as no-op outcomes.
 */
export async function reapWorktreeElectronZombies(
  options: ZombieScanOptions,
): Promise<ReapedProcess[]> {
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  let rows: ProcessRow[];
  let livePids: Set<number>;
  try {
    // Independent scans, run concurrently: the image-filtered matching scan
    // (needs CommandLine) and the complete liveness scan (the orphan gate's
    // source of truth).
    [rows, livePids] = await Promise.all([
      _internals.scanProcesses(scanTimeoutMs),
      _internals.scanLivePids(scanTimeoutMs),
    ]);
  } catch (error) {
    console.warn('[REAPER] scan failed:', error);
    return [];
  }
  if (rows.length === 0) {
    console.log('[REAPER] no processes returned by scan');
    return [];
  }
  if (livePids.size === 0) {
    // The complete liveness scan failed or returned nothing. An empty live set
    // makes every process read as orphaned, so refuse to kill and let the next
    // boot sweep retry. Fail closed.
    console.warn('[REAPER] complete liveness scan returned 0 pids; aborting sweep');
    return [];
  }

  let skipPids: Set<number>;
  try {
    skipPids = _internals.buildSelfSkipSet(rows, process.pid);
  } catch (error) {
    // Defensive: if the self-walk throws somehow, abort rather than risk
    // a wrong-process kill.
    console.warn('[REAPER] self-walk failed, aborting:', error);
    return [];
  }

  const candidates = _internals.findZombies(rows, options.projectPath, skipPids, livePids);
  if (candidates.length === 0) {
    console.log('[REAPER] no zombies found');
    return [];
  }

  const killed: ReapedProcess[] = [];
  for (const candidate of candidates) {
    try {
      await _internals.killProcess(candidate.pid);
      console.log(
        `[REAPER] killed pid=${candidate.pid} reason=${candidate.reason} cmd=${candidate.commandLine.slice(0, 200)}`,
      );
      killed.push(candidate);
    } catch (error) {
      console.warn(`[REAPER] kill failed for pid=${candidate.pid}:`, error);
    }
  }
  return killed;
}

/**
 * Per-worktree production reap: kill orphaned processes pinning `worktreePath`
 * before it is removed. Always returns the (possibly empty) list of reaped
 * processes; never throws (matching `reapWorktreeElectronZombies`), so a caller
 * on the removal path can `await` it without a guard and removal proceeds even
 * if the scan fails.
 */
export async function reapProcessesForWorktree(
  options: WorktreeReapOptions,
): Promise<ReapedProcess[]> {
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_WORKTREE_SCAN_TIMEOUT_MS;
  let rows: ProcessRow[];
  try {
    rows = await _internals.scanProcessesCached(scanTimeoutMs);
  } catch (error) {
    console.warn('[REAPER] worktree scan failed:', error);
    return [];
  }
  if (rows.length === 0) return [];

  let skipPids: Set<number>;
  try {
    skipPids = _internals.buildSelfSkipSet(rows, process.pid);
  } catch (error) {
    console.warn('[REAPER] self-walk failed, aborting:', error);
    return [];
  }

  const candidates = _internals.findWorktreePathProcesses(rows, options.worktreePath, skipPids);
  if (candidates.length === 0) return [];

  const killed: ReapedProcess[] = [];
  for (const candidate of candidates) {
    try {
      await _internals.killProcess(candidate.pid);
      console.log(
        `[REAPER] killed pid=${candidate.pid} reason=${candidate.reason} cmd=${candidate.commandLine.slice(0, 200)}`,
      );
      killed.push(candidate);
    } catch (error) {
      console.warn(`[REAPER] kill failed for pid=${candidate.pid}:`, error);
    }
  }
  return killed;
}

// ---------------------------------------------------------------------------
// Internals (exposed for unit-test replacement via vi.spyOn / vi.mock)
// ---------------------------------------------------------------------------

export const _internals = {
  scanProcesses,
  scanLivePids,
  scanProcessesCached,
  buildSelfSkipSet,
  findZombies,
  findWorktreePathProcesses,
  killProcess,
};

// ---------------------------------------------------------------------------
// Generic spawn-with-timeout (purposefully not in git-spawn.ts because
// that module's runGitWithTimeout is hard-coded to spawn `git`)
// ---------------------------------------------------------------------------

interface RunCommandOptions {
  timeoutMs: number;
  windowsHide?: boolean;
}

function runCommandWithTimeout(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);

    const spawnOptions: SpawnOptions = {
      signal: controller.signal,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const child = spawn(command, [...args], spawnOptions);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}
