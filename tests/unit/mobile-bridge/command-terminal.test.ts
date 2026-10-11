/**
 * The `command-terminal` verb: a phone starts or stops a Command Terminal.
 *
 * Start runs the desktop's own `startCommandTerminal` in its unattended form
 * (mocked here; transient-session-spawn-dirty-guard.test.ts drives it for
 * real), answers once the session exists with `{ ok, sessionId, slot, name }`,
 * and turns every refusal into a typed `code` the phone shows one line for,
 * never text it has to parse. Stop ends only a Command Terminal, through the
 * same `endCommandTerminal` the desktop's Stop uses.
 *
 * The router keeps only `error.message` from a throw, so a code survives only
 * when the handler returns the refusal itself; every refusal here is checked
 * for its code for that reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { startCommandTerminalMock, CommandTerminalStartErrorStub } = vi.hoisted(() => {
  class CommandTerminalStartErrorStub extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { startCommandTerminalMock: vi.fn(), CommandTerminalStartErrorStub };
});
vi.mock('../../../src/main/ipc/handlers/transient-sessions', () => ({
  startCommandTerminal: startCommandTerminalMock,
  CommandTerminalStartError: CommandTerminalStartErrorStub,
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleCommandTerminal } from '../../../src/main/mobile-bridge/handlers/command-terminal';
import { AgentCliNotFoundError } from '../../../src/main/agent/shared/agent-cli-not-found';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'command-terminal', payload };
}

function fakeContext(options: { project?: boolean; endOutcome?: 'ended' | 'not-found' | 'not-command-terminal' } = {}) {
  const endCommandTerminal = vi.fn(() => options.endOutcome ?? 'ended');
  const context = {
    // No current project: a phone's start must not need one.
    currentProjectId: null,
    projectRepo: {
      getById: vi.fn((projectId: string) => (options.project === false ? undefined : { id: projectId, path: 'C:/Users/dev/proj' })),
    },
    sessionManager: { endCommandTerminal },
  } as unknown as IpcContext;
  return { context, endCommandTerminal };
}

function startedSession(slot: string, label: string | null = null) {
  return {
    session: { id: 'term-9', commandTerminalLabel: label },
    slot,
    branch: 'main',
  };
}

describe('command-terminal: start', () => {
  beforeEach(() => {
    startCommandTerminalMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('starts an unattended terminal for the named project and answers its id, slot number and name', async () => {
    startCommandTerminalMock.mockResolvedValue(startedSession('slot-3'));
    const { context } = fakeContext();

    const response = await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'proj-1' }), context);

    expect(startCommandTerminalMock).toHaveBeenCalledWith(context, { projectId: 'proj-1', unattended: true });
    expect(response).toEqual({
      type: 'capability-response',
      requestId: 'req-1',
      ok: true,
      payload: { ok: true, sessionId: 'term-9', slot: 3, name: 'Command Terminal 3' },
    });
  });

  it('answers the terminal\'s own name rather than the slot title once main has named it', async () => {
    startCommandTerminalMock.mockResolvedValue(startedSession('slot-3', 'Fix the flaky login test'));
    const { context } = fakeContext();

    const response = await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'proj-1' }), context);

    expect(response).toEqual({
      type: 'capability-response',
      requestId: 'req-1',
      ok: true,
      payload: { ok: true, sessionId: 'term-9', slot: 3, name: 'Fix the flaky login test' },
    });
  });

  it('never forwards a branch, model or effort the phone tried to send', async () => {
    startCommandTerminalMock.mockResolvedValue(startedSession('slot-1'));
    const { context } = fakeContext();

    await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'proj-1', branch: 'feature/x', model: 'm', effort: 'e' }), context);

    expect(startCommandTerminalMock).toHaveBeenCalledWith(context, { projectId: 'proj-1', unattended: true });
  });

  it('refuses an unknown project with its code, before starting anything', async () => {
    const { context } = fakeContext({ project: false });

    const response = await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'ghost' }), context);

    expect(response).toMatchObject({ ok: false, code: 'unknown-project' });
    expect(startCommandTerminalMock).not.toHaveBeenCalled();
  });

  it.each([
    ['command-terminal-limit', 'command-terminal-limit'],
    ['unknown-project', 'unknown-project'],
    // A phone's start asks for no slot, so this cannot reach it; it still maps to the generic failure rather than going unmapped.
    ['slot-taken', 'command-terminal-start-failed'],
  ])('maps a %s refusal from the start to the %s code', async (startCode, wireCode) => {
    startCommandTerminalMock.mockRejectedValue(new CommandTerminalStartErrorStub(startCode, 'refused'));
    const { context } = fakeContext();

    const response = await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'proj-1' }), context);

    expect(response).toMatchObject({ ok: false, code: wireCode, error: 'refused' });
  });

  it('maps a missing agent CLI to agent-unavailable', async () => {
    startCommandTerminalMock.mockRejectedValue(new AgentCliNotFoundError('claude', 'Claude Code'));
    const { context } = fakeContext();

    const response = await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'proj-1' }), context);

    expect(response).toMatchObject({ ok: false, code: 'agent-unavailable' });
  });

  it('maps anything else to command-terminal-start-failed, keeping the text for logs', async () => {
    startCommandTerminalMock.mockRejectedValue(new Error('EACCES: permission denied, mkdir'));
    const { context } = fakeContext();

    const response = await handleCommandTerminal(fakeRequest({ action: 'start', projectId: 'proj-1' }), context);

    expect(response).toMatchObject({ ok: false, code: 'command-terminal-start-failed', error: 'EACCES: permission denied, mkdir' });
  });
});

describe('command-terminal: stop', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('ends the terminal through endCommandTerminal and answers ok', async () => {
    const { context, endCommandTerminal } = fakeContext();

    const response = await handleCommandTerminal(fakeRequest({ action: 'stop', sessionId: 'term-9' }), context);

    expect(endCommandTerminal).toHaveBeenCalledWith('term-9');
    expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: true, payload: { ok: true } });
  });

  it('refuses a session that is not a Command Terminal, with its code', async () => {
    const { context } = fakeContext({ endOutcome: 'not-command-terminal' });

    const response = await handleCommandTerminal(fakeRequest({ action: 'stop', sessionId: 'task-session' }), context);

    expect(response).toMatchObject({ ok: false, code: 'not-command-terminal' });
  });

  it('answers unknown-session for a terminal that already ended, which the phone treats as stopped', async () => {
    const { context } = fakeContext({ endOutcome: 'not-found' });

    const response = await handleCommandTerminal(fakeRequest({ action: 'stop', sessionId: 'gone' }), context);

    expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
  });
});
