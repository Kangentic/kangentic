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
 *
 * What a start records and what it reads back: a start-over that could not start
 * leaves the agent recorded, so the next open continues from the saved plan; an
 * id the agent reported while its spawn was awaited survives the start's own
 * write; a recorded agent with no id is not kept over the Workflow agent
 * setting; Kangentic's own id wins over a conversation the CLI would create; and
 * a reported id for a done workflow, a repeat, or a task's session changes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Every project `getProjectDb` was asked for: on main it creates a database that is not there. */
  getProjectDbCalls: [] as string[],
  adapter: null as unknown,
  /** An adapter registered under one name only, for a test where the agents differ. Every other name gets `adapter`. */
  adapterByName: new Map<string, unknown>(),
  notifyWorkflowChanged: vi.fn(),
  /** The retrieval worker's `call`, where the agent's turn tokens are indexed from. */
  retrievalCall: vi.fn(async (_method: string, _params: unknown) => ({ outcome: 'indexed' })),
  /** Settings > Workflows > Workflow agent, as `getEffectiveConfig` returns it. */
  workflows: {} as { agent?: string | null; model?: string | null; effort?: string | null },
  /** What the saved-plan message builder answers after a start-over: null when the workflow has no saved plan. */
  continueMessage: 'CONTINUE MESSAGE' as string | null,
  /** What it answers for a plan another session saved: null by default, as for a workflow with nothing saved. */
  savedElsewhereMessage: null as string | null,
  /** The reason each call to the saved-plan message builder gave. */
  continueReasons: [] as string[],
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
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: (name: string) => harness.adapterByName.get(name) ?? harness.adapter, list: () => [] },
}));
// The cached agent inventory the Workflow agent setting is checked against:
// Claude and OpenCode can be a workflow's agent (OpenCode takes no model flag),
// Codex is installed but, here, cannot.
vi.mock('../../src/main/agent/agent-list', () => ({
  listAgents: async () => [
    { name: 'claude', found: true, supportsWorkflowAgent: true, capabilities: { supportsModelOverride: true } },
    { name: 'opencode', found: true, supportsWorkflowAgent: true, capabilities: {} },
    { name: 'cursor', found: true, supportsWorkflowAgent: true, capabilities: {} },
    { name: 'codex', found: true, supportsWorkflowAgent: false, capabilities: { supportsModelOverride: true } },
  ],
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: harness.retrievalCall } }));
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: async (options: { agentPath: string; prompt?: string }) => ({ agentPath: options.agentPath, prompt: options.prompt }),
}));
vi.mock('../../src/main/workflows/workflow-agent-prompt', () => ({
  buildWorkflowAgentFirstMessage: () => 'FIRST MESSAGE',
  buildWorkflowAgentContinueMessage: async (_context: unknown, _homeProjectId: string, _workflow: unknown, _template: string, reason: string) => {
    harness.continueReasons.push(reason);
    return reason === 'saved-elsewhere' ? harness.savedElsewhereMessage : harness.continueMessage;
  },
}));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: harness.notifyWorkflowChanged,
  notifyWorkflowOfTask: vi.fn(),
  setWorkflowChangedWindow: vi.fn(),
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const agent = await import('../../src/main/workflows/workflow-agent');
const agentEffort = await import('../../src/main/workflows/workflow-agent-effort');

import { openTestDatabase } from './helpers/test-database';
import { canBeWorkflowAgent } from '../../src/main/agent/shared/workflow-agent-capability';
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
  agentSessionId: string | null;
}

