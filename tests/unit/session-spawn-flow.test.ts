/**
 * Tests for the caller-owned session ID branch in performSpawn.
 *
 * Scope: lines 207-247 of session-spawn-flow.ts — the new
 * `hasKnownAgentSessionId` flag wired into sessionIdManager.init(), and
 * the sessionHistoryReader.attach() short-circuit for adapters that
 * declare both supportsCallerSessionId and runtime.sessionHistory.
 *
 * Strategy: mock node-pty so no real process is spawned, mock all
 * collaborator modules so the test drives only the unit under test, and
 * stub every SpawnFlowContext field with vi.fn() so call signatures can
 * be asserted precisely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpawnFlowContext } from '../../src/main/pty/lifecycle/session-spawn-flow';
import type { SpawnSessionInput } from '../../src/shared/types';
import type { AgentParser } from '../../src/shared/types';

// ---- Module-level mocks (hoisted before the import under test) ----

// Prevent real PTY process from spawning.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    pid: 999,
  })),
}));

// Stub uuid so the generated session ID is predictable.
vi.mock('uuid', () => ({
  v4: () => 'test-session-uuid-0000-000000000000',
}));

// Stub shutdown guard to always allow spawning.
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => false,
}));

// Stub spawn env/cwd helpers — return safe defaults, no real fs access.
vi.mock('../../src/main/pty/spawn/pty-spawn', () => ({
  resolveShellArgs: (shell: string) => ({ exe: shell, args: [] }),
  buildSpawnEnv: (env: Record<string, string> | undefined) => ({ ...env }),
  resolveSpawnCwd: ({ requestedCwd }: { requestedCwd: string }) => ({
    effectiveCwd: requestedCwd,
    uncPushdPrefix: null,
  }),
}));

// Stub spawn-failure-handler — never used in happy-path tests.
vi.mock('../../src/main/pty/spawn/spawn-failure-handler', () => ({
  handleSpawnFailure: vi.fn(),
}));

// Stub adapter lifecycle hooks — no-ops for these tests.
vi.mock('../../src/main/pty/lifecycle/adapter-lifecycle', () => ({
  attachAdapter: vi.fn(),
  disposeAdapterAttachment: vi.fn(),
  removeAdapterHooks: vi.fn(),
}));

// Stub PTY kill helper.
vi.mock('../../src/main/pty/lifecycle/pty-kill', () => ({
  safeKillPty: vi.fn(),
}));

// Stub PR detection.
vi.mock('../../src/main/pty/pr/pr-connectors', () => ({
  detectPR: vi.fn(() => null),
}));

// Stub shell path adaptation.
vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
}));

// ---- Import under test (after all vi.mock hoisting) ----
import { performSpawn } from '../../src/main/pty/lifecycle/session-spawn-flow';
import { SessionRegistry } from '../../src/main/pty/session-registry';

// ---- Helpers ----

/**
 * Build a minimal AgentParser that declares a sessionId strategy plus an
 * optional sessionHistory hook. Mirrors the `makeAdapter` pattern from
 * session-id-manager.test.ts but exposes the sessionHistory field.
 */
function makeAdapter(options: {
  withSessionHistory?: boolean;
}): AgentParser {
  const sessionHistoryHook = options.withSessionHistory
    ? {
        locate: vi.fn().mockResolvedValue('/some/history/file.jsonl'),
        parse: vi.fn().mockReturnValue({ usage: null, events: [] }),
        isFullRewrite: false,
      }
    : undefined;

  return {
    detectFirstOutput: (_data: string) => false,
    removeHooks: vi.fn(),
    runtime: {
      activity: { kind: 'pty' as const, detectIdle: vi.fn(() => false) },
      sessionId: {
        fromOutput: (_data: string) => null,
      },
      sessionHistory: sessionHistoryHook,
    },
  } as unknown as AgentParser;
}

/**
 * Build a SpawnFlowContext with vi.fn() stubs for every collaborator.
 * The `sessionHistoryReader.attach` stub resolves by default (overridden
 * in individual tests where rejection behaviour is needed).
 */
function makeContext(): SpawnFlowContext {
  const registry = new SessionRegistry();
  return {
    registry,
    bufferManager: {
      getRawScrollback: vi.fn(() => ''),
      removeSession: vi.fn(),
      initSession: vi.fn(),
      onData: vi.fn(),
    },
    usageTracker: {
      removeSession: vi.fn(),
      initSession: vi.fn(),
      setSessionUsage: vi.fn(),
      notifyPtyIdle: vi.fn(),
      notifyPtyData: vi.fn(),
      ingestEvents: vi.fn(),
      emitSessionEnd: vi.fn(),
      hasPendingPRCommand: vi.fn(() => false),
      clearPendingPRCommand: vi.fn(),
      getSessionActivity: vi.fn(() => null),
    },
    sessionIdManager: {
      init: vi.fn(),
      onData: vi.fn(),
      clearDiagnostic: vi.fn(),
      removeSession: vi.fn(),
      scanScrollback: vi.fn(),
    },
    sessionFiles: {
      register: vi.fn(),
      detachPreservingFiles: vi.fn(),
      removeSession: vi.fn(),
      detachOnPtyExit: vi.fn(),
    },
    resizeManager: {
      shouldNotifyOnData: vi.fn(() => false),
    },
    statusFileReader: {
      attach: vi.fn(),
      flushPendingEvents: vi.fn(),
    },
    sessionHistoryReader: {
      attach: vi.fn().mockResolvedValue(undefined),
    },
    sessionQueue: {
      notifySlotFreed: vi.fn(),
    },
    getTranscriptWriter: vi.fn(() => null),
    getShell: vi.fn().mockResolvedValue('/bin/bash'),
    emit: vi.fn(),
  } as unknown as SpawnFlowContext;
}

