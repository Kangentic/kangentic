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
 * Real, migrated SQLite (node:sqlite) behind a fake session manager, as in
 * `workflow-agent-spend.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  adapter: null as unknown,
  notifyWorkflowChanged: vi.fn(),
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
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: vi.fn(async () => ({ outcome: 'indexed' })) } }));
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

import { adaptDatabase } from './helpers/node-sqlite-database';
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

describeWithSqlite('a workflow\'s own agent starting over', () => {
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
    const db = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set('home', db);
    harness.notifyWorkflowChanged.mockReset();
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
});
