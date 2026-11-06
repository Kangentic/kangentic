import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionUsage } from '../../../../shared/types';
import { timeSyncWork } from '../../../diagnostics/event-loop-lag';
import { loadBetterSqlite3 } from '../../shared/sqlite-loader';

/**
 * Goose's session store, read-only.
 *
 * Since 1.10.0 Goose keeps every session in one SQLite database (Goose's logs
 * guide, https://goose-docs.ai/docs/guides/logs, "Session Records"):
 * `~/.local/share/goose/sessions/sessions.db` on Unix-like systems and
 * `%APPDATA%\Block\goose\data\sessions\sessions.db` on Windows. The session
 * management guide queries its `sessions` table (`id`, `description`,
 * `working_dir`, `created_at`) with sqlite3 directly.
 *
 * The rest of the schema is Goose's source at 1.57.0
 * (`crates/goose/src/session/session_manager.rs`, schema version 17, opened in
 * WAL mode), not a published contract, so every read is defensive:
 * - `sessions`: `id` (`YYYYMMDD_<n>`), `name`, `working_dir`, `created_at`,
 *   `total_tokens` / `input_tokens` / `output_tokens` / `cache_read_tokens` (the
 *   latest turn), their `accumulated_*` lifetime sums, `accumulated_cost`, and
 *   `model_config_json` (`model_name`, `context_limit`).
 * - `messages`: an integer row `id`, `session_id`, `role` (`user` or
 *   `assistant`), `content_json` (the message's content blocks), and
 *   `created_timestamp` (seconds; values above 1e10 are milliseconds, which
 *   Goose's own reader divides back).
 *
 * Kangentic finds a session by the name it passed: a fresh `goose run -n <name>`
 * stores `name = <name>`, and `-r -n <name>` resumes the session whose name or
 * id equals it (`crates/goose-cli/src/cli.rs`, `get_or_create_session_id`).
 *
 * The columns match a real Goose 1.57.0's database (2026-11-05,
 * `docs/audits/ssh-transcript-exports-audit.md`). It is still no published
 * contract: a database or column that is missing answers null or empty, never a
 * throw.
 */

/**
 * The data directory Goose's `Paths::data_dir()` resolves to
 * (`crates/goose/src/config/paths.rs`): `<GOOSE_PATH_ROOT>/data` when that
 * variable is an absolute path, else the `etcetera` app strategy for
 * `Block`/`goose`. That strategy is XDG on Linux and macOS (the logs guide's
 * "Unix-like" path) and `%APPDATA%\Block\goose\data` on Windows.
 */
export function gooseDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const root = environment.GOOSE_PATH_ROOT?.trim();
  if (root && pathModule.isAbsolute(root)) return pathModule.join(root, 'data');
  if (platform === 'win32') {
    const appData = environment.APPDATA?.trim() || pathModule.join(homeDirectory, 'AppData', 'Roaming');
    return pathModule.join(appData, 'Block', 'goose', 'data');
  }
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  const dataHome = xdgDataHome && pathModule.isAbsolute(xdgDataHome)
    ? xdgDataHome
    : pathModule.join(homeDirectory, '.local', 'share');
  return pathModule.join(dataHome, 'goose');
}

/** `<data dir>/sessions/sessions.db`. */
export function gooseSessionsDatabasePath(): string {
  return path.join(gooseDataDirectory(), 'sessions', 'sessions.db');
}

/** Read failures already logged, by database path and message, so a poll tick does not repeat one. */
const loggedReadFailures = new Set<string>();

/**
 * Run a read against the database opened read-only, or answer `fallback` when it
 * is absent, cannot be opened, or the read fails (a table or column this Goose
 * does not have). Goose keeps the database in WAL mode, so a read-only handle
 * reads beside a running Goose without blocking its writes. The schema is not a
 * published contract, so a failed read is logged once per path and message: a
 * Goose release that renames a table shows up in the log instead of only as an
 * empty conversation.
 */
export function withGooseDatabase<Value>(dbPath: string, fallback: Value, read: (database: DatabaseType.Database) => Value): Value {
  return timeSyncWork('transcript:read-goose', () => readGooseDatabase(dbPath, fallback, read));
}

