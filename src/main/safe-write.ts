import fs from 'node:fs';
import path from 'node:path';
import {
  reportSyncWriteFailure,
  noteSyncWriteSuccess,
  isRenameOntoHeldFile,
} from './config/write-failure-notice';

/**
 * How long to wait before each retry of a rename Windows refused because another program
 * holds the target: three attempts, 100 ms of waiting at most. The wait blocks the main
 * process, so the budget stays small; see `safeWriteJson` for what it costs.
 */
const RENAME_RETRY_DELAYS_MS = [25, 75];

/** A cell nobody notifies, so `Atomics.wait` on it is a plain synchronous sleep. */
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Rename `fromPath` onto `toPath`, retrying while Windows reports the target held
 *  (`isRenameOntoHeldFile`). Throws the last error when the delays run out, and any
 *  other failure at once. */
function renameRetryingWhileHeldSync(fromPath: string, toPath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(fromPath, toPath);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRenameOntoHeldFile(error)) throw error;
      Atomics.wait(sleepCell, 0, 0, delayMs);
    }
  }
}

/**
 * Guarded, atomic JSON write for the small per-machine/per-project state files main
 * writes synchronously from a timer, an IPC handler, or an event callback (config,
 * import sources, browser URL overrides, the mobile-bridge roster and identity, the
 * Asana token). None of those callers has anywhere to send a rejection when the
 * target volume goes away mid-session (a timer has no caller at all; `config:setSync`
 * is an `ipcMain.on`, where a throw is an uncaught exception, not a rejection) - see
 * DESKTOP-14/DESKTOP-13. This is the shared guard: mkdir + write-to-temp + rename,
 * all inside one try, reporting through the source-keyed latch in
 * `./config/write-failure-notice.ts` on failure instead of throwing.
 *
 * The mkdir is inside the try deliberately - on the failing volume it is the mkdir
 * that throws, one line above the write, so guarding the write alone would leave the
 * bug intact. Write-to-temp-then-rename is kept from the existing hand-rolled callers
 * (`browser-url-store.ts`) so a crash mid-write cannot truncate the target file; the
 * other adopters gain that atomicity as a side effect.
 *
 * On Windows a rename that replaces a file fails with EPERM, EACCES or EBUSY while
 * another program holds the target open without delete sharing. File-sync clients and
 * scanners do that for a moment after every change, and a one-shot rename dropped a
 * user's project settings change that way (Sentry DESKTOP-1Z). So the rename is retried
 * on those codes, on Windows only, within `RENAME_RETRY_DELAYS_MS`. The wait runs on main
 * because this function is synchronous and has no caller that could await it. The worst
 * case is 100 ms of blocked main per write, and a target that stays refused pays it on
 * every write, not once per outage. A read-only target is that case: Windows refuses it
 * with the same EPERM from `rename`, so its retries cannot succeed. darwin and linux never
 * retry: a local POSIX filesystem does not refuse a rename over an open file.
 *
 * A target still held after the last attempt fails like any other write. There is no
 * fallback that writes the content straight onto the target. That write works only when
 * the holder allows write sharing, which a holder that refuses delete sharing rarely
 * does, and it gives up atomicity where a torn file costs more than one lost change: a
 * truncated project `config.json` reads as no overrides at all (`loadProjectOverrides`),
 * and the same path writes credentials (`encrypted-secret-file.ts`) and the decisions a
 * hook reads (`plan-approval-writer.ts`). The caller's in-memory copy and the next write
 * to the same source are the recovery path.
 *
 * Returns `true` on success, `false` on any failure (already reported). Callers that
 * hold an in-memory copy of what they meant to persist (ConfigManager) keep serving
 * it regardless of the return value, exactly as they did before this guard existed -
 * a failed disk write must not roll back a value already accepted into memory.
 */
export function safeWriteJson(
  filePath: string,
  value: unknown,
  source: string,
  options?: { mode?: number },
): boolean {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(tmpPath, content, options?.mode !== undefined ? { mode: options.mode } : undefined);
    renameRetryingWhileHeldSync(tmpPath, filePath);
    noteSyncWriteSuccess(source);
    return true;
  } catch (error) {
    // Best-effort cleanup so a flaky volume does not litter `.tmp.<pid>` files
    // behind it. Never lets a cleanup failure mask the original error.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up, or the volume is unwritable either way.
    }
    reportSyncWriteFailure(error, source);
    return false;
  }
}
