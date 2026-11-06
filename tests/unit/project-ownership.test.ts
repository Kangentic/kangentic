/**
 * Whether this instance owns a project's folder. On 2026-11-05 a second instance,
 * started with a copy of `index.db` and empty per-project databases, deleted real
 * worktrees and attachments on every registered project: an empty database read
 * as "nothing here is mine". Every test below runs on a real folder and a real
 * database, with the real migrations.
 *
 * Tier: Unit. Nothing Electron-specific is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import {
  decideOwnership,
  verifyProjectOwnership,
  type OwnershipFacts,
  type ProjectStanding,
} from '../../src/main/project-ownership/project-ownership';
import { openTestDatabase } from './helpers/test-database';

// Delegates to the real write; a test flips `failWrites` to make the marker write report failure.
const safeWriteControl = vi.hoisted(() => ({ failWrites: false }));
vi.mock('../../src/main/safe-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/safe-write')>();
  return {
    ...actual,
    safeWriteJson: (...args: Parameters<typeof actual.safeWriteJson>): boolean => (
      safeWriteControl.failWrites ? false : actual.safeWriteJson(...args)
    ),
  };
});

let workspace: string;
let projectPath: string;
let dataDir: string;
const openDatabases: Database.Database[] = [];

interface Instance {
  databasePath: string;
  database: Database.Database;
  tasks: TaskRepository;
  sessions: SessionRepository;
  swimlaneId: string;
}

function openInstance(name: string, sourceDatabase?: string): Instance {
  const databasePath = path.join(dataDir, `${name}.db`);
  if (sourceDatabase) fs.copyFileSync(sourceDatabase, databasePath);
  const database = openTestDatabase(databasePath);
  openDatabases.push(database);
  runProjectMigrations(database);
  const swimlaneId = new SwimlaneRepository(database).list()[0].id;
  return { databasePath, database, tasks: new TaskRepository(database), sessions: new SessionRepository(database), swimlaneId };
}

function verify(instance: Instance, folder = projectPath): Promise<ProjectStanding> {
  return verifyProjectOwnership(folder, instance.databasePath, instance.database, instance.tasks, instance.sessions);
}

function addTask(instance: Instance): string {
  return instance.tasks.create({ title: 'A task', description: '', swimlane_id: instance.swimlaneId }).id;
}

function populate(folder: string, ...entries: string[]): void {
  for (const entry of entries) fs.mkdirSync(path.join(folder, '.kangentic', entry), { recursive: true });
}

function markerOf(folder: string): Record<string, string> | null {
  const markerPath = path.join(folder, '.kangentic', 'project-owner.json');
  return fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Record<string, string> : null;
}

/** An instance that has claimed the project: a task of its own, and that task's folder. */
async function claimedInstance(name = 'owner'): Promise<Instance> {
  const owner = openInstance(name);
  populate(projectPath, path.join('tasks', addTask(owner)));
  const standing = await verify(owner);
  expect(standing.kind).toBe('owned');
  return owner;
}

