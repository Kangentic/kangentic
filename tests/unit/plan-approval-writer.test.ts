/**
 * PlanApprovalWriter: the decision file each live task session's plan approval
 * hook reads. The decision itself is `resolvePlanApprovalDecision`'s job
 * (plan-approval-decision.test.ts), so the board read is stubbed here and this
 * pins the writer's own: where the file goes, when it is written and
 * rewritten, and what `approves` says to the activity pipeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../src/shared/types';
import type { PlanApprovalDecision } from '../../src/main/agent/shared/plan-approval-hook';

const hoisted = vi.hoisted(() => ({
  decision: null as PlanApprovalDecision | null,
  reads: [] as Array<{ projectId: string; taskId: string; agentCanApprove: boolean; bypassAvailable: boolean }>,
  notifiedBoards: [] as string[],
}));

vi.mock('../../src/main/plan-approval/read-decision', () => ({
  newDecisionReadCache: () => ({ workflowValues: new Map(), globalModes: new Map() }),
  readPlanApprovalDecision: (_context: unknown, input: { projectId: string; taskId: string; agentCanApprove: boolean; bypassAvailable: boolean }) => {
    hoisted.reads.push({ projectId: input.projectId, taskId: input.taskId, agentCanApprove: input.agentCanApprove, bypassAvailable: input.bypassAvailable });
    return hoisted.decision;
  },
}));
vi.mock('../../src/main/plan-approval/workflow-plan-approval', () => ({
  notifyWorkflowsReadingBoard: (_context: unknown, boardProjectId: string) => hoisted.notifiedBoards.push(boardProjectId),
}));
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

const { PlanApprovalWriter } = await import('../../src/main/plan-approval/plan-approval-writer');
const { forgetPlanApprovalSpawn, notePlanApprovalSpawn, planApprovalModeForSpawn } = await import('../../src/main/plan-approval/plan-approval-spawns');

class FakeSessionManager extends EventEmitter {
  lookup: ((sessionId: string) => boolean) | null = null;
  agentNames = new Map<string, string>();
  setPlanApprovalLookup(lookup: (sessionId: string) => boolean): void { this.lookup = lookup; }
  getSessionAgentName(sessionId: string): string | undefined { return this.agentNames.get(sessionId); }
  listSessions(): Session[] { return []; }
}

class FakeBoardEvents {
  private listeners: Array<(event: { projectId: string; change: string; ids: string[] }) => void> = [];
  onBoardChanged(listener: (event: { projectId: string; change: string; ids: string[] }) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((candidate) => candidate !== listener); };
  }
  emit(event: { projectId: string; change: string; ids: string[] }): void {
    for (const listener of this.listeners) listener(event);
  }
}

let projectRoot: string;
let sessionManager: FakeSessionManager;
let boardEvents: FakeBoardEvents;
let writer: InstanceType<typeof PlanApprovalWriter>;

function session(id: string, status: Session['status'] = 'running'): Session {
  return { id, taskId: 'task-1', projectId: 'project-1', status, transient: false } as unknown as Session;
}

function decisionFile(sessionId: string): PlanApprovalDecision | null {
  const filePath = path.join(projectRoot, '.kangentic', 'sessions', sessionId, 'plan-approval.json');
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.decision = { approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' };
  hoisted.reads = [];
  hoisted.notifiedBoards = [];
  // The spawn registry is module state: a record from another test would point here.
  forgetPlanApprovalSpawn('session-1');
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approval-writer-'));
  sessionManager = new FakeSessionManager();
  sessionManager.agentNames.set('session-1', 'claude');
  boardEvents = new FakeBoardEvents();
  const context = {
    sessionManager,
    boardEvents,
    projectRepo: { getById: () => ({ id: 'project-1', path: projectRoot }) },
  };
  writer = new PlanApprovalWriter(context as never);
  writer.start();
});

afterEach(() => {
  writer.dispose();
  vi.useRealTimers();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('PlanApprovalWriter', () => {
  it('writes the decision when a task session first appears, with no board event needed', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(decisionFile('session-1')).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(sessionManager.lookup?.('session-1')).toBe(true);
    // Read from the session's own task, with the agent's capability.
    expect(hoisted.reads[0]).toMatchObject({ projectId: 'project-1', taskId: 'task-1', agentCanApprove: true });
  });

  it('writes into the directory the spawn recorded, and passes on whether bypass is available', () => {
    const spawnDir = path.join(projectRoot, 'elsewhere', 'session-1');
    notePlanApprovalSpawn('session-1', { sessionDir: spawnDir, bypassAvailable: true });
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(JSON.parse(fs.readFileSync(path.join(spawnDir, 'plan-approval.json'), 'utf8'))).toMatchObject({ approve: true });
    expect(hoisted.reads[0].bypassAvailable).toBe(true);
  });

  it('rewrites the file when the board changes while the agent plans', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    hoisted.decision = { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' };
    boardEvents.emit({ projectId: 'project-1', change: 'swimlane-updated', ids: [] });
    // Coalesced, not immediate.
    expect(decisionFile('session-1')?.approve).toBe(true);
    vi.advanceTimersByTime(200);
    expect(decisionFile('session-1')?.approve).toBe(false);
    expect(sessionManager.lookup?.('session-1')).toBe(false);
    // A column change also reloads the workflows reading that board.
    expect(hoisted.notifiedBoards).toEqual(['project-1']);
  });

  it('approves nothing for an agent that cannot approve plans, whatever the board says', () => {
    sessionManager.agentNames.set('session-1', 'codex');
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(hoisted.reads[0].agentCanApprove).toBe(false);
  });

  it('stops writing for a session that is no longer live', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    sessionManager.emit('session-changed', 'session-1', session('session-1', 'suspended'));
    hoisted.reads = [];
    boardEvents.emit({ projectId: 'project-1', change: 'task-updated', ids: [] });
    vi.advanceTimersByTime(200);
    expect(hoisted.reads).toEqual([]);
    expect(sessionManager.lookup?.('session-1')).toBe(false);
  });

  it('never tracks a transient session', () => {
    sessionManager.emit('session-changed', 'session-1', { ...session('session-1'), transient: true });
    expect(decisionFile('session-1')).toBeNull();
  });

  it('tells a plan spawn the mode an approval would continue in, and null when nothing is approved', () => {
    hoisted.decision = { approve: true, mode: 'bypassPermissions', detail: 'Moved to Executing' };
    expect(planApprovalModeForSpawn('project-1', 'task-1')).toBe('bypassPermissions');
    hoisted.decision = { approve: false, mode: 'bypassPermissions', detail: null };
    expect(planApprovalModeForSpawn('project-1', 'task-1')).toBeNull();
  });
});
