/**
 * What a workflow's agent may read beyond its own project, on real, migrated
 * SQLite and real directories (#732, the user's call: the workflow's projects,
 * plus any registered project it needs, granted automatically):
 * - it reads every other project a task of its workflow is on, and every one it
 *   asked for, and never a checkout that is gone from disk;
 * - a request is granted at once and kept on the workflow, and a running agent
 *   picks it up at its next idle, or at once when it is idle already;
 * - that restart waits out a turn the user started in the tick before it ran
 *   (the access stays owed), leaves a Pause the user pressed while the
 *   agent was stopping standing, and stays owed when the suspend fails, so
 *   the next idle edge retries it, unless the agent is no longer running
 *   by then (a Resume or a new start reads the grant from the row);
 * - a Pause pressed later still, while the restart's start is finding the CLI,
 *   also stands: the start spawns nothing and the agent stays suspended. A
 *   Resume pressed after that Pause joins the start in flight and spawns it;
 * - a Pause pressed later still, while a start is spawning, finds no row or only
 *   the one the start replaces, so the start suspends the new agent once it
 *   exists (once, when the Pause reached its row first, and never an exited one),
 *   even when the write that records its conversation throws, and only after
 *   that write, so a Resume finds the conversation;
 * - a restart owed to an agent that a Pause and a Resume since replaced leaves
 *   the new agent alone when its start already read the checkout, and still
 *   restarts one that lacks it;
 * - a restart whose suspend worked but whose start then threw, after the new
 *   agent was already running, owes nothing: the new agent has the access, and
 *   owing it again would stop and respawn a healthy agent at every idle edge;
 * - a restart whose start is refused because the Workflow agent setting was
 *   cleared since the agent started leaves the agent suspended, logs that the
 *   setting is not complete, spawns nothing, and owes nothing;
 * - an agent whose workflow records no conversation id (its CLI chose its own and
 *   never reported it) is not restarted, since a restart would begin a new
 *   conversation and drop the one running: the grant is stored for its next
 *   start, whether the agent is idle or mid-turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Every project `getProjectDb` was asked for: on main it creates a database that is not there. */
  getProjectDbCalls: [] as string[],
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    harness.getProjectDbCalls.push(projectId);
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
// A restart message a resume could not carry is pasted in; observed, never run.
const mockPasteAgentMessage = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/automations/turn-end/agent-message-delivery')>()),
  pasteAgentMessageInBackground: mockPasteAgentMessage,
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
// The cached agent inventory the Workflow agent setting is checked against.
vi.mock('../../src/main/agent/agent-list', () => ({
  listAgents: async () => [{ name: 'claude', found: true, supportsWorkflowAgent: true, capabilities: { supportsModelOverride: true } }],
}));

/** Settings > Workflows > Workflow agent, complete, so a start gets past it. */
const WORKFLOW_AGENT = { agent: 'claude', model: 'haiku', effort: null };

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const agent = await import('../../src/main/workflows/workflow-agent');
const { agentRegistry } = await import('../../src/main/agent/agent-registry');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

interface FakeSession {
  id: string;
  workflowId: string;
  status: string;
  projectId?: string;
}

