/**
 * PlanApprovalWriter when a session's folder is missing (Sentry DESKTOP-2F).
 *
 * The folder belongs to the spawn, so the writer never creates it, and with no
 * decision file the hook leaves the plan to the user. A missing folder is that
 * state, not a failed save: no report, no toast, one local log line. Every other
 * failed write is still a failure.
 *
 * The other writer tests stub `safeWriteJson`. These run the real one and the
 * real failure latch on a real temp folder, since `safeWriteJson`'s recursive
 * mkdir and its report are the behavior in question. Only the board read, the
 * workflow reload and the Sentry call are stubbed.
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
  reportHandledError: vi.fn(),
}));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: hoisted.reportHandledError,
}));
vi.mock('../../src/main/plan-approval/read-decision', () => ({
  newDecisionReadCache: () => ({ globalModes: new Map(), boards: new Map(), legacyAdoptionsTried: new Set() }),
  readPlanApprovalDecision: () => hoisted.decision,
}));
vi.mock('../../src/main/plan-approval/workflow-plan-approval', () => ({
  notifyWorkflowsReadingBoard: () => undefined,
}));

const { PlanApprovalWriter } = await import('../../src/main/plan-approval/plan-approval-writer');
const { forgetPlanApprovalSpawn, notePlanApprovalSpawn } = await import('../../src/main/plan-approval/plan-approval-spawns');
const { __resetForTest, setSyncWriteFailureNotifier } = await import('../../src/main/config/write-failure-notice');

// Mirror the writer's private constants. A change there is a deliberate change
// to the retry contract and should show up here.
const REFRESH_DEBOUNCE_MS = 100;
const WRITE_RETRY_MS = 1_000;

const APPROVING: PlanApprovalDecision = { approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' };
const DECLINING: PlanApprovalDecision = { approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' };

class FakeSessionManager extends EventEmitter {
  setPlanApprovalLookup(): void { /* The gate is read through `writer.approves` here. */ }
  getSessionAgentName(): string { return 'claude'; }
  listSessions(): Session[] { return []; }
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
let notifier: ReturnType<typeof vi.fn<(message: string) => boolean>>;
let warn: ReturnType<typeof vi.spyOn>;
let writer: InstanceType<typeof PlanApprovalWriter>;

function session(id: string): Session {
  return { id, taskId: 'task-1', projectId: 'project-1', status: 'running', transient: false } as unknown as Session;
}

function sessionFolder(sessionId: string): string {
  return path.join(projectRoot, '.kangentic', 'sessions', sessionId);
}

function decisionFile(sessionId: string): PlanApprovalDecision | null {
  const filePath = path.join(sessionFolder(sessionId), 'plan-approval.json');
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function changeBoard(): void {
  boardEvents.emit({ projectId: 'project-1', change: 'task-updated', ids: [] });
  vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
}

// Captured before any spy is installed, so calling through never recurses.
const realStatSync = fs.statSync as (target: fs.PathLike, options?: unknown) => unknown;

/**
 * Replace `fs.statSync` for the session folder's path only. `answer` returns the
 * stat to hand back, throws, or returns 'call-through' to use the real one. Every
 * other path always goes to the real `statSync`.
 */
function stubSessionFolderStat(answer: () => fs.Stats | 'call-through'): void {
  const target = sessionFolder('session-1');
  vi.spyOn(fs, 'statSync').mockImplementation(((requested: fs.PathLike, options?: unknown) => {
    if (String(requested) === target) {
      const answered = answer();
      if (answered !== 'call-through') return answered;
    }
    return realStatSync(requested, options);
  }) as typeof fs.statSync);
}

/** The lines the writer logged about a missing folder. */
function folderWarnings(): string[] {
  return warn.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('no session folder'));
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.decision = APPROVING;
  hoisted.reportHandledError.mockClear();
  __resetForTest();
  notifier = vi.fn<(message: string) => boolean>(() => true);
  setSyncWriteFailureNotifier(notifier);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The spawn registry is module state: a record from another test would point here.
  forgetPlanApprovalSpawn('session-1');
  forgetPlanApprovalSpawn('session-2');
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approval-missing-folder-'));
  sessionManager = new FakeSessionManager();
  boardEvents = new FakeBoardEvents();
  writer = new PlanApprovalWriter({
    sessionManager,
    boardEvents,
    projectRepo: { getById: () => ({ id: 'project-1', path: projectRoot }) },
  } as never);
  writer.start();
});

