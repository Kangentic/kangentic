/**
 * AutomaticOrderFollower (task #1200): running sessions follow Automatic order's top account with
 * room, and only when it changes. Replays 2026-11-24 on a fixed clock: account 2's weekly window
 * reset at 15:00Z and the agent's own login moved to the top. Tier: Unit.
 */
import { describe, expect, it, vi } from 'vitest';
import { automaticOrder } from '../../src/main/accounts/account-order';
import { AutomaticOrderFollower } from '../../src/main/accounts/account-order-follow';
import type { AgentAccount, AgentAccountsConfig } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';

const AGENT = 'claude';
const WEEK_SECONDS = 7 * 86_400;
const at = (iso: string): number => Date.parse(iso);
const seconds = (iso: string): number => Date.parse(iso) / 1000;

function weekly(usedPercentage: number, resetsAtIso: string): RateLimitWindow {
  return { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt: seconds(resetsAtIso), windowDurationSeconds: WEEK_SECONDS };
}

function account(id: string, position: number, lastUsage: RateLimitWindow[]): AgentAccount {
  return {
    id, agent: AGENT, kind: id === 'own' ? 'default' : 'folder', folderPath: null, keyFilePath: null, keyNames: [],
    email: `${id}@example.com`, orgId: null, plan: 'Max', status: 'ok', position, historyPrivate: false,
    lastUsage, lastUsageAt: '2026-11-24T14:00:00.000Z', absentWindowIds: [], createdAt: '2026-01-01T00:00:00.000Z',
  };
}

interface Harness {
  follower: AutomaticOrderFollower;
  accounts: AgentAccount[];
  config: AgentAccountsConfig;
  setNow: (iso: string) => void;
  request: ReturnType<typeof vi.fn>;
  notifyFollowing: ReturnType<typeof vi.fn>;
  cancelFollowing: ReturnType<typeof vi.fn>;
}

function harness(options: { sessionsCanMove?: boolean; moving?: number } = {}): Harness {
  let nowMs = at('2026-11-24T14:26:00Z');
  const config: AgentAccountsConfig = { orderMode: 'automatic', autoSwitchAtLimit: true };
  const accounts = [
    account('own', 1, [weekly(86, '2026-11-26T09:00:00Z')]),
    account('two', 2, [weekly(68, '2026-11-24T15:00:00Z')]),
    account('three', 3, [weekly(20, '2026-11-29T00:00:00Z')]),
  ];
  const request = vi.fn(async () => ({ moved: options.moving ?? 1, pending: 0, failed: 0 }));
  const notifyFollowing = vi.fn();
  const cancelFollowing = vi.fn();
  const follower = new AutomaticOrderFollower({
    readConfig: () => config,
    agents: () => [AGENT],
    followsOrderMode: () => true,
    sessionsCanMove: () => options.sessionsCanMove ?? true,
    ordered: () => (config.orderMode === 'automatic' ? automaticOrder(accounts, Math.floor(nowMs / 1000)) : accounts),
    request,
    cancelFollowing,
    notifyFollowing,
    reportFailure: vi.fn(),
    now: () => nowMs,
  });
  return { follower, accounts, config, setNow: (iso) => { nowMs = at(iso); }, request, notifyFollowing, cancelFollowing };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('AutomaticOrderFollower', () => {
  it('moves running sessions to the agent\'s own login once account 2\'s week resets', async () => {
    const target = harness();
    // 14:26Z: account 2's week resets soonest, so it leads; the first look asks for it.
    target.follower.evaluate();
    expect(target.request).toHaveBeenLastCalledWith(AGENT, 'two');

    // 15:00:30Z, the refresher's pass after the reset: account 2 read a new week to Dec 1.
    target.setNow('2026-11-24T15:00:30Z');
    target.accounts[1].lastUsage = [weekly(0, '2026-12-01T15:00:00Z')];
    target.follower.evaluate();
    expect(target.request).toHaveBeenLastCalledWith(AGENT, 'own');
    expect(target.request).toHaveBeenCalledTimes(2);
    await settle();
    expect(target.notifyFollowing).toHaveBeenLastCalledWith(AGENT, expect.objectContaining({ id: 'own' }));
  });

  it('catches a reset on the clock alone: an expired longest window sorts its account last', () => {
    const target = harness();
    target.follower.evaluate();
    // The reset passed and the read after it failed, so account 2 keeps its old reading.
    target.setNow('2026-11-24T15:00:30Z');
    target.follower.evaluate();
    expect(target.request).toHaveBeenLastCalledWith(AGENT, 'own');
  });

  it('asks nothing for a reading that leaves the top account where it was', () => {
    const target = harness();
    target.follower.evaluate();
    target.accounts[0].lastUsage = [weekly(91, '2026-11-26T09:00:00Z')];
    target.accounts[1].lastUsage = [weekly(74, '2026-11-24T15:00:00Z')];
    target.follower.evaluate();
    target.follower.evaluate();
    expect(target.request).toHaveBeenCalledTimes(1);
  });

  it('never targets a full account: the top account with room leads instead', () => {
    const target = harness();
    target.accounts[1].lastUsage = [weekly(100, '2026-11-24T15:00:00Z')];
    target.follower.evaluate();
    expect(target.request).toHaveBeenLastCalledWith(AGENT, 'own');
  });

  it('asks nothing when every account is full', () => {
    const target = harness();
    for (const entry of target.accounts) entry.lastUsage = [weekly(100, '2026-11-30T00:00:00Z')];
    target.follower.evaluate();
    expect(target.request).not.toHaveBeenCalled();
  });

  it('asks nothing under Manual, and looks afresh when the order goes back to Automatic', () => {
    const target = harness();
    target.config.orderMode = 'manual';
    target.follower.evaluate();
    expect(target.request).not.toHaveBeenCalled();
    // Nothing was followed yet, so there is nothing to cancel.
    expect(target.cancelFollowing).not.toHaveBeenCalled();
    target.config.orderMode = 'automatic';
    target.follower.evaluate();
    expect(target.request).toHaveBeenLastCalledWith(AGENT, 'two');
  });

  it('cancels the moves it asked for once the order goes to Manual', () => {
    const target = harness();
    target.follower.evaluate();
    expect(target.request).toHaveBeenLastCalledWith(AGENT, 'two');
    target.config.orderMode = 'manual';
    target.follower.evaluate();
    expect(target.cancelFollowing).toHaveBeenCalledWith(AGENT);
  });

  it('asks nothing for an agent whose conversations stay on their account', () => {
    const target = harness({ sessionsCanMove: false });
    target.follower.evaluate();
    expect(target.request).not.toHaveBeenCalled();
  });

  it('raises no notice when no session was there to move', async () => {
    const target = harness({ moving: 0 });
    target.follower.evaluate();
    await settle();
    expect(target.notifyFollowing).not.toHaveBeenCalled();
  });
});
