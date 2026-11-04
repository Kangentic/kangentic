/**
 * The board-path spawn chokepoint (`TransitionEngine.executeSpawnAgent`, reached here through
 * `runLegacySpawnAgent`) for a project on a remote host (#913), and the early-agent launcher for the same.
 *
 * With a remote launch resolver set:
 * - the CLI on this computer is never detected (`adapter.detect`), the host's own CLI is named instead;
 * - `sessionManager.spawn` receives the `remote` descriptor and the ssh place as `cliTarget`;
 * - a resume hands the conversation reconcile no `cliPath`, because the reconcile would stop a CLI
 *   background session by running a command on THIS computer, where the conversation is not;
 * - `launchEarlyAgent` returns null and launches nothing, because a remote agent starts through the main
 *   path only.
 *
 * What a user loses if it breaks: a remote task that launches a CLI from this computer, runs a local
 * command against a conversation that lives on the host, or has an agent started ahead of its files.
 *
 * The reconcile is mocked so the assertion reads exactly what the engine handed it; a project on this
 * computer is the control for each assertion.
 */
import { promises as fileSystem } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { setRemoteLaunchResolver, type SshCliTarget } from '../../src/main/remote/remote-launch';
import { HostFileSync } from '../../src/main/remote/host-file-sync';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

const mockAdapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  defaultPermission: 'default',
  remoteCliName: 'claude' as string | undefined,
  remoteFiles: undefined as (() => { home: string[]; project: string[] }) | undefined,
  resumePromptDelivery: 'command-line',
  firstPromptMayBeTyped: vi.fn(() => true),
  detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: vi.fn((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`.trim()),
  getExitSequence: vi.fn(() => ['\x03']),
  removeHooks: vi.fn(),
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn(() => mockAdapter),
    getOrThrow: vi.fn(() => mockAdapter),
    list: vi.fn(() => ['claude']),
  },
}));

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

vi.mock('../../src/main/transition-engine/resume-cwd-migration', () => ({
  migrateResumeCwdIfRenamed: vi.fn(async () => {}),
}));

const reconcileMock = vi.hoisted(() => vi.fn(async (params: { storedAgentSessionId: string }) => params.storedAgentSessionId));
vi.mock('../../src/main/transition-engine/resume-id-reconcile', () => ({
  reconcileResumeAgentSessionId: reconcileMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const mocked = { ...original, mkdirSync: vi.fn() };
  return { ...mocked, default: mocked };
});

const PROJECT_PATH = '/mock/project';
const STORED_AGENT_SESSION_ID = 'agent-session-stored';

const place: SshCliTarget = {
  kind: 'ssh',
  hostId: 'host-a-0000',
  home: '/home/dev',
  shellName: 'bash',
  localHome: '/mock/remote-homes/host-a',
  roots: [{ local: PROJECT_PATH, host: '/home/dev/api' }],
  linuxCliPath: 'claude',
};
const remote = { hostId: 'host-a-0000', cwd: '/home/dev/api', shellName: 'bash' };

function makeTask() {
  return {
    id: 'task-remote-1',
    title: 'Remote task',
    description: 'Do it on the host.',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    agent: null,
  };
}

function makeEngine(options: { resumeRecord?: boolean; projectPath?: string } = {}) {
  const spawn = vi.fn(async (input: { id: string }) => ({ id: input.id, status: 'running' }));
  const sessionManager = {
    spawn,
    getShell: vi.fn(async () => 'bash'),
    markIdleAuthoritative: vi.fn(),
    getFreeAgentSlots: vi.fn(() => 4),
    columnBlocks: vi.fn(() => false),
    hasSessionForTask: vi.fn(() => false),
  };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => (options.resumeRecord
      ? { id: 'record-1', agent_session_id: STORED_AGENT_SESSION_ID, session_type: 'claude_agent', status: 'suspended', cwd: PROJECT_PATH }
      : null)),
    insert: vi.fn(),
    update: vi.fn(),
    updateAppliedSettings: vi.fn(),
    compareAndUpdateStatus: vi.fn(() => true),
    updateAgentSessionId: vi.fn(),
    listForTaskNewestFirst: vi.fn(() => []),
  };
  const taskRepo = { update: vi.fn(), getById: vi.fn(() => null), recordWorktree: vi.fn(), recoverLegacyWorktreeFolder: vi.fn(() => null), setWorktreeSkipReason: vi.fn() };
  const engine = new TransitionEngine(
    sessionManager as never,
    { submitKeystrokes: vi.fn() } as never,
    taskRepo as never,
    (() => ({
      permissionMode: 'default',
      projectPath: options.projectPath ?? PROJECT_PATH,
      projectId: 'proj-1',
      projectName: 'Remote project',
      gitConfig: { worktreesEnabled: false, defaultBaseBranch: 'main', autoCleanup: false, copyFiles: [] },
      mcpServerEnabled: false,
      defaultAgent: 'claude',
      cliPathOverrides: {},
      executionServers: {},
      execution: {},
      launchOptions: {},
    })) as never,
    sessionRepo as never,
    { getPathsForTask: vi.fn(() => []) } as never,
  );
  const runSpawn = () => engine.runLegacySpawnAgent({ promptTemplate: '{{task_xml}}' } as never, makeTask() as never);
  return { engine, runSpawn, spawn };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdapter.remoteFiles = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  setRemoteLaunchResolver(null);
  vi.restoreAllMocks();
});

describe('TransitionEngine spawn for a project on a remote host', () => {
  beforeEach(() => {
    setRemoteLaunchResolver({ resolve: async () => ({ place, remote }) });
  });

  it('never detects a CLI on this computer, and hands the spawn the host descriptor and ssh place', async () => {
    const { runSpawn, spawn } = makeEngine();

    await runSpawn();

    expect(mockAdapter.detect).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnInput = spawn.mock.calls[0][0] as unknown as { remote?: unknown; cliTarget?: unknown };
    expect(spawnInput.remote).toEqual(remote);
    expect(spawnInput.cliTarget).toMatchObject({ kind: 'ssh', hostId: 'host-a-0000', linuxCliPath: 'claude' });
    expect(mockAdapter.buildCommand.mock.calls[0][0]).toMatchObject({ agentPath: 'claude' });
  });

  it('hands the resume reconcile the ssh place and no cliPath', async () => {
    const { runSpawn } = makeEngine({ resumeRecord: true });

    await runSpawn();

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const reconcileParams = reconcileMock.mock.calls[0][0] as unknown as { cliPath?: string; place: unknown };
    expect(reconcileParams.cliPath).toBeUndefined();
    expect(reconcileParams.place).toMatchObject({ kind: 'ssh', hostId: 'host-a-0000' });
  });

  it('launches no early agent', async () => {
    const { engine, spawn } = makeEngine();

    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: `${PROJECT_PATH}/wt`, agentOverride: 'claude' });

    expect(handle).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(mockAdapter.detect).not.toHaveBeenCalled();
  });
});

describe('TransitionEngine spawn for a project on this computer (control)', () => {
  it('detects the CLI, passes its path to the resume reconcile, and sends no remote descriptor', async () => {
    setRemoteLaunchResolver({ resolve: async () => null });
    const { runSpawn, spawn } = makeEngine({ resumeRecord: true });

    await runSpawn();

    expect(mockAdapter.detect).toHaveBeenCalled();
    const reconcileParams = reconcileMock.mock.calls[0][0] as unknown as { cliPath?: string };
    expect(reconcileParams.cliPath).toBe('/usr/bin/claude');
    expect((spawn.mock.calls[0][0] as unknown as { remote?: unknown }).remote).toBeUndefined();
  });

  it('still launches an early agent', async () => {
    setRemoteLaunchResolver({ resolve: async () => null });
    const { engine, spawn } = makeEngine();

    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: `${PROJECT_PATH}/wt`, agentOverride: 'claude' });

    expect(handle).not.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('TransitionEngine spawn: a trust step that throws after the host files were pulled', () => {
  let workspace: FakeSshWorkspace;

  beforeEach(async () => {
    workspace = await makeFakeSshWorkspace();
  });

  afterEach(async () => {
    await workspace.dispose();
  });

  it('abandons the pull, so a following pull of the same file refreshes it from the host', async () => {
    const declaration = { home: [], project: ['.cursor/mcp.json'] };
    const hostPath = `${workspace.hostProject}/.cursor/mcp.json`;
    const localPath = path.join(workspace.projectFolder, '.cursor', 'mcp.json');
    workspace.host.files.set(hostPath, '{"v":1}');
    mockAdapter.remoteFiles = () => declaration;
    // The adapter edits the folder copy, then fails before the push.
    mockAdapter.ensureTrust.mockImplementationOnce(async () => {
      await fileSystem.writeFile(localPath, '{"v":1,"adapter":1}');
      throw new Error('trust failed');
    });
    setRemoteLaunchResolver({
      resolve: async () => ({
        place: { ...workspace.place, linuxCliPath: 'claude' },
        remote: { hostId: 'host-1', cwd: workspace.hostProject, shellName: 'bash' },
      }),
    });
    const { runSpawn } = makeEngine({ projectPath: workspace.projectFolder });

    await expect(runSpawn()).rejects.toThrow('trust failed');
    workspace.host.files.set(hostPath, '{"v":2}');
    await HostFileSync.pull(declaration, workspace.projectFolder, workspace.place);

    expect(await fileSystem.readFile(localPath, 'utf8')).toBe('{"v":2}');
  });
});
