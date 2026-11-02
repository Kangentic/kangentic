/**
 * The project's Stop script in `kangentic.json` (BoardConfigManager's
 * getStopScriptForPath and setStopScript), over real files in a temp project.
 * A pause reads it by path because it can be in a project that is not the active
 * one, and `kangentic.local.json` overrides it per machine.
 *
 * buildBoardConfigFromDb rebuilds the file wholesale, so the key must be carried
 * across it, or the first column edit deletes the team's script.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { lanes } = vi.hoisted(() => ({ lanes: [] as unknown[] }));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list = () => lanes; },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class { listAll = () => []; },
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { buildBoardConfigFromDb } from '../../src/main/config/board-config/build-config';
import { LOCAL_FILE, TEAM_FILE } from '../../src/main/config/board-config/config-helpers';
import type { BoardConfig } from '../../src/shared/types';

interface ManagerInternals {
  activeProjectPath: string | null;
}

let projectPath: string;
let manager: BoardConfigManager;

function writeTeam(content: object): void {
  fs.writeFileSync(path.join(projectPath, TEAM_FILE), JSON.stringify(content));
}

function writeLocal(content: object): void {
  fs.writeFileSync(path.join(projectPath, LOCAL_FILE), JSON.stringify(content));
}

function readTeam(): BoardConfig {
  return JSON.parse(fs.readFileSync(path.join(projectPath, TEAM_FILE), 'utf8')) as BoardConfig;
}

beforeEach(() => {
  vi.useFakeTimers();
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-stop-script-config-'));
  manager = new BoardConfigManager({ ephemeral: false });
  (manager as unknown as ManagerInternals).activeProjectPath = projectPath;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

describe('BoardConfigManager and the Stop script', () => {
  it('reads none with no file, and with no key', () => {
    expect(manager.getStopScriptForPath(projectPath)).toBeNull();

    writeTeam({ version: 1, columns: [] });
    expect(manager.getStopScriptForPath(projectPath)).toBeNull();
  });

  it('reads the team\'s script', () => {
    writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });

    expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop');
  });

  it('lets the local file override it, and an empty local value turn it off', () => {
    writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
    // A path that is not the active project's reads the files every time, as a
    // pause in a background project does.
    (manager as unknown as ManagerInternals).activeProjectPath = null;

    writeLocal({ stopScript: 'npm run stop:mine' });
    expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop:mine');

    writeLocal({ stopScript: '' });
    expect(manager.getStopScriptForPath(projectPath)).toBeNull();
  });

  it('reads a value that is not a string, or only blanks, as none', () => {
    writeTeam({ version: 1, columns: [], stopScript: 7 });
    expect(manager.getStopScriptForPath(projectPath)).toBeNull();

    writeTeam({ version: 1, columns: [], stopScript: '   ' });
    expect(manager.getStopScriptForPath(projectPath)).toBeNull();
  });

  it('writes it to kangentic.json, trimmed, beside what the file already holds', () => {
    writeTeam({ version: 1, columns: [], defaultBaseBranch: 'develop' });

    manager.setStopScript('  npm run stop  ');

    expect(readTeam()).toMatchObject({ stopScript: 'npm run stop', defaultBaseBranch: 'develop' });
    expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop');
  });

  it('removes the key for a cleared field', () => {
    writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });

    manager.setStopScript(null);
    expect(readTeam()).not.toHaveProperty('stopScript');

    writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
    manager.setStopScript('   ');
    expect(readTeam()).not.toHaveProperty('stopScript');
  });

  it('refuses to write over a file it cannot read', () => {
    const conflicted = '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":2}\n>>>>>>> theirs\n';
    fs.writeFileSync(path.join(projectPath, TEAM_FILE), conflicted);

    expect(() => manager.setStopScript('npm run stop')).toThrow();
    expect(fs.readFileSync(path.join(projectPath, TEAM_FILE), 'utf8')).toBe(conflicted);
  });

  it('survives a column edit rebuilding the file from the database', () => {
    const rebuilt = buildBoardConfigFromDb({
      projectId: 'proj-1',
      existingTeamConfig: { version: 1, columns: [], stopScript: 'npm run stop' },
      fingerprint: 'fingerprint',
    });

    expect(rebuilt.stopScript).toBe('npm run stop');
  });
});
