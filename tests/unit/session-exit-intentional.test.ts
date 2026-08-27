/**
 * Tests the `intentional` flag carried on the PTY 'exit' event
 * (session-spawn-flow.ts onExit handler).
 *
 * Bug: moving a task to Done suspends the session. suspend() sets
 * `session.status = 'suspended'` and then force-kills the PTY, which exits
 * non-zero. The renderer's SESSION_EXIT handler can run before the suspended
 * SESSION_STATUS reaches the store, so a store-status check alone races and
 * a false "Session crashed" notification fires. The fix tags the exit event
 * itself: onExit emits `intentional = (session.status === 'suspended')` so the
 * renderer can suppress the false crash regardless of cross-channel ordering.
 *
 * This test drives the real onExit handler through performSpawn with a fake
 * PTY whose onExit callback is captured, then asserts the emitted 'exit' event
 * carries the correct flag for both the suspended (intentional) and the
 * unexpected (crash) case.
 *
 * Tier: Unit (no real PTY, no OS, no IPC - pure mock collaborators).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnFlowContext } from '../../src/main/pty/lifecycle/session-spawn-flow';
import type { SpawnSessionInput } from '../../src/shared/types';

// ---- Hoisted holder so the node-pty mock can hand the captured onExit
// callback back to the test body. ----
const ptyHarness = vi.hoisted(() => ({
  onExitCallback: null as ((event: { exitCode: number }) => void) | null,
}));

// ---- Module-level mocks (hoisted before the import under test) ----

// Fake PTY: capture the onExit callback so the test can fire it deliberately.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      ptyHarness.onExitCallback = callback;
    }),
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    pid: 999,
  })),
}));

vi.mock('uuid', () => ({
  v4: () => 'test-session-uuid-0000-000000000000',
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => false,
}));

vi.mock('../../src/main/pty/spawn/pty-spawn', () => ({
  resolveShellArgs: (shell: string) => ({ exe: shell, args: [] }),
  buildSpawnEnv: (env: Record<string, string> | undefined) => ({ ...env }),
  resolveSpawnCwd: ({ requestedCwd }: { requestedCwd: string }) => ({
    effectiveCwd: requestedCwd,
    cwdFixupCommand: null,
  }),
}));

vi.mock('../../src/main/pty/spawn/spawn-failure-handler', () => ({
  handleSpawnFailure: vi.fn(),
}));

vi.mock('../../src/main/pty/lifecycle/adapter-lifecycle', () => ({
  attachAdapter: vi.fn(),
  disposeAdapterAttachment: vi.fn(),
  removeAdapterHooks: vi.fn(),
}));

vi.mock('../../src/main/pty/lifecycle/pty-kill', () => ({
  safeKillPty: vi.fn(),
}));

vi.mock('../../src/main/pr/pr-registry', () => ({
  detectPR: vi.fn(() => null),
}));

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
  // performSpawn's deferred command write calls this ~100ms after every
  // spawn under this file's REAL timers; a factory without it throws
  // "buildSpawnClearPrelude is not a function" as an unhandled error after
  // the test body has already returned.
  buildSpawnClearPrelude: () => '',
}));

// trace-recorder is the only module the onExit body touches that the
// session-spawn-flow harness does not otherwise stub. Mock it so firing
// onExit stays a pure in-memory operation.
vi.mock('../../src/main/activity-engine/trace-recorder', () => ({
  setSessionDir: vi.fn(),
  recordPtyChunk: vi.fn(),
  clearSessionDir: vi.fn(),
}));

// ---- Import under test (after all vi.mock hoisting) ----
import { performSpawn } from '../../src/main/pty/lifecycle/session-spawn-flow';
import { SessionRegistry } from '../../src/main/pty/session-registry';

// ---- Helpers ----

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
    telemetry: {
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
    takePendingResize: vi.fn(() => undefined),
    emit: vi.fn(),
  } as unknown as SpawnFlowContext;
}

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

function findExitEmit(context: SpawnFlowContext): unknown[] | undefined {
  const emitMock = context.emit as unknown as ReturnType<typeof vi.fn>;
  return emitMock.mock.calls.find((call: unknown[]) => call[0] === 'exit');
}

// ---- Tests ----

describe('session-spawn-flow onExit - intentional-suspend flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptyHarness.onExitCallback = null;
  });

  it('tags the exit event intentional=true when the session was suspended first', async () => {
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    // Simulate suspend(): status is set to 'suspended' before the force-kill.
    const session = context.registry.get(input.id!);
    expect(session).toBeDefined();
    session!.status = 'suspended';

    // Fire the PTY exit with a non-zero Windows ConPTY force-kill code.
    expect(ptyHarness.onExitCallback).toBeTypeOf('function');
    ptyHarness.onExitCallback!({ exitCode: 1073807364 });

    expect(findExitEmit(context)).toEqual(['exit', input.id, 1073807364, true]);
    // A deliberate suspend must NOT be reclassified as 'exited'.
    expect(context.registry.get(input.id!)!.status).toBe('suspended');
  });

  it('tags the exit event intentional=true when kill() marked a deliberate hard reset', async () => {
    // To-Do reset / delete path: kill(sessionId) sets session.intentionalExit
    // before the force-kill WITHOUT setting status='suspended' (a hard reset is
    // 'exited', not resumable). onExit must still tag the event intentional so the
    // renderer suppresses the false "Session crashed" notification.
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    const session = context.registry.get(input.id!);
    expect(session).toBeDefined();
    session!.intentionalExit = true;

    ptyHarness.onExitCallback!({ exitCode: 1073807364 });

    expect(findExitEmit(context)).toEqual(['exit', input.id, 1073807364, true]);
    // A hard reset is recorded as 'exited' (not 'suspended'); the intent is
    // carried by the orthogonal marker, not the status.
    expect(context.registry.get(input.id!)!.status).toBe('exited');
  });

  it('tags the exit event intentional=false for an unexpected (crash) exit', async () => {
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    // The session was never suspended, so the exit is a genuine crash.
    const session = context.registry.get(input.id!);
    expect(session!.status).not.toBe('suspended');

    ptyHarness.onExitCallback!({ exitCode: 1 });

    expect(findExitEmit(context)).toEqual(['exit', input.id, 1, false]);
    // A non-suspended exit is recorded as 'exited'.
    expect(context.registry.get(input.id!)!.status).toBe('exited');
  });

  it('tags intentional=false even on a clean (exit 0) crash-path exit', async () => {
    // Guards against keying the flag on the exit code instead of the status:
    // a non-suspended exit 0 is still not an intentional suspend.
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    ptyHarness.onExitCallback!({ exitCode: 0 });

    expect(findExitEmit(context)).toEqual(['exit', input.id, 0, false]);
  });
});

/**
 * `overrideExitCode` MASKS the OS exit code when Kangentic ends a session on the
 * agent's behalf. Today only the agent-absence sweep sets it, always to 0.
 *
 * That sweep force-kills a shell whose agent CLI had already exited NORMALLY (a
 * user `/exit`, a crash, a failed launch) while the shell survived. Every
 * platform reports a force-kill with an abnormal code, and
 * `SessionRepository.getInterruptedExited` resumes exactly those on the next
 * launch - so reporting the real code would resurrect the very conversation the
 * user ended, contradicting that query's documented "clean exit 0 is excluded so
 * a deliberate /exit is never resurrected".
 */
