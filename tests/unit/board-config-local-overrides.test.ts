/**
 * kangentic.local.json is personal: what it sets changes this machine's board
 * and never reaches the committed kangentic.json (GitHub #806).
 *
 * Before the fix, the write-back rebuilt kangentic.json from the database,
 * which holds the MERGED board, so one project open (apply, then export) wrote
 * every local override and local-only column into the team file. These tests
 * drive the real BoardConfigManager over a real in-memory SQLite database and
 * real files in a temp project folder:
 *   - the leak: an override and a local-only column stay out of kangentic.json;
 *   - edit routing: an edit to a locally set field lands in the local file,
 *     any other in the team file, including automations and a pointer at a
 *     local-only column;
 *   - a delete drops the column's local entry;
 *   - a key removed from the local file resets the field, so the old personal
 *     value does not leak on the next write-back;
 *   - a local file change applies at once, with no reconciliation banner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const hoisted = vi.hoisted(() => ({
  currentDb: null as unknown,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => hoisted.currentDb,
}));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { LOCAL_FILE, TEAM_FILE } from '../../src/main/config/board-config/config-helpers';
import { IPC } from '../../src/shared/ipc-channels';
import type { BoardColumnConfig, BoardConfig } from '../../src/shared/types';

const PROJECT_ID = 'project-local-overrides';

type SendMock = (channel: string, ...args: unknown[]) => void;

/** The private state the file-change path reads; set directly via a typed cast. */
interface ManagerInternals {
  activeProjectId: string | null;
  activeProjectPath: string | null;
  mainWindow: { isDestroyed(): boolean; webContents: { send: SendMock } } | null;
  isWritingBack: boolean;
  lastLocalContentHash: string | null;
  onFileChanged(projectId: string, source: 'team' | 'local'): void;
}

function teamFile(): BoardConfig {
  return {
    version: 1,
    columns: [
      { id: 'lane-todo', name: 'To Do', role: 'todo' },
      {
        id: 'lane-build',
        name: 'Build',
        description: 'Builds things',
        autoSpawn: true,
        automations: { onEnter: [{ name: 'Team message', type: 'send_message', message: '/build' }] },
      },
      { id: 'lane-done', name: 'Done', role: 'done' },
    ],
    actions: [],
    transitions: [],
  };
}

