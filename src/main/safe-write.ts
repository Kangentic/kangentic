import fs from 'node:fs';
import path from 'node:path';
import { reportSyncWriteFailure, noteSyncWriteSuccess } from './config/write-failure-notice';

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
    fs.renameSync(tmpPath, filePath);
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
