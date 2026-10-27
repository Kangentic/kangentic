/**
 * Wiring test: prepareAgentSpawn (the STARTUP spawn chokepoint) resolves where
 * the agent CLI runs once per spawn, as the board path does. A CLI configured
 * by its \\wsl.localhost path runs in that distro's shell, so the command is
 * built for that shell and the caller spawns in it, whatever the Terminal
 * setting says. The caller records the distro on the session row.
 *
 * Target resolution runs for real, as on Windows with the distro's facts
 * already read, so the file runs on any OS without calling wsl.exe.
 *
 * Red-green: building with `input.resolvedShell` alone fails the first case's
 * shell assertions; dropping `cliTarget` from the command options or the
 * result fails the matching assertion; resolving after ensureTrust fails the
 * ordering case; resolving a target for an adapter without WSL support fails
 * the last case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';

const WSL_CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

const FACTS = vi.hoisted(() => ({
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/home/dev/.local/bin:/usr/bin',
  env: {},
  networkingMode: 'nat' as const,
}));

const resolveCliTargetSpy = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  resolveCliTargetSpy.mockImplementation((cliPath: string | null | undefined, adapterSupportsWsl: boolean) =>
    original.resolveCliTarget(cliPath, adapterSupportsWsl, { platform: 'win32', resolveFacts: async () => FACTS }));
  return { ...original, resolveCliTarget: resolveCliTargetSpy };
});

const resolveShimLaunchMock = vi.hoisted(() =>
  vi.fn(async (input: { agentPath: string; shell: string | undefined; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
);

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: resolveShimLaunchMock,
}));

const buildCommandMock = vi.fn(() => 'claude --mock-run');
const ensureTrustMock = vi.fn(async () => {});

const adapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: false,
  supportsWslCli: true as boolean | undefined,
  detect: vi.fn(async () => ({ found: true, path: WSL_CLI_PATH, version: '2.1.311' })),
  ensureTrust: ensureTrustMock,
  buildCommand: buildCommandMock,
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn((agentName: string) => (agentName === 'claude' ? adapterRef : undefined)),
  },
}));

// prepareAgentSpawn creates the on-disk session directory; keep it virtual.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
  },
}));

const adapterRef = adapter;

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

function makeTask(): Task {
  return {
    id: 'task-startup-wsl-001',
    display_id: 1,
    title: 'Startup task',
    description: 'Recover me',
    swimlane_id: 'lane-review',
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    run_mode: 'column_settings',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  } as Task;
}

function makeSwimlane(): Swimlane {
  return {
    id: 'lane-review',
    name: 'Review',
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
  } as Swimlane;
}

async function runPrepare() {
  return prepareAgentSpawn({
    task: makeTask(),
    swimlane: makeSwimlane(),
    cwd: '/mock/project',
    projectId: 'proj-123',
    projectPath: '/mock/project',
    effectiveConfig: { agent: { permissionMode: 'acceptEdits', cliPaths: {} }, mcpServer: { enabled: false } } as unknown as AppConfig,
    projectDefaultAgent: 'claude',
    projectDefaultModel: null,
    projectDefaultEffort: null,
    resolvedShell: PWSH,
    mcpServerHandle: null,
    resume: null,
    hasSessionRecord: true,
    tasks: { update: vi.fn() },
  });
}

describe('prepareAgentSpawn: where the agent CLI runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.supportsWslCli = true;
  });

  it('builds for the distro shell and returns it with the target for the spawn and the row', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveShimLaunchMock).toHaveBeenCalledWith(expect.objectContaining({ shell: 'wsl -d Ubuntu' }));
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({
      shell: 'wsl -d Ubuntu',
      cliTarget: { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/claude', facts: FACTS },
    });
    expect(result.data.shell).toBe('wsl -d Ubuntu');
    expect(result.data.cliTarget).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('resolves the target before ensureTrust, which a distro CLI keeps in the distro', async () => {
    await runPrepare();

    expect(resolveCliTargetSpy).toHaveBeenCalledWith(WSL_CLI_PATH, true);
    expect(resolveCliTargetSpy.mock.invocationCallOrder[0]).toBeLessThan(ensureTrustMock.mock.invocationCallOrder[0]);
  });

  it('keeps the configured shell and no target for an adapter that does not run from WSL', async () => {
    adapter.supportsWslCli = undefined;

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({ shell: PWSH, cliTarget: null });
    expect(result.data.shell).toBe(PWSH);
    expect(result.data.cliTarget).toBeNull();
  });
});
