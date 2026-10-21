/**
 * Unit tests for the AGENT_SUMMARIZE IPC handler in
 * src/main/ipc/handlers/system.ts.
 *
 * The handler:
 *   - rejects empty prompts
 *   - names on the Automation agent (`AppConfig.automation`), its model and
 *     effort, never the project's default agent; with no Automation agent it
 *     refuses, and the refusal spends no rate-limit slot
 *   - applies a sliding-window rate limit (autoNameRateLimitPerHour), shared
 *     with main's Command Terminal namer
 *   - runs `summarize` in the shared answer home with a run directory of its own
 *   - converts thrown errors to { ok: false, reason }
 *
 * Strategy mirrors agent-list-handler.test.ts: capture handlers via mocked
 * ipcMain.handle, configure mockRegistryAdapters and the context per test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentCallUsage, AgentSummarizeResult } from '../../src/shared/types';

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

type SummarizeOptions = {
  model?: string | null;
  effort?: string | null;
  runDirectory?: string;
  onUsage?: (usage: AgentCallUsage) => void;
};

// The ledger write the handler's sink reaches: `backgroundCallSink` checks the
// project exists, then writes through `getProjectRepos(...).backgroundCalls`.
// Mocked at that seam so the real sink (and its project lookup) still runs.
const recordSpy = vi.hoisted(() => vi.fn());
const getProjectReposMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/helpers/project-repos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ipc/helpers/project-repos')>();
  return { ...actual, getProjectRepos: getProjectReposMock };
});

type MockAdapter = {
  name: string;
  displayName: string;
  permissions: { mode: string; label: string }[];
  defaultPermission: string;
  detect: (override?: string | null) => Promise<{ found: boolean; path: string | null; version: string | null }>;
  summarize?: (prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions) => Promise<string>;
  answerFromContext?: () => Promise<string>;
  answerCapabilities?: { streaming: boolean; search: boolean; model: boolean; effort: boolean; defaultEffort?: string };
  discoverCapabilities?: () => Promise<{ effortLevels: string[] }>;
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
import { resetSummarizeRateLimit, tryAcquireSummarizeSlot } from '../../src/main/agent/shared/summarize-rate-limit';
import { resetAutomationAgentCacheForTests } from '../../src/main/automations/automation-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An adapter that can be the Automation agent: it answers, takes a model, and
 *  reports the effort levels its CLI knows. */
function makeAdapter(overrides: Partial<MockAdapter> & { name: string }): MockAdapter {
  return {
    displayName: overrides.name.charAt(0).toUpperCase() + overrides.name.slice(1),
    permissions: [{ mode: 'default', label: 'Default' }],
    defaultPermission: 'default',
    detect: vi.fn(async () => ({ found: true, path: `/usr/bin/${overrides.name}`, version: '1.0.0' })),
    answerFromContext: vi.fn(async () => 'answer'),
    answerCapabilities: { streaming: false, search: false, model: true, effort: true, defaultEffort: 'low' },
    discoverCapabilities: vi.fn(async () => ({ effortLevels: ['low', 'high'] })),
    invalidateDetectionCache: vi.fn(),
    ...overrides,
  };
}

