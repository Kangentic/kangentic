/**
 * Main names a Command Terminal from its first prompt (command-terminal-namer.ts),
 * so a terminal a phone started, or one in a project the desktop does not have
 * open, gets a name too. The renderer did this before and could not see either.
 *
 * Pinned here: only a transient session's first real prompt counts, once; the
 * synthetic pty-activity prompt is skipped; the summarize runs with the
 * session's OWN agent in the session's project folder; the shared rate limit
 * gates it; and the name lands through `setCommandTerminalLabel`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CommandTerminalNamer, type CommandTerminalNamerDeps } from '../../src/main/agent/shared/command-terminal-namer';
import { EventType, PromptReason, type Session, type SessionEvent } from '../../src/shared/types';

class FakeSessionManager extends EventEmitter {
  sessions = new Map<string, Session>();
  agentNames = new Map<string, string>();
  setCommandTerminalLabel = vi.fn((_sessionId: string, _label: string) => true);
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
  getSessionAgentName(sessionId: string): string | undefined {
    return this.agentNames.get(sessionId);
  }
}

function terminal(overrides: Partial<Session> = {}): Session {
  return {
    id: 'term-1',
    taskId: 'made-up-uuid',
    projectId: 'proj-1',
    pid: 1,
    status: 'running',
    shell: 'pwsh',
    cwd: '/mock/project-root',
    startedAt: '2026-10-11T12:00:00.000Z',
    exitCode: null,
    resuming: false,
    transient: true,
    commandTerminalSlot: 'slot-1',
    commandTerminalLabel: null,
    ...overrides,
  };
}

function prompt(detail: string): SessionEvent {
  return { ts: Date.now(), type: EventType.Prompt, detail };
}

describe('CommandTerminalNamer', () => {
  let sessionManager: FakeSessionManager;
  let summarize: ReturnType<typeof vi.fn>;
  let detect: ReturnType<typeof vi.fn>;
  let tryAcquireSlot: ReturnType<typeof vi.fn>;
  let getAdapter: ReturnType<typeof vi.fn>;
  let readConfig: ReturnType<typeof vi.fn>;
  let namer: CommandTerminalNamer;

  beforeEach(() => {
    sessionManager = new FakeSessionManager();
    sessionManager.sessions.set('term-1', terminal());
    sessionManager.agentNames.set('term-1', 'codex');
    summarize = vi.fn(async () => 'Audit Unused Feature Flags');
    detect = vi.fn(async () => ({ found: true, path: '/usr/bin/codex' }));
    tryAcquireSlot = vi.fn(() => true);
    getAdapter = vi.fn(() => ({ detect, summarize }));
    readConfig = vi.fn(() => ({ rateLimitPerHour: 60, cliPathOverride: '/custom/codex' }));
    namer = new CommandTerminalNamer({
      sessionManager: sessionManager as unknown as CommandTerminalNamerDeps['sessionManager'],
      getAdapter: getAdapter as unknown as CommandTerminalNamerDeps['getAdapter'],
      readConfig: readConfig as unknown as CommandTerminalNamerDeps['readConfig'],
      tryAcquireSlot: tryAcquireSlot as unknown as CommandTerminalNamerDeps['tryAcquireSlot'],
    });
    namer.start();
  });

  it('names a terminal from its first prompt, with the session\'s own agent in its project folder', async () => {
    sessionManager.emit('event', 'term-1', prompt('find feature flags nobody reads anymore'));

    await vi.waitFor(() => expect(sessionManager.setCommandTerminalLabel).toHaveBeenCalledTimes(1));
    expect(getAdapter).toHaveBeenCalledWith('codex');
    expect(readConfig).toHaveBeenCalledWith('/mock/project-root', 'codex');
    expect(detect).toHaveBeenCalledWith('/custom/codex');
    expect(summarize).toHaveBeenCalledWith('find feature flags nobody reads anymore', '/usr/bin/codex', '/mock/project-root');
    expect(sessionManager.setCommandTerminalLabel).toHaveBeenCalledWith('term-1', 'Audit Unused Feature Flags');
  });

  it('only the first prompt counts: a later one never renames it', async () => {
    sessionManager.emit('event', 'term-1', prompt('first'));
    sessionManager.emit('event', 'term-1', prompt('second'));

    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    expect(summarize).toHaveBeenCalledWith('first', expect.any(String), expect.any(String));
  });

  it('skips the synthetic pty-activity prompt, an empty prompt, and any other event type', async () => {
    sessionManager.emit('event', 'term-1', prompt(PromptReason.PtyActivity));
    sessionManager.emit('event', 'term-1', prompt('   '));
    sessionManager.emit('event', 'term-1', { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    // The naming work begins synchronously with the adapter lookup, so a
    // skipped event is proven skipped here, before any await.
    expect(getAdapter).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(summarize).not.toHaveBeenCalled();

    // The real prompt that follows still names it.
    sessionManager.emit('event', 'term-1', prompt('the real one'));
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
  });

  it('never names a task\'s agent', async () => {
    sessionManager.sessions.set('task-session', terminal({ id: 'task-session', transient: false }));
    // An agent the namer could use, so only the transient check can stop it.
    sessionManager.agentNames.set('task-session', 'codex');

    sessionManager.emit('event', 'task-session', prompt('a task prompt'));
    expect(getAdapter).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('leaves a terminal that already has a name alone', async () => {
    sessionManager.sessions.set('term-1', terminal({ commandTerminalLabel: 'Named Already' }));

    sessionManager.emit('event', 'term-1', prompt('hello'));
    expect(getAdapter).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('honors the shared rate limit', async () => {
    tryAcquireSlot.mockReturnValue(false);

    sessionManager.emit('event', 'term-1', prompt('hello'));
    await vi.waitFor(() => expect(tryAcquireSlot).toHaveBeenCalledWith(60));

    expect(summarize).not.toHaveBeenCalled();
  });

  it('does nothing for an agent with no summarize, or one whose CLI is not found', async () => {
    getAdapter.mockReturnValueOnce({ detect });
    sessionManager.emit('event', 'term-1', prompt('hello'));
    await Promise.resolve();
    expect(detect).not.toHaveBeenCalled();

    sessionManager.sessions.set('term-2', terminal({ id: 'term-2' }));
    sessionManager.agentNames.set('term-2', 'codex');
    detect.mockResolvedValueOnce({ found: false, path: null });
    sessionManager.emit('event', 'term-2', prompt('hello'));
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
    expect(summarize).not.toHaveBeenCalled();
  });

  it('a summarize failure keeps the slot title and does not throw out of the event', async () => {
    summarize.mockRejectedValueOnce(new Error('cli crashed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => sessionManager.emit('event', 'term-1', prompt('hello'))).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(sessionManager.setCommandTerminalLabel).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('dispose detaches both listeners', () => {
    namer.dispose();

    expect(sessionManager.listenerCount('event')).toBe(0);
    expect(sessionManager.listenerCount('session-removed')).toBe(0);
  });
});
