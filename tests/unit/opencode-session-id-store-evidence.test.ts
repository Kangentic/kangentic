/**
 * OpenCode's answer to "does its store hold this session", which the session-id
 * report sends as `id_store`. Runs the adapter's real check with os.homedir()
 * pointed at a temp folder, so no test reads or writes the developer's home.
 * A remote or WSL-targeted OpenCode keeps its database elsewhere, so the local
 * file says nothing about it and the answer is `unknown`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { openCodeDbPath } from '../../src/main/agent/adapters/opencode/session-history-parser';

describe('OpenCode session id store evidence', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-store-evidence-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const storeEvidenceFor = (adapter: OpenCodeAdapter, options: { cwd: string; cliTarget?: never; spawnedAt?: Date }) => {
    const check = adapter.runtime.sessionId?.storeEvidence;
    if (!check) throw new Error('OpenCode declares no store evidence');
    return check(options);
  };

  it('reads absent when OpenCode has not created its database', async () => {
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome })).resolves.toBe('absent');
  });

  it('reads present once the database file exists', async () => {
    fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    fs.writeFileSync(openCodeDbPath(), '');
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome })).resolves.toBe('present');
  });

  it('reads absent when the database path is a directory, not a file', async () => {
    fs.mkdirSync(openCodeDbPath(), { recursive: true });
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome })).resolves.toBe('absent');
  });

  // Sentry DESKTOP-3A on 0.59.0: a Command Terminal no one typed into. The
  // database holds every run on the machine, so its existence said nothing
  // about one session, and an untouched terminal read `present` and reported.
  describe('about one session (spawnedAt)', () => {
    const spawnedAt = new Date(Date.now() - 60_000);
    const COLUMNS = '(id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL)';
    let projectFolder: string;

    beforeEach(() => {
      projectFolder = path.join(fakeHome, 'project');
      fs.mkdirSync(projectFolder);
      fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    });

    /** A database with the tables named, each holding rows of [directory, ms after the spawn]. */
    function plantDatabase(tables: Record<string, Array<[string, number]>>, columns = COLUMNS): void {
      const database = new Database(openCodeDbPath());
      for (const [table, rows] of Object.entries(tables)) {
        database.exec(`CREATE TABLE ${table} ${columns}`);
        rows.forEach(([directory, afterSpawnMs], index) => {
          database.prepare(`INSERT INTO ${table} (id, directory, time_created) VALUES (?, ?, ?)`)
            .run(`ses_${table}_${index}`, directory.replace(/\\/g, '/'), spawnedAt.getTime() + afterSpawnMs);
        });
      }
      database.close();
    }

    const evidence = () => storeEvidenceFor(new OpenCodeAdapter(), { cwd: projectFolder, spawnedAt });

    it('reads absent when the database holds only rows from before this spawn', async () => {
      plantDatabase({ session: [[projectFolder, -600_000], [projectFolder, -4_000]], session_v2: [[projectFolder, -600_000]] });
      await expect(evidence()).resolves.toBe('absent');
    });

    it('reads present for a row made since the spawn in either table, however late', async () => {
      plantDatabase({ session: [[projectFolder, 50_000]] });
      await expect(evidence()).resolves.toBe('present');
    });

    it('reads present for a row only OpenCode 2\'s table has', async () => {
      plantDatabase({ session: [[projectFolder, -600_000]], session_v2: [[projectFolder, 2_000]] });
      await expect(evidence()).resolves.toBe('present');
    });

    it('reads absent for a row made since the spawn in another folder', async () => {
      plantDatabase({ session: [[path.join(projectFolder, 'other'), 2_000]] });
      await expect(evidence()).resolves.toBe('absent');
    });

    it('reads present for a row whose directory is the real path behind a linked project', async () => {
      const link = path.join(fakeHome, 'link-to-project');
      fs.symlinkSync(projectFolder, link, 'junction');
      plantDatabase({ session: [[fs.realpathSync.native(projectFolder), 2_000]] });
      await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: link, spawnedAt })).resolves.toBe('present');
    });

    // The floor is the spawn minus 1 s, for a clock a little behind the database's.
    it('allows 1 s of clock slack below the spawn, and no more', async () => {
      plantDatabase({ session: [[projectFolder, -500]] });
      await expect(evidence()).resolves.toBe('present');

      fs.rmSync(openCodeDbPath());
      plantDatabase({ session: [[projectFolder, -1_500]] });
      await expect(evidence()).resolves.toBe('absent');
    });

    // A subagent's row is in the same folder and newer than its session, and says nothing about whether the root was made.
    it('reads absent for a subagent\'s row alone, and present once its root row is beside it', async () => {
      plantDatabase({ session: [[projectFolder, 2_000]] }, COLUMNS.replace(')', ', parent_id TEXT)'));
      const database = new Database(openCodeDbPath());
      database.prepare('UPDATE session SET parent_id = ?').run('ses_someRootSession');
      database.close();
      await expect(evidence()).resolves.toBe('absent');

      const withRoot = new Database(openCodeDbPath());
      withRoot.prepare('INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)')
        .run('ses_theRoot', projectFolder.replace(/\\/g, '/'), spawnedAt.getTime() + 1_000);
      withRoot.close();
      await expect(evidence()).resolves.toBe('present');
    });

    it('reads absent with no database, where nothing could have been made', async () => {
      await expect(evidence()).resolves.toBe('absent');
    });

    // `absent` drops a report, so it needs a read that worked.
    it('reads unknown when the file is no database, holds no session table, or has one it cannot query', async () => {
      fs.writeFileSync(openCodeDbPath(), 'not a database, and long enough that SQLite reads a header from it. '.repeat(20));
      await expect(evidence()).resolves.toBe('unknown');

      fs.rmSync(openCodeDbPath());
      plantDatabase({ unrelated: [] });
      await expect(evidence()).resolves.toBe('unknown');

      fs.rmSync(openCodeDbPath());
      plantDatabase({ session: [] }, '(id TEXT PRIMARY KEY, folder TEXT)');
      await expect(evidence()).resolves.toBe('unknown');
    });

    it('reads present when one table cannot be queried and the other holds the row', async () => {
      plantDatabase({ session_v2: [] }, '(id TEXT PRIMARY KEY)');
      plantDatabase({ session: [[projectFolder, 2_000]] });
      await expect(evidence()).resolves.toBe('present');
    });
  });

  it('answers unknown for a stored CLI target even when the local database exists', async () => {
    fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    fs.writeFileSync(openCodeDbPath(), '');
    const cliTarget = { kind: 'wsl', distro: 'Ubuntu' } as never;
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome, cliTarget })).resolves.toBe('unknown');
  });

  it('answers unknown for a cwd registered as remote, and present again for another cwd', async () => {
    fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    fs.writeFileSync(openCodeDbPath(), '');
    const adapter = new OpenCodeAdapter();
    const remoteCwd = path.join(fakeHome, 'remote-project');
    const executionTarget = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' }, workingDirectory: '/srv/project' } as never;
    adapter.remoteExecution?.adoptTargets([[remoteCwd, executionTarget]]);
    await expect(storeEvidenceFor(adapter, { cwd: remoteCwd })).resolves.toBe('unknown');
    await expect(storeEvidenceFor(adapter, { cwd: fakeHome })).resolves.toBe('present');
  });
});
