import { AgentTool, EventType, IdleReason } from '../../shared/types';
import type { SessionEvent } from '../../shared/types';

/**
 * Keeps a plan Kangentic approves from ever reading as "needs you".
 *
 * The agent raises its plan approval prompt as a permission request, and two
 * hooks answer that one request in parallel: the catch-all permission hook,
 * which reports the session as waiting on the user, and the plan approval hook
 * (`plan-approval-bridge.js`), which approves the plan and writes a
 * `plan_approval_sent` marker. Either can land first. Measured on Claude Code
 * 2.1.302, the permission idle led the marker by 24 to 31 ms in all four runs,
 * and the plan exit's ToolEnd followed the marker 130 to 170 ms later.
 *
 * Letting that idle through would flip the card to amber, raise the desktop
 * "Needs permission" notification and push the phone, all for a prompt nobody
 * has to answer. So, before anything else in the pipeline reads it:
 *
 * - a plan-exit permission idle, for a session whose decision approves plans or
 *   that has a fresh marker, is held for `PLAN_APPROVAL_HOLD_MS`. The marker
 *   restarts that wait, since the CLI acts on the answer after it;
 * - the plan exit's ToolEnd drops it. Only that proves the plan was approved:
 *   the marker proves only that the answer was sent, and the CLI can refuse it.
 *   On timeout the idle is processed late, so an approver that failed, or an
 *   answer the CLI refused, still shows the dialog as "needs you";
 * - the ToolEnd that follows a marker is followed by `plan_auto_approved`,
 *   which is what the activity log draws and the engine re-stamps a turn on;
 * - once the session's agent has ended (`end`), nothing is held: a held idle is
 *   dropped with the session, and a late one passes straight through.
 *
 * Only an idle whose tool is the plan exit is ever held or dropped. A question
 * the agent asks the user, or any other permission prompt, passes untouched.
 */

/**
 * How long a plan-exit permission idle waits for the plan exit's ToolEnd. On
 * Claude Code 2.1.302 the marker followed the idle by at most 31 ms and the
 * ToolEnd followed the marker by at most 170 ms.
 */
export const PLAN_APPROVAL_HOLD_MS = 2_000;

/** How long a marker stays fresh. The ToolEnd it pairs with arrived within 170 ms. */
export const PLAN_APPROVAL_MARKER_WINDOW_MS = 15_000;

export interface PlanApprovalGateOptions {
  /** Whether this session's current decision approves plans (`PlanApprovalWriter.approves`). */
  approvesPlans(sessionId: string): boolean;
  /** Run a held event through the rest of the pipeline, late. */
  release(sessionId: string, event: SessionEvent): void;
  now?(): number;
}

interface Marker {
  at: number;
  detail: string | null;
}

interface Held {
  event: SessionEvent;
  timer: ReturnType<typeof setTimeout>;
}

function isPlanExitPermissionIdle(event: SessionEvent): boolean {
  return event.type === EventType.Idle
    && event.detail === IdleReason.Permission
    && event.tool === AgentTool.ExitPlanMode;
}

export class PlanApprovalGate {
  private readonly markers = new Map<string, Marker>();
  private readonly held = new Map<string, Held>();
  /** Sessions whose agent has ended (`end`), until they are cleared. */
  private readonly ended = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: PlanApprovalGateOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The events to process now, in order, for one event that arrived. */
  admit(sessionId: string, event: SessionEvent): SessionEvent[] {
    if (event.type === EventType.PlanApprovalSent) {
      this.markers.set(sessionId, { at: this.now(), detail: event.detail ?? null });
      // The answer is sent, not yet taken: a held prompt now waits for the
      // ToolEnd the CLI reports once it acts on it.
      const current = this.held.get(sessionId);
      if (current) this.hold(sessionId, current.event);
      return [event];
    }

    if (isPlanExitPermissionIdle(event)) {
      if (this.ended.has(sessionId)) return [event];
      if (!this.freshMarker(sessionId) && !this.options.approvesPlans(sessionId)) return [event];
      this.hold(sessionId, event);
      return [];
    }

    if (event.type === EventType.ToolEnd && event.tool === AgentTool.ExitPlanMode) {
      // The plan was approved: a held prompt no longer waits on anyone.
      this.dropHeld(sessionId);
      const marker = this.freshMarker(sessionId);
      if (!marker) return [event];
      this.markers.delete(sessionId);
      return [event, { ts: this.now(), type: EventType.PlanAutoApproved, detail: marker.detail ?? undefined }];
    }

    return [event];
  }

  /**
   * The session's agent has ended (its PTY exited or was killed). A held idle
   * is dropped, since nobody can answer it now, and nothing more is held, so an
   * idle the exit's last flush reads is never released after the session end.
   */
  end(sessionId: string): void {
    this.dropHeld(sessionId);
    this.ended.add(sessionId);
  }

  /** Forget a session (removed, or its tracking cleared). A held idle is dropped with it. */
  clear(sessionId: string): void {
    this.markers.delete(sessionId);
    this.ended.delete(sessionId);
    this.dropHeld(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.held.keys()]) this.dropHeld(sessionId);
    this.markers.clear();
    this.ended.clear();
  }

  /**
   * Hold a plan-exit idle for `PLAN_APPROVAL_HOLD_MS` from now. No ToolEnd by
   * then means the plan was not approved, so the idle is processed late and the
   * marker, whose answer the CLI never acted on, is spent.
   */
  private hold(sessionId: string, event: SessionEvent): void {
    this.dropHeld(sessionId);
    const timer = setTimeout(() => {
      const current = this.held.get(sessionId);
      if (current?.timer !== timer) return;
      this.held.delete(sessionId);
      this.markers.delete(sessionId);
      this.options.release(sessionId, current.event);
    }, PLAN_APPROVAL_HOLD_MS);
    this.held.set(sessionId, { event, timer });
  }

  private freshMarker(sessionId: string): Marker | null {
    const marker = this.markers.get(sessionId);
    if (!marker) return null;
    if (this.now() - marker.at > PLAN_APPROVAL_MARKER_WINDOW_MS) {
      this.markers.delete(sessionId);
      return null;
    }
    return marker;
  }

  private dropHeld(sessionId: string): void {
    const current = this.held.get(sessionId);
    if (!current) return;
    clearTimeout(current.timer);
    this.held.delete(sessionId);
  }
}
