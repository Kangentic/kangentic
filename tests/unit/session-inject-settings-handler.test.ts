/**
 * Unit tests for the SESSION_INJECT_SETTINGS IPC handler.
 *
 * The handler lives inside registerTransientSessionHandlers (transient-sessions.ts)
 * and serves command-terminal (transient) sessions that have no task row and
 * therefore cannot use the task-keyed TASK_SET_RUNTIME_OVERRIDE handler.
 *
 * Pattern mirrors task-runtime-override-handler.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly with a mocked IpcContext.
 *
 * Covers:
 *   - unknown-agent branch (a): getSessionAgentName returns a name, but
 *     agentRegistry has no adapter for it
 *   - unknown-agent branch (b): getSessionAgentName returns undefined, falls
 *     back to input.agent which is also unknown
 *   - session-not-found: session manager returns undefined for the sessionId
 *   - no-op delta: input.model equals currentModel -> spec has no changes ->
 *     empty sequence -> ok:true, injected:false without calling scheduleKeystrokes
 *   - empty sequence: adapter.getInjectionSequence returns [] ->
 *     ok:true, injected:false, scheduleKeystrokes NOT called
 *   - happy path: adapter returns ['/model sonnet'] -> scheduleKeystrokes
 *     called with (sessionId, sessionId, sequence, {}), ok:true, injected:true
 *   - happy path with effort only changed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

// transient-sessions.ts imports these at module level; mock them to prevent
// side effects from non-IPC code paths (spawn/kill handlers) loading real
// node modules.
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: vi.fn(async () => 'origin/main'),
}));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));
vi.mock('../../src/main/git/git-utils', () => ({
  resolveProjectRoot: vi.fn((p: string) => p),
}));
vi.mock('../../src/shared/git-utils', () => ({
  resolveProjectRoot: vi.fn((p: string) => p),
}));

const mockAgentRegistryGet = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => mockAgentRegistryGet(name),
    getOrThrow: vi.fn(() => { throw new Error('should not be called in these tests'); }),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';
import type { SessionInjectSettingsInput, SessionInjectSettingsResult } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockSession {
  taskId: string;
  cwd: string;
  transient: boolean;
}

interface MockContext {
  currentProjectId: string | null;
  currentProjectPath: string | null;
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  mcpServerHandle: null;
  sessionManager: {
    spawn: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getSessionAgentName: ReturnType<typeof vi.fn>;
  };
  terminalSubmitScheduler: { scheduleKeystrokes: ReturnType<typeof vi.fn> };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    projectRepo: {
      getById: vi.fn(() => ({
        id: 'proj-1',
        path: '/mock/project',
        default_agent: 'claude',
      })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { cliPaths: {}, permissionMode: 'default' },
        git: { worktreesEnabled: false, defaultBaseBranch: 'main' },
        mcpServer: { enabled: false },
      })),
    },
    mcpServerHandle: null,
    sessionManager: {
      spawn: vi.fn(async () => ({ id: 'session-1' })),
      remove: vi.fn(),
      getSession: vi.fn(() => undefined as MockSession | undefined),
      getSessionAgentName: vi.fn(() => undefined as string | undefined),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    ...overrides,
  };
}

async function callHandler(
  context: MockContext,
  input: SessionInjectSettingsInput,
): Promise<SessionInjectSettingsResult> {
  const handler = capturedHandlers.get(IPC.SESSION_INJECT_SETTINGS);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_INJECT_SETTINGS} was not registered`);
  return handler(null, input) as Promise<SessionInjectSettingsResult>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_INJECT_SETTINGS handler', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  // =========================================================================
  // Unknown-agent branch
  // =========================================================================

  it('returns ok:false when getSessionAgentName returns a name but the registry has no adapter (sub-case a)', async () => {
    // Sub-case (a): live session tracked as 'mystery-agent', but not in registry.
    context.sessionManager.getSessionAgentName.mockReturnValue('mystery-agent');
    mockAgentRegistryGet.mockReturnValue(undefined);

    const result = await callHandler(context, {
      sessionId: 'session-1',
      agent: 'claude',
      model: 'sonnet',
    });

    expect(result).toEqual({ ok: false, reason: 'unknown agent "mystery-agent"' });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    // Confirm the registry was queried with the resolved (live) agent name, not input.agent.
    expect(mockAgentRegistryGet).toHaveBeenCalledWith('mystery-agent');
  });

  it('returns ok:false when getSessionAgentName returns undefined and input.agent is also unknown (sub-case b)', async () => {
    // Sub-case (b): no tracked agent for this session AND input.agent is unknown.
    context.sessionManager.getSessionAgentName.mockReturnValue(undefined);
    mockAgentRegistryGet.mockReturnValue(undefined);

    const result = await callHandler(context, {
      sessionId: 'session-1',
      agent: 'no-such-agent',
      model: 'sonnet',
    });

    expect(result).toEqual({ ok: false, reason: 'unknown agent "no-such-agent"' });
    // The fallback is input.agent when getSessionAgentName returns undefined.
    expect(mockAgentRegistryGet).toHaveBeenCalledWith('no-such-agent');
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Session-not-found branch
  // =========================================================================

  it('returns ok:false with "session not found" when the session manager has no session for that id', async () => {
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence: vi.fn(() => ['/model sonnet']) });
    context.sessionManager.getSession.mockReturnValue(undefined);

    const result = await callHandler(context, {
      sessionId: 'gone-session',
      agent: 'claude',
      model: 'sonnet',
    });

    expect(result).toEqual({ ok: false, reason: 'session not found' });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // No-op delta
  // =========================================================================

  it('returns ok:true, injected:false and skips scheduleKeystrokes when model equals currentModel (no-op delta)', async () => {
    // modelChanged = (input.model !== undefined && input.model !== currentModel)
    // Here input.model === currentModel, so modelChanged = false.
    // effortChanged = false (input.effort is undefined).
    // Spec has no changes -> sequence will be empty -> early return injected:false.
    const getInjectionSequence = vi.fn(() => []);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getSession.mockReturnValue({ taskId: 'transient-1', cwd: '/proj', transient: true });

    const result = await callHandler(context, {
      sessionId: 'session-1',
      agent: 'claude',
      model: 'claude-sonnet-4-5',
      currentModel: 'claude-sonnet-4-5',
    });

    expect(result).toEqual({ ok: true, injected: false });
    // The adapter was invoked but produced an empty sequence; verify the spec values.
    expect(getInjectionSequence).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-5',
      modelChanged: false,
      effort: null,
      effortChanged: false,
    });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Empty sequence from adapter
  // =========================================================================

  it('returns ok:true, injected:false and skips scheduleKeystrokes when adapter returns empty sequence', async () => {
    // The model DID change, but the adapter (e.g. a Codex-like one) produces
    // no live slash command for this spec.
    const getInjectionSequence = vi.fn(() => []);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getSession.mockReturnValue({ taskId: 'transient-1', cwd: '/proj', transient: true });

    const result = await callHandler(context, {
      sessionId: 'session-1',
      agent: 'claude',
      model: 'opus',
      currentModel: 'sonnet',
    });

    expect(result).toEqual({ ok: true, injected: false });
    expect(getInjectionSequence).toHaveBeenCalledWith({
      model: 'opus',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Happy paths
  // =========================================================================

  it('calls scheduleKeystrokes with (sessionId, sessionId, sequence, {}) and returns ok:true, injected:true', async () => {
    // Key distinction from the task handler: BOTH first arguments are the
    // sessionId (not taskId + sessionId), because transient sessions have no task row.
    const getInjectionSequence = vi.fn(() => ['/model sonnet']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getSession.mockReturnValue({ taskId: 'transient-1', cwd: '/proj', transient: true });

    const result = await callHandler(context, {
      sessionId: 'my-session-id',
      agent: 'claude',
      model: 'sonnet',
      currentModel: 'haiku',
    });

    expect(result).toEqual({ ok: true, injected: true });
    expect(getInjectionSequence).toHaveBeenCalledWith({
      model: 'sonnet',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'my-session-id',
      'my-session-id',
      [{ text: '/model sonnet', verify: 'none' }],
      {},
    );
  });

  it('injects effort-only change when only effort is specified and changed', async () => {
    const getInjectionSequence = vi.fn(() => ['/effort high']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });
    context.sessionManager.getSessionAgentName.mockReturnValue('claude');
    context.sessionManager.getSession.mockReturnValue({ taskId: 'transient-1', cwd: '/proj', transient: true });

    const result = await callHandler(context, {
      sessionId: 'my-session-id',
      agent: 'claude',
      effort: 'high',
      currentEffort: 'low',
    });

    expect(result).toEqual({ ok: true, injected: true });
    expect(getInjectionSequence).toHaveBeenCalledWith({
      model: null,
      modelChanged: false,
      effort: 'high',
      effortChanged: true,
    });
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'my-session-id',
      'my-session-id',
      [{ text: '/effort high', verify: 'none' }],
      {},
    );
  });

  it('prefers the live session agent name over input.agent when looking up the adapter', async () => {
    // getSessionAgentName returns 'gemini'; input.agent is 'claude'.
    // The registry lookup should use 'gemini'.
    const getInjectionSequence = vi.fn(() => ['/model flash']);
    mockAgentRegistryGet.mockReturnValue({ getInjectionSequence });
    context.sessionManager.getSessionAgentName.mockReturnValue('gemini');
    context.sessionManager.getSession.mockReturnValue({ taskId: 'transient-1', cwd: '/proj', transient: true });

    await callHandler(context, {
      sessionId: 'session-x',
      agent: 'claude',
      model: 'flash',
      currentModel: 'pro',
    });

    expect(mockAgentRegistryGet).toHaveBeenCalledWith('gemini');
    expect(mockAgentRegistryGet).not.toHaveBeenCalledWith('claude');
  });
});
