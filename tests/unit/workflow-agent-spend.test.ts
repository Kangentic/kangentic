/**
 * A workflow's own agent on real, migrated SQLite (#732): where its spend goes,
 * and what a start records about its conversation.
 *
 * Spend. The agent has no `sessions` row, so its cost reaches Stats only through
 * a `usage_history` row written under its PTY session id. A stop clears the
 * session manager's live usage, so every stop that Kangentic makes (Pause, a
 * Pause that a start finds out about once its agent is spawned, a restart for
 * new checkouts, the end of the workflow) has to write that row first, and a
 * stop the CLI makes (its exit) writes it from the exit listener.
 * The agent-absence sweep is the third: it emits `agent-absent`, then kills the
 * session, so its exit arrives intentional and the exit listener skips it; the
 * `agent-absent` edge writes the spend instead.
 * The fake session manager clears the live usage on suspend, kill and remove as
 * the real one does, which is what makes "before" observable: a capture that ran
 * after the stop finds nothing to write and leaves no row.
 *
 * Turns. Alongside the spend row, every capture asks the retrieval worker to
 * write the conversation's turns to the token ledger (`index.workflowAgentTurns`),
 * fire and forget: a rejection is logged and never breaks the stop. A live
 * session with no conversation id of its own is filed under the one its workflow
 * records, and under nothing when the row has none either.
 *
 * Start. Every start records the conversation on the workflow row, resumes
 * included, so a row from before `agent_cwd` existed gains its checkout the next
 * time it is resumed, and keeps the conversation id it resumes by. It also
 * records the effort the agent started with (until its session is removed), and
 * spawns at the size the pane last had: a measured grid wins, then the grid
 * recorded on the workflow row, then this run's last start.
 *
 * Restart for new checkouts. The restart runs through the whole start, so what
 * it tells the new agent is observable on the command it built:
 * - a Pause pressed with no agent to stop, or for one since gone, is not the
 *   next agent's, so a pane open that starts one clears it and a request for
 *   another checkout still restarts that agent;
 * - when the restart's suspend fails, the older grant it carried never
 *   overwrites a newer one a request stored while it was stopping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>(), adapter: null as unknown, retrievalCall: vi.fn() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
// The agent CLI itself is out of reach of a unit test: the registry hands back a
// fake adapter that is found, launches read-only, and builds a fixed command.
// `list` is what the real remote-targets collector walks, with no remote servers.
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: () => harness.adapter, list: () => [] } }));
// The retrieval worker is another process: the agent's turn recording is a call to it.
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: harness.retrievalCall } }));
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: async (options: { agentPath: string; prompt?: string }) => ({ agentPath: options.agentPath, prompt: options.prompt }),
}));
// Every fresh start asks for the saved-plan message first; these workflows have no plan saved.
vi.mock('../../src/main/workflows/workflow-agent-prompt', () => ({
  buildWorkflowAgentFirstMessage: () => 'FIRST MESSAGE',
  buildWorkflowAgentContinueMessage: async () => null,
}));
// The cached agent inventory the Workflow agent setting is checked against.
vi.mock('../../src/main/agent/agent-list', () => ({
  listAgents: async () => [{ name: 'claude', found: true, supportsWorkflowAgent: true, capabilities: { supportsModelOverride: true } }],
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const agent = await import('../../src/main/workflows/workflow-agent');
const { workflowAgentEffort, forgetWorkflowAgentEffort } = await import('../../src/main/workflows/workflow-agent-effort');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

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

interface FakeUsage {
  cost: { totalCostUsd: number; totalDurationMs: number };
  contextWindow: { totalInputTokens: number; totalOutputTokens: number };
  model: { id: string; displayName: string; effort: string | null };
}

interface LedgerRow {
  session_record_id: string;
  conversation_id: string | null;
  total_cost_usd: number;
  total_input_tokens: number;
  agent: string | null;
  session_type: string | null;
}

interface SpawnOptions {
  taskId: string;
  projectId: string;
  cwd: string;
  resuming: boolean;
  transient: boolean;
  workflowId: string;
  agentSessionId: string;
  cols?: number;
  rows?: number;
}

const LIVE_USAGE: FakeUsage = {
  cost: { totalCostUsd: 1.5, totalDurationMs: 90_000 },
  contextWindow: { totalInputTokens: 1_000, totalOutputTokens: 200 },
  model: { id: 'model-a', displayName: 'Model A', effort: null },
};

/** The slice of SessionManager the workflow agent drives, with the real manager's habit of dropping live usage on a stop. */
class FakeSessionManager extends EventEmitter {
  sessions: FakeSession[] = [];
  usageCache: Record<string, FakeUsage> = {};
  activity: Record<string, string> = {};
  private spawnCount = 0;