/** The slice of SessionManager the workflow agent drives. */
class FakeSessionManager extends EventEmitter {
  sessions: FakeSession[] = [];
  /** The agent every session runs, as `getSessionAgentName` answers. */
  agentName = 'claude';
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
    return this.agentName;
  }
  getSessionCliTarget(): null {
    return null;
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
    harness.getProjectDbCalls.length = 0;
    harness.adapterByName.clear();
    harness.notifyWorkflowChanged.mockReset();
    harness.retrievalCall.mockClear();
    harness.continueMessage = 'CONTINUE MESSAGE';
    harness.savedElsewhereMessage = null;
    harness.continueReasons.length = 0;
    describeStartupFailure = vi.fn(() => true);
    harness.adapter = {
      name: 'claude',
      displayName: 'Claude Code',
      sessionType: 'claude_agent',
      kangenticMcp: 'per-session',
      supportsReadOnlyLaunch: true,
      supportsCallerSessionId: true,
      supportsReadableDirectories: false,
      detect: vi.fn(async () => ({ found: true, path: '/mock/bin/claude' })),
      ensureTrust: vi.fn(async () => undefined),
      buildCommand: vi.fn(() => 'mock-agent-command'),
      removeHooks: vi.fn(),
      getExitSequence: () => ['\x03'],
      describeStartupFailure,
    };
    const projects = [{ id: 'home', name: 'kangentic', path: home, default_agent: null, default_model: null, default_effort: null }];
    harness.workflows = { agent: 'claude', model: 'haiku', effort: null };
    manager = new FakeSessionManager();
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: manager,
      configManager: {
        load: () => ({}),
        getEffectiveConfig: () => ({ mcpServer: { enabled: true }, agent: { cliPaths: {} }, workflows: harness.workflows }),
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

  /** A new workflow, with no agent and no conversation recorded. */
  function newWorkflow(): string {
    return new WorkflowRepository(harness.dbs.get('home') as Database.Database).create({ title: 'Release notes' }).id;
  }

  /** One planned task, as kangentic_save_workflow stores it. */
  const PLANNED_TASK = {
    key: 'task-1', title: 'Token table', description: 'Planned in a Command Terminal.', project_id: null, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], labels: [], priority: 0,
    canvas_x: null, canvas_y: null,
  };

  /** A workflow another session created and planned over MCP: a saved draft, and no agent recorded. */
  function plannedElsewhere(): string {
    const repository = new WorkflowRepository(harness.dbs.get('home') as Database.Database);
    const id = repository.create({ title: 'Clear stale push notifications' }).id;
    repository.saveDraft(id, { tasks: [PLANNED_TASK], links: [] });
    return id;
  }

  /** The agent and conversation id the workflow row records. */
  function recordedConversation(id: string): { agent_name: string | null; agent_session_id: string | null } {
    const workflow = new WorkflowRepository(harness.dbs.get('home') as Database.Database).getById(id)!;
    return { agent_name: workflow.agent_name, agent_session_id: workflow.agent_session_id };
  }

  /**
   * Make `adapter` the Workflow agent: registered under `name`, chosen in the
   * Workflow agent setting with no model or effort, and the agent the fake
   * manager reports for every session.
   */
  function becomeWorkflowAgent(name: string, adapter: unknown): void {
    harness.adapterByName.set(name, adapter);
    harness.workflows = { agent: name, model: null, effort: null };
    manager.agentName = name;
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

  // Before, the start-over sent only the template's first message, and an agent
  // that planned from the brief again saved over the plan the user had shaped
  // (a save replaces the whole plan). It now starts from the saved plan.
  it('starts the new conversation from the saved plan', async () => {
    await resumeThatFails();

    const buildCommand = (harness.adapter as { buildCommand: ReturnType<typeof vi.fn> }).buildCommand;
    expect(buildCommand.mock.calls[1][0]).toMatchObject({ resume: false, prompt: 'CONTINUE MESSAGE' });
    expect(harness.continueReasons).toEqual(['not-resumed']);
  });

  it('sends the first message when nothing is saved yet to continue from', async () => {
    harness.continueMessage = null;
    await resumeThatFails();

    const buildCommand = (harness.adapter as { buildCommand: ReturnType<typeof vi.fn> }).buildCommand;
    expect(buildCommand.mock.calls[1][0]).toMatchObject({ resume: false, prompt: 'FIRST MESSAGE' });
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

  // A resume the CLI cannot find forgets only the conversation id, never the
  // agent that ran (`forgetAgentSessionId`). When the start-over that follows
  // cannot start either, the row keeps saying an agent ran, so the next open
  // still continues from the saved plan. Before, the failed resume cleared the
  // whole record and that open sent the plain first message, which an agent
  // that planned from the brief again would save over the user's plan.
  describe('a start-over that could not start', () => {
    /** What stops the replacement start, and the way to undo it. */
    const causes: Array<{ name: string; stopStarts: (target: IpcContext) => () => void }> = [
      {
        name: 'the MCP server is off',
        stopStarts: (target) => {
          const serverHandle = target.mcpServerHandle;
          target.mcpServerHandle = null;
          return () => {
            target.mcpServerHandle = serverHandle;
          };
        },
      },
      {
        name: 'the Workflow agent setting is not complete',
        stopStarts: () => {
          const setting = harness.workflows;
          harness.workflows = {};
          return () => {
            harness.workflows = setting;
          };
        },
      },
    ];

    it.each(causes)('keeps the agent recorded, and continues from the saved plan on the next open, when $name', async ({ stopStarts }) => {
      const resumed = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      expect(resumed.session?.resuming).toBe(true);
      const fixCause = stopStarts(context);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      manager.exitOnItsOwn(resumed.session!.id);

      // The conversation the CLI could not find is forgotten as the start-over begins.
      await vi.waitFor(() => expect(recordedConversation(workflowId).agent_session_id).toBeNull());
      // The replacement start is refused through microtasks only: one macrotask lets it
      // end and leave the opening map, so the open below is a start of its own, not a join.
      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(recordedConversation(workflowId)).toEqual({ agent_name: 'claude', agent_session_id: null });

      fixCause();
      const reopened = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(reopened.session?.resuming).toBe(false);
      const buildCommand = (harness.adapter as { buildCommand: ReturnType<typeof vi.fn> }).buildCommand;
      // The refused start never built a command: the resume and this open are the two.
      expect(buildCommand).toHaveBeenCalledTimes(2);
      expect(buildCommand.mock.calls[1][0]).toMatchObject({ resume: false, prompt: 'CONTINUE MESSAGE' });
      expect(agent.workflowAgentSummary(context, workflowId)).toMatchObject({ startedOverSessionId: reopened.session!.id });
      agentEffort.forgetWorkflowAgentEffort(reopened.session!.id);
    });
  });

  // The bug: a plan saved with kangentic_save_workflow from a Command Terminal
  // has no agent recorded, so the view's first open started a new agent with
  // the planning prompt, which held Start for its whole turn and could save over
  // the finished plan. That open now starts nothing, and Ask for changes (the
  // pane's Resume path) starts the agent on the saved plan.
  describe('a plan another session saved', () => {
    const buildCommandOf = () => (harness.adapter as { buildCommand: ReturnType<typeof vi.fn> }).buildCommand;

    it('starts nothing on open, before the CLI is even looked for', async () => {
      const id = plannedElsewhere();
      const detect = (harness.adapter as { detect: ReturnType<typeof vi.fn> }).detect;

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(status).toEqual({ session: null, unavailable: null, setupNeeded: false, startsOnRequest: true });
      expect(detect).not.toHaveBeenCalled();
      expect(manager.spawn).not.toHaveBeenCalled();
      expect(recordedConversation(id)).toEqual({ agent_name: null, agent_session_id: null });
    });

    it('starts nothing on open once it was started from that session too, while its tasks are on a board', async () => {
      const homeDb = harness.dbs.get('home') as Database.Database;
      const repository = new WorkflowRepository(homeDb);
      const id = repository.create({ title: 'Clear stale push notifications' }).id;
      repository.markStarted(id);
      const todo = new SwimlaneRepository(homeDb).list().find((lane) => lane.role === 'todo')!;
      new TaskRepository(homeDb).create({
        title: 'Token table',
        description: '',
        swimlane_id: todo.id,
        workflow: {
          workflow_id: id, workflow_project_id: 'home', route_start_swimlane_id: null, route_last_swimlane_id: null,
          skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
        },
      });

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(status.startsOnRequest).toBe(true);
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    // The control: the plan is what tells the two apart, so a workflow made in
    // the view, which has no tasks until its agent plans, still starts on open.
    it('still starts a workflow with no tasks yet on open, with the first message', async () => {
      const id = newWorkflow();

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(status.startsOnRequest).toBe(false);
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(buildCommandOf().mock.calls[0][0]).toMatchObject({ resume: false, prompt: 'FIRST MESSAGE' });
      // Every start that is not a resume asks the builder for the saved plan, and
      // names no lost conversation: with nothing saved it answers null, and the
      // plain first message goes out.
      expect(harness.continueReasons).toEqual(['saved-elsewhere']);
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    // A finished workflow has nothing to plan: its board tasks do not make it
    // one that awaits an agent. The sibling above, with the same seed and not
    // finished, answers `startsOnRequest`, so the `done` state is the only thing
    // sending this open on to the start, which refuses it.
    it('does not hold a finished workflow back for an agent, though its tasks are on a board', async () => {
      const homeDb = harness.dbs.get('home') as Database.Database;
      const repository = new WorkflowRepository(homeDb);
      const id = repository.create({ title: 'Clear stale push notifications' }).id;
      repository.markStarted(id);
      const todo = new SwimlaneRepository(homeDb).list().find((lane) => lane.role === 'todo')!;
      new TaskRepository(homeDb).create({
        title: 'Token table',
        description: '',
        swimlane_id: todo.id,
        workflow: {
          workflow_id: id, workflow_project_id: 'home', route_start_swimlane_id: null, route_last_swimlane_id: null,
          skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
        },
      });
      repository.setState(id, 'done');
      const detect = (harness.adapter as { detect: ReturnType<typeof vi.fn> }).detect;

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(status.startsOnRequest).toBe(false);
      expect(status.session).toBeNull();
      expect(status.unavailable).toContain('is complete');
      expect(manager.spawn).not.toHaveBeenCalled();
      // The start refused it before it looked for the CLI.
      expect(detect).not.toHaveBeenCalled();
    });

    it('starts on the saved plan when the user asks, says nothing about starting over, and resumes after that', async () => {
      harness.savedElsewhereMessage = 'SAVED ELSEWHERE MESSAGE';
      const id = plannedElsewhere();
      await agent.openWorkflowAgent(context, 'home', id, {});

      const asked = await agent.resumeWorkflowAgent(context, 'home', id, {});

      expect(asked).toMatchObject({ unavailable: null, setupNeeded: false, startsOnRequest: false });
      expect(buildCommandOf()).toHaveBeenCalledTimes(1);
      expect(buildCommandOf().mock.calls[0][0]).toMatchObject({ resume: false, prompt: 'SAVED ELSEWHERE MESSAGE' });
      expect(harness.continueReasons).toEqual(['saved-elsewhere']);
      // Nothing was lost, so the pane has no "started a new one" line to show.
      expect(agent.workflowAgentSummary(context, id)?.startedOverSessionId).toBeNull();
      expect(harness.notifyWorkflowChanged).not.toHaveBeenCalledWith('home', id);

      // The agent is recorded now, so an open after a restart resumes its conversation.
      expect(recordedConversation(id).agent_name).toBe('claude');
      await agent.pauseWorkflowAgent(context, id);
      manager.sessions = [];
      const reopened = await agent.openWorkflowAgent(context, 'home', id, {});
      expect(reopened.session?.resuming).toBe(true);
      agentEffort.forgetWorkflowAgentEffort(asked.session!.id);
      agentEffort.forgetWorkflowAgentEffort(reopened.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    // Ask for changes, then the pane remounts (a quick trip to the board and
    // back) while the agent is still spawning: there is no session and no
    // recorded agent yet, and an open must not bring the notice back.
    it('joins the start Ask for changes began, when the pane opens again before it spawned', async () => {
      const id = plannedElsewhere();
      let finishSpawn!: () => void;
      const spawnGate = new Promise<void>((resolve) => {
        finishSpawn = resolve;
      });
      const spawnImmediately = manager.spawn.getMockImplementation()!;
      manager.spawn.mockImplementationOnce(async (options: SpawnOptions) => {
        await spawnGate;
        return spawnImmediately(options);
      });
      const asked = agent.resumeWorkflowAgent(context, 'home', id, {});
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1));

      const reopened = agent.openWorkflowAgent(context, 'home', id, {});
      finishSpawn();
      const [askedStatus, reopenedStatus] = await Promise.all([asked, reopened]);

      expect(reopenedStatus.startsOnRequest).toBe(false);
      expect(reopenedStatus.session?.id).toBe(askedStatus.session!.id);
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      agentEffort.forgetWorkflowAgentEffort(askedStatus.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    // The Pause lands while the start is spawning, when there is no agent to
    // stop, so it only records itself. The pane then reopens and joins that
    // start: an open that cleared the Pause on its way in would leave the agent
    // running that the user had just stopped.
    it('keeps a Pause pressed during the start it joins: the agent that spawns ends suspended', async () => {
      const id = plannedElsewhere();
      let finishSpawn!: () => void;
      const spawnGate = new Promise<void>((resolve) => {
        finishSpawn = resolve;
      });
      const spawnImmediately = manager.spawn.getMockImplementation()!;
      manager.spawn.mockImplementationOnce(async (options: SpawnOptions) => {
        await spawnGate;
        return spawnImmediately(options);
      });
      const asked = agent.resumeWorkflowAgent(context, 'home', id, {});
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1));

      // No session exists yet: the Pause stops nothing and is only recorded.
      await agent.pauseWorkflowAgent(context, id);
      expect(manager.suspend).not.toHaveBeenCalled();
      // Not awaited, since it returns the start that is waiting on the spawn.
      const reopened = agent.openWorkflowAgent(context, 'home', id, {});
      finishSpawn();
      const [askedStatus, reopenedStatus] = await Promise.all([asked, reopened]);

      const spawnedId = askedStatus.session!.id;
      expect(reopenedStatus.session?.id).toBe(spawnedId);
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(manager.suspend).toHaveBeenCalledTimes(1);
      expect(manager.suspend).toHaveBeenCalledWith(spawnedId);
      expect(manager.getSession(spawnedId)?.status).toBe('suspended');
      expect(agent.workflowAgentSummary(context, id)).toMatchObject({ state: 'paused' });
      agentEffort.forgetWorkflowAgentEffort(spawnedId);
      await agent.endWorkflowAgent(context, id);
    });
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

  // The bug: with the Automation agent on Haiku at low, a new workflow's agent
  // started on Opus at xhigh, the project's default. The workflow agent now runs
  // on its own setting (Settings > Workflows > Workflow agent), with no fallback,
  // and nothing starts until that setting is complete.
  describe('the Workflow agent setting', () => {
    function buildCommandOptions(callIndex: number): { model?: string; effort?: string; resume: boolean } {
      const buildCommand = (harness.adapter as { buildCommand: ReturnType<typeof vi.fn> }).buildCommand;
      return buildCommand.mock.calls[callIndex][0] as { model?: string; effort?: string; resume: boolean };
    }

    it.each([
      { name: 'no agent is chosen', workflows: {} },
      { name: 'the agent takes a model and none is chosen', workflows: { agent: 'claude', model: null } },
      { name: 'the chosen agent is not one that can be a workflow agent', workflows: { agent: 'codex', model: 'gpt-5' } },
    ])('starts nothing and asks for the setting when $name', async ({ workflows }) => {
      harness.workflows = workflows;
      const detect = (harness.adapter as { detect: ReturnType<typeof vi.fn> }).detect;

      const status = await agent.openWorkflowAgent(context, 'home', newWorkflow(), {});

      expect(status).toEqual({ session: null, unavailable: null, setupNeeded: true, startsOnRequest: false });
      expect(detect).not.toHaveBeenCalled();
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it('starts a new workflow on the chosen model and effort, not the project default', async () => {
      const project = context.projectRepo.getById('home') as unknown as { default_model: string; default_effort: string };
      project.default_model = 'opus';
      project.default_effort = 'xhigh';
      harness.workflows = { agent: 'claude', model: 'haiku', effort: 'low' };

      const status = await agent.openWorkflowAgent(context, 'home', newWorkflow(), {});

      expect(status.setupNeeded).toBe(false);
      expect(buildCommandOptions(0)).toMatchObject({ resume: false, model: 'haiku', effort: 'low' });
      expect(agentEffort.workflowAgentEffort(status.session!.id)).toBe('low');
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
    });

    it('runs at the CLI\'s own effort when none is chosen', async () => {
      harness.workflows = { agent: 'claude', model: 'haiku', effort: null };

      const status = await agent.openWorkflowAgent(context, 'home', newWorkflow(), {});

      expect(buildCommandOptions(0).model).toBe('haiku');
      expect(buildCommandOptions(0).effort).toBeUndefined();
      expect(agentEffort.workflowAgentEffort(status.session!.id)).toBeNull();
    });

    it('resumes a paused agent on the setting as it is now, so a change reaches the next start', async () => {
      harness.workflows = { agent: 'claude', model: 'haiku', effort: 'low' };
      const first = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      expect(buildCommandOptions(0)).toMatchObject({ resume: true, model: 'haiku', effort: 'low' });

      await agent.pauseWorkflowAgent(context, workflowId);
      harness.workflows = { agent: 'claude', model: 'sonnet', effort: 'medium' };
      const second = await agent.resumeWorkflowAgent(context, 'home', workflowId, {});

      expect(buildCommandOptions(1)).toMatchObject({ resume: true, model: 'sonnet', effort: 'medium' });
      agentEffort.forgetWorkflowAgentEffort(first.session!.id);
      agentEffort.forgetWorkflowAgentEffort(second.session!.id);
    });

    it('leaves a paused agent paused when the setting is no longer complete', async () => {
      await agent.openWorkflowAgent(context, 'home', workflowId, {});
      await agent.pauseWorkflowAgent(context, workflowId);
      harness.workflows = {};

      const resumed = await agent.resumeWorkflowAgent(context, 'home', workflowId, {});

      expect(resumed).toEqual({ session: null, unavailable: null, setupNeeded: true, startsOnRequest: false });
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(agent.findWorkflowAgentSession(context, workflowId)?.status).toBe('suspended');
    });

    /** The harness adapter with its own name and spies, registered under `agentName` only. */
    function registerAdapterFor(agentName: string, displayName: string, overrides: Record<string, unknown> = {}) {
      const adapter = {
        ...(harness.adapter as Record<string, unknown>),
        name: agentName,
        displayName,
        detect: vi.fn(async () => ({ found: true, path: `/mock/bin/${agentName}` })),
        ensureTrust: vi.fn(async () => undefined),
        buildCommand: vi.fn((_options: unknown) => `mock-${agentName}-command`),
        ...overrides,
      };
      harness.adapterByName.set(agentName, adapter);
      return adapter;
    }

    /** Record the workflow's conversation as held by `agentName`, as a start does after it spawns. */
    function recordConversationOn(agentName: string, agentSessionId: string): void {
      new WorkflowRepository(harness.dbs.get('home') as Database.Database)
        .setAgentConversation(workflowId, { agentName, agentSessionId, cwd: path.join(root, 'home') });
    }

    // A conversation belongs to the agent that holds it, so a resume keeps that
    // agent after the Workflow agent setting changed to another. The setting's
    // model and effort are that setting's agent's (a model id means nothing to
    // another CLI), so the kept agent runs at its own defaults.
    it('resumes a conversation kept on another agent at that agent\'s own model and effort, not the setting\'s', async () => {
      harness.workflows = { agent: 'claude', model: 'haiku', effort: 'low' };
      const keptAgent = registerAdapterFor('gemini', 'Gemini CLI');
      recordConversationOn('gemini', 'conv-gemini');
      const settingAgent = harness.adapter as { buildCommand: ReturnType<typeof vi.fn> };

      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status).toMatchObject({ unavailable: null, setupNeeded: false, startsOnRequest: false });
      // The recorded agent's adapter built the command, on its own conversation.
      expect(settingAgent.buildCommand).not.toHaveBeenCalled();
      expect(keptAgent.buildCommand).toHaveBeenCalledTimes(1);
      const options = keptAgent.buildCommand.mock.calls[0][0] as { model?: string; effort?: string; resume: boolean; sessionId: string };
      expect(options.resume).toBe(true);
      expect(options.sessionId).toBe('conv-gemini');
      expect(options.model).toBeUndefined();
      expect(options.effort).toBeUndefined();
      // Stats reads the effort the agent started with back: none was passed.
      expect(agentEffort.workflowAgentEffort(status.session!.id)).toBeNull();
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
    });

    // Before, a conversation kept on an agent that could no longer be a
    // workflow's agent was a dead end ("Plan this workflow on the canvas"). Now
    // the setting's agent starts a new conversation from the saved plan.
    it.each([
      { name: 'reaches the MCP server through a folder-shared file', flags: { kangenticMcp: 'shared-folder', supportsCallerSessionId: true } },
      { name: 'does not reach the MCP server', flags: { kangenticMcp: undefined, supportsCallerSessionId: true } },
      { name: 'cannot resume its conversation', flags: { kangenticMcp: 'per-session', supportsCallerSessionId: false, capturesInteractiveSessionId: undefined } },
    ])('starts a new conversation on the setting\'s agent when the kept one $name', async ({ flags }) => {
      const keptAgent = registerAdapterFor('codex', 'Codex CLI', flags);
      recordConversationOn('codex', 'conv-codex');
      const settingAgent = harness.adapter as { buildCommand: ReturnType<typeof vi.fn> };

      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status).toMatchObject({ unavailable: null, setupNeeded: false, startsOnRequest: false });
      expect(keptAgent.buildCommand).not.toHaveBeenCalled();
      expect(settingAgent.buildCommand.mock.calls[0][0]).toMatchObject({ resume: false, prompt: 'CONTINUE MESSAGE' });
      expect(agent.workflowAgentSummary(context, workflowId)?.startedOverSessionId).toBe(status.session!.id);
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
    });

    // The id is what makes a conversation one to resume. A row that names an
    // agent but holds no id (never captured, or forgotten after a resume the CLI
    // could not find) is not kept on that agent, even one that could be a workflow
    // agent: the setting's agent starts a new conversation from the saved plan.
    it('starts a new conversation on the setting\'s agent, not the recorded one, when the recorded agent has no id', async () => {
      harness.workflows = { agent: 'claude', model: 'haiku', effort: null };
      const recordedAgent = registerAdapterFor('gemini', 'Gemini CLI');
      // The recorded agent could keep the conversation, were there an id to resume.
      expect(canBeWorkflowAgent(recordedAgent as unknown as Parameters<typeof canBeWorkflowAgent>[0])).toBe(true);
      new WorkflowRepository(harness.dbs.get('home') as Database.Database)
        .setAgentConversation(workflowId, { agentName: 'gemini', agentSessionId: null, cwd: path.join(root, 'home') });
      const settingAgent = harness.adapter as { buildCommand: ReturnType<typeof vi.fn> };

      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

      expect(status).toMatchObject({ unavailable: null, setupNeeded: false, startsOnRequest: false });
      expect(recordedAgent.buildCommand).not.toHaveBeenCalled();
      expect(settingAgent.buildCommand).toHaveBeenCalledTimes(1);
      expect(settingAgent.buildCommand.mock.calls[0][0]).toMatchObject({ resume: false, prompt: 'CONTINUE MESSAGE', model: 'haiku' });
      expect(manager.spawn.mock.calls[0][0]).toMatchObject({ resuming: false, agentName: 'claude' });
      // The row now names the agent that ran, with the new conversation's id.
      expect(recordedConversation(workflowId)).toEqual({ agent_name: 'claude', agent_session_id: manager.spawn.mock.calls[0][0].agentSessionId });
      expect(agent.workflowAgentSummary(context, workflowId)?.startedOverSessionId).toBe(status.session!.id);
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
    });

    // Grok loads Kangentic's tools only in a folder its user trusted in Grok: an
    // agent started there anyway could not save a plan, so the start says why.
    it('starts nothing and says why when the agent would not reach Kangentic\'s tools in this folder', async () => {
      const reason = 'Grok Build loads Kangentic\'s tools only in a folder you have trusted in it.';
      (harness.adapter as Record<string, unknown>).kangenticMcpBlockedReason = () => reason;

      const status = await agent.openWorkflowAgent(context, 'home', newWorkflow(), {});

      expect(status).toEqual({ session: null, unavailable: reason, setupNeeded: false, startsOnRequest: false });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it('launches read-only where the adapter declares it', async () => {
      const status = await agent.openWorkflowAgent(context, 'home', newWorkflow(), {});

      expect(buildCommandOptions(0)).toMatchObject({ readOnly: true });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
    });
  });

  // Any agent that reaches Kangentic's MCP server with a URL of its own and can
  // resume its conversation can be the Workflow agent. One that cannot launch
  // read-only runs in its own default mode (the prompt asks it to leave files
  // alone), and one that picks its own session id has it captured after launch.
  describe('an agent that is not read-only and picks its own session id', () => {
    let openCodeAdapter: { buildCommand: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      openCodeAdapter = {
        ...(harness.adapter as Record<string, unknown>),
        name: 'opencode',
        displayName: 'OpenCode',
        sessionType: 'opencode_agent',
        kangenticMcp: 'per-session',
        supportsReadOnlyLaunch: undefined,
        supportsCallerSessionId: false,
        capturesInteractiveSessionId: true,
        detect: vi.fn(async () => ({ found: true, path: '/mock/bin/opencode' })),
        ensureTrust: vi.fn(async () => undefined),
        buildCommand: vi.fn((_options: unknown) => 'mock-opencode-command'),
        describeStartupFailure: undefined,
      } as unknown as { buildCommand: ReturnType<typeof vi.fn> };
      becomeWorkflowAgent('opencode', openCodeAdapter);
    });

    it('starts in its default mode with no session id, and records the agent with no id yet', async () => {
      const id = newWorkflow();

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      const options = openCodeAdapter.buildCommand.mock.calls[0][0] as { readOnly: boolean; sessionId?: string; permissionMode: string; prompt: string };
      expect(options.readOnly).toBe(false);
      expect(options.permissionMode).toBe('default');
      expect(options.sessionId).toBeUndefined();
      expect(options.prompt).toBe('FIRST MESSAGE');
      expect(manager.spawn.mock.calls[0][0].agentSessionId).toBeNull();
      expect(recordedConversation(id)).toEqual({ agent_name: 'opencode', agent_session_id: null });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    it('records the id the agent reports after launch, so the next start resumes it', async () => {
      const id = newWorkflow();
      const status = await agent.openWorkflowAgent(context, 'home', id, {});
      harness.notifyWorkflowChanged.mockClear();

      manager.emit('agent-session-id', status.session!.id, id, 'home', 'ses_reported');

      expect(recordedConversation(id)).toEqual({ agent_name: 'opencode', agent_session_id: 'ses_reported' });
      expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', id);

      await agent.pauseWorkflowAgent(context, id);
      await agent.resumeWorkflowAgent(context, 'home', id, {});
      expect(openCodeAdapter.buildCommand.mock.calls[1][0]).toMatchObject({ resume: true, sessionId: 'ses_reported' });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    // The start's write of the conversation comes after its spawn is awaited. An
    // id the agent reported in that window is on the live row already, so the
    // write reads it back, and a null from the start would lose the conversation.
    it.each([
      { name: 'sits on its session row', announced: false },
      { name: 'was also announced to the lifecycle listener', announced: true },
    ])('keeps the id the agent reported while its spawn was awaited, when it $name', async ({ announced }) => {
      const id = newWorkflow();
      const spawnImmediately = manager.spawn.getMockImplementation()!;
      manager.spawn.mockImplementationOnce(async (options: SpawnOptions) => {
        const registered = await spawnImmediately(options);
        // The real spawn resolves with a snapshot taken before the agent has an id.
        const snapshot = { ...registered };
        manager.getSession(registered.id)!.agentSessionId = 'ses_during_spawn';
        if (announced) manager.emit('agent-session-id', registered.id, id, 'home', 'ses_during_spawn');
        return snapshot;
      });

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      // The adapter gave the start no id to spawn with: the one recorded came from the agent.
      expect(manager.spawn.mock.calls[0][0].agentSessionId).toBeNull();
      expect(recordedConversation(id)).toEqual({ agent_name: 'opencode', agent_session_id: 'ses_during_spawn' });
      await agent.pauseWorkflowAgent(context, id);
      const resumed = await agent.resumeWorkflowAgent(context, 'home', id, {});
      expect(openCodeAdapter.buildCommand.mock.calls[1][0]).toMatchObject({ resume: true, sessionId: 'ses_during_spawn' });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      agentEffort.forgetWorkflowAgentEffort(resumed.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    it('ignores a report from a session the workflow has replaced', async () => {
      const id = newWorkflow();
      const first = await agent.openWorkflowAgent(context, 'home', id, {});
      await agent.pauseWorkflowAgent(context, id);
      await agent.resumeWorkflowAgent(context, 'home', id, {});
      // The paused first session's row is replaced; a late report from it names a conversation the workflow left.
      manager.sessions = manager.sessions.filter((session) => session.id !== first.session!.id || session.status !== 'suspended');
      manager.sessions.push({ ...manager.getSession('pty-spawned-2')!, id: first.session!.id, status: 'exited' });

      manager.emit('agent-session-id', first.session!.id, id, 'home', 'ses_stale');

      expect(recordedConversation(id).agent_session_id).not.toBe('ses_stale');
      await agent.endWorkflowAgent(context, id);
    });

    it('continues from the saved plan when its id was never captured', async () => {
      const id = newWorkflow();
      await agent.openWorkflowAgent(context, 'home', id, {});
      // Paused before the agent reported its id: there is no conversation to resume.
      await agent.pauseWorkflowAgent(context, id);

      const resumed = await agent.resumeWorkflowAgent(context, 'home', id, {});

      expect(openCodeAdapter.buildCommand.mock.calls[1][0]).toMatchObject({ resume: false, prompt: 'CONTINUE MESSAGE' });
      // Main's spawn drains the paused row it replaces; the fake keeps it, and the summary would read it first.
      manager.sessions = manager.sessions.filter((session) => session.status !== 'suspended');
      expect(agent.workflowAgentSummary(context, id)?.startedOverSessionId).toBe(resumed.session!.id);
      await agent.endWorkflowAgent(context, id);
    });
  });

  // An agent that takes no id of Kangentic's and prints none in a terminal, but
  // can create an empty conversation before launch and name it (Cursor's
  // `create-chat`): the start opens that conversation, so its id is known from
  // the first moment, as a caller-chosen one is.
  describe('an agent that creates its conversation before launch', () => {
    interface CreatedAgent {
      buildCommand: ReturnType<typeof vi.fn>;
      createSessionId: ReturnType<typeof vi.fn>;
      supportsCallerSessionId: boolean;
    }
    let createdAgent: CreatedAgent;

    beforeEach(() => {
      createdAgent = {
        ...(harness.adapter as Record<string, unknown>),
        name: 'cursor',
        displayName: 'Cursor CLI',
        sessionType: 'cursor_agent',
        kangenticMcp: 'per-session',
        supportsReadOnlyLaunch: undefined,
        supportsCallerSessionId: false,
        capturesInteractiveSessionId: undefined,
        createSessionId: vi.fn(async (_cliPath: string, _workingDirectory: string): Promise<string | null> => 'chat-created'),
        detect: vi.fn(async () => ({ found: true, path: '/mock/bin/cursor-agent' })),
        ensureTrust: vi.fn(async () => undefined),
        buildCommand: vi.fn((_options: unknown) => 'mock-cursor-command'),
        describeStartupFailure: undefined,
      } as unknown as CreatedAgent;
      becomeWorkflowAgent('cursor', createdAgent);
    });

    it('creates the conversation in the project folder and starts in it with the first message', async () => {
      const id = newWorkflow();

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(createdAgent.createSessionId).toHaveBeenCalledWith('/mock/bin/cursor-agent', path.join(root, 'home'));
      expect(createdAgent.buildCommand.mock.calls[0][0]).toMatchObject({ resume: false, sessionId: 'chat-created', prompt: 'FIRST MESSAGE' });
      expect(manager.spawn.mock.calls[0][0].agentSessionId).toBe('chat-created');
      expect(recordedConversation(id)).toEqual({ agent_name: 'cursor', agent_session_id: 'chat-created' });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    it('resumes the created conversation after a Pause without creating another', async () => {
      const id = newWorkflow();
      const status = await agent.openWorkflowAgent(context, 'home', id, {});
      await agent.pauseWorkflowAgent(context, id);

      await agent.resumeWorkflowAgent(context, 'home', id, {});

      expect(createdAgent.createSessionId).toHaveBeenCalledTimes(1);
      expect(createdAgent.buildCommand.mock.calls[1][0]).toMatchObject({ resume: true, sessionId: 'chat-created' });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    // Kangentic's own id is the safest way, so an agent that offers both takes it:
    // creating a conversation first would spend a CLI call to get an id that the
    // start already has.
    it('uses an id of Kangentic\'s own, and creates no conversation, when the CLI takes one too', async () => {
      createdAgent.supportsCallerSessionId = true;
      const id = newWorkflow();

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(createdAgent.createSessionId).not.toHaveBeenCalled();
      const spawnedId = manager.spawn.mock.calls[0][0].agentSessionId;
      expect(spawnedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(spawnedId).not.toBe('chat-created');
      expect(createdAgent.buildCommand.mock.calls[0][0]).toMatchObject({ resume: false, sessionId: spawnedId });
      expect(recordedConversation(id)).toEqual({ agent_name: 'cursor', agent_session_id: spawnedId });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });

    it('starts with no id when the CLI could not create one', async () => {
      createdAgent.createSessionId.mockResolvedValueOnce(null);
      const id = newWorkflow();

      const status = await agent.openWorkflowAgent(context, 'home', id, {});

      expect(createdAgent.buildCommand.mock.calls[0][0]).toMatchObject({ resume: false, sessionId: undefined });
      expect(recordedConversation(id)).toEqual({ agent_name: 'cursor', agent_session_id: null });
      agentEffort.forgetWorkflowAgentEffort(status.session!.id);
      await agent.endWorkflowAgent(context, id);
    });
  });

  // A Claude conversation forked by `/clear` reports its new id through the
  // status file. The workflow used to keep the old one, so a Resume reopened
  // the conversation from before the `/clear`.
  it('records the new conversation a Claude /clear fork reports', async () => {
    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

    manager.emit('agent-session-id', status.session!.id, workflowId, 'home', 'conv-forked');

    const workflow = new WorkflowRepository(harness.dbs.get('home') as Database.Database).getById(workflowId)!;
    expect(workflow.agent_session_id).toBe('conv-forked');
    expect(workflow.agent_name).toBe('claude');
  });

  // The listener writes a reported id only to a live workflow's own agent row
  // and only when it is news. Anything else leaves the workflow row and the
  // pane's push alone.
  describe('a reported conversation id that changes nothing', () => {
    function reportConversation(sessionId: string, taskId: string, agentSessionId: string): void {
      manager.emit('agent-session-id', sessionId, taskId, 'home', agentSessionId);
    }

    it('is ignored for a workflow that is done', async () => {
      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      new WorkflowRepository(harness.dbs.get('home') as Database.Database).setState(workflowId, 'done');
      harness.notifyWorkflowChanged.mockClear();

      reportConversation(status.session!.id, workflowId, 'conv-after-done');

      expect(recordedConversation(workflowId)).toEqual({ agent_name: 'claude', agent_session_id: 'conv-gone' });
      expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
    });

    it('is not written, nor pushed to the pane, when it is the id already recorded', async () => {
      const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      // Installed after the open, whose own start records the conversation through the same method.
      const conversationWrites = vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation');
      harness.notifyWorkflowChanged.mockClear();

      reportConversation(status.session!.id, workflowId, 'conv-gone');

      expect(conversationWrites).not.toHaveBeenCalled();
      expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();

      // The control: a different id is written and pushed, so the spy and the mock can see both.
      reportConversation(status.session!.id, workflowId, 'conv-forked');

      expect(conversationWrites).toHaveBeenCalledTimes(1);
      expect(harness.notifyWorkflowChanged).toHaveBeenCalledWith('home', workflowId);
      expect(recordedConversation(workflowId).agent_session_id).toBe('conv-forked');
    });

    it('is ignored for a session that is not a workflow\'s agent, before any workflow is read', async () => {
      await agent.openWorkflowAgent(context, 'home', workflowId, {});
      // A task's session reports its conversation id like any other agent's.
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
      const workflowReads = vi.spyOn(WorkflowRepository.prototype, 'getById');
      const conversationWrites = vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      harness.notifyWorkflowChanged.mockClear();

      reportConversation('task-session', 'task-1', 'task-agent-session-forked');

      expect(workflowReads).not.toHaveBeenCalled();
      expect(conversationWrites).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
      expect(recordedConversation(workflowId).agent_session_id).toBe('conv-gone');
    });
  });

  describe('the effort a start replaces', () => {
    it('is forgotten with the session the start replaces, and kept for the new one', async () => {
      // The Workflow agent's effort is what the agent starts with, and what Stats reads back.
      harness.workflows.effort = 'high';
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

    // A resumed agent whose CLI picked its own id may not report it again on that
    // run, which left the live session's id empty and its turns unrecorded.
    it('files the turns under the workflow\'s recorded conversation when the live session has no id', async () => {
      const opened = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      const session = manager.getSession(opened.session!.id)!;
      session.agentSessionId = null;
      harness.retrievalCall.mockClear();

      manager.emit('idle-timeout', session.id, workflowId, 5);

      expect(harness.retrievalCall).toHaveBeenCalledWith('index.workflowAgentTurns', expect.objectContaining({ agentSessionId: 'conv-gone' }));
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

      expect(status).toEqual({ session: null, unavailable: 'This workflow no longer exists.', setupNeeded: false, startsOnRequest: false });
      expect(manager.spawn).not.toHaveBeenCalled();
      // The command was built, so a folder-shared adapter took its hold under
      // the start's session id; with no session to release it, the start does.
      // Red-green: drop that early return's releaseCommandHold and this fails.
      const adapter = harness.adapter as { buildCommand: ReturnType<typeof vi.fn>; removeHooks: ReturnType<typeof vi.fn> };
      const built = adapter.buildCommand.mock.calls[0][0] as { cwd: string; ptySessionId?: string };
      expect(built.ptySessionId).toBeDefined();
      expect(adapter.removeHooks).toHaveBeenCalledWith(built.cwd, built.ptySessionId);
    });
  });

  // A folder-shared adapter holds the file it writes under `ptySessionId`, and
  // the session layer releases with the session's own id, so the two must be one.
  it('builds the command for the same session id it spawns under', async () => {
    await agent.openWorkflowAgent(context, 'home', workflowId, {});

    const adapter = harness.adapter as { buildCommand: ReturnType<typeof vi.fn>; removeHooks: ReturnType<typeof vi.fn> };
    const built = adapter.buildCommand.mock.calls[0][0] as { ptySessionId?: string };
    expect(built.ptySessionId).toBeDefined();
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({ id: built.ptySessionId }));
    expect(adapter.removeHooks).not.toHaveBeenCalled();
  });

  // `buildCommand` takes a folder-shared adapter's hold under the start's session
  // id. The start owns that hold until `sessionManager.spawn()` takes the command:
  // every return or throw before the call releases it, and from the call on the
  // session layer does (it releases a spawn that never runs, and a session that
  // ran releases at its exit), so the start must not release a second time there.
  describe('the hold a start\'s built command took', () => {
    interface HoldingAdapter {
      buildCommand: ReturnType<typeof vi.fn>;
      removeHooks: ReturnType<typeof vi.fn>;
      detect: ReturnType<typeof vi.fn>;
    }
    const holdingAdapter = (): HoldingAdapter => harness.adapter as HoldingAdapter;

    /** What the Nth `buildCommand` call (zero based) was handed: its cwd, and the id its hold is keyed by. */
    function builtOptions(buildIndex: number): { cwd: string; ptySessionId?: string } {
      return holdingAdapter().buildCommand.mock.calls[buildIndex][0] as { cwd: string; ptySessionId?: string };
    }

    /**
     * The agent running on its recorded conversation (the open's build is the
     * first), owed a restart to read a second project's checkout. The restart
     * suspends it and starts again, and that start is held inside `detect`:
     * past the restart's own Pause check, before the start's re-read.
     */
    async function holdAccessRestartInItsStart(): Promise<{ releaseDetect: () => void }> {
      Object.assign(harness.adapter as object, { supportsReadableDirectories: true });
      const otherCheckout = path.join(root, 'other');
      fs.mkdirSync(otherCheckout);
      const otherProject = { id: 'other', name: 'kangentic-other', path: otherCheckout, default_agent: null, default_model: null, default_effort: null };
      const knownGetById = context.projectRepo.getById.bind(context.projectRepo);
      vi.spyOn(context.projectRepo, 'getById').mockImplementation(
        (projectId: string) => (projectId === 'other' ? otherProject : knownGetById(projectId)) as never,
      );

      const opened = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      expect(opened.session?.status).toBe('running');

      let releaseDetect!: () => void;
      const detectGate = new Promise<void>((resolve) => {
        releaseDetect = resolve;
      });
      const detect = holdingAdapter().detect;
      detect.mockImplementationOnce(async () => {
        await detectGate;
        return { found: true, path: '/mock/bin/claude' };
      });

      // 'now' is the restart: an idle agent that lacks the checkout (the cache is empty, so it reads idle).
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'other').when).toBe('now');
      await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
      expect(manager.suspend).toHaveBeenCalledTimes(1);
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      return { releaseDetect };
    }

    // A Pause pressed while the restart's start finds the CLI finds the agent
    // suspended already, so it stops nothing and stands: the start re-reads it
    // after building its command and returns without spawning. That command
    // took a hold that no session will ever own.
    //
    // Red-green: drop the releaseCommandHold in that early return and this fails.
    it('releases the hold of a read-access restart that a Pause pressed during the start stood down', async () => {
      const { releaseDetect } = await holdAccessRestartInItsStart();

      await agent.pauseWorkflowAgent(context, workflowId);
      releaseDetect();
      await vi.waitFor(() => expect(holdingAdapter().buildCommand).toHaveBeenCalledTimes(2));
      // Nothing after the build awaits before the spawn decision; one macrotask turn lets the rest settle.
      await new Promise((resolve) => setImmediate(resolve));

      const restartBuild = builtOptions(1);
      expect(restartBuild.ptySessionId).toBeDefined();
      // The restart built for its own session, not the open's.
      expect(restartBuild.ptySessionId).not.toBe(builtOptions(0).ptySessionId);
      // Only the open spawned.
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(holdingAdapter().removeHooks).toHaveBeenCalledTimes(1);
      expect(holdingAdapter().removeHooks).toHaveBeenCalledWith(restartBuild.cwd, restartBuild.ptySessionId);
    });

    it('control: the same restart with no Pause spawns, and the session keeps the hold', async () => {
      const { releaseDetect } = await holdAccessRestartInItsStart();

      releaseDetect();
      await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setImmediate(resolve));

      expect(manager.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ id: builtOptions(1).ptySessionId }));
      expect(holdingAdapter().removeHooks).not.toHaveBeenCalled();
    });

    // `buildEnv` runs after `buildCommand`, so the command's hold is already
    // taken when it throws. The start rejects (the pane shows the reason), and
    // no session will exist to release the hold.
    //
    // Red-green: move the buildEnv call above the try in workflow-agent.ts and
    // this fails.
    it('releases the hold and rejects the start when the adapter\'s buildEnv throws, spawning nothing', async () => {
      const failure = new Error('the adapter could not build its environment');
      Object.assign(harness.adapter as object, {
        buildEnv: vi.fn(() => {
          throw failure;
        }),
      });

      await expect(agent.openWorkflowAgent(context, 'home', workflowId, {})).rejects.toBe(failure);

      expect(manager.spawn).not.toHaveBeenCalled();
      const built = builtOptions(0);
      expect(built.ptySessionId).toBeDefined();
      expect(holdingAdapter().removeHooks).toHaveBeenCalledTimes(1);
      expect(holdingAdapter().removeHooks).toHaveBeenCalledWith(built.cwd, built.ptySessionId);
    });

    // From the `spawn()` call on, the session layer owns the hold: it releases a
    // spawn that never ran, and keeps it for a PTY that started, so the file is
    // never stripped under a running agent. A second release from here would
    // strip the folder's file out from under a session that is still running.
    //
    // Red-green: wrap the spawn call back inside a catch that calls
    // releaseCommandHold and this fails.
    it('leaves the hold to the session layer when spawn rejects', async () => {
      const failure = new Error('the pty host refused the spawn');
      manager.spawn.mockRejectedValueOnce(failure);

      await expect(agent.openWorkflowAgent(context, 'home', workflowId, {})).rejects.toBe(failure);

      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(holdingAdapter().buildCommand).toHaveBeenCalledTimes(1);
      expect(holdingAdapter().removeHooks).not.toHaveBeenCalled();
    });
  });

  // The home is the id a pane or a resume names, and it can outlive its project.
  // `getProjectDb` on main creates, migrates and seeds a database for any id it is
  // given, so reading a gone home through it would bring the deleted project's
  // file back, empty. The mocked `getProjectDb` records each id and throws for one
  // with no database; every read below sits in a try or returns a soft value, so
  // the recorded ids are what show a read that opened the gone home.
  describe('a home project that is gone', () => {
    const entryPoints: Array<{ name: string; start: () => Promise<WorkflowAgentStatus> }> = [
      { name: 'open', start: () => agent.openWorkflowAgent(context, 'deleted-home', workflowId, {}) },
      { name: 'resume', start: () => agent.resumeWorkflowAgent(context, 'deleted-home', workflowId, {}) },
    ];

    it.each(entryPoints)('answers $name with the workflow gone, and neither starts an agent nor opens the home', async ({ start }) => {
      const detect = (harness.adapter as { detect: ReturnType<typeof vi.fn> }).detect;

      await expect(start()).resolves.toEqual({ session: null, unavailable: 'This workflow no longer exists.', setupNeeded: false, startsOnRequest: false });

      expect(harness.getProjectDbCalls).not.toContain('deleted-home');
      expect(detect).not.toHaveBeenCalled();
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it('starts nothing over, and does not open the home, when the project is deleted while the dead session\'s scrollback is read', async () => {
      const resumed = await agent.openWorkflowAgent(context, 'home', workflowId, {});
      let finishScrollback!: () => void;
      const scrollbackGate = new Promise<void>((resolve) => {
        finishScrollback = resolve;
      });
      manager.getRawScrollback.mockImplementationOnce(async () => {
        await scrollbackGate;
        return 'No conversation found with session ID: conv-gone';
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      manager.exitOnItsOwn(resumed.session!.id);
      await vi.waitFor(() => expect(manager.getRawScrollback).toHaveBeenCalledTimes(1));

      // The project is deleted while the last words are still being read: its
      // database is closed and gone. Installed after the open, whose own start
      // records the conversation through the same method.
      (harness.dbs.get('home') as Database.Database).close();
      harness.dbs.delete('home');
      const conversationWrites = vi.spyOn(WorkflowRepository.prototype, 'setAgentConversation');
      // After the exit above, whose listener reads the spend through `getProjectDb`.
      harness.getProjectDbCalls.length = 0;

      finishScrollback();
      await vi.waitFor(() => expect(describeStartupFailure).toHaveBeenCalledTimes(1));
      // The start-over, were it not skipped, spawns through microtasks only: one macrotask lets it run.
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.getProjectDbCalls).not.toContain('home');
      expect(conversationWrites).not.toHaveBeenCalled();
      expect(manager.spawn).toHaveBeenCalledTimes(1);
      expect(harness.notifyWorkflowChanged).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('found no conversation'));
    });
  });
});
