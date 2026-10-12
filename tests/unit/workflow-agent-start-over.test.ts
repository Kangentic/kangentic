/**
 * A workflow's own agent starting over (#732, the agent pane's "started a new
 * one" line): when its conversation could not be resumed, main starts a new one,
 * and the summary the pane reads names the session it started over in, until a
 * normal resume or the end of the workflow.
 *
 * The summary carries it, not `WorkflowAgentStatus`, because the start-over
 * happens after the pane's open has answered; a workflow change push is what
 * brings the summary back to the pane, so the start-over sends one.
 *
 * Real, migrated SQLite (better-sqlite3) behind a fake session manager, as in
 * `workflow-agent-spend.test.ts`.
 *
 * The races around a start live here too, since they share the harness: a
 * start-over never replaces a session the user resumed while the dead one's
 * scrollback was read; a Pause pressed in that same window stands for the
 * session the start-over spawns; the end of a workflow waits for an open still in flight
 * and ends what it spawned; and a start reads its workflow again before it
 * spawns, so one deleted or finished while the CLI was being found spawns nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  adapter: null as unknown,
  notifyWorkflowChanged: vi.fn(),
  /** The retrieval worker's `call`, where the agent's turn tokens are indexed from. */
  retrievalCall: vi.fn(async (_method: string, _params: unknown) => ({ outcome: 'indexed' })),
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: () => harness.adapter, list: () => [] } }));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: harness.retrievalCall } }));
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: async (options: { agentPath: string; prompt?: string }) => ({ agentPath: options.agentPath, prompt: options.prompt }),
}));
vi.mock('../../src/main/workflows/workflow-agent-prompt', () => ({ buildWorkflowAgentFirstMessage: () => 'FIRST MESSAGE' }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: harness.notifyWorkflowChanged,
  notifyWorkflowOfTask: vi.fn(),
  setWorkflowChangedWindow: vi.fn(),
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const agent = await import('../../src/main/workflows/workflow-agent');
const agentEffort = await import('../../src/main/workflows/workflow-agent-effort');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { WorkflowAgentStatus } from '../../src/shared/types';

interface FakeSession {
  id: string;
  taskId: string;
  projectId: string;
  pid: number;
  status: string;
  shell: string;
  cwd: string;
  startedAt: string;
  exitCode: number | null;
  resuming: boolean;
  transient: boolean;
  workflowId?: string;
  agentSessionId: string | null;
}

interface SpawnOptions {
  taskId: string;
  projectId: string;
  cwd: string;
  resuming: boolean;
  transient: boolean;
  workflowId: string;
  agentSessionId: string;
}

/** The slice of SessionManager the workflow agent drives. */
class FakeSessionManager extends EventEmitter {
  sessions: FakeSession[] = [];
  private spawnCount = 0;

  suspend = vi.fn(async (sessionId: string) => {
    this.setStatus(sessionId, 'suspended');
  });
  kill = vi.fn((sessionId: string) => {
    this.setStatus(sessionId, 'exited');
  });
  awaitExit = vi.fn(async (_sessionId: string) => undefined);
  remove = vi.fn((sessionId: string) => {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
  });
  getShell = vi.fn(async () => 'bash');
  spawn = vi.fn(async (options: SpawnOptions) => {
    this.spawnCount += 1;
    const session: FakeSession = {
      id: `pty-spawned-${this.spawnCount}`,
      taskId: options.taskId,
      projectId: options.projectId,
      pid: 5000 + this.spawnCount,
      status: 'running',
      shell: 'bash',
      cwd: options.cwd,
      startedAt: '2026-10-04T10:00:00.000Z',
      exitCode: null,
      resuming: options.resuming,
      transient: options.transient,
      workflowId: options.workflowId,
      agentSessionId: options.agentSessionId,
    };
    this.sessions.push(session);
    return session;
  });
  getRawScrollback = vi.fn(async (_sessionId: string) => 'No conversation found with session ID: conv-gone');
  markIdleAuthoritative = vi.fn((_sessionId: string) => undefined);

  listSessions(): FakeSession[] {
    return this.sessions;
  }
  getSession(sessionId: string): FakeSession | undefined {
    return this.sessions.find((session) => session.id === sessionId);
  }
  getUsageCache(): Record<string, unknown> {
    return {};
  }
  getActivityCache(): Record<string, string> {
    return {};
  }
  getSessionAgentName(): string {
    return 'claude';
  }
  getToolCallCount(): number {
    return 0;
  }
  getCompactionCount(): number {
    return 0;
  }

  /** The CLI ends on its own, as one that cannot find the conversation does. */
  exitOnItsOwn(sessionId: string): void {
    this.setStatus(sessionId, 'exited');
    this.emit('exit', sessionId, 1, false);
  }

  private setStatus(sessionId: string, status: string): void {
    const session = this.getSession(sessionId);
    if (session) session.status = status;
  }
}

describe('a workflow\'s own agent starting over', () => {
  let root: string;
  let manager: FakeSessionManager;
  let context: IpcContext;
  let workflowId: string;
  let describeStartupFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-start-over-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    harness.dbs.clear();
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set('home', db);
    harness.notifyWorkflowChanged.mockReset();
    harness.retrievalCall.mockClear();
    describeStartupFailure = vi.fn(() => true);
    harness.adapter = {
      name: 'claude',
      displayName: 'Claude Code',
      sessionType: 'claude_agent',
      supportsReadOnlyLaunch: true,
      supportsCallerSessionId: true,
      supportsReadableDirectories: false,
      detect: vi.fn(async () => ({ found: true, path: '/mock/bin/claude' })),
      ensureTrust: vi.fn(async () => undefined),
      buildCommand: vi.fn(() => 'mock-agent-command'),
      getExitSequence: () => ['\x03'],
      describeStartupFailure,
    };
    const projects = [{ id: 'home', name: 'kangentic', path: home, default_agent: null, default_model: null, default_effort: null }];
    manager = new FakeSessionManager();
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: manager,
      configManager: {
        load: () => ({}),
        getEffectiveConfig: () => ({ mcpServer: { enabled: true }, agent: { cliPaths: {} } }),
      },
      mcpServerHandle: { urlForProject: (projectId: string) => `http://127.0.0.1:9/mcp/${projectId}`, token: 'test-token' },
    } as unknown as IpcContext;
    const repository = new WorkflowRepository(harness.dbs.get('home') as Database.Database);
    workflowId = repository.create({ title: 'Usage budgets' }).id;
    // A conversation the CLI no longer has.
    repository.setAgentConversation(workflowId, { agentName: 'claude', agentSessionId: 'conv-gone', cwd: home });
    agent.registerWorkflowAgentLifecycle(context);
  });

  afterEach(async () => {
    await agent.endWorkflowAgent(context, workflowId);
    vi.restoreAllMocks();
    // After the end: it reads the home database to record the agent's spend.
    for (const database of harness.dbs.values()) (database as Database.Database).close();
    harness.dbs.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Open the pane on the workflow: a resume, which the CLI then cannot honour. */
  async function resumeThatFails(): Promise<string> {
    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});
    expect(status.session?.resuming).toBe(true);
    const resumedId = status.session!.id;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    manager.exitOnItsOwn(resumedId);
    await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(2));
    return resumedId;
  }

  // Found in the preview: `--resume` reloads the conversation with no hooks
  // while its token count grows, the status heartbeat forces that shape to
  // thinking, and the canvas then held every plan edit for the 30 s the
  // stale-thinking watchdog took to clear it ("Workflow agent is working" on an
  // agent whose last turn had ended). A resume that sends no message is idle by
  // contract, so it says so, as the settings-change restart does.
  it('asserts idle on a resume that sends the agent nothing', async () => {
    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

    expect(status.session?.resuming).toBe(true);
    expect(manager.markIdleAuthoritative).toHaveBeenCalledWith(status.session!.id);
  });

  it('asserts nothing on a fresh start, whose first message starts a real turn', async () => {
    await resumeThatFails();

    // The start-over is a new conversation with its first message.
    expect(manager.spawn.mock.calls[1][0].resuming).toBe(false);
    expect(manager.markIdleAuthoritative).not.toHaveBeenCalledWith('pty-spawned-2');
  });

  it('names the session it started over in on the summary, and pushes a change so the pane reads it', async () => {
    await resumeThatFails();

    await vi.waitFor(() => expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId));
    // The new session is a fresh conversation, not another resume.
    expect(manager.spawn.mock.calls[1][0].resuming).toBe(false);
    expect(agent.workflowAgentSummary(context, workflowId)).toMatchObject({ state: 'idle', startedOverSessionId: 'pty-spawned-2' });
  });

  it('keeps saying so while that session is paused', async () => {
    await resumeThatFails();
    await vi.waitFor(() => expect(harness.notifyWorkflowChanged).toHaveBeenCalled());

    await agent.pauseWorkflowAgent(context, workflowId);

    expect(agent.workflowAgentSummary(context, workflowId)).toMatchObject({ state: 'paused', startedOverSessionId: 'pty-spawned-2' });
  });

  it('stops saying so when the agent next resumes normally', async () => {
    await resumeThatFails();
    await vi.waitFor(() => expect(harness.notifyWorkflowChanged).toHaveBeenCalled());
    await agent.pauseWorkflowAgent(context, workflowId);

    const status = await agent.resumeWorkflowAgent(context, 'home', workflowId, {});

    expect(status.session?.resuming).toBe(true);
    // The fake keeps the paused row beside the resumed one, and the summary
    // reads it first: what clears it is the resume forgetting the start-over,
    // not only the new session's new id.
    expect(agent.workflowAgentSummary(context, workflowId)).toMatchObject({ state: 'paused', startedOverSessionId: null });
  });

  it('says nothing when the resume ended for another reason, and starts nothing', async () => {
    describeStartupFailure.mockReturnValue(false);
    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});
    manager.exitOnItsOwn(status.session!.id);
    await vi.waitFor(() => expect(manager.getRawScrollback).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(agent.workflowAgentSummary(context, workflowId)).toBeNull();
  });

  it('forgets it with the workflow\'s end', async () => {
    await resumeThatFails();
    await vi.waitFor(() => expect(harness.notifyWorkflowChanged).toHaveBeenCalled());
    const startedOver = { ...manager.getSession('pty-spawned-2')! };

    await agent.endWorkflowAgent(context, workflowId);
    // The same row registered again names nothing: the end forgot the start-over.
    manager.sessions.push({ ...startedOver, status: 'running' });

    expect(agent.workflowAgentSummary(context, workflowId)?.startedOverSessionId).toBeNull();
  });

  it('does not start over when the user resumed the agent while the dead session\'s scrollback was being read', async () => {
    const resumed = await agent.openWorkflowAgent(context, 'home', workflowId, {});
    let finishScrollback!: () => void;
    const scrollbackGate = new Promise<void>((resolve) => {
      finishScrollback = resolve;
    });
    manager.getRawScrollback.mockImplementationOnce(async () => {
      await scrollbackGate;
      return 'No conversation found with session ID: conv-gone';
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    manager.exitOnItsOwn(resumed.session!.id);
    await vi.waitFor(() => expect(manager.getRawScrollback).toHaveBeenCalledTimes(1));

    // The user presses Resume while the last words are still being read.
    const userResume = await agent.resumeWorkflowAgent(context, 'home', workflowId, {});
    expect(userResume.session?.id).toBe('pty-spawned-2');

    finishScrollback();
    await vi.waitFor(() => expect(describeStartupFailure).toHaveBeenCalledTimes(1));
    // The start-over, were it not skipped, spawns through microtasks only: one macrotask lets it run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.spawn).toHaveBeenCalledTimes(2);
    expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(agent.workflowAgentSummary(context, workflowId)).toMatchObject({ state: 'idle', startedOverSessionId: null });
    // The conversation the user resumed is still the workflow's.
    expect(new WorkflowRepository(harness.dbs.get('home') as Database.Database).getById(workflowId)!.agent_session_id).toBe('conv-gone');
  });

  it('suspends the session it starts over in when the user paused while the dead one\'s scrollback was being read', async () => {
    const resumed = await agent.openWorkflowAgent(context, 'home', workflowId, {});
    let finishScrollback!: () => void;
    const scrollbackGate = new Promise<void>((resolve) => {
      finishScrollback = resolve;
    });
    manager.getRawScrollback.mockImplementationOnce(async () => {
      await scrollbackGate;
      return 'No conversation found with session ID: conv-gone';
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    manager.exitOnItsOwn(resumed.session!.id);
    await vi.waitFor(() => expect(manager.getRawScrollback).toHaveBeenCalledTimes(1));

    // The resumed session has exited and the start-over has not spawned: the
    // Pause finds no live agent to stop, and only records itself.
    await agent.pauseWorkflowAgent(context, workflowId);
    expect(manager.suspend).not.toHaveBeenCalled();
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    finishScrollback();
    await vi.waitFor(() => expect(manager.suspend).toHaveBeenCalledWith('pty-spawned-2'));
    // The summary names the start-over after this push.
    await vi.waitFor(() => expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId));

    expect(manager.spawn).toHaveBeenCalledTimes(2);
    expect(manager.suspend).toHaveBeenCalledTimes(1);
    expect(manager.getSession('pty-spawned-2')?.status).toBe('suspended');
    expect(agent.workflowAgentSummary(context, workflowId)).toMatchObject({ state: 'paused', startedOverSessionId: 'pty-spawned-2' });
  });

  describe('the end of a workflow while its agent is still opening', () => {
    /**
     * Open the agent with its spawn held, and return the open and the way to let
     * the spawn finish. Until it does, no session exists to find.
     */
    async function openWithSpawnHeld(): Promise<{ opened: Promise<WorkflowAgentStatus>; finishSpawn: () => void }> {
      let finishSpawn!: () => void;
      const spawnGate = new Promise<void>((resolve) => {
        finishSpawn = resolve;
      });
      const spawnImmediately = manager.spawn.getMockImplementation()!;
      manager.spawn.mockImplementationOnce(async (options: SpawnOptions) => {
        await spawnGate;
        return spawnImmediately(options);
      });
      const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1));
      return { opened, finishSpawn };
    }

    it('ends the session the open spawns, rather than leaving it running', async () => {
      const { opened, finishSpawn } = await openWithSpawnHeld();

      // The end arrives while the open still waits on its spawn: no session exists to find.
      const ended = agent.endWorkflowAgent(context, workflowId);
      finishSpawn();
      const [status] = await Promise.all([opened, ended]);

      expect(status.session?.id).toBe('pty-spawned-1');
      expect(manager.kill).toHaveBeenCalledWith('pty-spawned-1');
      expect(manager.remove).toHaveBeenCalledWith('pty-spawned-1');
      expect(manager.sessions).toEqual([]);
    });

    it('is the end of its project too: the project\'s delete ends an agent still opening in it', async () => {
      const { opened, finishSpawn } = await openWithSpawnHeld();

      // No session of the project's lists a workflow yet, so only the open in flight names it.
      const ended = agent.endWorkflowAgentsOfProject(context, 'home');
      finishSpawn();
      const [status] = await Promise.all([opened, ended]);

      expect(status.session?.id).toBe('pty-spawned-1');
      expect(manager.kill).toHaveBeenCalledWith('pty-spawned-1');
      expect(manager.remove).toHaveBeenCalledWith('pty-spawned-1');
      expect(manager.sessions).toEqual([]);
    });

    it('leaves an agent opening in another project alone when a project is deleted (the control)', async () => {
      const { opened, finishSpawn } = await openWithSpawnHeld();

      const ended = agent.endWorkflowAgentsOfProject(context, 'another-project');
      finishSpawn();
      const [status] = await Promise.all([opened, ended]);

      expect(status.session?.id).toBe('pty-spawned-1');
      expect(manager.kill).not.toHaveBeenCalled();
      expect(manager.remove).not.toHaveBeenCalled();
      expect(manager.sessions.map((session) => session.id)).toEqual(['pty-spawned-1']);
    });
  });

  describe('the effort a start replaces', () => {
    it('is forgotten with the session the start replaces, and kept for the new one', async () => {
      // The project's effort tier is what the agent starts with, and what Stats reads back.
      (context.projectRepo.getById('home') as unknown as { default_effort: string }).default_effort = 'high';
      const first = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      expect(agentEffort.workflowAgentEffort(first.session!.id)).toBe('high');

      // Pause, then Resume: the resume spawns a new session and replaces the paused one.
      await agent.pauseWorkflowAgent(context, workflowId);
      const second = await agent.resumeWorkflowAgent(context, 'home', workflowId, {});

      expect(second.session!.id).not.toBe(first.session!.id);
      expect(agentEffort.workflowAgentEffort(first.session!.id)).toBeNull();
      expect(agentEffort.workflowAgentEffort(second.session!.id)).toBe('high');
      // Ids repeat across tests (one fake manager each), so leave none behind.
      agentEffort.forgetWorkflowAgentEffort(second.session!.id);
    });
  });

  describe('the idle auto-suspend', () => {
    it('records a workflow agent\'s turn tokens and tells the pane it is paused', async () => {
      const opened = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      const session = opened.session!;
      harness.retrievalCall.mockClear();
      harness.notifyWorkflowChanged.mockClear();

      manager.emit('idle-timeout', session.id, workflowId, 5);

      expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
      expect(harness.retrievalCall).toHaveBeenCalledWith('index.workflowAgentTurns', expect.objectContaining({
        projectId: 'home',
        sessionId: session.id,
        agentSessionId: 'conv-gone',
        sessionType: 'claude_agent',
        cwd: session.cwd,
      }));
      expect(harness.notifyWorkflowChanged).toHaveBeenCalledTimes(1);
      expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId);
    });

    it('does nothing for a task\'s session (the control)', () => {
      // A task's session: no workflow id, but everything else the agent's has.
      manager.sessions.push({
        id: 'task-session',
        taskId: 'task-1',
        projectId: 'home',
        pid: 6001,
        status: 'running',
        shell: 'bash',
        cwd: root,
        startedAt: '2026-10-04T10:00:00.000Z',
        exitCode: null,
        resuming: false,
        transient: false,
        agentSessionId: 'task-agent-session',
      });

      manager.emit('idle-timeout', 'task-session', 'task-1', 5);

      expect(harness.retrievalCall).not.toHaveBeenCalled();
      expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
    });
  });

  describe('a start whose workflow went while the CLI was being found', () => {
    const changes: Array<{ name: string; change: (context: IpcContext) => void }> = [
      { name: 'was deleted', change: () => new WorkflowRepository(harness.dbs.get('home') as Database.Database).delete(workflowId) },
      { name: 'finished', change: () => new WorkflowRepository(harness.dbs.get('home') as Database.Database).setState(workflowId, 'done') },
      { name: 'lost its project', change: (target) => { vi.spyOn(target.projectRepo, 'getById').mockReturnValue(undefined); } },
    ];

    it.each(changes)('spawns nothing and says the workflow is gone when it $name', async ({ change }) => {
      let finishDetect!: () => void;
      const detectGate = new Promise<void>((resolve) => {
        finishDetect = resolve;
      });
      const detect = (harness.adapter as { detect: ReturnType<typeof vi.fn> }).detect;
      detect.mockImplementationOnce(async () => {
        await detectGate;
        return { found: true, path: '/mock/bin/claude' };
      });
      const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
      await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1));

      change(context);
      finishDetect();
      const status = await opened;

      expect(status).toEqual({ session: null, unavailable: 'This workflow no longer exists.' });
      expect(manager.spawn).not.toHaveBeenCalled();
    });
  });
});
