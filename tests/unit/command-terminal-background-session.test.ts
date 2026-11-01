/**
 * A Command Terminal's conversation and the agent CLI's own background session
 * (src/main/ipc/helpers/command-terminal-background-session.ts).
 *
 * A Command Terminal has no session record and its events file goes with its
 * directory, so the gate in front of the CLI is the agent's own files
 * (`isInBackgroundSession`). An ordinary end or resume must run no CLI: not
 * the stop, not the resumable-id lookup, not even `detect`, which can run the
 * CLI's version probe.
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

const MOVED = '8c4cb30b-352c-4d33-ba24-3c53324bfd49';
const ORIGINAL = '6e21471d-887a-42d3-97d3-fcfedac9dd51';
const CLI_PATH = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
const PROJECT_ROOT = 'C:\\Users\\dev\\projects\\app';

function makeAdapter(options: { inBackground: boolean; resolvesTo?: string }) {
  return {
    name: 'claude',
    isInBackgroundSession: vi.fn(async () => options.inBackground),
    stopBackgroundSession: vi.fn(async () => true),
    resolveResumableSessionId: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) => options.resolvesTo ?? agentSessionId),
    detect: vi.fn(async () => ({ found: true, path: CLI_PATH, version: '2.1.316' })),
  };
}

function conversationOf(adapter: ReturnType<typeof makeAdapter>, resolveCliPath = vi.fn(async () => CLI_PATH)) {
  return { adapter: adapter as never, agentSessionId: MOVED, cwd: PROJECT_ROOT, place: null, resolveCliPath };
}

const context = {
  configManager: {
    getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: { claude: 'C:\\Users\\dev\\tools\\claude.exe' } } })),
  },
};

describe('stopEndedCommandTerminalBackgroundSession: a terminal that just ended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.clear();
  });

  it('runs no CLI, not even detect, for a conversation that never moved into a background session', async () => {
    const adapter = makeAdapter({ inBackground: false });
    adapters.set('claude', adapter);

    await stopEndedCommandTerminalBackgroundSession(context as never, { agentName: 'claude', agentSessionId: ORIGINAL, cwd: PROJECT_ROOT, cliTarget: null });

    expect(adapter.isInBackgroundSession).toHaveBeenCalledWith({ agentSessionId: ORIGINAL, cwd: PROJECT_ROOT, place: null });
    expect(adapter.detect).not.toHaveBeenCalled();
    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
  });

  it("stops the background session with the project's configured CLI for its agent", async () => {
    const adapter = makeAdapter({ inBackground: true });
    adapters.set('claude', adapter);

    await stopEndedCommandTerminalBackgroundSession(context as never, { agentName: 'claude', agentSessionId: MOVED, cwd: PROJECT_ROOT, cliTarget: null });

    expect(context.configManager.getEffectiveConfig).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(adapter.detect).toHaveBeenCalledWith('C:\\Users\\dev\\tools\\claude.exe');
    expect(adapter.stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: MOVED, cliPath: CLI_PATH });
  });

  it('asks nothing for a terminal with no conversation, no agent name, or an agent that cannot tell', async () => {
    const adapter = makeAdapter({ inBackground: true });
    adapters.set('claude', adapter);
    adapters.set('codex', { name: 'codex', detect: vi.fn() });

    await stopEndedCommandTerminalBackgroundSession(context as never, { agentName: 'claude', agentSessionId: null, cwd: PROJECT_ROOT, cliTarget: null });
    await stopEndedCommandTerminalBackgroundSession(context as never, { agentName: undefined, agentSessionId: MOVED, cwd: PROJECT_ROOT, cliTarget: null });
    await stopEndedCommandTerminalBackgroundSession(context as never, { agentName: 'codex', agentSessionId: MOVED, cwd: PROJECT_ROOT, cliTarget: null });

    expect(adapter.isInBackgroundSession).not.toHaveBeenCalled();
    expect(adapters.get('codex')!.detect).not.toHaveBeenCalled();
  });

  it('stops nothing when the CLI is not found, and still reads as in a background session', async () => {
    const adapter = makeAdapter({ inBackground: true });
    const resolveCliPath = vi.fn(async () => null);

    await expect(stopCommandTerminalBackgroundSession(conversationOf(adapter, resolveCliPath))).resolves.toBe(true);

    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
  });

  it('reads a check that throws as no background session, and a stop that throws as done, never throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingCheck = makeAdapter({ inBackground: true });
    failingCheck.isInBackgroundSession.mockRejectedValueOnce(new Error('EACCES'));
    await expect(stopCommandTerminalBackgroundSession(conversationOf(failingCheck))).resolves.toBe(false);
    expect(failingCheck.stopBackgroundSession).not.toHaveBeenCalled();

    const failingStop = makeAdapter({ inBackground: true });
    failingStop.stopBackgroundSession.mockRejectedValueOnce(new Error('spawn ENOENT'));
    await expect(stopCommandTerminalBackgroundSession(conversationOf(failingStop))).resolves.toBe(true);
    warn.mockRestore();
  });
});

describe('settleCommandTerminalResume: an Earlier resume', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs no CLI and keeps the id for a conversation that never moved into a background session', async () => {
    const adapter = makeAdapter({ inBackground: false, resolvesTo: ORIGINAL });
    const resolveCliPath = vi.fn(async () => CLI_PATH);

    await expect(settleCommandTerminalResume(conversationOf(adapter, resolveCliPath))).resolves.toBe(MOVED);

    expect(resolveCliPath).not.toHaveBeenCalled();
    expect(adapter.stopBackgroundSession).not.toHaveBeenCalled();
    expect(adapter.resolveResumableSessionId).not.toHaveBeenCalled();
  });

  it('stops the background session first, then resumes the conversation it continued', async () => {
    const order: string[] = [];
    const adapter = makeAdapter({ inBackground: true, resolvesTo: ORIGINAL });
    adapter.stopBackgroundSession.mockImplementation(async () => { order.push('stop'); return true; });
    adapter.resolveResumableSessionId.mockImplementation(async () => { order.push('resolve'); return ORIGINAL; });

    await expect(settleCommandTerminalResume(conversationOf(adapter))).resolves.toBe(ORIGINAL);

    expect(order).toEqual(['stop', 'resolve']);
    expect(adapter.resolveResumableSessionId).toHaveBeenCalledWith({ agentSessionId: MOVED, cwd: PROJECT_ROOT, place: null });
  });

  it('keeps the id when the lookup proves nothing better, returns an id not shaped like one, or throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(settleCommandTerminalResume(conversationOf(makeAdapter({ inBackground: true })))).resolves.toBe(MOVED);
    await expect(settleCommandTerminalResume(conversationOf(makeAdapter({ inBackground: true, resolvesTo: '--dangerously-skip-permissions' })))).resolves.toBe(MOVED);
    const throwing = makeAdapter({ inBackground: true });
    throwing.resolveResumableSessionId.mockRejectedValueOnce(new Error('EBUSY'));
    await expect(settleCommandTerminalResume(conversationOf(throwing))).resolves.toBe(MOVED);
    warn.mockRestore();
  });
});
