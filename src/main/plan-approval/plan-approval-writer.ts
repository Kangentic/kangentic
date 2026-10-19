import path from 'node:path';
import type { Session } from '../../shared/types';
import { isLiveSessionStatus } from '../../shared/session-liveness';
import { agentRegistry } from '../agent/agent-registry';
import { planApprovalDecisionPath, type PlanApprovalDecision } from '../agent/shared/plan-approval-hook';
import type { IpcContext } from '../ipc/ipc-context';
import { safeWriteJson } from '../safe-write';
import { newDecisionReadCache, readPlanApprovalDecision, type DecisionReadCache } from './read-decision';
import { notifyWorkflowsReadingBoard } from './workflow-plan-approval';
import { forgetPlanApprovalSpawn, setPlanApprovalModeResolver, spawnedSessionFor } from './plan-approval-spawns';

/**
 * Keeps every live task session's plan approval decision file current.
 *
 * The file is what the agent's plan approval hook reads when the plan prompt
 * appears (`plan-approval-bridge.js`), so it must be right whenever that
 * happens, not only at spawn:
 *
 * - written when a session first appears, so a task spawned into an Automatic
 *   column is approved with no later board event;
 * - rewritten for every live session, coalesced, on any board change (task
 *   moves, column edits, workflow start, pause, resume and route changes all
 *   reach `BoardEventBus`), and on a Board Profile or settings change, which
 *   the bus does not carry (`refreshPlanApprovals`). Every project's sessions,
 *   because a workflow's derived value spans boards.
 *
 * The file goes in the directory the spawn itself created, as the spawn
 * recorded it (`plan-approval-spawns.ts`), which is the directory the hook
 * command names. A session whose agent cannot approve plans still gets a file,
 * with `approve: false`. A failed write is reported through the shared write
 * latch (`safeWriteJson`); the hook then reads the previous answer or none,
 * and with none the user approves, as before.
 */

/** Coalesce a burst of board events (a drag fires several) into one pass. */
const REFRESH_DEBOUNCE_MS = 100;

/**
 * A failed write (on Windows, a scanner can hold the file through the rename)
 * is retried this long after, at most `WRITE_RETRY_LIMIT` times in a row, so
 * a quiet board does not keep the previous answer until its next event.
 */
const WRITE_RETRY_MS = 1_000;
const WRITE_RETRY_LIMIT = 3;

interface TrackedSession {
  projectId: string;
  taskId: string;
  decisionPath: string;
  agentCanApprove: boolean;
  bypassAvailable: boolean;
  decision: PlanApprovalDecision | null;
}

const NO_APPROVAL: PlanApprovalDecision = { approve: false, mode: 'default', detail: null };

export class PlanApprovalWriter {
  private readonly sessions = new Map<string, TrackedSession>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retriesLeft = WRITE_RETRY_LIMIT;
  private readonly detachers: Array<() => void> = [];

  constructor(private readonly context: IpcContext) {}

  get ipcContext(): IpcContext {
    return this.context;
  }

  start(): void {
    const { sessionManager, boardEvents } = this.context;
    const onChanged = (sessionId: string, session: Session): void => this.noteSession(sessionId, session);
    const onGone = (sessionId: string): void => {
      this.sessions.delete(sessionId);
      forgetPlanApprovalSpawn(sessionId);
    };
    sessionManager.on('session-changed', onChanged);
    sessionManager.on('session-removed', onGone);
    sessionManager.on('exit', onGone);
    this.detachers.push(
      () => sessionManager.off('session-changed', onChanged),
      () => sessionManager.off('session-removed', onGone),
      () => sessionManager.off('exit', onGone),
      boardEvents.onBoardChanged((event) => {
        this.scheduleRefresh();
        // A column's mode, agent or Plan approval feeds a workflow's derived value.
        if (event.change === 'swimlane-updated') notifyWorkflowsReadingBoard(this.context, event.projectId);
      }),
      () => setPlanApprovalModeResolver(null),
    );
    sessionManager.setPlanApprovalLookup((sessionId) => this.approves(sessionId));
    // Asked by a plan-mode spawn before it launches. The session does not exist
    // yet, so its agent is taken as able and bypass as reachable: the answer is
    // what the spawn should make possible.
    setPlanApprovalModeResolver((projectId, taskId) => {
      const decision = readPlanApprovalDecision(this.context, { projectId, taskId, agentCanApprove: true, bypassAvailable: true });
      return decision?.approve ? decision.mode : null;
    });
    for (const session of sessionManager.listSessions()) this.noteSession(session.id, session);
  }