describe('kangentic.local.json stays out of kangentic.json (real SQLite)', () => {
  let db: Database.Database;
  let swimlanes: SwimlaneRepository;
  let automations: AutomationRepository;
  let projectDir: string;
  let manager: BoardConfigManager;

  beforeEach(() => {
    db = new Database(':memory:');
    runProjectMigrations(db);
    hoisted.currentDb = db;
    swimlanes = new SwimlaneRepository(db);
    automations = new AutomationRepository(db);
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-local-overrides-'));
    manager = new BoardConfigManager({ ephemeral: false });
  });

  afterEach(() => {
    manager.detach();
    db?.close();
    hoisted.currentDb = null;
    // Retried: on Windows a just-closed watcher or a rename can hold a handle briefly.
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const teamPath = () => path.join(projectDir, TEAM_FILE);
  const localPath = () => path.join(projectDir, LOCAL_FILE);
  const writeJson = (filePath: string, value: unknown) => fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  const readJson = <Shape>(filePath: string): Shape => JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Shape;
  const teamColumn = (id: string): BoardColumnConfig | undefined =>
    readJson<BoardConfig>(teamPath()).columns.find((column) => column.id === id);
  const localColumns = (): BoardColumnConfig[] => readJson<Partial<BoardConfig>>(localPath()).columns ?? [];
  const localColumn = (id: string): BoardColumnConfig | undefined => localColumns().find((column) => column.id === id);

  /** Apply then export, as a project open does. */
  function openProject(): void {
    manager.applyConfig(PROJECT_ID, projectDir);
    manager.writeBackForProject(PROJECT_ID, projectDir);
  }

  /** The team file as the app writes it with no local file, to compare against. */
  function canonicalTeamFile(): string {
    writeJson(teamPath(), teamFile());
    openProject();
    return fs.readFileSync(teamPath(), 'utf-8');
  }

  it('keeps a local override and a local-only column out of kangentic.json on open', () => {
    const canonical = canonicalTeamFile();
    const localFile = {
      columns: [
        { id: 'lane-build', description: 'local only', agentOverride: 'codex' },
        { id: 'lane-mine', name: 'Mine' },
        { name: 'Scratch' },
      ],
    };
    writeJson(localPath(), localFile);

    openProject();

    // The board runs the merged config.
    const build = swimlanes.getById('lane-build')!;
    expect(build.description).toBe('local only');
    expect(build.agent_override).toBe('codex');
    expect(swimlanes.list().map((lane) => lane.name)).toEqual(['To Do', 'Build', 'Mine', 'Scratch', 'Done']);

    // The team file is exactly what it was without a local file.
    expect(fs.readFileSync(teamPath(), 'utf-8')).toBe(canonical);

    // The local file is untouched, except the id a local-only column without
    // one was given, so the next open matches it instead of creating another.
    const scratchLane = swimlanes.list().find((lane) => lane.name === 'Scratch')!;
    expect(localColumns()).toEqual([
      { id: 'lane-build', description: 'local only', agentOverride: 'codex' },
      { id: 'lane-mine', name: 'Mine' },
      { name: 'Scratch', id: scratchLane.id },
    ]);

    // A second open changes neither file and adds no second Scratch.
    const localAfterFirst = fs.readFileSync(localPath(), 'utf-8');
    openProject();
    expect(fs.readFileSync(teamPath(), 'utf-8')).toBe(canonical);
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(localAfterFirst);
    expect(swimlanes.list().filter((lane) => lane.name === 'Scratch')).toHaveLength(1);
  });

  it('saves an edit to a locally set field in kangentic.local.json, and any other field in kangentic.json', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', description: 'local only', agentOverride: 'codex' }] });
    openProject();

    // What the Column Manager's save and kangentic_update_column both do: write the row, then write back.
    swimlanes.update({ id: 'lane-build', description: 'edited here', color: '#ff0000', agent_override: null });
    manager.writeBackForProject(PROJECT_ID, projectDir);

    const team = teamColumn('lane-build')!;
    expect(team.description).toBe('Builds things');
    expect(team.agentOverride).toBeUndefined();
    expect(team.color).toBe('#ff0000');

    // A cleared field is written explicitly, or the merge would fall through to the team value.
    expect(localColumn('lane-build')).toEqual({ id: 'lane-build', description: 'edited here', agentOverride: null });

    // And the edit survives the next open instead of being undone.
    openProject();
    expect(swimlanes.getById('lane-build')!.description).toBe('edited here');
    expect(swimlanes.getById('lane-build')!.agent_override).toBeNull();
  });

  it('leaves a local file with every automation type byte-identical across opens', () => {
    // The shape the /preview seed writes (src/devtools/main/ephemeral-projects.ts):
    // disabled rows of each type, with their own fields, a condition, a text
    // match, a frequency and a move target. If the serializer adds or drops a
    // key on any of them, every such local file is rewritten on the first open.
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), {
      version: 1,
      columns: [
        {
          id: 'lane-build',
          modelOverride: 'haiku',
          effortOverride: 'low',
          permissionMode: 'acceptEdits',
          automations: {
            onEnter: [
              { name: 'Tell the agent', type: 'send_message', enabled: false, message: 'Pick up {{title}} and start on {{branchName}}.', mode: 'immediate' },
              { name: 'Install dependencies', type: 'run_script', enabled: false, script: 'npm ci', timeoutMinutes: 5 },
              { name: 'Notify me', type: 'notify', enabled: false, title: '{{title}}', body: 'moved to {{toColumn}}' },
            ],
            onTurnEnd: [
              { name: 'Back to planning', type: 'move_to_column', enabled: false, condition: 'The plan needs revising', maxRuns: 2, targetColumn: 'To Do', message: '{{agentReply}}' },
              { name: 'On to review', type: 'move_to_column', enabled: false, finalLine: 'Ready for review', maxRuns: 1 },
            ],
            onExit: [
              { name: 'Ping the channel', type: 'webhook', enabled: false, url: 'https://hooks.example.com/kangentic', method: 'POST', body: '{"task":"{{taskNumber}}"}' },
            ],
          },
        },
        { id: 'lane-todo', modelOverride: 'haiku', effortOverride: 'low' },
      ],
    });
    const localBefore = fs.readFileSync(localPath(), 'utf-8');

    openProject();
    expect(automations.listForColumn('lane-build')).toHaveLength(6);
    const teamAfterFirst = fs.readFileSync(teamPath(), 'utf-8');
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(localBefore);
    expect(teamColumn('lane-build')!.automations).toEqual(teamFile().columns[1].automations);
    expect(teamColumn('lane-build')!.modelOverride).toBeUndefined();

    openProject();
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(localBefore);
    expect(fs.readFileSync(teamPath(), 'utf-8')).toBe(teamAfterFirst);
  });

  it('saves an automation edit to the local file when the local column declares automations', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), {
      columns: [{ id: 'lane-build', automations: { onEnter: [{ name: 'Local message', type: 'send_message', message: '/mine' }] } }],
    });
    openProject();
    expect(automations.listForColumn('lane-build').map((row) => row.name)).toEqual(['Local message']);

    automations.replaceForColumn('lane-build', [
      { name: 'Edited message', type: 'send_message', trigger: 'enter', enabled: true, config: { message: '/edited' }, final_line: null },
    ]);
    manager.writeBackForProject(PROJECT_ID, projectDir);

    expect(teamColumn('lane-build')!.automations).toEqual(teamFile().columns[1].automations);
    expect(localColumn('lane-build')!.automations?.onEnter?.map((row) => row.name)).toEqual(['Edited message']);
  });

  it('keeps the team value for a pointer at a local-only column and saves the pointer locally', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-mine', name: 'Mine' }] });
    openProject();

    swimlanes.update({ id: 'lane-build', plan_exit_target_id: 'lane-mine' });
    manager.writeBackForProject(PROJECT_ID, projectDir);

    expect(teamColumn('lane-build')!.planExitTarget).toBeUndefined();
    expect(teamColumn('lane-mine')).toBeUndefined();
    expect(localColumn('lane-build')).toEqual({ id: 'lane-build', planExitTarget: 'Mine' });

    openProject();
    expect(swimlanes.getById('lane-build')!.plan_exit_target_id).toBe('lane-mine');
  });

  it('drops a deleted column from the local file and leaves the team file alone', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-mine', name: 'Mine' }], shortcuts: [] });
    openProject();
    const teamBefore = fs.readFileSync(teamPath(), 'utf-8');

    swimlanes.delete('lane-mine');
    manager.removeLocalColumn(PROJECT_ID, projectDir, 'lane-mine');
    manager.writeBackForProject(PROJECT_ID, projectDir);

    expect(readJson<Partial<BoardConfig>>(localPath())).toEqual({ columns: [], shortcuts: [] });
    expect(fs.readFileSync(teamPath(), 'utf-8')).toBe(teamBefore);
    openProject();
    expect(swimlanes.getById('lane-mine')).toBeUndefined();
  });

  it('resets a field whose key was removed from the local file, so it does not leak on the next write-back', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', agentOverride: 'codex', description: 'local only' }] });
    openProject();
    expect(swimlanes.getById('lane-build')!.agent_override).toBe('codex');

    // The team file sets a description, so the merge brings it back on its
    // own; it sets no agentOverride, so that one needs the reset.
    writeJson(localPath(), { columns: [] });
    openProject();
    expect(swimlanes.getById('lane-build')!.agent_override).toBeNull();
    expect(swimlanes.getById('lane-build')!.description).toBe('Builds things');
    expect(teamColumn('lane-build')!.agentOverride).toBeUndefined();
  });

  it('resets the fields a deleted local file set', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', modelOverride: 'opus' }] });
    openProject();
    expect(swimlanes.getById('lane-build')!.model_override).toBe('opus');

    fs.rmSync(localPath(), { force: true });
    openProject();
    expect(swimlanes.getById('lane-build')!.model_override).toBeNull();
    expect(teamColumn('lane-build')!.modelOverride).toBeUndefined();
  });

  describe('a kangentic.local.json change while the project is open', () => {
    function attachInternals(): { internals: ManagerInternals; send: ReturnType<typeof vi.fn> } {
      const send = vi.fn();
      const internals = manager as unknown as ManagerInternals;
      internals.activeProjectId = PROJECT_ID;
      internals.activeProjectPath = projectDir;
      internals.mainWindow = { isDestroyed: () => false, webContents: { send } };
      return { internals, send };
    }

    it('applies at once and asks the renderer to reload, never raising the banner', () => {
      writeJson(teamPath(), teamFile());
      const { internals, send } = attachInternals();
      openProject();

      internals.isWritingBack = false;
      writeJson(localPath(), { columns: [{ id: 'lane-build', description: 'from my editor' }] });
      internals.onFileChanged(PROJECT_ID, 'local');

      expect(swimlanes.getById('lane-build')!.description).toBe('from my editor');
      expect(send).toHaveBeenCalledWith(IPC.BOARD_CONFIG_LOCAL_APPLIED, PROJECT_ID);
      expect(send).not.toHaveBeenCalledWith(IPC.BOARD_CONFIG_CHANGED, PROJECT_ID);
    });

    it("ignores the echo of the app's own local write", () => {
      writeJson(teamPath(), teamFile());
      writeJson(localPath(), { columns: [{ id: 'lane-build', description: 'local only' }] });
      const { internals, send } = attachInternals();
      openProject();

      swimlanes.update({ id: 'lane-build', description: 'edited here' });
      manager.writeBackForProject(PROJECT_ID, projectDir);
      expect(localColumn('lane-build')!.description).toBe('edited here');

      // Past the write-back's suppression window, only the content hash is left.
      internals.isWritingBack = false;
      internals.onFileChanged(PROJECT_ID, 'local');
      expect(send).not.toHaveBeenCalledWith(IPC.BOARD_CONFIG_LOCAL_APPLIED, PROJECT_ID);
    });
  });
});
