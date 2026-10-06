/**
 * Tests for the caller-owned session ID branch in performSpawn.
 *
 * Scope: lines 207-247 of session-spawn-flow.ts - the new
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

// Holder so the node-pty mock can hand the captured onExit callback back to
// the "onExit fallback ordering" describe block below (mirrors the harness in
// session-exit-intentional.test.ts). Every other describe block in this file
// never fires it, so capturing it here is purely additive.
const ptyExitHarness = vi.hoisted(() => ({
  onExitCallback: null as ((event: { exitCode: number }) => void) | null,
}));

// Prevent real PTY process from spawning.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      ptyExitHarness.onExitCallback = callback;
    }),
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

// Stub shutdown guard: spawning is allowed unless a test flips the flag (the
// "shutdown begins during the host round trip" block below). Every flip is
// undone in that block's afterEach, so the rest of the file always spawns.
const shutdownState = vi.hoisted(() => ({ shuttingDown: false }));
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shutdownState.shuttingDown,
}));

// Stub spawn env/cwd helpers - return safe defaults, no real fs access.
// resolveSpawnCwd is a vi.fn() so write-order tests can override the fixup
// command per-call via mockReturnValueOnce.
vi.mock('../../src/main/pty/spawn/pty-spawn', () => ({
  resolveShellArgs: (shell: string) => ({ exe: shell, args: [] }),
  buildSpawnEnv: (env: Record<string, string> | undefined) => ({ ...env }),
  resolveSpawnCwd: vi.fn(({ requestedCwd }: { requestedCwd: string }) => ({
    effectiveCwd: requestedCwd,
    cwdFixupCommand: null,
  })),
}));

// Stub spawn-failure-handler - never used in happy-path tests.
vi.mock('../../src/main/pty/spawn/spawn-failure-handler', () => ({
  handleSpawnFailure: vi.fn(),
}));

// Stub adapter lifecycle hooks - no-ops for these tests.
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
vi.mock('../../src/main/pr/pr-registry', () => ({
  detectPR: vi.fn(() => null),
}));

// Stub shell path adaptation. adaptCommandForShell is a vi.fn() (default:
// identity) so the cwd-fixup-order tests can override it per-call via
// mockImplementationOnce to prove the fixup command bypasses it (see
// "writes the fixup command RAW" below).
vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: vi.fn((cmd: string) => cmd),
  // Default to no prelude so the write-order assertions below stay
  // byte-exact; the dedicated prelude test overrides this with a marker.
  buildSpawnClearPrelude: vi.fn(() => ''),
}));

// ---- Import under test (after all vi.mock hoisting) ----
import { performSpawn, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from '../../src/main/pty/lifecycle/session-spawn-flow';
import { SessionRegistry } from '../../src/main/pty/session-registry';
import { resolveSpawnCwd } from '../../src/main/pty/spawn/pty-spawn';
import { handleSpawnFailure } from '../../src/main/pty/spawn/spawn-failure-handler';
import { safeKillPty } from '../../src/main/pty/lifecycle/pty-kill';
import { adaptCommandForShell, buildSpawnClearPrelude } from '../../src/shared/paths';
import * as ptyModule from 'node-pty';
import { InProcessPtyHostTransport, PtyHostClient } from '../../src/main/pty/host/pty-host-client';

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
/** Each context's in-process pty host transport, for seeding and reading rings. */
const hostTransports = new WeakMap<SpawnFlowContext, InProcessPtyHostTransport>();

function makeContext(): SpawnFlowContext {
  const registry = new SessionRegistry();
  const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
  const host = new PtyHostClient(transport);
  vi.spyOn(host, 'spawn');
  const context = {
    registry,
    host,
    setBufferCols: vi.fn(),
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
      takePendingPushedBranch: vi.fn(() => null),
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
    firstOutputTracker: {
      removeSession: vi.fn(),
    },
    getShell: vi.fn().mockResolvedValue('/bin/bash'),
    takePendingResize: vi.fn(() => undefined),
    emit: vi.fn(),
  } as unknown as SpawnFlowContext;
  hostTransports.set(context, transport);
  return context;
}

/** Give a session a ring in the context's host, as an earlier spawn would. */
function seedRing(context: SpawnFlowContext, sessionId: string, bytes: string): void {
  hostTransports.get(context)!.core.handleCommand({ type: 'initSession', sessionId, scrollback: bytes, cols: 120 });
}

/** The ring the host holds for a session. */
function ringOf(context: SpawnFlowContext, sessionId: string): string {
  return hostTransports.get(context)!.core.getRawScrollback(sessionId);
}

/** What performSpawn asked the host to spawn. */
function lastSpawnParams(context: SpawnFlowContext): Parameters<PtyHostClient['spawn']>[0] {
  const calls = vi.mocked(context.host.spawn).mock.calls;
  return calls[calls.length - 1][0];
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

describe('performSpawn - KANGENTIC_EVENTS_PATH env injection', () => {
  // ptyModule.spawn is the vi.fn() from the module-level vi.mock('node-pty').
  // Accessing it via the named import lets us inspect .mock.calls across tests.
  const ptySpawnMock = ptyModule.spawn as ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes KANGENTIC_EVENTS_PATH in the spawn env when eventsOutputPath is set', async () => {
    const context = makeContext();
    const eventsPath = '/home/dev/project/.kangentic/sessions/test-session/events.jsonl';
    const input = makeInput({ eventsOutputPath: eventsPath });

    await performSpawn(input, context);

    expect(ptySpawnMock).toHaveBeenCalledOnce();
    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env).toBeDefined();
    expect(spawnOptions.env!['KANGENTIC_EVENTS_PATH']).toBe(eventsPath);
  });

  it('does NOT add KANGENTIC_EVENTS_PATH when eventsOutputPath is absent', async () => {
    const context = makeContext();
    // makeInput() does not set eventsOutputPath by default.
    const input = makeInput();

    await performSpawn(input, context);

    expect(ptySpawnMock).toHaveBeenCalledOnce();
    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env).toBeDefined();
    expect('KANGENTIC_EVENTS_PATH' in (spawnOptions.env ?? {})).toBe(false);
  });

  it('does NOT add KANGENTIC_EVENTS_PATH when eventsOutputPath is undefined', async () => {
    const context = makeContext();
    const input = makeInput({ eventsOutputPath: undefined });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect('KANGENTIC_EVENTS_PATH' in (spawnOptions.env ?? {})).toBe(false);
  });

  it('eventsOutputPath value wins over a caller-supplied KANGENTIC_EVENTS_PATH in input.env', async () => {
    // The spawn flow merges input.env first, then unconditionally overwrites
    // KANGENTIC_EVENTS_PATH with input.eventsOutputPath (lines 136-139 of
    // session-spawn-flow.ts). Verify that the eventsOutputPath value wins.
    const context = makeContext();
    const callerEnvValue = '/caller/supplied/path.jsonl';
    const eventsOutputPathValue = '/authoritative/events/path.jsonl';
    const input = makeInput({
      env: { KANGENTIC_EVENTS_PATH: callerEnvValue, OTHER_VAR: 'preserved' },
      eventsOutputPath: eventsOutputPathValue,
    });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    // eventsOutputPath must win.
    expect(spawnOptions.env!['KANGENTIC_EVENTS_PATH']).toBe(eventsOutputPathValue);
    // Other env vars from input.env must be preserved.
    expect(spawnOptions.env!['OTHER_VAR']).toBe('preserved');
  });

  it('merges input.env into the spawn env when eventsOutputPath is absent', async () => {
    const context = makeContext();
    const input = makeInput({
      env: { CUSTOM_VAR: 'hello', ANOTHER_VAR: 'world' },
    });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env!['CUSTOM_VAR']).toBe('hello');
    expect(spawnOptions.env!['ANOTHER_VAR']).toBe('world');
    expect('KANGENTIC_EVENTS_PATH' in (spawnOptions.env ?? {})).toBe(false);
  });
});

