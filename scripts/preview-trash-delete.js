/**
 * preview-trash-delete.js - Deletes one preview trash folder in the background.
 *
 * Usage: node scripts/preview-trash-delete.js <worktree>/.kangentic/trash-<id>
 *
 * A preview's exit cleanup (scripts/dev.js) does not delete its two repo clones
 * in place. That took about 7 seconds on Windows, and the preview counted as
 * running until it finished. Instead the cleanup renames everything into a
 * `.kangentic/trash-<id>` folder, which is instant on one drive, exits, and
 * starts this script detached to do the slow delete. When the trash is gone it
 * also removes `.kangentic/`, but only if nothing else is in it.
 *
 * Refuses any path that is not a `trash-*` folder directly inside a
 * `.kangentic` folder, so a wrong argument cannot delete anything else.
 */

const fs = require('fs');
const path = require('path');

function isPreviewTrashDir(candidate) {
  const resolved = path.resolve(candidate);
  return /^trash-[\w-]+$/.test(path.basename(resolved)) && path.basename(path.dirname(resolved)) === '.kangentic';
}

function deletePreviewTrash(trashDir) {
  if (!isPreviewTrashDir(trashDir)) {
    throw new Error(`Refusing to delete ${trashDir}: not a .kangentic/trash-* folder`);
  }
  const resolved = path.resolve(trashDir);
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    // best-effort: the next preview boot sweeps any trash left behind
  }
  try {
    // Non-recursive on purpose: a preview that started meanwhile owns whatever is left.
    fs.rmdirSync(path.dirname(resolved));
  } catch {
    // not empty, or already gone
  }
}

if (require.main === module) {
  try {
    deletePreviewTrash(process.argv[2] || '');
  } catch (deleteError) {
    console.error(deleteError.message);
    process.exit(2);
  }
}

module.exports = { isPreviewTrashDir, deletePreviewTrash };