/**
 * One macrotask turn. A restart for read access is scheduled with
 * `setImmediate` by the request or idle edge that owes it, so it has run once
 * this resolves.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('the workflow agent\'s reads across projects', () => {
  let root: string;
  let context: IpcContext;
  let sessions: FakeSession[];
  let activity: Record<string, string>;
  let suspend: ReturnType<typeof vi.fn>;
  let paths: Record<string, string>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-access-'));
    paths = {};
    for (const name of ['home', 'mobile', 'relay']) {
      paths[name] = path.join(root, name);
      fs.mkdirSync(paths[name]);
    }
    // Registered, but its checkout is gone from disk.
    paths.gone = path.join(root, 'gone');
    harness.dbs.clear();
    harness.getProjectDbCalls.length = 0;
    for (const projectId of ['home', 'mobile', 'relay', 'gone']) {
      const db = openTestDatabase();
      db.exec('PRAGMA foreign_keys = ON');
      runProjectMigrations(db);
      harness.dbs.set(projectId, db);
    }
    const projects = [
      { id: 'home', name: 'kangentic', path: paths.home },
      { id: 'mobile', name: 'kangentic-mobile', path: paths.mobile },
      { id: 'relay', name: 'kangentic-relay', path: paths.relay },
      { id: 'gone', name: 'old-checkout', path: paths.gone },
    ];
    sessions = [];
    activity = {};
    suspend = vi.fn(async () => undefined);
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: {
        listSessions: () => sessions,
        getSessionAgentName: () => 'claude',
        getActivityCache: () => activity,
        suspend,
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      configManager: { load: () => ({}) },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    for (const database of harness.dbs.values()) (database as Database.Database).close();
    harness.dbs.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const homeDb = () => harness.dbs.get('home') as Database.Database;
  const read = (workflowId: string) => new WorkflowRepository(homeDb()).getById(workflowId)!;

  it('reads the projects its tasks are on and the ones it asked for, never its own or a missing one', () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      tasks: [
        { key: 'app', title: 'Budgets screen', project: 'kangentic-mobile' },
        { key: 'api', title: 'Budgets API' },
      ],
      links: [],
    });
    const repository = new WorkflowRepository(homeDb());
    repository.addAgentReadProject(workflow.id, 'relay');
    repository.addAgentReadProject(workflow.id, 'gone');

    const readable = agent.readableProjectsOf(context, 'home', read(workflow.id));
    expect(readable.map((entry) => entry.name).sort()).toEqual(['kangentic-mobile', 'kangentic-relay']);
    expect(readable.find((entry) => entry.name === 'kangentic-relay')!.path).toBe(paths.relay);
  });

  it('grants a request at once and keeps it; with no agent running, the next start reads it', () => {
    const workflow = service.createWorkflow('home', {});
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflow.id, 'home').when).toBe('home');

    const result = agent.requestWorkflowAgentProjectAccess(context, 'home', workflow.id, 'relay');
    expect(result).toEqual({ name: 'kangentic-relay', path: paths.relay, when: 'next-start' });
    expect(read(workflow.id).agent_read_project_ids).toEqual(['relay']);
  });

  // The grant is written to the home project's database. The home is the id the
  // agent's scope names, which can outlive its project, and `getProjectDb` on main
  // would create an empty database for it. The live home is the test above.
  it('refuses a request when the home project is gone, and does not open its database', () => {
    // A registered project to read, and a home with no database and no registry row.
    expect(() => agent.requestWorkflowAgentProjectAccess(context, 'deleted-home', 'workflow-of-a-deleted-project', 'relay'))
      .toThrow('This workflow no longer exists.');

    expect(harness.getProjectDbCalls).not.toContain('deleted-home');
  });

  // The working agent's restart at its turn's end is pinned in "the restart for new read access" below.
  it('leaves a working agent\'s turn alone, and restarts an idle one at once', async () => {
    // Each agent's conversation is recorded, as its start leaves it: a restart resumes by that id.
    const working = service.createWorkflow('home', {});
    new WorkflowRepository(homeDb()).setAgentConversation(working.id, { agentName: 'claude', agentSessionId: 'conversation-working', cwd: paths.home });
    sessions.push({ id: 'session-working', workflowId: working.id, status: 'running' });
    activity['session-working'] = 'thinking';
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', working.id, 'mobile').when).toBe('next-turn');
    // Nothing is cut short mid-turn.
    await nextTurn();
    expect(suspend).not.toHaveBeenCalled();

    const idle = service.createWorkflow('home', {});
    new WorkflowRepository(homeDb()).setAgentConversation(idle.id, { agentName: 'claude', agentSessionId: 'conversation-idle', cwd: paths.home });
    sessions.push({ id: 'session-idle', workflowId: idle.id, status: 'running' });
    activity['session-idle'] = 'idle';
    // The restart's own start fails here (no config in this context) and logs; the suspend is what matters.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', idle.id, 'mobile').when).toBe('now');
      await vi.waitFor(() => expect(suspend).toHaveBeenCalledWith('session-idle'));
      // The start runs after the suspend resolves: let it log before the spy goes.
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not restart with the new project access'),
        expect.anything(),
      ));
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe('the restart for new read access', () => {
    /** Every call is a start the restart attempted: the start reads the config first, and finds the MCP server off. */
    let startAttempts: ReturnType<typeof vi.fn>;
    let manager: EventEmitter;
    /** A start that comes back unavailable warns; quiet here, and read by the test that pins it. */
    let warnSpy: MockInstance<typeof console.warn>;
    // Set by `makeStartsReachSpawn`, for the restarts that get past the start's config check and on to its spawn.
    let spawn: ReturnType<typeof vi.fn>;
    let getShell: ReturnType<typeof vi.fn>;
    let buildCommand: ReturnType<typeof vi.fn>;
    let markIdleAuthoritative: ReturnType<typeof vi.fn>;
    /** Spies a test installed, restored after it. */
    const spies: Array<{ mockRestore: () => void }> = [];

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      startAttempts = vi.fn(() => ({ mcpServer: { enabled: false }, agent: { cliPaths: {} }, workflows: WORKFLOW_AGENT }));
      Object.assign(context.configManager, { getEffectiveConfig: startAttempts });
      // An emitter, so the lifecycle's activity listener (the next idle) can be driven.
      manager = Object.assign(new EventEmitter(), {
        listSessions: () => sessions,
        getSession: (sessionId: string) => sessions.find((session) => session.id === sessionId),
        getSessionAgentName: () => 'claude',
        getActivityCache: () => activity,
        suspend,
      });
      Object.assign(context, { sessionManager: manager });
      agent.registerWorkflowAgentLifecycle(context);
    });

    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore();
      warnSpy.mockRestore();
    });

    /**
     * An idle running agent for a new workflow, owed a restart for `mobile`'s
     * checkout. Its conversation is recorded, as every start on an agent that
     * takes Kangentic's id leaves it: a restart resumes by that id.
     */
    function idleAgent(sessionId: string): string {
      const workflow = service.createWorkflow('home', {});
      sessions.push({ id: sessionId, workflowId: workflow.id, status: 'running' });
      activity[sessionId] = 'idle';
      recordConversation(workflow.id);
      return workflow.id;
    }

    /** Lets a start run end to end: a usable adapter, the MCP server on, a suspend that works, a spawn that replaces the row. */
    function makeStartsReachSpawn(): void {
      buildCommand = vi.fn(() => 'mock-agent-command');
      // An adapter the start can use end to end: the real one probes the CLI and writes its trust file.
      const fakeAdapter = {
        name: 'claude',
        displayName: 'Claude Code',
        sessionType: 'claude_agent',
        kangenticMcp: 'per-session',
        supportsReadOnlyLaunch: true,
        supportsCallerSessionId: true,
        resumePromptDelivery: 'command-line',
        supportsReadableDirectories: true,
        detect: async () => ({ found: true, path: '/mock/bin/claude' }),
        ensureTrust: async () => undefined,
        buildCommand,
        getExitSequence: () => ['\x03'],
      };
      spies.push(vi.spyOn(agentRegistry, 'get').mockReturnValue(fakeAdapter as unknown as AgentAdapter));
      // The MCP server is on, so the start gets past its config check and to the spawn.
      startAttempts.mockReturnValue({ mcpServer: { enabled: true }, agent: { cliPaths: {} }, workflows: WORKFLOW_AGENT });
      Object.assign(context, {
        mcpServerHandle: { urlForProject: (projectId: string) => `http://127.0.0.1:9/mcp/${projectId}`, token: 'test-token' },
      });
      // A suspend that works: the row stays, suspended, until the spawn replaces it.
      suspend.mockImplementation(async (sessionId: string) => {
        const stopped = sessions.find((session) => session.id === sessionId);
        if (stopped) stopped.status = 'suspended';
      });
      spawn = vi.fn(async (options: { workflowId: string; projectId: string }) => {
        // The real spawn drains the rows it replaces, so only the new agent is left.
        sessions.splice(0, sessions.length, ...sessions.filter((existing) => existing.workflowId !== options.workflowId));
        const spawned: FakeSession = { id: 'session-restarted', workflowId: options.workflowId, projectId: options.projectId, status: 'running' };
        sessions.push(spawned);
        return spawned;
      });
      getShell = vi.fn(async () => 'bash');
      markIdleAuthoritative = vi.fn();
      Object.assign(manager, { getShell, spawn, markIdleAuthoritative });
    }

    /** A conversation to resume, so a start has no first message to build. */
    function recordConversation(workflowId: string): void {
      new WorkflowRepository(homeDb()).setAgentConversation(workflowId, { agentName: 'claude', agentSessionId: 'conversation-1', cwd: paths.home });
    }

    it('suspends the agent and starts it again when nobody paused it (the control)', async () => {
      const workflowId = idleAgent('session-control');

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      await vi.waitFor(() => expect(startAttempts).toHaveBeenCalledTimes(1));
      expect(suspend).toHaveBeenCalledWith('session-control');
    });

    it('leaves the agent suspended and says why when its start cannot run, and owes nothing', async () => {
      const sessionId = 'session-start-unavailable';
      const workflowId = idleAgent(sessionId);
      // A suspend that works: the row stays, suspended.
      suspend.mockImplementationOnce(async (stoppedSessionId: string) => {
        const stopped = sessions.find((session) => session.id === stoppedSessionId);
        if (stopped) stopped.status = 'suspended';
      });

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      // The start reads the config, finds the MCP server off, and comes back unavailable.
      await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/could not start again: .*MCP server/)));
      expect(startAttempts).toHaveBeenCalledTimes(1);

      // Nothing is owed: an agent that runs again is left alone at its idle edge.
      const returning = sessions.find((session) => session.id === sessionId);
      if (returning) returning.status = 'running';
      manager.emit('activity', sessionId, 'idle');
      await nextTurn();
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(startAttempts).toHaveBeenCalledTimes(1);
    });

    // The Workflow agent setting can be cleared between the agent's start and the
    // restart for new access. That start has no agent to run, so it asks for the
    // setting instead of falling back to the project's default agent, and the
    // restart leaves the agent paused with the reason logged.
    it('leaves the agent suspended, says the setting is not complete, and owes nothing when the setting was cleared since it started', async () => {
      makeStartsReachSpawn();
      // Everything else a start needs is in place; only the Workflow agent setting is empty.
      startAttempts.mockReturnValue({ mcpServer: { enabled: true }, agent: { cliPaths: {} }, workflows: {} });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      spies.push(errorSpy);
      const sessionId = 'session-setting-cleared';
      const workflowId = idleAgent(sessionId);
      // A conversation to resume: were the start to get past the setting, it would spawn.
      recordConversation(workflowId);

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not start again: the Workflow agent setting is not complete'),
      ));
      expect(startAttempts).toHaveBeenCalledTimes(1);
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(suspend).toHaveBeenCalledWith(sessionId);
      // A refusal to start is a return, not a failure: nothing spawned, nothing threw, the agent is paused.
      expect(spawn).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(sessions.map((session) => [session.id, session.status])).toEqual([[sessionId, 'suspended']]);

      // Nothing is owed: an agent that runs again is left alone at its idle edge.
      const returning = sessions.find((session) => session.id === sessionId);
      if (returning) returning.status = 'running';
      manager.emit('activity', sessionId, 'idle');
      await nextTurn();
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(startAttempts).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    });

    // A restart resumes the agent by the id its workflow recorded. An agent whose
    // CLI chose its own id and has not reported it has none recorded, so a restart
    // would begin a new conversation and drop the one running. The grant is kept
    // for its next start instead, and nothing is owed to it.
    it.each(['idle', 'thinking'])('keeps a %s agent running, and owes it nothing, when no conversation id was ever recorded for it', async (state) => {
      const workflow = service.createWorkflow('home', {});
      sessions.push({ id: 'session-no-id', workflowId: workflow.id, status: 'running' });
      activity['session-no-id'] = state;
      expect(read(workflow.id).agent_session_id).toBeNull();

      const result = agent.requestWorkflowAgentProjectAccess(context, 'home', workflow.id, 'mobile');

      expect(result.when).toBe('next-start');
      expect(read(workflow.id).agent_read_project_ids).toEqual(['mobile']);
      // Were a restart queued, it would have run by the time this resolves.
      await nextTurn();
      expect(suspend).not.toHaveBeenCalled();
      expect(startAttempts).not.toHaveBeenCalled();

      // Nothing is owed: the agent's next idle edge leaves it alone too.
      activity['session-no-id'] = 'idle';
      manager.emit('activity', 'session-no-id', 'idle');
      await nextTurn();
      expect(suspend).not.toHaveBeenCalled();
      expect(startAttempts).not.toHaveBeenCalled();
    });

    it('does not suspend an agent whose turn began again before the restart ran, and restarts it at its next idle', async () => {
      const workflowId = idleAgent('session-reprompted');
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      // The user's prompt starts a turn in the tick between the idle edge and the restart.
      activity['session-reprompted'] = 'thinking';
      // The restart was queued first, so it has run by the time this resolves.
      await nextTurn();
      expect(suspend).not.toHaveBeenCalled();
      expect(startAttempts).not.toHaveBeenCalled();

      // The access is still owed: the turn's end restarts the agent.
      activity['session-reprompted'] = 'idle';
      manager.emit('activity', 'session-reprompted', 'idle');
      await vi.waitFor(() => expect(startAttempts).toHaveBeenCalledTimes(1));
      expect(suspend).toHaveBeenCalledWith('session-reprompted');
    });

    // The restart runs a tick after the request, and reads the workflow's home
    // again to see what the agent still lacks. That home can be deleted in that
    // tick, and `getProjectDb` on main would create an empty database for it. The
    // mocked `getProjectDb` throws for it and the read sits in a try, so the
    // recorded ids are what show a read that opened the gone home.
    it('does not restart, and does not open the home, when the project is deleted between the request and the restart', async () => {
      const workflowId = idleAgent('session-home-deleted');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      spies.push(errorSpy);
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      // The project is deleted before the restart runs: its database is closed and gone.
      homeDb().close();
      harness.dbs.delete('home');
      // After the request, whose own reads of the home were of the live database.
      harness.getProjectDbCalls.length = 0;
      // The restart was queued first, so it has run by the time this resolves.
      await nextTurn();

      expect(harness.getProjectDbCalls).not.toContain('home');
      expect(suspend).not.toHaveBeenCalled();
      expect(startAttempts).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('owes the restart again when its suspend fails, so the next idle edge retries it and starts the agent', async () => {
      const workflowId = idleAgent('session-suspend-fails');
      const suspendFailure = new Error('the session would not suspend');
      suspend.mockRejectedValueOnce(suspendFailure);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

        // The catch that logs is the one that owes the restart again, so waiting
        // on the log means the access is owed before the next edge is emitted.
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not restart with the new project access'),
          suspendFailure,
        ));
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(startAttempts).not.toHaveBeenCalled();

        // The fake's suspend leaves the row running, as the real one does when it fails.
        // Its next idle edge is the retry.
        manager.emit('activity', 'session-suspend-fails', 'idle');

        await vi.waitFor(() => expect(startAttempts).toHaveBeenCalledTimes(1));
        expect(suspend).toHaveBeenCalledTimes(2);
        expect(suspend).toHaveBeenLastCalledWith('session-suspend-fails');
        // The retry's own start comes back unavailable here (the MCP server is off) and warns; let it settle.
        await nextTurn();
      } finally {
        errorSpy.mockRestore();
      }
    });

    // The agent left `running` while the restart's suspend was failing: the idle
    // auto-suspend got there first, or the CLI exited under it. Whatever runs
    // next, a Resume or a new start, reads the grant from the workflow row, so
    // nothing is owed. Owing it anyway would stop that agent at its first idle edge.
    it.each(['suspended', 'exited'])('owes nothing when its suspend fails with the agent %s, so an agent that runs again is left alone at its idle edge', async (statusAtFailure) => {
      const sessionId = 'session-left-running';
      const workflowId = idleAgent(sessionId);
      const suspendFailure = new Error('the session was no longer running');
      suspend.mockImplementationOnce(async (stoppedSessionId: string) => {
        const stopped = sessions.find((session) => session.id === stoppedSessionId);
        if (stopped) stopped.status = statusAtFailure;
        throw suspendFailure;
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not restart with the new project access'),
          suspendFailure,
        ));
        expect(suspend).toHaveBeenCalledTimes(1);

        // An agent runs again and goes idle. Were the access still owed, this edge would restart it.
        const returning = sessions.find((session) => session.id === sessionId);
        if (returning) returning.status = 'running';
        manager.emit('activity', sessionId, 'idle');
        // The restart, were it owed, was queued first, so it has run by the time this resolves.
        await nextTurn();

        expect(suspend).toHaveBeenCalledTimes(1);
        expect(startAttempts).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    describe('a restart whose start throws after the new agent is already running', () => {
      beforeEach(() => {
        makeStartsReachSpawn();
      });

      /** Makes the start's step after its spawn (recording the conversation) throw, and quiets the log it ends in. */
      function failStartsAfterTheirSpawn() {
        const startFailure = new Error('the conversation could not be recorded');
        spies.push(vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation').mockImplementation(() => {
          throw startFailure;
        }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        spies.push(errorSpy);
        return { startFailure, errorSpy };
      }

      /** Two macrotask turns: a restart runs one turn after the edge or request that scheduled it, and the second lets it finish. */
      async function settle(): Promise<void> {
        await nextTurn();
        await nextTurn();
      }

      it('owes nothing, so the next idle edge leaves the running agent alone instead of stopping and spawning it again', async () => {
        const workflowId = idleAgent('session-before-restart');
        recordConversation(workflowId);
        // The start's last step after its spawn fails: the new agent is already running.
        const { startFailure, errorSpy } = failStartsAfterTheirSpawn();

        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

        // The catch that logs is the one that decides whether to owe the restart again.
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not restart with the new project access'),
          startFailure,
        ));
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(suspend).toHaveBeenCalledWith('session-before-restart');
        expect(spawn).toHaveBeenCalledTimes(1);
        // The start threw after its spawn: the one session left is the new agent, running.
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'running']]);

        // The new agent goes idle. Were the access still owed, this edge would restart it again.
        activity['session-restarted'] = 'idle';
        manager.emit('activity', 'session-restarted', 'idle');
        await settle();

        expect(suspend).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(startAttempts).toHaveBeenCalledTimes(1);
      });

      it('records the checkouts the new agent reads before the step that threw, so asking for one it has finds nothing missing', async () => {
        const workflowId = idleAgent('session-before-restart');
        recordConversation(workflowId);
        const { startFailure, errorSpy } = failStartsAfterTheirSpawn();
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not restart with the new project access'),
          startFailure,
        ));
        expect(spawn).toHaveBeenCalledTimes(1);

        // The new agent, idle, was started with the mobile checkout. A start that recorded nothing
        // would read it as missing here, answer 'now', and stop and spawn a healthy agent.
        activity['session-restarted'] = 'idle';
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('already');
        await settle();

        expect(suspend).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(startAttempts).toHaveBeenCalledTimes(1);
      });

      it('records the size it started at before the step that threw, so the next restart keeps the pane\'s size', async () => {
        const workflowId = service.createWorkflow('home', {}).id;
        recordConversation(workflowId);
        const { errorSpy } = failStartsAfterTheirSpawn();

        // The pane's own start, at a size it measured: the workflow row records none.
        await expect(agent.openWorkflowAgent(context, 'home', workflowId, { cols: 100, rows: 40 })).rejects.toThrow('the conversation could not be recorded');
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0][0]).toMatchObject({ cols: 100, rows: 40 });
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'running']]);
        // The running agent's own bookkeeping runs before the write that threw: a
        // resume that sends nothing is still asserted idle, or it would read as
        // working, with every plan edit held, until the stale-thinking watchdog.
        expect(markIdleAuthoritative).toHaveBeenCalledWith('session-restarted');

        // The restart for a new checkout starts from the size the last start recorded.
        activity['session-restarted'] = 'idle';
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
        expect(spawn.mock.calls[1][0]).toMatchObject({ cols: 100, rows: 40 });
        // The restart's own start throws after its spawn too, and logs; let it settle before the spies go.
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not restart with the new project access'),
          expect.any(Error),
        ));
      });
    });

    it('does not start the agent again when the user paused it while it was being suspended', async () => {
      const workflowId = idleAgent('session-pausing');
      let finishRestartSuspend!: () => void;
      const restartSuspendGate = new Promise<void>((resolve) => {
        finishRestartSuspend = resolve;
      });
      suspend.mockImplementationOnce(async () => restartSuspendGate);
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
      await vi.waitFor(() => expect(suspend).toHaveBeenCalledTimes(1));

      // Pause, pressed while the restart's suspend is still stopping the agent.
      await agent.pauseWorkflowAgent(context, workflowId);
      finishRestartSuspend();
      // The restart's continuation is microtasks only: one macrotask lets it run to its end.
      await nextTurn();

      expect(startAttempts).not.toHaveBeenCalled();
    });

    // The restart suspends the agent, checks for a Pause once, then waits on a
    // start that finds the CLI, the shell and the trust file before it spawns.
    // A Pause pressed in that wait finds the agent already suspended, so it stops
    // nothing and only records itself; the start has to read it before it spawns.
    describe('a Pause pressed while the restart\'s start is finding the CLI', () => {
      beforeEach(() => {
        makeStartsReachSpawn();
      });

      /**
       * Starts the restart for `mobile`'s checkout and holds its start inside
       * `getShell`: past the check that follows the suspend, before the spawn.
       */
      async function holdRestartInItsStart(sessionId: string) {
        const workflowId = idleAgent(sessionId);
        recordConversation(workflowId);
        let releaseShell: () => void = () => undefined;
        const shellGate = new Promise<string>((resolve) => {
          releaseShell = () => resolve('bash');
        });
        getShell.mockImplementationOnce(() => shellGate);

        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
        await vi.waitFor(() => expect(getShell).toHaveBeenCalledTimes(1));
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(sessions.map((session) => [session.id, session.status])).toEqual([[sessionId, 'suspended']]);
        expect(spawn).not.toHaveBeenCalled();
        return { workflowId, releaseShell };
      }

      /**
       * Waits for the start to reach its command build. Nothing after it awaits
       * before the spawn call, so once it has run the spawn has happened or never will.
       */
      async function waitForStartToReachItsSpawnDecision(): Promise<void> {
        await vi.waitFor(() => expect(buildCommand).toHaveBeenCalledTimes(1));
      }

      it('spawns the new agent when nobody paused it (the control)', async () => {
        const { releaseShell } = await holdRestartInItsStart('session-unpaused-mid-start');

        releaseShell();
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

        expect(spawn.mock.calls[0][0]).toMatchObject({ projectId: 'home', resuming: true });
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'running']]);
      });

      it('stands: the start spawns nothing, and the agent stays suspended', async () => {
        const { workflowId, releaseShell } = await holdRestartInItsStart('session-paused-mid-start');

        // The agent reads suspended already, so the Pause stops nothing.
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(suspend).toHaveBeenCalledTimes(1);
        releaseShell();
        await waitForStartToReachItsSpawnDecision();

        expect(spawn).not.toHaveBeenCalled();
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-paused-mid-start', 'suspended']]);
        expect(suspend).toHaveBeenCalledTimes(1);
        // A start that stood down is not a start that failed: nothing warns or logs.
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('is lifted by a Resume pressed after it, which joins the held start and spawns the agent', async () => {
        const { workflowId, releaseShell } = await holdRestartInItsStart('session-resumed-mid-start');
        await agent.pauseWorkflowAgent(context, workflowId);

        // The Resume joins the start in flight, so it settles only once the gate opens.
        const resumed = agent.resumeWorkflowAgent(context, 'home', workflowId, {});
        releaseShell();
        const status = await resumed;

        expect(spawn).toHaveBeenCalledTimes(1);
        expect(status.session?.id).toBe('session-restarted');
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'running']]);
      });
    });

    // The wait after the one above: the spawn itself. A Pause pressed there finds
    // only the row the start replaces (the restart suspended it already) or no row
    // at all (a fresh open), so it stops nothing and only records itself. The
    // start reads it once the new agent exists, and suspends that agent.
    describe('a Pause pressed while a start is spawning', () => {
      interface FakeSpawnOptions {
        workflowId: string;
        projectId: string;
      }

      let errorSpy: MockInstance<typeof console.error>;

      beforeEach(() => {
        makeStartsReachSpawn();
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        spies.push(errorSpy);
      });

      /**
       * Holds the next spawn open until `release` is called. It resolves with a
       * snapshot of the new row, as the real one does (`toSession`), taken when the
       * row is registered, so whatever the start learns of the row afterwards has
       * to come from the registry.
       * `registersRowFirst` puts the new row in the registry before the spawn
       * resolves, which is where the real spawn has it for a Pause to find.
       * `newRowStatus` is the status that row arrives with.
       */
      function holdNextSpawn(held: { registersRowFirst?: boolean; newRowStatus?: string } = {}): { release: () => void } {
        const spawnWithoutHold: (options: FakeSpawnOptions) => Promise<FakeSession> = spawn.getMockImplementation()!;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        spawn.mockImplementationOnce(async (options: FakeSpawnOptions) => {
          if (held.registersRowFirst) {
            const registered = await spawnWithoutHold(options);
            registered.status = held.newRowStatus ?? registered.status;
            const snapshot = { ...registered };
            await gate;
            return snapshot;
          }
          await gate;
          const registered = await spawnWithoutHold(options);
          registered.status = held.newRowStatus ?? registered.status;
          return { ...registered };
        });
        return { release };
      }

      /**
       * Starts the restart for `mobile`'s checkout and holds its start inside the
       * spawn. The old agent's row, suspended by the restart, is the only one there.
       */
      async function holdRestartInItsSpawn(sessionId: string) {
        const workflowId = idleAgent(sessionId);
        recordConversation(workflowId);
        const { release } = holdNextSpawn();

        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(sessions.map((session) => [session.id, session.status])).toEqual([[sessionId, 'suspended']]);
        return { workflowId, release };
      }

      /** A workflow with a conversation to resume and no agent row, as a fresh open finds it. */
      function workflowWithNoAgent(): string {
        const workflowId = service.createWorkflow('home', {}).id;
        recordConversation(workflowId);
        return workflowId;
      }

      it('suspends the agent the restart spawned: the Pause reached only the row the start replaces', async () => {
        const { workflowId, release } = await holdRestartInItsSpawn('session-paused-mid-spawn');

        // The old agent reads suspended already, so the Pause stops nothing.
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(suspend).toHaveBeenCalledTimes(1);

        release();
        await vi.waitFor(() => expect(suspend).toHaveBeenCalledWith('session-restarted'));
        // The start returns after the suspend; let it end before reading what it logged.
        await nextTurn();

        expect(suspend).toHaveBeenCalledTimes(2);
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'suspended']]);
        // A start that suspended its agent is a start that worked: nothing warns or logs.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('suspends the agent a fresh open spawned, and the open reports it suspended', async () => {
        const workflowId = workflowWithNoAgent();
        const { release } = holdNextSpawn();

        const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        // No row exists yet, so the Pause finds no agent to stop.
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(suspend).not.toHaveBeenCalled();

        release();
        const status = await opened;

        expect(suspend).toHaveBeenCalledTimes(1);
        expect(suspend).toHaveBeenCalledWith('session-restarted');
        // The spawn resolved with a snapshot that reads running: the status comes from the registry.
        expect(status.unavailable).toBeNull();
        expect(status.session).toMatchObject({ id: 'session-restarted', status: 'suspended' });
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'suspended']]);
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('leaves the agent the restart spawned running when nobody paused it (the control)', async () => {
        const { release } = await holdRestartInItsSpawn('session-unpaused-mid-spawn');
        const conversationWrites = vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation');
        spies.push(conversationWrites);

        release();
        // The write is the start's last step before the check for a Pause; one turn lets that check run.
        await vi.waitFor(() => expect(conversationWrites).toHaveBeenCalledTimes(1));
        await nextTurn();

        // Only the restart's own suspend, of the old agent, ever ran.
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(suspend).not.toHaveBeenCalledWith('session-restarted');
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'running']]);
      });

      it('suspends the new agent once, not twice, when the Pause already reached its row', async () => {
        const workflowId = workflowWithNoAgent();
        // The spawn has registered the new row but has not resolved yet.
        const { release } = holdNextSpawn({ registersRowFirst: true });

        const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
        await vi.waitFor(() => expect(sessions.map((session) => session.id)).toEqual(['session-restarted']));
        // This Pause finds the new row running and suspends it.
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(suspend).toHaveBeenCalledWith('session-restarted');

        release();
        const status = await opened;

        // The spawn's snapshot, taken before the Pause, still reads running. The start reads
        // the registry, where the row is suspended, so it leaves it be and reports that row.
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(status.session).toMatchObject({ id: 'session-restarted', status: 'suspended' });
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('leaves a new agent that already exited alone: there is nothing to suspend', async () => {
        const workflowId = workflowWithNoAgent();
        const { release } = holdNextSpawn({ newRowStatus: 'exited' });

        const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        await agent.pauseWorkflowAgent(context, workflowId);

        release();
        const status = await opened;

        expect(suspend).not.toHaveBeenCalled();
        expect(status.session).toMatchObject({ id: 'session-restarted', status: 'exited' });
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('logs a suspend that fails and still reports the new agent, rather than failing the start', async () => {
        const workflowId = workflowWithNoAgent();
        const suspendFailure = new Error('the session would not suspend');
        suspend.mockRejectedValueOnce(suspendFailure);
        const { release } = holdNextSpawn();

        const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        await agent.pauseWorkflowAgent(context, workflowId);

        release();
        const status = await opened;

        expect(suspend).toHaveBeenCalledWith('session-restarted');
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Could not pause the agent a Pause reached while it started'),
          suspendFailure,
        );
        // The row stays running, as the real suspend leaves it when it fails: the start still has an agent to report.
        expect(status.unavailable).toBeNull();
        expect(status.session).toMatchObject({ id: 'session-restarted', status: 'running' });
      });

      it('still suspends the new agent when the write of its conversation throws, and the open rejects with that error', async () => {
        const workflowId = workflowWithNoAgent();
        const writeFailure = new Error('the conversation could not be recorded');
        // Installed after the seed above, which writes through the same method.
        spies.push(vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation').mockImplementation(() => {
          throw writeFailure;
        }));
        const { release } = holdNextSpawn();

        const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        // No row exists yet, so the Pause finds no agent to stop.
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(suspend).not.toHaveBeenCalled();

        release();
        await expect(opened).rejects.toBe(writeFailure);

        // The Pause stands for the agent the failed start left running.
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(suspend).toHaveBeenCalledWith('session-restarted');
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'suspended']]);
      });

      it('records the conversation before it suspends the new agent, so a Resume finds it', async () => {
        // A workflow with no conversation: this start makes one.
        const workflowId = service.createWorkflow('home', {}).id;
        expect(read(workflowId).agent_session_id).toBeNull();
        // A start with no conversation builds the first message, which asks for the board's default branch.
        Object.assign(context, { boardConfigManager: { getDefaultBaseBranchForPath: () => 'main' } });
        // Reads the row at the moment the agent is stopped, then stops it as the fake does.
        const conversationAtSuspend: Array<string | null> = [];
        const stopAgent = suspend.getMockImplementation()!;
        suspend.mockImplementation(async (sessionId: string) => {
          conversationAtSuspend.push(read(workflowId).agent_session_id);
          await stopAgent(sessionId);
        });
        const { release } = holdNextSpawn();

        const opened = agent.openWorkflowAgent(context, 'home', workflowId, {});
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        await agent.pauseWorkflowAgent(context, workflowId);
        expect(suspend).not.toHaveBeenCalled();

        release();
        const status = await opened;

        const startedConversation = spawn.mock.calls[0][0].agentSessionId;
        expect(startedConversation).toEqual(expect.any(String));
        // Already set when the suspend ran, and still set afterwards.
        expect(conversationAtSuspend).toEqual([startedConversation]);
        expect(read(workflowId).agent_session_id).toBe(startedConversation);
        expect(status.session).toMatchObject({ id: 'session-restarted', status: 'suspended' });
      });
    });

    // A start since the restart was owed (a Resume after a Pause) read the grant
    // from the workflow row, so the agent it spawned may already have every
    // checkout. The restart looks again before it stops that agent.
    describe('a restart owed to an agent that a later start already gave the checkout', () => {
      beforeEach(() => {
        makeStartsReachSpawn();
      });

      /** A conversation in a turn, asked for `mobile`'s checkout: the restart is owed at the turn's end. */
      function midTurnAgentOwedMobile(): string {
        const workflowId = idleAgent('session-mid-turn');
        recordConversation(workflowId);
        activity['session-mid-turn'] = 'thinking';
        expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('next-turn');
        return workflowId;
      }

      /** The first message each command was built with; a resume built without one reads as an empty string. */
      function builtPrompts(): string[] {
        return buildCommand.mock.calls.map((call) => String(call[0].prompt ?? ''));
      }

      it('leaves the new agent running at its idle edge, and starts nothing', async () => {
        const workflowId = midTurnAgentOwedMobile();
        await agent.pauseWorkflowAgent(context, workflowId);
        // The Resume's start reads the grant from the workflow row.
        await agent.resumeWorkflowAgent(context, 'home', workflowId, {});
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(buildCommand.mock.calls[0][0].readableDirectories).toEqual([paths.mobile]);
        expect(suspend.mock.calls).toEqual([['session-mid-turn']]);

        // The new agent finishes its first turn. The restart queued first has run by the time this resolves.
        activity['session-restarted'] = 'idle';
        manager.emit('activity', 'session-restarted', 'idle');
        await nextTurn();
        await nextTurn();

        expect(suspend.mock.calls).toEqual([['session-mid-turn']]);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(builtPrompts().some((prompt) => prompt.includes('Kangentic restarted you'))).toBe(false);
        expect(sessions.map((session) => [session.id, session.status])).toEqual([['session-restarted', 'running']]);
      });

      it('restarts the agent at its idle edge when a checkout it was owed is still missing (the control)', async () => {
        midTurnAgentOwedMobile();

        activity['session-mid-turn'] = 'idle';
        manager.emit('activity', 'session-mid-turn', 'idle');
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        // The start's last step after its spawn: one turn lets it end.
        await nextTurn();

        expect(suspend).toHaveBeenCalledWith('session-mid-turn');
        expect(buildCommand.mock.calls[0][0].readableDirectories).toEqual([paths.mobile]);
        expect(builtPrompts()[0]).toContain(`kangentic-mobile at ${paths.mobile}`);
        expect(builtPrompts()[0]).toContain('Kangentic restarted you');
        expect(mockPasteAgentMessage).not.toHaveBeenCalled();
      });

      it('types the restart\'s reason in for an agent whose resume carries no prompt', async () => {
        // A CLI that takes no prompt with a resume (`resumePromptDelivery: 'typed'`)
        // dropped this message: the builder was handed it and left it out.
        const carryingAdapter = agentRegistry.get('claude') as unknown as Record<string, unknown>;
        spies.push(vi.spyOn(agentRegistry, 'get').mockReturnValue({ ...carryingAdapter, resumePromptDelivery: 'typed' } as unknown as AgentAdapter));
        mockPasteAgentMessage.mockClear();
        const workflowId = midTurnAgentOwedMobile();

        activity['session-mid-turn'] = 'idle';
        manager.emit('activity', 'session-mid-turn', 'idle');
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        await nextTurn();

        expect(buildCommand.mock.calls[0][0]).toMatchObject({ resume: true, prompt: undefined });
        expect(markIdleAuthoritative).toHaveBeenCalledWith('session-restarted');
        expect(mockPasteAgentMessage).toHaveBeenCalledWith(context, expect.objectContaining({
          taskId: workflowId,
          sessionId: 'session-restarted',
          message: expect.stringContaining('Kangentic restarted you'),
        }));
      });
    });

    // In these two the fake's suspend leaves the row running, as in the tests
    // above, so a Resume finds a live agent and starts nothing: what is pinned
    // is whether the user's Pause still stands when the restart is owed.
    it('leaves an agent the user paused alone: no suspend, no start (the control)', async () => {
      const workflowId = idleAgent('session-paused');
      await agent.pauseWorkflowAgent(context, workflowId);
      expect(suspend).toHaveBeenCalledTimes(1);

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');
      // The restart was queued first, so it has run by the time this resolves.
      await nextTurn();

      expect(suspend).toHaveBeenCalledTimes(1);
      expect(startAttempts).not.toHaveBeenCalled();
    });

    it('restarts an agent after the user paused it and then resumed it: the Pause no longer stands', async () => {
      const workflowId = idleAgent('session-resumed');
      await agent.pauseWorkflowAgent(context, workflowId);
      await agent.resumeWorkflowAgent(context, 'home', workflowId, {});
      suspend.mockClear();

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      await vi.waitFor(() => expect(startAttempts).toHaveBeenCalledTimes(1));
      expect(suspend).toHaveBeenCalledWith('session-resumed');
    });
  });
});
