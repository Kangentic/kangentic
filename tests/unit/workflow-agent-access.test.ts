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
 *   the next idle edge retries it;
 * - a restart whose suspend worked but whose start then threw, after the new
 *   agent was already running, owes nothing: the new agent has the access, and
 *   owing it again would stop and respawn a healthy agent at every idle edge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

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

  it('restarts a working agent when its turn ends, and an idle one at once', async () => {
    const working = service.createWorkflow('home', {});
    sessions.push({ id: 'session-working', workflowId: working.id, status: 'running' });
    activity['session-working'] = 'thinking';
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', working.id, 'mobile').when).toBe('next-turn');
    // Nothing is cut short mid-turn.
    await new Promise((resolve) => setImmediate(resolve));
    expect(suspend).not.toHaveBeenCalled();

    const idle = service.createWorkflow('home', {});
    sessions.push({ id: 'session-idle', workflowId: idle.id, status: 'running' });
    activity['session-idle'] = 'idle';
    // The restart's own start fails here (no config in this context) and logs; the suspend is what matters.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', idle.id, 'mobile').when).toBe('now');
    await vi.waitFor(() => expect(suspend).toHaveBeenCalledWith('session-idle'));
    errorSpy.mockRestore();
  });

  describe('the restart for new read access', () => {
    /** Every call is a start the restart attempted: the start reads the config first, and finds the MCP server off. */
    let startAttempts: ReturnType<typeof vi.fn>;
    let manager: EventEmitter;

    beforeEach(() => {
      startAttempts = vi.fn(() => ({ mcpServer: { enabled: false }, agent: { cliPaths: {} } }));
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

    /** An idle running agent for a new workflow, owed a restart for `mobile`'s checkout. */
    function idleAgent(sessionId: string): string {
      const workflow = service.createWorkflow('home', {});
      sessions.push({ id: sessionId, workflowId: workflow.id, status: 'running' });
      activity[sessionId] = 'idle';
      return workflow.id;
    }

    it('suspends the agent and starts it again when nobody paused it (the control)', async () => {
      const workflowId = idleAgent('session-control');

      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      await vi.waitFor(() => expect(startAttempts).toHaveBeenCalledTimes(1));
      expect(suspend).toHaveBeenCalledWith('session-control');
    });

    it('does not suspend an agent whose turn began again before the restart ran, and restarts it at its next idle', async () => {
      const workflowId = idleAgent('session-reprompted');
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'mobile').when).toBe('now');

      // The user's prompt starts a turn in the tick between the idle edge and the restart.
      activity['session-reprompted'] = 'thinking';
      // The restart was queued first, so it has run by the time this resolves.
      await new Promise((resolve) => setImmediate(resolve));
      expect(suspend).not.toHaveBeenCalled();
      expect(startAttempts).not.toHaveBeenCalled();

      // The access is still owed: the turn's end restarts the agent.
      activity['session-reprompted'] = 'idle';
      manager.emit('activity', 'session-reprompted', 'idle');
      await vi.waitFor(() => expect(startAttempts).toHaveBeenCalledTimes(1));
      expect(suspend).toHaveBeenCalledWith('session-reprompted');
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
        // The retry's own start fails here (the MCP server is off) and logs; let it settle before the spy goes.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        errorSpy.mockRestore();
      }
    });

    describe('a restart whose start throws after the new agent is already running', () => {
      let spawn: ReturnType<typeof vi.fn>;
      const spies: Array<{ mockRestore: () => void }> = [];

      beforeEach(() => {
        // An adapter the start can use end to end: the real one probes the CLI and writes its trust file.
        const fakeAdapter = {
          name: 'claude',
          displayName: 'Claude Code',
          sessionType: 'claude_agent',
          supportsReadOnlyLaunch: true,
          supportsCallerSessionId: true,
          supportsReadableDirectories: true,
          detect: async () => ({ found: true, path: '/mock/bin/claude' }),
          ensureTrust: async () => undefined,
          buildCommand: () => 'mock-agent-command',
          getExitSequence: () => ['\x03'],
        };
        spies.push(vi.spyOn(agentRegistry, 'get').mockReturnValue(fakeAdapter as unknown as AgentAdapter));
        // The MCP server is on, so the start gets past its config check and to the spawn.
        startAttempts.mockReturnValue({ mcpServer: { enabled: true }, agent: { cliPaths: {} } });
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
        Object.assign(manager, { getShell: async () => 'bash', spawn });
      });

      afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
      });

      it('owes nothing, so the next idle edge leaves the running agent alone instead of stopping and spawning it again', async () => {
        const workflowId = idleAgent('session-before-restart');
        // A conversation to resume, so the start has no first message to build.
        new WorkflowRepository(homeDb()).setAgentConversation(workflowId, { agentName: 'claude', agentSessionId: 'conversation-1', cwd: paths.home });
        // The start's last step after its spawn fails: the new agent is already running.
        const startFailure = new Error('the conversation could not be recorded');
        spies.push(vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation').mockImplementation(() => {
          throw startFailure;
        }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        spies.push(errorSpy);

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
        // A restart runs a macrotask after the edge: the second lets one that was scheduled finish.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(suspend).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(startAttempts).toHaveBeenCalledTimes(1);
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
      await new Promise((resolve) => setImmediate(resolve));

      expect(startAttempts).not.toHaveBeenCalled();
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
      await new Promise((resolve) => setImmediate(resolve));

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