function makeContext(overrides?: {
  rateLimit?: number;
  automation?: { agent?: string | null; model?: string | null; effort?: string | null };
  currentProjectId?: string | null;
  currentProjectPath?: string | null;
  projects?: Array<{ id: string; default_agent: string | null; path: string }>;
}) {
  const rateLimit = overrides?.rateLimit ?? 60;
  const projects = overrides?.projects ?? [];
  const automation = overrides?.automation ?? { agent: 'claude', model: 'claude-haiku-5-5', effort: null };
  return {
    configManager: {
      load: vi.fn(() => ({
        agent: {
          cliPaths: {},
          maxConcurrentSessions: 5,
          idleTimeoutMinutes: 30,
          permissionMode: 'default',
        },
        terminal: { shell: null },
        mcpServer: { enabled: false },
        autoNameRateLimitPerHour: rateLimit,
        automation,
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
    projectRepo: {
      list: vi.fn(() => projects),
      // The background-call sink skips a project this lookup does not find.
      getById: vi.fn((projectId: string) => projects.find((project) => project.id === projectId) ?? null),
    },
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

async function invokeSummarize(input: { prompt: string; projectId?: string | null; taskId?: string | null }): Promise<AgentSummarizeResult> {
  const handler = capturedHandlers.get('agent:summarize');
  if (!handler) throw new Error('agent:summarize handler not registered');
  return handler(undefined, input) as Promise<AgentSummarizeResult>;
}

function register(context: ReturnType<typeof makeContext>): void {
  registerSystemHandlers(context as Parameters<typeof registerSystemHandlers>[0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AGENT_SUMMARIZE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    mockRegistryAdapters = [];
    // The window is shared with main's Command Terminal namer, so it outlives
    // a handler registration; each case starts from an empty one.
    resetSummarizeRateLimit();
    // Detection is cached for minutes, keyed by agent: each case detects afresh.
    resetAutomationAgentCacheForTests();
    recordSpy.mockReset();
    getProjectReposMock.mockReset();
    getProjectReposMock.mockReturnValue({ backgroundCalls: { record: recordSpy } });
  });

  it('rejects empty prompts', async () => {
    register(makeContext());
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'X') })];

    expect(await invokeSummarize({ prompt: '' })).toEqual({ ok: false, reason: 'empty prompt' });
    expect(await invokeSummarize({ prompt: '   ' })).toEqual({ ok: false, reason: 'empty prompt' });
  });

  it('names on the Automation agent, its model and effort, not the project default agent', async () => {
    const claudeSummarize = vi.fn(async () => 'Fix Login Race Condition');
    const kimiSummarize = vi.fn(async () => 'Wrong Agent');
    mockRegistryAdapters = [
      makeAdapter({ name: 'claude', summarize: claudeSummarize }),
      makeAdapter({ name: 'kimi', summarize: kimiSummarize }),
    ];
    register(makeContext({
      currentProjectId: 'proj-1',
      currentProjectPath: '/repo',
      projects: [{ id: 'proj-1', default_agent: 'kimi', path: '/repo' }],
    }));

    const result = await invokeSummarize({ prompt: 'tests are failing', projectId: 'proj-1' });

    expect(result).toEqual({ ok: true, title: 'Fix Login Race Condition' });
    expect(kimiSummarize).not.toHaveBeenCalled();
    expect(claudeSummarize).toHaveBeenCalledTimes(1);
    const [prompt, cliPath, cwd, options] = claudeSummarize.mock.calls[0] as unknown as [string, string, string, SummarizeOptions];
    expect(prompt).toBe('tests are failing');
    expect(cliPath).toBe('/usr/bin/claude');
    // The shared answer home, never the project root: a project root loads the
    // agent's instructions into every call.
    expect(cwd).not.toBe('/repo');
    expect(cwd).toContain('kangentic-ask-home');
    expect(options.model).toBe('claude-haiku-5-5');
    // No effort chosen: the adapter's recommended level, since the CLI lists it.
    expect(options.effort).toBe('low');
    expect(typeof options.runDirectory).toBe('string');
  });

  describe('background-call ledger', () => {
    const reportedUsage: AgentCallUsage = {
      model: 'claude-haiku-5-5',
      inputTokens: 120,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 40,
      outputTokens: 9,
      costUsd: 0.0004,
    };
    const projects = [
      { id: 'proj-A', default_agent: null, path: '/repo-a' },
      { id: 'proj-B', default_agent: null, path: '/repo-b' },
    ];

    it('records one task_title call against the project the request named, not the open one', async () => {
      // The adapter reports its usage through the sink the handler hands it.
      const summarize = vi.fn(async (_prompt: string, _cliPath: string, _cwd: string, options?: SummarizeOptions) => {
        options?.onUsage?.(reportedUsage);
        return 'Fix Login Race Condition';
      });
      mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize })];
      // proj-B is the open project when the request, made for proj-A, runs.
      register(makeContext({ currentProjectId: 'proj-B', currentProjectPath: '/repo-b', projects }));

      const result = await invokeSummarize({ prompt: 'tests are failing', projectId: 'proj-A', taskId: 't1' });

      expect(result).toEqual({ ok: true, title: 'Fix Login Race Condition' });
      // Written to proj-A's ledger. The existence check passes for both
      // projects, so this id is what separates a request-time project from the
      // ambient one.
      expect(getProjectReposMock).toHaveBeenCalledTimes(1);
      expect(getProjectReposMock.mock.calls[0][1]).toBe('proj-A');
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
        job: 'task_title',
        taskId: 't1',
        swimlaneId: null,
        agent: 'claude',
        requestedModel: 'claude-haiku-5-5',
        // No effort chosen: the adapter's recommended level, since the CLI lists it.
        effort: 'low',
        usage: reportedUsage,
        outcome: 'succeeded',
      }));
    });

    it('leaves the usage null when the adapter reports none', async () => {
      const summarize = vi.fn(async () => 'Some Title');
      mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize })];
      register(makeContext({ currentProjectId: 'proj-A', currentProjectPath: '/repo-a', projects }));

      await invokeSummarize({ prompt: 'a description', projectId: 'proj-A' });

      const [, , , options] = summarize.mock.calls[0] as unknown as [string, string, string, SummarizeOptions];
      expect(typeof options.onUsage).toBe('function');
      // An adapter that reports nothing leaves the usage null, never invented.
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy.mock.calls[0][0].usage).toBeNull();
    });

    it('falls back to the open project when the request names none', async () => {
      mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'Some Title') })];
      register(makeContext({ currentProjectId: 'proj-B', currentProjectPath: '/repo-b', projects }));

      await invokeSummarize({ prompt: 'a description' });

      expect(getProjectReposMock).toHaveBeenCalledTimes(1);
      expect(getProjectReposMock.mock.calls[0][1]).toBe('proj-B');
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy.mock.calls[0][0]).toMatchObject({ job: 'task_title', taskId: null });
    });

    it('records a failed call too, with the failure as its detail', async () => {
      mockRegistryAdapters = [makeAdapter({
        name: 'claude',
        summarize: vi.fn(async () => { throw new Error('CLI exited 1: bad config'); }),
      })];
      register(makeContext({ currentProjectId: 'proj-A', currentProjectPath: '/repo-a', projects }));

      const result = await invokeSummarize({ prompt: 'a description', projectId: 'proj-A', taskId: 't1' });

      expect(result).toEqual({ ok: false, reason: 'CLI exited 1: bad config' });
      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy.mock.calls[0][0]).toMatchObject({ job: 'task_title', taskId: 't1', outcome: 'failed', detail: 'CLI exited 1: bad config' });
    });

    it('records nothing for a refusal that never ran a CLI', async () => {
      mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'Should Not Run') })];
      register(makeContext({
        currentProjectId: 'proj-A',
        currentProjectPath: '/repo-a',
        projects,
        automation: { agent: null, model: null, effort: null },
      }));

      await invokeSummarize({ prompt: 'a description', projectId: 'proj-A' });

      expect(recordSpy).not.toHaveBeenCalled();
    });
  });

  it('refuses with no Automation agent, without spending a rate-limit slot', async () => {
    const summarize = vi.fn(async () => 'Should Not Run');
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize })];
    register(makeContext({ rateLimit: 1, automation: { agent: null, model: null, effort: null } }));

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result).toEqual({ ok: false, reason: 'Set up an Automation agent in Settings > Workflows to name tasks.' });
    expect(summarize).not.toHaveBeenCalled();
    // The one slot is still free for a call that can run.
    expect(tryAcquireSummarizeSlot(1)).toBe(true);
  });

  it('refuses when the Automation agent takes a model and none is chosen', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'X') })];
    register(makeContext({ automation: { agent: 'claude', model: null, effort: null } }));

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result).toEqual({ ok: false, reason: 'Choose a model for the Automation agent in Settings > Workflows to name tasks.' });
  });

  it('refuses when the Automation agent cannot summarize', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'aider' /* no summarize */ })];
    register(makeContext({ automation: { agent: 'aider', model: 'gpt-x', effort: null } }));

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('cannot name tasks');
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
    register(makeContext());

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    // The shared agentCliNotFoundMessage, which never appends the word "CLI":
    // the display name supplies it when it applies.
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
    register(makeContext());

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result).toEqual({ ok: false, reason: 'CLI exited 1: bad config' });
  });

  it('returns ok:false on empty title from adapter', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => '') })];
    register(makeContext());

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('empty output');
  });

  it('rate-limits when window is exceeded', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'A Title') })];
    register(makeContext({ rateLimit: 3 }));

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

  // `autoNameRateLimitPerHour` promises ONE combined cap for the task-name
  // suggestion (this handler) and main's Command Terminal namer. The namer
  // acquires through `tryAcquireSummarizeSlot` by default, so a slot taken
  // there must count here, and the other way round. A handler with its own
  // private window would let the two callers spend twice the cap.
  it('refuses when a main-side caller (the namer path) already used the only slot', async () => {
    const summarize = vi.fn(async () => 'Should Not Run');
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize })];
    register(makeContext({ rateLimit: 1 }));

    // What CommandTerminalNamer.nameFromPrompt does with no injected acquirer.
    expect(tryAcquireSummarizeSlot(1)).toBe(true);

    const result = await invokeSummarize({ prompt: 'description' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('rate limit');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('a slot the handler used is refused to a main-side caller (the namer path)', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'A Title') })];
    register(makeContext({ rateLimit: 1 }));

    const result = await invokeSummarize({ prompt: 'description' });
    expect(result.ok).toBe(true);

    expect(tryAcquireSummarizeSlot(1)).toBe(false);
  });

  it('does not rate-limit when limit is 0 (disabled)', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'OK') })];
    register(makeContext({ rateLimit: 0 }));

    // Sequential rather than Promise.all to avoid micro-task starvation in vitest's
    // tiny-pool runner. The point is just to verify the disabled branch doesn't
    // accumulate timestamps in the limit window.
    const results: AgentSummarizeResult[] = [];
    for (let index = 0; index < 5; index++) {
      results.push(await invokeSummarize({ prompt: `description ${index}` }));
    }

    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('evicts timestamps older than 1 hour from the rate-limit window before the cap check', async () => {
    mockRegistryAdapters = [makeAdapter({ name: 'claude', summarize: vi.fn(async () => 'Eviction Title') })];
    register(makeContext({ rateLimit: 2 }));

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const r1 = await invokeSummarize({ prompt: 'first' });
      const r2 = await invokeSummarize({ prompt: 'second' });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      const rBlocked = await invokeSummarize({ prompt: 'blocked' });
      expect(rBlocked.ok).toBe(false);
      if (!rBlocked.ok) expect(rBlocked.reason).toContain('rate limit');

      // 61 minutes on: the first two age out of the 1-hour window. The
      // detection cache expires too, and the next call simply detects again.
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);

      const rAfterEviction1 = await invokeSummarize({ prompt: 'after eviction 1' });
      const rAfterEviction2 = await invokeSummarize({ prompt: 'after eviction 2' });
      expect(rAfterEviction1.ok).toBe(true);
      expect(rAfterEviction2.ok).toBe(true);

      const rBlockedAgain = await invokeSummarize({ prompt: 'blocked again' });
      expect(rBlockedAgain.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
