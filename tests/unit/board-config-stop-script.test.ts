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

const { lanes, atomicWrite } = vi.hoisted(() => ({
  lanes: [] as unknown[],
  // Wraps the real `atomicWriteJson`, so a test can make one write fail.
  atomicWrite: { spy: vi.fn(), real: null as null | ((...args: unknown[]) => string | null) },
}));

vi.mock('../../src/main/config/board-config/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/board-config/atomic-write')>();
  atomicWrite.real = actual.atomicWriteJson as unknown as (...args: unknown[]) => string | null;
  return { ...actual, atomicWriteJson: (...args: unknown[]) => atomicWrite.spy(...args) };
});
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
  isWritingBack: boolean;
  lastTeamContentHash: string | null;
  lastLocalContentHash: string | null;
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

function readLocal(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectPath, LOCAL_FILE), 'utf8')) as Record<string, unknown>;
}

/** The file's bytes, or null when there is none, to prove a file was left alone. */
function bytesOf(folder: string, fileName: string): string | null {
  const filePath = path.join(folder, fileName);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

beforeEach(() => {
  atomicWrite.spy.mockReset();
  atomicWrite.spy.mockImplementation((...args: unknown[]) => atomicWrite.real!(...args));
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
  it('reads a local script with no kangentic.json, and a save reaches it', () => {
    writeLocal({ stopScript: 'npm run stop:mine' });
    expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop:mine');

    manager.setStopScript(projectPath, 'npm run stop:other');
    expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop:other');
  });

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

    manager.setStopScript(projectPath, '  npm run stop  ');

    expect(readTeam()).toMatchObject({ stopScript: 'npm run stop', defaultBaseBranch: 'develop' });
    expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop');
  });

  it('removes the key for a cleared field', () => {
    writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });

    manager.setStopScript(projectPath, null);
    expect(readTeam()).not.toHaveProperty('stopScript');

    writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
    manager.setStopScript(projectPath, '   ');
    expect(readTeam()).not.toHaveProperty('stopScript');
  });

  it('refuses to write over a file it cannot read', () => {
    const conflicted = '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":2}\n>>>>>>> theirs\n';
    fs.writeFileSync(path.join(projectPath, TEAM_FILE), conflicted);

    expect(() => manager.setStopScript(projectPath, 'npm run stop')).toThrow();
    expect(fs.readFileSync(path.join(projectPath, TEAM_FILE), 'utf8')).toBe(conflicted);
  });

  describe('where setStopScript writes', () => {
    it('writes kangentic.local.json when that holds the key, and leaves kangentic.json alone', () => {
      writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
      writeLocal({ stopScript: 'npm run stop:mine' });
      const teamBefore = bytesOf(projectPath, TEAM_FILE);

      manager.setStopScript(projectPath, '  npm run stop:other  ');

      expect(readLocal()).toMatchObject({ stopScript: 'npm run stop:other' });
      expect(bytesOf(projectPath, TEAM_FILE)).toBe(teamBefore);
      // What was saved is what the effective read gives back, not the team's value.
      expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop:other');
    });

    it('leaves an empty value in the local file for a blank one, so the team\'s script stays off here', () => {
      writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
      writeLocal({ stopScript: 'npm run stop:mine' });
      const teamBefore = bytesOf(projectPath, TEAM_FILE);

      manager.setStopScript(projectPath, '   ');

      expect(readLocal()).toHaveProperty('stopScript', '');
      expect(bytesOf(projectPath, TEAM_FILE)).toBe(teamBefore);
      expect(manager.getStopScriptForPath(projectPath)).toBeNull();

      manager.setStopScript(projectPath, null);
      expect(readLocal()).toHaveProperty('stopScript', '');
      expect(manager.getStopScriptForPath(projectPath)).toBeNull();
    });

    it('writes kangentic.json as before when the local file exists without the key', () => {
      writeTeam({ version: 1, columns: [] });
      writeLocal({ defaultBaseBranch: 'develop' });
      const localBefore = bytesOf(projectPath, LOCAL_FILE);

      manager.setStopScript(projectPath, 'npm run stop');

      expect(readTeam()).toMatchObject({ stopScript: 'npm run stop' });
      expect(bytesOf(projectPath, LOCAL_FILE)).toBe(localBefore);
    });

    it('writes a project that is not the active one, and touches nothing of the active one', () => {
      const otherPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-stop-script-other-'));
      try {
        writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
        fs.writeFileSync(path.join(otherPath, TEAM_FILE), JSON.stringify({ version: 1, columns: [] }));
        const internals = manager as unknown as ManagerInternals;
        const activeTeamBefore = bytesOf(projectPath, TEAM_FILE);
        const hashesBefore = [internals.lastTeamContentHash, internals.lastLocalContentHash];

        manager.setStopScript(otherPath, 'make stop');

        expect(JSON.parse(fs.readFileSync(path.join(otherPath, TEAM_FILE), 'utf8'))).toMatchObject({ stopScript: 'make stop' });
        expect(manager.getStopScriptForPath(otherPath)).toBe('make stop');
        expect(bytesOf(projectPath, TEAM_FILE)).toBe(activeTeamBefore);
        expect(bytesOf(projectPath, LOCAL_FILE)).toBeNull();
        expect(manager.getStopScriptForPath(projectPath)).toBe('npm run stop');
        // The active project's watcher bookkeeping is for its files, not another project's.
        expect(internals.isWritingBack).toBe(false);
        expect([internals.lastTeamContentHash, internals.lastLocalContentHash]).toEqual(hashesBefore);
      } finally {
        fs.rmSync(otherPath, { recursive: true, force: true });
      }
    });

    it('throws a failed write out of setStopScript, and warns, rather than swallowing it', () => {
      writeTeam({ version: 1, columns: [] });
      atomicWrite.spy.mockImplementationOnce(() => { throw new Error('disk full'); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => manager.setStopScript(projectPath, 'npm run stop')).toThrow('disk full');

      expect(atomicWrite.spy).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      expect(manager.getStopScriptForPath(projectPath)).toBeNull();
      warn.mockRestore();
    });

    it('refuses to write when kangentic.local.json cannot be read, and changes neither file', () => {
      const conflicted = '<<<<<<< HEAD\n{"stopScript":"a"}\n=======\n{"stopScript":"b"}\n>>>>>>> theirs\n';
      writeTeam({ version: 1, columns: [], stopScript: 'npm run stop' });
      fs.writeFileSync(path.join(projectPath, LOCAL_FILE), conflicted);
      const teamBefore = bytesOf(projectPath, TEAM_FILE);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => manager.setStopScript(projectPath, 'npm run stop:other')).toThrow();

      expect(bytesOf(projectPath, LOCAL_FILE)).toBe(conflicted);
      expect(bytesOf(projectPath, TEAM_FILE)).toBe(teamBefore);
      expect(atomicWrite.spy).not.toHaveBeenCalled();
      warn.mockRestore();
    });
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
