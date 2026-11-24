import type { AgentAccount, AgentAccountsConfig } from '../../shared/agent-accounts';
import { topAccountWithRoom } from './account-order';
import type { MoveRequestOutcome } from './account-session-move';

export interface AutomaticOrderFollowerDependencies {
  readConfig(): AgentAccountsConfig;
  /** The agents with two or more accounts: the only ones whose top account can change. */
  agents(): string[];
  /** The agent's list follows the order mode (it reports usage, so Automatic sorts it). */
  followsOrderMode(agent: string): boolean;
  /** The agent's running sessions can move to another account (`sessionsCanMove`). */
  sessionsCanMove(agent: string): boolean;
  /** The agent's accounts in run order. */
  ordered(agent: string): AgentAccount[];
  /** Moves the agent's running sessions to the account at their first safe point. */
  request(agent: string, accountId: string): Promise<MoveRequestOutcome>;
  /** Drops the moves this follower asked for that still wait (`SessionAccountMover.cancelFollowing`). */
  cancelFollowing(agent: string): void;
  /** Some of the agent's sessions are moving to `account`: one notice per order change. */
  notifyFollowing(agent: string, account: AgentAccount): void;
  reportFailure(error: unknown): void;
  now?: () => number;
}

/**
 * Under Automatic order, running sessions follow the Active account (task #1200). Automatic
 * puts first the account whose longest window resets soonest, so its allowance is used before it
 * resets. Once that reset passes, another account leads, and a session left on the old one spends
 * a new week while the new leader's last days run out unused.
 *
 * `evaluate` runs after each usage read and each pass of the refresher, whose reset timer fires
 * just after a window resets, and after the accounts settings change. Never on every
 * `accounts:changed` push: a dogfood app sent about 2,000 of those in one day. It compares the
 * agent's top account with room (`topAccountWithRoom`, never the first row, so a full account is
 * never the target) with the one it last saw, and moves sessions only when that changed. A
 * reading that leaves the top alone moves nothing, so sessions never flip back and forth between
 * resets: a resume on another account starts with a cold prompt cache.
 *
 * The first look at an agent (a launch, or a switch back to Automatic) also asks: sessions not on
 * the top account move there. Startup recovery already puts them there, so this is normally a
 * no-op.
 */
export class AutomaticOrderFollower {
  /** Each agent's top account with room as last seen under Automatic. */
  private readonly lastTop = new Map<string, string | null>();

  constructor(private readonly dependencies: AutomaticOrderFollowerDependencies) {}

  private nowSeconds(): number {
    return Math.floor((this.dependencies.now?.() ?? Date.now()) / 1000);
  }

  evaluate(): void {
    const automatic = this.dependencies.readConfig().orderMode === 'automatic';
    for (const agent of this.dependencies.agents()) {
      if (!automatic || !this.dependencies.followsOrderMode(agent) || !this.dependencies.sessionsCanMove(agent)) {
        // Manual keeps the saved order, and a switch back to Automatic looks afresh. A session still
        // waiting to follow the old top account stays where it runs.
        if (this.lastTop.delete(agent)) this.dependencies.cancelFollowing(agent);
        continue;
      }
      const top = topAccountWithRoom(this.dependencies.ordered(agent), this.nowSeconds());
      const topId = top?.id ?? null;
      const seen = this.lastTop.has(agent);
      if (seen && this.lastTop.get(agent) === topId) continue;
      this.lastTop.set(agent, topId);
      // Every account full: nothing has room to move to, and the continuation waits it out.
      if (!top) continue;
      void this.dependencies.request(agent, top.id).then((outcome) => {
        if (outcome.moved + outcome.pending > 0) this.dependencies.notifyFollowing(agent, top);
      }).catch((error: unknown) => {
        // report-ok: handed to `reportFailure`, which the accounts handler binds to its chokepoint reporter.
        this.dependencies.reportFailure(error);
      });
    }
  }
}