afterEach(() => {
  writer.dispose();
  forgetPlanApprovalSpawn('session-1');
  forgetPlanApprovalSpawn('session-2');
  __resetForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('PlanApprovalWriter, a session whose folder is missing', () => {
  it('creates no folder and reports nothing, then writes the decision on the next pass once the folder exists', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    // Past every retry, so the write below comes from a board pass.
    vi.advanceTimersByTime(60_000);

    expect(fs.existsSync(path.join(projectRoot, '.kangentic'))).toBe(false);
    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
    expect(writer.approves('session-1')).toBe(false);

    // The session stayed tracked, so its folder arriving is all it needs.
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    changeBoard();
    expect(decisionFile('session-1')).toEqual(APPROVING);
    expect(writer.approves('session-1')).toBe(true);
    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });

  it('gives a folder that arrives within the retries its decision with no board event', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(decisionFile('session-1')).toBeNull();

    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    vi.advanceTimersByTime(WRITE_RETRY_MS + REFRESH_DEBOUNCE_MS);
    expect(decisionFile('session-1')).toEqual(APPROVING);
    expect(writer.approves('session-1')).toBe(true);
  });

  it('logs one line across every pass of an outage, naming where the path came from and never the path', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    vi.advanceTimersByTime(60_000);
    changeBoard();
    changeBoard();
    expect(folderWarnings()).toHaveLength(1);
    expect(folderWarnings()[0]).toContain('derived');
    expect(folderWarnings()[0]).not.toContain(projectRoot);

    notePlanApprovalSpawn('session-2', { sessionDir: path.join(projectRoot, 'gone', 'session-2'), bypassAvailable: false });
    sessionManager.emit('session-changed', 'session-2', session('session-2'));
    expect(folderWarnings()).toHaveLength(2);
    expect(folderWarnings()[1]).toContain('record');
  });

  it('logs again for a second outage, after a write landed between them', () => {
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(folderWarnings()).toHaveLength(1);

    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    changeBoard();
    expect(decisionFile('session-1')).toEqual(APPROVING);

    fs.rmSync(sessionFolder('session-1'), { recursive: true, force: true });
    hoisted.decision = DECLINING;
    changeBoard();
    expect(folderWarnings()).toHaveLength(2);
  });

  it('stops approving and creates nothing when the folder goes after a decision landed', () => {
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(writer.approves('session-1')).toBe(true);

    fs.rmSync(path.join(projectRoot, '.kangentic'), { recursive: true, force: true });
    hoisted.decision = DECLINING;
    changeBoard();
    expect(fs.existsSync(path.join(projectRoot, '.kangentic'))).toBe(false);
    expect(writer.approves('session-1')).toBe(false);

    // The board returns to the answer it first gave. The file is gone, so that
    // answer is written again, not taken as already on disk.
    hoisted.decision = APPROVING;
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    changeBoard();
    expect(decisionFile('session-1')).toEqual(APPROVING);
    expect(writer.approves('session-1')).toBe(true);
  });
});

describe('PlanApprovalWriter, an approval whose file has gone with the decision unchanged', () => {
  it('stops approving and creates nothing when the whole session folder is removed', () => {
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(decisionFile('session-1')).toEqual(APPROVING);
    expect(writer.approves('session-1')).toBe(true);

    fs.rmSync(sessionFolder('session-1'), { recursive: true, force: true });
    changeBoard();

    expect(writer.approves('session-1')).toBe(false);
    expect(folderWarnings()).toHaveLength(1);
    expect(fs.existsSync(sessionFolder('session-1'))).toBe(false);
    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });

  it('writes the same approval again into a folder rebuilt empty, with no report and no toast', () => {
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(decisionFile('session-1')).toEqual(APPROVING);

    // What the status file reader does for a live session whose folder vanished.
    fs.rmSync(sessionFolder('session-1'), { recursive: true, force: true });
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    expect(decisionFile('session-1')).toBeNull();
    changeBoard();

    expect(decisionFile('session-1')).toEqual(APPROVING);
    expect(writer.approves('session-1')).toBe(true);
    expect(folderWarnings()).toEqual([]);
    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });
});

describe('PlanApprovalWriter, a file in place of a parent of the session folder', () => {
  it('counts as a missing folder: no report, no toast, one log line, no approval', () => {
    fs.mkdirSync(path.join(projectRoot, '.kangentic'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.kangentic', 'sessions'), 'not a folder');

    sessionManager.emit('session-changed', 'session-1', session('session-1'));

    expect(hoisted.reportHandledError).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
    expect(folderWarnings()).toHaveLength(1);
    expect(writer.approves('session-1')).toBe(false);
  });
});

describe('PlanApprovalWriter, a stat that fails for another reason', () => {
  it('is a failed write, reported once, not a missing folder', () => {
    stubSessionFolderStat(() => {
      throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES', syscall: 'stat' });
    });

    sessionManager.emit('session-changed', 'session-1', session('session-1'));

    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    expect(hoisted.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'plan_approval' }),
    );
    expect(folderWarnings()).toEqual([]);
    expect(writer.approves('session-1')).toBe(false);
  });
});

describe('PlanApprovalWriter, a folder that goes between the check and the write', () => {
  it('creates no folder, and the next pass finds it missing', () => {
    // The folder reads as present once, for the check, and is not on disk.
    let answered = false;
    stubSessionFolderStat(() => {
      if (answered) return 'call-through';
      answered = true;
      return {} as fs.Stats;
    });
    sessionManager.emit('session-changed', 'session-1', session('session-1'));

    expect(fs.existsSync(path.join(projectRoot, '.kangentic'))).toBe(false);
    expect(writer.approves('session-1')).toBe(false);
    // The check saw a folder, so this one reads as a failed write.
    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);

    changeBoard();
    expect(fs.existsSync(path.join(projectRoot, '.kangentic'))).toBe(false);
    expect(folderWarnings()).toHaveLength(1);
    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
  });
});

describe('PlanApprovalWriter, a write that fails for another reason', () => {
  it('still reports a held file, once, as a plan approval write', () => {
    fs.mkdirSync(sessionFolder('session-1'), { recursive: true });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY', syscall: 'rename' });
    });

    sessionManager.emit('session-changed', 'session-1', session('session-1'));
    expect(writer.approves('session-1')).toBe(false);
    expect(folderWarnings()).toEqual([]);
    expect(hoisted.reportHandledError).toHaveBeenCalledTimes(1);
    expect(hoisted.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'plan_approval', errno: 'EBUSY', syscall: 'rename' }),
    );
    expect(notifier).toHaveBeenCalledTimes(1);
  });
});
