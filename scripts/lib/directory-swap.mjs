/**
 * Put a directory written beside its target into the target's place, so a reader never sees half
 * of it. scripts/cut-demo-fonts.mjs swaps its cut in for the committed demo/fonts/ this way.
 *
 * The target's old contents move aside to `retiredDir` first and are removed only once the new
 * directory is in. If the new one cannot be renamed in (Windows refuses a rename while a scanner
 * holds a fresh file), the old contents go back. If even that rename is refused, they stay in
 * `retiredDir`, which the error names, and nothing removes them.
 */
import fs from 'node:fs';

/** Windows can hold a handle on a fresh file for a moment (Defender, the indexer). */
export const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Swap `stagingDir` in for `outputDir`, through `retiredDir`. Throws, leaving the target as it was,
 * when the swap cannot finish. Refuses to start when a previous swap left the old contents in
 * `retiredDir` with no `outputDir`, since clearing `retiredDir` would delete the only copy.
 * `fileSystem` is `node:fs` outside tests.
 */
export function swapDirectoryIn({ stagingDir, outputDir, retiredDir }, fileSystem = fs) {
  const hadOutput = fileSystem.existsSync(outputDir);
  if (!hadOutput && fileSystem.existsSync(retiredDir)) {
    throw new Error(`${outputDir} is missing and ${retiredDir} holds what a previous swap moved aside. Move it back, or restore ${outputDir} from git, then run again.`);
  }
  fileSystem.rmSync(retiredDir, REMOVE_OPTIONS);
  if (hadOutput) fileSystem.renameSync(outputDir, retiredDir);
  try {
    fileSystem.renameSync(stagingDir, outputDir);
  } catch (error) {
    if (hadOutput) {
      try {
        fileSystem.renameSync(retiredDir, outputDir);
      } catch (restoreError) {
        throw new Error(`${stagingDir} could not replace ${outputDir} (${messageOf(error)}), and the previous contents could not be put back (${messageOf(restoreError)}). They are in ${retiredDir}.`, { cause: error });
      }
    }
    throw error;
  }
  fileSystem.rmSync(retiredDir, REMOVE_OPTIONS);
}
