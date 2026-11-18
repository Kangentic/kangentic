import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAccount } from '../../src/shared/agent-accounts';
import {
  createTaskAccountSwitcher,
  type SwitchableSession,
  type TaskAccountSwitcherDependencies,
  type TaskAccountSwitcherHandle,
} from '../../src/main/accounts/account-task-switch';

const BOUND_MS = 60_000;

function makeAccount(overrides: Partial<AgentAccount> & Pick<AgentAccount, 'id' | 'email'>): AgentAccount {
  return {
    agent: 'claude',
    kind: 'folder',
    folderPath: null,
    keyFilePath: null,
    keyNames: [],
    orgId: null,
    plan: null,
    status: 'ok',
    position: 1,
    historyPrivate: false,
    lastUsage: null,
    lastUsageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  handle: TaskAccountSwitcherHandle;
  restartOn: ReturnType<typeof vi.fn>;
  reportFailure: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  fireTurnEnded: (sessionId: string) => void;
  state: { live: SwitchableSession | null; canMove: boolean | null; accounts: AgentAccount[]; agent: string | undefined };
}

function build(accounts: AgentAccount[], liveAccountId: string | null): Harness {
  const state: Harness['state'] = {
    live: { id: 'session-1', projectId: 'project-1', accountId: liveAccountId },
    canMove: true,
    accounts,
    agent: 'claude',
  };
  const listeners = new Set<(sessionId: string) => void>();
  const unsubscribe = vi.fn();
  const restartOn = vi.fn().mockResolvedValue(true);
  const reportFailure = vi.fn();
  const dependencies: TaskAccountSwitcherDependencies = {
    liveSession: () => state.live,
    agentOf: () => state.agent,
    sessionsCanMove: () => state.canMove,
    ordered: () => state.accounts,
    onTurnEnded: (listener) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    },
    restartOn,
    reportFailure,
    turnEndBoundMs: BOUND_MS,
  };
  return {
    handle: createTaskAccountSwitcher(dependencies),
    restartOn,
    reportFailure,
    unsubscribe,
    fireTurnEnded: (sessionId) => {
      for (const listener of [...listeners]) listener(sessionId);
    },
    state,
  };
}

const alice = makeAccount({ id: 'a', email: 'alice@example.com', position: 1 });
const bob = makeAccount({ id: 'b', email: 'bob@example.com', position: 2 });
const carol = makeAccount({ id: 'c', email: 'carol@example.com', position: 3 });
const dave = makeAccount({ id: 'd', email: 'dave@example.com', position: 4, status: 'signed-out' });

