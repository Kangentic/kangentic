import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Lazy-load better-sqlite3 to avoid evaluating the native module at
// import time. The module is rebuilt against Electron's Node ABI in
// production; loading it under a stand-alone Node runtime (tsx, raw
// vitest) crashes with NODE_MODULE_VERSION mismatch. Lazy require
// confines the failure to the call sites that actually need the DB,
// so unit tests that don't exercise the SQLite path stay loadable.
//
// We use `require(<non-literal>)` so esbuild leaves the call as a
// runtime resolution rather than statically inlining the module
// (which would defeat the lazy load and re-trigger the eager native
// binding load).
let cachedDatabaseConstructor: typeof DatabaseType | null = null;
function loadBetterSqlite3(): typeof DatabaseType | null {
  if (cachedDatabaseConstructor) return cachedDatabaseConstructor;
  try {
    const moduleName = 'better-sqlite3';
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule;
    cachedDatabaseConstructor = databaseConstructor as typeof DatabaseType;
    return cachedDatabaseConstructor;
  } catch {
    return null;
  }
}

/**
 * OpenCode persists sessions in a SQLite database (`opencode.db`)
 * inside its data directory. Verified empirically against OpenCode
 * 1.14.25 on Windows: the DB lives at
 * `%USERPROFILE%\.local\share\opencode\opencode.db`. On macOS/Linux
 * the same `~/.local/share/opencode/` path applies.
 *
 * SQLite is opened in WAL mode (`PRAGMA journal_mode = wal`), so we
 * can safely read the DB while OpenCode itself is running and writing.
 * We open in readonly + immutable=0 mode so we never accidentally
 * mutate the database from Kangentic.
 *
 * Schema (verified via `sqlite_master`, OpenCode 1.14.25):
 *
 *   CREATE TABLE `session` (
 *     `id` text PRIMARY KEY,           -- ses_<26 alphanumeric>
 *     `project_id` text NOT NULL,
 *     `directory` text NOT NULL,       -- absolute path, OS-native slashes
 *     `time_created` integer NOT NULL, -- epoch ms
 *     `time_updated` integer NOT NULL,
 *     ...
 *   )
 *
 * Why direct DB read instead of `opencode session list --format json`:
 *  - On Windows, npm publishes `opencode.cmd` (a shell shim).
 *    `child_process.execFile('opencode', ...)` rejects shim execution
 *    for security. Resolving the absolute path adds complexity, and
 *    spawning through a shell adds Node startup latency on every poll.
 *  - Direct WAL read is ~5-10ms vs ~200-500ms for an opencode CLI
 *    spin-up. With a 500ms poll interval that matters.
 *  - The schema fields we read (`id`, `directory`, `time_created`)
 *    are core columns. Verified against OpenCode 1.14.25 - if a
 *    future release renames or drops one of these we will see read
 *    failures (caught) and resume falls back to a fresh session.
 *
 * Known limitation: two concurrent OpenCode spawns in the SAME `cwd`
 * within ~30s of each other cannot be reliably disambiguated by this
 * parser - both rows match the directory + time-window predicate, and
 * we return the most recently created. Kangentic's worktree flow
 * gives each task its own cwd, so this only affects users running
 * multiple tasks against the same project root without worktrees.
 * Mirrors the same caveat in the Codex parser.
 */
