/**
 * One parent directory per vitest run for the per-file data directories that
 * isolate-data-dir.ts creates, removed once the run is over.
 *
 * A per-file directory cannot always remove itself: on Windows a database
 * handle the suite left open keeps its files locked until the worker process
 * exits, which is after the file's own `afterAll`. This teardown runs in the
 * main process after the workers, so the locks are normally gone and the whole
 * tree goes in one call.
 *
 * Normally, not always: Windows can still hold a handle for a moment after a
 * worker exits, and then the teardown fails with EPERM. So setup also sweeps
 * parents an earlier run left behind. It removes only those over an hour old,
 * which no live run can own (two worktrees can run vitest at once, each with its
 * own parent), so leftovers never accumulate in the temp directory.
 *
 * Workers are forked after this runs, so they inherit the variable.
 *
 * Registered in vitest.config.ts `test.globalSetup`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_PREFIX = 'kangentic-unit-data-';
const STALE_AFTER_MS = 60 * 60 * 1000;

function sweepStaleRoots(now: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(ROOT_PREFIX)) continue;
    const candidate = path.join(os.tmpdir(), entry);
    try {
      if (now - fs.statSync(candidate).mtimeMs < STALE_AFTER_MS) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Still locked, or raced with another sweep. The next run tries again.
    }
  }
}

export default function setupUnitDataRoot(): () => void {
  sweepStaleRoots(Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  process.env.KANGENTIC_UNIT_DATA_ROOT = root;
  return () => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Left for the next run's sweep (see the header). Not worth a warning.
    }
  };
}
