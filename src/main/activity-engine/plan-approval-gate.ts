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
 * "Agent needs your approval" notification and push the phone, all for a prompt nobody
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
 * Only an idle whose tool is the plan exit is held by that path. A question the
 * agent asks the user passes untouched.
 *
 * The same hook also answers a prompt for a tool the project allows that the
 * agent's plan mode asks about anyway (task #870: a third-party MCP tool with
 * no read-only annotation, for Claude), writing `tool_approval_sent` with the
 * tool's name. Its idle races that marker the same way, so, for a session
 * whose decision approves plans and a tool its agent's hook may answer
 * (`mayApproveTool`):
 *
 * - the idle is held for `TOOL_APPROVAL_WAIT_MS` waiting for the marker, and
 *   let through then if none came: a prompt the hook left alone shows that
 *   much late;
 * - a marker (before or after the idle) holds it until that tool's ToolEnd,
 *   which drops it. The marker proves only that the answer was sent: a tool
 *   the CLI still prompts for leaves its dialog open, so after
 *   `TOOL_APPROVAL_HOLD_MS` the idle is let through late. A tool that really
 *   runs that long reads as waiting from then until its ToolEnd clears it;
 * - several can wait at once (a subagent calls the tool its parent does).
 *   Markers, idles and ToolEnds pair with the oldest of the same tool;
 * - the turn's end (a Stop idle, a failed turn, an interrupt that names no
 *   tool) or a new prompt drops every held idle and marker. No call of an
 *   ended turn waits on anything, and an idle released after it would mark an
 *   idle session as needing you.
 *
 * `approvesPlans` holds for a task in a running automatic workflow in any
 * column, not only its plan column, so there the hook's own mode check is what
 * keeps a tool outside plan mode from being answered, and a tool's prompt in
 * such a task shows up to `TOOL_APPROVAL_WAIT_MS` late.
 */

/**
 * How long a plan-exit permission idle waits for the plan exit's ToolEnd. On
 * Claude Code 2.1.302 the marker followed the idle by at most 31 ms and the
 * ToolEnd followed the marker by at most 170 ms.
 */
export const PLAN_APPROVAL_HOLD_MS = 2_000;

/** How long a marker stays fresh. The ToolEnd it pairs with arrived within 170 ms. */
export const PLAN_APPROVAL_MARKER_WINDOW_MS = 15_000;

/**
 * How long a tool's permission idle waits for the hook's marker. On Claude
 * Code 2.1.306 the approving hook started 5 to 114 ms after the catch-all one
 * (`scripts/probe-claude-plan-tool-approval.js`).
 */
export const TOOL_APPROVAL_WAIT_MS = 1_000;

/**
 * How long a tool's permission idle waits for the tool's ToolEnd once the hook
 * answered. Short of a minute, so a tool the CLI still prompts for shows as
 * waiting on the user within one.
 */
export const TOOL_APPROVAL_HOLD_MS = 30_000;

/** How long a tool marker that arrived before its idle stays fresh. */
export const TOOL_APPROVAL_MARKER_WINDOW_MS = 5_000;

export interface PlanApprovalGateOptions {
  /** Whether this session's current decision approves plans (`PlanApprovalWriter.approves`). */
  approvesPlans(sessionId: string): boolean;
  /**
   * Whether the session's agent's hook may answer a prompt for this tool
   * (`AgentParser.mayApprovePlanTool`). Absent: no tool's idle is held.
   */
  mayApproveTool?(sessionId: string, toolName: string): boolean;
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

/**
 * What a held tool idle waits for: the hook's marker (`TOOL_APPROVAL_WAIT_MS`),
 * or, once the hook answered, the tool's ToolEnd (`TOOL_APPROVAL_HOLD_MS`).
 */
type ToolHoldPhase = 'awaiting-marker' | 'awaiting-tool-end';

/** A tool's permission idle, held until its phase's wait ends. */
interface HeldTool {
  tool: string;
  event: SessionEvent;
  phase: ToolHoldPhase;
  timer: ReturnType<typeof setTimeout>;
}

/** A tool marker that arrived before its idle. */
interface ToolMarker {
  tool: string;
  at: number;
}

function isPlanExitPermissionIdle(event: SessionEvent): boolean {
  return event.type === EventType.Idle
    && event.detail === IdleReason.Permission
    && event.tool === AgentTool.ExitPlanMode;
}

/** A permission idle for any named tool but the plan exit. */
function isToolPermissionIdle(event: SessionEvent): event is SessionEvent & { tool: string } {
  return event.type === EventType.Idle
    && event.detail === IdleReason.Permission
    && typeof event.tool === 'string'
    && event.tool.length > 0
    && event.tool !== AgentTool.ExitPlanMode;
}

/** The turn ended (a Stop idle, a failed turn, an interrupt naming no tool) or a new one began. */
function isTurnBoundary(event: SessionEvent): boolean {
  return event.type === EventType.Prompt
    || event.type === EventType.TurnFailed
    || (event.type === EventType.Interrupted && !event.tool)
    || (event.type === EventType.Idle && event.detail !== IdleReason.Permission);
}

export class PlanApprovalGate {
  private readonly markers = new Map<string, Marker>();
  private readonly held = new Map<string, Held>();
  private readonly heldTools = new Map<string, HeldTool[]>();
  private readonly toolMarkers = new Map<string, ToolMarker[]>();
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