describe('createTaskAccountSwitcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('refusals', () => {
    it('refuses with no live session', async () => {
      const harness = build([alice, bob], 'a');
      harness.state.live = null;
      const result = await harness.handle.switchAccount('task-1', 'bob@example.com');
      expect(result).toMatchObject({ ok: false, reason: 'no-session' });
    });

    it('refuses when the agent has no accounts', async () => {
      const harness = build([alice, bob], 'a');
      harness.state.canMove = null;
      const result = await harness.handle.switchAccount('task-1', 'bob@example.com');
      expect(result).toMatchObject({ ok: false, reason: 'no-accounts' });
    });

    it('refuses when conversations stay on their account', async () => {
      const harness = build([alice, bob], 'a');
      harness.state.canMove = false;
      const result = await harness.handle.switchAccount('task-1', 'bob@example.com');
      expect(result).toMatchObject({ ok: false, reason: 'stays-on-account' });
    });

    it('refuses an unknown name and lists the ok accounts other than the current one', async () => {
      const harness = build([alice, bob, carol, dave], 'a');
      const result = await harness.handle.switchAccount('task-1', 'nobody@example.com');
      expect(result).toEqual({
        ok: false,
        reason: 'unknown-account',
        runnable: ['bob@example.com', 'carol@example.com'],
        current: 'alice@example.com',
      });
      expect(harness.restartOn).not.toHaveBeenCalled();
    });

    it('refuses an account that is not signed in', async () => {
      const harness = build([alice, bob, dave], 'a');
      const result = await harness.handle.switchAccount('task-1', 'dave@example.com');
      expect(result).toMatchObject({ ok: false, reason: 'not-signed-in' });
    });

    it('refuses the current account, matching case-insensitively', async () => {
      const harness = build([alice, bob], 'a');
      const result = await harness.handle.switchAccount('task-1', 'ALICE@Example.com');
      expect(result).toMatchObject({ ok: false, reason: 'already-on-account', current: 'alice@example.com' });
    });

    it('refuses another row with the same login', async () => {
      const twin = makeAccount({ id: 't', email: 'Alice@example.com', position: 5 });
      const harness = build([alice, bob, twin], 'a');
      const result = await harness.handle.switchAccount('task-1', 'alice@example.com');
      expect(result).toMatchObject({ ok: false, reason: 'already-on-account' });
    });

    it('matches names case-insensitively when switching', async () => {
      const harness = build([alice, bob], 'a');
      const result = await harness.handle.switchAccount('task-1', 'BOB@EXAMPLE.COM');
      expect(result).toEqual({ ok: true, accountName: 'bob@example.com', agent: 'claude' });
    });
  });

  describe('one email in two organizations', () => {
    const rowA = makeAccount({ id: 'org-a-row', email: 'shared@example.com', orgId: 'org-a', status: 'replaced' });
    const rowB = makeAccount({ id: 'org-b-row', email: 'shared@example.com', orgId: 'org-b', position: 2 });

    it('picks the row that can run when the other is replaced', async () => {
      const harness = build([rowA, rowB], rowA.id);
      const result = await harness.handle.switchAccount('task-1', 'shared@example.com');
      expect(result).toMatchObject({ ok: true });
      harness.fireTurnEnded('session-1');
      expect(harness.restartOn).toHaveBeenCalledWith(
        { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1' },
        'org-b-row',
        expect.any(String),
      );
    });

    it('picks the other organization when both are ok and the session is on A', async () => {
      const bothOkay = { ...rowA, status: 'ok' as const };
      const harness = build([bothOkay, rowB], bothOkay.id);
      const result = await harness.handle.switchAccount('task-1', 'shared@example.com');
      expect(result).toMatchObject({ ok: true });
      harness.fireTurnEnded('session-1');
      expect(harness.restartOn).toHaveBeenCalledTimes(1);
      expect(harness.restartOn.mock.calls[0][1]).toBe('org-b-row');
    });
  });

  describe('restart timing', () => {
    it('answers ok at once and restarts only when the live session turn ends', async () => {
      const harness = build([alice, bob], 'a');
      const result = await harness.handle.switchAccount('task-1', 'bob@example.com');
      expect(result).toEqual({ ok: true, accountName: 'bob@example.com', agent: 'claude' });
      expect(harness.restartOn).not.toHaveBeenCalled();

      harness.fireTurnEnded('some-other-session');
      expect(harness.restartOn).not.toHaveBeenCalled();

      harness.fireTurnEnded('session-1');
      expect(harness.restartOn).toHaveBeenCalledTimes(1);
      const [target, accountId, prompt] = harness.restartOn.mock.calls[0];
      expect(target).toEqual({ sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1' });
      expect(accountId).toBe('b');
      expect(prompt).toContain('bob@example.com');
    });

    it('restarts once at the bound when no turn ends, then ignores a late turn end', async () => {
      const harness = build([alice, bob], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
      expect(harness.restartOn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.restartOn).toHaveBeenCalledTimes(1);
      expect(harness.unsubscribe).toHaveBeenCalled();

      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
      expect(harness.restartOn).toHaveBeenCalledTimes(1);
    });

    it('does not fire the bound after the turn already ended it', async () => {
      const harness = build([alice, bob], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
      expect(harness.restartOn).toHaveBeenCalledTimes(1);
    });
  });

  describe('last request wins', () => {
    it('restarts once, on the last account asked for', async () => {
      const harness = build([alice, bob, carol], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      await harness.handle.switchAccount('task-1', 'carol@example.com');
      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
      expect(harness.restartOn).toHaveBeenCalledTimes(1);
      expect(harness.restartOn.mock.calls[0][1]).toBe('c');
    });

    it('cancels a pending switch when a later call answers already-on-account', async () => {
      const harness = build([alice, bob], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      const stay = await harness.handle.switchAccount('task-1', 'alice@example.com');
      expect(stay).toMatchObject({ ok: false, reason: 'already-on-account' });
      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
      expect(harness.restartOn).not.toHaveBeenCalled();
      expect(harness.unsubscribe).toHaveBeenCalled();
    });
  });

  describe('restart time checks', () => {
    it('does not restart when the live session is gone', async () => {
      const harness = build([alice, bob], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      harness.state.live = null;
      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
      expect(harness.restartOn).not.toHaveBeenCalled();
    });

    it('does not restart when the live session is another id', async () => {
      const harness = build([alice, bob], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      harness.state.live = { id: 'session-2', projectId: 'project-1', accountId: 'a' };
      await vi.advanceTimersByTimeAsync(BOUND_MS);
      expect(harness.restartOn).not.toHaveBeenCalled();
    });

    it('reports a rejected restart', async () => {
      const harness = build([alice, bob], 'a');
      const failure = new Error('restart failed');
      harness.restartOn.mockRejectedValue(failure);
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.reportFailure).toHaveBeenCalledTimes(1);
      expect(harness.reportFailure).toHaveBeenCalledWith(failure);
    });
  });

  describe('dispose', () => {
    it('cancels a pending switch and removes the listener', async () => {
      const harness = build([alice, bob], 'a');
      await harness.handle.switchAccount('task-1', 'bob@example.com');
      harness.handle.dispose();
      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
      harness.fireTurnEnded('session-1');
      await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
      expect(harness.restartOn).not.toHaveBeenCalled();
    });
  });
});