  suspend = vi.fn(async (sessionId: string) => {
    this.stop(sessionId, 'suspended');
  });
  kill = vi.fn((sessionId: string) => {
    this.stop(sessionId, 'exited');
  });
  awaitExit = vi.fn(async (_sessionId: string) => undefined);
  remove = vi.fn((sessionId: string) => {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    delete this.usageCache[sessionId];
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
      startedAt: '2026-09-02T10:00:00.000Z',
      exitCode: null,
      resuming: options.resuming,
      transient: options.transient,
      workflowId: options.workflowId,
      agentSessionId: options.agentSessionId,
    };
    this.sessions.push(session);
    return session;
  });

  listSessions(): FakeSession[] {
    return this.sessions;
  }
  getSession(sessionId: string): FakeSession | undefined {
    return this.sessions.find((session) => session.id === sessionId);
  }
  getUsageCache(): Record<string, FakeUsage> {
    return this.usageCache;
  }
  getReportedTranscriptPath(): string | null {
    return null;
  }
  getActivityCache(): Record<string, string> {
    return this.activity;
  }
  getSessionAgentName(): string {
    return 'claude';
  }
  getSessionCliTarget(): null {
    return null;
  }
  getToolCallCount(): number {
    return 4;
  }
  getCompactionCount(): number {
    return 1;
  }
  getRawScrollback = vi.fn(async (_sessionId: string) => '');
  markIdleAuthoritative = vi.fn((_sessionId: string) => undefined);

  private stop(sessionId: string, status: string): void {
    delete this.usageCache[sessionId];
    const session = this.getSession(sessionId);
    if (session) session.status = status;
  }
}

