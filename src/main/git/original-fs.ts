import nodeFs from 'node:fs';

/**
 * Electron's `original-fs` module: the unpatched Node `fs`, bypassing
 * Electron's ASAR interception.
 *
 * Why this exists: Electron patches `require('fs')` to transparently walk
 * into `.asar` archives. The patch's `splitPath` helper finds any path
 * segment ending in `.asar` and calls `getOrCreateArchive(asarPath)`, which
 * memory-maps the archive into the process with a handle that is NOT
 * opened with `FILE_SHARE_DELETE` and is cached for the process lifetime
 * (no eviction API exists).
 *
 * Recursive deletion of a directory tree that contains `.asar` files (e.g.
 * worktree cleanup of `node_modules/electron/dist/resources/default_app.asar`)
 * therefore traps Kangentic in a lose-lose:
 *   1. `fs.rm({ recursive: true })` walks the tree and stats each file.
 *   2. The stat on `default_app.asar` triggers `splitPath` -> archive opens.
 *   3. The subsequent `unlink` fails with `EBUSY` / sharing violation
 *      because the archive is now memory-mapped by this process.
 *   4. Handle is held until Kangentic exits. Subsequent cleanup retries
 *      repeat the cycle and leak another handle per attempt.
 *
 * `original-fs` is the first-party escape hatch: its exports are the raw
 * Node implementations with no asar awareness, so recursive rm walks and
 * unlinks through without opening any archive.
 *
 * Fallback to `node:fs`: tests run under plain Node (vitest) where the
 * `original-fs` module does not exist. In that environment they are
 * identical anyway (no Electron patching), so using the Node fallback is
 * correct behavior, not a compromise.
 *
 * Use this for any filesystem operation in the main process that walks
 * user-project trees (worktrees, repos, node_modules) where asar files
 * may live. Do NOT use it for operations that must read into our own
 * app.asar (e.g. the bridge scripts) - those rely on the patch.
 */
let originalFs: typeof nodeFs;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  originalFs = require('original-fs') as typeof nodeFs;
} catch {
  originalFs = nodeFs;
}

export default originalFs;
