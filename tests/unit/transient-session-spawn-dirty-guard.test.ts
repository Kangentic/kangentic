/**
 * Unit tests for `startCommandTerminal` and its checkout policy
 * (`checkOutStartBranch`, src/main/ipc/handlers/transient-sessions.ts). The
 * SESSION_SPAWN_TRANSIENT handler is a thin caller of it, so most cases drive
 * the handler.
 *
 * A Command Terminal's cold spawn checks out the project's default base branch
 * with no user gesture behind it beyond opening a terminal, and a plain
 * `git checkout` carries non-conflicting uncommitted changes onto that branch
 * silently. The start therefore STAYS PUT when the tree has modifications to
 * tracked files and no branch was picked explicitly, reports it through the
 * same `checkoutError` the renderer already toasts, and skips the ff-merge that
 * would otherwise fast-forward the wrong branch. An explicit picker choice keeps
 * git's own behavior. The target itself resolves the board-shared default
 * ahead of the config default (resolveProjectDefaultBaseBranch), the same chain
 * the renderer's pill and every task spawn use.
 *
 * Mocking pattern follows transient-session-spawn-ensure-trust.test.ts (same
 * handler, same capturedHandlers + mocked IpcContext shape).
 *
 * Red-green: dropping the tracked-changes probe fails the stay-put case;
 * running the merge on the stay-put path fails the no-merge assertion; reading
 * `config.git.defaultBaseBranch` directly fails the board-default case.
 *
 * The handler and a phone's `command-terminal` start share `startCommandTerminal`,
 * so this file also covers what both rely on: main owns the 4-per-project cap and
 * the slot allocation (with a reservation so two starts in flight cannot share
 * a slot), and an unattended start runs the desktop's steps made unable to
 * block: a non-interactive fetch with a deadline, one budget for the git phase,
 * and no checkout under another live agent in the project folder.
 *
 * Red-green for those: a task agent in `<root>/.kangentic/worktrees/<slug>` does
 * not share the root (fails if `normalizeComparablePath` maps it through
 * `resolveProjectRoot` again); the win32 case fold is exercised on every OS by
 * stubbing `process.platform` (fails if the fold is dropped or made unconditional);
 * the slot check refuses anything outside `slot-1`..`slot-4` and reserves nothing
 * when it does; the cap counts the union of live slots and reservations plus
 * slotless rows, so a row registered under its own reservation counts once (fails
 * if the two are summed); the 6 s budget is checked before the checkout and before
 * the merge (each fails if its `pastDeadline()` guard is removed); and the adapter's
 * exit sequence reaches the spawn, with Ctrl+C as the fallback.
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

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-transient-task-id') }));

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

interface MockStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

const gitRevparseMock = vi.fn(async () => 'main\n');
const gitStatusMock = vi.fn(async (): Promise<{ files: MockStatusFile[] }> => ({ files: [] }));
const gitCheckoutMock = vi.fn(async () => undefined);
const gitMergeMock = vi.fn(async () => undefined);
vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    revparse: gitRevparseMock,
    status: gitStatusMock,
    checkout: gitCheckoutMock,
    merge: gitMergeMock,
  })),
}));

// Hoisted: the factory below reads it at module-mock time, before a plain
// module-level const would be initialized (the simple-git mock above gets away
// with plain consts only because its references sit inside a lazily-called
// arrow function).
const { fetchIfStaleMock } = vi.hoisted(() => ({
  fetchIfStaleMock: vi.fn(async (_git: unknown, _projectPath: string, branch: string) => `origin/${branch}`),
}));
vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: fetchIfStaleMock,
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
}));

// `shared/git-utils` is deliberately NOT mocked. Its real `resolveProjectRoot`
// maps `<root>/.kangentic/worktrees/<slug>` to `<root>`, and the worktree cases
// below only fail when `normalizeComparablePath` goes back to calling it if that
// mapping is really present. An identity stub would let that revert pass.

const mockAgentRegistryGetOrThrow = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: (name: string) => mockAgentRegistryGetOrThrow(name),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import {
  clearCommandTerminalReservations,
  registerTransientSessionHandlers,
  startCommandTerminal,
} from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';
import type { SpawnTransientSessionInput } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = 'C:/Users/dev/proj';

interface SpawnResult {
  session: { id: string };
  branch: string;
  checkoutError?: string;
}

interface MockContext {
  currentProjectId: string | null;
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: { getDefaultBaseBranchForPath: ReturnType<typeof vi.fn> };
  mcpServerHandle: null;
  sessionManager: { spawn: ReturnType<typeof vi.fn>; getShell: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> };
}

function createMockContext(options?: { boardDefault?: string; configDefault?: string }): MockContext {
  return {
    currentProjectId: 'proj-1',
    projectRepo: {
      getById: vi.fn(() => ({
        id: 'proj-1',
        path: PROJECT_ROOT,
        default_agent: 'claude',
        default_model: null,
        default_effort: null,
      })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { cliPaths: {}, permissionMode: 'default' },
        git: { worktreesEnabled: false, defaultBaseBranch: options?.configDefault ?? 'main' },
        mcpServer: { enabled: false },
      })),
    },
    boardConfigManager: {
      getDefaultBaseBranchForPath: vi.fn(() => options?.boardDefault),
    },
    mcpServerHandle: null,
    sessionManager: {
      spawn: vi.fn(async () => ({ id: 'session-1' })),
      getShell: vi.fn(async () => 'bash'),
      // No live terminals: the slot allocation (startCommandTerminal) reads it.
      listSessions: vi.fn(() => []),
    },
  };
}

async function callSpawnHandler(input: SpawnTransientSessionInput): Promise<SpawnResult> {
  const handler = capturedHandlers.get(IPC.SESSION_SPAWN_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_SPAWN_TRANSIENT} was not registered`);
  return (await handler(null, input)) as SpawnResult;
}

/** Register the handler against a fresh context; returns that context. */
function registerWith(options?: { boardDefault?: string; configDefault?: string }): MockContext {
  const context = createMockContext(options);
  registerTransientSessionHandlers(context as never);
  return context;
}

