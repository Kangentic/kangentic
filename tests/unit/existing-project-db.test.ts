/**
 * `getExistingProjectDb` (src/main/db/database.ts): the read for a project id
 * another record stored (a workflow's home, a link's far end, a planned task's
 * board), which can outlive its project. `getProjectDb` on main creates,
 * migrates and seeds a database for any id it is given, so a read of a deleted
 * project's id used to bring its file back, empty. This one never creates a file.
 *
 * Runs the real module against the throwaway data directory every test file
 * gets (tests/unit/helpers/isolate-data-dir.ts).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { PATHS } from '../../src/main/config/paths';
import { closeAll, closeProjectDb, getExistingProjectDb, getProjectDb } from '../../src/main/db/database';

describe('getExistingProjectDb', () => {
  afterAll(() => {
    closeAll();
  });

  it('returns null for a project with no database, and creates no file for it', () => {
    expect(getExistingProjectDb('never-created')).toBeNull();
    expect(fs.existsSync(PATHS.projectDb('never-created'))).toBe(false);
  });

  it('returns the open connection getProjectDb opened', () => {
    const opened = getProjectDb('open-project');
    expect(getExistingProjectDb('open-project')).toBe(opened);
  });

  it('opens a database whose file is there but is not open yet, as for a live home after a restart', () => {
    getProjectDb('closed-project');
    closeProjectDb('closed-project');

    const reopened = getExistingProjectDb('closed-project');

    expect(reopened).not.toBeNull();
    expect(reopened!.prepare("SELECT COUNT(*) AS count FROM swimlanes WHERE role = 'todo'").get()).toEqual({ count: 1 });
  });

  it('returns null once a project delete has closed and unlinked its file, and does not bring it back', () => {
    getProjectDb('deleted-project');
    closeProjectDb('deleted-project');
    const databasePath = PATHS.projectDb('deleted-project');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });

    expect(getExistingProjectDb('deleted-project')).toBeNull();
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});