  /** Whether the session's current decision approves its next plan. */
  approves(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.decision?.approve === true;
  }

  /** Re-read every live session's decision, coalesced. */
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const cache = newDecisionReadCache();
      for (const sessionId of this.sessions.keys()) this.write(sessionId, cache);
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners, starts no I/O. */
  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const detach of this.detachers.splice(0)) detach();
    this.sessions.clear();
  }

  private noteSession(sessionId: string, session: Session): void {
    if (session.transient) return;
    // A suspended or exited row plans nothing, and its directory may be
    // cleaned up under it: a rewrite would create the directory again.
    if (!isLiveSessionStatus(session.status)) {
      this.sessions.delete(sessionId);
      return;
    }
    if (this.sessions.has(sessionId)) return;
    const spawned = spawnedSessionFor(sessionId);
    // A session from before this build has no record: its directory is the one
    // both spawn paths build from the project root.
    const projectPath = this.context.projectRepo.getById(session.projectId)?.path;
    const sessionDir = spawned?.sessionDir
      ?? (projectPath ? path.join(projectPath, '.kangentic', 'sessions', sessionId) : null);
    if (!sessionDir) return;
    const agentName = this.context.sessionManager.getSessionAgentName(sessionId);
    this.sessions.set(sessionId, {
      projectId: session.projectId,
      taskId: session.taskId,
      decisionPath: planApprovalDecisionPath(sessionDir),
      agentCanApprove: agentName ? agentRegistry.get(agentName)?.supportsPlanAutoApproval === true : false,
      bypassAvailable: spawned?.bypassAvailable === true,
      decision: null,
    });
    this.write(sessionId, newDecisionReadCache());
  }

  private write(sessionId: string, cache: DecisionReadCache): void {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return;
    let decision: PlanApprovalDecision;
    try {
      decision = readPlanApprovalDecision(this.context, tracked, cache) ?? NO_APPROVAL;
    } catch (error) {
      // A board that will not read approves nothing: the user decides.
      console.warn(`[plan-approval] Could not read the decision for session ${sessionId.slice(0, 8)}:`, error);
      decision = NO_APPROVAL;
    }
    if (tracked.decision && sameDecision(tracked.decision, decision)) return;
    if (safeWriteJson(tracked.decisionPath, decision, 'plan_approval')) {
      tracked.decision = decision;
      this.retriesLeft = WRITE_RETRY_LIMIT;
      return;
    }
    // The decision stays unset, so the next pass writes it again.
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.retriesLeft === 0) return;
    this.retriesLeft -= 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleRefresh();
    }, WRITE_RETRY_MS);
  }
}

function sameDecision(left: PlanApprovalDecision, right: PlanApprovalDecision): boolean {
  return left.approve === right.approve && left.mode === right.mode && left.detail === right.detail;
}

let activeWriter: PlanApprovalWriter | null = null;

/** Start the writer once, at registration. */
export function startPlanApprovalWriter(context: IpcContext): PlanApprovalWriter {
  activeWriter?.dispose();
  activeWriter = new PlanApprovalWriter(context);
  activeWriter.start();
  return activeWriter;
}

/**
 * A change the board bus does not carry (a Board Profile edit, a settings
 * change, a teammate's kangentic.json) may change who approves a plan. With the
 * board it happened on, the workflows reading that board reload too. No-op
 * before the writer starts.
 */
export function refreshPlanApprovals(boardProjectId?: string | null): void {
  if (!activeWriter) return;
  activeWriter.scheduleRefresh();
  if (boardProjectId) notifyWorkflowsReadingBoard(activeWriter.ipcContext, boardProjectId);
}
