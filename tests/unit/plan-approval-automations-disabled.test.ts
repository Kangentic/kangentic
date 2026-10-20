/**
 * Disable automations holds a task's plan approval as Manual, end to end: the
 * switch is written to the task row, announced on the board bus the way the
 * card menu's TASK_UPDATE announces it (`announceTaskBoardChange`), and the
 * real `PlanApprovalWriter` re-reads the real board (`readPlanApprovalDecision`
 * over migrated SQLite) and rewrites the live session's decision file.
 *
 * plan-approval-writer.test.ts stubs the board read, so it cannot show that
 * the flag reaches the decision. This file runs the whole chain with only the
 * session manager faked and the atomic write reduced to a plain write.
 *
 * Board: To Do, Planning (plan mode, Automatic, exits to Executing),
 * Executing, Code Review, Testing, Merge and Done.
 *
 * Red-green: dropping the `automationsDisabled` gate in
 * `resolvePlanApprovalDecision` fails the rewrite tests; dropping
 * `ignoreDisabledAutomations` from the writer's spawn resolver fails the spawn
 * test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { PermissionMode, Session, Task } from '../../src/shared/types';
import type { PlanApprovalDecision } from '../../src/main/agent/shared/plan-approval-hook';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/safe-write', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    safeWriteJson: (filePath: string, value: unknown) => {
      nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      nodeFs.writeFileSync(filePath, JSON.stringify(value));
      return true;
    },
  };
});

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { BoardEventBus } = await import('../../src/main/mobile-bridge/board-event-bus');
const { announceTaskBoardChange } = await import('../../src/main/ipc/helpers/task-write-announce');
const { PlanApprovalWriter } = await import('../../src/main/plan-approval/plan-approval-writer');
const {
  forgetPlanApprovalSpawn,
  notePlanApprovalSpawn,
  planApprovalModeForSpawn,
  planSpawnNeedsBypass,
} = await import('../../src/main/plan-approval/plan-approval-spawns');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// Mirrors the writer's private constant, as plan-approval-writer.test.ts does.
const REFRESH_DEBOUNCE_MS = 100;
const SESSION_ID = 'session-held';

class FakeSessionManager extends EventEmitter {
  lookup: ((sessionId: string) => boolean) | null = null;
  setPlanApprovalLookup(lookup: (sessionId: string) => boolean): void { this.lookup = lookup; }
  getSessionAgentName(): string { return 'claude'; }
  listSessions(): Session[] { return []; }
}

let sessionRoot: string;
let sessionManager: FakeSessionManager;
let context: IpcContext;
let writer: InstanceType<typeof PlanApprovalWriter>;

const homeDb = () => harness.dbs.get('home') as Database.Database;
const laneId = (name: string) => new SwimlaneRepository(homeDb()).list().find((lane) => lane.name === name)!.id;
const taskRepository = () => new TaskRepository(homeDb());

function editColumn(name: string, changes: { plan_approval?: 'automatic' | 'manual'; permission_mode?: PermissionMode | null; plan_exit_target_id?: string | null }): void {
  new SwimlaneRepository(homeDb()).update({ id: laneId(name), ...changes });
}

function createPlanningTask(): Task {
  return taskRepository().create({ title: 'Wire budgets API', description: '', swimlane_id: laneId('Planning') });
}

/** Throw the switch as the card menu does: write the row, announce it on the bus. */
function setAutomationsDisabled(task: Task, automationsDisabled: boolean): void {
  taskRepository().update({ id: task.id, automations_disabled: automationsDisabled });
  announceTaskBoardChange(context, 'home', { change: 'task-updated', ids: [task.id] });
}

/** Bring up a live session on the task, as the spawn chokepoints record one. */
function startSession(task: Task): void {
  notePlanApprovalSpawn(SESSION_ID, { sessionDir: path.join(sessionRoot, SESSION_ID), bypassAvailable: true });
  const session = { id: SESSION_ID, taskId: task.id, projectId: 'home', status: 'running', transient: false } as unknown as Session;
  sessionManager.emit('session-changed', SESSION_ID, session);
}

function decisionFile(): PlanApprovalDecision {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, SESSION_ID, 'plan-approval.json'), 'utf8'));
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.dbs.clear();
  const db = openTestDatabase();
  db.exec('PRAGMA foreign_keys = ON');
  runProjectMigrations(db);
  harness.dbs.set('home', db);

  sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approval-held-'));
  sessionManager = new FakeSessionManager();
  const projects = [{ id: 'home', name: 'kangentic', path: sessionRoot }];
  context = {
    projectRepo: {
      list: () => projects,
      getById: (id: string) => projects.find((project) => project.id === id),
    },
    boardEvents: new BoardEventBus(),
    configManager: { load: () => ({}), getEffectiveConfig: () => ({ agent: { permissionMode: 'default' } }) },
    boardConfigManager: { getBoardProfiles: () => [] },
    sessionManager,
  } as unknown as IpcContext;

  editColumn('Planning', { plan_approval: 'automatic', plan_exit_target_id: laneId('Executing') });
  writer = new PlanApprovalWriter(context);
  writer.start();
});

afterEach(() => {
  writer.dispose();
  forgetPlanApprovalSpawn(SESSION_ID);
  vi.useRealTimers();
  fs.rmSync(sessionRoot, { recursive: true, force: true });
});

describe('Disable automations and a live plan session', () => {
  beforeEach(() => {
    editColumn('Executing', { permission_mode: 'acceptEdits' });
  });

  it('rewrites the decision to wait for the user when the switch is thrown, and back when it is cleared', () => {
    const task = createPlanningTask();
    startSession(task);
    // Control: an Automatic plan column approves while the task's automations run.
    expect(decisionFile()).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(sessionManager.lookup?.(SESSION_ID)).toBe(true);

    setAutomationsDisabled(task, true);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);

    // The destination and mode stay: only who approves changes.
    expect(decisionFile()).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
    // The activity gate stops holding the plan prompt's idle for an approver.
    expect(sessionManager.lookup?.(SESSION_ID)).toBe(false);

    setAutomationsDisabled(task, false);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);

    expect(decisionFile()).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(sessionManager.lookup?.(SESSION_ID)).toBe(true);
  });

  it('writes a held decision for a session that first appears while the task is held', () => {
    const task = createPlanningTask();
    taskRepository().update({ id: task.id, automations_disabled: true });

    startSession(task);

    expect(decisionFile()).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(sessionManager.lookup?.(SESSION_ID)).toBe(false);
  });
});

describe('Disable automations and the pre-spawn question', () => {
  it('still launches a held plan session with bypass available when the column\'s approval would continue in bypass', () => {
    editColumn('Executing', { permission_mode: 'bypassPermissions' });
    const task = createPlanningTask();
    taskRepository().update({ id: task.id, automations_disabled: true });

    // Enabling automations later must land the approved plan in bypass, which
    // Claude applies only to a session launched with bypass available.
    expect(planApprovalModeForSpawn('home', task.id)).toBe('bypassPermissions');
    expect(planSpawnNeedsBypass({ permissionMode: 'plan', agentApprovesPlans: true, projectId: 'home', taskId: task.id })).toBe(true);

    // Control: the session's own decision is still held.
    startSession(task);
    expect(decisionFile()).toEqual({ approve: false, mode: 'bypassPermissions', detail: 'Moved to Executing' });
  });
});
