import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBetterSqlite3 } from '../../shared/sqlite-loader';
import { pathStoreEvidence } from '../../shared/store-evidence';
import type { SessionIdStoreEvidence } from '../../../../shared/types';

// The lazy better-sqlite3 loader is shared with Goose's reader. Re-exported so
// this module's importers (and the tests that mock it here) keep their path.
export { loadBetterSqlite3 };

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
 *     `directory` text NOT NULL,       -- absolute path (forward slashes on
 *                                      --   Windows by 1.18 and in V2)
 *     `time_created` integer NOT NULL, -- epoch ms
 *     `time_updated` integer NOT NULL,
 *     ...
 *   )
 *
 * OpenCode 2 (2.2.5) keeps the same file and writes new sessions to
 * `session_v2`, which has the same three columns (`SESSION_TABLES`).
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
   * The poll runs to the end of that window: every 500 ms for the first 10 s,
   * when almost every row lands, then every 2 s, since each read opens the
   * database on the main process. It used to stop at 10 s, so a row made in the
   * 20 s after that was accepted and never looked for (Sentry DESKTOP-3A). It
   * ends early once `shouldContinue` answers no, which is when the id came
   * another way (the plugin's) or the session is gone.
   *
   * Returns null if the DB does not exist (OpenCode never run on this
   * machine), the table is missing (older format), or no row matches
   * before the poll ends.
   */
  static async captureSessionIdFromFilesystem(options: {
    spawnedAt: Date;
    cwd: string;
    /** For tests and the probe script. Without it the window alone ends the poll. */
    maxAttempts?: number;
    getAgentVersion?: () => string | null;
    shouldContinue?: () => boolean;
    /** Injected so tests need no real wait. */
    sleep?: (milliseconds: number) => Promise<void>;
  }): Promise<string | null> {
    const spawnedAtMs = options.spawnedAt.getTime();
    // Match the Codex parser's window shape: ±a few seconds for clock
    // skew on the floor, generous +30s on the ceil because OpenCode
    // may take a moment to insert the row after CLI startup.
    const createdFloorMs = spawnedAtMs - 5_000;
    const createdCeilMs = spawnedAtMs + CREATED_WINDOW_MS;
    const cwdKeys = await cwdComparisonKeys(options.cwd);
    const wait = options.sleep ?? sleep;
    const maxAttempts = options.maxAttempts ?? Infinity;

    let waitedMs = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const id = readMatchingSessionId(createdFloorMs, createdCeilMs, cwdKeys, options.getAgentVersion);
      if (id) return id;
      // Past the window by now: this read saw every row the window can hold.
      if (waitedMs > CREATED_WINDOW_MS) return null;
      const delayMs = waitedMs < FAST_POLL_SPAN_MS ? FAST_POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
      await wait(delayMs);
      waitedMs += delayMs;
      if (options.shouldContinue && !options.shouldContinue()) return null;
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
    return sessionIdExists(options.agentSessionId) ? dbPath : null;
  }

  /**
   * Whether `opencode.db` holds this session, the file
   * `captureSessionIdFromFilesystem` reads. For the session-id report only. A
   * fixed word, never a path.
   *
   * With `spawnedAt`, `present` needs a row made at or after the spawn in this
   * session's cwd, with no upper bound, because OpenCode makes its session at
   * the first prompt, which can come minutes later. The file alone said nothing
   * about one session, because it holds every run on the machine, so a Command
   * Terminal no one typed into read `present` and reported (Sentry DESKTOP-3A on
   * 0.59.0). `absent` is what drops that report, so it needs a read that worked.
   * A database that cannot be opened or queried, or holds no session table, is
   * `unknown`. A sibling started later in the same cwd can read as this
   * session's, which only moves the answer toward `present`, the side that
   * reports. Without `spawnedAt` it is the file check.
   */
  static async storeEvidence(options: { cwd: string; spawnedAt?: Date }): Promise<SessionIdStoreEvidence> {
    const file = await pathStoreEvidence(openCodeDbPath(), 'file');
    if (file !== 'present' || !options.spawnedAt) return file;
    const createdFloorMs = options.spawnedAt.getTime() - SPAWN_CLOCK_SLACK_MS;
    const cwdKeys = await cwdComparisonKeys(options.cwd);
    const read = readSessionDatabase((database) => readRootSessionRows(database, createdFloorMs, null));
    if (!read) return 'unknown';
    if (read.rows.some((row) => cwdKeys.has(normalizeCwdForCompare(row.directory)))) return 'present';
    return read.complete ? 'absent' : 'unknown';
  }
}

