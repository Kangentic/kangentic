/**
 * The workflow hang check (src/main/workflows/workflow-hang-check.ts): a
 * running workflow task whose turn shows working and has written nothing to
 * its history for longer than its agent ever goes quiet is interrupted once,
 * and the user is told when the interrupt does not land. On a real board three
 * tasks sat 114 minutes like this, shown working, until a person restarted the
 * app and typed "continue" into each.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { ActivityReason } from '../../src/shared/types';

const MINUTE = 60_000;

const hoisted = vi.hoisted(() => ({
  running: true,
  pendingDelivery: false,
  subagentMtime: null as number | null,
  historyFile: '' as string,
  adapterDeclares: true,
  taskSessionId: 'session-1',
  subagentReads: 0,
  announce: vi.fn(),
  startOver: vi.fn(),
  recordWorkflowInterrupt: vi.fn(),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => (name !== 'claude' ? undefined : {
      hungTurn: hoisted.adapterDeclares ? { quietLimitMs: 20 * 60_000, interruptKeys: '\x1b' } : undefined,
      locateSessionHistoryFile: async () => hoisted.historyFile,
      statSubagentTranscripts: () => {
        hoisted.subagentReads += 1;
        return hoisted.subagentMtime === null ? null : { fileCount: 1, totalSize: 1, maxMtimeMs: hoisted.subagentMtime };
      },
    }),
  },
}));
vi.mock('../../src/main/workflows/workflow-home', () => ({ isRunningWorkflowStepTask: () => hoisted.running }));
vi.mock('../../src/main/workflows/workflow-recovery', () => ({ announceWorkflowStall: hoisted.announce, startWorkflowRecoveryOver: hoisted.startOver }));
vi.mock('../../src/main/automations/turn-end/turn-end-passes', () => ({ hasPendingMessageDelivery: () => hoisted.pendingDelivery }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => ({
    tasks: { getById: (id: string) => ({ id, workflow_id: 'workflow-1', swimlane_id: 'lane-executing', session_id: hoisted.taskSessionId }) },
    automationRuns: { recordWorkflowInterrupt: hoisted.recordWorkflowInterrupt },
  }),
}));

const { checkForHungTurns, stopWorkflowHangCheck, INTERRUPT_LANDING_MS } = await import('../../src/main/workflows/workflow-hang-check');

describe('a running workflow task whose turn hangs', () => {
  let directory: string;
  let activity: string;
  let reason: ActivityReason | null;
  let draft: string | null;
  let agentName: string;
  let written: string[];
  let signalledInterrupts: string[];
  let context: IpcContext;
  /** The history file's last write, as an epoch time. */
  let lastWriteAt: number;

  function setLastWrite(at: number): void {
    lastWriteAt = at;
    fs.utimesSync(hoisted.historyFile, new Date(at), new Date(at));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stopWorkflowHangCheck();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-hang-check-'));
    hoisted.historyFile = path.join(directory, 'agent-session-1.jsonl');
    fs.writeFileSync(hoisted.historyFile, '{}\n');
    hoisted.running = true;
    hoisted.pendingDelivery = false;
    hoisted.subagentMtime = null;
    hoisted.adapterDeclares = true;
    hoisted.taskSessionId = 'session-1';
    hoisted.subagentReads = 0;
    activity = 'thinking';
    reason = { kind: 'turn-active' };
    draft = null;
    agentName = 'claude';
    written = [];
    setLastWrite(Date.now() - 25 * MINUTE);
    signalledInterrupts = [];
    const session = () => ({
      id: 'session-1',
      taskId: 'task-1',
      projectId: 'project-1',
      status: 'running',
      transient: false,
      workflowId: null,
      agentSessionId: 'agent-session-1',
      cwd: directory,
    });
    context = {
      sessionManager: {
        listSessions: () => [session()],
        getSession: (sessionId: string) => (sessionId === 'session-1' ? session() : undefined),
        getActivityCache: () => ({ 'session-1': activity }),
        getActivityReason: () => reason,
        getSessionAgentName: () => agentName,
        getSessionCliTarget: () => null,
        getReportedTranscriptPath: () => null,
        getPendingDraft: () => draft,
        write: (_sessionId: string, data: string) => { written.push(data); },
        signalUserInterrupt: (sessionId: string) => { signalledInterrupts.push(sessionId); },
      },
      terminalSubmitScheduler: { hasPending: () => false },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    stopWorkflowHangCheck();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('interrupts a turn that has written nothing past the limit, once, and records it', async () => {
    await checkForHungTurns(context);

    expect(written).toEqual(['\x1b']);
    // Told to the engine as a user's Ctrl+C is: an interrupt between tool
    // calls fires no hook, and the turn would stay shown working.
    expect(signalledInterrupts).toEqual(['session-1']);
    expect(hoisted.recordWorkflowInterrupt).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      swimlaneId: 'lane-executing',
      workflowId: 'workflow-1',
      detail: 'The agent wrote nothing for 25 minutes while working, so its turn was interrupted.',
    }));
    // The interrupted turn gets a fresh schedule from recovery.
    expect(hoisted.startOver).toHaveBeenCalledTimes(1);
    expect(hoisted.startOver).toHaveBeenCalledWith(context, { projectId: 'project-1', taskId: 'task-1', workflowId: 'workflow-1', columnId: 'lane-executing' }, expect.objectContaining({ detail: expect.any(String) }));
    // The next tick, before the interrupt could land, writes nothing more.
    await checkForHungTurns(context);
    expect(written).toEqual(['\x1b']);
    expect(hoisted.announce).not.toHaveBeenCalled();
  });

  it('tells the user once when the interrupt does not land: Kangentic cannot reach the agent', async () => {
    await checkForHungTurns(context);
    const interruptedAt = Date.now();

    await checkForHungTurns(context, () => interruptedAt + INTERRUPT_LANDING_MS - 1_000);
    expect(hoisted.announce).not.toHaveBeenCalled();

    await checkForHungTurns(context, () => interruptedAt + INTERRUPT_LANDING_MS + 1_000);
    expect(hoisted.announce).toHaveBeenCalledTimes(1);
    expect(hoisted.announce).toHaveBeenCalledWith(context, expect.objectContaining({
      projectId: 'project-1',
      taskId: 'task-1',
      workflowId: 'workflow-1',
      columnId: 'lane-executing',
      countedNudges: 0,
    }));
    expect((hoisted.announce.mock.calls[0][1] as { reason: string }).reason).toMatch(/^its agent stopped responding: it has written nothing for \d+ minutes, and did not answer an interrupt\.$/);
    // Started over again past the stall row, for an agent that comes back later.
    expect(hoisted.startOver).toHaveBeenCalledTimes(2);
    expect(hoisted.startOver.mock.calls[1][2]).toEqual(expect.objectContaining({ after: expect.any(Date) }));

    await checkForHungTurns(context, () => interruptedAt + 3 * INTERRUPT_LANDING_MS);
    expect(hoisted.announce).toHaveBeenCalledTimes(1);
    expect(written).toEqual(['\x1b']);
  });

  // The engine settles an interrupt it saw no hook for as idle after its own
  // short wait, whether the agent answered or not. Only a write says it did.
  it('tells the user when the engine shows the agent idle after the interrupt but it wrote nothing', async () => {
    await checkForHungTurns(context);
    const interruptedAt = Date.now();
    activity = 'idle';
    reason = { kind: 'idle', since: interruptedAt };

    await checkForHungTurns(context, () => interruptedAt + INTERRUPT_LANDING_MS + 1_000);

    expect(hoisted.announce).toHaveBeenCalledTimes(1);
    expect(written).toEqual(['\x1b']);
  });

  it('never interrupts a session its task has moved off', async () => {
    hoisted.taskSessionId = 'session-2';

    await checkForHungTurns(context);

    expect(written).toEqual([]);
    expect(hoisted.startOver).not.toHaveBeenCalled();
  });

  it('reads no subagent transcript while the main history was written within the limit', async () => {
    setLastWrite(Date.now() - 2 * MINUTE);

    await checkForHungTurns(context);

    expect(hoisted.subagentReads).toBe(0);
    expect(written).toEqual([]);
  });

  it('forgets the interrupt once the agent writes again, so nobody is told', async () => {
    await checkForHungTurns(context);
    setLastWrite(Date.now());

    await checkForHungTurns(context, () => Date.now() + INTERRUPT_LANDING_MS + 1_000);

    expect(hoisted.announce).not.toHaveBeenCalled();
  });

  it('leaves a turn alone that wrote within the limit', async () => {
    setLastWrite(Date.now() - 19 * MINUTE);

    await checkForHungTurns(context);

    expect(written).toEqual([]);
  });

  it('counts a subagent\'s writes, since a fan-out writes to its own files while the main history is quiet', async () => {
    hoisted.subagentMtime = Date.now() - 2 * MINUTE;

    await checkForHungTurns(context);

    expect(written).toEqual([]);
  });

  // A turn that ended with a background shell running stays working while the
  // agent waits for it, writing nothing: the board's gates ran up to 28 minutes.
  it('leaves a session alone that only a background shell holds working', async () => {
    reason = { kind: 'background-shell', count: 1, ids: ['bdrb9enzm'] };

    await checkForHungTurns(context);

    expect(written).toEqual([]);
  });

  it('checks a foreground tool and a subagent still in the turn', async () => {
    reason = { kind: 'tool', pendingCount: 1, currentTool: 'Bash' };
    await checkForHungTurns(context);
    expect(written).toEqual(['\x1b']);

    stopWorkflowHangCheck();
    written = [];
    reason = { kind: 'subagent', depth: 1 };
    await checkForHungTurns(context);
    expect(written).toEqual(['\x1b']);
  });

  it('never writes to a permission prompt or an idle agent', async () => {
    activity = 'permission';
    reason = { kind: 'permission', since: Date.now() };
    await checkForHungTurns(context);

    activity = 'idle';
    reason = { kind: 'idle', since: Date.now() };
    await checkForHungTurns(context);

    expect(written).toEqual([]);
  });

  it('holds while text is typed into the prompt or a message is on its way', async () => {
    draft = 'and also fix the';
    await checkForHungTurns(context);
    expect(written).toEqual([]);

    draft = null;
    hoisted.pendingDelivery = true;
    await checkForHungTurns(context);
    expect(written).toEqual([]);

    hoisted.pendingDelivery = false;
    await checkForHungTurns(context);
    expect(written).toEqual(['\x1b']);
  });

  it('checks only a running workflow task, and only an agent that declares its limit', async () => {
    hoisted.running = false;
    await checkForHungTurns(context);

    hoisted.running = true;
    hoisted.adapterDeclares = false;
    await checkForHungTurns(context);

    hoisted.adapterDeclares = true;
    agentName = 'codex';
    await checkForHungTurns(context);

    expect(written).toEqual([]);
  });
});

describe('Claude\'s hung-turn declaration', () => {
  it('is twice its measured longest healthy quiet, with Esc as the interrupt', async () => {
    const { ClaudeAdapter } = await vi.importActual<typeof import('../../src/main/agent/adapters/claude/claude-adapter')>(
      '../../src/main/agent/adapters/claude/claude-adapter',
    );
    expect(new ClaudeAdapter().hungTurn).toEqual({ quietLimitMs: 20 * MINUTE, interruptKeys: '\x1b' });
  });
});