    if (event.type === EventType.ToolApprovalSent) {
      if (event.tool) this.noteToolMarker(sessionId, event.tool);
      return [event];
    }

    if (isToolPermissionIdle(event)) {
      if (this.ended.has(sessionId)) return [event];
      if (this.takeFreshToolMarker(sessionId, event.tool)) {
        this.holdTool(sessionId, event, 'awaiting-tool-end');
        return [];
      }
      if (!this.options.approvesPlans(sessionId)) return [event];
      if (this.options.mayApproveTool?.(sessionId, event.tool) !== true) return [event];
      this.holdTool(sessionId, event, 'awaiting-marker');
      return [];
    }

    if ((event.type === EventType.ToolEnd || event.type === EventType.Interrupted) && event.tool) {
      // The tool ran, failed, or was interrupted (a failure hook with
      // `is_interrupt`, which names the tool too), or its prompt was answered:
      // its held idle waits on no one.
      this.dropHeldTool(sessionId, event.tool);
    } else if (isTurnBoundary(event)) {
      this.forgetToolWaits(sessionId);
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
    this.forgetToolWaits(sessionId);
    this.ended.add(sessionId);
  }

  /** Forget a session (removed, or its tracking cleared). A held idle is dropped with it. */
  clear(sessionId: string): void {
    this.markers.delete(sessionId);
    this.ended.delete(sessionId);
    this.dropHeld(sessionId);
    this.forgetToolWaits(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.held.keys()]) this.dropHeld(sessionId);
    for (const sessionId of [...this.heldTools.keys()]) this.dropHeldTools(sessionId);
    this.markers.clear();
    this.toolMarkers.clear();
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

  /** Hold a tool's idle for its phase's wait. The expiry processes it late. */
  private holdTool(sessionId: string, event: SessionEvent & { tool: string }, phase: ToolHoldPhase): void {
    const entries = this.heldTools.get(sessionId) ?? [];
    entries.push({ tool: event.tool, event, phase, timer: this.toolTimer(sessionId, phase) });
    this.heldTools.set(sessionId, entries);
  }

  private toolTimer(sessionId: string, phase: ToolHoldPhase): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const entry = this.heldTools.get(sessionId)?.find((candidate) => candidate.timer === timer);
      if (!entry) return;
      this.removeHeldTool(sessionId, entry);
      this.options.release(sessionId, entry.event);
    }, phase === 'awaiting-tool-end' ? TOOL_APPROVAL_HOLD_MS : TOOL_APPROVAL_WAIT_MS);
    return timer;
  }

  /** A marker answers the oldest idle of its tool still awaiting one, or waits for that idle. */
  private noteToolMarker(sessionId: string, tool: string): void {
    const waiting = this.heldTools.get(sessionId)?.find((entry) => entry.tool === tool && entry.phase === 'awaiting-marker');
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.phase = 'awaiting-tool-end';
      waiting.timer = this.toolTimer(sessionId, waiting.phase);
      return;
    }
    // Stale markers go first, so one whose idle never came cannot pile up.
    const now = this.now();
    const markers = (this.toolMarkers.get(sessionId) ?? []).filter((marker) => now - marker.at <= TOOL_APPROVAL_MARKER_WINDOW_MS);
    markers.push({ tool, at: now });
    this.toolMarkers.set(sessionId, markers);
  }

  /** Spend the oldest fresh marker of this tool, if one came before its idle. */
  private takeFreshToolMarker(sessionId: string, tool: string): boolean {
    const markers = this.toolMarkers.get(sessionId);
    if (!markers) return false;
    const now = this.now();
    const fresh = markers.filter((marker) => now - marker.at <= TOOL_APPROVAL_MARKER_WINDOW_MS);
    const index = fresh.findIndex((marker) => marker.tool === tool);
    if (index >= 0) fresh.splice(index, 1);
    if (fresh.length > 0) this.toolMarkers.set(sessionId, fresh);
    else this.toolMarkers.delete(sessionId);
    return index >= 0;
  }

  /**
   * A ToolEnd ends the oldest answered wait of its tool, or else the oldest one
   * still awaiting its marker: a prompt the user answered within the wait.
   */
  private dropHeldTool(sessionId: string, tool: string): void {
    const entries = this.heldTools.get(sessionId);
    if (!entries) return;
    const entry = entries.find((candidate) => candidate.tool === tool && candidate.phase === 'awaiting-tool-end')
      ?? entries.find((candidate) => candidate.tool === tool);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.removeHeldTool(sessionId, entry);
  }

  private removeHeldTool(sessionId: string, entry: HeldTool): void {
    const remaining = (this.heldTools.get(sessionId) ?? []).filter((candidate) => candidate !== entry);
    if (remaining.length > 0) this.heldTools.set(sessionId, remaining);
    else this.heldTools.delete(sessionId);
  }

  private dropHeldTools(sessionId: string): void {
    for (const entry of this.heldTools.get(sessionId) ?? []) clearTimeout(entry.timer);
    this.heldTools.delete(sessionId);
  }

  /** Drop every held tool idle and tool marker of the session. */
  private forgetToolWaits(sessionId: string): void {
    this.dropHeldTools(sessionId);
    this.toolMarkers.delete(sessionId);
  }
}
