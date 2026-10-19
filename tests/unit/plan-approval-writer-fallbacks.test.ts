/**
 * PlanApprovalWriter's fallback and lifecycle paths
 * (src/main/plan-approval/plan-approval-writer.ts, plan-approval-spawns.ts).
 *
 * plan-approval-writer.test.ts pins the happy path: where the file goes, the
 * first write, the rewrite on a board change. This file pins what happens when
 * things go wrong or end:
 *
 * - a board read that throws approves nothing (the user decides);
 * - an unchanged decision is not rewritten;
 * - a failed write leaves the decision unset and is retried on a bounded budget;
 * - an exited or removed session is forgotten, with its spawn record;
 * - a session already live when the writer starts is written at once;
 * - `refreshPlanApprovals` (the Board Profile and settings path) is a no-op
 *   before the writer starts and a coalesced refresh plus a workflow reload after;
 * - `releaseCommandHold` ends the spawn record along with the hold.
 *
 * The board read and the write are stubbed: the decision itself is
 * `resolvePlanApprovalDecision`'s job and the atomic write is `safeWriteJson`'s.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentParser, Session } from '../../src/shared/types';
import type { PlanApprovalDecision } from '../../src/main/agent/shared/plan-approval-hook';

interface DecisionRead {
  projectId: string;
  taskId: string;
  agentCanApprove: boolean;
  bypassAvailable: boolean;
}

interface WriteAttempt {
  filePath: string;
  value: unknown;
  label: string | undefined;
}

const hoisted = vi.hoisted(() => ({
  decision: null as PlanApprovalDecision | null,
  readError: null as Error | null,
  reads: [] as DecisionRead[],
  notifiedBoards: [] as string[],
  writeSucceeds: true,
  writeAttempts: [] as WriteAttempt[],
}));

vi.mock('../../src/main/plan-approval/read-decision', () => ({
  newDecisionReadCache: () => ({ workflowValues: new Map(), globalModes: new Map() }),
  readPlanApprovalDecision: (_context: unknown, input: DecisionRead) => {
    hoisted.reads.push({ projectId: input.projectId, taskId: input.taskId, agentCanApprove: input.agentCanApprove, bypassAvailable: input.bypassAvailable });
    if (hoisted.readError) throw hoisted.readError;
    // A fresh object per read, as the real reader returns: sameness is by value.
    return hoisted.decision ? { ...hoisted.decision } : null;
  },
}));
vi.mock('../../src/main/plan-approval/workflow-plan-approval', () => ({
  notifyWorkflowsReadingBoard: (_context: unknown, boardProjectId: string) => hoisted.notifiedBoards.push(boardProjectId),
}));
vi.mock('../../src/main/safe-write', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    safeWriteJson: (filePath: string, value: unknown, label?: string) => {
      hoisted.writeAttempts.push({ filePath, value, label });
      if (!hoisted.writeSucceeds) return false;
      nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      nodeFs.writeFileSync(filePath, JSON.stringify(value));
      return true;
    },
  };
});

const writerModule = await import('../../src/main/plan-approval/plan-approval-writer');
const { PlanApprovalWriter, startPlanApprovalWriter, refreshPlanApprovals } = writerModule;
const { forgetPlanApprovalSpawn, notePlanApprovalSpawn, spawnedSessionFor } = await import('../../src/main/plan-approval/plan-approval-spawns');
const { releaseCommandHold } = await import('../../src/main/pty/lifecycle/adapter-lifecycle');

// Mirror the writer's private constants. A change there is a deliberate change
// to the retry contract and should show up here.
const REFRESH_DEBOUNCE_MS = 100;
const WRITE_RETRY_MS = 1_000;
const WRITE_RETRY_LIMIT = 3;

class FakeSessionManager extends EventEmitter {
  lookup: ((sessionId: string) => boolean) | null = null;
  agentNames = new Map<string, string>();
  liveSessions: Session[] = [];
  setPlanApprovalLookup(lookup: (sessionId: string) => boolean): void { this.lookup = lookup; }
  getSessionAgentName(sessionId: string): string | undefined { return this.agentNames.get(sessionId); }
  listSessions(): Session[] { return this.liveSessions; }
}

type BoardChange = { projectId: string; change: string; ids: string[] };

class FakeBoardEvents {
  private listeners: Array<(event: BoardChange) => void> = [];
  onBoardChanged(listener: (event: BoardChange) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((candidate) => candidate !== listener); };
  }
  emit(event: BoardChange): void {
    for (const listener of this.listeners) listener(event);
  }
}

let projectRoot: string;
let sessionManager: FakeSessionManager;
let boardEvents: FakeBoardEvents;
let context: { sessionManager: FakeSessionManager; boardEvents: FakeBoardEvents; projectRepo: { getById(): { id: string; path: string } } };
let writer: InstanceType<typeof PlanApprovalWriter> | null;

function session(id: string, status: Session['status'] = 'running'): Session {
  return { id, taskId: 'task-1', projectId: 'project-1', status, transient: false } as unknown as Session;
}

function decisionFile(sessionId: string): PlanApprovalDecision | null {
  const filePath = path.join(projectRoot, '.kangentic', 'sessions', sessionId, 'plan-approval.json');
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function startWriter(): InstanceType<typeof PlanApprovalWriter> {
  writer = new PlanApprovalWriter(context as never);
  writer.start();
  return writer;
}

function requireWriter(): InstanceType<typeof PlanApprovalWriter> {
  if (!writer) throw new Error('startWriter() was not called');
  return writer;
}

function changeBoard(): void {
  boardEvents.emit({ projectId: 'project-1', change: 'task-updated', ids: [] });
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.decision = { approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' };
  hoisted.readError = null;
  hoisted.reads = [];
  hoisted.notifiedBoards = [];
  hoisted.writeSucceeds = true;
  hoisted.writeAttempts = [];
  // The spawn registry is module state: a record from another test would point here.
  forgetPlanApprovalSpawn('session-1');
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approval-fallbacks-'));
  sessionManager = new FakeSessionManager();
  sessionManager.agentNames.set('session-1', 'claude');
  boardEvents = new FakeBoardEvents();
  context = {
    sessionManager,
    boardEvents,
    projectRepo: { getById: () => ({ id: 'project-1', path: projectRoot }) },
  };
  writer = null;
});

afterEach(() => {
  writer?.dispose();
  writer = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  forgetPlanApprovalSpawn('session-1');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('PlanApprovalWriter, a board that will not read', () => {
  it('writes NO_APPROVAL to the decision file and approves nothing when the read throws', () => {
    hoisted.readError = new Error('board unreadable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));

    expect(decisionFile('session-1')).toEqual({ approve: false, mode: 'default', detail: null });
    expect(requireWriter().approves('session-1')).toBe(false);
    expect(sessionManager.lookup?.('session-1')).toBe(false);
    expect(warn).toHaveBeenCalled();

    // NO_APPROVAL is the session's recorded decision, so a read that keeps
    // failing does not rewrite it on every pass.
    changeBoard();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(hoisted.reads).toHaveLength(2);
    expect(hoisted.writeAttempts).toHaveLength(1);
  });

  it('writes the real decision on the next pass once the board reads again', () => {
    hoisted.readError = new Error('board unreadable');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(decisionFile('session-1')?.approve).toBe(false);

    hoisted.readError = null;
    changeBoard();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(decisionFile('session-1')).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(requireWriter().approves('session-1')).toBe(true);
  });
});

describe('PlanApprovalWriter, an unchanged decision', () => {
  it('is not rewritten across refresh passes, though each pass re-reads the board', () => {
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(hoisted.writeAttempts).toHaveLength(1);

    for (let pass = 0; pass < 2; pass++) {
      changeBoard();
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    }
    // First write plus two passes: the passes did run and read.
    expect(hoisted.reads).toHaveLength(3);
    expect(hoisted.writeAttempts).toHaveLength(1);
  });

  it.each([
    ['mode', { approve: true, mode: 'bypassPermissions', detail: 'Moved to Executing' }],
    ['detail', { approve: true, mode: 'acceptEdits', detail: 'Moved to Review' }],
    ['approve', { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' }],
  ] as Array<[string, PlanApprovalDecision]>)('is rewritten when only its %s changed', (_field, changed) => {
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    hoisted.decision = changed;
    changeBoard();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(hoisted.writeAttempts).toHaveLength(2);
    expect(decisionFile('session-1')).toEqual(changed);
  });
});

describe('PlanApprovalWriter, a failed write', () => {
  it('leaves the decision unset, so the session approves nothing though the board says it should', () => {
    hoisted.writeSucceeds = false;
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(hoisted.writeAttempts).toHaveLength(1);
    expect(requireWriter().approves('session-1')).toBe(false);
    expect(decisionFile('session-1')).toBeNull();
  });

  it('writes again after the retry delay plus the refresh debounce, and the decision is set once it lands', () => {
    hoisted.writeSucceeds = false;
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));

    vi.advanceTimersByTime(WRITE_RETRY_MS + REFRESH_DEBOUNCE_MS - 1);
    expect(hoisted.writeAttempts).toHaveLength(1);

    hoisted.writeSucceeds = true;
    vi.advanceTimersByTime(1);
    expect(hoisted.writeAttempts).toHaveLength(2);
    expect(decisionFile('session-1')?.approve).toBe(true);
    expect(requireWriter().approves('session-1')).toBe(true);

    // Landed: nothing is pending, so a quiet board does not write again.
    vi.advanceTimersByTime(60_000);
    expect(hoisted.writeAttempts).toHaveLength(2);
  });

  it('stops retrying after WRITE_RETRY_LIMIT consecutive failures', () => {
    hoisted.writeSucceeds = false;
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    vi.advanceTimersByTime(60_000);
    // The first attempt plus the retry budget, then nothing more.
    expect(hoisted.writeAttempts).toHaveLength(1 + WRITE_RETRY_LIMIT);
    vi.advanceTimersByTime(60_000);
    expect(hoisted.writeAttempts).toHaveLength(1 + WRITE_RETRY_LIMIT);
    expect(requireWriter().approves('session-1')).toBe(false);
  });

  it('resets the retry budget on a success, so the next failure gets the full budget again', () => {
    hoisted.writeSucceeds = false;
    startWriter();
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    // Attempt 2 fails too: one retry of the budget is left.
    vi.advanceTimersByTime(WRITE_RETRY_MS + REFRESH_DEBOUNCE_MS);
    expect(hoisted.writeAttempts).toHaveLength(2);

    // Attempt 3 lands.
    hoisted.writeSucceeds = true;
    vi.advanceTimersByTime(WRITE_RETRY_MS + REFRESH_DEBOUNCE_MS);
    expect(hoisted.writeAttempts).toHaveLength(3);
    expect(requireWriter().approves('session-1')).toBe(true);

    // The decision changes and every write fails again.
    hoisted.writeSucceeds = false;
    hoisted.decision = { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' };
    changeBoard();
    vi.advanceTimersByTime(60_000);
    // A fresh first attempt plus the whole budget. Without the reset only the
    // one retry left over from before the success would run.
    expect(hoisted.writeAttempts).toHaveLength(3 + 1 + WRITE_RETRY_LIMIT);
  });
});

describe('PlanApprovalWriter, a session that ends', () => {
  it.each([
    ['exit', ['session-1', 0, false]],
    ['session-removed', ['session-1', session('session-1', 'exited')]],
  ] as Array<[string, unknown[]]>)('forgets the session and its spawn record on %s', (eventName, eventArguments) => {
    startWriter();
    notePlanApprovalSpawn('session-1', {
      sessionDir: path.join(projectRoot, '.kangentic', 'sessions', 'session-1'),
      bypassAvailable: false,
    });
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(requireWriter().approves('session-1')).toBe(true);
    expect(spawnedSessionFor('session-1')).toBeDefined();

    sessionManager.emit(eventName, ...eventArguments);
    expect(spawnedSessionFor('session-1')).toBeUndefined();
    expect(requireWriter().approves('session-1')).toBe(false);

    // A change that would rewrite a tracked session finds nothing to write.
    hoisted.decision = { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' };
    hoisted.reads = [];
    const writesBefore = hoisted.writeAttempts.length;
    changeBoard();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS * 2);
    expect(hoisted.reads).toEqual([]);
    expect(hoisted.writeAttempts).toHaveLength(writesBefore);
    expect(decisionFile('session-1')?.approve).toBe(true);
  });
});

describe('PlanApprovalWriter, a session live before the writer starts', () => {
  it('writes its decision file at start, with no session-changed event', () => {
    sessionManager.liveSessions = [session('session-1')];
    startWriter();
    expect(decisionFile('session-1')).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(requireWriter().approves('session-1')).toBe(true);
    expect(sessionManager.lookup?.('session-1')).toBe(true);
  });

  it('writes nothing at start for a listed session that is not live', () => {
    sessionManager.liveSessions = [session('session-1', 'suspended')];
    startWriter();
    expect(decisionFile('session-1')).toBeNull();
    expect(hoisted.reads).toEqual([]);
    expect(requireWriter().approves('session-1')).toBe(false);
  });
});

describe('refreshPlanApprovals', () => {
  it('is a no-op before the writer has started', async () => {
    vi.resetModules();
    const freshModule = await import('../../src/main/plan-approval/plan-approval-writer');
    expect(() => freshModule.refreshPlanApprovals('project-1')).not.toThrow();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS * 2);
    expect(hoisted.reads).toEqual([]);
    expect(hoisted.notifiedBoards).toEqual([]);
  });

  it('re-reads every live session after the debounce and reloads the workflows reading that board', () => {
    writer = startPlanApprovalWriter(context as never);
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(decisionFile('session-1')?.approve).toBe(true);

    hoisted.decision = { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' };
    refreshPlanApprovals('project-1');
    // The workflow reload is immediate, the re-read is coalesced.
    expect(hoisted.notifiedBoards).toEqual(['project-1']);
    expect(decisionFile('session-1')?.approve).toBe(true);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(decisionFile('session-1')?.approve).toBe(false);
    expect(writer.approves('session-1')).toBe(false);
  });

  it('only reschedules the re-read when it names no board', () => {
    writer = startPlanApprovalWriter(context as never);
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    hoisted.decision = { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' };

    refreshPlanApprovals();
    refreshPlanApprovals(null);
    expect(hoisted.notifiedBoards).toEqual([]);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(decisionFile('session-1')?.approve).toBe(false);
  });
});

describe('releaseCommandHold and the plan approval spawn record', () => {
  it('forgets the spawn record along with the hold', () => {
    notePlanApprovalSpawn('session-1', {
      sessionDir: path.join(projectRoot, '.kangentic', 'sessions', 'session-1'),
      bypassAvailable: true,
    });
    expect(spawnedSessionFor('session-1')).toBeDefined();
    releaseCommandHold(undefined, projectRoot, 'session-1');
    expect(spawnedSessionFor('session-1')).toBeUndefined();
  });

  it('forgets the record even when the adapter strip throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    notePlanApprovalSpawn('session-1', {
      sessionDir: path.join(projectRoot, '.kangentic', 'sessions', 'session-1'),
      bypassAvailable: false,
    });
    const throwingParser = {
      removeHooks: () => { throw new Error('strip failed'); },
    } as unknown as AgentParser;
    expect(() => releaseCommandHold(throwingParser, projectRoot, 'session-1')).not.toThrow();
    expect(spawnedSessionFor('session-1')).toBeUndefined();
  });

  it('leaves another session record alone', () => {
    notePlanApprovalSpawn('session-1', { sessionDir: path.join(projectRoot, 'one'), bypassAvailable: false });
    notePlanApprovalSpawn('session-2', { sessionDir: path.join(projectRoot, 'two'), bypassAvailable: false });
    releaseCommandHold(undefined, projectRoot, 'session-1');
    expect(spawnedSessionFor('session-2')).toBeDefined();
    forgetPlanApprovalSpawn('session-2');
  });
});
