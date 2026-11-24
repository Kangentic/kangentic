/**
 * SessionAccountMover (task #1200): moves running sessions to another account, each at its first
 * safe point, and never cuts work in flight. Runs the real mover over fake sessions. Tier: Unit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECHECK_AFTER_TOOL_END_MS,
  SessionAccountMover,
  type RestartOutcome,
  type RunningSession,
  type SafePoint,
  type SessionAccountMoverDependencies,
} from '../../src/main/accounts/account-session-move';
import type { AgentAccount } from '../../src/shared/agent-accounts';

const AGENT = 'test-agent';

function account(id: string, email: string | null = `${id}@example.com`, orgId: string | null = null): AgentAccount {
  return {
    id, agent: AGENT, kind: 'folder', folderPath: null, keyFilePath: null, keyNames: [], email, orgId, plan: null,
    status: 'ok', position: 1, historyPrivate: false, lastUsage: null, lastUsageAt: null, absentWindowIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

interface Harness {
  mover: SessionAccountMover;
  sessions: Map<string, RunningSession>;
  points: Map<string, SafePoint>;
  drafts: Set<string>;
  handledElsewhere: Set<string>;
  restartOn: ReturnType<typeof vi.fn>;
}

function harness(options: { accounts?: AgentAccount[]; restart?: (session: RunningSession, accountId: string) => Promise<RestartOutcome> } = {}): Harness {
  const sessions = new Map<string, RunningSession>();
  const points = new Map<string, SafePoint>();
  const drafts = new Set<string>();
  const handledElsewhere = new Set<string>();
  const accounts = options.accounts ?? [account('one'), account('two'), account('three')];
  const restartOn = vi.fn(async (session: RunningSession, accountId: string): Promise<RestartOutcome> => {
    const outcome = options.restart ? await options.restart(session, accountId) : 'moved';
    // A moved session comes back under a new id on the account it moved to.
    if (outcome === 'moved') sessions.delete(session.sessionId);
    return outcome;
  });
  const dependencies: SessionAccountMoverDependencies = {
    listRunning: (agent) => [...sessions.values()].filter((session) => session.agent === agent),
    findRunning: (sessionId) => sessions.get(sessionId) ?? null,
    accountsOf: () => accounts,
    isHandledElsewhere: (sessionId) => handledElsewhere.has(sessionId),
    // A session the test names nothing for sits idle; a null it set means "not now".
    safePoint: async (sessionId) => (points.has(sessionId) ? points.get(sessionId) ?? null : 'idle'),
    hasDraft: async (sessionId) => drafts.has(sessionId),
    restartOn,
    reportFailure: vi.fn(),
  };
  return { mover: new SessionAccountMover(dependencies), sessions, points, drafts, handledElsewhere, restartOn };
}

function addSession(target: Harness, sessionId: string, accountId: string | null, kind: RunningSession['kind'] = 'task'): RunningSession {
  const session: RunningSession = { sessionId, kind, projectId: 'project-1', ownerId: `owner-${sessionId}`, agent: AGENT, accountId };
  target.sessions.set(sessionId, session);
  return session;
}

/** Lets the mover's queued looks run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionAccountMover', () => {
  it('moves an idle session at once, with nothing sent to it', async () => {
    const target = harness();
    const session = addSession(target, 'idle', 'one');
    expect(await target.mover.request(AGENT, 'two')).toEqual({ moved: 1, pending: 0, failed: 0 });
    expect(target.restartOn).toHaveBeenCalledWith(session, 'two', 'idle');
  });

  it('moves a session between two tools, once its results are written, told to continue', async () => {
    const target = harness();
    const session = addSession(target, 'working', 'one');
    target.points.set('working', 'between-tools');
    expect(await target.mover.request(AGENT, 'two')).toMatchObject({ moved: 1 });
    expect(target.restartOn).toHaveBeenCalledWith(session, 'two', 'between-tools');
  });

  it('waits through a tool in flight, a prompt or a background job, and moves at the first safe point', async () => {
    const target = harness();
    addSession(target, 'busy', 'one');
    target.points.set('busy', null);
    expect(await target.mover.request(AGENT, 'two')).toEqual({ moved: 0, pending: 1, failed: 0 });
    expect(target.mover.isPending('busy')).toBe(true);

    // Still busy: a look changes nothing.
    target.mover.check('busy');
    await settle();
    expect(target.restartOn).not.toHaveBeenCalled();

    target.points.set('busy', 'between-tools');
    target.mover.check('busy');
    await settle();
    expect(target.restartOn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'busy' }), 'two', 'between-tools');
    expect(target.mover.isPending('busy')).toBe(false);
  });

  it('looks again after a tool end, on a schedule, since the result reaches the transcript later', async () => {
    vi.useFakeTimers();
    const target = harness();
    addSession(target, 'working', 'one');
    target.points.set('working', null);
    await target.mover.request(AGENT, 'two');
    target.mover.noteToolEnded('working');
    // The result lands between the second and third look.
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_TOOL_END_MS[1]);
    expect(target.restartOn).not.toHaveBeenCalled();
    target.points.set('working', 'between-tools');
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_TOOL_END_MS[2] - RECHECK_AFTER_TOOL_END_MS[1]);
    expect(target.restartOn).toHaveBeenCalledTimes(1);
  });

  it('drops the looks still scheduled once the next tool starts', async () => {
    vi.useFakeTimers();
    const target = harness();
    addSession(target, 'working', 'one');
    target.points.set('working', null);
    await target.mover.request(AGENT, 'two');
    target.mover.noteToolEnded('working');
    target.mover.dropRechecks('working');
    target.points.set('working', 'between-tools');
    await vi.advanceTimersByTimeAsync(RECHECK_AFTER_TOOL_END_MS[RECHECK_AFTER_TOOL_END_MS.length - 1] + 1);
    expect(target.restartOn).not.toHaveBeenCalled();
  });

  it('never moves a session with a draft in its input box, and moves it once the draft is gone', async () => {
    const target = harness();
    addSession(target, 'drafting', 'one');
    target.drafts.add('drafting');
    expect(await target.mover.request(AGENT, 'two')).toMatchObject({ moved: 0, pending: 1 });
    target.drafts.delete('drafting');
    target.mover.check('drafting');
    await settle();
    expect(target.restartOn).toHaveBeenCalledTimes(1);
  });

  it('keeps a move the restart deferred, because the session left its safe point under the lock', async () => {
    let outcome: RestartOutcome = 'deferred';
    const target = harness({ restart: async () => outcome });
    addSession(target, 'raced', 'one');
    expect(await target.mover.request(AGENT, 'two')).toMatchObject({ moved: 0, pending: 1 });
    outcome = 'moved';
    target.mover.check('raced');
    await settle();
    expect(target.restartOn).toHaveBeenCalledTimes(2);
    expect(target.mover.isPending('raced')).toBe(false);
  });

  it('drops a waiting move when the order comes back to the account the session runs on', async () => {
    const target = harness();
    addSession(target, 'busy', 'one');
    target.points.set('busy', null);
    await target.mover.request(AGENT, 'two');
    expect(target.mover.isPending('busy')).toBe(true);
    await target.mover.request(AGENT, 'one');
    expect(target.mover.isPending('busy')).toBe(false);
    target.points.set('busy', 'idle');
    target.mover.check('busy');
    await settle();
    expect(target.restartOn).not.toHaveBeenCalled();
  });

  it('moves a waiting session to the newest target when the order changes again', async () => {
    const target = harness();
    addSession(target, 'busy', 'one');
    target.points.set('busy', null);
    await target.mover.request(AGENT, 'two');
    await target.mover.request(AGENT, 'three');
    target.points.set('busy', 'idle');
    target.mover.check('busy');
    await settle();
    expect(target.restartOn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'busy' }), 'three', 'idle');
  });

  it('moves the replacement to a target a newer request named while the restart ran', async () => {
    let releaseRestart: () => void = () => undefined;
    const target = harness({
      restart: (session, accountId) => new Promise<RestartOutcome>((resolve) => {
        if (accountId === 'two') {
          releaseRestart = () => {
            // The restart lands: the old row goes and its replacement runs on 'two'.
            addSession(target, `${session.sessionId}-next`, 'two');
            resolve('moved');
          };
        } else {
          resolve('moved');
        }
      }),
    });
    addSession(target, 'idle', 'one');
    const first = target.mover.request(AGENT, 'two');
    await settle();
    // The order moves on while the restart to 'two' is still running.
    const second = target.mover.request(AGENT, 'three');
    releaseRestart();
    await first;
    await second;
    await settle();
    expect(target.restartOn).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'idle-next' }), 'three', 'idle');
  });

  it('cancels the moves Automatic order asked for, and keeps the ones Switch to asked for', async () => {
    const target = harness();
    addSession(target, 'followed', 'one');
    target.points.set('followed', null);
    await target.mover.request(AGENT, 'two', 'follow');
    target.mover.cancelFollowing(AGENT);
    expect(target.mover.isPending('followed')).toBe(false);

    await target.mover.request(AGENT, 'two', 'switch');
    target.mover.cancelFollowing(AGENT);
    expect(target.mover.isPending('followed')).toBe(true);
  });

  it('does not count a session that ended during a look as still waiting', async () => {
    const target = harness();
    addSession(target, 'ending', 'one');
    let releaseDraftRead: (hasDraft: boolean) => void = () => undefined;
    const harnessWithSlowDraft = new SessionAccountMover({
      listRunning: () => [...target.sessions.values()],
      findRunning: (sessionId) => target.sessions.get(sessionId) ?? null,
      accountsOf: () => [account('one'), account('two')],
      isHandledElsewhere: () => false,
      safePoint: async () => 'idle',
      hasDraft: () => new Promise<boolean>((resolve) => { releaseDraftRead = resolve; }),
      restartOn: target.restartOn,
      reportFailure: vi.fn(),
    });
    const outcome = harnessWithSlowDraft.request(AGENT, 'two');
    await settle();
    harnessWithSlowDraft.forget('ending');
    releaseDraftRead(false);
    expect(await outcome).toEqual({ moved: 0, pending: 0, failed: 0 });
  });

  it('forgets a session that ended while it waited', async () => {
    const target = harness();
    addSession(target, 'gone', 'one');
    target.points.set('gone', null);
    await target.mover.request(AGENT, 'two');
    target.mover.forget('gone');
    target.points.set('gone', 'idle');
    target.mover.check('gone');
    await settle();
    expect(target.restartOn).not.toHaveBeenCalled();
  });

  it('leaves alone a session already on the target, another row of its login, or one accounts do not apply to', async () => {
    const target = harness({ accounts: [account('one'), account('two', 'shared@example.com'), account('two-again', 'shared@example.com')] });
    addSession(target, 'there', 'two');
    addSession(target, 'same-login', 'two-again');
    addSession(target, 'wsl', null);
    expect(await target.mover.request(AGENT, 'two')).toEqual({ moved: 0, pending: 0, failed: 0 });
    expect(target.restartOn).not.toHaveBeenCalled();
  });

  it('leaves a session the usage-limit continuation holds to the continuation', async () => {
    const target = harness();
    addSession(target, 'at-limit', 'one');
    target.handledElsewhere.add('at-limit');
    expect(await target.mover.request(AGENT, 'two')).toMatchObject({ moved: 0, pending: 1 });
    expect(target.restartOn).not.toHaveBeenCalled();
  });

  it('restarts one at a time, and a restart that fails or throws does not stop the rest or retry', async () => {
    let running = 0;
    let mostAtOnce = 0;
    const target = harness({
      restart: async (session) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await Promise.resolve();
        running -= 1;
        if (session.sessionId === 'throws') throw new Error('suspend failed');
        return session.sessionId === 'refused' ? 'failed' : 'moved';
      },
    });
    addSession(target, 'throws', 'one');
    addSession(target, 'refused', 'one');
    addSession(target, 'fine', 'one', 'command-terminal');
    expect(await target.mover.request(AGENT, 'two')).toEqual({ moved: 1, pending: 0, failed: 2 });
    expect(mostAtOnce).toBe(1);
    expect(target.mover.isPending('throws')).toBe(false);
    expect(target.mover.isPending('refused')).toBe(false);
  });
});
