import { app } from 'electron';

/**
 * Where the sqlite-vec loadable extension is, for the retrieval worker, the
 * only process that loads it (`retrieval-client.ts` sends it in the worker's
 * init; the worker loads it into each project connection it opens). Main never
 * loads it: nothing on main reads or writes a vec0 table, and a connection
 * without the module that tried would fail with `no such module: vec0`.
 *
 * The binary is a prebuilt per-platform `.dll`/`.dylib`/`.so` (sqlite-vec's
 * optional platform packages), resolved via `getLoadablePath()`. In a packaged
 * app those packages are asarUnpacked, so the resolved path is rewritten from
 * `app.asar` to `app.asar.unpacked` (SQLite cannot open a loadable extension
 * from inside an asar archive).
 */
interface SqliteVecModule {
  getLoadablePath(): string;
}

/**
 * Where the sqlite-vec binary is, outside the asar in a packaged app. Throws
 * when the package or its platform binary is missing, which leaves the worker
 * searching by keyword only.
 */
export function resolveVecLoadablePath(): string {
  // Lazy require (not a top-level import) so a missing package degrades to
  // lexical-only instead of crashing at boot. `sqlite-vec` is an esbuild
  // external, so this stays a runtime require of node_modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require('sqlite-vec') as SqliteVecModule;
  const loadablePath = sqliteVec.getLoadablePath();
  return app.isPackaged ? loadablePath.replace('app.asar', 'app.asar.unpacked') : loadablePath;
}
