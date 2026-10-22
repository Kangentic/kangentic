/**
 * When SessionManager says a session's agent is on screen: the 'first-output'
 * event (and `getFirstOutputCache`), which is the only thing that lifts a
 * terminal's launch overlay in the renderer.
 *
 * Pinned here:
 *  - For an agent session, the adapter's first-output detector does NOT fire it.
 *    The shell's startup frame carries the very escape Claude's detector
 *    matches (pwsh and Windows PowerShell emit `\x1b[?25l` seconds before the
 *    agent runs), which is how the Command Terminal showed the PowerShell
 *    prompt for about three seconds before Claude's TUI.
 *  - It fires, once, on the first of: the agent's first text after the shell
 *    ran the spawn command (the host's `agentOutput`), the first alt-screen
 *    entry, the agent's SessionStart hook, or the backstop ceiling.
 *  - The ceiling never fires for a session that was removed first.
 *  - The ceiling is disarmed when the PTY exits on its own while the registry
 *    row stays, and it is armed for a queue-promoted session, which reuses its
 *    placeholder's id.
 *  - A stopped row (`suspended`, or `exited`) is never marked, whether the
 *    evidence is the ceiling, an alt-screen entry or a SessionStart that lands
 *    between `suspend()` and the PTY's exit.
 *  - A session with no agent keeps the raw first output: its shell IS the output.
 *    With no agent and no output it is not lifted at the ceiling, because it
 *    has no agent to wait for and gets no backstop.
 *
 * Tier: Unit. Node-pty is mocked; the pty host core runs in this process, so
 * the bytes fed here go through the real buffer manager and trackers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { AGENT_READY_CEILING_MS } from '../../src/main/pty/lifecycle/agent-output-tracker';
import { ActivityDetection, EventType, type AgentParser, type SessionEvent } from '../../src/shared/types';

let tmpDir: string;

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;
  const mockPty = {
    pid: 4242,
    cols: 120,
    rows: 30,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
      return { dispose: () => { dataHandler = null; } };
    }),
    onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => {
      exitHandler = callback;
      return { dispose: () => { exitHandler = null; } };
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      mockPty.cols = cols;
      mockPty.rows = rows;
    }),
    kill: vi.fn(),
  };
  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    /** The PTY's own exit, as node-pty raises it. The mock's kill() raises none. */
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

/** An agent whose detector matches the cursor-hide escape, as Claude's does. */
function cursorHideAgent(): AgentParser {
  return {
    name: 'cursor-hide-agent',
    detectFirstOutput: (data: string) => data.includes('\x1b[?25l'),
    runtime: { activity: ActivityDetection.hooks(), reportsTurnEnd: true },
    removeHooks: () => undefined,
  } as unknown as AgentParser;
}

// Byte shapes from a real Command Terminal boot under Windows PowerShell (see
// agent-output-tracker.test.ts): ConPTY's escape-only startup clear carrying
// the cursor-hide escape, the prompt, then `Clear-Host` rendered as ED 3.
const SHELL_STARTUP = '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b[?25h';
const SHELL_PROMPT = 'PS C:\\Users\\dev\\project> Clear-Host; & claude --model haiku\r\n';
const HANDOFF_CLEAR = '\x1b[?25l\x1b[H\x1b[K\r\n\x1b[K\x1b[H\x1b[3J\x1b[?25h';
const AGENT_TEXT = 'Agent v1.0 ready\r\n';

/**
 * Let the host's 16ms flush, which feeds the detectors, land. The budget is
 * several flushes, not two: on Windows a 16ms timer can take about 31ms (the
 * 15.6ms clock tick), so the earlier 30ms left no margin, and one run in four
 * missed the flush. The negative assertions that follow it need a fixed budget
 * anyway, since non-occurrence cannot be polled.
 */
function waitForFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

function sendSessionStart(manager: SessionManager, sessionId: string): void {
  const telemetry = (manager as unknown as { telemetry: { ingestEvents(id: string, events: SessionEvent[]): void } }).telemetry;
  telemetry.ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.SessionStart } as SessionEvent]);
}