/**
 * Make the NEXT spawn on `context` hang until `finish()` is called. That keeps a
 * start in flight (its slot reserved, its `finally` not yet run) for as long as a
 * test needs, deterministically: the start cannot reach its `finally` before the
 * test lets it. `onSpawn` runs as the spawn is reached, which is the moment a real
 * spawn has just put its row in the registry. `reached` settles at that moment.
 */
function holdNextSpawn(context: MockContext, onSpawn?: () => void): { reached: Promise<void>; finish: () => void } {
  let resolveSpawn: ((spawned: { id: string }) => void) | null = null;
  const reached = new Promise<void>((resolveReached) => {
    context.sessionManager.spawn.mockImplementationOnce(() => {
      onSpawn?.();
      resolveReached();
      return new Promise<{ id: string }>((resolve) => { resolveSpawn = resolve; });
    });
  });
  return { reached, finish: () => resolveSpawn?.({ id: 'held-session' }) };
}

/** Freeze `Date.now()` so a test can spend the git budget at an exact step. */
function freezeClock(): { advance: (milliseconds: number) => void; restore: () => void } {
  let now = 1_000_000;
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance: (milliseconds: number) => { now += milliseconds; },
    restore: () => nowSpy.mockRestore(),
  };
}

/** Run `body` with `process.platform` reading as `platform`, restoring it even when `body` throws. */
async function withPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await body();
  } finally {
    if (originalDescriptor) Object.defineProperty(process, 'platform', originalDescriptor);
    else Reflect.deleteProperty(process, 'platform');
  }
}

