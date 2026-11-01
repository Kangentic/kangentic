/**
 * `Session.hasUserInput`: SessionManager marks a session used when the pty host
 * reports a human's first key or text (`userInput`; a renderer's keystrokes go to
 * the host on its own port and never cross main), and announces it once on
 * 'session-changed'. An unused Command Terminal is replaced in place when an
 * earlier conversation is resumed from it. What counts as a human's key (not
 * xterm's own replies, not injected keystrokes) is decided in the host core and
 * pinned in pty-host-core.test.ts.
 *
 * Harness modelled on session-manager-remove-emit.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

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

import { EventType, type Session } from '../../src/shared/types';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';

const SESSION_ID = 'command-terminal-1';

describe('SessionManager: a session is marked used when a human uses it', () => {
  let manager: SessionManager;
  let changes: Session[];

  /** The host's event, as `handleHostEvent` receives it. */
  const hostReports = (event: { type: 'userInput'; sessionId: string }) => {
    (manager as unknown as { handleHostEvent(event: unknown): void }).handleHostEvent(event);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: 'transient-task',
      projectId: 'project-1',
      pty: { pid: 1, write: vi.fn() },
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: true,
      exitSequence: ['\x03'],
    } as unknown as ManagedSession);
    changes = [];
    manager.on('session-changed', (_sessionId: string, session: Session) => changes.push(session));
  });

  it('marks it when the host reports a human typed, and announces that once', () => {
    hostReports({ type: 'userInput', sessionId: SESSION_ID });
    hostReports({ type: 'userInput', sessionId: SESSION_ID });
    expect(changes).toHaveLength(1);
    expect(changes[0].hasUserInput).toBe(true);
    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBe(true);
  });

  it('leaves it unmarked until the host reports', () => {
    expect(changes).toEqual([]);
    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBeUndefined();
  });

  it('ignores a report for a session it does not hold', () => {
    hostReports({ type: 'userInput', sessionId: 'gone' });
    expect(changes).toEqual([]);
  });

  it('marks it for pasted content delivered outside the write path', () => {
    manager.markUserInput(SESSION_ID);
    manager.markUserInput(SESSION_ID);
    expect(changes).toHaveLength(1);
    expect(changes[0].hasUserInput).toBe(true);
  });
});

/**
 * `getLastUserInputAt` (task #952): when a PERSON last typed into a session,
 * read by the automated-keys guard so Kangentic never types over a draft in
 * progress. It is set from the host's `userInput` report (`at`) and from
 * nothing else: not from `markUserInput` (a paste Kangentic sends marks the
 * session used too, and must not read as a person at the keys), and not from a
 * write Kangentic makes through `write()`. It is cleared on exit, so the next
 * session to reuse the id starts with no typing on record.
 *
 * Red-green: drop the `lastUserInputAt.set` from the `userInput` case and the
 * report tests fail; also set it from `markUserInput` or `write()` and the
 * matching "does not" test fails; drop the `delete` from the exit listener and
 * the exit test fails.
 */
describe('SessionManager: when a person last typed into a session', () => {
  let manager: SessionManager;

  const hostReports = (event: { type: 'userInput'; sessionId: string; at?: number }) => {
    (manager as unknown as { handleHostEvent(event: unknown): void }).handleHostEvent(event);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: 'task-1',
      projectId: 'project-1',
      pty: { pid: 1, ptyId: 'pty-1', write: vi.fn() },
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      exitSequence: ['\x03'],
    } as unknown as ManagedSession);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has no answer before the host reports a person typing', () => {
    expect(manager.getLastUserInputAt(SESSION_ID)).toBeNull();
    expect(manager.getLastUserInputAt('unknown-session')).toBeNull();
  });

  it('takes the moment the host says the person typed', () => {
    hostReports({ type: 'userInput', sessionId: SESSION_ID, at: 1_700_000_000_000 });

    expect(manager.getLastUserInputAt(SESSION_ID)).toBe(1_700_000_000_000);
  });

  it('moves forward when the host reports a later keystroke', () => {
    hostReports({ type: 'userInput', sessionId: SESSION_ID, at: 1_700_000_000_000 });
    hostReports({ type: 'userInput', sessionId: SESSION_ID, at: 1_700_000_010_000 });

    expect(manager.getLastUserInputAt(SESSION_ID)).toBe(1_700_000_010_000);
  });

  it('falls back to now for a report that carries no moment', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));

    hostReports({ type: 'userInput', sessionId: SESSION_ID });

    expect(manager.getLastUserInputAt(SESSION_ID)).toBe(Date.parse('2026-10-31T12:00:00.000Z'));
  });

  it('is not set by a paste Kangentic marks used', () => {
    manager.markUserInput(SESSION_ID);

    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBe(true);
    expect(manager.getLastUserInputAt(SESSION_ID)).toBeNull();
  });

  it('is not set by a write Kangentic makes through write()', () => {
    const host = (manager as unknown as { host: { post(command: unknown): void } }).host;
    const post = vi.spyOn(host, 'post').mockImplementation(() => undefined);

    manager.write(SESSION_ID, 'a message from an automation\r');

    // The control: the write really went out, and still no person is on record.
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'enqueueWrite' }));
    expect(manager.getLastUserInputAt(SESSION_ID)).toBeNull();
  });

  it('is cleared when the session exits', () => {
    hostReports({ type: 'userInput', sessionId: SESSION_ID, at: 1_700_000_000_000 });
    expect(manager.getLastUserInputAt(SESSION_ID)).toBe(1_700_000_000_000);

    manager.emit('exit', SESSION_ID, 0);

    expect(manager.getLastUserInputAt(SESSION_ID)).toBeNull();
  });
});

