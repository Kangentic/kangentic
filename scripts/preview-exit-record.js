/**
 * preview-exit-record.js - Shared exit-record contract between scripts/dev.js
 * (the preview dev server) and scripts/worktree-preview.js (the launcher's
 * --wait watcher).
 *
 * dev.js's ephemeral cleanup() removes the whole worktree .kangentic/
 * directory on exit, so nothing under the worktree survives to tell a
 * watcher HOW the server exited. This module keys a tiny JSON record under
 * os.tmpdir() by (worktree, port) so it survives that cleanup: dev.js writes
 * { pid, exitCode } as the first statement of cleanup(), and the watcher
 * reads it to distinguish a clean exit from a crash.
 *
 * Both callers pass their raw worktree directory string and never normalize
 * it themselves. normalizeWorktreeKey is the single implementation, so the
 * two sides (process.cwd() in worktree-preview.js, path.resolve(__dirname,
 * '..') in dev.js) cannot drift into different keys for the same directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function normalizeWorktreeKey(worktreeDir) {
  let normalized = path.resolve(worktreeDir).replace(/\\/g, '/');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function exitRecordPath(worktreeDir, port) {
  const key = normalizeWorktreeKey(worktreeDir);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'kangentic-preview', `${hash}-${port}.json`);
}

function writeExitRecord(worktreeDir, port, { pid, exitCode }) {
  const recordPath = exitRecordPath(worktreeDir, port);
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ pid, exitCode }));
  } catch {
    // best-effort: a failed write just means the watcher falls back to the
    // PID-liveness classification (status 'vanished') instead of 'crashed'.
  }
}

function readExitRecord(worktreeDir, port) {
  try {
    const raw = fs.readFileSync(exitRecordPath(worktreeDir, port), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === 'number' && typeof parsed.exitCode === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearExitRecord(worktreeDir, port) {
  try {
    fs.rmSync(exitRecordPath(worktreeDir, port), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Pure classification, no I/O. `processAlive` must already be the caller's
 * AND of "PID file still names this PID" and "process responds to signal 0"
 * (see worktree-preview.js's --wait loop), so a hard-killed PID that the
 * OS later recycles for an unrelated process cannot read back as alive here.
 *
 * Returns null when the caller should keep polling (still running, or a
 * stale record from an earlier instance on this port that hasn't been
 * superseded yet).
 */
function classifyPreviewExit({ record, watchedPid, processAlive, stopRequested }) {
  if (record && record.pid === watchedPid) {
    return record.exitCode === 0
      ? { status: 'clean', code: 0 }
      : { status: 'crashed', code: 2 };
  }
  if (processAlive) {
    return null;
  }
  return stopRequested
    ? { status: 'clean', code: 0 }
    : { status: 'vanished', code: 3 };
}

module.exports = {
  normalizeWorktreeKey,
  exitRecordPath,
  writeExitRecord,
  readExitRecord,
  clearExitRecord,
  classifyPreviewExit,
};
