/**
 * A workflow's own agent on a remote project. It used to detect the CLI on this computer and run in the empty shell
 * folder, so it failed where the CLI was only on the host and planned against nothing where it was on both.
 *
 * Real, migrated SQLite behind a fake session manager, as in `workflow-agent-start-over.test.ts`, with the real
 * `resolveSpawnCli` reading a fake launch resolver.
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
  firstMessageInput: null as unknown,
  // What the host file pull answers, and a hook that runs inside it (the point between the CLI search and the push).
  pulled: null as unknown,
  duringPull: null as (() => void) | null,
}));
vi.mock('../../src/main/remote/host-file-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/remote/host-file-sync')>();
  return {
    ...actual,
    pullHostFilesFor: vi.fn(async () => {
      harness.duringPull?.();
      return harness.pulled;
    }),
  };
});
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => harness.dbs.get(projectId),
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: () => harness.adapter, list: () => [] } }));
vi.mock('../../src/main/agent/agent-list', () => ({
  listAgents: async () => [{ name: 'claude', found: false, supportsWorkflowAgent: true, capabilities: { supportsModelOverride: true } }],
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: vi.fn(async () => ({ outcome: 'indexed' })) } }));
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: async (options: { agentPath: string; prompt?: string }) => ({ agentPath: options.agentPath, prompt: options.prompt }),
}));
vi.mock('../../src/main/workflows/workflow-changed', () => ({
  notifyWorkflowChanged: vi.fn(),
  notifyWorkflowOfTask: vi.fn(),
  setWorkflowChangedWindow: vi.fn(),
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const agent = await import('../../src/main/workflows/workflow-agent');
const { buildWorkflowAgentFirstMessage } = await import('../../src/main/workflows/workflow-agent-prompt');

import { openTestDatabase } from './helpers/test-database';
import { RemoteAgentUnsupportedError, setRemoteLaunchResolver, type RemoteLaunch } from '../../src/main/remote/remote-launch';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Workflow } from '../../src/shared/types';

const HOST_PROJECT = '/home/dev/proj';

interface SpawnInput { cwd: string; remote?: { hostId: string; cwd: string }; cliTarget?: { kind: string } | null }

class FakeSessionManager extends EventEmitter {
  sessions: Array<{ id: string; workflowId: string; status: string; agentSessionId: string | null; resuming: boolean; projectId: string; transient: boolean; taskId: string; startedAt: string; cwd: string; shell: string; pid: number | null; exitCode: null }> = [];
  spawn = vi.fn(async (input: SpawnInput & { id: string; taskId: string; projectId: string; workflowId: string; resuming: boolean; agentSessionId: string | null }) => {
    const session = { id: input.id, workflowId: input.workflowId, status: 'running', agentSessionId: input.agentSessionId, resuming: input.resuming, projectId: input.projectId, transient: true, taskId: input.taskId, startedAt: '2026-11-06T10:00:00.000Z', cwd: input.cwd, shell: 'bash', pid: null, exitCode: null };
    this.sessions.push(session);
    return session;
  });
  suspend = vi.fn(async () => undefined);
  kill = vi.fn();
  awaitExit = vi.fn(async () => undefined);
  remove = vi.fn();
  getShell = vi.fn(async () => { throw new Error('asked this computer\'s shell for a host'); });
  listSessions(): unknown[] { return this.sessions; }
  getSession(sessionId: string): unknown { return this.sessions.find((session) => session.id === sessionId); }
  getUsageCache(): Record<string, unknown> { return {}; }
  getReportedTranscriptPath(): null { return null; }
  getActivityCache(): Record<string, string> { return {}; }
  getSessionAgentName(): string { return 'claude'; }
  getSessionCliTarget(): null { return null; }
  getToolCallCount(): number { return 0; }
  getCompactionCount(): number { return 0; }
  markIdleAuthoritative = vi.fn();
}

describe('a workflow\'s agent on a remote project', () => {
  let root: string;
  let shell: string;
  let manager: FakeSessionManager;
  let context: IpcContext;
  let workflowId: string;
  let projects: Array<{ id: string; name: string; path: string; remote: { hostId: string; path: string } | null; default_agent: null; default_model: null; default_effort: null }>;

  function project(id: string, folder: string, remote: { hostId: string; path: string } | null) {
    return { id, name: id, path: folder, remote, default_agent: null, default_model: null, default_effort: null };
  }

  function launchFor(cwd: string): RemoteLaunch {
    return {
      place: { kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'bash', localHome: path.join(root, 'mirror'), roots: [{ local: shell, host: HOST_PROJECT }], linuxCliPath: 'claude' },
      remote: { hostId: 'host-1', cwd, shellName: 'bash' },
    };
  }

  function read(): Workflow {
    return new WorkflowRepository(harness.dbs.get('home') as Database.Database).getById(workflowId) as Workflow;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-remote-'));
    shell = path.join(root, 'shell');
    fs.mkdirSync(shell);
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set('home', db);
    harness.adapter = {
      name: 'claude',
      displayName: 'Claude Code',
      sessionType: 'claude_agent',
      kangenticMcp: 'per-session',
      supportsReadOnlyLaunch: true,
      supportsCallerSessionId: true,
      resumePromptDelivery: 'command-line',
      supportsReadableDirectories: true,
      remoteCliName: 'claude',
      detect: vi.fn(async () => ({ found: false, path: null })),
      ensureTrust: vi.fn(async () => undefined),
      buildCommand: vi.fn(() => 'mock-agent-command'),
      removeHooks: vi.fn(),
      getExitSequence: () => ['\x03'],
      describeStartupFailure: vi.fn(() => true),
    };
    projects = [
      project('home', shell, { hostId: 'host-1', path: HOST_PROJECT }),
      project('sibling', path.join(root, 'sibling-shell'), { hostId: 'host-1', path: '/home/dev/sibling' }),
      project('other-host', path.join(root, 'other-shell'), { hostId: 'host-2', path: '/home/dev/other' }),
      project('local', root, null),
    ];
    manager = new FakeSessionManager();
    context = {
      projectRepo: { list: () => projects, listHidden: () => [], getById: (id: string) => projects.find((candidate) => candidate.id === id) },
      sessionManager: manager,
      boardConfigManager: { getDefaultBaseBranchForPath: () => 'main' },
      configManager: {
        load: () => ({}),
        getEffectiveConfig: () => ({ mcpServer: { enabled: true }, agent: { cliPaths: {} }, workflows: { agent: 'claude', model: 'haiku', effort: null } }),
      },
      mcpServerHandle: { urlForProject: (projectId: string) => `http://127.0.0.1:9/mcp/${projectId}`, token: 'test-token' },
    } as unknown as IpcContext;
    workflowId = new WorkflowRepository(db).create({ title: 'Usage budgets' }).id;
    setRemoteLaunchResolver({ resolve: async ({ projectPath }) => (projectPath === shell ? launchFor(HOST_PROJECT) : null) });
    agent.registerWorkflowAgentLifecycle(context);
  });

  afterEach(async () => {
    harness.pulled = null;
    harness.duringPull = null;
    await agent.endWorkflowAgent(context, workflowId);
    setRemoteLaunchResolver(null);
    vi.restoreAllMocks();
    for (const database of harness.dbs.values()) (database as Database.Database).close();
    harness.dbs.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts on the host with no CLI on this computer', async () => {
    const adapter = harness.adapter as { detect: ReturnType<typeof vi.fn>; buildCommand: ReturnType<typeof vi.fn> };

    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

    expect(status.state).not.toBe('unavailable');
    expect(adapter.detect).not.toHaveBeenCalled();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(manager.spawn.mock.calls[0][0]).toMatchObject({ cwd: shell, remote: { hostId: 'host-1', cwd: HOST_PROJECT }, cliTarget: { kind: 'ssh' } });
    expect((adapter.buildCommand.mock.calls[0][0] as { cliTarget: { kind: string } }).cliTarget.kind).toBe('ssh');
  });

  function fakeSync(push: () => Promise<void> = async () => undefined) {
    return { push: vi.fn(push), abandon: vi.fn() };
  }

  it('pulls the host\'s files before trust is written, and pushes them before the spawn', async () => {
    const sync = fakeSync();
    harness.pulled = sync;
    const adapter = harness.adapter as { ensureTrust: ReturnType<typeof vi.fn> };

    await agent.openWorkflowAgent(context, 'home', workflowId, {});

    const pull = vi.mocked((await import('../../src/main/remote/host-file-sync')).pullHostFilesFor);
    expect(pull.mock.invocationCallOrder[0]).toBeLessThan(adapter.ensureTrust.mock.invocationCallOrder[0]);
    expect(sync.push).toHaveBeenCalledTimes(1);
    expect(sync.push.mock.invocationCallOrder[0]).toBeLessThan(manager.spawn.mock.invocationCallOrder[0]);
    expect(sync.abandon).not.toHaveBeenCalled();
  });

  it('starts nothing and releases the command hold when the push to the host fails', async () => {
    const sync = fakeSync(async () => { throw new Error('push to the host failed'); });
    harness.pulled = sync;
    const adapter = harness.adapter as { removeHooks: ReturnType<typeof vi.fn> };

    await expect(agent.openWorkflowAgent(context, 'home', workflowId, {})).rejects.toThrow('push to the host failed');

    expect(manager.spawn).not.toHaveBeenCalled();
    expect(adapter.removeHooks).toHaveBeenCalledTimes(1);
    expect(adapter.removeHooks.mock.calls[0][0]).toBe(shell);
  });

  it('abandons the pull, releases the hold and spawns nothing when the workflow is deleted mid-start', async () => {
    const sync = fakeSync();
    harness.pulled = sync;
    harness.duringPull = () => new WorkflowRepository(harness.dbs.get('home') as Database.Database).delete(workflowId);
    const adapter = harness.adapter as { removeHooks: ReturnType<typeof vi.fn> };

    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

    expect(JSON.stringify(status)).toContain('This workflow no longer exists.');
    expect(sync.abandon).toHaveBeenCalledTimes(1);
    expect(sync.push).not.toHaveBeenCalled();
    expect(adapter.removeHooks).toHaveBeenCalledTimes(1);
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('abandons the pull, releases the hold and spawns nothing when the user pauses during the restart for read access', async () => {
    await agent.openWorkflowAgent(context, 'home', workflowId, {});
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const adapter = harness.adapter as { removeHooks: ReturnType<typeof vi.fn> };
    const sync = fakeSync();
    harness.pulled = sync;
    // The Pause lands while the restart finds the CLI, after the agent was suspended and before it spawns.
    harness.duringPull = () => { void agent.pauseWorkflowAgent(context, workflowId); };

    // A sibling checkout the running agent was not started with owes it a restart (a `continuation` start).
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'sibling').when).toBe('now');

    await expect.poll(() => sync.abandon.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(sync.push).not.toHaveBeenCalled();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(adapter.removeHooks).toHaveBeenCalledTimes(1);
  });

  it('asks an adapter that creates its own session id for one on the host, passing the ssh target', async () => {
    const adapter = harness.adapter as { supportsCallerSessionId: boolean; createSessionId?: ReturnType<typeof vi.fn> };
    adapter.supportsCallerSessionId = false;
    adapter.createSessionId = vi.fn(async () => 'created-session-id');

    await agent.openWorkflowAgent(context, 'home', workflowId, {});

    expect(adapter.createSessionId).toHaveBeenCalledTimes(1);
    const [, projectRoot, target] = adapter.createSessionId.mock.calls[0] as unknown[];
    expect(projectRoot).toBe(shell);
    expect(target).toMatchObject({ kind: 'ssh', hostId: 'host-1' });
    expect(manager.spawn.mock.calls[0][0]).toMatchObject({ agentSessionId: 'created-session-id' });
  });

  it('removes this computer\'s session folder when it ends, though a live session reports the host\'s folder', async () => {
    await agent.openWorkflowAgent(context, 'home', workflowId, {});
    manager.sessions[0].cwd = HOST_PROJECT;
    const localFolder = path.join(shell, '.kangentic', 'sessions', workflowId);
    expect(fs.existsSync(localFolder)).toBe(true);

    await agent.endWorkflowAgent(context, workflowId);

    expect(fs.existsSync(localFolder)).toBe(false);
  });

  it('shows a host that is not connected in its own words, and starts nothing', async () => {
    setRemoteLaunchResolver({ resolve: async () => { throw new Error('This host is not connected.'); } });

    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

    expect(JSON.stringify(status)).toContain('This host is not connected.');
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('shows an agent that cannot run on a host, and starts nothing', async () => {
    setRemoteLaunchResolver({ resolve: async () => { throw new RemoteAgentUnsupportedError('claude', 'Claude Code'); } });

    const status = await agent.openWorkflowAgent(context, 'home', workflowId, {});

    expect(JSON.stringify(status)).toContain('cannot run on a remote host');
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('tells the agent the project\'s folder on the host', () => {
    const message = buildWorkflowAgentFirstMessage(context, 'home', read(), 'Work in {{projectPath}}');

    expect(message).toBe(`Work in ${HOST_PROJECT}`);
  });

  describe('reading another project', () => {
    it('reaches a project on the same host by its path there, and no other', () => {
      const repository = new WorkflowRepository(harness.dbs.get('home') as Database.Database);
      for (const id of ['sibling', 'other-host', 'local']) repository.addAgentReadProject(workflowId, id);

      expect(agent.readableProjectsOf(context, 'home', read())).toEqual([{ projectId: 'sibling', name: 'sibling', path: '/home/dev/sibling' }]);
    });

    it('grants a project on the same host, with the path the agent can open', () => {
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'sibling')).toEqual({ name: 'sibling', path: '/home/dev/sibling', when: 'next-start' });
    });

    it('grants nothing across machines, and says so', () => {
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'other-host').when).toBe('elsewhere');
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'local').when).toBe('elsewhere');
      expect(read().agent_read_project_ids).toEqual([]);
    });

    it('names its own project as the host does', () => {
      expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflowId, 'home')).toEqual({ name: 'home', path: HOST_PROJECT, when: 'home' });
    });
  });
});
