/**
 * Wiring test: prepareAgentSpawn (the STARTUP spawn chokepoint) runs a recovered session on the
 * account the service resolves (task #1057). The account's env reaches the PTY through
 * `buildSessionEnv` on top of the adapter's own, and its id goes back to the caller to stamp on
 * the session row. A CLI that runs in a WSL distro keeps its single login: no account resolves.
 *
 * Red-green: dropping `account` from the command options fails the env and id assertions;
 * dropping the `cliTarget ? null :` guard fails the WSL case; calling `adapter.buildEnv` directly
 * instead of `buildSessionEnv` fails the env assertion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';
import { setAccountService, type AccountService } from '../../src/main/accounts/account-service';

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

vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...original,
    resolveCliTarget: (cliPath: string | null | undefined, adapterSupportsWsl: boolean) =>
      original.resolveCliTarget(cliPath, adapterSupportsWsl, { platform: 'win32', resolveFacts: async () => FACTS }),
  };
});

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

const buildCommandMock = vi.fn(() => 'claude --mock-run');
const adapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: false,
  supportsWslCli: true as boolean | undefined,
  detect: vi.fn(async () => ({ found: true, path: WSL_CLI_PATH, version: '2.1.311' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: buildCommandMock,
  buildEnv: vi.fn(() => ({ ADAPTER_VARIABLE: 'adapter' })),
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn((agentName: string) => (agentName === 'claude' ? adapterRef : undefined)),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
  },
}));

const adapterRef = adapter;

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

const FOLDER_ACCOUNT = {
  id: 'account-2',
  agent: 'claude',
  kind: 'folder' as const,
  env: { CLAUDE_CONFIG_DIR: '/mock/accounts/claude/2' },
};

const resolveForSpawn = vi.fn(async () => FOLDER_ACCOUNT);

function makeTask(): Task {
  return {
    id: 'task-startup-account-001',
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

describe('prepareAgentSpawn: the account a recovered session runs on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.supportsWslCli = undefined;
    setAccountService({ resolveForSpawn } as unknown as AccountService);
  });

  afterEach(() => {
    setAccountService(null);
  });

  it('hands the account to the builder, merges its env over the adapter env and returns its id', async () => {
    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveForSpawn).toHaveBeenCalledWith('claude', undefined, undefined);
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({ account: FOLDER_ACCOUNT });
    expect(result.data.accountId).toBe('account-2');
    expect(result.data.extraEnv).toEqual({ ADAPTER_VARIABLE: 'adapter', CLAUDE_CONFIG_DIR: '/mock/accounts/claude/2' });
  });

  it('resolves no account for a CLI that runs in a WSL distro', async () => {
    adapter.supportsWslCli = true;

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cliTarget).not.toBeNull();
    expect(resolveForSpawn).not.toHaveBeenCalled();
    expect(result.data.accountId).toBeNull();
    expect(result.data.extraEnv).toEqual({ ADAPTER_VARIABLE: 'adapter' });
  });

  /**
   * A resume on another account than its conversation's runs in that account's
   * config folder, where the conversation is not, and the CLI answers "No
   * conversation found". The launch report says which it was (`resume_account`).
   */
  describe('the resume evidence names whether the account changed', () => {
    async function runResume(conversationAccountId: string) {
      const record = {
        id: 'record-1', task_id: 'task-startup-account-001', agent_session_id: 'agent-1', account_id: conversationAccountId,
        transcript_path: null, total_input_tokens: 900, total_output_tokens: 40, total_cost_usd: 0.1,
      };
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
        resume: { agentSessionId: 'agent-1' },
        sessionRepo: { updateAgentSessionId: vi.fn(), listForTaskNewestFirst: () => [record] as never },
        hasSessionRecord: true,
        tasks: { update: vi.fn() },
      });
    }

    it('reads same when the resume runs on the conversation\'s account', async () => {
      const result = await runResume('account-2');

      expect(result.ok && result.data.resumed).toBe(true);
      if (!result.ok) return;
      expect(resolveForSpawn).toHaveBeenCalledWith('claude', undefined, 'account-2');
      expect(result.data.resumeEvidence?.account).toBe('same');
    });

    it('reads changed when the service put the resume on another account', async () => {
      const result = await runResume('account-1');

      expect(result.ok && result.data.resumed).toBe(true);
      if (!result.ok) return;
      expect(result.data.resumeEvidence?.account).toBe('changed');
    });
  });

  it('keeps the adapter env and no account id when no service runs', async () => {
    setAccountService(null);

    const result = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.accountId).toBeNull();
    expect(result.data.extraEnv).toEqual({ ADAPTER_VARIABLE: 'adapter' });
  });
});
