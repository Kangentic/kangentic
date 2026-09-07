/**
 * Wiring test: prepareAgentSpawn (the STARTUP spawn chokepoint) resolves the
 * shim launch before building the command (src/main/agent/shared/shim-launch.ts).
 *
 * On Windows an npm-installed CLI resolves to its `.cmd` shim, which a
 * PowerShell or Git Bash host launches through cmd.exe, and cmd.exe keeps only
 * the first line of a multi-line prompt (#353). resolveShimLaunch swaps in the
 * sibling shim the host can run. This path never carries a prompt, but a
 * crash-recovered session must launch through the same head the board spawn
 * used, so the swap has to happen here too.
 *
 * The helper is mocked with a pass-through default so the REAL
 * prepareAgentSpawn runs end to end on every OS; one test swaps the head to
 * prove the builder sees the helper's result, not detect()'s. A separate file
 * from prepare-spawn-first-spawn-lock.test.ts because vi.mock is file-global
 * and the lock tests should keep exercising the unmocked import.
 *
 * Red-green: building from `detection.path` instead of `launch.agentPath`
 * fails the swap test; dropping the `await` or moving the call above
 * ensureTrust fails the ordering test; feeding buildEnv a second options
 * object fails the shared-options test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';

const CMD_HEAD = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD';
const PS1_SIBLING = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.ps1';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

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

const buildCommandMock = vi.fn(() => 'codex --mock-run');
const buildEnvMock = vi.fn(() => null);
const ensureTrustMock = vi.fn(async () => {});

const adapter = {
  name: 'codex',
  displayName: 'Codex',
  sessionType: 'codex_agent',
  supportsCallerSessionId: false,
  detect: vi.fn(async () => ({ found: true, path: CMD_HEAD, version: '1.0.0' })),
  ensureTrust: ensureTrustMock,
  buildCommand: buildCommandMock,
  buildEnv: buildEnvMock,
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn((agentName: string) => (agentName === 'codex' ? adapterRef : undefined)),
  },
}));

// prepareAgentSpawn creates the on-disk session directory; keep it virtual.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
  },
}));

// Referenced from the vi.mock factory above (hoisted), so declared via
// module scope after the mock declarations run.
const adapterRef = adapter;

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

const TASK_ID = 'task-startup-shim-001';
const LANE_ID = 'lane-review';

function makeTask(): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'Startup task',
    description: 'Recover me',
    swimlane_id: LANE_ID,
    position: 0,
    agent: 'codex',
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
    id: LANE_ID,
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

function makeEffectiveConfig(): AppConfig {
  return {
    agent: {
      permissionMode: 'acceptEdits',
      cliPaths: {},
    },
    mcpServer: { enabled: false },
  } as unknown as AppConfig;
}

async function runPrepare() {
  return prepareAgentSpawn({
    task: makeTask(),
    swimlane: makeSwimlane(),
    cwd: '/mock/project',
    projectId: 'proj-123',
    projectPath: '/mock/project',
    effectiveConfig: makeEffectiveConfig(),
    projectDefaultAgent: 'codex',
    projectDefaultModel: null,
    projectDefaultEffort: null,
    resolvedShell: PWSH,
    mcpServerHandle: null,
    resume: null,
    hasSessionRecord: true,
    tasks: { update: vi.fn() },
  });
}

describe('prepareAgentSpawn: Windows .cmd shim launch resolution wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the detected path, the resolved shell, and an undefined prompt to resolveShimLaunch', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    expect(resolveShimLaunchMock).toHaveBeenCalledTimes(1);
    expect(resolveShimLaunchMock).toHaveBeenCalledWith({ agentPath: CMD_HEAD, shell: PWSH, prompt: undefined });
  });

  it('builds the command from the resolved head, not the detected one', async () => {
    resolveShimLaunchMock.mockResolvedValueOnce({ agentPath: PS1_SIBLING, prompt: undefined, strategy: 'ps1-sibling' });

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    expect(buildCommandMock).toHaveBeenCalledTimes(1);
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({ agentPath: PS1_SIBLING, shell: PWSH, prompt: undefined });
  });

  it('resolves after ensureTrust and before buildCommand', async () => {
    await runPrepare();

    const ensureTrustOrder = ensureTrustMock.mock.invocationCallOrder[0];
    const resolveOrder = resolveShimLaunchMock.mock.invocationCallOrder[0];
    const buildOrder = buildCommandMock.mock.invocationCallOrder[0];
    expect(ensureTrustOrder).toBeLessThan(resolveOrder);
    expect(resolveOrder).toBeLessThan(buildOrder);
  });

  it('passes the same resolved options object to buildEnv', async () => {
    resolveShimLaunchMock.mockResolvedValueOnce({ agentPath: PS1_SIBLING, prompt: undefined, strategy: 'ps1-sibling' });

    await runPrepare();

    expect(buildEnvMock).toHaveBeenCalledTimes(1);
    expect(buildEnvMock.mock.calls[0][0]).toBe(buildCommandMock.mock.calls[0][0]);
  });
});
