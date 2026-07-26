/**
 * Unit tests for prepareAgentSpawn (src/main/transition-engine/session-startup/prepare-spawn.ts).
 *
 * Focuses on the extraEnv field: the result of adapter.buildEnv?.() being captured
 * correctly (or absent correctly) in the returned PreparedSpawn.
 *
 * All collaborators that touch disk, Electron, or native modules are mocked so
 * these tests run in pure Node with no build step and no side effects.
 *
 * Hoisting strategy: vi.mock() factories are hoisted to the top of the file by
 * Vitest before any const declarations are evaluated. All mock functions that need
 * to be referenced in both the vi.mock factory AND in test/beforeEach code are
 * created with vi.hoisted() so they exist before hoisting occurs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentAdapter, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { Task, Swimlane, AppConfig } from '../../src/shared/types';
import { OpenCodeCommandBuilder, type OpenCodeCommandOptions } from '../../src/main/agent/adapters/opencode';
import { CodexCommandBuilder, type CodexCommandOptions } from '../../src/main/agent/adapters/codex';
import type { AgentLaunchOptionInfo } from '../../src/shared/types';
// Type-only: erased at compile time, so importing it does not drag the heavy
// mcp-http-server module graph (SDK, agent commands, ...) into this test.
import type { McpHttpServerHandle } from '../../src/main/agent/mcp-http-server';

// ---------------------------------------------------------------------------
// Hoisted mock functions - all mocks that need to be referenced outside of
// vi.mock() factories must be created here first.
// ---------------------------------------------------------------------------

const {
  randomUUIDMock,
  sessionOutputPathsMock,
  agentRegistryGetMock,
  FAKE_SESSION_RECORD_ID,
  FAKE_AGENT_SESSION_ID,
} = vi.hoisted(() => {
  const recordId = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
  const agentId = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
  return {
    randomUUIDMock: vi.fn<[], string>(),
    sessionOutputPathsMock: vi.fn<[string], { statusOutputPath: string; eventsOutputPath: string }>(),
    agentRegistryGetMock: vi.fn<[string], unknown>(),
    FAKE_SESSION_RECORD_ID: recordId,
    FAKE_AGENT_SESSION_ID: agentId,
  };
});

// ---------------------------------------------------------------------------
// Module mocks - declared after vi.hoisted() so all hoisted values are available
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

// Mock fs so mkdirSync never touches disk.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

// randomUUID is called twice per prepareAgentSpawn invocation:
//   1st call → sessionRecordId
//   2nd call → agentSessionId (only for adapters with supportsCallerSessionId=true)
vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock,
}));

// sessionOutputPaths builds file paths from a session directory.
vi.mock('../../src/main/transition-engine/session-paths', () => ({
  sessionOutputPaths: sessionOutputPathsMock,
}));

// resolveTargetAgent always returns 'opencode' so agentRegistry.get('opencode')
// is called. Individual tests configure agentRegistryGetMock to return the
// desired adapter.
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'opencode', isHandoff: false })),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: (...args: unknown[]) => agentRegistryGetMock(...(args as [string])) },
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are declared.
// ---------------------------------------------------------------------------
import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    display_id: 1,
    title: 'Test Task',
    description: '',
    swimlane_id: 'lane-001',
    position: 0,
    agent: null,
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
    ...overrides,
  };
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-001',
    name: 'In Progress',
    role: null,
    position: 1,
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
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agent: {
      cliPaths: {},
      permissionMode: 'default',
      maxConcurrentSessions: 5,
      queueOverflow: 'queue',
      autoResumeSessionsOnRestart: true,
      ...((overrides.agent ?? {}) as object),
    },
    git: {
      worktreesEnabled: false,
      defaultBaseBranch: 'main',
      ...(overrides.git ?? {}),
    },
    mcpServer: {
      enabled: true,
      ...(overrides.mcpServer ?? {}),
    },
    ...overrides,
  } as AppConfig;
}

/** Minimal stub for AgentAdapter. Controls buildEnv behaviour via options. */
function makeAdapter(
  options: {
    name?: string;
    supportsCallerSessionId?: boolean;
    /** 'omit' means buildEnv is not defined on the adapter at all. */
    buildEnvResult?: Record<string, string> | null | 'omit';
  } = {},
): AgentAdapter {
  const adapterName = options.name ?? 'opencode';
  const supportsCallerSessionId = options.supportsCallerSessionId ?? false;
  const buildEnvResult = options.buildEnvResult;

  const adapter: Partial<AgentAdapter> = {
    name: adapterName,
    displayName: adapterName.charAt(0).toUpperCase() + adapterName.slice(1),
    sessionType: `${adapterName}_agent` as AgentAdapter['sessionType'],
    supportsCallerSessionId,
    permissions: [],
    defaultPermission: 'default',
    async detect(_overridePath?: string | null) {
      return { found: true, path: `/usr/bin/${adapterName}`, version: '1.0.0' };
    },
    invalidateDetectionCache() {},
    async ensureTrust(_workingDirectory: string) {},
    buildCommand(_options: SpawnCommandOptions) {
      return `/usr/bin/${adapterName} --prompt 'hello'`;
    },
    interpolateTemplate(template: string, _variables: Record<string, string>) {
      return template;
    },
    removeHooks(_directory: string, _taskId?: string) {},
    clearSettingsCache() {},
    detectFirstOutput(_data: string) {
      return false;
    },
    async locateSessionHistoryFile(_agentSessionId: string, _cwd: string) {
      return null;
    },
    runtime: {
      activity: { kind: 'pty' },
      sessionId: undefined,
    },
  };

  // Only attach buildEnv when the caller wants it present on the adapter.
  if (buildEnvResult !== 'omit') {
    const capturedResult = buildEnvResult ?? null;
    adapter.buildEnv = (_options: SpawnCommandOptions) => capturedResult;
  }

  return adapter as AgentAdapter;
}

