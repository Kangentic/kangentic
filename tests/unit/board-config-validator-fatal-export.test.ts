/**
 * The open-time export over a kangentic.json the validator rejects.
 *
 * Project open runs `applyConfigOnOpen` and then `exportFromDb`. A file that is
 * valid JSON but the wrong shape (`"actions": {}`, `"columns": {}`) used to throw
 * out of the apply, and the catch in the open path skipped the export, so the
 * file survived. Once the validator reported those shapes as a warning instead,
 * the export ran and rewrote the file from the database: the hand edit was gone
 * while the banner said the board loaded from the local database.
 *
 * better-sqlite3 cannot load under vitest, so the DB modules the import graph
 * pulls in are mocked (same pattern as board-config-malformed-lists.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list() { return []; } },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { list() { return []; } listTransitions() { return []; } },
}));
vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class { listAll() { return []; } listForColumn() { return []; } },
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { TEAM_FILE } from '../../src/main/config/board-config/config-helpers';

interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
}

describe('open-time export over a kangentic.json the validator rejects', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-validator-fatal-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function attachedManager(): BoardConfigManager {
    const manager = new BoardConfigManager({ ephemeral: false });
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = 'project-1';
    internals.activeProjectPath = tempDir;
    return manager;
  }

  const teamPath = () => path.join(tempDir, TEAM_FILE);

  it.each([
    ['actions is an object', { version: 1, columns: [{ name: 'To Do', role: 'todo' }], actions: {} }],
    ['columns is an object', { version: 1, columns: { planning: { name: 'Planning' } } }],
    ['a column is null', { version: 1, columns: [null, { name: 'To Do', role: 'todo' }] }],
  ])('leaves the file as it is when %s', (_label, team) => {
    const original = JSON.stringify(team, null, 2);
    fs.writeFileSync(teamPath(), original);
    const manager = attachedManager();

    const warnings = manager.applyConfigOnOpen();
    manager.exportFromDb();

    expect(warnings).toHaveLength(1);
    expect(fs.readFileSync(teamPath(), 'utf-8')).toBe(original);
  });
});
