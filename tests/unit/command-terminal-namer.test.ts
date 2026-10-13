/**
 * Main names a Command Terminal from its first prompt (command-terminal-namer.ts),
 * so a terminal a phone started, or one in a project the desktop does not have
 * open, gets a name too. The renderer did this before and could not see either.
 *
 * Pinned here: only a transient session's first real prompt counts, once; the
 * synthetic pty-activity prompt is skipped; the summarize runs on the Automation
 * agent, its model and effort, in the shared answer home; with no Automation
 * agent nothing runs and no rate-limit slot is spent; the shared rate limit
 * gates it; and the name lands through `setCommandTerminalLabel`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CommandTerminalNamer, type CommandTerminalNamerDeps } from '../../src/main/agent/shared/command-terminal-namer';
import type { ResolvedAutomationAgent } from '../../src/main/automations/automation-agent';
import { EventType, PromptReason, type Session, type SessionEvent } from '../../src/shared/types';

class FakeSessionManager extends EventEmitter {
  sessions = new Map<string, Session>();
  setCommandTerminalLabel = vi.fn((_sessionId: string, _label: string) => true);
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
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
  let tryAcquireSlot: ReturnType<typeof vi.fn>;
  let resolveNamingAgent: ReturnType<typeof vi.fn>;
  let readRateLimit: ReturnType<typeof vi.fn>;
  let namer: CommandTerminalNamer;

  function readyAgent(): ResolvedAutomationAgent {
    return {
      ok: true,
      adapter: { summarize } as unknown as Extract<ResolvedAutomationAgent, { ok: true }>['adapter'],
      agentName: 'claude',
      cliPath: '/usr/bin/claude',
      model: 'claude-haiku-5-5',
      effort: 'low',
    };
  }

  beforeEach(() => {
    sessionManager = new FakeSessionManager();
    sessionManager.sessions.set('term-1', terminal());
    summarize = vi.fn(async () => 'Audit Unused Feature Flags');
    tryAcquireSlot = vi.fn(() => true);
    resolveNamingAgent = vi.fn(async () => readyAgent());
    readRateLimit = vi.fn(() => 60);
    namer = new CommandTerminalNamer({
      sessionManager: sessionManager as unknown as CommandTerminalNamerDeps['sessionManager'],
      resolveNamingAgent: resolveNamingAgent as unknown as CommandTerminalNamerDeps['resolveNamingAgent'],
      readRateLimit: readRateLimit as unknown as CommandTerminalNamerDeps['readRateLimit'],
      tryAcquireSlot: tryAcquireSlot as unknown as CommandTerminalNamerDeps['tryAcquireSlot'],
    });
    namer.start();
  });

  it('names a terminal from its first prompt, on the Automation agent in the answer home', async () => {
    sessionManager.emit('event', 'term-1', prompt('find feature flags nobody reads anymore'));

    await vi.waitFor(() => expect(sessionManager.setCommandTerminalLabel).toHaveBeenCalledTimes(1));
    expect(summarize).toHaveBeenCalledTimes(1);
    const [promptText, cliPath, cwd, options] = summarize.mock.calls[0] as [string, string, string, { model: string; effort: string; runDirectory: string }];
    expect(promptText).toBe('find feature flags nobody reads anymore');
    expect(cliPath).toBe('/usr/bin/claude');
    // Never the terminal's project folder: a title needs nothing from it.
    expect(cwd).not.toBe('/mock/project-root');
    expect(cwd).toContain('kangentic-ask-home');
    expect(options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(typeof options.runDirectory).toBe('string');
    expect(sessionManager.setCommandTerminalLabel).toHaveBeenCalledWith('term-1', 'Audit Unused Feature Flags');
  });

  it('only the first prompt counts: a later one never renames it', async () => {
    sessionManager.emit('event', 'term-1', prompt('first'));
    sessionManager.emit('event', 'term-1', prompt('second'));

    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    expect(summarize.mock.calls[0][0]).toBe('first');
  });

  it('skips the synthetic pty-activity prompt, an empty prompt, and any other event type', async () => {
    sessionManager.emit('event', 'term-1', prompt(PromptReason.PtyActivity));
    sessionManager.emit('event', 'term-1', prompt('   '));
    sessionManager.emit('event', 'term-1', { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    // The naming work begins synchronously with the agent resolution, so a
    // skipped event is proven skipped here, before any await.
    expect(resolveNamingAgent).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(summarize).not.toHaveBeenCalled();

    // The real prompt that follows still names it.
    sessionManager.emit('event', 'term-1', prompt('the real one'));
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
  });

  it('never names a task\'s agent', async () => {
    sessionManager.sessions.set('task-session', terminal({ id: 'task-session', transient: false }));

    sessionManager.emit('event', 'task-session', prompt('a task prompt'));
    expect(resolveNamingAgent).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('never names a workflow\'s own agent: transient, but no terminal, and its first prompt is the planning brief', async () => {
    sessionManager.sessions.set('workflow-agent', terminal({ id: 'workflow-agent', taskId: 'workflow-1', workflowId: 'workflow-1', commandTerminalSlot: null }));

    sessionManager.emit('event', 'workflow-agent', prompt('<workflow_request>plan usage budgets</workflow_request>'));
    expect(resolveNamingAgent).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('leaves a terminal that already has a name alone', async () => {
    sessionManager.sessions.set('term-1', terminal({ commandTerminalLabel: 'Named Already' }));

    sessionManager.emit('event', 'term-1', prompt('hello'));
    expect(resolveNamingAgent).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('honors the shared rate limit', async () => {
    tryAcquireSlot.mockReturnValue(false);

    sessionManager.emit('event', 'term-1', prompt('hello'));
    await vi.waitFor(() => expect(tryAcquireSlot).toHaveBeenCalledWith(60));

    expect(summarize).not.toHaveBeenCalled();
  });

  it('with no Automation agent, keeps the default title and spends no rate-limit slot', async () => {
    resolveNamingAgent.mockResolvedValueOnce({ ok: false, reason: 'Set up an Automation agent in Settings > Workflows to name tasks.' });

    sessionManager.emit('event', 'term-1', prompt('hello'));
    await vi.waitFor(() => expect(resolveNamingAgent).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(tryAcquireSlot).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(sessionManager.setCommandTerminalLabel).not.toHaveBeenCalled();
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