function makeSpawnInput(overrides: {
  task?: Task;
  swimlane?: Swimlane | null;
  cwd?: string;
  projectId?: string;
  projectPath?: string;
  effectiveConfig?: AppConfig;
  resume?: { agentSessionId: string } | null;
  mcpServerHandle?: import('../../src/main/agent/mcp-http-server').McpHttpServerHandle | null;
} = {}) {
  return {
    task: overrides.task ?? makeTask(),
    swimlane: overrides.swimlane ?? makeSwimlane(),
    cwd: overrides.cwd ?? '/home/dev/project',
    projectId: overrides.projectId ?? 'proj-001',
    projectPath: overrides.projectPath ?? '/home/dev/project',
    effectiveConfig: overrides.effectiveConfig ?? makeAppConfig(),
    projectDefaultAgent: null,
    projectDefaultModel: null,
    projectDefaultEffort: null,
    resolvedShell: '/bin/bash',
    mcpServerHandle: overrides.mcpServerHandle ?? null,
    resume: overrides.resume ?? null,
    // This suite tests the LIVE resolution chains (model/effort/permission
    // passthrough), so keep the first-spawn override lock a no-op: with a
    // session record "in hand" the preamble never locks, and the fixtures'
    // task-vs-lane inheritance stays dynamic. The lock itself is covered by
    // prepare-spawn-first-spawn-lock.test.ts.
    hasSessionRecord: true,
    tasks: { update: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Per-test setup: reset then re-configure mocks with fresh return-value queues.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.resetAllMocks();

  // randomUUID is called in sequence inside prepareAgentSpawn:
  //   call 1 → sessionRecordId (always)
  //   call 2 → agentSessionId (only when supportsCallerSessionId=true)
  // Queue both after each reset so deterministic IDs are always available.
  randomUUIDMock
    .mockReturnValueOnce(FAKE_SESSION_RECORD_ID)
    .mockReturnValueOnce(FAKE_AGENT_SESSION_ID);

  // Restore sessionOutputPaths implementation after resetAllMocks clears it.
  sessionOutputPathsMock.mockImplementation((sessionDir: string) => ({
    statusOutputPath: `${sessionDir}/status.json`,
    eventsOutputPath: `${sessionDir}/events.jsonl`,
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: build a capture adapter whose buildCommand records what it receives.
// ---------------------------------------------------------------------------

function makeCaptureAdapter(
  options: {
    name?: string;
    supportsCallerSessionId?: boolean;
    /** Declared boolean launch-option toggles (AgentAdapter.launchOptions is
     * readonly, so it must be set here at construction rather than assigned
     * after the fact). Defaults to undefined, matching every adapter but
     * Codex. */
    launchOptions?: readonly AgentLaunchOptionInfo[];
  } = {},
): { adapter: AgentAdapter; capturedCommandOptions: SpawnCommandOptions[] } {
  const capturedCommandOptions: SpawnCommandOptions[] = [];
  const adapterName = options.name ?? 'opencode';

  const adapter: Partial<AgentAdapter> = {
    name: adapterName,
    displayName: adapterName,
    sessionType: `${adapterName}_agent` as AgentAdapter['sessionType'],
    supportsCallerSessionId: options.supportsCallerSessionId ?? false,
    launchOptions: options.launchOptions,
    permissions: [],
    defaultPermission: 'default',
    async detect(_overridePath?: string | null) {
      return { found: true, path: `/usr/bin/${adapterName}`, version: '1.0.0' };
    },
    invalidateDetectionCache() {},
    async ensureTrust(_workingDirectory: string) {},
    buildCommand(commandOptions: SpawnCommandOptions) {
      capturedCommandOptions.push(commandOptions);
      return `/usr/bin/${adapterName}`;
    },
    interpolateTemplate(template: string, _variables: Record<string, string>) {
      return template;
    },
    removeHooks(_directory: string, _taskId?: string) {},
    clearSettingsCache() {},
    detectFirstOutput(_data: string) {
      return false;
    },
    async locateSessionHistoryFile(_agentSessionId: string, _cwd: string) {
      return null;
    },
    runtime: {
      activity: { kind: 'pty' },
      sessionId: undefined,
    },
  };

  return { adapter: adapter as AgentAdapter, capturedCommandOptions };
}

describe('prepareAgentSpawn - model/effort override passthrough', () => {
  it('passes task model_override to buildCommand when the task has an override and the lane does not', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithOverride = makeTask({ model_override: 'sonnet', effort_override: null } as Partial<Task>);
    const laneWithNoOverride = makeSwimlane({ model_override: null, effort_override: null } as Partial<Swimlane>);

    const result = await prepareAgentSpawn(makeSpawnInput({ task: taskWithOverride, swimlane: laneWithNoOverride }));

    expect(result.ok).toBe(true);
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].model).toBe('sonnet');
    expect(capturedCommandOptions[0].effort).toBeUndefined();
  });

  it('passes lane model_override to buildCommand when the task has no override (null falls through)', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithNoOverride = makeTask({ model_override: null, effort_override: null } as Partial<Task>);
    const laneWithOverride = makeSwimlane({ model_override: 'opus', effort_override: null } as Partial<Swimlane>);

    const result = await prepareAgentSpawn(makeSpawnInput({ task: taskWithNoOverride, swimlane: laneWithOverride }));

    expect(result.ok).toBe(true);
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].model).toBe('opus');
  });

  it('passes task effort_override to buildCommand, with task winning over the lane', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithOverride = makeTask({ model_override: null, effort_override: 'high' } as Partial<Task>);
    const laneWithOverride = makeSwimlane({ model_override: null, effort_override: 'low' } as Partial<Swimlane>);

    const result = await prepareAgentSpawn(makeSpawnInput({ task: taskWithOverride, swimlane: laneWithOverride }));

    expect(result.ok).toBe(true);
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].effort).toBe('high');
  });

  it('passes undefined for model and effort when both task and lane have no overrides', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithNoOverride = makeTask({ model_override: null, effort_override: null } as Partial<Task>);
    const laneWithNoOverride = makeSwimlane({ model_override: null, effort_override: null } as Partial<Swimlane>);

    const result = await prepareAgentSpawn(makeSpawnInput({ task: taskWithNoOverride, swimlane: laneWithNoOverride }));

    expect(result.ok).toBe(true);
    expect(capturedCommandOptions).toHaveLength(1);
    // Both null coalesced with ?? undefined produces undefined, which is what
    // the adapter's buildCommand expects when no override is active.
    expect(capturedCommandOptions[0].model).toBeUndefined();
    expect(capturedCommandOptions[0].effort).toBeUndefined();
  });
});