beforeEach(() => {
  safeWriteControl.failWrites = false;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-ownership-'));
  projectPath = path.join(workspace, 'project');
  dataDir = path.join(workspace, 'data');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(dataDir);
});

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('verifyProjectOwnership', () => {
  it('an empty database never claims a populated folder, and writes nothing', async () => {
    // The incident, with no marker: every project had none that day.
    populate(projectPath, 'worktrees/1003', 'tasks/some-task', 'sessions/some-session');
    const fresh = openInstance('fresh');

    expect((await verify(fresh)).kind).toBe('unclaimed');
    expect(markerOf(projectPath)).toBeNull();
    expect(fresh.database.prepare('SELECT value FROM schema_meta WHERE key = ?').get('folder_owner_token')).toBeUndefined();
  });

  it('a fresh database cannot take a folder another live database owns', async () => {
    // The incident, on a project that has its marker.
    const owner = await claimedInstance();
    const markerBefore = markerOf(projectPath);
    const fresh = openInstance('fresh');

    expect(await verify(fresh)).toEqual({ kind: 'foreign', ownerDatabase: owner.databasePath });
    expect(markerOf(projectPath)).toEqual(markerBefore);
  });

  it('a full copy of the data directory is foreign, though it holds the token and the rows', async () => {
    const owner = await claimedInstance();
    owner.database.pragma('wal_checkpoint(TRUNCATE)');
    const copy = openInstance('copy', owner.databasePath);

    expect((await verify(copy)).kind).toBe('foreign');
  });

  it('a foreign instance with tasks of its own still cannot claim', async () => {
    await claimedInstance();
    const other = openInstance('other');
    populate(projectPath, path.join('tasks', addTask(other)));

    expect((await verify(other)).kind).toBe('foreign');
  });

  it('the owner stays the owner on the next open', async () => {
    const owner = await claimedInstance();
    const markerBefore = markerOf(projectPath);

    expect((await verify(owner)).kind).toBe('owned');
    expect(markerOf(projectPath)).toEqual(markerBefore);
  });

  it.each([
    ['a task folder', 'tasks'],
    ['a session folder', 'sessions'],
  ])('an upgrading project claims on evidence: %s', async (_label, folder) => {
    const owner = openInstance('owner');
    const taskId = addTask(owner);
    populate(projectPath, path.join(folder, taskId), path.join(folder, 'someone-elses'));

    const standing = await verify(owner);

    expect(standing.kind).toBe('owned');
    expect(markerOf(projectPath)).toMatchObject({ database: owner.databasePath, projectPath });
  });

  it('claims on a worktree folder a task names', async () => {
    const owner = openInstance('owner');
    const created = owner.tasks.create({ title: 'A task', description: '', swimlane_id: owner.swimlaneId });
    owner.tasks.update({ id: created.id, worktree_path: path.join(projectPath, '.kangentic', 'worktrees', '7') });
    populate(projectPath, 'worktrees/7');

    expect((await verify(owner)).kind).toBe('owned');
  });

  it('claims when its tasks stand beside an empty folder: nothing there is at risk', async () => {
    const owner = openInstance('owner');
    addTask(owner);

    expect((await verify(owner)).kind).toBe('owned');
  });

  it('a spare worktree is no evidence and puts nothing at risk', async () => {
    const owner = openInstance('owner');
    addTask(owner);
    populate(projectPath, 'worktrees/spare_0a1b2c3d');

    expect((await verify(owner)).kind).toBe('owned');
  });

  it('a database whose rows name nothing on disk does not claim a populated folder', async () => {
    const stranger = openInstance('stranger');
    addTask(stranger);
    populate(projectPath, 'tasks/someone-elses');

    expect((await verify(stranger)).kind).toBe('unclaimed');
    expect(markerOf(projectPath)).toBeNull();
  });

  it('a relocated project is still owned, and its marker follows it', async () => {
    const owner = await claimedInstance();
    const movedPath = path.join(workspace, 'moved');
    fs.renameSync(projectPath, movedPath);

    expect((await verify(owner, movedPath)).kind).toBe('owned');
    expect(markerOf(movedPath)?.projectPath).toBe(movedPath);
  });

  it('a copied folder reads as unmarked: the marker there was written for the original', async () => {
    const owner = await claimedInstance();
    const copyPath = path.join(workspace, 'copy');
    fs.cpSync(projectPath, copyPath, { recursive: true });
    const added = openInstance('added');
    const addedTask = addTask(added);

    // Not foreign, or the copy would never recover its own sessions.
    expect((await verify(added, copyPath)).kind).toBe('unclaimed');

    populate(copyPath, path.join('tasks', addedTask));
    expect((await verify(added, copyPath)).kind).toBe('owned');
    expect(markerOf(copyPath)).toMatchObject({ database: added.databasePath, projectPath: copyPath });
    expect(markerOf(projectPath)).toMatchObject({ database: owner.databasePath });
  });

  it('a moved data directory claims again: the database the marker names is gone', async () => {
    const owner = await claimedInstance();
    const taskRow = owner.tasks.list()[0];
    owner.database.pragma('wal_checkpoint(TRUNCATE)');
    const movedDatabase = path.join(dataDir, 'moved.db');
    fs.copyFileSync(owner.databasePath, movedDatabase);
    owner.database.close();
    openDatabases.splice(openDatabases.indexOf(owner.database), 1);
    fs.rmSync(owner.databasePath);
    fs.rmSync(`${owner.databasePath}-wal`, { force: true });
    fs.rmSync(`${owner.databasePath}-shm`, { force: true });

    const moved = openInstance('moved');

    expect(moved.tasks.getById(taskRow.id)).toBeDefined();
    expect((await verify(moved)).kind).toBe('owned');
    expect(markerOf(projectPath)?.database).toBe(moved.databasePath);
  });

  it('a database replaced by an empty one sweeps nothing, though the marker names its path', async () => {
    const owner = await claimedInstance();
    owner.database.close();
    openDatabases.splice(openDatabases.indexOf(owner.database), 1);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${owner.databasePath}${suffix}`, { force: true });

    const replacement = openInstance('owner');

    expect((await verify(replacement)).kind).toBe('unclaimed');
  });

  it('a marker that does not parse counts as none', async () => {
    const owner = openInstance('owner');
    const taskId = addTask(owner);
    populate(projectPath, path.join('tasks', taskId));
    fs.writeFileSync(path.join(projectPath, '.kangentic', 'project-owner.json'), '{ not json');

    expect((await verify(owner)).kind).toBe('owned');
  });

  it('a check that fails sweeps nothing and never rejects', async () => {
    const owner = openInstance('owner');
    addTask(owner);
    populate(projectPath, 'tasks/some-task');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingTasks = { list: () => { throw new Error('database is closed'); }, listArchived: () => [] };

    const standing = await verifyProjectOwnership(projectPath, owner.databasePath, owner.database, failingTasks as never, owner.sessions);

    expect(standing.kind).toBe('unclaimed');
    warnSpy.mockRestore();
  });

  it('a marker that cannot be written is no ownership, and the next open reuses the token it left', async () => {
    // An unmarked folder with a task and nothing else in it: the claim path, so the write is reached.
    const owner = openInstance('owner');
    addTask(owner);
    const tokenOf = (): string | undefined => (owner.database
      .prepare('SELECT value FROM schema_meta WHERE key = ?').get('folder_owner_token') as { value: string } | undefined)?.value;
    safeWriteControl.failWrites = true;

    expect((await verify(owner)).kind).toBe('unclaimed');
    expect(markerOf(projectPath)).toBeNull();
    const leftToken = tokenOf();
    expect(leftToken).toBeTruthy();

    safeWriteControl.failWrites = false;
    expect((await verify(owner)).kind).toBe('owned');
    expect(tokenOf()).toBe(leftToken);
    expect(markerOf(projectPath)?.token).toBe(leftToken);
  });

  it('a marker of the wrong shape counts as none', async () => {
    const owner = await claimedInstance();
    const rival = openInstance('rival');
    const rivalTask = addTask(rival);
    populate(projectPath, path.join('tasks', rivalTask));
    // Names the live owner's database, so were it believed the folder would read foreign.
    const wrongShape = { token: 1, database: owner.databasePath, projectPath };
    fs.writeFileSync(path.join(projectPath, '.kangentic', 'project-owner.json'), JSON.stringify(wrongShape));

    expect((await verify(rival)).kind).toBe('owned');
    expect(markerOf(projectPath)).toMatchObject({ database: rival.databasePath });
  });

  it('a marker that is an empty object counts as none, so an empty database claims nothing', async () => {
    populate(projectPath, 'tasks/someone-elses');
    fs.writeFileSync(path.join(projectPath, '.kangentic', 'project-owner.json'), '{}');
    const fresh = openInstance('fresh');

    expect((await verify(fresh)).kind).toBe('unclaimed');
    expect(fs.readFileSync(path.join(projectPath, '.kangentic', 'project-owner.json'), 'utf-8')).toBe('{}');
  });

  describe('through a link', () => {
    function linkTo(target: string, name: string): string {
      const linkPath = path.join(workspace, name);
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return linkPath;
    }
    const markerText = (): string => fs.readFileSync(path.join(projectPath, '.kangentic', 'project-owner.json'), 'utf-8');

    it('the owner opening its folder through a link stays the owner and rewrites nothing', async () => {
      const owner = await claimedInstance();
      const textBefore = markerText();

      expect((await verify(owner, linkTo(projectPath, 'project-link'))).kind).toBe('owned');
      expect(markerText()).toBe(textBefore);
    });

    it('a full data directory copy opening the owner folder through a link is foreign and writes nothing', async () => {
      const owner = await claimedInstance();
      owner.database.pragma('wal_checkpoint(TRUNCATE)');
      const copy = openInstance('copy', owner.databasePath);
      const textBefore = markerText();

      expect(await verify(copy, linkTo(projectPath, 'project-link'))).toMatchObject({ kind: 'foreign' });
      expect(markerText()).toBe(textBefore);
    });

    it('the owner database reached through a linked data directory stays the owner', async () => {
      const owner = await claimedInstance();
      const linkedDataDir = linkTo(dataDir, 'data-link');

      const standing = await verifyProjectOwnership(
        projectPath, path.join(linkedDataDir, 'owner.db'), owner.database, owner.tasks, owner.sessions,
      );

      expect(standing.kind).toBe('owned');
    });
  });
});

describe('decideOwnership', () => {
  const BASE: OwnershipFacts = {
    marker: null,
    projectPath: '/project',
    databasePath: '/data/mine.db',
    databaseToken: null,
    markerDatabaseExists: false,
    hasTasks: false,
    sharesFolderEntry: false,
    folderEmpty: false,
  };
  const MINE = { token: 'token-1', database: '/data/mine.db', projectPath: '/project' };
  const THEIRS = { token: 'token-1', database: '/data/theirs.db', projectPath: '/project' };

  it.each<[string, Partial<OwnershipFacts>, ReturnType<typeof decideOwnership>]>([
    ['the token matches', { marker: MINE, databaseToken: 'token-1' }, 'owned'],
    ['the token differs and the database is empty', { marker: MINE, databaseToken: 'token-2' }, 'unclaimed'],
    ['this database has no token and rows on disk', { marker: MINE, hasTasks: true, sharesFolderEntry: true }, 'claim'],
    ['another live database owns it', { marker: THEIRS, markerDatabaseExists: true, databaseToken: 'token-1' }, 'foreign'],
    ['another database owned it and is gone', { marker: THEIRS, hasTasks: true, sharesFolderEntry: true }, 'claim'],
    ['no marker, no tasks, an empty folder', { folderEmpty: true }, 'unclaimed'],
    ['no marker, no tasks, a populated folder', {}, 'unclaimed'],
    ['no marker, tasks, an empty folder', { hasTasks: true, folderEmpty: true }, 'claim'],
    ['no marker, tasks, a stranger\'s folder', { hasTasks: true }, 'unclaimed'],
  ])('%s', (_label, facts, expected) => {
    expect(decideOwnership({ ...BASE, ...facts })).toBe(expected);
  });
});
