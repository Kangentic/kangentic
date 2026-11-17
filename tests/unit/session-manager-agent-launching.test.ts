/**
 * `SessionManager.isAgentLaunching` / `awaitAgentLaunched`: whether a session
 * that nobody flagged as fresh can take keys yet.
 *
 * An exit row's message reached a session about 3.4 s after its column spawned
 * it. The scheduler read a `running` row as ready and typed the message into
 * the shell 1.4 s before the Claude CLI started, so the message could never be
 * confirmed and the row failed. These two members are what the scheduler and
 * both paste paths now ask before they type. They read the evidence the launch
 * overlay waits for (`markAgentReady`): the agent's first visible text after
 * the launch line ran, its alternate-screen entry, or its SessionStart hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import { AGENT_READY_CEILING_MS } from '../../src/main/pty/lifecycle/agent-output-tracker';

const TASK_ID = 'task-agent-launching';
const PROJECT_ID = 'project-agent-launching';
const SESSION_ID = 'sess-agent-launching';

describe('SessionManager: is the agent still starting', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function seedRunningRow(overrides: Partial<ManagedSession> = {}): ManagedSession {
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    const session = {
      id: SESSION_ID,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      pty: { sealUserInput: vi.fn() } as unknown as ManagedSession['pty'],
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
      ...overrides,
    } as ManagedSession;
    registry.set(SESSION_ID, session);
    return session;
  }

  /** The pty host saw the agent's first visible text after the launch line ran. */
  function agentShowsOutput(): void {
    (manager as unknown as { handleHostEvent: (event: { type: 'agentOutput'; sessionId: string }) => void })
      .handleHostEvent({ type: 'agentOutput', sessionId: SESSION_ID });
  }

  it('reads a young session whose agent is not on screen yet as starting', async () => {
    seedRunningRow();

    expect(manager.isAgentLaunching(SESSION_ID)).toBe(true);
    await expect(manager.awaitAgentLaunched(SESSION_ID, 0)).resolves.toBe(false);
  });

  it('reads it as started once the agent has put text on the screen', async () => {
    seedRunningRow();
    agentShowsOutput();

    expect(manager.isAgentLaunching(SESSION_ID)).toBe(false);
    await expect(manager.awaitAgentLaunched(SESSION_ID, 0)).resolves.toBe(true);
  });

  it('ends a wait in progress when the agent shows up', async () => {
    seedRunningRow();

    const waiting = manager.awaitAgentLaunched(SESSION_ID, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    agentShowsOutput();

    await expect(waiting).resolves.toBe(true);
  });

  it('never holds a session past the launch overlay\'s own ceiling', () => {
    seedRunningRow({ startedAt: new Date(Date.now() - AGENT_READY_CEILING_MS - 1_000).toISOString() });

    expect(manager.isAgentLaunching(SESSION_ID)).toBe(false);
  });

  it('answers false for a session that has ended', async () => {
    seedRunningRow({ status: 'exited', pty: null });

    expect(manager.isAgentLaunching(SESSION_ID)).toBe(false);
    await expect(manager.awaitAgentLaunched(SESSION_ID, 0)).resolves.toBe(false);
  });

  it('answers false for a running row with no PTY, which cannot take keys', () => {
    seedRunningRow({ pty: null });

    expect(manager.isAgentLaunching(SESSION_ID)).toBe(false);
  });

  it('ends a wait in progress with false when its signal aborts', async () => {
    seedRunningRow();
    const controller = new AbortController();

    const waiting = manager.awaitAgentLaunched(SESSION_ID, 5_000, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    // Red: without the signal check the wait would run to its 5 s timeout.
    await expect(waiting).resolves.toBe(false);
  });

  it('ends a wait with false when its timeout passes and the agent never shows', async () => {
    seedRunningRow();

    await expect(manager.awaitAgentLaunched(SESSION_ID, 300)).resolves.toBe(false);
  });

  it('waits a queued session through its promotion', async () => {
    const session = seedRunningRow({ status: 'queued', pty: null });

    const waiting = manager.awaitAgentLaunched(SESSION_ID, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    session.status = 'running';
    session.pty = { sealUserInput: vi.fn() } as unknown as ManagedSession['pty'];
    agentShowsOutput();

    await expect(waiting).resolves.toBe(true);
  });
});
