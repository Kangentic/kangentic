/**
 * A Command Terminal's conversation and the agent CLI's own background session
 * (src/main/ipc/helpers/command-terminal-background-session.ts).
 *
 * A Command Terminal has no session record and its events file goes with its
 * directory, so the gate in front of the CLI is the agent's own files
 * (`backgroundSessionOf`). An ordinary end or resume must run no CLI: not
 * the stop, not the resumable-id lookup, not even `detect`, which can run the
 * CLI's version probe. A background session a live terminal still holds is
 * never stopped.
 *
 * Test tier: Unit. Fake adapters; the agent registry is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const adapters = new Map<string, Record<string, unknown>>();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: (name: string) => adapters.get(name) },
}));

const {
  settleCommandTerminalResume,
  stopCommandTerminalBackgroundSession,
  stopEndedCommandTerminalBackgroundSession,
} = await import('../../src/main/ipc/helpers/command-terminal-background-session');

/** The background session `/bg` moved the conversation into. */
const MOVED = '8c4cb30b-352c-4d33-ba24-3c53324bfd49';
/** The conversation the move left. */
const ORIGINAL = '6e21471d-887a-42d3-97d3-fcfedac9dd51';
const CLI_PATH = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
const PROJECT_ROOT = 'C:\\Users\\dev\\projects\\app';

function makeAdapter(options: { backgroundId: string | null; resolvesTo?: string }) {
  return {
    name: 'claude',
    backgroundSessionOf: vi.fn(async (_query: { agentSessionId: string }) => options.backgroundId),
    stopBackgroundSession: vi.fn(async (_options: { agentSessionId: string; cliPath: string }) => true),
    resolveResumableSessionId: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) => options.resolvesTo ?? agentSessionId),
    detect: vi.fn(async () => ({ found: true, path: CLI_PATH, version: '2.1.316' })),
  };
}

function conversationOf(
  adapter: ReturnType<typeof makeAdapter>,
  options: { agentSessionId?: string; resolveCliPath?: () => Promise<string | null>; heldLive?: string[] } = {},
) {
  return {
    adapter: adapter as never,
    agentSessionId: options.agentSessionId ?? MOVED,
    cwd: PROJECT_ROOT,
    place: null,
    resolveCliPath: options.resolveCliPath ?? vi.fn(async () => CLI_PATH),
    isHeldLive: (agentSessionId: string) => (options.heldLive ?? []).includes(agentSessionId),
  };
}

function makeContext(liveConversations: string[] = []) {
  return {
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: { claude: 'C:\\Users\\dev\\tools\\claude.exe' } } })),
    },
    sessionManager: {
      listSessions: vi.fn(() => liveConversations.map((agentSessionId, index) => ({ id: `live-${index}`, agentSessionId, status: 'running' }))),
    },
  };
}

describe('stopEndedCommandTerminalBackgroundSession: a terminal that just ended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.clear();
  });

  it('runs no CLI, not even detect, for a conversation that never moved into a background session', async () => {
    const adapter = makeAdapter({ backgroundId: null });
    adapters.set('claude', adapter);

    await stopEndedCommandTerminalBackgroundSession(makeContext() as never, { agentName: 'claude', agentSessionId: ORIGINAL, cwd: PROJECT_ROOT, cliTarget: null });

    expect(adapter.backgroundSessionOf).toHaveBeenCalledWith({ agentSessionId: ORIGINAL, cwd: PROJECT_ROOT, place: null });
    expect(adapter.detect).not.toHaveBeenCalled();
    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
  });

  it.each([
    ['the terminal held the background session itself (the live switch followed /bg)', MOVED],
    ['the terminal still held the conversation the move left (stopped before the switch)', ORIGINAL],
  ])("stops the background session with the project's configured CLI when %s", async (_name, heldId) => {
    const adapter = makeAdapter({ backgroundId: MOVED });
    adapters.set('claude', adapter);
    const context = makeContext();

    await stopEndedCommandTerminalBackgroundSession(context as never, { agentName: 'claude', agentSessionId: heldId, cwd: PROJECT_ROOT, cliTarget: null });

    expect(context.configManager.getEffectiveConfig).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(adapter.detect).toHaveBeenCalledWith('C:\\Users\\dev\\tools\\claude.exe');
    expect(adapter.stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: MOVED, cliPath: CLI_PATH });
  });

  it('leaves a background session another live terminal holds running, and runs no CLI', async () => {
    const adapter = makeAdapter({ backgroundId: MOVED });
    adapters.set('claude', adapter);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await stopEndedCommandTerminalBackgroundSession(makeContext([MOVED]) as never, { agentName: 'claude', agentSessionId: ORIGINAL, cwd: PROJECT_ROOT, cliTarget: null });

    expect(adapter.detect).not.toHaveBeenCalled();
    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('asks nothing for a terminal with no conversation, no agent name, or an agent that cannot tell', async () => {
    const adapter = makeAdapter({ backgroundId: MOVED });
    adapters.set('claude', adapter);
    adapters.set('codex', { name: 'codex', detect: vi.fn() });

    await stopEndedCommandTerminalBackgroundSession(makeContext() as never, { agentName: 'claude', agentSessionId: null, cwd: PROJECT_ROOT, cliTarget: null });
    await stopEndedCommandTerminalBackgroundSession(makeContext() as never, { agentName: undefined, agentSessionId: MOVED, cwd: PROJECT_ROOT, cliTarget: null });
    await stopEndedCommandTerminalBackgroundSession(makeContext() as never, { agentName: 'codex', agentSessionId: MOVED, cwd: PROJECT_ROOT, cliTarget: null });

    expect(adapter.backgroundSessionOf).not.toHaveBeenCalled();
    expect(adapters.get('codex')!.detect).not.toHaveBeenCalled();
  });

  it('stops nothing when the CLI is not found, and still names the background session', async () => {
    const adapter = makeAdapter({ backgroundId: MOVED });

    await expect(stopCommandTerminalBackgroundSession(conversationOf(adapter, { resolveCliPath: async () => null }))).resolves.toBe(MOVED);

    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
  });

  it('reads a check that throws as no background session, and a stop that throws as done, never throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingCheck = makeAdapter({ backgroundId: MOVED });
    failingCheck.backgroundSessionOf.mockRejectedValueOnce(new Error('EACCES'));
    await expect(stopCommandTerminalBackgroundSession(conversationOf(failingCheck))).resolves.toBeNull();
    expect(failingCheck.stopBackgroundSession).not.toHaveBeenCalled();

    const failingStop = makeAdapter({ backgroundId: MOVED });
    failingStop.stopBackgroundSession.mockRejectedValueOnce(new Error('spawn ENOENT'));
    await expect(stopCommandTerminalBackgroundSession(conversationOf(failingStop))).resolves.toBe(MOVED);
    warn.mockRestore();
  });
});