// ---------- Internal helpers ----------

/** How long after the spawn a row may be made and still be taken as this spawn's. */
const CREATED_WINDOW_MS = 30_000;
const FAST_POLL_INTERVAL_MS = 500;
const FAST_POLL_SPAN_MS = 10_000;
const SLOW_POLL_INTERVAL_MS = 2_000;
/** `storeEvidence`'s slack below the spawn time, as Codex's. */
const SPAWN_CLOCK_SLACK_MS = 1_000;

// Verified-against versions baked into the warning so future readers
// know which OpenCode releases we last observed the schema match.
// Single source of truth - the class JSDoc above also mentions these
// versions for context; bump both together when re-verifying.
const VERIFIED_AGAINST_OPENCODE_VERSION = '1.14.25 and 2.2.5';

// Required columns on a session table (`session` or `session_v2`). Missing
// any of these means the parser's read path will fail silently in production.
const REQUIRED_SESSION_COLUMNS = ['id', 'directory', 'time_created'] as const;

/**
 * The tables a session row can be in. OpenCode 1 writes `session`.
 * OpenCode 2 (measured on 2.2.5) migrates the same `opencode.db` in place:
 * it leaves `session` as it was, copies its rows into `session_v2`, and
 * writes every new session to `session_v2` only. An OpenCode 1 run after
 * that writes `session` again, so both are read whichever version runs.
 */
const SESSION_TABLES = ['session_v2', 'session'] as const;

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
 * Run a one-shot sanity check on OpenCode's session table schema: either
 * `session_v2` (OpenCode 2) or `session` (OpenCode 1) must carry `id`,
 * `directory` and `time_created`. When neither does, it emits a single
 * `console.warn` naming the table and the missing columns, so users have a
 * breadcrumb when a future OpenCode release renames or drops a column we
 * depend on.
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
    const columnsOf = (table: string): Set<string> => new Set(
      database.prepare<[], { name: string }>(`PRAGMA table_info("${table}")`).all().map((row) => row.name),
    );
    // Either session table with every column the read needs is enough.
    const v2Columns = columnsOf('session_v2');
    if (REQUIRED_SESSION_COLUMNS.every((column) => v2Columns.has(column))) return;
    const v1Columns = columnsOf('session');
    if (REQUIRED_SESSION_COLUMNS.every((column) => v1Columns.has(column))) return;

    const warn = (problem: string): void => {
      const version = getAgentVersion?.() ?? null;
      const versionSuffix = version ? ` (detected version: ${version})` : '';
      console.warn(
        `[opencode] opencode.db schema mismatch: ${problem}${versionSuffix}. ` +
          `Resume will fall back to fresh sessions until this is fixed. ` +
          `Verified against ${VERIFIED_AGAINST_OPENCODE_VERSION}.`,
      );
    };
    const missingIn = (table: string, columns: Set<string>): string => {
      const columnList = REQUIRED_SESSION_COLUMNS.filter((column) => !columns.has(column)).map((column) => `\`${column}\``).join(', ');
      return `missing column(s) ${columnList} in \`${table}\` table`;
    };

    if (v2Columns.size > 0) warn(missingIn('session_v2', v2Columns));
    else if (v1Columns.size === 0) warn('`session` table is missing');
    else warn(missingIn('session', v1Columns));
  } catch {
    // PRAGMA itself failed - leave the flag set so we don't loop and
    // let the real SELECT below decide whether the DB is usable.
  }
}

interface SessionIdRow {
  id: string;
}

interface SessionRow extends SessionIdRow {
  directory: string;
  time_created: number;
}

/**
 * Open the OpenCode DB read-only (WAL-friendly) for one read, or null when it
 * cannot be opened or read. OpenCode opens its DB in WAL mode; we must NOT
 * change journal mode from a read-only handle. Just read.
 */
function readSessionDatabase<Result>(read: (database: DatabaseType.Database) => Result): Result | null {
  const dbPath = openCodeDbPath();
  if (!fs.existsSync(dbPath)) return null;
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return null;

  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    return read(database);
  } catch {
    // report-ok: DB locked, schema mismatch, file disappeared mid-read. The poll retries, the report reads `unknown`, and `locate` finds no file.
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // report-ok: a handle that will not close held nothing but a read.
    }
  }
}

