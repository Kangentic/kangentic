/**
 * The startup spawn chokepoint (`prepareAgentSpawn`) resuming a conversation for a project on a remote
 * host (#913). The conversation reconcile is handed the ssh place and NO `cliPath`: with a path it would
 * stop a CLI background session by running a command on this computer, where the conversation is not.
 * A project on this computer is the control: it still hands the detected path.
 *
 * `prepare-spawn-remote-wiring.test.ts` covers the rest of the remote wiring with `resume: null`; this
 * file covers the resume case it leaves out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';
import type { SshCliTarget } from '../../src/main/remote/remote-launch';

const adapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: false,
  remoteCliName: 'claude',
  detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '2.1.311' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: vi.fn(() => 'claude --resume agent-session-stored'),
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn((agentName: string) => (agentName === 'claude' ? adapter : undefined)) },
}));

vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn() } }));

const reconcileMock = vi.hoisted(() => vi.fn(async (params: { storedAgentSessionId: string }) => params.storedAgentSessionId));
vi.mock('../../src/main/transition-engine/resume-id-reconcile', () => ({
  reconcileResumeAgentSessionId: reconcileMock,
}));

vi.mock('../../src/main/transition-engine/resume-conversation-guard', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/transition-engine/resume-conversation-guard')>();
  return { ...original, assessResumeConversation: vi.fn(async () => 'unknown') };
});

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';
import { setRemoteLaunchResolver } from '../../src/main/remote/remote-launch';

const place: SshCliTarget = {
  kind: 'ssh',
  hostId: 'host-a',
  home: '/home/dev',
  shellName: 'bash',
  localHome: '/mock/remote-homes/host-a',
  roots: [{ local: '/mock/project', host: '/home/dev/api' }],
  linuxCliPath: 'claude',
};

function runPrepare() {
  return prepareAgentSpawn({
    task: { id: 'task-remote-001', title: 'Remote task', description: '', swimlane_id: 'lane', agent: 'claude', worktree_path: null, labels: [] } as unknown as Task,
    swimlane: { id: 'lane', name: 'Review', role: null, position: 0, permission_mode: null, auto_spawn: true, session_target: 'main', session_spawn_strategy: 'create_or_resume' } as unknown as Swimlane,
    cwd: '/mock/project',
    projectId: 'proj-123',
    projectPath: '/mock/project',
    effectiveConfig: { agent: { permissionMode: 'acceptEdits', cliPaths: {} }, mcpServer: { enabled: false } } as unknown as AppConfig,
    projectDefaultAgent: 'claude',
    projectDefaultModel: null,
    projectDefaultEffort: null,
    resolvedShell: '/bin/bash',
    mcpServerHandle: null,
    resume: { agentSessionId: 'agent-session-stored', recordId: 'record-1', recordCwd: '/mock/project' },
    hasSessionRecord: true,
    tasks: { update: vi.fn() },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  setRemoteLaunchResolver(null);
  vi.restoreAllMocks();
});

describe('prepareAgentSpawn resuming a conversation', () => {
  it('on a remote host: hands the reconcile the ssh place and no cliPath', async () => {
    setRemoteLaunchResolver({ resolve: async () => ({ place, remote: { hostId: 'host-a', cwd: '/home/dev/api', shellName: 'bash' } }) });

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const reconcileParams = reconcileMock.mock.calls[0][0] as unknown as { cliPath?: string; place: unknown };
    expect(reconcileParams.cliPath).toBeUndefined();
    expect(reconcileParams.place).toMatchObject({ kind: 'ssh', hostId: 'host-a' });
  });

  it('on this computer: hands the reconcile the detected cliPath', async () => {
    setRemoteLaunchResolver({ resolve: async () => null });

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    const reconcileParams = reconcileMock.mock.calls[0][0] as unknown as { cliPath?: string };
    expect(reconcileParams.cliPath).toBe('/usr/local/bin/claude');
  });
});
