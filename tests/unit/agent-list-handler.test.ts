/**
 * Unit tests for the AGENT_LIST IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * The handler iterates the agent registry, calls detect() on each adapter,
 * and conditionally calls probeAuth() (only when detect() returned found:true
 * AND the adapter has a probeAuth method). The result is merged into the
 * AgentDetectionInfo output shape as `authenticated`.
 *
 * Strategy: mock electron (ipcMain.handle captures the registered callback),
 * mock the agent-registry dynamic import, and mock config-manager. Tests call
 * the captured handler directly - no Electron binary needed.
 *
 * Covers:
 *   - found:false agent -> probeAuth is NOT called, authenticated is undefined
 *   - found:true + probeAuth not defined -> authenticated is undefined
 *   - found:true + probeAuth returns true -> authenticated is true
 *   - found:true + probeAuth returns false -> authenticated is false
 *   - found:true + probeAuth returns null -> authenticated is null
 *   - found:true + probeAuth throws -> .catch(() => null) coerces to null
 *   - multiple agents returned in registry order
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDetectionInfo } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

// Capture the handler registered for each IPC channel so we can invoke it
// directly without a running Electron process.
const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: {
    isSupported: vi.fn(() => false),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
}));

// Mock the agent-registry dynamic import used inside registerSystemHandlers.
// Each test configures mockRegistryAdapters to control adapter behaviour.
type MockAdapter = {
  name: string;
  displayName: string;
  permissions: { mode: string; label: string }[];
  defaultPermission: string;
  detect: () => Promise<{ found: boolean; path: string | null; version: string | null }>;
  probeAuth?: () => Promise<boolean | null>;
  invalidateDetectionCache: () => void;
};

let mockRegistryAdapters: MockAdapter[] = [];

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => mockRegistryAdapters.map((adapter) => adapter.name),
    getOrThrow: (name: string) => {
      const adapter = mockRegistryAdapters.find((a) => a.name === name);
      if (!adapter) throw new Error(`No adapter for ${name}`);
      return adapter;
    },
    get: (name: string) => mockRegistryAdapters.find((a) => a.name === name) ?? null,
    has: (name: string) => mockRegistryAdapters.some((a) => a.name === name),
  },
}));

// Silence all handler-dependency imports that are not exercised in these tests.
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {},
}));
vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class {
    listByTaskId = vi.fn(() => []);
  },
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  syncProjectMcpConfig: vi.fn(),
}));
vi.mock('../../src/shared/object-utils', () => ({
  deepMergeConfig: vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
}));

// Mock node:child_process (used by shell:exec handler)
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions() {
  return [{ mode: 'default', label: 'Default' }];
}

function makeAdapter(overrides: Partial<MockAdapter> & { name: string }): MockAdapter {
  return {
    displayName: overrides.name.charAt(0).toUpperCase() + overrides.name.slice(1),
    permissions: makePermissions(),
    defaultPermission: 'default',
    detect: vi.fn(async () => ({ found: true, path: `/usr/bin/${overrides.name}`, version: '1.0.0' })),
    invalidateDetectionCache: vi.fn(),
    ...overrides,
  };
}

function makeContext() {
  return {
    configManager: {
      load: vi.fn(() => ({
        agent: {
          cliPaths: {},
          cliPath: null,
          maxConcurrentSessions: 5,
          idleTimeoutMinutes: 30,
          permissionMode: 'default',
          queueOverflow: 'queue',
        },
        terminal: { shell: null },
        mcpServer: { enabled: false },
      })),
      getEffectiveConfig: vi.fn(() => ({
        agent: {
          cliPaths: {},
          maxConcurrentSessions: 5,
          idleTimeoutMinutes: 30,
        },
        terminal: { shell: null },
      })),
      save: vi.fn(),
      saveProjectOverrides: vi.fn(),
      loadProjectOverrides: vi.fn(() => null),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
    },
    sessionManager: {
      setMaxConcurrent: vi.fn(),
      setShell: vi.fn(),
      setIdleTimeout: vi.fn(),
    },
    projectRepo: {
      list: vi.fn(() => []),
    },
    shellResolver: {
      getAvailableShells: vi.fn(() => []),
      getDefaultShell: vi.fn(() => 'bash'),
    },
    gitDetector: {
      detect: vi.fn(() => ({ found: false })),
    },
    mainWindow: {
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false),
      close: vi.fn(),
      isFocused: vi.fn(() => true),
      flashFrame: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      once: vi.fn(),
      webContents: { send: vi.fn() },
    },
    currentProjectPath: null,
    currentProjectId: null,
  };
}

async function invokeAgentList(): Promise<AgentDetectionInfo[]> {
  const handler = capturedHandlers.get('agent:list');
  if (!handler) throw new Error('agent:list handler not registered');
  return handler() as Promise<AgentDetectionInfo[]>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AGENT_LIST IPC handler - probeAuth integration', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockRegistryAdapters = [];
    const context = makeContext();
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);
  });

  it('skips probeAuth and leaves authenticated undefined when found is false', async () => {
    const probeAuth = vi.fn(async () => false);
    mockRegistryAdapters = [
      makeAdapter({
        name: 'kimi',
        detect: vi.fn(async () => ({ found: false, path: null, version: null })),
        probeAuth,
      }),
    ];

    const results = await invokeAgentList();

    expect(probeAuth).not.toHaveBeenCalled();
    expect(results[0].authenticated).toBeUndefined();
  });

  it('leaves authenticated undefined when adapter has no probeAuth method', async () => {
    mockRegistryAdapters = [
      makeAdapter({
        name: 'claude',
        detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '2.0.0' })),
        // probeAuth intentionally not set
      }),
    ];

    const results = await invokeAgentList();

    expect(results[0].authenticated).toBeUndefined();
  });

  it('sets authenticated to true when probeAuth resolves to true', async () => {
    mockRegistryAdapters = [
      makeAdapter({
        name: 'kimi',
        probeAuth: vi.fn(async () => true as boolean | null),
      }),
    ];

    const results = await invokeAgentList();

    expect(results[0].authenticated).toBe(true);
  });

  it('sets authenticated to false when probeAuth resolves to false', async () => {
    mockRegistryAdapters = [
      makeAdapter({
        name: 'kimi',
        probeAuth: vi.fn(async () => false as boolean | null),
      }),
    ];

    const results = await invokeAgentList();

    expect(results[0].authenticated).toBe(false);
  });

  it('sets authenticated to null when probeAuth resolves to null', async () => {
    mockRegistryAdapters = [
      makeAdapter({
        name: 'kimi',
        probeAuth: vi.fn(async () => null),
      }),
    ];

    const results = await invokeAgentList();

    expect(results[0].authenticated).toBeNull();
  });

  it('coerces a thrown probeAuth error to null via .catch(() => null)', async () => {
    mockRegistryAdapters = [
      makeAdapter({
        name: 'kimi',
        probeAuth: vi.fn(async () => {
          throw new Error('credentials directory unreadable');
        }),
      }),
    ];

    // The handler must NOT throw - it must catch and return null.
    const results = await invokeAgentList();

    expect(results[0].authenticated).toBeNull();
  });

  it('returns all agents in registry list order with correct shape', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude' }),
      makeAdapter({
        name: 'kimi',
        probeAuth: vi.fn(async () => false as boolean | null),
      }),
    ];

    const results = await invokeAgentList();

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('claude');
    expect(results[0].authenticated).toBeUndefined();
    expect(results[1].name).toBe('kimi');
    expect(results[1].authenticated).toBe(false);
  });

  it('includes name, displayName, found, path, version, permissions, defaultPermission in output', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude' }),
    ];

    const results = await invokeAgentList();
    const result = results[0];

    expect(result.name).toBe('claude');
    expect(result.displayName).toBe('Claude');
    expect(result.found).toBe(true);
    expect(result.path).toBe('/usr/bin/claude');
    expect(result.version).toBe('1.0.0');
    expect(Array.isArray(result.permissions)).toBe(true);
    expect(result.defaultPermission).toBe('default');
  });
});
