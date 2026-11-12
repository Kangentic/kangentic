/**
 * Edge cases of the kangentic.local.json split (GitHub #806), beside the main
 * cases in board-config-local-overrides.test.ts. Same harness: the real
 * BoardConfigManager over a real in-memory SQLite database and real files in a
 * temp project folder. This file pins:
 *   - an unreadable local file blocks the write-back, so nothing personal leaks;
 *   - a removed local key resets the field (automations, a legacy message, a
 *     plan exit target, a team value, a non-null default);
 *   - an explicit null clears, and stays in the local file;
 *   - a local name override keeps the team file's name for a pointer;
 *   - a Move to column row pointing at a local-only column moves to the local file;
 *   - the apply snapshot only advances on an apply that ran;
 *   - junk entries and unknown keys in the local file are kept;
 *   - an orphaned nameless override does not break the apply;
 *   - removeLocalColumn writes nothing it should not;
 *   - a hand edit inside the write-back suppression window is still applied.
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
import type { AutomationWriteInput, BoardColumnConfig, BoardConfig, ColumnAutomation } from '../../src/shared/types';

const PROJECT_ID = 'project-local-overrides-edges';

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

/** A team file where no column declares an automation, so only a reset can empty a list. */
function teamFileWithoutAutomations(): BoardConfig {
  const team = teamFile();
  delete team.columns[1].automations;
  return team;
}

function toWriteInput(automation: ColumnAutomation): AutomationWriteInput {
  return {
    name: automation.name,
    type: automation.type,
    trigger: automation.trigger,
    enabled: automation.enabled,
    config: automation.config,
    condition: automation.condition,
    final_line: automation.final_line,
    max_runs: automation.max_runs,
  };
}

