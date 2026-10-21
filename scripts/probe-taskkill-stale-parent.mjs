#!/usr/bin/env node
/*
 * WINDOWS ONLY. Does `taskkill /T` follow a parent pid that Windows has handed
 * to a newer process?
 *
 * A Windows process keeps its parent's pid after the parent exits, and Windows
 * reuses that pid. A tree kill that walks recorded parent pids without
 * comparing creation times therefore takes a process whose real parent died
 * long ago, as soon as an unrelated new process holds the dead parent's pid.
 * That is how a tree kill in another tool ended a whole terminal window's
 * tree on a developer machine. Every Kangentic `taskkill` relies on the
 * opposite behavior, recorded in `src/main/shared/child-tree-stop.ts`:
 *
 * 1. Plant an orphan: a launcher starts a long ping in a hidden console of
 *    its own (`Start-Process -WindowStyle Hidden`) and exits, so the ping
 *    records a parent pid nobody holds. Not `start /b`: a ping sharing the
 *    launcher's console keeps that console's host alive, and the host's handle
 *    on the dead launcher keeps its pid from ever being freed.
 * 2. Start and end short pings until Windows hands the launcher's pid to one.
 * 3. Abort when any live process created before the launcher also records
 *    that pid as its parent: a foreign orphan, such as a terminal window whose
 *    own launcher exited, which a wrong answer below would kill.
 * 4. `taskkill /PID <reused pid> /T /F`, then check that the older orphan is
 *    still running and the pid's new owner is not.
 *
 * Only ping.exe processes this probe started are created or ended. Each ping
 * that did not get the pid is ended through its own handle (`ChildProcess.kill`),
 * never as a tree, and the orphan is ended by pid only after its image and
 * creation time are checked again.
 *
 *   node scripts/probe-taskkill-stale-parent.mjs [--budget-ms <ms>]
 *
 * Exits 0 when taskkill spared the orphan, 1 when it killed it, and 2 when no
 * collision happened within the budget or a guard aborted the run.
 * `tests/unit/taskkill-stale-parent.test.ts` runs it in the
 * `task-reap-real-processes.yml` workflow on Windows.
 *
 * Measured 2026-10-21 on Windows 11 Pro build 26200: see the header of
 * `src/main/shared/child-tree-stop.ts` for the result.
 */

import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_BUDGET_MS = 120_000;
const ORPHAN_PING_COUNT = '900';
const CANDIDATE_PING_COUNT = '120';
/** How long `endOwn` waits for a ping it killed to report its exit. */
const END_OWN_TIMEOUT_MS = 5_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows PowerShell's JSON form of a CIM date, `/Date(<ms>)/`, as epoch ms.
 * `queryProcesses` runs `powershell.exe` (5.1), which writes only that form.
 * PowerShell 7 writes an ISO string, which `parseCimCreationDate` in
 * `src/main/git/zombie-reaper.ts` reads too; change both if the scan moves.
 */
export function cimDateMs(value) {
  const match = typeof value === 'string' ? /\/Date\((-?\d+)\)\//.exec(value) : null;
  return match ? Number(match[1]) : null;
}

