import type Database from 'better-sqlite3';

const statementsByConnection = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/**
 * `sql` prepared once per connection, for a read that runs on every pass of a
 * hot loop, where compiling the statement each time can cost more than running
 * it. Keyed by the connection object, so a reopened database prepares afresh
 * and a closed one's statements are collected with it.
 */
export function cachedStatement(db: Database.Database, sql: string): Database.Statement {
  let statements = statementsByConnection.get(db);
  if (!statements) {
    statements = new Map();
    statementsByConnection.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}