function readGooseDatabase<Value>(dbPath: string, fallback: Value, read: (database: DatabaseType.Database) => Value): Value {
  if (!fs.existsSync(dbPath)) return fallback;
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return fallback;
  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    return read(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureKey = `${dbPath}\n${message}`;
    if (!loggedReadFailures.has(failureKey)) {
      loggedReadFailures.add(failureKey);
      console.warn(`[goose] Session database read failed: ${message}`);
    }
    return fallback;
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

/** The `sessions` row fields Kangentic reads. Every one but the id may be absent on another schema. */
export interface GooseSessionRow {
  id: string;
  name: string | null;
  workingDirectory: string | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  accumulatedInputTokens: number | null;
  accumulatedOutputTokens: number | null;
  accumulatedCost: number | null;
  modelName: string | null;
  contextLimit: number | null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `model_name` and `context_limit` out of `model_config_json` (Goose's `ModelConfig`, snake_case fields). */
function parseModelConfig(value: unknown): { modelName: string | null; contextLimit: number | null } {
  if (typeof value !== 'string') return { modelName: null, contextLimit: null };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return { modelName: null, contextLimit: null };
    const config = parsed as Record<string, unknown>;
    const contextLimit = numberOrNull(config.context_limit);
    return {
      modelName: stringOrNull(config.model_name),
      contextLimit: contextLimit !== null && contextLimit > 0 ? contextLimit : null,
    };
  } catch {
    return { modelName: null, contextLimit: null };
  }
}

/**
 * The session Kangentic named `sessionName`, read from an open database, or null.
 * `SELECT *` so a column a given Goose lacks reads as absent rather than failing
 * the query, and no column is named in the query but the two it matches on. A
 * name Kangentic passes is a UUID, so a second match is not expected and no
 * order is asked for.
 */
export function findGooseSession(database: DatabaseType.Database, sessionName: string): GooseSessionRow | null {
  const row = database
    .prepare<[string, string], Record<string, unknown>>('SELECT * FROM sessions WHERE name = ? OR id = ? LIMIT 1')
    .get(sessionName, sessionName);
  if (!row || typeof row.id !== 'string') return null;
  const { modelName, contextLimit } = parseModelConfig(row.model_config_json);
  return {
    id: row.id,
    name: stringOrNull(row.name),
    workingDirectory: stringOrNull(row.working_dir),
    totalTokens: numberOrNull(row.total_tokens),
    inputTokens: numberOrNull(row.input_tokens),
    outputTokens: numberOrNull(row.output_tokens),
    cacheReadTokens: numberOrNull(row.cache_read_tokens),
    accumulatedInputTokens: numberOrNull(row.accumulated_input_tokens),
    accumulatedOutputTokens: numberOrNull(row.accumulated_output_tokens),
    accumulatedCost: numberOrNull(row.accumulated_cost),
    modelName,
    contextLimit,
  };
}

/** The session named `sessionName` in the database at `dbPath`, or null. */
export function readGooseSession(dbPath: string, sessionName: string): GooseSessionRow | null {
  return withGooseDatabase(dbPath, null, (database) => findGooseSession(database, sessionName));
}

/**
 * The live usage a session row gives, for the context bar and the card:
 * - model: `model_config_json.model_name`, shown as Goose names it (Goose runs
 *   any provider's model, so no display table and no humanizing);
 * - context: `total_tokens` of the latest turn against `context_limit`, which
 *   is what Goose's own context bar draws (`display_context_usage`). A config
 *   with no limit reports size 0, the "unknown" sentinel, never a guessed limit;
 * - tokens and cost: the lifetime `accumulated_*` sums.
 * Null when the row carries none of these yet.
 */
export function gooseSessionUsage(row: GooseSessionRow): Partial<SessionUsage> | null {
  const usedTokens = row.totalTokens ?? 0;
  const contextWindowSize = row.contextLimit ?? 0;
  const hasTokens = row.totalTokens !== null || row.accumulatedInputTokens !== null || row.accumulatedOutputTokens !== null;
  const usage: Partial<SessionUsage> = {};
  if (hasTokens) {
    usage.contextWindow = {
      usedPercentage: contextWindowSize > 0 ? Math.min(100, (usedTokens / contextWindowSize) * 100) : 0,
      usedTokens,
      cacheTokens: row.cacheReadTokens ?? 0,
      totalInputTokens: row.accumulatedInputTokens ?? row.inputTokens ?? 0,
      totalOutputTokens: row.accumulatedOutputTokens ?? row.outputTokens ?? 0,
      contextWindowSize,
    };
  }
  if (row.accumulatedCost !== null) {
    usage.cost = { totalCostUsd: row.accumulatedCost, totalDurationMs: 0 };
  }
  if (row.modelName) {
    usage.model = { id: row.modelName, displayName: row.modelName, reportedByAgent: true };
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * A cheap change stamp for the database: the newest mtime and the summed size of
 * `sessions.db` and its `-wal`, or null when the database is absent. Goose
 * writes new rows to the WAL first, so the WAL's stamp moves on every turn.
 */
export function gooseDatabaseStamp(dbPath: string): string | null {
  let stamp: string | null = null;
  for (const filePath of [dbPath, `${dbPath}-wal`]) {
    try {
      const stats = fs.statSync(filePath);
      stamp = `${stamp ?? ''}${stats.mtimeMs}:${stats.size};`;
    } catch {
      // A missing WAL is normal after a checkpoint.
    }
  }
  return stamp;
}