/**
 * `automatedKeysBlocker` (task #952): why Kangentic may not type into a session
 * right now. A permission prompt takes typed keys as its answer, so an Enter
 * would approve a tool call nobody saw. The engine's permission flag is one
 * signal; a tool call with no end is the other, because the flag has been
 * cleared early (a parallel subagent's start) with the prompt still on screen.
 *
 * The activity flag is stubbed on the real telemetry, since the engine reaches
 * 'permission' only through its own timers; the open tool call is the real
 * ledger, fed real hook events.
 *
 * Red-green: drop the `'permission'` branch and the first reason test fails;
 * drop the open-call branch and the tool call tests fail; swap the two
 * branches and the ordering test fails.
 */
describe('SessionManager: why Kangentic may not type into a session', () => {
  let manager: SessionManager;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: 'task-1',
      projectId: 'project-1',
      pty: { pid: 1, ptyId: 'pty-1', write: vi.fn() },
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      exitSequence: ['\x03'],
    } as unknown as ManagedSession);
    telemetry = (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
    telemetry.initSession(SESSION_ID);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.restoreAllMocks();
  });

  it('may type into a session with nothing open', () => {
    expect(manager.automatedKeysBlocker(SESSION_ID)).toBeNull();
  });

  it('may not while a permission prompt is open, even with no tool call on record', () => {
    vi.spyOn(telemetry, 'getSessionActivity').mockReturnValue('permission');

    expect(telemetry.getOpenWork(SESSION_ID).toolCalls).toEqual([]);
    expect(manager.automatedKeysBlocker(SESSION_ID)).toBe('a permission prompt is open');
  });

  it('may not while a tool call has not ended, and names the tool', () => {
    telemetry.ingestEvents(SESSION_ID, [
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash', toolId: 'toolu_open', detail: 'npm test' },
    ]);

    // The flag is not set (the engine reads this as plain thinking): the open
    // call alone is what blocks.
    expect(telemetry.getSessionActivity(SESSION_ID)).not.toBe('permission');
    expect(manager.automatedKeysBlocker(SESSION_ID)).toBe('the Bash tool call has not ended');
  });

  it('may type again once that tool call ends', () => {
    telemetry.ingestEvents(SESSION_ID, [
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash', toolId: 'toolu_open', detail: 'npm test' },
    ]);
    expect(manager.automatedKeysBlocker(SESSION_ID)).not.toBeNull();

    telemetry.ingestEvents(SESSION_ID, [
      { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash', toolId: 'toolu_open' },
    ]);

    expect(manager.automatedKeysBlocker(SESSION_ID)).toBeNull();
  });

  it('answers the permission prompt first when a tool call is open too', () => {
    telemetry.ingestEvents(SESSION_ID, [
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Edit', toolId: 'toolu_edit', detail: 'src/a.ts' },
    ]);
    vi.spyOn(telemetry, 'getSessionActivity').mockReturnValue('permission');

    expect(manager.automatedKeysBlocker(SESSION_ID)).toBe('a permission prompt is open');
  });
});
