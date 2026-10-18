import type { SessionEvent } from '../../shared/types';

/** One reported change of a session's plan mode, stamped on the app's clock. */
interface PlanModeChange {
  at: number;
  planMode: boolean;
}

/**
 * Enough changes for any real session: a plan, its exit, and a few re-plans.
 * A cut drops the oldest change, which can be the plan report before the
 * oldest exit kept, so a moment before the oldest plan report kept answers
 * false. The runner asks about a move inside the turn that is ending, a few
 * reports back at most.
 */
const MAX_CHANGES_PER_SESSION = 32;

/**
 * The plan mode each session's agent reported (`SessionEvent.planMode`), kept
 * as the changes between reports so a reader can ask what held at a past
 * moment. The turn-end runner asks it whether a task dragged mid-turn into its
 * column's plan exit target had already left plan mode at the move, which makes
 * the rest of the turn the target column's work.
 *
 * Stamped when main ingests the event, never with `event.ts`: the bridge stamps
 * `ts` on the agent host's clock, which a WSL guest lets drift from the app's,
 * and the move it is compared with is stamped on the app's.
 */
export class PlanModeTrail {
  private readonly changes = new Map<string, PlanModeChange[]>();

  /** Record the event's report, if it carries one and it differs from the last. */
  note(sessionId: string, event: SessionEvent, at: number): void {
    if (event.planMode === undefined) return;
    let trail = this.changes.get(sessionId);
    if (!trail) {
      trail = [];
      this.changes.set(sessionId, trail);
    }
    if (trail.length > 0 && trail[trail.length - 1].planMode === event.planMode) return;
    trail.push({ at, planMode: event.planMode });
    if (trail.length > MAX_CHANGES_PER_SESSION) trail.shift();
  }

  /**
   * Had the session left plan mode by `atMs`: an earlier report said plan mode,
   * and the last report at or before `atMs` said it was out? False when it was
   * still in plan mode, was never reported in it, or reported nothing by then.
   */
  hadLeftPlanModeBy(sessionId: string, atMs: number): boolean {
    const trail = this.changes.get(sessionId);
    if (!trail) return false;
    const reportedBy = trail.filter((change) => change.at <= atMs);
    const last = reportedBy[reportedBy.length - 1];
    if (!last || last.planMode) return false;
    return reportedBy.some((change) => change.planMode);
  }

  removeSession(sessionId: string): void {
    this.changes.delete(sessionId);
  }
}