describe('performSpawn - KANGENTIC_TASK_ID task process tag', () => {
  // Every process a task's agent starts inherits this tag, which is how a
  // terminal transition finds what the task left running (process-tag/).
  const ptySpawnMock = ptyModule.spawn as ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.clearAllMocks();
  });

  function spawnEnvAt(callIndex: number): Record<string, string> {
    return (ptySpawnMock.mock.calls[callIndex]?.[2] as { env: Record<string, string> }).env;
  }

  it('tags a task session with its task id, the same value on every spawn of the task', async () => {
    const context = makeContext();
    await performSpawn(makeInput({ id: 'session-first-0000-000000000000', taskId: 'task-tagged' }), context);
    await performSpawn(makeInput({ id: 'session-second-000-000000000000', taskId: 'task-tagged', resuming: true }), context);

    expect(spawnEnvAt(0).KANGENTIC_TASK_ID).toBe('task-tagged');
    expect(spawnEnvAt(1).KANGENTIC_TASK_ID).toBe('task-tagged');
  });

  it('never tags a Command Terminal: it is the user\'s own shell, not task work', async () => {
    const context = makeContext();
    await performSpawn(makeInput({ taskId: 'transient-slot-1', transient: true }), context);

    expect('KANGENTIC_TASK_ID' in spawnEnvAt(0)).toBe(false);
  });

  it('shares the tag into the distro through WSLENV on a WSL shell', async () => {
    const context = makeContext();
    vi.mocked(context.getShell).mockResolvedValue('wsl -d Ubuntu');
    await performSpawn(makeInput({ taskId: 'task-wsl' }), context);

    expect(spawnEnvAt(0).KANGENTIC_TASK_ID).toBe('task-wsl');
    expect(spawnEnvAt(0).WSLENV?.split(':')).toContain('KANGENTIC_TASK_ID/u');
  });
});

describe('performSpawn - resume path does not adopt bg shells', () => {
  // Regression guard: reconcileBgShellsOnResume was deleted (bug fix for the
  // "activity engine stays thinking on idle sessions" phantom-adoption bug).
  // This test ensures no future change re-introduces bg-shell adoption on the
  // resume path. If adoptAnonymousBackgroundShells were ever called from inside
  // performSpawn, the activity engine's anonymousBackgroundShellCount would get
  // a phantom value, pinning the session in 'thinking' indefinitely (the exact
  // bug this branch fixes).
  //
  // Tier: Unit (no PTY, no OS, no IPC - pure mock collaborators).

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resuming: true - telemetry.initSession called, adoptAnonymousBackgroundShells NOT called', async () => {
    const context = makeContext();
    // Expose adoptAnonymousBackgroundShells as a spy on the telemetry stub.
    // In production this method lives on ActivityEngine (not SessionTelemetry
    // directly), but having it present on the mock lets us verify it was never
    // called even if a future change incorrectly wires the path.
    const adoptSpy = vi.fn();
    (context.telemetry as Record<string, unknown>).adoptAnonymousBackgroundShells = adoptSpy;

    const input = makeInput({ resuming: true });
    await performSpawn(input, context);

    // initSession must still be called on the resume path - this initialises
    // activity-engine state for the resumed session.
    expect(context.telemetry.initSession).toHaveBeenCalledOnce();
    // adoptAnonymousBackgroundShells must NOT be called.
    expect(adoptSpy).not.toHaveBeenCalled();
  });

  it('resuming: false (fresh spawn) - adoptAnonymousBackgroundShells NOT called', async () => {
    // Confirms the method was not added to the spawn path for fresh sessions
    // either - it has no production caller in session-spawn-flow.ts.
    const context = makeContext();
    const adoptSpy = vi.fn();
    (context.telemetry as Record<string, unknown>).adoptAnonymousBackgroundShells = adoptSpy;

    const input = makeInput({ resuming: false });
    await performSpawn(input, context);

    expect(context.telemetry.initSession).toHaveBeenCalledOnce();
    expect(adoptSpy).not.toHaveBeenCalled();
  });
});

describe('performSpawn - scrollback carry-over geometry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('asks the host to carry the old ring over, and drops the old session once the spawn lands', async () => {
    const context = makeContext();
    seedRing(context, 'old-session-id', 'carried bytes');
    // An existing session for the task makes this a respawn; pty: null skips
    // the orphan-kill path so no fake PTY shape is needed.
    context.registry.set('old-session-id', {
      id: 'old-session-id',
      taskId: 'task-001',
      projectId: 'project-001',
      pty: null,
      status: 'running',
    } as never);

    await performSpawn(makeInput(), context);

    // The host reads the old ring and its geometry, which is what keeps the
    // replay geometry gate accurate across a respawn. Main drops the old
    // session after the spawn, so a cancelled spawn would have left it intact.
    const params = lastSpawnParams(context);
    expect(params.carryoverFromSessionId).toBe('old-session-id');
    expect(ringOf(context, makeInput().id!)).toBe('carried bytes');
    expect(ringOf(context, 'old-session-id')).toBe('');
  });
});