/** The status of the registry row, which outlives the PTY until remove(). */
function rowStatus(manager: SessionManager, sessionId: string): string | undefined {
  return (manager as unknown as { registry: { get(id: string): { status: string } | undefined } }).registry.get(sessionId)?.status;
}

/** The backstop timers the launch-overlay latch holds, keyed by session id. */
function pendingCeilings(manager: SessionManager): Map<string, unknown> {
  return (manager as unknown as { firstOutputTracker: { ceilings: Map<string, unknown> } }).firstOutputTracker.ceilings;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-agent-ready-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager: the launch overlay waits for the agent', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnAgentSession(taskId: string, { withAgent = true }: { withAgent?: boolean } = {}) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const agentParser = withAgent ? cursorHideAgent() : undefined;
    const session = await manager.spawn({ taskId, command: '', cwd: tmpDir, agentParser, agentName: withAgent ? 'cursor-hide-agent' : undefined });
    const firstOutput = vi.fn();
    manager.on('first-output', firstOutput);
    return { session, firstOutput, ...mock };
  }

  // Red-green: let the 'firstOutput' host event mark an agent session ready
  // again (drop its `!session.agentParser` gate) and this reads red.
  it("does not fire on the shell's startup frame, though the detector matches it", async () => {
    const { session, firstOutput, feedData } = await spawnAgentSession('task-shell-frame');
    feedData(SHELL_STARTUP);
    feedData(SHELL_PROMPT);
    await waitForFlush();
    expect(firstOutput).not.toHaveBeenCalled();
    expect(manager.getFirstOutputCache()).toEqual({});
    // The detector still matched: it times the boot geometry re-assert.
    const row = (manager as unknown as { registry: { get(id: string): { firstOutputDetected?: boolean } | undefined } }).registry.get(session.id);
    expect(row?.firstOutputDetected).toBe(true);
    manager.remove(session.id);
  });

  it("fires once on the agent's first text after the shell ran the spawn command", async () => {
    const { session, firstOutput, feedData } = await spawnAgentSession('task-agent-text');
    feedData(SHELL_STARTUP);
    feedData(SHELL_PROMPT);
    await waitForFlush();
    feedData(HANDOFF_CLEAR);
    await waitForFlush();
    expect(firstOutput).not.toHaveBeenCalled();
    feedData(AGENT_TEXT);
    await waitForFlush();
    expect(firstOutput).toHaveBeenCalledTimes(1);
    expect(firstOutput).toHaveBeenCalledWith(session.id);
    expect(manager.getFirstOutputCache()).toEqual({ [session.id]: true });
    feedData('\x1b[?1049h');
    sendSessionStart(manager, session.id);
    await waitForFlush();
    expect(firstOutput).toHaveBeenCalledTimes(1);
    manager.remove(session.id);
  });

  it("fires on the agent's first alt-screen entry", async () => {
    const { session, firstOutput, feedData } = await spawnAgentSession('task-alt-screen');
    feedData(SHELL_STARTUP);
    await waitForFlush();
    feedData('\x1b[?1049h');
    await waitForFlush();
    expect(firstOutput).toHaveBeenCalledTimes(1);
    expect(firstOutput).toHaveBeenCalledWith(session.id);
    manager.remove(session.id);
  });

  it("fires on the agent's SessionStart hook", async () => {
    const { session, firstOutput, feedData } = await spawnAgentSession('task-session-start');
    feedData(SHELL_STARTUP);
    await waitForFlush();
    sendSessionStart(manager, session.id);
    expect(firstOutput).toHaveBeenCalledTimes(1);
    expect(firstOutput).toHaveBeenCalledWith(session.id);
    manager.remove(session.id);
  });

  it('fires at the ceiling for an agent that shows none of it, and never for a removed session', async () => {
    vi.useFakeTimers();
    const waiting = await spawnAgentSession('task-ceiling');
    const removed = await spawnAgentSession('task-ceiling-removed');
    manager.remove(removed.session.id);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(waiting.firstOutput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waiting.firstOutput).toHaveBeenCalledWith(waiting.session.id);
    expect(waiting.firstOutput).not.toHaveBeenCalledWith(removed.session.id);
    manager.remove(waiting.session.id);
  });

  it('keeps the raw first output for a session with no agent', async () => {
    const { session, firstOutput, feedData } = await spawnAgentSession('task-no-agent', { withAgent: false });
    feedData('$ ');
    await waitForFlush();
    expect(firstOutput).toHaveBeenCalledTimes(1);
    expect(firstOutput).toHaveBeenCalledWith(session.id);
    manager.remove(session.id);
  });

  // Red-green: drop the `!session?.agentParser ||` half of armAgentReadyCeiling's
  // early return and a shell-only session is armed, then lifted at 15 s with no
  // output at all, which reads red here.
  it('does not lift a session with no agent and no output at the ceiling', async () => {
    vi.useFakeTimers();
    const { session, firstOutput } = await spawnAgentSession('task-no-agent-silent', { withAgent: false });
    // A session with no agent has nothing to wait for, so no backstop is armed.
    expect(pendingCeilings(manager).has(session.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(AGENT_READY_CEILING_MS + 1_000);
    expect(firstOutput).not.toHaveBeenCalled();
    expect(manager.getFirstOutputCache()).toEqual({});
    manager.remove(session.id);
  });

  describe('when the PTY exits on its own', () => {
    // Red-green: remove the `disarmCeiling` call from onPtyExited (session-manager.ts)
    // and the `ceilings` assertion reads red. The behavioral assertions below it stay
    // green on purpose: the spawn flow stamps the row 'exited' before onPtyExited
    // runs, so markAgentReady's status gate covers the same exit. The disarm is the
    // first guard (it cancels the timer), the status gate the second (it refuses the
    // row if a timer ever fires); this test pins each separately.
    it('disarms the ceiling while the registry row stays, so a dead row is never marked', async () => {
      vi.useFakeTimers();
      const { session, firstOutput, triggerExit } = await spawnAgentSession('task-ceiling-pty-exit');
      // Armed once spawn() resolved, which is what makes the disarm below mean something.
      expect(pendingCeilings(manager).has(session.id)).toBe(true);

      triggerExit(1);
      await vi.advanceTimersByTimeAsync(0);

      // No remove(): the row is still there, stamped by the exit, not by a teardown.
      expect(rowStatus(manager, session.id)).toBe('exited');
      expect(pendingCeilings(manager).has(session.id)).toBe(false);

      await vi.advanceTimersByTimeAsync(AGENT_READY_CEILING_MS + 1_000);
      expect(firstOutput).not.toHaveBeenCalled();
      expect(manager.getFirstOutputCache()).toEqual({});
      manager.remove(session.id);
    });
  });

  // A suspend() sets the row 'suspended' before its first await, then spends up
  // to 3 s on the exit sequence, the kill and the propagation wait. The PTY's exit
  // is what ends the session for the renderers, and the mock raises none, so each
  // case below is the gap between the status change and that exit.
  //
  // kill() is not used: it nulls the PTY and flags the exit as intentional but never
  // touches the status of a PTY-backed row, so the status gate has nothing to read
  // until the exit lands.
  //
  // Red-green: remove the `status === 'exited' || status === 'suspended'` check from
  // markAgentReady and each case below reads red.
  describe('a stopped row is never marked ready', () => {
    it('skips a suspended row when the ceiling fires, since no PTY exit has disarmed it', async () => {
      vi.useFakeTimers();
      const { session, firstOutput } = await spawnAgentSession('task-suspended-ceiling');
      const suspending = manager.suspend(session.id);
      expect(rowStatus(manager, session.id)).toBe('suspended');
      // Nothing cancelled the ceiling (that is the exit's job), so at 15 s the
      // status gate is the only thing between the timer and a dead row.
      expect(pendingCeilings(manager).has(session.id)).toBe(true);

      await vi.advanceTimersByTimeAsync(AGENT_READY_CEILING_MS + 1_000);
      await suspending;

      expect(pendingCeilings(manager).has(session.id)).toBe(false);
      expect(firstOutput).not.toHaveBeenCalled();
      expect(manager.getFirstOutputCache()).toEqual({});
      manager.remove(session.id);
    });

    it("skips a suspended row on the agent's alt-screen entry, which lands before the PTY exit", async () => {
      const { session, firstOutput, feedData, triggerExit } = await spawnAgentSession('task-suspended-alt-screen');
      const suspending = manager.suspend(session.id);
      expect(rowStatus(manager, session.id)).toBe('suspended');

      feedData('\x1b[?1049h');
      await waitForFlush();
      expect(firstOutput).not.toHaveBeenCalled();
      expect(manager.getFirstOutputCache()).toEqual({});

      // Let the suspend finish: the exit is what resolves its natural-exit wait.
      triggerExit(0);
      await suspending;
      expect(firstOutput).not.toHaveBeenCalled();
      manager.remove(session.id);
    });

    it('skips a suspended row on a SessionStart that lands before the PTY exit', async () => {
      const { session, firstOutput, triggerExit } = await spawnAgentSession('task-suspended-session-start');
      const suspending = manager.suspend(session.id);
      expect(rowStatus(manager, session.id)).toBe('suspended');

      sendSessionStart(manager, session.id);
      expect(firstOutput).not.toHaveBeenCalled();
      expect(manager.getFirstOutputCache()).toEqual({});

      triggerExit(0);
      await suspending;
      expect(firstOutput).not.toHaveBeenCalled();
      manager.remove(session.id);
    });

    // kill() leaves the row reading 'running' and marks `intentionalExit`
    // instead, so the status check alone would let this through. Red-green:
    // drop the `intentionalExit` check in markAgentReady and this reads red.
    it("skips a killed row on the agent's alt-screen entry, which lands before the PTY exit", async () => {
      const { session, firstOutput, feedData, triggerExit } = await spawnAgentSession('task-killed-alt-screen');
      manager.kill(session.id);
      expect(rowStatus(manager, session.id)).toBe('running');

      feedData('\x1b[?1049h');
      await waitForFlush();
      sendSessionStart(manager, session.id);
      expect(firstOutput).not.toHaveBeenCalled();
      expect(manager.getFirstOutputCache()).toEqual({});

      triggerExit(0);
      manager.remove(session.id);
    });
  });

  // Red-green: drop the `if (session.status === 'running') this.armAgentReadyCeiling(id)`
  // line in doSpawn and this reads red (as does the ceiling test above). The promotion
  // is the case that line's comment names: its placeholder row reads 'queued' until the
  // host round trip returns, so arming any earlier would find no 'running' row.
  it('arms the ceiling for a session promoted from the queue, which reuses its placeholder id', async () => {
    vi.useFakeTimers();
    manager.setMaxConcurrent(1);
    const holder = await spawnAgentSession('task-queue-holder');
    const promotedMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(promotedMock.mockPty as unknown as pty.IPty);
    const placeholder = await manager.spawn({
      taskId: 'task-queue-promoted',
      command: '',
      cwd: tmpDir,
      agentParser: cursorHideAgent(),
      agentName: 'cursor-hide-agent',
    });
    expect(placeholder.status).toBe('queued');
    expect(manager.queuedCount).toBe(1);
    // The holder's listener sees every session: it is registered on the manager.
    const firstOutput = holder.firstOutput;
    // A queued placeholder has no PTY and no agent to wait for yet.
    expect(pendingCeilings(manager).has(placeholder.id)).toBe(false);

    // The holder's PTY exits, which frees the slot and promotes the placeholder.
    holder.triggerExit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.queuedCount).toBe(0);
    expect(rowStatus(manager, placeholder.id)).toBe('running');
    expect(pendingCeilings(manager).has(placeholder.id)).toBe(true);
    expect(firstOutput).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AGENT_READY_CEILING_MS - 1_000);
    expect(firstOutput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    // Exactly the promoted session: the holder's own ceiling died with its exit.
    expect(firstOutput).toHaveBeenCalledTimes(1);
    expect(firstOutput).toHaveBeenCalledWith(placeholder.id);
    manager.remove(placeholder.id);
    manager.remove(holder.session.id);
  });
});
