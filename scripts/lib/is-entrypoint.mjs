/**
 * Whether the module at `moduleUrl` (pass `import.meta.url`) is the script node was asked to run.
 *
 * Compared by real path: node resolves the entry module through symlinks, so a checkout under a
 * link (or a junction or `subst` drive on Windows) never matched by URL, and a gate imported
 * cleanly, ran nothing, and exited 0 (see scripts/package-smoke.mjs). When either path cannot be
 * resolved, it falls back to the URL comparison, so importing a script from a test never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function isEntrypoint(moduleUrl) {
  const entryArgument = process.argv[1];
  if (!entryArgument) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(path.resolve(entryArgument));
  } catch {
    return moduleUrl === pathToFileURL(path.resolve(entryArgument)).href;
  }
}