describe('prepareAgentSpawn - permission_mode resolution', () => {
  it('resolves permissionMode from task.permission_mode, winning over a differing NON-plan swimlane.permission_mode', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithPermissionOverride = makeTask({ permission_mode: 'plan' } as Partial<Task>);
    const laneWithDifferentMode = makeSwimlane({ permission_mode: 'acceptEdits' } as Partial<Swimlane>);
    const configWithDifferentDefault = makeAppConfig({
      agent: { cliPaths: {}, permissionMode: 'default', maxConcurrentSessions: 5, queueOverflow: 'queue', autoResumeSessionsOnRestart: true },
    });

    const result = await prepareAgentSpawn(makeSpawnInput({
      task: taskWithPermissionOverride,
      swimlane: laneWithDifferentMode,
      effectiveConfig: configWithDifferentDefault,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(result.data.permissionMode).toBe('plan');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].permissionMode).toBe('plan');
  });

  it('a swimlane forcing plan mode ALWAYS wins, regardless of a differing task.permission_mode', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithPermissionOverride = makeTask({ permission_mode: 'auto' } as Partial<Task>);
    const laneForcingPlan = makeSwimlane({ permission_mode: 'plan' } as Partial<Swimlane>);
    const configWithDifferentDefault = makeAppConfig({
      agent: { cliPaths: {}, permissionMode: 'default', maxConcurrentSessions: 5, queueOverflow: 'queue', autoResumeSessionsOnRestart: true },
    });

    const result = await prepareAgentSpawn(makeSpawnInput({
      task: taskWithPermissionOverride,
      swimlane: laneForcingPlan,
      effectiveConfig: configWithDifferentDefault,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(result.data.permissionMode).toBe('plan');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].permissionMode).toBe('plan');
  });

  it('falls through to task.permission_mode when the swimlane has no permission_mode set', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const taskWithPermissionOverride = makeTask({ permission_mode: 'auto' } as Partial<Task>);
    const laneWithNoOverride = makeSwimlane({ permission_mode: null } as Partial<Swimlane>);
    const configWithDifferentDefault = makeAppConfig({
      agent: { cliPaths: {}, permissionMode: 'default', maxConcurrentSessions: 5, queueOverflow: 'queue', autoResumeSessionsOnRestart: true },
    });

    const result = await prepareAgentSpawn(makeSpawnInput({
      task: taskWithPermissionOverride,
      swimlane: laneWithNoOverride,
      effectiveConfig: configWithDifferentDefault,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(result.data.permissionMode).toBe('auto');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].permissionMode).toBe('auto');
  });
});