describe('performSpawn - first-output latch cleanup', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('drops the OLD session\'s first-output latch on respawn over an existing session', async () => {
    // A latched entry surviving under a reused id would permanently suppress
    // 'first-output' for the new session - and with it the post-first-output
    // geometry re-assert (the spawn-race fix).
    const context = makeContext();
    context.registry.set('old-session-id', {
      id: 'old-session-id',
      taskId: 'task-001',
      projectId: 'project-001',
      pty: null,
      status: 'running',
    } as never);

    await performSpawn(makeInput(), context);

    expect(context.firstOutputTracker.removeSession).toHaveBeenCalledExactlyOnceWith('old-session-id');
  });

  it('never touches the tracker on a fresh spawn (no existing session)', async () => {
    const context = makeContext();

    await performSpawn(makeInput(), context);

    expect(context.firstOutputTracker.removeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One row per task: a spawn drains EVERY stale registry row for its task.
//
// The observed leak: a paused task collected a placeholder per recovery pass,
// then a settings restart suspended its live row in place and respawned. The
// spawn evicted only `findByTaskId`'s first match (the placeholder), so the
// registry ended as [suspended, running] and the renderer's first-wins
// consumers painted "Resume session" over the running agent.
// ---------------------------------------------------------------------------

/** Seed a registry row directly; only the fields the drain reads are set. */
function seedRow(
  context: SpawnFlowContext,
  row: {
    id: string;
    status: 'running' | 'queued' | 'suspended' | 'exited';
    startedAt?: string;
    isolatedSwimlaneId?: string | null;
  },
): void {
  context.registry.set(row.id, {
    id: row.id,
    taskId: 'task-001',
    projectId: 'project-001',
    pty: null,
    status: row.status,
    startedAt: row.startedAt,
    isolatedSwimlaneId: row.isolatedSwimlaneId ?? null,
  } as never);
}

const PLACEHOLDER_STARTED_AT = '2026-09-04T14:18:31.000Z';
const SUSPENDED_STARTED_AT = '2026-09-04T14:25:26.000Z';

describe('performSpawn - one row per task', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('drains a leaked placeholder AND the suspended-in-place row behind it', async () => {
    const context = makeContext();
    seedRow(context, { id: 'sess-placeholder', status: 'suspended', startedAt: PLACEHOLDER_STARTED_AT });
    seedRow(context, { id: 'sess-suspended', status: 'suspended', startedAt: SUSPENDED_STARTED_AT });
    const posted = vi.spyOn(context.host, 'post');

    await performSpawn(makeInput({ id: 'sess-respawn' }), context);

    const rows = context.registry.listByTaskId('task-001');
    expect(rows.map((row) => row.id)).toEqual(['sess-respawn']);
    expect(rows[0].status).toBe('running');
    for (const staleId of ['sess-placeholder', 'sess-suspended']) {
      expect(context.sessionFiles.detachPreservingFiles).toHaveBeenCalledWith(staleId);
      expect(context.sessionIdManager.removeSession).toHaveBeenCalledWith(staleId);
      expect(context.firstOutputTracker.removeSession).toHaveBeenCalledWith(staleId);
      expect(context.telemetry.removeSession).toHaveBeenCalledWith(staleId);
      expect(posted).toHaveBeenCalledWith({ type: 'removeSession', sessionId: staleId });
      expect(context.sessionFiles.removeSession).toHaveBeenCalledWith(staleId);
    }
    // The new session's own id is never dropped, though a promotion reuses it.
    expect(posted).not.toHaveBeenCalledWith({ type: 'removeSession', sessionId: 'sess-respawn' });
  });

  it.each([
    ['older row first', ['sess-older', 'sess-newer']],
    ['newer row first', ['sess-newer', 'sess-older']],
  ])('carries scrollback over from the most recently started sibling (%s)', async (_label, insertionOrder) => {
    const context = makeContext();
    for (const id of insertionOrder) {
      seedRow(context, {
        id,
        status: 'suspended',
        startedAt: id === 'sess-newer' ? SUSPENDED_STARTED_AT : PLACEHOLDER_STARTED_AT,
      });
    }
    seedRing(context, 'sess-newer', 'newer bytes');
    seedRing(context, 'sess-older', 'older bytes');

    await performSpawn(makeInput({ id: 'sess-respawn' }), context);

    expect(lastSpawnParams(context).carryoverFromSessionId).toBe('sess-newer');
    expect(ringOf(context, 'sess-respawn')).toBe('newer bytes');
  });

  it('settings restart: the row suspended in place is drained by its own respawn', async () => {
    // restartSessionForSettingsChange suspends in place (status flips, the PTY
    // is released, the row keeps its Map position) and then respawns. Nothing
    // else evicts that row; the respawn must.
    const context = makeContext();
    seedRow(context, { id: 'sess-live', status: 'suspended', startedAt: SUSPENDED_STARTED_AT });

    await performSpawn(makeInput({ id: 'sess-restarted' }), context);

    expect(context.registry.listByTaskId('task-001').map((row) => row.id)).toEqual(['sess-restarted']);
  });

  it('an isolated-column spawn replaces the suspended main row: one row per task, whatever the track', async () => {
    // The DB keeps a record per (task, isolation) so each track resumes its
    // own conversation; the registry holds only the task's CURRENT session.
    const context = makeContext();
    seedRow(context, { id: 'sess-main', status: 'suspended', isolatedSwimlaneId: null });

    await performSpawn(makeInput({ id: 'sess-review', isolatedSwimlaneId: 'lane-review' }), context);

    const rows = context.registry.listByTaskId('task-001');
    expect(rows.map((row) => row.id)).toEqual(['sess-review']);
    expect(rows[0].isolatedSwimlaneId).toBe('lane-review');
    // The main session's files stay on disk for its own later resume.
    expect(context.sessionFiles.detachPreservingFiles).toHaveBeenCalledWith('sess-main');
  });

  it('queue promotion: carries over from the suspended predecessor, not the placeholder whose id it reuses', async () => {
    // While a respawn waits for a slot the task holds [suspended, queued]. The
    // promotion spawns under the placeholder's own id, which has no scrollback;
    // the bytes to inherit are the predecessor's, even though the placeholder
    // started later.
    const context = makeContext();
    const queuedId = makeInput().id!;
    seedRow(context, { id: 'sess-suspended', status: 'suspended', startedAt: SUSPENDED_STARTED_AT });
    seedRow(context, { id: queuedId, status: 'queued', startedAt: '2026-09-04T14:25:33.000Z' });
    seedRing(context, 'sess-suspended', 'predecessor bytes');

    await performSpawn(makeInput(), context);

    expect(lastSpawnParams(context).carryoverFromSessionId).toBe('sess-suspended');
    expect(ringOf(context, queuedId)).toBe('predecessor bytes');
    const rows = context.registry.listByTaskId('task-001');
    expect(rows.map((row) => row.id)).toEqual([queuedId]);
    expect(rows[0].status).toBe('running');
  });

  it('pickCarryoverSource fallback: a lone queued placeholder keeps its own (empty) carry-over as the only sibling', async () => {
    // Promoting a lone queued placeholder with no predecessor: the sibling
    // loop skips the row matching the reused id (it has no scrollback worth
    // reading yet), so `source` stays null - but that same row is
    // `siblings[0]`, and the `?? siblings[0]` fallback is what keeps it as the
    // carry-over source instead of falling through to no source at all.
    const context = makeContext();
    const queuedId = makeInput().id!;
    seedRow(context, { id: queuedId, status: 'queued', startedAt: SUSPENDED_STARTED_AT });

    await performSpawn(makeInput(), context);

    expect(lastSpawnParams(context).carryoverFromSessionId).toBe(queuedId);
  });

  it.each([
    ['undefined startedAt sibling first', ['sess-no-started-at', 'sess-timestamped']],
    ['timestamped sibling first', ['sess-timestamped', 'sess-no-started-at']],
  ])('prefers the sibling with a real startedAt over one with a missing value (%s)', async (_label, insertionOrder) => {
    // ISO-string comparison treats a missing startedAt as sorting oldest
    // ((startedAt || '') > (source.startedAt || '')), so a sibling with a real
    // timestamp must win regardless of which one the Map iterates first.
    const context = makeContext();
    for (const id of insertionOrder) {
      seedRow(context, {
        id,
        status: 'suspended',
        startedAt: id === 'sess-timestamped' ? SUSPENDED_STARTED_AT : undefined,
      });
    }
    seedRing(context, 'sess-timestamped', 'timestamped bytes');
    seedRing(context, 'sess-no-started-at', 'undated bytes');

    await performSpawn(makeInput({ id: 'sess-respawn' }), context);

    expect(lastSpawnParams(context).carryoverFromSessionId).toBe('sess-timestamped');
    expect(ringOf(context, 'sess-respawn')).toBe('timestamped bytes');
  });

  it('a failed spawn has already drained the stale rows and hands the carried scrollback to the failure placeholder', async () => {
    const context = makeContext();
    seedRow(context, { id: 'sess-placeholder', status: 'suspended', startedAt: PLACEHOLDER_STARTED_AT });
    seedRow(context, { id: 'sess-suspended', status: 'suspended', startedAt: SUSPENDED_STARTED_AT });
    seedRing(context, 'sess-suspended', 'carried bytes');
    vi.mocked(ptyModule.spawn).mockImplementationOnce(() => {
      throw new Error('spawn boom');
    });
    let rowsAtFailure: string[] | null = null;
    let scrollbackAtFailure: string | null = null;
    vi.mocked(handleSpawnFailure).mockImplementationOnce((_error, attempt, failureContext) => {
      rowsAtFailure = failureContext.registry.listByTaskId(attempt.input.taskId).map((row) => row.id);
      scrollbackAtFailure = attempt.previousScrollback;
      return { id: attempt.id, taskId: attempt.input.taskId, status: 'exited' } as never;
    });

    await performSpawn(makeInput({ id: 'sess-failed' }), context);

    // The real handler registers exactly one exited row, so the task ends at one.
    expect(rowsAtFailure).toEqual([]);
    expect(scrollbackAtFailure).toBe('carried bytes');
  });

  it('guards the mobile read-stream successor hop: the drain drops the paused sibling with no session-removed, before the new session-changed', async () => {
    // A phone's feed on a paused row ends naming the successor when it sees a
    // same-task session-changed AFTER its own row is gone from the registry
    // (handlers/read-stream.ts, onSessionChanged). A 'session-removed' for the
    // sibling would end the feed first and without the successor id, and a
    // sibling still in the registry when the new session is announced would
    // hold the hop back. So this drain must stay silent about the sibling and
    // must finish before the announcement.
    const context = makeContext();
    seedRow(context, { id: 'sess-paused', status: 'suspended', startedAt: SUSPENDED_STARTED_AT });
    const emittedEvents: string[] = [];
    let rowIdsAtSessionChanged: string[] | null = null;
    let pausedRowAtSessionChanged: unknown = 'session-changed was not observed';
    vi.mocked(context.emit).mockImplementation((event: string, ...args: unknown[]) => {
      emittedEvents.push(event);
      if (event === 'session-changed' && args[0] === 'sess-resumed') {
        rowIdsAtSessionChanged = context.registry.listByTaskId('task-001').map((row) => row.id);
        pausedRowAtSessionChanged = context.registry.get('sess-paused');
      }
    });

    await performSpawn(makeInput({ id: 'sess-resumed' }), context);

    // The announcement fired, and found the new session as the task's only row.
    expect(emittedEvents).toContain('session-changed');
    expect(rowIdsAtSessionChanged).toEqual(['sess-resumed']);
    expect(pausedRowAtSessionChanged).toBeUndefined();
    // Nothing announced the sibling's removal, at any point of the spawn.
    expect(emittedEvents).not.toContain('session-removed');
  });
});

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

describe('performSpawn - Windows cwd fixup write order', () => {
  // When resolveSpawnCwd returns a cwdFixupCommand (cmd.exe UNC pushd or
  // PowerShell bracket Set-Location), performSpawn must write the fixup RAW
  // into the PTY first, then write the initial command 200ms later so the
  // session lands in the real project directory. The writes are setTimeout-
  // based (100ms initial, 200ms fixup-to-command), so drive with fake timers.
  //
  // Red-green: drop the cwdFixupCommand write in session-spawn-flow.ts and the
  // first-write assertion goes red; require input.command for the fixup write
  // and the fixup-alone test goes red.
  //
  // Tier: Unit - pure mock collaborators, no PTY, no OS, no IPC.

  const ptySpawnMock = ptyModule.spawn as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT a mockReturnValue implementation,
    // so restore the suite's no-prelude default here - a failing assertion in
    // the prelude test must not leak 'CLEARPRE; ' into byte-exact write
    // assertions elsewhere in this file.
    vi.mocked(buildSpawnClearPrelude).mockReturnValue('');
  });

  it('writes the fixup command first, then the initial command', async () => {
    vi.mocked(resolveSpawnCwd).mockReturnValueOnce({
      effectiveCwd: 'C:\\Users\\dev\\[foo]\\bar',
      cwdFixupCommand: "Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'",
    });

    const context = makeContext();
    const input = makeInput({ command: 'claude --resume abc' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;

    // Nothing written until the 100ms initial delay elapses.
    expect(writeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    // Only the fixup so far - the command waits another 200ms.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'\r");

    vi.advanceTimersByTime(200);
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls[1][0]).toBe('claude --resume abc\r');
  });

  it('writes the fixup alone when there is no initial command', async () => {
    vi.mocked(resolveSpawnCwd).mockReturnValueOnce({
      effectiveCwd: 'C:\\Users\\dev\\[foo]\\bar',
      cwdFixupCommand: "Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'",
    });

    const context = makeContext();
    const input = makeInput({ command: '' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;

    vi.advanceTimersByTime(100);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'\r");

    // No command was scheduled, so advancing further writes nothing more.
    vi.advanceTimersByTime(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('writes only the command (no fixup) when cwdFixupCommand is null', async () => {
    // Default mock returns cwdFixupCommand: null - the common non-Windows /
    // bracket-free case. The command is written directly, with no fixup and no
    // 200ms stagger.
    const context = makeContext();
    const input = makeInput({ command: 'echo hi' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;

    vi.advanceTimersByTime(100);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toBe('echo hi\r');
  });

  it('writes the fixup command RAW, bypassing adaptCommandForShell (only the initial command is adapted)', async () => {
    // The default adaptCommandForShell mock is identity, so it cannot tell
    // "written raw" apart from "routed through adaptCommandForShell and
    // happened to come back unchanged" - a regression that started routing
    // cwdFixupCommand through adaptCommandForShell (e.g. picking up
    // PowerShell's `& ` call-operator prefix, which would break the
    // `Set-Location` syntax) would slip past every other test in this
    // describe block. Override the mock with a non-identity transform for
    // this one call so the two paths are distinguishable.
    vi.mocked(resolveSpawnCwd).mockReturnValueOnce({
      effectiveCwd: 'C:\\Users\\dev\\[foo]\\bar',
      cwdFixupCommand: "Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'",
    });
    vi.mocked(adaptCommandForShell).mockImplementationOnce((cmd: string) => `ADAPTED:${cmd}`);

    const context = makeContext();
    const input = makeInput({ command: 'claude --resume abc' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;

    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(200);

    expect(writeMock).toHaveBeenCalledTimes(2);
    // The fixup must never pass through adaptCommandForShell, so no
    // "ADAPTED:" marker even though the override would add one to anything
    // routed through it.
    expect(writeMock.mock.calls[0][0]).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'\r");
    // The initial command DOES go through adaptCommandForShell.
    expect(writeMock.mock.calls[1][0]).toBe('ADAPTED:claude --resume abc\r');
  });

  it('prefixes the shell clear prelude on agent spawns and skips it for transient shells', async () => {
    // The prelude makes the SHELL erase its startup preamble and command
    // echo at execution time (see buildSpawnClearPrelude) - the source-level
    // guard that stays valid across pwsh/ConPTY updates. Transient Command
    // Terminals are a normal shell experience and must not be auto-cleared.
    vi.mocked(buildSpawnClearPrelude).mockReturnValue('CLEARPRE; ');

    const agentContext = makeContext();
    await performSpawn(makeInput({ command: 'claude --resume abc' }), agentContext);
    vi.advanceTimersByTime(100);
    const agentWrite = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;
    expect(agentWrite.mock.calls[0][0]).toBe('CLEARPRE; claude --resume abc\r');

    vi.clearAllMocks();
    vi.mocked(buildSpawnClearPrelude).mockReturnValue('CLEARPRE; ');
    const transientContext = makeContext();
    await performSpawn(
      makeInput({ id: 'transient-session-id-000000000', taskId: 'task-002', command: 'echo hi', transient: true }),
      transientContext,
    );
    vi.advanceTimersByTime(100);
    const transientWrite = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;
    expect(transientWrite.mock.calls[0][0]).toBe('echo hi\r');
    // The suite-default '' prelude is restored by this block's afterEach, so a
    // failing assertion above cannot leak 'CLEARPRE; ' into later tests.
  });

  it('the prelude rides the cwd-fixup deferred write', async () => {
    // Both write-order mechanisms active at once: a Windows cwd fixup (100ms
    // write, then the command 200ms later) AND a non-empty clear prelude. The
    // fixup is written RAW - no prelude, since it is not the typed agent
    // command - while the prelude rides along on the DEFERRED command write
    // that follows it. A regression that prefixed the prelude onto the fixup
    // write instead of the command write would pass the other tests in this
    // describe block (which never combine both mocks at once) but fail here.
    vi.mocked(resolveSpawnCwd).mockReturnValueOnce({
      effectiveCwd: 'C:\\Users\\dev\\[foo]\\bar',
      cwdFixupCommand: "Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'",
    });
    vi.mocked(buildSpawnClearPrelude).mockReturnValue('CLEARPRE; ');

    const context = makeContext();
    const input = makeInput({ command: 'claude --resume abc' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;

    vi.advanceTimersByTime(100);
    // The fixup write at 100ms carries no prelude - it is not the typed
    // command, and prefixing it would corrupt the Set-Location syntax.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'\r");

    vi.advanceTimersByTime(200);
    // The deferred command write at +200ms carries the prelude.
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls[1][0]).toBe('CLEARPRE; claude --resume abc\r');
  });

  it('skips the deferred writes once the session no longer owns the PTY', async () => {
    // The timers hold the raw ptyProcess, not session.pty. Every kill /
    // respawn / exit path nulls session.pty in its own tick, before the 100ms
    // write fires; the write must notice rather than type into a dead ConPTY
    // handle (node-pty throws) or into a successor session's shell.
    vi.mocked(resolveSpawnCwd).mockReturnValueOnce({
      effectiveCwd: 'C:\\Users\\dev\\[foo]\\bar',
      cwdFixupCommand: "Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'",
    });

    const context = makeContext();
    const input = makeInput({ command: 'claude --resume abc' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;
    const session = context.registry.get(input.id!);
    expect(session?.pty).not.toBeNull();
    session!.pty = null;

    vi.advanceTimersByTime(300);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('tolerates node-pty throwing on a write to a PTY that died between the timer arming and firing', async () => {
    const context = makeContext();
    const input = makeInput({ command: 'echo hi' });

    await performSpawn(input, context);

    const writeMock = ptySpawnMock.mock.results[0]?.value.write as ReturnType<typeof vi.fn>;
    writeMock.mockImplementationOnce(() => {
      throw new Error('EPIPE');
    });

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});

describe('performSpawn - activity engine initialTurnActive seed (thinking vs idle)', () => {
  // The activity-indicator feature added a third argument to
  // telemetry.initSession: `initialTurnActive`. performSpawn derives it as
  // `!input.resuming && !input.transient`. This suite pins that derivation so
  // a future change to the expression (e.g. hardcoding true/false or dropping
  // the transient guard) is caught immediately.
  //
  // Red-green: change `!input.resuming && !input.transient` in
  // session-spawn-flow.ts to `false` and the fresh-spawn test goes red
  // (initSession receives false instead of true). Change it to `true` and the
  // resuming / transient tests go red (initSession receives true instead of
  // false).
  //
  // Tier: Unit - pure mock collaborators, no PTY, no OS, no IPC.

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fresh spawn (not resuming, not transient) passes initialTurnActive=true to telemetry', async () => {
    // A brand-new task spawn is already processing its initial prompt, so the
    // activity engine must seed 'thinking' immediately - no idle flash during boot.
    const context = makeContext();
    const input = makeInput({ resuming: false, transient: false });

    await performSpawn(input, context);

    expect(context.telemetry.initSession).toHaveBeenCalledOnce();
    const initArgs = (context.telemetry.initSession as ReturnType<typeof vi.fn>).mock.calls[0];
    // initSession(sessionId, agentParser, initialTurnActive)
    // Third argument must be true for a fresh task spawn.
    expect(initArgs[2]).toBe(true);
  });

  it('resuming spawn passes initialTurnActive=false to telemetry (seeds idle)', async () => {
    // A resumed session comes up waiting for the user at a quiet prompt - it is
    // NOT processing a new prompt. The engine must seed 'idle', not 'thinking'.
    const context = makeContext();
    const input = makeInput({ resuming: true, transient: false });

    await performSpawn(input, context);

    expect(context.telemetry.initSession).toHaveBeenCalledOnce();
    const initArgs = (context.telemetry.initSession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(initArgs[2]).toBe(false);
  });

  it('transient command-terminal spawn passes initialTurnActive=false to telemetry (seeds idle)', async () => {
    // A transient (command-terminal) spawn awaits the user's first command, so it
    // starts idle too. The expression !resuming && !transient must cover both
    // the resuming and the transient flag independently.
    const context = makeContext();
    const input = makeInput({ resuming: false, transient: true });

    await performSpawn(input, context);

    expect(context.telemetry.initSession).toHaveBeenCalledOnce();
    const initArgs = (context.telemetry.initSession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(initArgs[2]).toBe(false);
  });
});

describe('performSpawn - the resolved permission mode rides on the session', () => {
  // The spawn analytics event fires inside spawn(), before the caller inserts
  // the session's record, so it reads the mode off the registry row.

  it('records the input\'s permission mode on the registry row', async () => {
    const context = makeContext();
    const input = makeInput({ permissionMode: 'plan' });

    await performSpawn(input, context);

    expect(context.registry.getSessionPermissionMode(input.id!)).toBe('plan');
  });

  it('records none for a spawn that passes none (a Command Terminal)', async () => {
    const context = makeContext();
    const input = makeInput({ transient: true });

    await performSpawn(input, context);

    expect(context.registry.getSessionPermissionMode(input.id!)).toBeNull();
  });
});

describe('performSpawn - earlier runs load', () => {
  // A resume is a new session record, so the pill's tool-call count needs the
  // track's earlier runs. performSpawn hands the new session to the manager's
  // loader once its row is registered and telemetry initialised, and before
  // the status-file reader can stamp a first usage without them.

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the earlier runs once, after initSession and before the status reader attaches', async () => {
    const context = makeContext();
    const order: string[] = [];
    vi.mocked(context.telemetry.initSession).mockImplementation(() => { order.push('initSession'); });
    vi.mocked(context.statusFileReader.attach).mockImplementation(() => { order.push('statusFileReader.attach'); });
    let rowRegistered = false;
    context.loadEarlierRuns = vi.fn((sessionId: string) => {
      rowRegistered = context.registry.get(sessionId) !== undefined;
      order.push('loadEarlierRuns');
    });
    const input = makeInput({ resuming: true, statusOutputPath: '/home/dev/project/.kangentic/sessions/s/status.json' });

    await performSpawn(input, context);

    expect(context.loadEarlierRuns).toHaveBeenCalledOnce();
    expect(context.loadEarlierRuns).toHaveBeenCalledWith(input.id);
    expect(rowRegistered).toBe(true);
    expect(order.indexOf('loadEarlierRuns')).toBe(order.indexOf('initSession') + 1);
    expect(order.indexOf('loadEarlierRuns')).toBeLessThan(order.indexOf('statusFileReader.attach'));
  });
});

describe('performSpawn - cols/rows precedence', () => {
  // Pins the precedence chain documented at session-spawn-flow.ts lines
  // 167-192: takePendingResize's stashed grid wins over a caller-supplied
  // input.cols/rows, which in turn wins over the DEFAULT_PTY_COLS/ROWS
  // fallback. Also pins the clamp applied to input.cols/rows (mirroring
  // SessionManager.resize's clamp) before the value can reach pty.spawn.
  //
  // Pending grid (200x60) and input grid (100x40) are chosen to be
  // distinguishable from each other AND from the 120x30 default, so a test
  // asserting the wrong value in the chain cannot pass by accident.
  //
  // Red-green: for each case, the corresponding source line in
  // session-spawn-flow.ts was temporarily reverted (see the report), the
  // test observed red, and the source was restored to observe green.
  //
  // Tier: Unit - pure mock collaborators, no PTY, no OS, no IPC.

  const ptySpawnMock = ptyModule.spawn as ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('case (a): uses input.cols/rows when set and no pendingResize is stashed', async () => {
    const context = makeContext();
    const input = makeInput({ cols: 100, rows: 40 });

    await performSpawn(input, context);

    expect(ptySpawnMock).toHaveBeenCalledOnce();
    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(100);
    expect(spawnOptions.rows).toBe(40);
  });

  it('case (b): a stashed pendingResize wins over input.cols/rows when both are present', async () => {
    const context = makeContext();
    (context.takePendingResize as ReturnType<typeof vi.fn>).mockReturnValue({ cols: 200, rows: 60 });
    const input = makeInput({ cols: 100, rows: 40 });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(200);
    expect(spawnOptions.rows).toBe(60);
  });

  it('case (c): falls back to DEFAULT_PTY_COLS/ROWS when neither pendingResize nor input.cols/rows is set', async () => {
    const context = makeContext();
    const input = makeInput();

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(DEFAULT_PTY_COLS);
    expect(spawnOptions.rows).toBe(DEFAULT_PTY_ROWS);
  });

  describe('the grid inherited from the row a respawn replaces', () => {
    const INHERITED = { cols: 190, rows: 50 };

    function contextWithPredecessor(): SpawnFlowContext {
      const context = makeContext();
      context.registry.set('predecessor-id', {
        id: 'predecessor-id',
        taskId: 'task-001',
        projectId: 'project-001',
        pty: null,
        status: 'suspended',
      } as never);
      context.inheritedGrid = vi.fn(() => INHERITED);
      return context;
    }

    function spawnGrid(): [number, number] {
      const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
      return [spawnOptions.cols, spawnOptions.rows];
    }

    it('case (f): beats the default when nothing else names a grid, and is asked about the predecessor', async () => {
      const context = contextWithPredecessor();

      await performSpawn(makeInput(), context);

      expect(spawnGrid()).toEqual([190, 50]);
      expect(context.inheritedGrid).toHaveBeenCalledWith(expect.objectContaining({ id: 'predecessor-id' }));
    });

    it('case (g): a caller-supplied grid and a stashed resize both win over it', async () => {
      const callerContext = contextWithPredecessor();
      await performSpawn(makeInput({ cols: 100, rows: 40 }), callerContext);
      expect(spawnGrid()).toEqual([100, 40]);

      ptySpawnMock.mockClear();
      const stashContext = contextWithPredecessor();
      (stashContext.takePendingResize as ReturnType<typeof vi.fn>).mockReturnValue({ cols: 200, rows: 60 });
      await performSpawn(makeInput(), stashContext);
      expect(spawnGrid()).toEqual([200, 60]);
    });

    it('case (h): a queue promotion never inherits from its own placeholder', async () => {
      const context = makeContext();
      context.registry.set('input-session-id-0000-000000000000', {
        id: 'input-session-id-0000-000000000000',
        taskId: 'task-001',
        projectId: 'project-001',
        pty: null,
        status: 'queued',
      } as never);
      context.inheritedGrid = vi.fn(() => INHERITED);

      await performSpawn(makeInput(), context);

      expect(context.inheritedGrid).not.toHaveBeenCalled();
      expect(spawnGrid()).toEqual([DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS]);
    });

    it('case (j): a restored grid applies only when nothing above it names one', async () => {
      const restored = { cols: 210, rows: 48 };

      // No predecessor: the restored grid, as vetted by the caller's policy.
      const bare = makeContext();
      bare.restoredGrid = vi.fn((grid: { cols: number; rows: number }) => grid);
      await performSpawn(makeInput({ restoredGrid: restored }), bare);
      expect(spawnGrid()).toEqual([210, 48]);
      expect(bare.restoredGrid).toHaveBeenCalledWith(restored);

      // An inherited grid wins over it.
      ptySpawnMock.mockClear();
      const withPredecessor = contextWithPredecessor();
      withPredecessor.restoredGrid = vi.fn((grid: { cols: number; rows: number }) => grid);
      await performSpawn(makeInput({ restoredGrid: restored }), withPredecessor);
      expect(spawnGrid()).toEqual([190, 50]);

      // A policy that refuses it, or a context without one, leaves the default.
      ptySpawnMock.mockClear();
      const refusing = makeContext();
      refusing.restoredGrid = vi.fn(() => undefined);
      await performSpawn(makeInput({ restoredGrid: restored }), refusing);
      expect(spawnGrid()).toEqual([DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS]);

      ptySpawnMock.mockClear();
      await performSpawn(makeInput({ restoredGrid: restored }), makeContext());
      expect(spawnGrid()).toEqual([DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS]);
    });

    it('case (i): the new row records its spawn grid for its own successor', async () => {
      const context = contextWithPredecessor();

      await performSpawn(makeInput(), context);

      expect(context.registry.get('input-session-id-0000-000000000000')?.lastPtyGrid).toEqual(INHERITED);
    });

    it('case (k): forgets the grids kept for the row a respawn replaces, never a promotion\'s own', async () => {
      // A new-id respawn replaces the predecessor and nothing reads its stash,
      // desktop restore target or pending park again, so they are dropped.
      const respawn = contextWithPredecessor();
      respawn.forgetSessionGrid = vi.fn();
      await performSpawn(makeInput(), respawn);
      expect(respawn.forgetSessionGrid).toHaveBeenCalledTimes(1);
      expect(respawn.forgetSessionGrid).toHaveBeenCalledWith('predecessor-id');

      // A queue promotion keeps its id, so what the placeholder holds (the
      // desktop's restore target above all) belongs to the session being born.
      ptySpawnMock.mockClear();
      const promotion = makeContext();
      promotion.registry.set('input-session-id-0000-000000000000', {
        id: 'input-session-id-0000-000000000000',
        taskId: 'task-001',
        projectId: 'project-001',
        pty: null,
        status: 'queued',
      } as never);
      promotion.forgetSessionGrid = vi.fn();
      await performSpawn(makeInput(), promotion);
      expect(promotion.forgetSessionGrid).not.toHaveBeenCalled();
    });
  });

  it('case (d): takePendingResize is consumed exactly once, unconditionally, keyed on the resolved session id', async () => {
    // Pins the "called unconditionally" invariant documented at line 176-177:
    // the pending entry must be consumed even when input.cols/rows also
    // applies, never gated behind an `if (input.cols === undefined)` check.
    const context = makeContext();
    const input = makeInput({ cols: 100, rows: 40 });

    await performSpawn(input, context);

    expect(context.takePendingResize).toHaveBeenCalledTimes(1);
    expect(context.takePendingResize).toHaveBeenCalledWith(input.id);
  });

  it('case (e1): clamps input.cols=0 to the minimum of 2', async () => {
    const context = makeContext();
    const input = makeInput({ cols: 0, rows: 40 });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(2);
    expect(spawnOptions.rows).toBe(40);
  });

  it('case (e2): clamps input.rows=0 to the minimum of 1', async () => {
    const context = makeContext();
    const input = makeInput({ cols: 100, rows: 0 });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(100);
    expect(spawnOptions.rows).toBe(1);
  });

  it('case (e3): a non-finite input.cols (NaN) is treated as absent and falls through to DEFAULT_PTY_COLS', async () => {
    const context = makeContext();
    const input = makeInput({ cols: NaN, rows: 40 });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(DEFAULT_PTY_COLS);
    expect(spawnOptions.rows).toBe(40);
  });

  it('case (e4): floors a non-integer input.cols (100.7) to 100', async () => {
    const context = makeContext();
    const input = makeInput({ cols: 100.7, rows: 40 });

    await performSpawn(input, context);

    const spawnOptions = ptySpawnMock.mock.calls[0]?.[2] as { cols: number; rows: number };
    expect(spawnOptions.cols).toBe(100);
    expect(spawnOptions.rows).toBe(40);
  });
});

describe('performSpawn - a resize stashed while the spawn waits on the host', () => {
  // A queue promotion keeps its id, and its placeholder row stays 'queued' with
  // no PTY through the host round trip. takePendingResize has already run by
  // then, so a resize that reaches the placeholder in that window (a renderer
  // fit, or a phone's subscribe-time park) is stashed for a spawn that will
  // never read it. discardPendingResize drops it once the live row exists, so
  // it cannot outlive the PTY and outrank the PTY's real grid later.
  //
  // Tier: Unit - the SessionManager end of this (the orphan reaching
  // successorGridFor) is pinned in session-manager.test.ts, 'Respawn grid'.

  const PLACEHOLDER_ID = 'input-session-id-0000-000000000000';

  function contextWithQueuedPlaceholder(): SpawnFlowContext {
    const context = makeContext();
    context.registry.set(PLACEHOLDER_ID, {
      id: PLACEHOLDER_ID,
      taskId: 'task-001',
      projectId: 'project-001',
      pty: null,
      status: 'queued',
    } as never);
    return context;
  }

  it('discards the stash under the spawn id, after the registry holds the live row', async () => {
    const context = contextWithQueuedPlaceholder();
    const statusWhenDiscarded: Array<string | undefined> = [];
    context.discardPendingResize = vi.fn((sessionId: string) => {
      statusWhenDiscarded.push(context.registry.get(sessionId)?.status);
    });

    await performSpawn(makeInput(), context);

    expect(context.discardPendingResize).toHaveBeenCalledTimes(1);
    expect(context.discardPendingResize).toHaveBeenCalledWith(PLACEHOLDER_ID);
    // Any other status (or no row at all) would mean the discard ran before
    // the live row replaced the placeholder, i.e. before the window it exists
    // to close had ended.
    expect(statusWhenDiscarded).toEqual(['running']);
  });
});

describe('performSpawn - onExit fallback ordering: branch-pushed before pr-candidate', () => {
  // The onExit handler emits the pushed-branch fallback immediately BEFORE the
  // PR-candidate fallback, with a comment claiming this is deliberate: both
  // land on the same per-task queue (recordPushedBranchForSession runs
  // synchronously up to its `await withTaskLock`), so the branch-pushed
  // listener enqueues before the pr-candidate listener's resolve can run.
  //
  // Every other test in this file (and in session-exit-intentional.test.ts)
  // stubs takePendingPushedBranch to null and/or hasPendingPRCommand to
  // false, so neither fallback branch executes and swapping the two blocks
  // in session-spawn-flow.ts would pass every one of them. This test makes
  // BOTH preconditions true and asserts the OBSERVED emit order, not merely
  // that each mock was called.
  //
  // Red-green: swapped the two emit blocks in session-spawn-flow.ts (emitting
  // 'pr-candidate' before consuming/emitting the pending pushed branch) -
  // this test went red (branchPushedIndex > prCandidateIndex); restored the
  // source order - green again.
  //
  // Tier: Unit - pure mock collaborators, no PTY, no OS, no IPC.

  beforeEach(() => {
    ptyExitHarness.onExitCallback = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits branch-pushed before pr-candidate when both are pending at PTY exit', async () => {
    const context = makeContext();
    (context.telemetry.takePendingPushedBranch as ReturnType<typeof vi.fn>).mockReturnValue('feature/pending-branch');
    (context.telemetry.hasPendingPRCommand as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const input = makeInput();
    await performSpawn(input, context);
    seedRing(context, input.id!, 'scrollback bytes');

    expect(ptyExitHarness.onExitCallback).toBeTypeOf('function');
    ptyExitHarness.onExitCallback!({ exitCode: 0 });
    // The PR fallback reads the ring from the host before it emits, and that
    // read takes however many turns the host round trip takes. Wait for the
    // emit itself (the later of the two events) instead of counting microtask
    // turns, which is a guess about the transport's depth.
    const emitMock = context.emit as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(emitMock.mock.calls.map((call) => call[0] as string)).toContain('pr-candidate');
    });
    const eventOrder = emitMock.mock.calls.map((call) => call[0] as string);
    const branchPushedIndex = eventOrder.indexOf('branch-pushed');
    const prCandidateIndex = eventOrder.indexOf('pr-candidate');

    // Both fallbacks must actually have fired (the preconditions were set up
    // to make both true) ...
    expect(branchPushedIndex).toBeGreaterThanOrEqual(0);
    expect(prCandidateIndex).toBeGreaterThanOrEqual(0);
    // ... and branch-pushed must land on the queue first.
    expect(branchPushedIndex).toBeLessThan(prCandidateIndex);

    expect(emitMock.mock.calls[branchPushedIndex]).toEqual(['branch-pushed', input.id, 'feature/pending-branch']);
    expect(emitMock.mock.calls[prCandidateIndex]).toEqual(['pr-candidate', input.id, 'scrollback bytes']);
  });
});

describe('performSpawn - shutdown begins during the host round trip', () => {
  // The quit can start while `host.spawn` is in flight. killAll() ran before the
  // registry had a row for this session, so nothing else would end the PTY the
  // host just started, and the host's own shutdown kills no session PTY.
  //
  // Red-green: drop the `spawnOutcome.ok && isShuttingDown()` block after the
  // await in session-spawn-flow.ts and this goes red three ways: the spawn
  // resolves instead of rejecting, safeKillPty is never called for the new PTY,
  // and the registry gains a row for a session nothing will ever end.
  //
  // Tier: Unit - the host is the in-process core over a mocked node-pty.

  beforeEach(() => {
    // Sibling blocks above also reach safeKillPty; count only this block's calls.
    vi.mocked(safeKillPty).mockClear();
  });

  afterEach(() => {
    shutdownState.shuttingDown = false;
    vi.clearAllMocks();
  });

  it('kills the PTY the host just started and refuses the spawn', async () => {
    const context = makeContext();
    const input = makeInput();
    const spawnThroughHost = PtyHostClient.prototype.spawn.bind(context.host);
    vi.mocked(context.host.spawn).mockImplementationOnce(async (params) => {
      const outcome = await spawnThroughHost(params);
      // The quit begins while the round trip is in flight.
      shutdownState.shuttingDown = true;
      return outcome;
    });

    await expect(performSpawn(input, context)).rejects.toThrow('Cannot spawn session during shutdown');

    // Control: the host really did start a PTY, and performSpawn went through
    // the awaited call (a spawn refused up front would never reach it).
    expect(context.host.spawn).toHaveBeenCalledTimes(1);
    const startedOutcome = await vi.mocked(context.host.spawn).mock.results[0].value;
    expect(startedOutcome.ok).toBe(true);

    // The one kill is for that very PTY (identity, not structure).
    expect(safeKillPty).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safeKillPty).mock.calls[0][0]).toBe(startedOutcome.pty);

    // No row and no announcement for a session that never lived.
    expect(context.registry.get(input.id!)).toBeUndefined();
    const emittedEvents = vi.mocked(context.emit).mock.calls.map((call) => call[0]);
    expect(emittedEvents).not.toContain('session-changed');
  });

  it('does not refuse or kill when the quit has not begun by the time the host answers', async () => {
    const context = makeContext();
    const input = makeInput();

    const session = await performSpawn(input, context);

    expect(session.id).toBe(input.id);
    expect(safeKillPty).not.toHaveBeenCalled();
    expect(context.registry.get(input.id!)).toBeDefined();
  });
});
