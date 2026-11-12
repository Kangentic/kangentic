/**
 * Wiring test: prepareAgentSpawn (the STARTUP spawn chokepoint) for a project on a remote host (#913).
 * The CLI is the host's own, so the local CLI is never detected; the command is built for the host's
 * shell with the host place; trust is ensured through that place; and the result carries the spawn
 * descriptor the caller hands `sessionManager.spawn`. A project on this computer is untouched.
 *
 * What a user loses if it breaks: a remote project that tries to launch a CLI from this computer, or
 * an agent started by recovery on the wrong machine.
 */
import { promises as fileSystem } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';
import type { SshCliTarget } from '../../src/main/remote/remote-launch';
import { HostFileSync } from '../../src/main/remote/host-file-sync';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

const buildCommandMock = vi.fn(() => 'claude --mock-run');
const ensureTrustMock = vi.fn(async () => {});
const detectMock = vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '2.1.311' }));

const adapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: false,
  remoteCliName: 'claude' as string | undefined,
  remoteFiles: undefined as (() => { home: string[]; project: string[] }) | undefined,
  detect: detectMock,
  ensureTrust: ensureTrustMock,
  buildCommand: buildCommandMock,
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn((agentName: string) => (agentName === 'claude' ? adapter : undefined)) },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const mocked = { ...original, mkdirSync: vi.fn() };
  return { ...mocked, default: mocked };
});

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';
import { RemoteAgentUnsupportedError, setRemoteLaunchResolver } from '../../src/main/remote/remote-launch';

const place: SshCliTarget = {
  kind: 'ssh',
  hostId: 'host-a',
  home: '/home/dev',
  shellName: 'fish',
  localHome: 'C:\\Users\\dev\\remote-homes\\host-a',
  roots: [{ local: '/mock/project', host: '/home/dev/api' }],
  linuxCliPath: 'claude',
};

function makeTask(): Task {
  return { id: 'task-remote-001', title: 'Remote task', description: 'Recover me', swimlane_id: 'lane', agent: 'claude', worktree_path: null, labels: [] } as unknown as Task;
}

function makeSwimlane(): Swimlane {
  return { id: 'lane', name: 'Review', role: null, position: 0, permission_mode: null, auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' } as unknown as Swimlane;
}

function runPrepare(location: { cwd: string; projectPath: string } = { cwd: '/mock/project', projectPath: '/mock/project' }) {
  return prepareAgentSpawn({
    task: makeTask(),
    swimlane: makeSwimlane(),
    cwd: location.cwd,
    projectId: 'proj-123',
    projectPath: location.projectPath,
    effectiveConfig: { agent: { permissionMode: 'acceptEdits', cliPaths: {} }, mcpServer: { enabled: false } } as unknown as AppConfig,
    projectDefaultAgent: 'claude',
    projectDefaultModel: null,
    projectDefaultEffort: null,
    resolvedShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    mcpServerHandle: null,
    resume: null,
    hasSessionRecord: true,
    tasks: { update: vi.fn() },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adapter.remoteCliName = 'claude';
  adapter.remoteFiles = undefined;
});

afterEach(() => {
  setRemoteLaunchResolver(null);
});

describe('prepareAgentSpawn: a project on a remote host', () => {
  beforeEach(() => {
    setRemoteLaunchResolver({ resolve: async () => ({ place, remote: { hostId: 'host-a', cwd: '/home/dev/api', shellName: 'fish' } }) });
  });

  it('never detects a CLI on this computer', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('builds for the host\'s shell with the host place, and the CLI by its name there', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({ shell: 'fish', cliTarget: place, agentPath: 'claude' });
    expect(result.data.shell).toBe('fish');
  });

  it('ensures trust through the host place', async () => {
    await runPrepare();
    expect(ensureTrustMock).toHaveBeenCalledWith('/mock/project', place);
  });

  it('returns the spawn descriptor and records the host on the row, without the helper\'s file access', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.remote).toEqual({ hostId: 'host-a', cwd: '/home/dev/api', shellName: 'fish' });
    expect(result.data.cliTarget).toMatchObject({ kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'fish', linuxCliPath: 'claude' });
    expect(JSON.stringify(result.data.cliTarget)).not.toContain('files');
  });

  it('fails with the resolver\'s sentence for an agent that cannot run on a host yet', async () => {
    setRemoteLaunchResolver({ resolve: async () => { throw new RemoteAgentUnsupportedError('codex', 'Codex'); } });

    await expect(runPrepare()).rejects.toThrow('Codex cannot run on a remote host yet');
    expect(buildCommandMock).not.toHaveBeenCalled();
  });
});

describe('prepareAgentSpawn: a project on this computer', () => {
  it('detects the CLI as before and returns no remote descriptor', async () => {
    setRemoteLaunchResolver({ resolve: async () => null });

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(detectMock).toHaveBeenCalledOnce();
    expect(result.data.remote).toBeNull();
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({ agentPath: '/usr/local/bin/claude' });
  });

  it('is unchanged when no resolver is set at all', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    expect(detectMock).toHaveBeenCalledOnce();
  });
});

describe('prepareAgentSpawn: a trust step that throws after the host files were pulled', () => {
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
    adapter.remoteFiles = () => declaration;
    // The adapter edits the folder copy, then fails before the push.
    ensureTrustMock.mockImplementationOnce(async () => {
      await fileSystem.writeFile(localPath, '{"v":1,"adapter":1}');
      throw new Error('trust failed');
    });
    setRemoteLaunchResolver({
      resolve: async () => ({
        place: { ...workspace.place, linuxCliPath: 'claude' },
        remote: { hostId: 'host-1', cwd: workspace.hostProject, shellName: 'bash' },
      }),
    });

    await expect(runPrepare({ cwd: workspace.projectFolder, projectPath: workspace.projectFolder })).rejects.toThrow('trust failed');
    workspace.host.files.set(hostPath, '{"v":2}');
    await HostFileSync.pull(declaration, workspace.projectFolder, workspace.place);

    expect(await fileSystem.readFile(localPath, 'utf8')).toBe('{"v":2}');
  });
});