describe('prepareAgentSpawn - extraEnv field', () => {
  it('returns extraEnv=null when adapter does not implement buildEnv', async () => {
    const adapterWithoutBuildEnv = makeAdapter({ buildEnvResult: 'omit' });
    agentRegistryGetMock.mockReturnValue(adapterWithoutBuildEnv);

    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(result.data.extraEnv).toBeNull();
  });

  it('returns extraEnv=null when adapter.buildEnv returns null (MCP disabled path)', async () => {
    const adapterReturningNull = makeAdapter({ buildEnvResult: null });
    agentRegistryGetMock.mockReturnValue(adapterReturningNull);

    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(result.data.extraEnv).toBeNull();
  });

  it('returns extraEnv equal to the dict returned by adapter.buildEnv', async () => {
    const expectedEnv = { OPENCODE_CONFIG_CONTENT: '{"mcp":{"kangentic":{"type":"remote"}}}' };
    const adapterWithEnv = makeAdapter({ buildEnvResult: expectedEnv });
    agentRegistryGetMock.mockReturnValue(adapterWithEnv);

    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(result.data.extraEnv).toEqual(expectedEnv);
  });

  it('returns ok:false with reason "unknown-agent" when adapter is not registered', async () => {
    agentRegistryGetMock.mockReturnValue(undefined);

    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected ok:false');
    expect(result.reason).toBe('unknown-agent');
  });

  it('returns ok:false with reason "cli-not-found" when adapter.detect returns found:false', async () => {
    const adapterCliMissing: AgentAdapter = {
      ...makeAdapter(),
      async detect(_overridePath?: string | null) {
        return { found: false, path: null, version: null };
      },
    };
    agentRegistryGetMock.mockReturnValue(adapterCliMissing);

    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected ok:false');
    expect(result.reason).toBe('cli-not-found');
  });

  it('passes the env dict through to PreparedSpawn.extraEnv verbatim (no mutation)', async () => {
    const originalEnv = Object.freeze({
      OPENCODE_CONFIG_CONTENT: '{"mcp":{"kangentic":{"type":"remote","url":"http://127.0.0.1:1234"}}}',
      SOME_OTHER_VAR: 'value',
    });
    const adapterWithMultiKeyEnv = makeAdapter({
      buildEnvResult: originalEnv as Record<string, string>,
    });
    agentRegistryGetMock.mockReturnValue(adapterWithMultiKeyEnv);

    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    // Strict reference equality: extraEnv must be the exact object returned by buildEnv,
    // not a copy. The function must not wrap or transform the returned value.
    expect(result.data.extraEnv).toBe(originalEnv);
  });
});