describe('settleCommandTerminalResume: an Earlier resume', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs no CLI and keeps the id for a conversation that never moved into a background session', async () => {
    const adapter = makeAdapter({ backgroundId: null, resolvesTo: ORIGINAL });
    const resolveCliPath = vi.fn(async () => CLI_PATH);

    await expect(settleCommandTerminalResume(conversationOf(adapter, { resolveCliPath }))).resolves.toBe(MOVED);

    expect(resolveCliPath).not.toHaveBeenCalled();
    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
    expect(adapter.resolveResumableSessionId).not.toHaveBeenCalled();
  });

  it('stops the background session the row is, then resumes the conversation it continued', async () => {
    const order: string[] = [];
    const adapter = makeAdapter({ backgroundId: MOVED, resolvesTo: ORIGINAL });
    adapter.stopBackgroundSession.mockImplementation(async () => { order.push('stop'); return true; });
    adapter.resolveResumableSessionId.mockImplementation(async () => { order.push('resolve'); return ORIGINAL; });

    await expect(settleCommandTerminalResume(conversationOf(adapter))).resolves.toBe(ORIGINAL);

    expect(order).toEqual(['stop', 'resolve']);
    expect(adapter.resolveResumableSessionId).toHaveBeenCalledWith({ agentSessionId: MOVED, cwd: PROJECT_ROOT, place: null });
  });

  // After a quit with a background session that took no turn, Earlier offers
  // only the conversation the move left (the session wrote no transcript).
  // Red-green: without the forward record that resume leaves it running.
  it('stops the background session the row moved into, and resumes the row as it is', async () => {
    const adapter = makeAdapter({ backgroundId: MOVED, resolvesTo: ORIGINAL });

    await expect(settleCommandTerminalResume(conversationOf(adapter, { agentSessionId: ORIGINAL }))).resolves.toBe(ORIGINAL);

    expect(adapter.stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: MOVED, cliPath: CLI_PATH });
    expect(adapter.resolveResumableSessionId).not.toHaveBeenCalled();
  });

  // The terminal `/bg` ran in shows the background session, and Earlier lists
  // the row the move left while it runs.
  it('never stops a background session a live terminal holds', async () => {
    const adapter = makeAdapter({ backgroundId: MOVED });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const resolveCliPath = vi.fn(async () => CLI_PATH);

    await expect(settleCommandTerminalResume(conversationOf(adapter, { agentSessionId: ORIGINAL, resolveCliPath, heldLive: [MOVED] }))).resolves.toBe(ORIGINAL);

    expect(resolveCliPath).not.toHaveBeenCalled();
    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('keeps the id when the lookup proves nothing better, returns an id not shaped like one, or throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(settleCommandTerminalResume(conversationOf(makeAdapter({ backgroundId: MOVED })))).resolves.toBe(MOVED);
    await expect(settleCommandTerminalResume(conversationOf(makeAdapter({ backgroundId: MOVED, resolvesTo: '--dangerously-skip-permissions' })))).resolves.toBe(MOVED);
    const throwing = makeAdapter({ backgroundId: MOVED });
    throwing.resolveResumableSessionId.mockRejectedValueOnce(new Error('EBUSY'));
    await expect(settleCommandTerminalResume(conversationOf(throwing))).resolves.toBe(MOVED);
    warn.mockRestore();
  });
});
