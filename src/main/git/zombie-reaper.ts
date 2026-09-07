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
 *   - Orphan gate: a process whose parent is still alive is never killed by
 *     EITHER entry point (it is actively supervised - a live Playwright worker,
 *     the dogfooding `npm start` window, a `/preview` window, a terminal the
 *     user left in the directory). See `hasLiveParent`.
 *     `reapWorktreeElectronZombies` resolves liveness against the COMPLETE
 *     `scanLivePids` set (bug #258); `findWorktreePathProcesses` gets the same
 *     completeness for free because it is fed `scanAllProcesses`, which is what
 *     turned that gate from an accident of the filtered scan into a real
 *     guarantee. Supervised holders are not ignored, only spared: they are named
 *     by `findWorktreePathHolders` so the failure reads "Held by node.exe
 *     (pid N)" instead of a silent retry.
 *   - Path needle: only processes referencing the matched path are candidates.
 *     The boot sweep matches CommandLine; the per-worktree reap also matches
 *     ExecutablePath. A process referencing the worktree ONLY through its cwd is
 *     invisible to both, because `Win32_Process` has no working-directory
 *     property at all; that is what the session-end reap exists to cover. The
 *     per-worktree needle carries a trailing separator so `worktrees/foo` never
 *     matches `worktrees/foo-bar`, plus a boundary check so a command line
 *     naming the worktree ROOT still matches (`commandLineReferencesPath`).
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
import { isProcessAlive } from '../shared/process-liveness';

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
  /**
   * Absolute path of the process image, when the scan collected it. Only the
   * UNFILTERED scan (`scanAllProcesses`) populates this; the image-filtered
   * `scanProcesses` leaves it undefined, so a consumer must treat absence as
   * "unknown", never as "not under the needle".
   *
   * It matters because a process launched by a bare name (`func.exe start
   * --port 5003`) carries no path in its command line at all, and a binary
   * living inside the worktree (`node_modules/.bin`, a `.venv`) is pinning the
   * directory just as hard as one named in argv.
   */
  executablePath?: string;
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
 * Same TTL cache for the UNFILTERED scan, kept separate from `cachedScan`
 * because the two carry different row sets and different fields. Sharing one
 * slot would let a filtered scan satisfy a request that needs every image, which
 * is precisely the miss this module shipped with.
 */
let cachedAllScan: { rows: ProcessRow[]; capturedAt: number } | null = null;

/**
 * Normalize a path for case-insensitive substring comparison on Windows
 * and forward-slash matching on every platform. Returns lowercase on
 * Windows, original case elsewhere.
 *
 * Case and separator only. It does not canonicalize, so a Windows path reported
 * under an 8.3 short name (`C:/progra~1/...`) or carrying the `\\?\` long-path
 * prefix will not match a needle spelled the long way, and such a holder is
 * neither killed nor named. Both forms are rare in `Win32_Process` output; this
 * is a known limit of matching by string rather than by resolved identity.
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

/**
 * Enumerate EVERY process image, with `ExecutablePath` alongside `CommandLine`.
 *
 * The filtered `scanProcesses` above lists only electron.exe and node.exe, which
 * is why a leaked `func.exe` / `dotnet` / `python` dev server pinning a worktree
 * was invisible to the reaper. This scan sees them.
 *
 * It is NOT a drop-in replacement for `scanProcesses`, and deliberately does not
 * replace it: `findZombies` and the E2E leak janitor both depend on the filtered
 * table (see `findWorktreePathProcesses`'s note on narrow liveness), and
 * repointing them would silently change which processes they kill.
 *
 * Cost, measured on a 505-process Windows host: ~300ms of query and 171KB of
 * JSON, on top of ~600ms of PowerShell startup. That is why only the removal
 * FAILURE path uses it, where the removal has already failed and nothing the
 * user is waiting on gets slower.
 *
 * Returns an empty array on any failure, like its filtered sibling.
 */
export async function scanAllProcesses(scanTimeoutMs: number): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    return scanAllProcessesWindows(scanTimeoutMs);
  }
  // `ps -ax -o pid=,ppid=,command=` already lists every process on POSIX, so
  // the filtered scan and this one are the same query there. `command=` is the
  // full argv, which subsumes the executable path.
  return scanProcessesUnix(scanTimeoutMs);
}

