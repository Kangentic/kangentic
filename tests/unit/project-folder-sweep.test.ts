/**
 * The orphan sweep on a real folder and a real database. The incident's numbers
 * came from `pruneOrphanedDirectories` deleting everything no row named, so these
 * tests run it with nothing mocked between the sweep and the disk: an instance
 * that does not own a folder gets no proof, and what an owner clears can still be
 * put back.
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
import { pruneOrphanedDirectories } from '../../src/main/transition-engine/resource-cleanup';
import { verifyProjectOwnership, type VerifiedOwnership } from '../../src/main/project-ownership/project-ownership';
import {
  SET_ASIDE_RETENTION_MS,
  moveIntoSetAside,
  purgeExpiredSetAside,
} from '../../src/main/project-ownership/set-aside';
import { asideTimeOf } from '../../src/main/git/removed-worktrees';
import { openTestDatabase } from './helpers/test-database';
import { ownershipOf } from './helpers/verified-ownership';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const sessionManager = { listSessions: () => [] };

let workspace: string;
let projectPath: string;
let kangentic: string;
let database: Database.Database;
let tasks: TaskRepository;
let sessions: SessionRepository;
let swimlaneId: string;

/** A folder past the sweep's grace, holding a file, as an old entry would. */
function oldFolder(relative: string, fileName = 'note.txt'): string {
  const folder = path.join(kangentic, relative);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, fileName), 'real data');
  const past = new Date(Date.now() - ONE_DAY_MS);
  fs.utimesSync(folder, past, past);
  return folder;
}

function setAsideNames(kind: string): string[] {
  const root = path.join(kangentic, 'set-aside', kind);
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

function sweep(ownership: VerifiedOwnership): Promise<void> {
  return pruneOrphanedDirectories(ownership, tasks, sessions, sessionManager as never);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-sweep-'));
  projectPath = path.join(workspace, 'project');
  kangentic = path.join(projectPath, '.kangentic');
  fs.mkdirSync(kangentic, { recursive: true });
  database = openTestDatabase(path.join(workspace, 'project.db'));
  runProjectMigrations(database);
  tasks = new TaskRepository(database);
  sessions = new SessionRepository(database);
  swimlaneId = new SwimlaneRepository(database).list()[0].id;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  database.close();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the incident: a fresh database beside a populated .kangentic', () => {
  it('earns no proof, so no sweep can run and every folder stays', async () => {
    const entries = [
      oldFolder('worktrees/1003'),
      oldFolder('sessions/00779af3-9d51-4581-9ad8-927167febc51'),
      oldFolder('tasks/bc8be4d3-485d-475b-9bb4-d04810711229', 'attachment.png'),
    ];

    const standing = await verifyProjectOwnership(projectPath, path.join(workspace, 'project.db'), database, tasks, sessions);

    expect(standing.kind).not.toBe('owned');
    for (const entry of entries) expect(fs.existsSync(entry)).toBe(true);
  });
});

describe('an owner\'s sweep', () => {
  it('moves worktrees and task folders aside whole, attachments and uncommitted files included', async () => {
    const task = tasks.create({ title: 'Kept', description: '', swimlane_id: swimlaneId });
    oldFolder(path.join('tasks', task.id));
    const orphanTask = oldFolder('tasks/orphan-task', 'attachment.png');
    const orphanWorktree = oldFolder('worktrees/old', 'uncommitted.ts');

    await sweep(ownershipOf(projectPath));

    expect(fs.existsSync(orphanTask)).toBe(false);
    expect(fs.existsSync(orphanWorktree)).toBe(false);
    const [taskEntry] = setAsideNames('tasks');
    const [worktreeEntry] = setAsideNames('worktrees');
    expect(fs.readFileSync(path.join(kangentic, 'set-aside', 'tasks', taskEntry, 'attachment.png'), 'utf-8')).toBe('real data');
    expect(fs.readFileSync(path.join(kangentic, 'set-aside', 'worktrees', worktreeEntry, 'uncommitted.ts'), 'utf-8')).toBe('real data');
  });

  it('deletes an orphaned session folder, which holds nothing a person cannot rebuild', async () => {
    const orphan = oldFolder('sessions/dead-session');

    await sweep(ownershipOf(projectPath));

    expect(fs.existsSync(orphan)).toBe(false);
    expect(setAsideNames('sessions')).toEqual([]);
  });

  it('leaves a populated folder alone when its database names almost none of it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const task = tasks.create({ title: 'One row', description: '', swimlane_id: swimlaneId });
    oldFolder(path.join('tasks', task.id));
    const orphans = ['a', 'b', 'c', 'd', 'e'].map((name) => oldFolder(`tasks/${name}`));

    await sweep(ownershipOf(projectPath));

    for (const orphan of orphans) expect(fs.existsSync(orphan)).toBe(true);
    expect(setAsideNames('tasks')).toEqual([]);
  });
});

describe('moveIntoSetAside', () => {
  it('keeps the folder and reports null when the move fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = path.join(kangentic, 'tasks', 'already-gone');

    expect(await moveIntoSetAside(projectPath, 'tasks', missing)).toBeNull();
  });

  it('gives each move its own name, with its time in it', async () => {
    const before = Date.now();
    const first = await moveIntoSetAside(projectPath, 'tasks', oldFolder('tasks/same-name'));
    const second = await moveIntoSetAside(projectPath, 'tasks', oldFolder('tasks/same-name'));

    expect(first).not.toBe(second);
    expect(asideTimeOf(path.basename(first as string))).toBeGreaterThanOrEqual(before);
  });
});

describe('purgeExpiredSetAside', () => {
  it('deletes what has been set aside past its retention and keeps the rest', async () => {
    const moved = await moveIntoSetAside(projectPath, 'tasks', oldFolder('tasks/older'));
    const movedAt = asideTimeOf(path.basename(moved as string)) as number;

    expect(await purgeExpiredSetAside(ownershipOf(projectPath), movedAt + SET_ASIDE_RETENTION_MS - 1)).toBe(0);
    expect(fs.existsSync(moved as string)).toBe(true);

    expect(await purgeExpiredSetAside(ownershipOf(projectPath), movedAt + SET_ASIDE_RETENTION_MS)).toBe(1);
    expect(fs.existsSync(moved as string)).toBe(false);
  });

  it('keeps a name it did not write', async () => {
    const handMade = path.join(kangentic, 'set-aside', 'tasks', 'restore-me');
    fs.mkdirSync(handMade, { recursive: true });

    await purgeExpiredSetAside(ownershipOf(projectPath), Date.now() + 10 * SET_ASIDE_RETENTION_MS);

    expect(fs.existsSync(handMade)).toBe(true);
  });

  it('keeps a name that fits the pattern but whose "time" is a word, however late it is', async () => {
    // "notes" reads as a base-36 number far before 2026, so it was never a move time.
    const handMade = path.join(kangentic, 'set-aside', 'tasks', 'draft-notes-abcdef');
    fs.mkdirSync(handMade, { recursive: true });

    expect(asideTimeOf('draft-notes-abcdef')).toBeNull();
    await purgeExpiredSetAside(ownershipOf(projectPath), Date.now() + 1000 * SET_ASIDE_RETENTION_MS);

    expect(fs.existsSync(handMade)).toBe(true);
  });

  it('is a no-op with nothing set aside', async () => {
    await expect(purgeExpiredSetAside(ownershipOf(projectPath))).resolves.toBe(0);
  });
});