describe('prepareAgentSpawn - remote OpenCode execution wiring', () => {
  // Coverage hole: resolveExecutionTarget is called at this chokepoint
  // (session-startup/prepare-spawn.ts) and threaded into
  // commandOptions.executionTarget, but no prior test spawned through it with a
  // remote-configured agent. Deleting that wiring (either the
  // resolveExecutionTarget call or the executionTarget property on
  // commandOptions) would silently fall back to a local spawn while every other
  // test in this file kept passing, because they all leave
  // config.agent.executionServers/execution unset.
  //
  // The capture adapter's buildCommand is swapped for the REAL
  // OpenCodeCommandBuilder so the assertion exercises production attach-command
  // logic, not a hand-rolled stub of "did executionTarget arrive".
  it('threads resolveExecutionTarget into commandOptions.executionTarget, producing an attach command with the server URL', async () => {
    const openCodeCommandBuilder = new OpenCodeCommandBuilder();
    const { adapter, capturedCommandOptions } = makeCaptureAdapter({ name: 'opencode' });
    adapter.buildCommand = (commandOptions: SpawnCommandOptions) => {
      capturedCommandOptions.push(commandOptions);
      return openCodeCommandBuilder.buildOpenCodeCommand(commandOptions as unknown as OpenCodeCommandOptions);
    };
    agentRegistryGetMock.mockReturnValue(adapter);

    const configWithRemoteOpenCode = makeAppConfig({
      agent: {
        cliPaths: {},
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
        autoResumeSessionsOnRestart: true,
        executionServers: {
          opencode: { url: 'http://10.0.0.9:5100', auth: { kind: 'none' } },
        },
        execution: {
          opencode: { mode: 'remote', workingDirectory: '/srv/remote-project' },
        },
      } as unknown as AppConfig['agent'],
    });

    const result = await prepareAgentSpawn(makeSpawnInput({ effectiveConfig: configWithRemoteOpenCode }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].executionTarget).toEqual({
      url: 'http://10.0.0.9:5100',
      auth: { kind: 'none' },
      workingDirectory: '/srv/remote-project',
    });
    // Red: commenting out `executionTarget: resolveExecutionTarget(...)` in
    // prepareAgentSpawn's commandOptions (prepare-spawn.ts) makes
    // buildOpenCodeCommand take the local branch instead, and this command
    // would be the plain binary path with no 'attach' token and no server URL.
    expect(result.data.command).toContain('attach');
    expect(result.data.command).toContain('http://10.0.0.9:5100');
  });

  it('does not thread an executionTarget when the project is not configured for remote mode', async () => {
    // Plain capture stub (the default makeCaptureAdapter behavior), not the
    // real OpenCodeCommandBuilder: this test only needs to see what
    // commandOptions carried, not exercise the real attach-vs-local branch.
    const { adapter, capturedCommandOptions } = makeCaptureAdapter({ name: 'opencode' });
    agentRegistryGetMock.mockReturnValue(adapter);

    // config.agent.executionServers/execution both default to unset via
    // makeAppConfig, mirroring the common "no project has opted into remote"
    // case.
    const result = await prepareAgentSpawn(makeSpawnInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].executionTarget).toBeUndefined();
  });
});