/** `scanAllProcesses` behind the same 5s TTL contract as `scanProcessesCached`. */
export async function scanAllProcessesCached(scanTimeoutMs: number): Promise<ProcessRow[]> {
  if (cachedAllScan && Date.now() - cachedAllScan.capturedAt < SCAN_CACHE_TTL_MS) {
    return cachedAllScan.rows;
  }
  const rows = await _internals.scanAllProcesses(scanTimeoutMs);
  if (rows.length > 0) {
    cachedAllScan = { rows, capturedAt: Date.now() };
  }
  return rows;
}

async function scanAllProcessesWindows(scanTimeoutMs: number): Promise<ProcessRow[]> {
  const psCommand =
    'Get-CimInstance Win32_Process '
    + '| Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath '
    + '| ConvertTo-Json -Compress';
  const stdout = await runCommandWithTimeout(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { timeoutMs: scanTimeoutMs, windowsHide: true },
  );
  return parseProcessRowsFromJson(stdout);
}

/**
 * Parse the Windows scan's JSON into rows. A single-row result arrives as one
 * object rather than an array, which is why this normalizes before iterating.
 * Rows missing `ProcessId` are dropped; every other field degrades to a default
 * so one malformed entry cannot lose the whole scan.
 *
 * Exported for fixture testing on Linux CI, where PowerShell cannot run.
 * Pure; never throws.
 */
export function parseProcessRowsFromJson(stdout: string): ProcessRow[] {
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
      ExecutablePath?: string | null;
    };
    if (typeof typedRow.ProcessId !== 'number') continue;
    result.push({
      pid: typedRow.ProcessId,
      ppid: typeof typedRow.ParentProcessId === 'number' ? typedRow.ParentProcessId : 0,
      commandLine: typeof typedRow.CommandLine === 'string' ? typedRow.CommandLine : '',
      executablePath: typeof typedRow.ExecutablePath === 'string' ? typedRow.ExecutablePath : undefined,
    });
  }
  return result;
}