export class OpenCodeSessionHistoryParser {
  /**
   * Find the OpenCode session created by this spawn by polling the
   * SQLite DB for a row whose `directory` matches our cwd and whose
   * `time_created` falls within the spawn window.
   *
   * Returns null if the DB does not exist (OpenCode never run on this
   * machine), the table is missing (older format), or no row matches
   * within the polling budget.
   */
  static async captureSessionIdFromFilesystem(options: {
    spawnedAt: Date;
    cwd: string;
    maxAttempts?: number;
    getAgentVersion?: () => string | null;
  }): Promise<string | null> {
    const spawnedAtMs = options.spawnedAt.getTime();
    // Match the Codex parser's window shape: ±a few seconds for clock
    // skew on the floor, generous +30s on the ceil because OpenCode
    // may take a moment to insert the row after CLI startup.
    const createdFloorMs = spawnedAtMs - 5_000;
    const createdCeilMs = spawnedAtMs + 30_000;
    const normalizedCwd = normalizeCwdForCompare(options.cwd);
    const maxAttempts = options.maxAttempts ?? 20; // ~10s

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const id = readMatchingSessionId(createdFloorMs, createdCeilMs, normalizedCwd, options.getAgentVersion);
      if (id) return id;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  /**
   * Locate the on-disk record for a captured session ID. OpenCode
   * stores all sessions in `opencode.db`; there is no per-session
   * file. We confirm the row exists, then return the database path.
   * Returns null if the DB or the row is missing.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const dbPath = openCodeDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const found = sessionIdExists(dbPath, options.agentSessionId);
    return found ? dbPath : null;
  }
}

// ---------- Internal helpers ----------

const POLL_INTERVAL_MS = 500;

// Verified-against version baked into the warning so future readers
// know which OpenCode release we last observed the schema match.
// Single source of truth - the class JSDoc above also mentions this
// version for context; bump both together when re-verifying.
const VERIFIED_AGAINST_OPENCODE_VERSION = '1.14.25';

// Required columns on the `session` table. Missing any of these means
// the parser's read path will fail silently in production.
const REQUIRED_SESSION_COLUMNS = ['id', 'directory', 'time_created'] as const;

// Process-lifetime guard: the canary fires at most once per process so
// a long-running app doesn't spam logs on every poll. Reset by
// `__resetSchemaCanaryForTests` so unit tests can exercise the warn
// path repeatedly.
let schemaCanaryRun = false;

/** Test-only hook to reset the once-per-process guard. */
export function __resetSchemaCanaryForTests(): void {
  schemaCanaryRun = false;
}

/**
 * Run a one-shot sanity check on the OpenCode `session` table schema.
 * Emits a single `console.warn` if the `session` table is missing
 * entirely, or if any of `id`, `directory`, `time_created` is absent,
 * so users have a breadcrumb when a future OpenCode release renames or
 * drops a column we depend on.
 *
 * This function never throws: a PRAGMA failure flips the once-flag and
 * returns silently, so the legitimate read path that follows can
 * succeed (the canary may have been a false alarm) or fall through to
 * the existing outer catch in `readMatchingSessionId`.
 */
export function verifyOpenCodeSchemaOnce(
  database: DatabaseType.Database,
  getAgentVersion?: () => string | null,
): void {
  if (schemaCanaryRun) return;
  schemaCanaryRun = true;

  try {
    const rows = database
      .prepare<[], { name: string }>('PRAGMA table_info("session")')
      .all();

    if (rows.length === 0) {
      const version = getAgentVersion?.() ?? null;
      const versionSuffix = version ? ` (detected version: ${version})` : '';
      console.warn(
        `[opencode] opencode.db schema mismatch: \`session\` table is missing${versionSuffix}. ` +
          `Resume will fall back to fresh sessions until this is fixed. ` +
          `Verified against ${VERIFIED_AGAINST_OPENCODE_VERSION}.`,
      );
      return;
    }

    const present = new Set(rows.map((row) => row.name));
    const missing = REQUIRED_SESSION_COLUMNS.filter((column) => !present.has(column));
    if (missing.length > 0) {
      const version = getAgentVersion?.() ?? null;
      const versionSuffix = version ? ` (detected version: ${version})` : '';
      const columnList = missing.map((column) => `\`${column}\``).join(', ');
      console.warn(
        `[opencode] opencode.db schema mismatch: missing column(s) ${columnList} in \`session\` table${versionSuffix}. ` +
          `Resume will fall back to fresh sessions until this is fixed. ` +
          `Verified against ${VERIFIED_AGAINST_OPENCODE_VERSION}.`,
      );
    }
  } catch {
    // PRAGMA itself failed - leave the flag set so we don't loop and
    // let the real SELECT below decide whether the DB is usable.
  }
}

interface SessionIdRow {
  id: string;
}

/**
 * Open the OpenCode DB read-only (WAL-friendly) and return the most
 * recently created session row matching `directory` whose
 * `time_created` is within the window. Returns null if the DB or
 * table is unavailable, or no row matches.
 */
function readMatchingSessionId(
  createdFloorMs: number,
  createdCeilMs: number,
  normalizedCwd: string,
  getAgentVersion?: () => string | null,
): string | null {
  const dbPath = openCodeDbPath();
  if (!fs.existsSync(dbPath)) return null;
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return null;

  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    verifyOpenCodeSchemaOnce(database, getAgentVersion);
    // OpenCode opens its DB in WAL mode; we must NOT change journal
    // mode from a read-only handle. Just read.
    const statement = database.prepare<[number, number], SessionIdRow & { directory: string }>(
      `SELECT id, directory FROM session
       WHERE time_created >= ? AND time_created <= ?
       ORDER BY time_created DESC
       LIMIT 25`,
    );
    const rows = statement.all(createdFloorMs, createdCeilMs);
    for (const row of rows) {
      if (normalizeCwdForCompare(row.directory) === normalizedCwd) {
        return row.id;
      }
    }
    return null;
  } catch {
    // DB locked, schema mismatch, file disappeared mid-read - all
    // recoverable. The poll loop will retry.
    return null;
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Confirm a session ID exists in the DB. Used by `locate()` to avoid
 * returning the DB path for a row that was never persisted.
 */
function sessionIdExists(dbPath: string, sessionId: string): boolean {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return false;
  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    const statement = database.prepare<[string], SessionIdRow>('SELECT id FROM session WHERE id = ? LIMIT 1');
    const row = statement.get(sessionId);
    return row !== undefined;
  } catch {
    return false;
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Resolve the absolute path to OpenCode's SQLite DB. The path is
 * fixed at `<homedir>/.local/share/opencode/opencode.db` on every
 * platform (verified on Windows 11 with OpenCode 1.14.25 - the docs
 * also list this as the canonical location for macOS/Linux).
 */
function openCodeDbPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Normalize a path for cross-platform comparison. OpenCode writes
 * directories with OS-native separators (backslashes on Windows).
 * Lowercase on win32 because NTFS is case-insensitive.
 */
function normalizeCwdForCompare(raw: string): string {
  const normalized = path.normalize(raw).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
