/**
 * The text an agent reads back for a workflow (`formatWorkflow`, the message of
 * `kangentic_get_workflow`), built from the real read model on real, migrated
 * SQLite with two projects.
 *
 * Task numbers count per board, so two boards can each have a #1. The text has
 * to tell them apart, and has to give a plan an agent reads and sends back the
 * project of each planned task, since a save replaces the whole plan:
 * - a started workflow names the board of a task that is not on the home board
 *   ("In <column> on board"), and a blocker on another board ("#1 on <board>");
 *   a blocker on the home board stays a bare number;
 * - a draft puts the board in the task's settings as `project "<name>"`, which
 *   is save_workflow's own parameter, and its "In" clause names no board.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const projectDatabase = harness.dbs.get(projectId);
    if (!projectDatabase) throw new Error(`No database for ${projectId}`);
    return projectDatabase;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const service = await import('../../src/main/workflows/workflow-service');
const { formatWorkflow } = await import('../../src/main/workflows/workflow-format');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards, taskTitled } from './helpers/workflow-plans';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('formatWorkflow: which board a task is on', () => {
  let context: IpcContext;

  beforeEach(() => {
    harness.dbs.clear();
    for (const projectId of ['home', 'mobile']) {
      const projectDatabase = openTestDatabase();
      projectDatabase.exec('PRAGMA foreign_keys = ON');
      runProjectMigrations(projectDatabase);
      harness.dbs.set(projectId, projectDatabase);
    }
    const projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/projects/mobile' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    for (const database of harness.dbs.values()) (database as Database.Database).close();
    harness.dbs.clear();
  });

  /** The line `formatWorkflow` printed for the task with this title. */
  function lineOf(text: string, title: string): string {
    const line = text.split('\n').find((candidate) => candidate.startsWith('- ') && candidate.includes(` ${title}.`));
    if (!line) throw new Error(`No line for "${title}" in:\n${text}`);
    return line;
  }

  describe('a started workflow', () => {
    async function started() {
      const workflow = planAcrossBoards(service, context);
      await service.startWorkflow(context, 'home', workflow.id);
      const view = service.readWorkflow(context, 'home', workflow.id);
      return {
        text: formatWorkflow(view),
        api: taskTitled(view, 'Budgets API'),
        phone: taskTitled(view, 'Budgets on the phone'),
        ui: taskTitled(view, 'Budgets UI'),
      };
    }

    it('names the board of a task on another board, and no board for a task on the home board', async () => {
      const { text, api, phone, ui } = await started();

      expect(lineOf(text, phone.title)).toContain(`In ${phone.column} on board "kangentic-mobile".`);
      expect(lineOf(text, api.title)).toContain(`In ${api.column}.`);
      expect(lineOf(text, api.title)).not.toContain(' on board ');
      expect(lineOf(text, ui.title)).not.toContain(' on board ');
    });

    it('names the board of a blocker on another board that shares its number with the waiting home task, and leaves a home blocker a bare number', async () => {
      const { text, api, phone, ui } = await started();
      // The ambiguity the board name resolves: the blocker and the task that waits for it are both a bare #N.
      expect(phone.displayId).not.toBeNull();
      expect(phone.displayId).toBe(api.displayId);

      expect(lineOf(text, api.title)).toContain(`Waits for #${phone.displayId} on "kangentic-mobile".`);
      expect(lineOf(text, ui.title)).toContain(`Waits for #${api.displayId}.`);
      expect(lineOf(text, ui.title)).not.toContain(' on "');
    });
  });

  describe('a draft', () => {
    it('puts a planned task\'s other project in its settings, as save_workflow\'s project, and no board in its In clause', () => {
      const workflow = planAcrossBoards(service, context);
      const text = formatWorkflow(service.readWorkflow(context, 'home', workflow.id));

      const phoneLine = lineOf(text, 'Budgets on the phone');
      expect(phoneLine).toContain('Settings: project "kangentic-mobile".');
      expect(phoneLine).not.toContain(' on board ');
      // A task on the home board has no project to keep.
      expect(lineOf(text, 'Budgets API')).not.toContain('project "');
      expect(lineOf(text, 'Budgets UI')).not.toContain('project "');
    });

    it('keeps the planned task\'s board when the plan is read and sent back: the printed project is one save_workflow takes', () => {
      const workflow = planAcrossBoards(service, context);
      const text = formatWorkflow(service.readWorkflow(context, 'home', workflow.id));
      const printedProject = /Settings: project "([^"]+)"/.exec(lineOf(text, 'Budgets on the phone'))?.[1];
      expect(printedProject).toBeDefined();

      const saved = service.savePlan(context, 'home', workflow.id, {
        tasks: [
          { key: 'api', title: 'Budgets API' },
          { key: 'phone', title: 'Budgets on the phone', project: printedProject },
        ],
        links: [{ blocker: 'phone', blocked: 'api' }],
      });

      expect(saved.draft?.tasks.find((task) => task.key === 'phone')?.project_id).toBe('mobile');
      expect(saved.draft?.tasks.find((task) => task.key === 'api')?.project_id).toBeNull();
    });
  });

  describe('a task the workflow stalled on', () => {
    const WHY = 'the agent stopped before its step was done.';

    it('ends its line with why it stalled, and gives a task that did not stall no suffix', async () => {
      const workflow = planAcrossBoards(service, context);
      await service.startWorkflow(context, 'home', workflow.id);
      const view = service.readWorkflow(context, 'home', workflow.id);
      // Nothing stalled yet: no line carries the suffix, so the one below can only gain it from `stalled`.
      expect(formatWorkflow(view)).not.toContain('Stalled');

      // The run log's reading is set on the view row itself, so this pins the text alone.
      const stalledView = {
        ...view,
        tasks: view.tasks.map((task) => (task.title === 'Budgets API' ? { ...task, stalled: WHY } : task)),
      };
      const text = formatWorkflow(stalledView);

      expect(lineOf(text, 'Budgets API').endsWith(` Stalled: ${WHY}`)).toBe(true);
      expect(lineOf(text, 'Budgets UI')).not.toContain('Stalled');
      expect(lineOf(text, 'Budgets on the phone')).not.toContain('Stalled');
    });
  });
});
