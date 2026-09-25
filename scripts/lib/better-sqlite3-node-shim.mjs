/**
 * The slice of better-sqlite3's API the OpenCode transcript parser uses, backed by node:sqlite.
 *
 * The parser is the real one, imported from src/main, so the demo's OpenCode trail is built by the
 * same code the desktop runs. It reaches SQLite through a lazy `require('better-sqlite3')`, and
 * this repo's better-sqlite3 is rebuilt against Electron's ABI (NODE_MODULE_VERSION 145), so plain
 * Node 24 (137) cannot load the binding at all. Capture tooling runs under plain Node.
 *
 * Rather than reimplement the parser for the demo, which is the drift this whole change exists to
 * avoid, swap out the database driver underneath it. Node 24 ships SQLite, and the parser only
 * ever opens a file read-only, prepares a statement, and reads rows.
 *
 * Read-only, and used only by capture tooling. Nothing here ships.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class ShimStatement {
  constructor(statement) {
    this.statement = statement;
  }

  all(...parameters) {
    return this.statement.all(...parameters);
  }

  get(...parameters) {
    return this.statement.get(...parameters);
  }
}

class ShimDatabase {
  constructor(filePath, options = {}) {
    // node:sqlite has no fileMustExist option: a read-only open of a missing file throws a
    // less obvious error, so check first and keep better-sqlite3's contract.
    if (options.fileMustExist && !fs.existsSync(filePath)) {
      throw new Error(`[shim] SQLite file does not exist: ${filePath}`);
    }
    this.database = new DatabaseSync(filePath, { readOnly: options.readonly === true });
  }

  prepare(sql) {
    return new ShimStatement(this.database.prepare(sql));
  }

  close() {
    this.database.close();
  }
}

export default ShimDatabase;