/** Processes matching a WQL filter, as `{ pid, ppid, name, createdAtMs }`. */
function queryProcesses(filter) {
  const command = `@(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,Name,CreationDate) | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const text = stdout.trim();
      if (!text) {
        resolve([]);
        return;
      }
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      resolve(rows.map((row) => ({
        pid: row.ProcessId,
        ppid: row.ParentProcessId,
        name: String(row.Name ?? ''),
        createdAtMs: cimDateMs(row.CreationDate),
      })));
    });
  });
}

function startHidden(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => resolve(child));
  });
}

function endOwn(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, END_OWN_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      resolve(`${stdout}${stderr}`.replace(/\s+/g, ' ').trim() || (error ? String(error.message) : ''));
    });
  });
}

async function isOurPing(pid, createdAtMs) {
  const rows = await queryProcesses(`ProcessId=${pid}`);
  return rows.some((row) => row.name.toUpperCase() === 'PING.EXE' && row.createdAtMs === createdAtMs);
}

/**
 * End the orphan ping this run planted, by pid, only while that pid is still a
 * ping naming the dead launcher as its parent. With `known` null (its first
 * read failed) it is looked up again by that parent, among pings created after
 * the launcher started. Never throws: a ping left over ends on its own count.
 */
async function endOrphan(reusedPid, launcherStartedNotBeforeMs, known) {
  try {
    const rows = known
      ? await queryProcesses(`ProcessId=${known.pid}`)
      : await queryProcesses(`ParentProcessId=${reusedPid} AND Name='PING.EXE'`);
    for (const row of rows) {
      if (row.name.toUpperCase() !== 'PING.EXE' || row.ppid !== reusedPid) continue;
      const ours = known
        ? row.createdAtMs === known.createdAtMs
        : row.createdAtMs !== null && row.createdAtMs >= launcherStartedNotBeforeMs;
      if (ours) process.kill(row.pid);
    }
  } catch {
    // Already gone, or the listing failed.
  }
}

/**
 * Runs the probe once. Resolves with one of:
 * - `{ outcome: 'collision', reusedPid, spawns, elapsedMs, taskkillOutput, orphanSurvived, newOwnerEnded }`
 * - `{ outcome: 'no-collision', spawns, elapsedMs }`
 * - `{ outcome: 'aborted', reason }`
 */
export async function runStaleParentProbe(options = {}) {
  if (process.platform !== 'win32') return { outcome: 'aborted', reason: 'Windows only' };
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const log = options.log ?? (() => undefined);

  // 1. The orphan.
  const launcherStartedNotBeforeMs = Date.now();
  const launcher = await startHidden('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath ping.exe -ArgumentList '-n','${ORPHAN_PING_COUNT}','127.0.0.1' -WindowStyle Hidden`,
  ]);
  const reusedPid = launcher.pid;
  await new Promise((resolve) => {
    if (launcher.exitCode !== null) resolve();
    else launcher.once('exit', () => resolve());
  });
  // Node closes its own handle on the launcher after the exit event.
  await delay(400);

  let orphan = null;
  let match = null;
  let spawns = 0;
  try {
    orphan = (await queryProcesses(`ParentProcessId=${reusedPid} AND Name='PING.EXE'`))[0] ?? null;
    if (!orphan || orphan.createdAtMs === null) return { outcome: 'aborted', reason: `no orphan ping found under ${reusedPid}` };
    log(`orphan ping ${orphan.pid} records the dead launcher ${reusedPid} as its parent`);

    // 2. Wait for the dead launcher's pid to come back.
    const startedAt = Date.now();
    while (Date.now() - startedAt < budgetMs) {
      const candidate = await startHidden('ping.exe', ['-n', CANDIDATE_PING_COUNT, '127.0.0.1']);
      spawns += 1;
      if (candidate.pid === reusedPid) {
        match = candidate;
        break;
      }
      await endOwn(candidate);
    }
    const elapsedMs = Date.now() - startedAt;
    if (!match) return { outcome: 'no-collision', spawns, elapsedMs };
    log(`pid ${reusedPid} came back after ${spawns} spawns (${elapsedMs} ms)`);

    // 3. Guards.
    await delay(300);
    const claimants = (await queryProcesses(`ParentProcessId=${reusedPid}`))
      .filter((row) => row.createdAtMs !== null && row.createdAtMs < launcherStartedNotBeforeMs);
    if (claimants.length > 0) {
      return { outcome: 'aborted', reason: `older processes also record ${reusedPid} as their parent: ${claimants.map((row) => `${row.name}(${row.pid})`).join(', ')}` };
    }
    const orphanNow = (await queryProcesses(`ProcessId=${orphan.pid}`))[0];
    if (!orphanNow || orphanNow.name.toUpperCase() !== 'PING.EXE' || orphanNow.ppid !== reusedPid || orphanNow.createdAtMs !== orphan.createdAtMs) {
      return { outcome: 'aborted', reason: 'the orphan changed before the tree kill' };
    }

    // 4. The tree kill, of the pid's new owner.
    const taskkillOutput = await runTaskkill(reusedPid);
    await delay(1500);
    const orphanSurvived = await isOurPing(orphan.pid, orphan.createdAtMs);
    const newOwnerEnded = match.exitCode !== null || match.signalCode !== null;
    return { outcome: 'collision', reusedPid, spawns, elapsedMs, taskkillOutput, orphanSurvived, newOwnerEnded };
  } finally {
    if (match) await endOwn(match);
    await endOrphan(reusedPid, launcherStartedNotBeforeMs, orphan && orphan.createdAtMs !== null ? orphan : null);
  }
}

/** The probe's answer, or `aborted` when it failed: a failure is not taskkill's answer, so it never exits 1. */
async function probeResult(budgetMs) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { outcome: 'aborted', reason: '--budget-ms takes a positive number of milliseconds' };
  try {
    return await runStaleParentProbe({ budgetMs, log: (line) => console.log(line) });
  } catch (error) {
    return { outcome: 'aborted', reason: `the probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main() {
  const budgetIndex = process.argv.indexOf('--budget-ms');
  const budgetMs = budgetIndex >= 0 ? Number(process.argv[budgetIndex + 1]) : DEFAULT_BUDGET_MS;
  const result = await probeResult(budgetMs);
  console.log(`RESULT ${JSON.stringify(result)}`);
  if (result.outcome !== 'collision') process.exit(2);
  process.exit(result.orphanSurvived && result.newOwnerEnded ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