/** Test-only: clear the scan caches between cases. */
export function __resetScanCacheForTest(): void {
  cachedScan = null;
  cachedAllScan = null;
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
 * Filter the process list to ORPHANED processes pinning a SPECIFIC worktree
 * directory, by command line or executable path. A process referencing the
 * worktree only through its CWD is invisible here on every platform, which is
 * what the session-end reap covers instead. The needle carries a forced trailing
 * separator so a prefix-sibling like `worktrees/foo-bar` never matches
 * `worktrees/foo`, plus a boundary check so a command line naming the worktree
 * ROOT still matches (see `commandLineReferencesPath`).
 *
 * ## The orphan gate, and why it now means what it says
 *
 * A live parent means the process is actively supervised, and killing it would
 * be wrong: on this path the pinner can be something Kangentic never spawned -
 * a terminal the user left `cd`'d into the worktree, an editor, a dev server
 * they started by hand.
 *
 * The gate used to be load-bearing in an invisible way. It was fed the
 * IMAGE-FILTERED scan, so `livePids` held electron/node rows only and a
 * shell-parented pinner read as an orphan and got killed anyway - the gate said
 * "spare the supervised" while the incomplete input quietly made it kill them.
 * Feeding it `scanAllProcesses` makes the liveness set complete, so the gate now
 * does exactly what it claims.
 *
 * That is safe to rely on ONLY because the session-end reap
 * (`src/main/pty/session-tree-reap.ts`) already kills what a session spawned,
 * without a gate, from its own process tree. This path is the backstop for
 * processes we did NOT spawn, so it can afford to be careful. If that reap is
 * ever removed, revisit this gate rather than assuming it still covers the case.
 *
 * A supervised holder is not simply ignored: `findWorktreePathHolders` names it
 * so the failure surfaces as "Held by node.exe (pid N)" instead of a silent
 * retry.
 *
 */
/**
 * The normalized worktree path with a forced trailing separator, the form both
 * the killing path and the reporting path match against.
 */
function worktreeNeedleFor(worktreePath: string): string {
  const needle = normalizePath(worktreePath);
  return needle.endsWith('/') ? needle : `${needle}/`;
}

/**
 * Does this row reference the worktree at `needleWithSlash`?
 *
 * The two references a scan can actually see. A third - the process's cwd - is
 * what the motivating incident had, and no scan can see it on Windows:
 * `Win32_Process` exposes CommandLine, ExecutablePath and ParentProcessId and
 * nothing resembling a working directory. That gap is exactly why the
 * session-end reap in `src/main/pty/session-tree-reap.ts` is the primary
 * mechanism and the removal-failure scan is only the backstop.
 *
 * Shared by `findWorktreePathProcesses` (which kills) and
 * `findWorktreePathHolders` (which names), so reporting can never see LESS than
 * the reap would kill. A holder we would kill but could not name surfaces as an
 * unexplained failure, and keeping the two matchers structurally identical is
 * what rules that out - the invariant used to be restated in a comment on each
 * function and maintained by hand.
 */
function rowReferencesWorktree(row: ProcessRow, needleWithSlash: string): boolean {
  const commandLine = normalizePath(row.commandLine);
  const executablePath = row.executablePath ? normalizePath(row.executablePath) : '';
  return (commandLine !== '' && commandLineReferencesPath(commandLine, needleWithSlash))
    || (executablePath !== '' && executablePath.startsWith(needleWithSlash));
}

export function findWorktreePathProcesses(
  rows: ProcessRow[],
  worktreePath: string,
  skipPids: Set<number>,
): ReapedProcess[] {
  const needle = worktreeNeedleFor(worktreePath);
  // Complete, because `reapProcessesForWorktree` feeds this the UNFILTERED scan.
  // See the header: that completeness is what turns the gate below from an
  // accident into a real guarantee.
  const livePids = new Set(rows.map((row) => row.pid));

  const reaped: ReapedProcess[] = [];
  for (const row of rows) {
    if (skipPids.has(row.pid)) continue;

    // Supervised: someone owns this process. Name it, do not kill it.
    if (hasLiveParent(row, livePids)) continue;

    if (!rowReferencesWorktree(row, needle)) continue;

    reaped.push({
      pid: row.pid,
      commandLine: row.commandLine,
      reason: 'worktree-path-orphan',
    });
  }
  return reaped;
}


/**
 * Does a normalized command line reference the worktree at `needleWithSlash`
 * (a normalized worktree path carrying a forced trailing separator)?
 *
 * Testing the trailing-separator form ALONE misses a command line that names the
 * worktree ROOT exactly - `node <worktree>`, `code <worktree>`, `--cwd
 * <worktree>` - which is exactly the supervised-holder shape the holder scan
 * exists to name. Measured in a preview: a live `node.exe` holding worktree 3
 * was reported as `holders=none` purely because its path argument had no
 * trailing slash.
 *
 * The separator still does its original job of rejecting a prefix sibling
 * (`worktrees/foo` must never match `worktrees/foo-bar`), so the bare-root form
 * is accepted only where a real boundary follows: end of string, whitespace, or
 * a closing quote.
 */
export function commandLineReferencesPath(haystack: string, needleWithSlash: string): boolean {
  if (haystack.includes(needleWithSlash)) return true;
  const root = needleWithSlash.slice(0, -1);
  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(root, from);
    if (at === -1) return false;
    const next = haystack[at + root.length];
    if (next === undefined || next === ' ' || next === '\t' || next === '"' || next === "'") {
      return true;
    }
    from = at;
  }
}

/**
 * A process pinning a worktree path. Reported, never killed: this is the
 * diagnostic half of the reaper.
 */
export interface WorktreeHolder {
  pid: number;
  /** Best-effort image name derived from the command line's first token. */
  image: string;
  commandLine: string;
}

/**
 * Best-effort image name from a command line: the basename of the first token,
 * quoted or not. Returns '' when the command line is empty, which happens for
 * processes the scan cannot read.
 */
