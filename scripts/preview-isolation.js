/**
 * preview-isolation.js - Keeps a /preview away from everything outside its own
 * ephemeral state, and makes stopping one fast. Shared by scripts/dev.js (the
 * dev server) and scripts/worktree-preview.js (the launcher).
 *
 * Most of this exists because of one incident. A preview was relaunched while
 * the previous one was still exiting. Both use the same
 * <worktree>/.kangentic/data, and the outgoing preview's exit cleanup deleted the
 * new preview's clone, `.git` included. The new preview then ran
 * `git -C <clone> reset --hard HEAD` to fill that clone. With no `.git` there,
 * git searched the parent folders, found the worktree the preview runs from, and
 * hard-reset it, wiping every uncommitted change.
 *
 * - previewGitCeilingDirectories: the GIT_CEILING_DIRECTORIES value dev.js gives
 *   the preview's Electron process. Everything that process starts inherits it,
 *   including agent terminals, so git started inside a preview project can never
 *   find the worktree above it.
 * - findOtherPreviewInstances: lets the launcher refuse a second preview of the
 *   same worktree, and wait out one that is shutting down, before it starts a
 *   new one.
 * - moveIntoTrash / spawnTrashDeleter: dev.js's exit cleanup renames its state
 *   into a trash folder and leaves the slow delete to a detached process, so a
 *   closed preview is gone in about a second instead of the 7 it took to delete
 *   two repo clones in place.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * `existingValue` is the GIT_CEILING_DIRECTORIES the dev server inherited, kept
 * so a ceiling the developer set still applies. The preview-projects folder is
 * the same path src/devtools/main/ephemeral-projects.ts previewProjectsRoot()
 * derives from KANGENTIC_DATA_DIR.
 */
function previewGitCeilingDirectories(ephemeralDataDir, existingValue) {
  const previewProjectsDir = path.join(ephemeralDataDir, 'preview-projects');
  return [existingValue, previewProjectsDir].filter(Boolean).join(path.delimiter);
}

/** Written by dev.js the moment a stop, a closed terminal, or a closed window
 *  reaches it, and kept until its cleanup is done. */
function stoppingMarkerPathFor(worktreeDir, port) {
  return path.join(worktreeDir, '.kangentic', `preview-${port}.stopping`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just is not ours to signal.
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * Every OTHER live preview of this worktree, read from the PID files dev.js
 * writes at `.kangentic/preview-<port>.pid`. A PID file whose process is gone
 * is stale and skipped.
 *
 * `shuttingDown` covers the whole teardown: the launcher's `--stop` request
 * (`preview-<port>.stop`, while Electron quits) and dev.js's own stopping
 * marker, which it writes when a stop, a closed terminal, or a closed window
 * reaches it, and removes together with the PID file at the end of its cleanup.
 * Not the exit record: the `--wait` watcher clears that within a second.
 */
function findOtherPreviewInstances(worktreeDir) {
  const kangenticDir = path.join(worktreeDir, '.kangentic');
  let entries = [];
  try {
    entries = fs.readdirSync(kangenticDir);
  } catch {
    return [];
  }
  const instances = [];
  for (const entry of entries) {
    const match = /^preview-(\d+)\.pid$/.exec(entry);
    if (!match) continue;
    const port = parseInt(match[1], 10);
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(path.join(kangenticDir, entry), 'utf-8').trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isProcessAlive(pid)) continue;
    const shuttingDown = fs.existsSync(path.join(kangenticDir, `preview-${port}.stop`))
      || fs.existsSync(stoppingMarkerPathFor(worktreeDir, port));
    instances.push({ port, pid, shuttingDown });
  }
  return instances;
}

/**
 * Rename each of `sourcePaths` into `trashDir`, which is instant when both are
 * on one drive. Returns the paths that could not be moved (a handle still held,
 * or a different drive), which the caller deletes in place instead.
 */
function moveIntoTrash(sourcePaths, trashDir) {
  const leftBehind = [];
  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) continue;
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(sourcePath, path.join(trashDir, path.basename(sourcePath)));
    } catch {
      leftBehind.push(sourcePath);
    }
  }
  return leftBehind;
}

/** The `trash-*` folders in a worktree's `.kangentic/`, for the boot sweep. */
function listTrashDirs(kangenticDir) {
  try {
    return fs.readdirSync(kangenticDir)
      .filter((entryName) => entryName.startsWith('trash-'))
      .map((entryName) => path.join(kangenticDir, entryName));
  } catch {
    return [];
  }
}

/**
 * Start scripts/preview-trash-delete.js on `trashDir`, detached so it outlives
 * this process and a closed terminal. Best-effort: a deleter that never runs
 * leaves trash for the next boot's sweep.
 *
 * It runs from the temp folder, not dev.js's cwd (the worktree). On Windows a
 * process's cwd cannot be removed, so a deleter still working there would block
 * removing the worktree for those seconds.
 */
function spawnTrashDeleter(trashDir) {
  try {
    const deleter = spawn(process.execPath, [path.join(__dirname, 'preview-trash-delete.js'), path.resolve(trashDir)], {
      cwd: os.tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    deleter.on('error', () => {});
    deleter.unref();
  } catch {
    // best-effort, see above
  }
}

module.exports = {
  previewGitCeilingDirectories,
  stoppingMarkerPathFor,
  findOtherPreviewInstances,
  isProcessAlive,
  moveIntoTrash,
  listTrashDirs,
  spawnTrashDeleter,
};