describe('a workflow\'s own agent: spend and conversation', () => {
  let root: string;
  let paths: Record<string, string>;
  let manager: FakeSessionManager;
  let context: IpcContext;
  let workflowId: string;
  let projects: Array<{ id: string; name: string; path: string; default_agent: null; default_model: null; default_effort: string | null }>;
  /** Settings > Workflows > Workflow agent, which every start reads. */
  let workflowAgentSetting: { agent: string; model: string; effort: string | null };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-spend-'));
    workflowAgentSetting = { agent: 'claude', model: 'haiku', effort: null };
    paths = { home: path.join(root, 'home'), mobile: path.join(root, 'mobile'), relay: path.join(root, 'relay') };
    for (const checkout of Object.values(paths)) fs.mkdirSync(checkout);
    harness.dbs.clear();
    for (const projectId of ['home', 'mobile']) {
      const db = openTestDatabase();
      db.exec('PRAGMA foreign_keys = ON');
      runProjectMigrations(db);
      harness.dbs.set(projectId, db);
    }
    harness.adapter = {
      name: 'claude',
      displayName: 'Claude Code',
      sessionType: 'claude_agent',
      kangenticMcp: 'per-session',
      supportsReadOnlyLaunch: true,
      supportsCallerSessionId: true,
      resumePromptDelivery: 'command-line',
      supportsReadableDirectories: true,
      detect: vi.fn(async () => ({ found: true, path: '/mock/bin/claude' })),
      ensureTrust: vi.fn(async () => undefined),
      buildCommand: vi.fn(() => 'mock-agent-command'),
      getExitSequence: () => ['\x03'],
    };
    projects = [
      { id: 'home', name: 'kangentic', path: paths.home, default_agent: null, default_model: null, default_effort: null as string | null },
      { id: 'mobile', name: 'kangentic-mobile', path: paths.mobile, default_agent: null, default_model: null, default_effort: null as string | null },
      { id: 'relay', name: 'kangentic-relay', path: paths.relay, default_agent: null, default_model: null, default_effort: null as string | null },
    ];
    harness.retrievalCall.mockReset();
    harness.retrievalCall.mockResolvedValue({ outcome: 'indexed' });
    manager = new FakeSessionManager();
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: manager,
      configManager: {
        load: () => ({}),
        getEffectiveConfig: () => ({ mcpServer: { enabled: true }, agent: { cliPaths: {} }, workflows: workflowAgentSetting }),
      },
      mcpServerHandle: { urlForProject: (projectId: string) => `http://127.0.0.1:9/mcp/${projectId}`, token: 'test-token' },
    } as unknown as IpcContext;
    workflowId = new WorkflowRepository(homeDb()).create({ title: 'Usage budgets' }).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const homeDb = () => harness.dbs.get('home') as Database.Database;
  const readWorkflow = () => new WorkflowRepository(homeDb()).getById(workflowId)!;

  function ledgerRows(sessionId: string, projectId = 'home'): LedgerRow[] {
    const db = harness.dbs.get(projectId) as Database.Database;
    return db.prepare(`
      SELECT session_record_id, conversation_id, total_cost_usd, total_input_tokens, agent, session_type
        FROM usage_history WHERE session_record_id = ?
    `).all(sessionId) as unknown as LedgerRow[];
  }

  /** The agent's session, running, with spend on the meter. */
  function addAgentSession(overrides: Partial<FakeSession> = {}): FakeSession {
    const session: FakeSession = {
      id: 'pty-agent',
      taskId: workflowId,
      projectId: 'home',
      pid: 4242,
      status: 'running',
      shell: 'bash',
      cwd: paths.home,
      startedAt: '2026-09-01T10:00:00.000Z',
      exitCode: null,
      resuming: false,
      transient: true,
      workflowId,
      agentSessionId: 'conv-1',
      ...overrides,
    };
    manager.sessions.push(session);
    manager.usageCache[session.id] = LIVE_USAGE;
    return session;
  }

  function expectBookedOnce(sessionId: string, conversationId = 'conv-1'): void {
    const rows = ledgerRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe(conversationId);
    expect(rows[0].total_cost_usd).toBe(1.5);
    expect(rows[0].total_input_tokens).toBe(1_000);
    expect(rows[0].agent).toBe('claude');
    expect(rows[0].session_type).toBe('claude_agent');
  }

  describe('spend reaches the home project\'s ledger', () => {
    it('on Pause, before the suspend drops the live usage', async () => {
      addAgentSession();

      await agent.pauseWorkflowAgent(context, workflowId);

      expect(manager.suspend).toHaveBeenCalledWith('pty-agent');
      expectBookedOnce('pty-agent');
      // Another project's ledger is not the agent's.
      expect(ledgerRows('pty-agent', 'mobile')).toHaveLength(0);
    });

    it('on the end of the workflow, before the kill and the removal drop the live usage', async () => {
      addAgentSession();

      await agent.endWorkflowAgent(context, workflowId);

      expect(manager.kill).toHaveBeenCalledWith('pty-agent');
      expect(manager.remove).toHaveBeenCalledWith('pty-agent');
      expectBookedOnce('pty-agent');
    });

    it('on a restart for new checkouts, before the suspend drops the live usage', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      addAgentSession();
      // Recorded, as the agent's start leaves it: the restart resumes by it.
      new WorkflowRepository(homeDb()).setAgentConversation(workflowId, { agentName: 'claude', agentSessionId: 'conv-1', cwd: paths.home });
      manager.activity['pty-agent'] = 'idle';

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
      await vi.waitFor(() => expect(manager.suspend).toHaveBeenCalledWith('pty-agent'));
      expectBookedOnce('pty-agent');

      // Let the restart finish its start, so nothing runs on past the test: the
      // spawn is its last awaited step, and a macrotask turn drains what follows.
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('on a Pause pressed while the agent was spawning, before the suspend of the new agent drops the live usage', async () => {
      // A conversation to resume, so the row books under the id `expectBookedOnce` reads.
      new WorkflowRepository(homeDb()).setAgentConversation(workflowId, { agentName: 'claude', agentSessionId: 'conv-1', cwd: paths.home });
      let finishSpawn!: () => void;
      const spawnGate = new Promise<void>((resolve) => {
        finishSpawn = resolve;
      });
      const spawnImmediately = manager.spawn.getMockImplementation()!;
      manager.spawn.mockImplementationOnce(async (options: SpawnOptions) => {
        await spawnGate;
        const spawned = await spawnImmediately(options);
        // The new agent has spend on the meter from the moment it exists.
        manager.usageCache[spawned.id] = LIVE_USAGE;
        return spawned;
      });

      const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1));
      // No row exists yet, so the Pause finds no agent to stop and books nothing itself.
      await agent.pauseWorkflowAgent(context, workflowId);
      expect(manager.suspend).not.toHaveBeenCalled();
      expect(ledgerRows('pty-spawned-1')).toHaveLength(0);

      finishSpawn();
      await opened;

      // The start suspended the agent the Pause reached, and booked its spend first.
      expect(manager.suspend).toHaveBeenCalledWith('pty-spawned-1');
      expectBookedOnce('pty-spawned-1');
    });

    it('when the CLI exits on its own, from the exit listener', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      manager.emit('exit', 'pty-agent', 1, false);

      expectBookedOnce('pty-agent');
    });

    it('when an exit arrives with no intentional flag, as a spawn failure does', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      manager.emit('exit', 'pty-agent', 1);

      expectBookedOnce('pty-agent');
    });

    it('not from the exit listener when Kangentic asked for the exit: the stop that asked captured it first', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      manager.emit('exit', 'pty-agent', 0, true);

      expect(ledgerRows('pty-agent')).toHaveLength(0);
    });

    it('when the sweep retires an agent whose CLI is gone: captured at the agent-absent edge, since the intentional exit after it skips it', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      // The sweep emits agent-absent, then kills the session (which drops its live usage), and the exit arrives intentional.
      manager.emit('agent-absent', 'pty-agent');
      manager.kill('pty-agent');
      manager.emit('exit', 'pty-agent', 0, true);

      expectBookedOnce('pty-agent');
    });

    it('not for a task\'s session, which has a sessions row and its own writer', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession({ id: 'pty-task', taskId: 'task-1', workflowId: undefined, transient: false });

      manager.emit('exit', 'pty-task', 1, false);

      expect(ledgerRows('pty-task')).toHaveLength(0);
    });

    it('not for a task\'s session the sweep retires either, which has its own writer', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession({ id: 'pty-task', taskId: 'task-1', workflowId: undefined, transient: false });

      manager.emit('agent-absent', 'pty-task');

      expect(ledgerRows('pty-task')).toHaveLength(0);
    });

    it('and a project database that will not open breaks neither Pause nor the end', async () => {
      // The session names a project with no database: the lookup throws in
      // captureSpend's own argument list, outside the capture's try.
      addAgentSession({ projectId: 'ghost' });

      await expect(agent.pauseWorkflowAgent(context, workflowId)).resolves.toBeUndefined();
      expect(manager.suspend).toHaveBeenCalledWith('pty-agent');

      await expect(agent.endWorkflowAgent(context, workflowId)).resolves.toBeUndefined();
      expect(manager.kill).toHaveBeenCalledWith('pty-agent');
      expect(manager.remove).toHaveBeenCalledWith('pty-agent');
    });
  });

  const TURNS_CALL = (cwd: string, conversationId = 'conv-1') => ['index.workflowAgentTurns', {
    projectId: 'home',
    sessionId: 'pty-agent',
    agentSessionId: conversationId,
    sessionType: 'claude_agent',
    cwd,
    // The agent's CLI runs on this machine.
    cliTarget: null,
    // Its status line has reported no transcript path.
    transcriptPath: null,
    remoteTargets: [],
  }];

  describe('its turns reach the token ledger through the retrieval worker', () => {
    it('on Pause, with the session\'s project, id, conversation, session type and checkout', async () => {
      addAgentSession();

      await agent.pauseWorkflowAgent(context, workflowId);

      expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
      expect(harness.retrievalCall.mock.calls[0]).toEqual(TURNS_CALL(paths.home));
    });

    it('on the end of the workflow', async () => {
      addAgentSession();

      await agent.endWorkflowAgent(context, workflowId);

      expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
      expect(harness.retrievalCall.mock.calls[0]).toEqual(TURNS_CALL(paths.home));
    });

    it('when the CLI exits on its own', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      manager.emit('exit', 'pty-agent', 1, false);

      expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
      expect(harness.retrievalCall.mock.calls[0]).toEqual(TURNS_CALL(paths.home));
    });

    it('not for a stop Kangentic asked for from the exit listener, whose own stop already asked', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      manager.emit('exit', 'pty-agent', 0, true);

      expect(harness.retrievalCall).not.toHaveBeenCalled();
    });

    it('when the sweep retires an agent whose CLI is gone, at the agent-absent edge', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession();

      manager.emit('agent-absent', 'pty-agent');
      manager.kill('pty-agent');
      // The exit that follows is intentional, so it asks for nothing more.
      manager.emit('exit', 'pty-agent', 0, true);

      expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
      expect(harness.retrievalCall.mock.calls[0]).toEqual(TURNS_CALL(paths.home));
    });

    it('not for a task\'s session, which the conversation indexer already records', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession({ id: 'pty-task', taskId: 'task-1', workflowId: undefined, transient: false });

      manager.emit('exit', 'pty-task', 1, false);

      expect(harness.retrievalCall).not.toHaveBeenCalled();
    });

    it('not for a task\'s session the sweep retires either', () => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession({ id: 'pty-task', taskId: 'task-1', workflowId: undefined, transient: false });

      manager.emit('agent-absent', 'pty-task');

      expect(harness.retrievalCall).not.toHaveBeenCalled();
    });

    it('not for a session with no conversation id to read the transcript by', async () => {
      addAgentSession({ agentSessionId: null });

      await agent.pauseWorkflowAgent(context, workflowId);

      expect(harness.retrievalCall).not.toHaveBeenCalled();
      expect(manager.suspend).toHaveBeenCalledWith('pty-agent');
    });

    it('logs a rejection and breaks neither Pause nor the end', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      harness.retrievalCall.mockRejectedValue(new Error('The retrieval worker is restarting.'));
      addAgentSession();

      await expect(agent.pauseWorkflowAgent(context, workflowId)).resolves.toBeUndefined();

      expect(manager.suspend).toHaveBeenCalledWith('pty-agent');
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(String(warn.mock.calls[0][0])).toContain('pty-agen');
      expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({ message: 'The retrieval worker is restarting.' }));
    });
  });

  // A resumed agent whose CLI chose its own id may not report it again on that
  // run, which leaves the live session's id empty while its workflow still
  // records the conversation. The stop files the spend and the turns under the
  // recorded id; with none recorded either, there is no lineage to file under.
  describe('a stop of a session that has no conversation id of its own', () => {
    const stops: Array<{ name: string; stop: () => Promise<void> | void }> = [
      { name: 'Pause', stop: () => agent.pauseWorkflowAgent(context, workflowId) },
      { name: 'an exit the CLI made', stop: () => { manager.emit('exit', 'pty-agent', 1, false); } },
    ];

    function recordConversation(agentSessionId: string | null): void {
      new WorkflowRepository(homeDb()).setAgentConversation(workflowId, { agentName: 'claude', agentSessionId, cwd: paths.home });
    }

    it.each(stops)('files the spend and the turns under the workflow\'s recorded conversation on $name', async ({ stop }) => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession({ agentSessionId: null });
      recordConversation('conv-x');

      await stop();

      expectBookedOnce('pty-agent', 'conv-x');
      expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
      expect(harness.retrievalCall.mock.calls[0]).toEqual(TURNS_CALL(paths.home, 'conv-x'));
    });

    // The control: an agent that ran but whose id is not recorded (never captured,
    // or forgotten for a start-over) is not filed under any conversation.
    it.each(stops)('files nothing and asks for no turns when the workflow records no conversation id either, on $name', async ({ stop }) => {
      agent.registerWorkflowAgentLifecycle(context);
      addAgentSession({ agentSessionId: null });
      recordConversation(null);

      await stop();

      expect(ledgerRows('pty-agent')).toHaveLength(0);
      expect(harness.retrievalCall).not.toHaveBeenCalled();
    });
  });

  describe('a start records the conversation', () => {
    function spawnOptions(): SpawnOptions {
      return manager.spawn.mock.calls[0][0];
    }

    it('on a fresh start: the agent, a new conversation id and the checkout it ran in', async () => {
      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status.unavailable).toBeNull();
      expect(spawnOptions().resuming).toBe(false);
      const workflow = readWorkflow();
      expect(workflow.agent_name).toBe('claude');
      expect(workflow.agent_session_id).toBeTruthy();
      expect(workflow.agent_session_id).toBe(spawnOptions().agentSessionId);
      expect(workflow.agent_cwd).toBe(paths.home);
    });

    it('on a resume too: a row with no checkout recorded gains it and keeps its conversation id', async () => {
      // A conversation from before `agent_cwd` existed.
      homeDb()
        .prepare('UPDATE workflows SET agent_name = ?, agent_session_id = ?, agent_cwd = NULL WHERE id = ?')
        .run('claude', 'conv-old', workflowId);
      expect(readWorkflow().agent_cwd).toBeNull();

      const status = await agent.resumeWorkflowAgent(context, 'home', workflowId, {});

      expect(status.unavailable).toBeNull();
      expect(spawnOptions()).toMatchObject({ resuming: true, agentSessionId: 'conv-old', cwd: paths.home, workflowId });
      const workflow = readWorkflow();
      expect(workflow.agent_session_id).toBe('conv-old');
      expect(workflow.agent_name).toBe('claude');
      expect(workflow.agent_cwd).toBe(paths.home);
    });

    describe('and the effort it started with, for Stats', () => {
      afterEach(() => {
        forgetWorkflowAgentEffort('pty-spawned-1');
      });

      it('is the Workflow agent\'s effort, kept under the new session\'s id', async () => {
        workflowAgentSetting.effort = 'high';

        await agent.openWorkflowAgent(context, 'home', workflowId, {});

        expect(workflowAgentEffort('pty-spawned-1')).toBe('high');
      });

      it('is null when the Workflow agent runs at the CLI\'s own effort, whatever the project\'s default', async () => {
        projects[0].default_effort = 'xhigh';
        await agent.openWorkflowAgent(context, 'home', workflowId, {});

        expect(workflowAgentEffort('pty-spawned-1')).toBeNull();
      });

      it('is dropped when the session is removed', async () => {
        agent.registerWorkflowAgentLifecycle(context);
        workflowAgentSetting.effort = 'high';
        await agent.openWorkflowAgent(context, 'home', workflowId, {});
        expect(workflowAgentEffort('pty-spawned-1')).toBe('high');

        manager.emit('session-removed', 'pty-spawned-1');

        expect(workflowAgentEffort('pty-spawned-1')).toBeNull();
      });
    });
  });

  describe('a start draws its first frame at the size the pane last had', () => {    const lastSpawn = (): SpawnOptions => manager.spawn.mock.calls[manager.spawn.mock.calls.length - 1][0];

    /** Pause the running agent and resume it with no grid measured, as a restart's start does. */
    async function restartWithoutGrid(): Promise<SpawnOptions> {
      await agent.pauseWorkflowAgent(context, workflowId);
      await agent.resumeWorkflowAgent(context, 'home', workflowId, {});
      return lastSpawn();
    }

    it('spawns at the grid recorded on the workflow when none is passed, as after a restart of the app', async () => {
      new WorkflowRepository(homeDb()).setAgentGrid(workflowId, { cols: 150, rows: 50 });

      await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(lastSpawn()).toMatchObject({ cols: 150, rows: 50 });
    });

    it('lets a grid the pane measured win over the one recorded', async () => {
      new WorkflowRepository(homeDb()).setAgentGrid(workflowId, { cols: 150, rows: 50 });

      await agent.openWorkflowAgent(context, 'home', workflowId, { cols: 90, rows: 20 });

      expect(lastSpawn()).toMatchObject({ cols: 90, rows: 20 });
    });

    it('prefers the recorded grid to this run\'s last start once the pane has been resized since', async () => {
      await agent.openWorkflowAgent(context, 'home', workflowId, { cols: 100, rows: 40 });
      // The pane was resized after that start: the resize listener recorded it.
      new WorkflowRepository(homeDb()).setAgentGrid(workflowId, { cols: 150, rows: 50 });

      const restarted = await restartWithoutGrid();

      expect(restarted).toMatchObject({ cols: 150, rows: 50 });
    });

    it('falls back to this run\'s last start grid when the workflow has none recorded', async () => {
      await agent.openWorkflowAgent(context, 'home', workflowId, { cols: 100, rows: 40 });

      const restarted = await restartWithoutGrid();

      expect(manager.spawn).toHaveBeenCalledTimes(2);
      expect(restarted).toMatchObject({ cols: 100, rows: 40 });
    });

    it('spawns with no size when nothing has recorded one', async () => {
      await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(lastSpawn().cols).toBeUndefined();
      expect(lastSpawn().rows).toBeUndefined();
    });
  });

  describe('the restart for new checkouts', () => {
    interface BuiltCommand {
      prompt?: string;
      resume: boolean;
      readableDirectories: string[];
    }

    beforeEach(() => {
      // The lifecycle's activity listener is what restarts an agent at its next idle.
      agent.registerWorkflowAgentLifecycle(context);
    });

    /** The options the nth start (0 is the first) built its command from. */
    function builtCommand(startIndex: number): BuiltCommand {
      return (harness.adapter as { buildCommand: ReturnType<typeof vi.fn> }).buildCommand.mock.calls[startIndex][0];
    }

    /** The pane's open starts the agent; it is then idle, the state a restart for a new checkout needs. */
    async function openIdleAgent(): Promise<string> {
      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      if (!status.session) throw new Error(`The agent did not start: ${status.unavailable}`);
      manager.activity[status.session.id] = 'idle';
      return status.session.id;
    }

    /** A macrotask turn: a restart runs one turn after the edge or request that queued it. */
    const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

    /** Asking an idle agent for the mobile checkout stops it and starts it again, on its conversation, told why. */
    async function expectRestartedForMobile(agentSessionId: string): Promise<void> {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      await vi.waitFor(() => expect(manager.suspend).toHaveBeenCalledWith(agentSessionId));
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(2));
      expect(builtCommand(1)).toMatchObject({ resume: true, readableDirectories: [paths.mobile] });
      expect(builtCommand(1).prompt).toContain(`kangentic-mobile at ${paths.mobile}`);
      // The spawn is the restart's last awaited step; a turn drains what follows it.
      await nextTurn();
      expect(errorSpy).not.toHaveBeenCalled();
    }

    describe('after a Pause the new agent never had', () => {
      it('restarts the agent a pane open started after a Pause pressed with no agent to stop', async () => {
        // Nothing runs, so there is no session to suspend: only the user's intent is recorded.
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(manager.suspend).not.toHaveBeenCalled();

        const agentSessionId = await openIdleAgent();

        expect(manager.spawn).toHaveBeenCalledTimes(1);
        await expectRestartedForMobile(agentSessionId);
      });

      it('restarts the agent a pane open started after the paused agent\'s session left the registry', async () => {
        addAgentSession();
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(manager.suspend).toHaveBeenCalledWith('pty-agent');
        manager.remove('pty-agent');

        const agentSessionId = await openIdleAgent();

        expect(manager.spawn).toHaveBeenCalledTimes(1);
        await expectRestartedForMobile(agentSessionId);
      });
    });

    describe('when its suspend fails after a newer request stored its grant', () => {
      it('keeps the newer grant, so the restart that follows tells the agent about every checkout it is owed', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const agentSessionId = await openIdleAgent();
        const suspendFailure = new Error('the session would not suspend');
        let failRestartSuspend!: (error: Error) => void;
        manager.suspend.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
          failRestartSuspend = reject;
        }));

        // The older grant: the mobile checkout, owed to an idle agent, so its restart begins at once.
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
        await vi.waitFor(() => expect(manager.suspend).toHaveBeenCalledTimes(1));

        // The newer grant, stored while that suspend is still stopping the agent. A turn is
        // under way, so the request is owed to the turn's end and queues no restart of its own.
        manager.activity[agentSessionId] = 'thinking';
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'relay').when).toBe('next-turn');

        failRestartSuspend(suspendFailure);
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not restart with the new project access'),
          suspendFailure,
        ));
        expect(manager.spawn).toHaveBeenCalledTimes(1);

        // The turn ends. The restart it owes says what the newer grant says: both checkouts.
        // (Both grants name the same home project, so the line the agent is told after
        // the restart is what tells the two apart. The readable directories do not: a
        // start reads them from the workflow row, which holds both whichever grant won.)
        manager.activity[agentSessionId] = 'idle';
        manager.emit('activity', agentSessionId, 'idle');
        await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(2));

        const restart = builtCommand(1);
        expect(restart.prompt).toContain(`kangentic-relay at ${paths.relay}`);
        expect(restart.prompt).toContain(`kangentic-mobile at ${paths.mobile}`);
        expect([...restart.readableDirectories].sort()).toEqual([paths.mobile, paths.relay].sort());
        await nextTurn();
        // Only the failed suspend logged: the restart that followed went through.
        expect(errorSpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});