/**
 * The sessions made in the span (`createdCeilMs` null: no end), newest first,
 * from whichever session tables this database has. A subagent's session is
 * left out. It is a row in the same folder, newer than the session that started
 * it, and its id would resume the subagent. `complete` says every session table
 * there was read, and that there was one, so no match means no row.
 */
function readRootSessionRows(
  database: DatabaseType.Database,
  createdFloorMs: number,
  createdCeilMs: number | null,
): { rows: SessionRow[]; complete: boolean } {
  const rows: SessionRow[] = [];
  let tablesRead = 0;
  let tablesFailed = 0;
  for (const table of SESSION_TABLES) {
    try {
      const columns = database.prepare<[], { name: string }>(`PRAGMA table_info("${table}")`).all();
      // No such table (an OpenCode 1 database, or a fresh OpenCode 2 one).
      if (columns.length === 0) continue;
      const rootsOnly = columns.some((column) => column.name === 'parent_id') ? 'AND parent_id IS NULL' : '';
      rows.push(...database.prepare<[number, number], SessionRow>(
        `SELECT id, directory, time_created FROM ${table}
         WHERE time_created >= ? AND time_created <= ? ${rootsOnly}`,
      ).all(createdFloorMs, createdCeilMs ?? Number.MAX_SAFE_INTEGER));
      tablesRead += 1;
    } catch {
      // report-ok: a table another release changed. The schema canary logs it, and `complete` carries it.
      tablesFailed += 1;
    }
  }
  rows.sort((left, right) => right.time_created - left.time_created);
  return { rows, complete: tablesRead > 0 && tablesFailed === 0 };
}

/**
 * The id of the most recently created session row in this cwd whose
 * `time_created` is within the window, or null when the DB or table is
 * unavailable, or no row matches.
 */
function readMatchingSessionId(
  createdFloorMs: number,
  createdCeilMs: number,
  cwdKeys: ReadonlySet<string>,
  getAgentVersion?: () => string | null,
): string | null {
  return readSessionDatabase((database) => {
    verifyOpenCodeSchemaOnce(database, getAgentVersion);
    const { rows } = readRootSessionRows(database, createdFloorMs, createdCeilMs);
    return rows.find((row) => cwdKeys.has(normalizeCwdForCompare(row.directory)))?.id ?? null;
  });
}

/**
 * Confirm a session ID exists in the DB. Used by `locate()` to avoid
 * returning the DB path for a row that was never persisted.
 */
function sessionIdExists(sessionId: string): boolean {
  return readSessionDatabase((database) => SESSION_TABLES.some((table) => {
    try {
      return database.prepare<[string], SessionIdRow>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`).get(sessionId) !== undefined;
    } catch {
      // report-ok: no such table in this database, so the id is not in it.
      return false;
    }
  })) ?? false;
}

/**
 * How many saved credentials an OpenCode 2 database holds (`credential`, where
 * V2 keeps provider sign-ins), or 0 when the file, the table or the native
 * module is missing. Counts rows only; no credential value is read.
 */
export function openCodeCredentialCount(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return 0;
  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    return database.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM credential').get()?.count ?? 0;
  } catch {
    return 0;
  } finally {
    try { database?.close(); } catch { /* ignore */ }
  }
}

/**
 * Resolve the absolute path to OpenCode's SQLite DB. The path is
 * fixed at `<homedir>/.local/share/opencode/opencode.db` on every
 * platform (verified on Windows 11 with OpenCode 1.14.25 - the docs
 * also list this as the canonical location for macOS/Linux).
 */
export function openCodeDbPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Normalize a path for cross-platform comparison. OpenCode's separators
 * vary by version on Windows: backslashes in early OpenCode 1 releases,
 * forward slashes by 1.18 and in OpenCode 2. `path.normalize` makes them one.
 * Lowercase on win32 because NTFS is case-insensitive.
 */
function normalizeCwdForCompare(raw: string): string {
  const normalized = path.normalize(raw).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * The cwd as a row's `directory` may hold it: as given, and as its real path.
 * OpenCode stores the resolved real path of the folder it runs in
 * (`FSUtil.resolve`, native `realpathSync`), so a project reached through a
 * junction, a symlink or a subst drive never matched the path we spawned with.
 */
async function cwdComparisonKeys(cwd: string): Promise<ReadonlySet<string>> {
  const keys = new Set([normalizeCwdForCompare(cwd)]);
  try {
    keys.add(normalizeCwdForCompare(await fs.promises.realpath(cwd)));
  } catch {
    // report-ok: a folder with no real path to read (gone, or no access) is compared as given.
  }
  return keys;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