const TRACKED_MODIFICATION: MockStatusFile = { path: 'src/index.ts', index: ' ', working_dir: 'M' };
const UNTRACKED_FILE: MockStatusFile = { path: 'scratch.txt', index: '?', working_dir: '?' };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_SPAWN_TRANSIENT handler: cold-spawn checkout policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    gitRevparseMock.mockResolvedValue('main\n');
    gitStatusMock.mockResolvedValue({ files: [] });
    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '1.0.0' })),
      ensureTrust: vi.fn(async () => {}),
      buildCommand: vi.fn(() => 'claude'),
    });
  });

  it('stays on the current branch, skips the ff-merge, and says so when tracked files are modified and no branch was picked', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('feature/wip\n');
    gitStatusMock.mockResolvedValue({ files: [TRACKED_MODIFICATION, UNTRACKED_FILE] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(gitCheckoutMock).not.toHaveBeenCalled();
    // The merge target is origin/main; running it while HEAD is feature/wip
    // would fast-forward the wrong branch.
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('feature/wip');
    expect(result.checkoutError).toBe(
      'Staying on "feature/wip": the working tree has uncommitted changes, so this terminal did not switch to "main".',
    );
    // The spawn still happens: the terminal is useful on the branch it is on.
    expect(gitStatusMock).toHaveBeenCalledTimes(1);
  });

  it('checks out the default when the only changes are untracked files', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('feature/wip\n');
    gitStatusMock.mockResolvedValue({ files: [UNTRACKED_FILE] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(gitMergeMock).toHaveBeenCalledWith(['origin/main', '--ff-only']);
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });

  it('never probes the tree, and checks out anyway, when the branch was picked explicitly', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('feature/wip\n');
    gitStatusMock.mockResolvedValue({ files: [TRACKED_MODIFICATION] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1', branch: 'develop' });

    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitCheckoutMock).toHaveBeenCalledWith('develop');
    expect(result.branch).toBe('develop');
    expect(result.checkoutError).toBeUndefined();
  });

  it('never probes the tree when HEAD is already on the target', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('main\n');
    gitStatusMock.mockResolvedValue({ files: [TRACKED_MODIFICATION] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });

  it('resolves the target from the board-shared default ahead of the config default', async () => {
    const context = registerWith({ boardDefault: 'develop', configDefault: 'main' });
    gitRevparseMock.mockResolvedValue('main\n');

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(context.boardConfigManager.getDefaultBaseBranchForPath).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(fetchIfStaleMock).toHaveBeenCalledWith(expect.anything(), PROJECT_ROOT, 'develop');
    expect(gitCheckoutMock).toHaveBeenCalledWith('develop');
    expect(result.branch).toBe('develop');
  });

  it('falls back to the config default, then main, when no board default is set', async () => {
    registerWith({ configDefault: 'trunk' });
    gitRevparseMock.mockResolvedValue('trunk\n');

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(fetchIfStaleMock).toHaveBeenCalledWith(expect.anything(), PROJECT_ROOT, 'trunk');
    expect(result.branch).toBe('trunk');
  });

  it('refuses a start from the desktop layer while no project is open', async () => {
    const context = createMockContext();
    context.currentProjectId = null;
    registerTransientSessionHandlers(context as never);

    await expect(callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' })).rejects.toThrow(/no project is currently open/);
  });
});

/** A live Command Terminal row, as `listSessions()` reports it. */
function liveTerminal(slot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `term-${slot}`, projectId: 'proj-1', transient: true, status: 'running', cwd: PROJECT_ROOT, commandTerminalSlot: slot, ...overrides };
}

/** A live Command Terminal row that has no slot recorded (one spawned before slots existed). */
function slotlessTerminal(id: string): Record<string, unknown> {
  return { id, projectId: 'proj-1', transient: true, status: 'running', cwd: PROJECT_ROOT };
}

/** A live task agent row (not transient), as `listSessions()` reports it. */
function liveTaskSession(cwd: string): Record<string, unknown> {
  return { id: 'task-session-1', projectId: 'proj-1', transient: false, status: 'running', cwd };
}

describe('startCommandTerminal: main owns the cap and the slots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCommandTerminalReservations();
    gitRevparseMock.mockResolvedValue('main\n');
    gitStatusMock.mockResolvedValue({ files: [] });
    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '1.0.0' })),
      ensureTrust: vi.fn(async () => {}),
      buildCommand: vi.fn(() => 'claude'),
    });
  });

  it('works with no project open: a phone names the project it means', async () => {
    const context = createMockContext();
    context.currentProjectId = null;

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(result.slot).toBe('slot-1');
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', commandTerminalSlot: 'slot-1', transient: true }));
  });

  it('takes the lowest free slot when none is asked for, skipping live terminals in this project only', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([
      liveTerminal('slot-1'),
      liveTerminal('slot-3'),
      liveTerminal('slot-2', { projectId: 'proj-OTHER' }),
    ]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(result.slot).toBe('slot-2');
  });

  it('honors a requested slot that is free', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1')]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', slot: 'slot-3' });

    expect(result.slot).toBe('slot-3');
  });

  it('refuses a requested slot a live terminal already holds, before any git work', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-2')]);

    await expect(startCommandTerminal(context as never, { projectId: 'proj-1', slot: 'slot-2' }))
      .rejects.toMatchObject({ code: 'slot-taken' });
    expect(fetchIfStaleMock).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('refuses the fifth terminal with the limit code', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue(['slot-1', 'slot-2', 'slot-3', 'slot-4'].map((slot) => liveTerminal(slot)));

    await expect(startCommandTerminal(context as never, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: 'command-terminal-limit' });
  });

  it.each(['slot-1', 'slot-4'])('honors the boundary slot %s', async (slot) => {
    const context = createMockContext();

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', slot });

    expect(result.slot).toBe(slot);
  });

  it.each(['slot-9', 'slot-0', 'slot-5', 'x', 'slot-01'])('refuses the requested slot %s as not a Command Terminal slot, before any git or spawn work', async (slot) => {
    const context = createMockContext();

    await expect(startCommandTerminal(context as never, { projectId: 'proj-1', slot }))
      .rejects.toThrow('Not a Command Terminal slot');
    expect(fetchIfStaleMock).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('reserves nothing when it refuses a bad slot', async () => {
    const context = createMockContext();

    // Four distinct refusals: had each one reserved the slot it was refused for,
    // the reservations alone would fill the cap and the start below would fail.
    for (const slot of ['slot-9', 'slot-0', 'slot-5', 'x']) {
      await expect(startCommandTerminal(context as never, { projectId: 'proj-1', slot }))
        .rejects.toThrow('Not a Command Terminal slot');
    }
    const result = await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(result.slot).toBe('slot-1');
  });

  it.each([
    { label: 'omitted', slot: undefined },
    { label: 'empty', slot: '' },
  ])('treats an $label slot as no request and allocates the lowest free slot', async ({ slot }) => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1')]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', slot });

    expect(result.slot).toBe('slot-2');
  });

  it('counts a start in flight toward the cap: three live terminals plus one reserving start refuse the next', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue(['slot-1', 'slot-2', 'slot-3'].map((slot) => liveTerminal(slot)));
    const held = holdNextSpawn(context);

    const inFlight = startCommandTerminal(context as never, { projectId: 'proj-1' });
    await held.reached;

    await expect(startCommandTerminal(context as never, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: 'command-terminal-limit' });

    held.finish();
    expect((await inFlight).slot).toBe('slot-4');
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses a second start that asks for the slot an in-flight start reserved', async () => {
    const context = createMockContext();
    const held = holdNextSpawn(context);

    const inFlight = startCommandTerminal(context as never, { projectId: 'proj-1', slot: 'slot-2' });
    await held.reached;

    await expect(startCommandTerminal(context as never, { projectId: 'proj-1', slot: 'slot-2' }))
      .rejects.toMatchObject({ code: 'slot-taken' });
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);

    held.finish();
    expect((await inFlight).slot).toBe('slot-2');
  });

  it('keeps one project\'s in-flight reservation out of another project\'s allocation', async () => {
    const context = createMockContext();
    const held = holdNextSpawn(context);

    const otherProjectStart = startCommandTerminal(context as never, { projectId: 'proj-OTHER' });
    await held.reached;
    const result = await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(result.slot).toBe('slot-1');
    held.finish();
    expect((await otherProjectStart).slot).toBe('slot-1');
  });

  it('does not count an exited terminal toward the cap', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([
      liveTerminal('slot-1', { status: 'exited' }),
      liveTerminal('slot-2'),
      liveTerminal('slot-3'),
      liveTerminal('slot-4'),
    ]);

    // Four rows but three live: the cap admits one more, into the slot the
    // exited row no longer holds.
    const result = await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(result.slot).toBe('slot-1');
  });

  it('lets a start ask for the slot an exited terminal held', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1', { status: 'exited' })]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', slot: 'slot-1' });

    expect(result.slot).toBe('slot-1');
  });

  it('counts a start whose row has registered but whose reservation is not yet released once, not twice', async () => {
    const context = createMockContext();
    const otherTerminals = [liveTerminal('slot-2'), liveTerminal('slot-3')];
    context.sessionManager.listSessions.mockReturnValue(otherTerminals);
    // The first start takes slot-1. Its spawn registers the row (the registry now
    // lists slot-1) and then hangs, which holds the start between registration and
    // the `finally` that releases its reservation: slot-1 is a live row AND a
    // reservation at once.
    const held = holdNextSpawn(context, () => {
      context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1'), ...otherTerminals]);
    });
    const first = startCommandTerminal(context as never, { projectId: 'proj-1' });
    await held.reached;

    // Three distinct slots are held (1, 2, 3), so a fourth terminal fits. Summing
    // the rows and the reservations would count slot-1 twice and refuse it.
    const fourth = await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(fourth.slot).toBe('slot-4');
    held.finish();
    expect((await first).slot).toBe('slot-1');
  });

  it('counts live terminals with no slot toward the cap, beside slotted ones', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([
      liveTerminal('slot-1'),
      liveTerminal('slot-2'),
      slotlessTerminal('legacy-a'),
      slotlessTerminal('legacy-b'),
    ]);

    await expect(startCommandTerminal(context as never, { projectId: 'proj-1' }))
      .rejects.toMatchObject({ code: 'command-terminal-limit' });
  });

  it('gives a slotless terminal no slot of its own: three of them leave room for one start, in slot-1', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([
      slotlessTerminal('legacy-a'),
      slotlessTerminal('legacy-b'),
      slotlessTerminal('legacy-c'),
    ]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(result.slot).toBe('slot-1');
  });

  it('passes the adapter\'s exit sequence to the spawn', async () => {
    const context = createMockContext();
    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '1.0.0' })),
      ensureTrust: vi.fn(async () => {}),
      buildCommand: vi.fn(() => 'claude'),
      getExitSequence: vi.fn(() => ['/exit\r']),
    });

    await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ exitSequence: ['/exit\r'] }));
  });

  it('falls back to Ctrl+C as the exit sequence when the adapter has none', async () => {
    const context = createMockContext();

    await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ exitSequence: ['\x03'] }));
  });

  it('refuses an unknown project with its code', async () => {
    const context = createMockContext();
    context.projectRepo.getById.mockReturnValue(undefined);

    await expect(startCommandTerminal(context as never, { projectId: 'ghost' }))
      .rejects.toMatchObject({ code: 'unknown-project' });
  });

  it('never gives two starts in flight the same slot, and frees a failed start\'s slot', async () => {
    const context = createMockContext();
    let releaseFirstSpawn!: () => void;
    context.sessionManager.spawn
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirstSpawn = () => resolve({ id: 'first' }); }))
      .mockImplementationOnce(async () => { throw new Error('spawn failed'); });

    const first = startCommandTerminal(context as never, { projectId: 'proj-1' });
    const second = startCommandTerminal(context as never, { projectId: 'proj-1' });
    await expect(second).rejects.toThrow('spawn failed');
    await vi.waitFor(() => expect(releaseFirstSpawn).toBeTypeOf('function'));
    releaseFirstSpawn();
    expect((await first).slot).toBe('slot-1');

    const slotsAsked = context.sessionManager.spawn.mock.calls.map(([input]) => (input as { commandTerminalSlot: string }).commandTerminalSlot);
    expect(slotsAsked).toEqual(['slot-1', 'slot-2']);

    // Both reservations are released: with the registry still empty, the next
    // start takes slot-1 again.
    context.sessionManager.spawn.mockResolvedValue({ id: 'third' });
    expect((await startCommandTerminal(context as never, { projectId: 'proj-1' })).slot).toBe('slot-1');
  });
});

