import { app } from 'electron';
import type Database from 'better-sqlite3';
import { hasVecSupport, markVecCapable } from './vec-support';

/**
 * Loads the sqlite-vec loadable extension into a better-sqlite3 connection. The
 * whole semantic layer is gated on this: when the extension is unavailable (an
 * unsupported platform, a missing binary, a packaging slip, a dev worktree whose
 * node_modules is junctioned to a checkout without the dep), the connection is
 * never marked vec-capable and the engine degrades to lexical-only structurally
 * - nothing ever touches the vec table.
 *
 * The `sqlite-vec` package is required LAZILY inside the try/catch, not imported
 * at module top, so a MISSING package degrades gracefully instead of crashing
 * the whole app at boot (this module is pulled in from `index.ts` at startup).
 *
 * The binary is a prebuilt per-platform `.dll`/`.dylib`/`.so` (sqlite-vec's
 * optional platform packages), resolved via `getLoadablePath()`. In a packaged
 * app those packages are asarUnpacked, so the resolved path is rewritten from
 * `app.asar` to `app.asar.unpacked` before `dlopen` (SQLite cannot open a
 * loadable extension from inside an asar archive).
 *
 * Registered as the project-DB initializer in `src/main/index.ts` so it runs on
 * every project-DB open.
 */
interface SqliteVecModule {
  getLoadablePath(): string;
}

/** The reason sqlite-vec failed to load on the most recent attempt, surfaced in
 *  the memory status so the Memory tab can explain a lexical-only degrade instead
 *  of a generic "unavailable". Null once a connection loads it successfully. */
let lastLoadError: string | null = null;

export function lastVecLoadError(): string | null {
  return lastLoadError;
}

export function loadVecExtension(db: Database.Database): boolean {
  if (hasVecSupport(db)) return true;
  try {
    // Lazy require (not a top-level import) so a missing package degrades to
    // lexical-only instead of crashing at boot. `sqlite-vec` is an esbuild
    // external, so this stays a runtime require of node_modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec') as SqliteVecModule;
    let loadablePath = sqliteVec.getLoadablePath();
    if (app.isPackaged) {
      loadablePath = loadablePath.replace('app.asar', 'app.asar.unpacked');
    }
    db.loadExtension(loadablePath);
    markVecCapable(db);
    lastLoadError = null;
    return true;
  } catch (error) {
    // Missing package / unsupported platform / missing binary / disabled
    // loadExtension: the engine runs lexical-only. Logged once at open.
    lastLoadError = error instanceof Error ? error.message : String(error);
    console.warn('[retrieval] sqlite-vec unavailable, semantic search disabled:', error);
    return false;
  }
}
