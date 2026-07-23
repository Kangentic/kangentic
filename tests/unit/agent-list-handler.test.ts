/**
 * Unit tests for the AGENT_LIST and AGENT_PROBE_EXECUTION_SERVER IPC
 * handlers in src/main/ipc/handlers/system.ts.
 *
 * AGENT_LIST: the handler iterates the agent registry, calls detect() on
 * each adapter, and conditionally calls probeAuth() (only when detect()
 * returned found:true AND the adapter has a probeAuth method). The result is
 * merged into the AgentDetectionInfo output shape as `authenticated`, and
 * (support-remote-opencode) as `remoteExecution: adapter.remoteExecution?.info`.
 *
 * AGENT_PROBE_EXECUTION_SERVER: the "Test connection" handler. Reads the
 * server record from config, never from the renderer, and never throws.
 *
 * Strategy: mock electron (ipcMain.handle captures the registered callback),
 * mock the agent-registry dynamic import, and mock config-manager. Tests call
 * the captured handler directly - no Electron binary needed.
 *
 * Covers (AGENT_LIST):
 *   - found:false agent -> probeAuth is NOT called, authenticated is undefined
 *   - found:true + probeAuth not defined -> authenticated is undefined
 *   - found:true + probeAuth returns true -> authenticated is true
 *   - found:true + probeAuth returns false -> authenticated is false
 *   - found:true + probeAuth returns null -> authenticated is null
 *   - found:true + probeAuth throws -> .catch(() => null) coerces to null
 *   - multiple agents returned in registry order
 *   - remoteExecution passthrough: present -> surfaced as adapter.remoteExecution.info
 *     verbatim (and never leaks the probeServer function); absent -> undefined
 *
 * Covers (AGENT_PROBE_EXECUTION_SERVER):
 *   - adapter has no remoteExecution capability -> unreachable, capability reason
 *   - adapter has the capability but no server is configured -> unreachable, "No server configured"
 *   - server configured -> delegates to adapter.remoteExecution.probeServer and returns its result verbatim
 *   - probeServer throws an Error -> caught, unreachable with the error message
 *   - probeServer throws a non-Error -> caught, unreachable with "Unknown error"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDetectionInfo, AgentExecutionServer, AgentLaunchOptionInfo, AgentRemoteExecutionInfo, RemoteServerStatus } from '../../src/shared/types';

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
  discoverCapabilities?: (cliPath: string, forceRefresh?: boolean) => Promise<unknown>;
  invalidateDetectionCache: () => void;
  remoteExecution?: {
    info: AgentRemoteExecutionInfo;
    probeServer: (server: AgentExecutionServer) => Promise<RemoteServerStatus>;
  };
  launchOptions?: readonly AgentLaunchOptionInfo[];
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
import { resetAgentListForTests } from '../../src/main/agent/agent-list';

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
          executionServers: {},
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
      hydrateDiscoveredContextWindows: vi.fn(),
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

async function invokeAgentList(forceRefresh?: boolean): Promise<AgentDetectionInfo[]> {
  const handler = capturedHandlers.get('agent:list');
  if (!handler) throw new Error('agent:list handler not registered');
  // The real handler signature is (event, forceRefresh); pass a placeholder event.
  return handler(undefined, forceRefresh) as Promise<AgentDetectionInfo[]>;
}

function invokeConfigSet(config: unknown): void {
  const handler = capturedHandlers.get('config:set');
  if (!handler) throw new Error('config:set handler not registered');
  handler(undefined, config);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AGENT_LIST IPC handler - probeAuth integration', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockRegistryAdapters = [];
    // The handler delegates to a module-level cache; clear it so each case
    // starts cold and does not see a prior case's cached inventory.
    resetAgentListForTests();
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

  it('surfaces adapter.remoteExecution.info verbatim, without leaking the probeServer function', async () => {
    const info: AgentRemoteExecutionInfo = {
      urlPlaceholder: 'http://10.0.0.5:4096',
      authKind: 'basic',
      workingDirectoryScope: 'per-invocation',
      remoteModeCaveat: 'The server is the authority for providers, models, and MCP tools in remote mode.',
    };
    mockRegistryAdapters = [
      makeAdapter({
        name: 'opencode',
        remoteExecution: { info, probeServer: vi.fn() },
      }),
    ];

    const results = await invokeAgentList();

    expect(results[0].remoteExecution).toEqual(info);
    // Regression guard: a future edit that surfaces the whole
    // `adapter.remoteExecution` object (instead of just `.info`) would leak
    // a non-serializable function across the IPC boundary.
    expect(results[0].remoteExecution).not.toHaveProperty('probeServer');
  });

  it('leaves remoteExecution undefined for an adapter with no remote-execution capability', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude' }),
    ];

    const results = await invokeAgentList();

    expect(results[0].remoteExecution).toBeUndefined();
  });

  it('surfaces adapter.launchOptions verbatim for an adapter that declares them (Codex)', async () => {
    const launchOptions: AgentLaunchOptionInfo[] = [{
      id: 'disableApps',
      label: 'Disable ChatGPT Apps',
      description: 'Skip the optional cloud ChatGPT Apps MCP connector.',
      default: false,
    }];
    mockRegistryAdapters = [
      makeAdapter({ name: 'codex', launchOptions }),
    ];

    const results = await invokeAgentList();

    expect(results[0].launchOptions).toEqual(launchOptions);
  });

  it('leaves launchOptions undefined for an adapter with no launch-option capability', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude' }),
    ];

    const results = await invokeAgentList();

    expect(results[0].launchOptions).toBeUndefined();
  });
});

describe('AGENT_LIST IPC handler - caching', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockRegistryAdapters = [];
    resetAgentListForTests();
    const context = makeContext();
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);
  });

  it('serves a cached inventory on the second call without re-probing', async () => {
    const detect = vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' }));
    mockRegistryAdapters = [makeAdapter({ name: 'claude', detect })];

    const first = await invokeAgentList();
    const second = await invokeAgentList();

    expect(detect).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('forceRefresh rebuilds and invalidates every adapter detection cache', async () => {
    const detect = vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' }));
    const invalidateDetectionCache = vi.fn();
    mockRegistryAdapters = [makeAdapter({ name: 'claude', detect, invalidateDetectionCache })];

    await invokeAgentList();
    await invokeAgentList(true);

    expect(detect).toHaveBeenCalledTimes(2);
    expect(invalidateDetectionCache).toHaveBeenCalled();
  });

  it('threads forceRefresh into discoverCapabilities so adapter model caches are bypassed', async () => {
    const discoverCapabilities = vi.fn(async () => ({ models: ['claude-opus-4-8'] }));
    mockRegistryAdapters = [makeAdapter({ name: 'claude', discoverCapabilities })];

    // A plain open builds with the flag unset (background-warm path).
    await invokeAgentList();
    expect(discoverCapabilities).toHaveBeenLastCalledWith('/usr/bin/claude', false);

    // A forced rescan (dropdown open) reaches capability discovery so the
    // Claude adapter can bypass its 12h /model picker TTL.
    await invokeAgentList(true);
    expect(discoverCapabilities).toHaveBeenLastCalledWith('/usr/bin/claude', true);
  });

  it('rebuilds after CONFIG_SET invalidates the cache on an agent-config change', async () => {
    const detect = vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' }));
    mockRegistryAdapters = [makeAdapter({ name: 'claude', detect })];

    await invokeAgentList();
    invokeConfigSet({ agent: { cliPaths: { claude: '/opt/claude' } } });
    await invokeAgentList();

    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild after CONFIG_SET that does not touch agent config', async () => {
    const detect = vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' }));
    mockRegistryAdapters = [makeAdapter({ name: 'claude', detect })];

    await invokeAgentList();
    invokeConfigSet({ terminal: { shell: 'bash' } });
    await invokeAgentList();

    expect(detect).toHaveBeenCalledTimes(1);
  });
});

describe('AGENT_PROBE_EXECUTION_SERVER IPC handler', () => {
  let context: ReturnType<typeof makeContext>;

  async function invokeProbeExecutionServer(agentName: string): Promise<RemoteServerStatus> {
    const handler = capturedHandlers.get('agent:probeExecutionServer');
    if (!handler) throw new Error('agent:probeExecutionServer handler not registered');
    return handler(undefined, agentName) as Promise<RemoteServerStatus>;
  }

  beforeEach(() => {
    capturedHandlers.clear();
    mockRegistryAdapters = [];
    resetAgentListForTests();
    context = makeContext();
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);
  });

  it('reports unreachable with a capability-specific reason when the adapter has no remoteExecution', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude' })];

    const result = await invokeProbeExecutionServer('claude');

    expect(result).toEqual({ reachable: false, reason: 'claude does not support remote execution' });
  });

  it('reports unreachable with "No server configured" when the capability exists but no server is set', async () => {
    const probeServer = vi.fn();
    mockRegistryAdapters = [
      makeAdapter({
        name: 'opencode',
        remoteExecution: {
          info: { urlPlaceholder: 'http://10.0.0.5:4096', authKind: 'basic', workingDirectoryScope: 'per-invocation' },
          probeServer,
        },
      }),
    ];
    // executionServers has no 'opencode' entry (default from makeContext).

    const result = await invokeProbeExecutionServer('opencode');

    expect(result).toEqual({ reachable: false, reason: 'No server configured' });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it('delegates to adapter.remoteExecution.probeServer with the configured server and returns its result verbatim', async () => {
    const server: AgentExecutionServer = { url: 'http://10.0.0.5:4096', auth: { kind: 'basic', username: 'dev', password: 'secret' } };
    const probeServer = vi.fn(async () => ({ reachable: true, version: '1.14.25' }) as RemoteServerStatus);
    mockRegistryAdapters = [
      makeAdapter({
        name: 'opencode',
        remoteExecution: {
          info: { urlPlaceholder: 'http://10.0.0.5:4096', authKind: 'basic', workingDirectoryScope: 'per-invocation' },
          probeServer,
        },
      }),
    ];
    context.configManager.load.mockReturnValue({
      agent: { cliPaths: {}, cliPath: null, maxConcurrentSessions: 5, idleTimeoutMinutes: 30, permissionMode: 'default', queueOverflow: 'queue', executionServers: { opencode: server } },
      terminal: { shell: null },
      mcpServer: { enabled: false },
    });

    const result = await invokeProbeExecutionServer('opencode');

    expect(probeServer).toHaveBeenCalledWith(server);
    expect(result).toEqual({ reachable: true, version: '1.14.25' });
  });

  it('catches an Error thrown by probeServer and reports it as unreachable', async () => {
    const server: AgentExecutionServer = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' } };
    const probeServer = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    mockRegistryAdapters = [
      makeAdapter({
        name: 'opencode',
        remoteExecution: {
          info: { urlPlaceholder: 'http://10.0.0.5:4096', authKind: 'basic', workingDirectoryScope: 'per-invocation' },
          probeServer,
        },
      }),
    ];
    context.configManager.load.mockReturnValue({
      agent: { cliPaths: {}, cliPath: null, maxConcurrentSessions: 5, idleTimeoutMinutes: 30, permissionMode: 'default', queueOverflow: 'queue', executionServers: { opencode: server } },
      terminal: { shell: null },
      mcpServer: { enabled: false },
    });

    const result = await invokeProbeExecutionServer('opencode');

    expect(result).toEqual({ reachable: false, reason: 'ECONNREFUSED' });
  });

  it('catches a non-Error thrown by probeServer and reports "Unknown error"', async () => {
    const server: AgentExecutionServer = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' } };
    const probeServer = vi.fn(async () => {
      throw 'a raw string rejection';
    });
    mockRegistryAdapters = [
      makeAdapter({
        name: 'opencode',
        remoteExecution: {
          info: { urlPlaceholder: 'http://10.0.0.5:4096', authKind: 'basic', workingDirectoryScope: 'per-invocation' },
          probeServer,
        },
      }),
    ];
    context.configManager.load.mockReturnValue({
      agent: { cliPaths: {}, cliPath: null, maxConcurrentSessions: 5, idleTimeoutMinutes: 30, permissionMode: 'default', queueOverflow: 'queue', executionServers: { opencode: server } },
      terminal: { shell: null },
      mcpServer: { enabled: false },
    });

    const result = await invokeProbeExecutionServer('opencode');

    expect(result).toEqual({ reachable: false, reason: 'Unknown error' });
  });
});