describe('startCommandTerminal: an unattended (phone) start always launches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCommandTerminalReservations();
    gitRevparseMock.mockResolvedValue('feature/live\n');
    gitStatusMock.mockResolvedValue({ files: [] });
    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '1.0.0' })),
      ensureTrust: vi.fn(async () => {}),
      buildCommand: vi.fn(() => 'claude'),
    });
  });

  it('checks out the default branch like the desktop New does when the folder is not shared', async () => {
    const context = createMockContext();

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(result.branch).toBe('main');
  });

  it('fetches non-interactively, with a deadline, so no credential prompt waits on an empty desk', async () => {
    const context = createMockContext();

    await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(fetchIfStaleMock).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ROOT,
      'main',
      expect.objectContaining({ nonInteractive: true, signal: expect.any(AbortSignal) }),
    );
  });

  it('stays put, and still launches, when another live agent works in the project folder', async () => {
    const context = createMockContext();
    // A sibling terminal on a feature branch; on Windows its cwd may differ in case.
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1', { cwd: PROJECT_ROOT.toUpperCase() })]);
    const caseInsensitive = process.platform === 'win32';
    if (!caseInsensitive) context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1')]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(fetchIfStaleMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('feature/live');
    expect(result.checkoutError).toMatch(/another agent is running in the project folder/);
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('a desktop start keeps its own behavior beside a sibling: it checks out as before', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1')]);

    await startCommandTerminal(context as never, { projectId: 'proj-1' });

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
  });

  it('a failed checkout falls back to the current branch and still launches', async () => {
    const context = createMockContext();
    gitCheckoutMock.mockRejectedValueOnce(new Error('cannot lock ref'));

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(result.branch).toBe('feature/live');
    expect(result.checkoutError).toMatch(/Could not switch to "main"/);
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('skips the remaining git steps once the git budget is spent, and launches on the current branch', async () => {
    const context = createMockContext();
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    // The fetch took long enough to spend the whole budget.
    fetchIfStaleMock.mockImplementationOnce(async (_git: unknown, _projectPath: string, branch: string) => {
      now += 10_000;
      return `origin/${branch}`;
    });
    try {
      const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

      expect(gitStatusMock).not.toHaveBeenCalled();
      expect(gitCheckoutMock).not.toHaveBeenCalled();
      expect(result.branch).toBe('feature/live');
      expect(result.checkoutError).toMatch(/git took too long/);
      expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('skips the checkout, and says git took too long, when the budget is spent inside the dirty-tree probe', async () => {
    const context = createMockContext();
    const clock = freezeClock();
    // Nothing is past the deadline when the probe starts; the probe itself spends it.
    gitStatusMock.mockImplementationOnce(async () => {
      clock.advance(10_000);
      return { files: [] };
    });
    try {
      const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

      expect(gitStatusMock).toHaveBeenCalledTimes(1);
      expect(gitCheckoutMock).not.toHaveBeenCalled();
      expect(gitMergeMock).not.toHaveBeenCalled();
      expect(result.branch).toBe('feature/live');
      expect(result.checkoutError).toMatch(/git took too long/);
      expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
    } finally {
      clock.restore();
    }
  });

  it('skips the fast-forward merge when the budget is spent during the checkout, without cutting the checkout short', async () => {
    const context = createMockContext();
    const clock = freezeClock();
    gitCheckoutMock.mockImplementationOnce(async () => {
      clock.advance(10_000);
      return undefined;
    });
    try {
      const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

      // The checkout was already running, so it finished: the terminal is on main.
      expect(gitCheckoutMock).toHaveBeenCalledWith('main');
      expect(gitMergeMock).not.toHaveBeenCalled();
      expect(result.branch).toBe('main');
      expect(result.checkoutError).toBeUndefined();
    } finally {
      clock.restore();
    }
  });

  it('fast-forwards after the checkout while the budget holds', async () => {
    const context = createMockContext();

    await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(gitMergeMock).toHaveBeenCalledWith(['origin/main', '--ff-only']);
  });

  it('a desktop start has no git budget: it checks out and fast-forwards however long the steps take', async () => {
    const context = createMockContext();
    const clock = freezeClock();
    fetchIfStaleMock.mockImplementationOnce(async (_git: unknown, _projectPath: string, branch: string) => {
      clock.advance(10_000);
      return `origin/${branch}`;
    });
    gitCheckoutMock.mockImplementationOnce(async () => {
      clock.advance(10_000);
      return undefined;
    });
    try {
      const result = await startCommandTerminal(context as never, { projectId: 'proj-1' });

      expect(gitCheckoutMock).toHaveBeenCalledWith('main');
      expect(gitMergeMock).toHaveBeenCalledWith(['origin/main', '--ff-only']);
      expect(result.branch).toBe('main');
      expect(result.checkoutError).toBeUndefined();
    } finally {
      clock.restore();
    }
  });

  it('reports no checkoutError when the shared folder is already on the target branch', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1')]);
    gitRevparseMock.mockResolvedValue('main\n');

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(fetchIfStaleMock).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('stays put beside a queued sibling too, not only a running one', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1', { status: 'queued' })]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('feature/live');
    expect(result.checkoutError).toMatch(/another agent is running in the project folder/);
  });

  it('does not let an exited sibling in the project folder block the checkout', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1', { status: 'exited' })]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });

  it('stays put beside a task agent that runs in the project root itself', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTaskSession(PROJECT_ROOT)]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('feature/live');
    expect(result.checkoutError).toMatch(/another agent is running in the project folder/);
  });

  it('does not count a task agent in a worktree under the project root as sharing the root', async () => {
    const context = createMockContext();
    // A worktree has its own HEAD, so its agent never shares the root's checkout.
    context.sessionManager.listSessions.mockReturnValue([liveTaskSession(`${PROJECT_ROOT}/.kangentic/worktrees/some-task`)]);

    const result = await startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true });

    expect(fetchIfStaleMock).toHaveBeenCalled();
    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });

  it('on win32 a sibling whose cwd differs only in case shares the project folder', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1', { cwd: PROJECT_ROOT.toUpperCase() })]);

    const result = await withPlatform('win32', () => startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true }));

    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('feature/live');
    expect(result.checkoutError).toMatch(/another agent is running in the project folder/);
  });

  it('on linux a sibling whose cwd differs only in case is another folder, so the checkout runs', async () => {
    const context = createMockContext();
    context.sessionManager.listSessions.mockReturnValue([liveTerminal('slot-1', { cwd: PROJECT_ROOT.toUpperCase() })]);

    const result = await withPlatform('linux', () => startCommandTerminal(context as never, { projectId: 'proj-1', unattended: true }));

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });
});
