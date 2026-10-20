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

interface DecisionRead {
  projectId: string;
  taskId: string;
  agentCanApprove: boolean;
  bypassAvailable: boolean;
  ignoreDisabledAutomations?: boolean;
}

const hoisted = vi.hoisted(() => ({
  decision: null as PlanApprovalDecision | null,
  reads: [] as DecisionRead[],
  notifiedBoards: [] as string[],
}));

vi.mock('../../src/main/plan-approval/read-decision', () => ({
  newDecisionReadCache: () => ({ workflowValues: new Map(), globalModes: new Map() }),
  readPlanApprovalDecision: (_context: unknown, input: DecisionRead) => {
    hoisted.reads.push({
      projectId: input.projectId,
      taskId: input.taskId,
      agentCanApprove: input.agentCanApprove,
      bypassAvailable: input.bypassAvailable,
      ignoreDisabledAutomations: input.ignoreDisabledAutomations,
    });
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

// Mirrors the writer's private constant. A change there is a deliberate change
// to the coalescing contract and should show up here.
const REFRESH_DEBOUNCE_MS = 100;

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
    // A session's decision honors a task's disabled automations.
    expect(hoisted.reads[0].ignoreDisabledAutomations).toBeUndefined();
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

  it('reads a plan spawn\'s mode as an agent that can approve with bypass reachable, and stops answering once disposed', () => {
    hoisted.decision = { approve: true, mode: 'bypassPermissions', detail: 'Moved to Executing' };
    // The session does not exist yet at spawn time, so the writer assumes the
    // best case: the answer is what the spawn should make possible. That
    // includes automations the user may enable while the session lives.
    expect(planApprovalModeForSpawn('project-1', 'task-1')).toBe('bypassPermissions');
    expect(hoisted.reads.at(-1)).toEqual({
      projectId: 'project-1',
      taskId: 'task-1',
      agentCanApprove: true,
      bypassAvailable: true,
      ignoreDisabledAutomations: true,
    });

    // The same approving board would still answer, so a null here comes from
    // the resolver having been unregistered, not from the decision.
    writer.dispose();
    expect(planApprovalModeForSpawn('project-1', 'task-1')).toBeNull();
  });
});

describe('PlanApprovalWriter, a session that is first seen queued', () => {
  it('re-derives what its agent can do once it is running, and writes the decision then', () => {
    // A queued placeholder row names no agent until its spawn runs, so the
    // session is first tracked as unable to approve and its read says no.
    sessionManager.agentNames.delete('session-1');
    hoisted.decision = { approve: false, mode: 'default', detail: null };
    sessionManager.emit('session-changed', 'session-1', session('session-1', 'queued'));
    expect(hoisted.reads).toHaveLength(1);
    expect(hoisted.reads[0].agentCanApprove).toBe(false);
    expect(decisionFile('session-1')).toEqual({ approve: false, mode: 'default', detail: null });
    expect(sessionManager.lookup?.('session-1')).toBe(false);

    // The spawn ran: the agent is named, and the same session now reads as able.
    sessionManager.agentNames.set('session-1', 'claude');
    hoisted.decision = { approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' };
    sessionManager.emit('session-changed', 'session-1', session('session-1', 'running'));
    expect(hoisted.reads).toHaveLength(2);
    expect(hoisted.reads.at(-1)?.agentCanApprove).toBe(true);
    expect(decisionFile('session-1')).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(sessionManager.lookup?.('session-1')).toBe(true);
  });

  it('does not read or rewrite again when a running session reports with its agent unchanged', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(hoisted.reads).toHaveLength(1);

    // A different answer is waiting on the board, so a wrongful re-read shows
    // up both in the read count and in the file.
    hoisted.decision = { approve: true, mode: 'acceptEdits', detail: 'Moved to Review' };
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(hoisted.reads).toHaveLength(1);
    expect(decisionFile('session-1')?.detail).toBe('Moved to Executing');
  });
});

describe('PlanApprovalWriter, the workflow reload after a pass', () => {
  it('reloads the workflows reading a board once for a burst of column edits, and only after the debounce', () => {
    boardEvents.emit({ projectId: 'project-1', change: 'swimlane-updated', ids: [] });
    boardEvents.emit({ projectId: 'project-1', change: 'swimlane-updated', ids: [] });
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS - 1);
    expect(hoisted.notifiedBoards).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(hoisted.notifiedBoards).toEqual(['project-1']);

    // Nothing is pending after the pass: a quiet board does not reload again.
    vi.advanceTimersByTime(60_000);
    expect(hoisted.notifiedBoards).toEqual(['project-1']);
  });

  it('reloads no workflow for a task change, though the pass still re-reads the sessions', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(hoisted.reads).toHaveLength(1);
    boardEvents.emit({ projectId: 'project-1', change: 'task-updated', ids: [] });
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    // The pass ran (so the empty list below is not just a pass that never came).
    expect(hoisted.reads).toHaveLength(2);
    expect(hoisted.notifiedBoards).toEqual([]);
  });

  it('reloads each changed board once when two projects change inside one debounce window', () => {
    boardEvents.emit({ projectId: 'project-2', change: 'swimlane-updated', ids: [] });
    boardEvents.emit({ projectId: 'project-1', change: 'swimlane-updated', ids: [] });
    boardEvents.emit({ projectId: 'project-2', change: 'swimlane-updated', ids: [] });
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect([...hoisted.notifiedBoards].sort()).toEqual(['project-1', 'project-2']);
  });

  it('reloads nothing when the writer is disposed before the debounce elapses', () => {
    boardEvents.emit({ projectId: 'project-1', change: 'swimlane-updated', ids: [] });
    writer.dispose();
    vi.advanceTimersByTime(60_000);
    expect(hoisted.notifiedBoards).toEqual([]);
  });
});