/**
 * Build the minimum SpawnSessionInput needed for a normal spawn. The
 * `cwd` uses a safe generic path rather than any real user directory.
 */
function makeInput(overrides: Partial<SpawnSessionInput> = {}): SpawnSessionInput {
  return {
    id: 'input-session-id-0000-000000000000',
    taskId: 'task-001',
    projectId: 'project-001',
    command: 'echo hello',
    cwd: '/home/dev/project',
    ...overrides,
  };
}

// ---- Tests ----

describe('performSpawn - caller-owned session ID wiring', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('case 1: agentSessionId set + adapter has sessionHistory -> attach called with correct args', async () => {
    const context = makeContext();
    const adapter = makeAdapter({ withSessionHistory: true });
    const input = makeInput({
      agentSessionId: 'qwen-owned-session-uuid-1234567890ab',
      agentParser: adapter,
      agentName: 'qwen',
    });

    await performSpawn(input, context);

    // sessionIdManager.init must receive hasKnownAgentSessionId=true
    expect(context.sessionIdManager.init).toHaveBeenCalledOnce();
    const initArgs = (context.sessionIdManager.init as ReturnType<typeof vi.fn>).mock.calls[0];
    // init(sessionId, agentParser, effectiveCwd, agentName, hasKnownAgentSessionId)
    expect(initArgs[4]).toBe(true);

    // sessionHistoryReader.attach must be called exactly once with the
    // correct shape derived from the input and the resolved cwd.
    expect(context.sessionHistoryReader.attach).toHaveBeenCalledOnce();
    const attachArgs = (context.sessionHistoryReader.attach as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(attachArgs.sessionId).toBe(input.id);
    expect(attachArgs.agentSessionId).toBe('qwen-owned-session-uuid-1234567890ab');
    expect(attachArgs.cwd).toBe('/home/dev/project');
    expect(attachArgs.hook).toBe(adapter.runtime!.sessionHistory);
    expect(attachArgs.agentName).toBe('qwen');
  });

  it('case 2: agentSessionId is null -> sessionHistoryReader.attach NOT called', async () => {
    const context = makeContext();
    const adapter = makeAdapter({ withSessionHistory: true });
    const input = makeInput({
      agentSessionId: null,
      agentParser: adapter,
      agentName: 'gemini',
    });

    await performSpawn(input, context);

    // The attach short-circuit requires agentSessionId to be truthy.
    expect(context.sessionHistoryReader.attach).not.toHaveBeenCalled();

    // sessionIdManager.init must receive hasKnownAgentSessionId=false (!!null = false).
    const initArgs = (context.sessionIdManager.init as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(initArgs[4]).toBe(false);
  });

  it('case 3: agentSessionId set but adapter has no sessionHistory -> attach NOT called', async () => {
    const context = makeContext();
    // Adapter declares sessionId capture but omits sessionHistory.
    const adapter = makeAdapter({ withSessionHistory: false });
    const input = makeInput({
      agentSessionId: 'caller-uuid-but-no-history-hook',
      agentParser: adapter,
      agentName: 'codex',
    });

    await performSpawn(input, context);

    // callerOwnedSessionHistory is undefined, so the if-guard short-circuits.
    expect(context.sessionHistoryReader.attach).not.toHaveBeenCalled();

    // hasKnownAgentSessionId is still true because agentSessionId is truthy.
    const initArgs = (context.sessionIdManager.init as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(initArgs[4]).toBe(true);
  });

  it('case 4: attach rejects -> spawn still resolves, console.warn is called', async () => {
    const context = makeContext();
    const attachError = new Error('history file not found');
    (context.sessionHistoryReader.attach as ReturnType<typeof vi.fn>).mockRejectedValue(attachError);

    const adapter = makeAdapter({ withSessionHistory: true });
    const input = makeInput({
      agentSessionId: 'kimi-owned-session-uuid-deadbeef0000',
      agentParser: adapter,
      agentName: 'kimi',
    });

    // performSpawn must resolve normally even though attach() rejected.
    // The rejection is caught by .catch() inside performSpawn and emitted
    // as a console.warn (fire-and-forget).
    const result = await performSpawn(input, context);
    expect(result).toBeDefined();
    expect(result.id).toBe(input.id);

    // attach() was called (the rejection fires after spawn returns).
    expect(context.sessionHistoryReader.attach).toHaveBeenCalledOnce();

    // Flush the microtask queue so the .catch() handler runs before we
    // assert the warning. A single `await Promise.resolve()` is enough
    // because the rejection chain is one microtask deep.
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain('[session-history] attach failed');
    // The session ID in the warning is the first 8 chars of input.id.
    expect(warnMessage).toContain(input.id!.slice(0, 8));
  });
});