describe('session-spawn-flow onExit - overrideExitCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptyHarness.onExitCallback = null;
  });

  it('reports the override instead of the OS force-kill code', async () => {
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    // What retireAgentlessSession() does before calling kill().
    const session = context.registry.get(input.id!);
    session!.overrideExitCode = 0;
    session!.intentionalExit = true;

    // The OS reports the Windows ConPTY force-kill code...
    ptyHarness.onExitCallback!({ exitCode: 1073807364 });

    // ...but 0 is what reaches the DB writer, which is the value
    // getInterruptedExited keys on.
    expect(findExitEmit(context)).toEqual(['exit', input.id, 0, true]);
    expect(context.registry.get(input.id!)!.exitCode).toBe(0);
  });

  it('reports the override on a POSIX SIGKILL code too', async () => {
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    const session = context.registry.get(input.id!);
    session!.overrideExitCode = 0;
    session!.intentionalExit = true;

    ptyHarness.onExitCallback!({ exitCode: 137 });

    expect(findExitEmit(context)).toEqual(['exit', input.id, 0, true]);
    expect(context.registry.get(input.id!)!.exitCode).toBe(0);
  });

  it('leaves the real OS code alone when no override is set', async () => {
    // The override is opt-in: every other exit path must be byte-for-byte
    // unchanged, including a genuine crash that MUST stay resumable at startup.
    const context = makeContext();
    const input = makeInput();
    await performSpawn(input, context);

    expect(context.registry.get(input.id!)!.overrideExitCode).toBeUndefined();

    ptyHarness.onExitCallback!({ exitCode: 137 });

    expect(findExitEmit(context)).toEqual(['exit', input.id, 137, false]);
    expect(context.registry.get(input.id!)!.exitCode).toBe(137);
  });
});
