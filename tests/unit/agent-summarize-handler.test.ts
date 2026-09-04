/**
 * Unit tests for the AGENT_SUMMARIZE IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * The handler:
 *   - rejects empty prompts
 *   - applies a sliding-window rate limit (autoNameRateLimitPerHour)
 *   - resolves which adapter to call: explicit input.agentName, then the
 *     active project's default_agent, then the registry's first entry
 *   - returns { ok: false, reason } for unknown agents, missing summarize
 *     capability, or undetected CLI
 *   - calls adapter.summarize() with the detected CLI path + project cwd
 *   - converts thrown errors to { ok: false, reason }
 *
 * Strategy mirrors agent-list-handler.test.ts: capture handlers via mocked
 * ipcMain.handle, configure mockRegistryAdapters and the context per test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentSummarizeResult } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

type MockAdapter = {
  name: string;
  displayName: string;
  permissions: { mode: string; label: string }[];
  defaultPermission: string;
  detect: (override?: string | null) => Promise<{ found: boolean; path: string | null; version: string | null }>;
  summarize?: (prompt: string, cliPath: string, cwd: string) => Promise<string>;
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

vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => false) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({ syncProjectMcpConfig: vi.fn() }));
vi.mock('../../src/shared/object-utils', () => ({
  deepMergeConfig: vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })),
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<MockAdapter> & { name: string }): MockAdapter {
  return {
    displayName: overrides.name.charAt(0).toUpperCase() + overrides.name.slice(1),
    permissions: [{ mode: 'default', label: 'Default' }],
    defaultPermission: 'default',
    detect: vi.fn(async () => ({ found: true, path: `/usr/bin/${overrides.name}`, version: '1.0.0' })),
    invalidateDetectionCache: vi.fn(),
    ...overrides,
  };
}

function makeContext(overrides?: {
  rateLimit?: number;
  currentProjectId?: string | null;
  currentProjectPath?: string | null;
  projects?: Array<{ id: string; default_agent: string | null; path: string }>;
}) {
  const rateLimit = overrides?.rateLimit ?? 60;
  const projects = overrides?.projects ?? [];
  return {
    configManager: {
      load: vi.fn(() => ({
        agent: {
          cliPaths: {},
          maxConcurrentSessions: 5,
          idleTimeoutMinutes: 30,
          permissionMode: 'default',
          queueOverflow: 'queue',
        },
        terminal: { shell: null },
        mcpServer: { enabled: false },
        autoNameRateLimitPerHour: rateLimit,
      })),
      getEffectiveConfig: vi.fn(() => ({
        agent: { cliPaths: {}, maxConcurrentSessions: 5, idleTimeoutMinutes: 30 },
        terminal: { shell: null },
      })),
      save: vi.fn(),
      saveProjectOverrides: vi.fn(),
      loadProjectOverrides: vi.fn(() => null),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    sessionManager: { setMaxConcurrent: vi.fn(), setShell: vi.fn(), setIdleTimeout: vi.fn() },
    projectRepo: { list: vi.fn(() => projects) },
    shellResolver: { getAvailableShells: vi.fn(() => []), getDefaultShell: vi.fn(() => 'bash') },
    gitDetector: { detect: vi.fn(() => ({ found: false })) },
    mainWindow: {
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false), close: vi.fn(), isFocused: vi.fn(() => true),
      flashFrame: vi.fn(), isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(),
      focus: vi.fn(), once: vi.fn(), webContents: { send: vi.fn() },
    },
    currentProjectPath: overrides?.currentProjectPath ?? null,
    currentProjectId: overrides?.currentProjectId ?? null,
  };
}

async function invokeSummarize(input: { prompt: string; agentName?: string }): Promise<AgentSummarizeResult> {
  const handler = capturedHandlers.get('agent:summarize');
  if (!handler) throw new Error('agent:summarize handler not registered');
  return handler(undefined, input) as Promise<AgentSummarizeResult>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AGENT_SUMMARIZE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockRegistryAdapters = [];
  });

  it('rejects empty prompts', async () => {
    const context = makeContext();
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'X') })];

    const empty = await invokeSummarize({ prompt: '' });
    const blank = await invokeSummarize({ prompt: '   ' });

    expect(empty).toEqual({ ok: false, reason: 'empty prompt' });
    expect(blank).toEqual({ ok: false, reason: 'empty prompt' });
  });

  it('returns ok:true with the title from the active project default agent', async () => {
    const summarize = vi.fn(async () => 'Fix Login Race Condition');
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize }),
      makeAdapter({ name: 'kimi', summarize: vi.fn(async () => 'Wrong Adapter') }),
    ];
    const context = makeContext({
      currentProjectId: 'proj-1',
      currentProjectPath: '/repo',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'tests are failing' });

    expect(result).toEqual({ ok: true, title: 'Fix Login Race Condition' });
    expect(summarize).toHaveBeenCalledWith('tests are failing', '/usr/bin/claude', '/repo');
  });

  it('honors explicit input.agentName, overriding project default', async () => {
    const claudeSummarize = vi.fn(async () => 'Claude Title');
    const kimiSummarize = vi.fn(async () => 'Kimi Title');
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize: claudeSummarize }),
      makeAdapter({ name: 'kimi', summarize: kimiSummarize }),
    ];
    const context = makeContext({
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description', agentName: 'kimi' });

    expect(result).toEqual({ ok: true, title: 'Kimi Title' });
    expect(claudeSummarize).not.toHaveBeenCalled();
    expect(kimiSummarize).toHaveBeenCalledTimes(1);
  });

  it('falls back to the registry first entry when no project is open', async () => {
    const summarize = vi.fn(async () => 'Fallback Title');
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize })];
    const context = makeContext({ currentProjectId: null });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result).toEqual({ ok: true, title: 'Fallback Title' });
  });

  it('returns ok:false when the resolved agent is unknown to the registry', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude' })];
    const context = makeContext();
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description', agentName: 'nonexistent' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unknown agent');
  });

  it('returns ok:false when the resolved adapter lacks summarize', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'aider' /* no summarize */ })];
    const context = makeContext({
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'aider', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('does not support summarize');
  });

  it('returns ok:false when the CLI is not detected on disk', async () => {
    const summarize = vi.fn(async () => 'Should Not Be Called');
    mockRegistryAdapters = [
      makeAdapter({
        name: 'claude',
        summarize,
        detect: vi.fn(async () => ({ found: false, path: null, version: null })),
      }),
    ];
    const context = makeContext({
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    // The reason now comes from the shared agentCliNotFoundMessage, which never
    // appends the word "CLI" - the display name supplies it when it applies.
    // This adapter's displayName is "Claude", so asserting on "CLI not found"
    // here would be asserting the old doubled-"CLI" wording.
    if (!result.ok) {
      expect(result.reason).toContain('not found on PATH');
      expect(result.reason).not.toMatch(/CLI CLI/i);
    }
    expect(summarize).not.toHaveBeenCalled();
  });

  it('converts a thrown summarize() error to ok:false with the message', async () => {
    mockRegistryAdapters = [
      makeAdapter({
        name: 'claude',
        summarize: vi.fn(async () => { throw new Error('CLI exited 1: bad config'); }),
      }),
    ];
    const context = makeContext({
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CLI exited 1: bad config');
  });

  it('returns ok:false on empty title from adapter', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize: vi.fn(async () => '') }),
    ];
    const context = makeContext({
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('empty output');
  });

  it('rate-limits when window is exceeded', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'A Title') }),
    ];
    const context = makeContext({
      rateLimit: 3,
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const r1 = await invokeSummarize({ prompt: 'a' });
    const r2 = await invokeSummarize({ prompt: 'b' });
    const r3 = await invokeSummarize({ prompt: 'c' });
    const r4 = await invokeSummarize({ prompt: 'd' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.reason).toContain('rate limit');
  });

  it('does not rate-limit when limit is 0 (disabled)', async () => {
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'OK') }),
    ];
    const context = makeContext({
      rateLimit: 0,
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    // Sequential rather than Promise.all to avoid micro-task starvation in vitest's
    // tiny-pool runner. The point is just to verify the disabled branch doesn't
    // accumulate timestamps in the limit window.
    const results: AgentSummarizeResult[] = [];
    for (let index = 0; index < 5; index++) {
      results.push(await invokeSummarize({ prompt: `description ${index}` }));
    }

    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('uses currentProjectPath as cwd when provided, falling back to process.cwd()', async () => {
    const summarize = vi.fn(async () => 'Title');
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize })];
    const context = makeContext({
      currentProjectId: 'proj-1',
      currentProjectPath: '/repo/main',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo/main' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    await invokeSummarize({ prompt: 'description' });

    expect(summarize).toHaveBeenCalledWith('description', '/usr/bin/claude', '/repo/main');
  });

  // ---------------------------------------------------------------------------
  // #8: Sliding-window rate-limit eviction via fake timers
  // ---------------------------------------------------------------------------

  it('evicts timestamps older than 1 hour from the rate-limit window before the cap check', async () => {
    // This test must NOT re-use the capturedHandlers from a previous test because
    // the rate-limit window array is closure-scoped inside registerSystemHandlers.
    // We call capturedHandlers.clear() and re-register to get a fresh window.
    capturedHandlers.clear();
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'Eviction Title') }),
    ];
    const context = makeContext({
      rateLimit: 2,
      currentProjectId: 'proj-1',
      projects: [{ id: 'proj-1', default_agent: 'claude', path: '/repo' }],
    });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    vi.useFakeTimers();
    try {
      // Fill the 2-call window
      const r1 = await invokeSummarize({ prompt: 'first' });
      const r2 = await invokeSummarize({ prompt: 'second' });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      // Third call should be rate-limited (window is full)
      const rBlocked = await invokeSummarize({ prompt: 'blocked' });
      expect(rBlocked.ok).toBe(false);
      if (!rBlocked.ok) expect(rBlocked.reason).toContain('rate limit');

      // Advance time by 61 minutes so the first two entries age out of the 1-hour window
      vi.advanceTimersByTime(61 * 60 * 1000);

      // Now calls should succeed again - the old entries were evicted
      const rAfterEviction1 = await invokeSummarize({ prompt: 'after eviction 1' });
      const rAfterEviction2 = await invokeSummarize({ prompt: 'after eviction 2' });
      expect(rAfterEviction1.ok).toBe(true);
      expect(rAfterEviction2.ok).toBe(true);

      // Third call after eviction should be blocked again (window refilled)
      const rBlockedAgain = await invokeSummarize({ prompt: 'blocked again' });
      expect(rBlockedAgain.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------------
  // #9: Empty registry path
  // ---------------------------------------------------------------------------

  it('returns ok:false with "no agents registered" when agentRegistry.list() is empty and no agentName provided', async () => {
    capturedHandlers.clear();
    // Empty registry
    mockRegistryAdapters = [];
    const context = makeContext({ currentProjectId: null });
    registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);

    const result = await invokeSummarize({ prompt: 'any description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no agents registered');
  });
});
