import type DatabaseType from 'better-sqlite3';

// Lazy-load better-sqlite3 for the adapters that read an agent CLI's own SQLite
// store (OpenCode, Goose), to avoid evaluating the native module at import
// time. It used to be rebuilt against Electron's Node ABI, so loading it under
// a stand-alone Node runtime (tsx, raw vitest) crashed with NODE_MODULE_VERSION
// mismatch; better-sqlite3 13 is Node-API and loads there. The lazy require
// still confines any load failure (a platform with no prebuild) to the call
// sites that need the DB, and keeps the native load off the import path of
// modules that never read.
//
// We use `require(<non-literal>)` so esbuild leaves the call as a runtime
// resolution rather than statically inlining the module (which would defeat
// the lazy load and re-trigger the eager native binding load).
let cachedDatabaseConstructor: typeof DatabaseType | null = null;
export function loadBetterSqlite3(): typeof DatabaseType | null {
  if (cachedDatabaseConstructor) return cachedDatabaseConstructor;
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule;
    cachedDatabaseConstructor = databaseConstructor as typeof DatabaseType;
    return cachedDatabaseConstructor;
  } catch {
    return null;
  }
}