describe('prepareAgentSpawn - Codex launch-option wiring', () => {
  // Coverage hole: resolveLaunchOptions is called at this chokepoint
  // (session-startup/prepare-spawn.ts) and threaded into
  // commandOptions.launchOptions, but no prior test spawned through it with
  // an adapter that declares launch options. Deleting that wiring (either the
  // resolveLaunchOptions call or the launchOptions property on
  // commandOptions) would silently drop the toggle while every other test in
  // this file kept passing, because they all use adapters with no declared
  // launchOptions.
  //
  // The capture adapter's buildCommand is swapped for the REAL
  // CodexCommandBuilder so the assertion exercises production
  // --disable-apps flag logic, not a hand-rolled stub of "did launchOptions
  // arrive".
  const codexLaunchOptions: readonly AgentLaunchOptionInfo[] = [{
    id: 'disableApps',
    label: 'Disable ChatGPT Apps',
    description: "Skips the optional ChatGPT Apps connector.",
    default: false,
  }];

  it('threads resolveLaunchOptions into commandOptions.launchOptions, producing a --disable apps flag', async () => {
    const codexCommandBuilder = new CodexCommandBuilder();
    const { adapter, capturedCommandOptions } = makeCaptureAdapter({
      name: 'codex',
      launchOptions: codexLaunchOptions,
    });
    adapter.buildCommand = (commandOptions: SpawnCommandOptions) => {
      capturedCommandOptions.push(commandOptions);
      const { agentPath, ...rest } = commandOptions;
      return codexCommandBuilder.buildCodexCommand({ codexPath: agentPath, ...rest } as CodexCommandOptions);
    };
    agentRegistryGetMock.mockReturnValue(adapter);

    const configWithLaunchOption = makeAppConfig({
      agent: {
        cliPaths: {},
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
        autoResumeSessionsOnRestart: true,
        launchOptions: {
          codex: { disableApps: true },
        },
      } as unknown as AppConfig['agent'],
    });

    const result = await prepareAgentSpawn(makeSpawnInput({ effectiveConfig: configWithLaunchOption }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].launchOptions).toEqual({ disableApps: true });
    // Red: commenting out `launchOptions: resolveLaunchOptions(...)` in
    // prepareAgentSpawn's commandOptions (prepare-spawn.ts) makes
    // buildCodexCommand never see the flag, so this command would omit
    // `--disable apps` entirely.
    expect(result.data.command).toContain('--disable apps');
  });

  it('does not thread a launchOptions value when the adapter declares no launch options', async () => {
    // Plain capture stub (the default makeCaptureAdapter behavior), not the
    // real CodexCommandBuilder: this test only needs to see what
    // commandOptions carried. launchOptions is left unset on the adapter even
    // though a stored override IS configured below - resolveLaunchOptions
    // must key off the ADAPTER's declared options, not the presence of
    // stored config.
    const { adapter, capturedCommandOptions } = makeCaptureAdapter({ name: 'codex' });
    agentRegistryGetMock.mockReturnValue(adapter);

    const configWithLaunchOption = makeAppConfig({
      agent: {
        cliPaths: {},
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
        autoResumeSessionsOnRestart: true,
        launchOptions: {
          codex: { disableApps: true },
        },
      } as unknown as AppConfig['agent'],
    });

    const result = await prepareAgentSpawn(makeSpawnInput({ effectiveConfig: configWithLaunchOption }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].launchOptions).toBeUndefined();
  });
});

describe('prepareAgentSpawn - MCP caller-session URL stamping', () => {
  // Coverage hole: prepareAgentSpawn wraps mcpServerUrl in
  // `appendCallerSession(input.mcpServerHandle?.urlForProject(projectId), sessionRecordId)`
  // so the MCP server can identify which session is calling (see
  // caller-url.ts). Every existing test in this file passes
  // mcpServerHandle: null (the makeSpawnInput default), so
  // appendCallerSession(undefined, id) returns undefined either way and a
  // regression to `input.mcpServerHandle?.urlForProject(projectId)` (dropping
  // the appendCallerSession wrapper entirely) would fail nothing above.
  function makeFakeMcpHandle(baseUrl: string): McpHttpServerHandle {
    return {
      baseUrl: `${baseUrl}/mcp`,
      token: 'mcp-token',
      urlForProject: (projectId: string) => `${baseUrl}/mcp/${projectId}`,
      close: () => {},
    };
  }

  it('stamps the spawned session record id as the third URL segment when an mcpServerHandle is supplied', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const result = await prepareAgentSpawn(makeSpawnInput({
      projectId: 'proj-caller-test',
      mcpServerHandle: makeFakeMcpHandle('http://127.0.0.1:9999'),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(capturedCommandOptions).toHaveLength(1);
    // Red: reverting prepare-spawn.ts's
    // `mcpServerUrl: appendCallerSession(input.mcpServerHandle?.urlForProject(projectId), sessionRecordId)`
    // back to `input.mcpServerHandle?.urlForProject(projectId)` makes this
    // 'http://127.0.0.1:9999/mcp/proj-caller-test' - no session segment.
    expect(capturedCommandOptions[0].mcpServerUrl).toBe(
      `http://127.0.0.1:9999/mcp/proj-caller-test/${FAKE_SESSION_RECORD_ID}`,
    );
    expect(result.data.sessionRecordId).toBe(FAKE_SESSION_RECORD_ID);
  });

  it('leaves mcpServerUrl undefined when no mcpServerHandle is supplied', async () => {
    const { adapter, capturedCommandOptions } = makeCaptureAdapter();
    agentRegistryGetMock.mockReturnValue(adapter);

    const result = await prepareAgentSpawn(makeSpawnInput({ mcpServerHandle: null }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok:true');
    expect(capturedCommandOptions).toHaveLength(1);
    expect(capturedCommandOptions[0].mcpServerUrl).toBeUndefined();
  });
});