describe('kangentic.local.json edge cases (real SQLite)', () => {
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
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-local-edges-'));
    manager = new BoardConfigManager({ ephemeral: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
  const readBytes = (filePath: string) => fs.readFileSync(filePath, 'utf-8');
  const teamColumn = (id: string): BoardColumnConfig | undefined =>
    readJson<BoardConfig>(teamPath()).columns.find((column) => column.id === id);
  const localColumns = (): unknown[] => readJson<{ columns?: unknown[] }>(localPath()).columns ?? [];
  const localColumn = (id: string): BoardColumnConfig | undefined =>
    (localColumns() as BoardColumnConfig[]).find((column) => column !== null && column.id === id);
  const automationNames = (laneId: string) => automations.listForColumn(laneId).map((row) => row.name);

  /** Apply then export, as a project open does. */
  function openProject(): void {
    manager.applyConfig(PROJECT_ID, projectDir);
    manager.writeBackForProject(PROJECT_ID, projectDir);
  }

  it('blocks the write-back while the local file is unreadable, so no override reaches kangentic.json', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', agentOverride: 'codex' }] });
    openProject();
    expect(swimlanes.getById('lane-build')!.agent_override).toBe('codex');
    const teamBefore = readBytes(teamPath());

    fs.writeFileSync(localPath(), '{ not json');
    manager.writeBackForProject(PROJECT_ID, projectDir);

    // Red trigger: drop LOCAL_FILE from the readProblem loop in doWriteBack and
    // the merged board (agentOverride included) is written to the team file.
    expect(readBytes(teamPath())).toBe(teamBefore);
    expect(teamColumn('lane-build')!.agentOverride).toBeUndefined();
    expect(readBytes(localPath())).toBe('{ not json');
  });

  describe('a key removed from the local file resets its field', () => {
    const variants = [
      { label: 'the team sets automations', team: teamFile, teamRows: ['Team message'] },
      { label: 'no team column sets automations', team: teamFileWithoutAutomations, teamRows: [] as string[] },
    ];
    const ownKeys = [
      { label: 'automations', winsOverTeamRows: true, entry: { automations: { onEnter: [{ name: 'Local message', type: 'send_message', message: '/mine' }] } } },
      // A legacy message loses to a merged `automations` list, so over the team's rows it changes nothing.
      { label: 'a legacy autoCommand', winsOverTeamRows: false, entry: { autoCommand: '/mine' } },
    ];

    for (const variant of variants) {
      for (const ownKey of ownKeys) {
        it(`restores the team's rows when a local entry's ${ownKey.label} is removed (${variant.label})`, () => {
          writeJson(teamPath(), variant.team());
          writeJson(localPath(), { columns: [{ id: 'lane-build', ...ownKey.entry }] });
          openProject();
          if (ownKey.winsOverTeamRows || variant.teamRows.length === 0) {
            expect(automationNames('lane-build')).not.toEqual(variant.teamRows);
          }
          const teamBefore = readBytes(teamPath());

          writeJson(localPath(), { columns: [{ id: 'lane-build' }] });
          openProject();

          // Red trigger (no team rows only): drop `|| config.columns.some(automationsReset)`
          // in apply-config.ts and the personal rows stay on the lane.
          expect(automationNames('lane-build')).toEqual(variant.teamRows);
          expect(readBytes(teamPath())).toBe(teamBefore);
          expect(teamColumn('lane-build')!.automations).toEqual(variant.team().columns[1].automations);
        });
      }
    }

    it('clears a plan exit target the team does not set', () => {
      writeJson(teamPath(), teamFile());
      writeJson(localPath(), { columns: [{ id: 'lane-build', planExitTarget: 'Done' }] });
      openProject();
      expect(swimlanes.getById('lane-build')!.plan_exit_target_id).toBe('lane-done');

      writeJson(localPath(), { columns: [{ id: 'lane-build' }] });
      openProject();

      // Red trigger: drop the `resetFields.get(...)?.has('planExitTarget')` branch in apply-config.ts.
      expect(swimlanes.getById('lane-build')!.plan_exit_target_id).toBeNull();
      expect(teamColumn('lane-build')!.planExitTarget).toBeUndefined();
    });

    it("brings back the team's value, not the default, when the team sets the key", () => {
      writeJson(teamPath(), teamFile());
      writeJson(localPath(), { columns: [{ id: 'lane-build', description: 'mine' }] });
      openProject();
      expect(swimlanes.getById('lane-build')!.description).toBe('mine');

      writeJson(localPath(), { columns: [{ id: 'lane-build' }] });
      openProject();

      expect(swimlanes.getById('lane-build')!.description).toBe('Builds things');
      expect(teamColumn('lane-build')!.description).toBe('Builds things');
    });

    it('resets to a non-null default: color, handoff context and session target', () => {
      writeJson(teamPath(), teamFile());
      writeJson(localPath(), {
        columns: [{ id: 'lane-build', color: '#ff0000', handoffContext: true, sessionTarget: 'isolated' }],
      });
      openProject();
      const personal = swimlanes.getById('lane-build')!;
      expect(personal.color).toBe('#ff0000');
      expect(personal.handoff_context).toBe(true);
      expect(personal.session_target).toBe('isolated');

      writeJson(localPath(), { columns: [{ id: 'lane-build' }] });
      openProject();

      const reset = swimlanes.getById('lane-build')!;
      expect(reset.color).toBe('#3b82f6');
      expect(reset.handoff_context).toBe(false);
      expect(reset.session_target).toBe('main');
      const team = teamColumn('lane-build')!;
      expect(team.color).toBeUndefined();
      expect(team.handoffContext).toBeUndefined();
      expect(team.sessionTarget).toBeUndefined();
    });
  });

  describe('an explicit null in the local file clears the field', () => {
    it('clears an agent override set earlier, and the file still says null afterwards', () => {
      writeJson(teamPath(), teamFile());
      writeJson(localPath(), { columns: [{ id: 'lane-build', agentOverride: 'codex' }] });
      openProject();
      expect(swimlanes.getById('lane-build')!.agent_override).toBe('codex');

      writeJson(localPath(), { columns: [{ id: 'lane-build', agentOverride: null }] });
      openProject();

      // Red trigger: make localNullResets return an empty map and the lane keeps
      // 'codex', which the write-back then copies over the null.
      expect(swimlanes.getById('lane-build')!.agent_override).toBeNull();
      expect(localColumn('lane-build')).toEqual({ id: 'lane-build', agentOverride: null });
      expect(teamColumn('lane-build')!.agentOverride).toBeUndefined();
    });

    it("clears a team column's description, and leaves the local file alone across two opens", () => {
      writeJson(teamPath(), teamFile());
      writeJson(localPath(), { columns: [{ id: 'lane-build', description: null }] });
      const localBefore = readBytes(localPath());

      openProject();
      expect(swimlanes.getById('lane-build')!.description).toBeNull();
      expect(readBytes(localPath())).toBe(localBefore);

      openProject();
      expect(swimlanes.getById('lane-build')!.description).toBeNull();
      expect(readBytes(localPath())).toBe(localBefore);
      expect(teamColumn('lane-build')!.description).toBe('Builds things');
    });
  });

  it('keeps the team file naming a column its team name when a local entry renames it', () => {
    const team = teamFile();
    team.columns.splice(2, 0, {
      id: 'lane-review',
      name: 'Review',
      automations: { onTurnEnd: [{ name: 'Back to build', type: 'move_to_column', targetColumn: 'Build', finalLine: 'REVIEWED' }] },
    });
    writeJson(teamPath(), team);
    writeJson(localPath(), { columns: [{ id: 'lane-build', name: 'My Build' }] });
    const localBefore = readBytes(localPath());

    openProject();
    openProject();

    expect(swimlanes.list().map((lane) => lane.name)).toEqual(['To Do', 'My Build', 'Review', 'Done']);
    expect(teamColumn('lane-build')!.name).toBe('Build');
    expect(teamColumn('lane-review')!.automations?.onTurnEnd?.[0].targetColumn).toBe('Build');
    expect(readBytes(localPath())).toBe(localBefore);

    // The user picks the target by the name the board shows. The team file keeps
    // the name teammates know. Red trigger: have teamNameOf return lane.name in
    // split-config.ts and the team file says 'My Build'.
    const reviewRows = automations.listForColumn('lane-review');
    automations.replaceForColumn('lane-review', reviewRows.map((row) => ({
      ...toWriteInput(row),
      config: { ...row.config, targetColumn: 'My Build' },
    })));
    manager.writeBackForProject(PROJECT_ID, projectDir);

    expect(teamColumn('lane-review')!.automations?.onTurnEnd?.[0].targetColumn).toBe('Build');
    expect(teamColumn('lane-build')!.name).toBe('Build');
    expect(readBytes(localPath())).toBe(localBefore);
  });

  it('saves a Move to column row that targets a local-only column in the local file', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-mine', name: 'Mine' }] });
    openProject();
    const teamRowsBefore = teamColumn('lane-build')!.automations;
    expect(teamRowsBefore).toEqual(teamFile().columns[1].automations);

    const existingRows = automations.listForColumn('lane-build').map(toWriteInput);
    automations.replaceForColumn('lane-build', [
      ...existingRows,
      { name: 'To mine', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: { targetColumn: 'Mine' }, final_line: null },
    ]);
    manager.writeBackForProject(PROJECT_ID, projectDir);

    // Red trigger: drop `rowsPointLocal` from the keep-team-value condition in split-config.ts.
    expect(teamColumn('lane-build')!.automations).toEqual(teamRowsBefore);
    expect(readBytes(teamPath())).not.toContain('Mine');
    const entry = localColumn('lane-build')!;
    expect(entry.automations?.onEnter?.map((row) => row.name)).toEqual(['Team message']);
    expect(entry.automations?.onTurnEnd).toHaveLength(1);
    expect(entry.automations?.onTurnEnd?.[0]).toMatchObject({ name: 'To mine', type: 'move_to_column', targetColumn: 'Mine' });
  });

  it('advances the apply snapshot only on an apply that ran', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', color: '#ff0000' }] });
    openProject();
    expect(swimlanes.getById('lane-build')!.color).toBe('#ff0000');

    // No color any more, and a second Done that the validator rejects.
    writeJson(localPath(), { columns: [{ id: 'lane-build' }, { name: 'Done' }] });
    const rejected = manager.applyConfig(PROJECT_ID, projectDir);
    expect(rejected.warnings.join('\n')).toContain("duplicate column name 'Done'");
    expect(swimlanes.getById('lane-build')!.color).toBe('#ff0000');

    writeJson(localPath(), { columns: [] });
    openProject();

    // Red trigger: drop `result.applied &&` before the snapshot set in applyConfig
    // and the rejected file becomes the snapshot, which has no color to reset.
    expect(swimlanes.getById('lane-build')!.color).toBe('#3b82f6');
    expect(teamColumn('lane-build')!.color).toBeUndefined();
  });

  it('keeps a value out of kangentic.json while the local file that dropped it is rejected', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', color: '#ff0000' }] });
    openProject();
    const teamBefore = readBytes(teamPath());

    // The local entry no longer claims the color, but the validator rejects the
    // file, so the lane still holds the personal red. A full open writes back.
    writeJson(localPath(), { columns: [{ id: 'lane-build' }, { name: 'Done' }] });
    const localRejected = readBytes(localPath());
    openProject();

    // Red trigger: route the split by the file on disk instead of the applied
    // version in doWriteBack, and the red lands in kangentic.json.
    expect(readBytes(teamPath())).toBe(teamBefore);
    expect(readBytes(localPath())).toBe(localRejected);
  });

  it("resolves the team file's pointers at a column the local file renames", () => {
    const team = teamFile();
    team.columns.splice(2, 0, {
      id: 'lane-review',
      name: 'Review',
      planExitTarget: 'Build',
      automations: { onTurnEnd: [{ name: 'Back to build', type: 'move_to_column', targetColumn: 'Build', finalLine: 'REVIEWED' }] },
    });
    writeJson(teamPath(), team);
    writeJson(localPath(), { columns: [{ id: 'lane-build', name: 'My Build' }] });

    const warnings = manager.applyConfig(PROJECT_ID, projectDir).warnings;
    manager.writeBackForProject(PROJECT_ID, projectDir);
    openProject();

    // Red trigger: drop the renameTeamPointers pass from mergeBoardConfigs and
    // apply clears the target with an "unknown column 'Build'" warning.
    expect(warnings.join('\n')).not.toContain('unknown column');
    expect(swimlanes.getById('lane-review')!.plan_exit_target_id).toBe('lane-build');
    expect(automations.listForColumn('lane-review')[0].config).toMatchObject({ targetColumn: 'My Build' });
    // And the write-back puts the team names back.
    expect(teamColumn('lane-review')!.planExitTarget).toBe('Build');
    expect(teamColumn('lane-review')!.automations?.onTurnEnd?.[0].targetColumn).toBe('Build');
  });

  it('keeps a junk entry in the local file across opens', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [null, { id: 'lane-build', description: 'x' }] });

    openProject();
    const afterFirst = readBytes(localPath());
    expect(localColumns()[0]).toBeNull();
    expect(swimlanes.getById('lane-build')!.description).toBe('x');

    openProject();
    expect(readBytes(localPath())).toBe(afterFirst);
    expect(localColumns()[0]).toBeNull();
  });

  it('applies a board whose local file holds a nameless override of a column the team does not have', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-gone', description: 'mine' }] });
    const localBefore = readBytes(localPath());

    const { warnings } = manager.applyConfig(PROJECT_ID, projectDir);
    manager.writeBackForProject(PROJECT_ID, projectDir);

    expect(warnings.join('\n')).not.toContain('no name');
    expect(swimlanes.list().map((lane) => lane.name)).toEqual(['To Do', 'Build', 'Done']);
    expect(readBytes(localPath())).toBe(localBefore);
  });

  describe('removeLocalColumn writes nothing it should not', () => {
    it('writes nothing on an ephemeral manager', () => {
      writeJson(teamPath(), teamFile());
      fs.writeFileSync(localPath(), JSON.stringify({ columns: [{ id: 'lane-mine', name: 'Mine' }] }));
      const localBefore = readBytes(localPath());

      new BoardConfigManager({ ephemeral: true }).removeLocalColumn(PROJECT_ID, projectDir, 'lane-mine');

      expect(readBytes(localPath())).toBe(localBefore);
    });

    it('leaves an unreadable local file as it is, and does not throw', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeJson(teamPath(), teamFile());
      fs.writeFileSync(localPath(), '{ not json');

      expect(() => manager.removeLocalColumn(PROJECT_ID, projectDir, 'lane-mine')).not.toThrow();

      expect(readBytes(localPath())).toBe('{ not json');
      expect(warn).toHaveBeenCalled();
    });

    it('leaves the file untouched when the column has no entry', () => {
      writeJson(teamPath(), teamFile());
      // Compact on purpose: a rewrite would be indented, so any write shows in the bytes.
      fs.writeFileSync(localPath(), JSON.stringify({ columns: [{ id: 'lane-other', name: 'Other' }] }));
      const localBefore = readBytes(localPath());

      manager.removeLocalColumn(PROJECT_ID, projectDir, 'lane-mine');

      expect(readBytes(localPath())).toBe(localBefore);
    });
  });

  it('applies a hand edit made inside the write-back suppression window', () => {
    writeJson(teamPath(), teamFile());
    const send = vi.fn();
    const internals = manager as unknown as ManagerInternals;
    internals.activeProjectId = PROJECT_ID;
    internals.activeProjectPath = projectDir;
    internals.mainWindow = { isDestroyed: () => false, webContents: { send } };
    openProject();

    internals.isWritingBack = true;
    writeJson(localPath(), { columns: [{ id: 'lane-build', description: 'hand edit' }] });
    internals.onFileChanged(PROJECT_ID, 'local');

    // Red trigger: move the `isWritingBack` fast path above the local branch in onFileChanged.
    expect(swimlanes.getById('lane-build')!.description).toBe('hand edit');
    expect(send).toHaveBeenCalledWith(IPC.BOARD_CONFIG_LOCAL_APPLIED, PROJECT_ID);
  });

  it('gives a local-only column added by hand its id on the write-back that follows the apply', () => {
    vi.useFakeTimers();
    try {
      writeJson(teamPath(), teamFile());
      const internals = manager as unknown as ManagerInternals;
      internals.activeProjectId = PROJECT_ID;
      internals.activeProjectPath = projectDir;
      internals.mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
      openProject();

      writeJson(localPath(), { columns: [{ name: 'Scratch' }] });
      internals.onFileChanged(PROJECT_ID, 'local');
      // The follow-up write-back is the debounced one.
      vi.advanceTimersByTime(600);

      // Red trigger: drop the `this.writeBack()` call at the end of applyLocalFileChange,
      // and the next open creates a second Scratch.
      const scratchLane = swimlanes.list().find((lane) => lane.name === 'Scratch')!;
      expect(localColumns()).toEqual([{ name: 'Scratch', id: scratchLane.id }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an unknown key on a team column entry through a write-back', () => {
    writeJson(teamPath(), teamFile());
    writeJson(localPath(), { columns: [{ id: 'lane-build', description: 'local only', futureKey: 1 }] });
    const localBefore = readBytes(localPath());

    openProject();
    expect(readBytes(localPath())).toBe(localBefore);

    // A real edit forces the entry to be rewritten; the key this build cannot read must survive it.
    swimlanes.update({ id: 'lane-build', description: 'edited here' });
    manager.writeBackForProject(PROJECT_ID, projectDir);

    expect(readBytes(localPath())).not.toBe(localBefore);
    expect(localColumn('lane-build')).toEqual({ id: 'lane-build', description: 'edited here', futureKey: 1 });
  });
});