export function processImageName(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return '';
  let executable: string;
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    executable = closingQuote === -1 ? trimmed.slice(1) : trimmed.slice(1, closingQuote);
  } else {
    executable = trimmed.split(/\s+/)[0] ?? '';
  }
  const separator = Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\'));
  return separator === -1 ? executable : executable.slice(separator + 1);
}

/** Short label for a user-facing message: `node.exe (pid 12345)`. */
export function describeHolder(holder: WorktreeHolder): string {
  return holder.image ? `${holder.image} (pid ${holder.pid})` : `pid ${holder.pid}`;
}

/**
 * Processes referencing `worktreePath`, for REPORTING only. Nothing here kills.
 *
 * It shares the needle and the self-skip set with `findWorktreePathProcesses`
 * but DELIBERATELY omits the `hasLiveParent` orphan gate, and that omission is
 * the entire reason this function exists. The gate is a kill-safety rule: a live
 * parent means the process is actively supervised, so ending it would be wrong.
 * Naming it is not wrong, and the holder we most want to name is precisely the
 * supervised one - in the incident this was written for, the directory was
 * pinned by a live dev server the user had started, so the orphan-gated finder
 * named nothing and the create hung with no explanation.
 *
 * One limit worth knowing before trusting an empty result: `Win32_Process`
 * exposes no working-directory property, so a holder that references the
 * worktree ONLY through its cwd cannot be seen. An empty list means "no holder
 * we can see", not "no holder". It is no longer limited by image, though: the
 * caller feeds it the unfiltered scan, so a `pwsh.exe` or an editor pinning the
 * directory is named like anything else.
 */
export function findWorktreePathHolders(
  rows: ProcessRow[],
  worktreePath: string,
  skipPids: Set<number>,
): WorktreeHolder[] {
  const needle = worktreeNeedleFor(worktreePath);

  const holders: WorktreeHolder[] = [];
  for (const row of rows) {
    if (skipPids.has(row.pid)) continue;
    // Deliberately the SAME matcher the killing path runs, not a copy of it.
    if (!rowReferencesWorktree(row, needle)) continue;
    holders.push({
      pid: row.pid,
      image: processImageName(row.commandLine),
      commandLine: row.commandLine,
    });
  }
  return holders;
}

/**
 * Name the processes holding `worktreePath`. Reuses `scanAllProcessesCached`, so
 * when this runs right after the reap on the same removal it costs nothing: the
 * 5s TTL still holds that scan. Never throws; an empty list is the degraded
 * answer.
 */
export async function describeWorktreeHolders(
  worktreePath: string,
  scanTimeoutMs?: number,
): Promise<WorktreeHolder[]> {
  const timeoutMs = scanTimeoutMs ?? DEFAULT_WORKTREE_SCAN_TIMEOUT_MS;
  try {
    const rows = await _internals.scanAllProcessesCached(timeoutMs);
    if (rows.length === 0) return [];
    const skipPids = _internals.buildSelfSkipSet(rows, process.pid);
    return _internals.findWorktreePathHolders(rows, worktreePath, skipPids);
  } catch (error) {
    console.warn('[REAPER] holder scan failed:', error);
    return [];
  }
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
      // A pid that exited between selection and kill is the EXPECTED case, not a
      // failure: `/T` on a parent already took the subtree, and taskkill then
      // exits 128 ("process not found") for each child we also targeted. Warning
      // on that filled the log with noise on every successful reap. Only report
      // a kill that failed against a process still standing (access denied, a
      // protected process).
      if (isProcessAlive(pid)) {
        console.warn(`[REAPER] taskkill failed for pid=${pid}:`, error);
      }
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
    // The UNFILTERED scan: a pinning dev server is rarely node or electron. This
    // path only runs after a removal has already failed, so its extra ~300ms is
    // not on anything a user is waiting for.
    rows = await _internals.scanAllProcessesCached(scanTimeoutMs);
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

  const candidates = _internals.findWorktreePathProcesses(
    rows,
    options.worktreePath,
    skipPids,
  );
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
  scanAllProcesses,
  scanLivePids,
  scanProcessesCached,
  scanAllProcessesCached,
  buildSelfSkipSet,
  findZombies,
  findWorktreePathProcesses,
  findWorktreePathHolders,
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
