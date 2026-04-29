/**
 * Unit tests for prepareAgentSpawn (src/main/engine/session-startup/prepare-spawn.ts).
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
vi.mock('../../src/main/engine/session-paths', () => ({
  sessionOutputPaths: sessionOutputPathsMock,
}));

// resolveTargetAgent always returns 'opencode' so agentRegistry.get('opencode')
// is called. Individual tests configure agentRegistryGetMock to return the
// desired adapter.
vi.mock('../../src/main/engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'opencode', isHandoff: false })),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: (...args: unknown[]) => agentRegistryGetMock(...(args as [string])) },
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are declared.
// ---------------------------------------------------------------------------
import { prepareAgentSpawn } from '../../src/main/engine/session-startup/prepare-spawn';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    title: 'Test Task',
    description: '',
    swimlane_id: 'lane-001',
    position: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    archived_at: null,
    session_id: null,
    agent: null,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    ...overrides,
  };
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-001',
    name: 'In Progress',
    position: 1,
    auto_spawn: true,
    role: 'active',
    permission_mode: null,
    agent_override: null,
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
    resolvedShell: '/bin/bash',
    mcpServerHandle: overrides.mcpServerHandle ?? null,
    resume: overrides.resume ?? null,
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
