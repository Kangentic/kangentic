import * as fs from 'node:fs';
import * as path from 'node:path';
import { replacePathPrefix } from '../../../../shared/paths';
import { loadBetterSqlite3, openCodeDbPath } from './session-history-parser';
import { writeTransaction } from '../../../db/transaction';

/**
 * Migrate OpenCode's per-project session data when a Kangentic project is
 * relocated.
 *
 * OpenCode stores sessions in a single SQLite database at
 * `~/.local/share/opencode/opencode.db` (verified on Windows 11 with OpenCode
 * 1.14.25; same XDG path on macOS/Linux). Several columns hold the absolute
 * project/working directory:
 *   - `session.directory`, `session.path`
 *   - `project.worktree`
 *   - `project_directory.directory`
 *
 * OpenCode derives a project's identity from its git remote / root-commit hash,
 * not its path, so sessions are NOT orphaned by a move - but the stored absolute
 * directories go stale, which mis-scopes the per-directory session filter and
 * strands sessions for non-git projects. The migration rewrites the path prefix
 * in those columns. A single prefix pass covers the project root and every
 * worktree, so no pair enumeration is needed.
 *
 * No file backup: the DB may be live (WAL mode) where only `db.backup()` is
 * safe, and that copies the entire (potentially large) message history on every
 * relocation with no retention story. The rewrite is a narrow path-metadata
 * UPDATE inside one transaction, so the failure mode is a rollback to the status
 * quo (stale directories) - identical to not running the hook. `project.sandboxes`
 * (a JSON array of unknown semantics, not resume state) is intentionally left
 * untouched.
 *
 * Best-effort: a missing DB or an unloadable native module is a silent no-op,
 * and a per-row UPDATE that hits a UNIQUE/PK collision is skipped while the rest
 * proceed.
 */
export async function migrateOpenCodeProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  // Resolve up front so the prefix match is consistent with every other adapter
  // (a caller passing a trailing slash or relative path would otherwise skip
  // every row). The IPC caller already resolves, so this is defensive parity.
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const dbPath = openCodeDbPath();
  if (!fs.existsSync(dbPath)) return;

  const Database = loadBetterSqlite3();
  if (!Database) return; // Native module unavailable (e.g. stand-alone Node): silent no-op.

  // (table, column) pairs that store an absolute directory path.
  const targets: Array<{ table: string; column: string }> = [
    { table: 'session', column: 'directory' },
    { table: 'session', column: 'path' },
    { table: 'project', column: 'worktree' },
    { table: 'project_directory', column: 'directory' },
  ];

  let db: import('better-sqlite3').Database | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });

    const existingTables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );

    const applicable = targets.filter((target) => {
      if (!existingTables.has(target.table)) return false;
      const columns = db!.prepare(`PRAGMA table_info(${target.table})`).all() as Array<{ name: string }>;
      return columns.some((column) => column.name === target.column);
    });

    const migrate = writeTransaction(db, () => {
      for (const { table, column } of applicable) {
        const rows = db!
          .prepare(`SELECT rowid AS rowid, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`)
          .all() as Array<{ rowid: number | bigint; value: string }>;
        const update = db!.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
        for (const row of rows) {
          const rewritten = replacePathPrefix(row.value, oldResolved, newResolved);
          if (!rewritten || rewritten === row.value) continue;
          try {
            update.run(rewritten, row.rowid);
          } catch {
            // UNIQUE/PK collision (a row for the new directory already exists):
            // leave the stale row rather than abort the whole transaction.
          }
        }
      }
    });
    migrate();
  } catch (err) {
    console.warn('[OPENCODE_RELOCATE] Failed to rewrite session directories:', err);
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close.
    }
  }
}
