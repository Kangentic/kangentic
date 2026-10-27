import fs from 'node:fs';
import type { Session } from '../../shared/types';
import type { AgentAdapter } from '../agent/agent-adapter';
import { agentRegistry } from '../agent/agent-registry';
import { placeFromStored } from '../agent/shared/cli-target';
import type { IpcContext } from '../ipc/ipc-context';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { hasPendingMessageDelivery } from '../automations/turn-end/turn-end-passes';
import { isRunningWorkflowStepTask } from './workflow-home';
import { announceWorkflowStall, startWorkflowRecoveryOver } from './workflow-recovery';

/**
 * A running workflow task whose turn hangs: its agent shows working and has
 * written nothing to its session history for longer than a healthy turn ever
 * goes quiet. No turn end comes, so recovery never sees it, and the board shows
 * it working for as long as it hangs. On 2026-10-21 three tasks of one board
 * froze mid-turn within ten seconds of each other and sat 114 minutes, shown
 * working, until a restart and a person typing "continue" into each.
 *
 * - **The limit is the adapter's** (`AgentAdapter.hungTurn`), measured on the
 *   real CLI, never a guess made here. An agent that declares none is not
 *   checked.
 * - **Only a turn still in progress counts**: the session's reason is a tool, a
 *   subagent or the turn itself. A turn that ended with a background shell
 *   running stays working while the agent waits quietly for it, so it is left
 *   alone, and a question or a permission prompt is never working.
 * - **It reads the history from outside, in main.** The activity engine runs in
 *   the pty host, and the freeze above looked like that host stopping: none of
 *   the engine's own watchdogs fired.
 * - **It ends the turn with the CLI's own interrupt**, once, so the agent goes
 *   idle and recovery takes the turn from there, on a schedule started over
 *   (`startWorkflowRecoveryOver`). The interrupt is signalled to the activity
 *   engine as a user's Ctrl+C is (`signalUserInterrupt`): an interrupt between
 *   tool calls fires no hook, and the engine would show the turn working.
 * - **An interrupt lands when the agent writes.** Claude records one in its
 *   history (`[Request interrupted by user]`). If nothing has been written
 *   `INTERRUPT_LANDING_MS` later, the user gets the stall notice, once, whatever
 *   the engine shows, and the schedule starts over again past it, for an agent
 *   that comes back later. That notice is the part to count on: if the pty
 *   host itself is what stopped, the interrupt goes through the same host and
 *   cannot land, while main still tells the user about 22 minutes after the
 *   last write.
 * - **It holds while text is typed into the prompt or a message is on its way.**
 *   A terminal left on screen does not hold it: an agent that has written
 *   nothing for twice its longest healthy quiet is what a watching person
 *   would interrupt too, and one left on screen overnight would never be.
 */
const MINUTE_MS = 60_000;
const HANG_CHECK_INTERVAL_MS = MINUTE_MS;
/** How long an interrupt has to end the turn before the user is told. */
export const INTERRUPT_LANDING_MS = 2 * MINUTE_MS;

/** A session the check interrupted: its history's write time then, and when. */
interface InterruptedTurn {
  lastWriteAt: number;
  interruptedAt: number;
  noticeSent: boolean;
}

const interruptedTurns = new Map<string, InterruptedTurn>();
let timer: NodeJS.Timeout | null = null;
let checking = false;

/** Start the check's minute tick. One per app. */
export function startWorkflowHangCheck(context: IpcContext): void {
  if (timer) return;
  timer = setInterval(() => {
    void checkForHungTurns(context);
  }, HANG_CHECK_INTERVAL_MS);
  // The tick never keeps the app from quitting.
  timer.unref?.();
}

export function stopWorkflowHangCheck(): void {
  if (timer) clearInterval(timer);
  timer = null;
  interruptedTurns.clear();
  checking = false;
}

/** One pass over every live session. `now` is for tests. */
export async function checkForHungTurns(context: IpcContext, now: () => number = Date.now): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const live = new Set<string>();
    for (const session of context.sessionManager.listSessions()) {
      live.add(session.id);
      try {
        await checkSession(context, session, now);
      } catch (error) {
        console.warn(`[WORKFLOW] Could not check session ${session.id.slice(0, 8)} for a hung turn:`, error);
      }
    }
    for (const sessionId of [...interruptedTurns.keys()]) {
      if (!live.has(sessionId)) interruptedTurns.delete(sessionId);
    }
  } finally {
    checking = false;
  }
}

async function checkSession(context: IpcContext, session: Session, now: () => number): Promise<void> {
  const interrupted = interruptedTurns.get(session.id);
  // An interrupted session is followed past the engine's idle: the engine
  // settles an interrupt it saw no hook for as idle, landed or not.
  if (!interrupted && !isBusyTurn(context, session)) return;
  const adapter = agentRegistry.get(context.sessionManager.getSessionAgentName(session.id) ?? '');
  const spec = adapter?.hungTurn;
  if (!adapter || !spec || !session.agentSessionId || !isRunningWorkflowStepTask(session.projectId, session.taskId)) {
    interruptedTurns.delete(session.id);
    return;
  }
  const at = now();
  if (interrupted) {
    await checkInterruptLanded(context, session, adapter, interrupted, at);
    return;
  }

  const lastWriteAt = await lastHistoryWriteAt(context, adapter, session, session.agentSessionId, at - spec.quietLimitMs);
  if (lastWriteAt === null || at - lastWriteAt < spec.quietLimitMs) return;
  if (promptInUse(context, session)) return;
  // The awaits above gave the session time to change: a permission prompt
  // would take the interrupt as no, and a session that ended is not this turn.
  const liveSession = context.sessionManager.getSession(session.id);
  if (!liveSession || !isBusyTurn(context, liveSession)) return;
  const target = workflowTarget(context, liveSession);
  if (!target) return;
  const quietMinutes = Math.floor((at - lastWriteAt) / MINUTE_MS);
  context.sessionManager.write(session.id, spec.interruptKeys);
  // An interrupt between tool calls fires no hook, so the engine is told, as
  // it is of a user's Ctrl+C, and settles the turn itself when none comes.
  context.sessionManager.signalUserInterrupt(session.id);
  interruptedTurns.set(session.id, { lastWriteAt, interruptedAt: at, noticeSent: false });
  console.warn(`[WORKFLOW] Task ${session.taskId.slice(0, 8)}'s agent wrote nothing for ${quietMinutes} minutes while working; interrupted it.`);
  try {
    getProjectRepos(context, session.projectId).automationRuns.recordWorkflowInterrupt({
      taskId: target.taskId,
      swimlaneId: target.columnId,
      workflowId: target.workflowId,
      detail: `The agent wrote nothing for ${quietMinutes} minutes while working, so its turn was interrupted.`,
    });
  } catch (error) {
    console.warn('[WORKFLOW] Could not record an interrupted turn:', error);
  }
  // The interrupted turn is a new stall: its idle arms a fresh schedule,
  // even when this visit's recovery was already spent.
  startWorkflowRecoveryOver(context, target, { detail: 'Recovery starts over: a hung turn was interrupted.' });
}

/**
 * After the interrupt: a write means it landed, or the agent came back, and
 * the session is checked afresh from then on. No write by
 * `INTERRUPT_LANDING_MS` means the agent did not answer, so the user is told.
 */
async function checkInterruptLanded(
  context: IpcContext,
  session: Session,
  adapter: AgentAdapter,
  interrupted: InterruptedTurn,
  at: number,
): Promise<void> {
  const lastWriteAt = await lastHistoryWriteAt(context, adapter, session, session.agentSessionId!, interrupted.lastWriteAt + 1);
  if (lastWriteAt === null) return;
  if (lastWriteAt !== interrupted.lastWriteAt) {
    interruptedTurns.delete(session.id);
    return;
  }
  if (interrupted.noticeSent || at - interrupted.interruptedAt < INTERRUPT_LANDING_MS) return;
  const target = workflowTarget(context, session);
  if (!target) {
    interruptedTurns.delete(session.id);
    return;
  }
  interrupted.noticeSent = true;
  const quietMinutes = Math.floor((at - lastWriteAt) / MINUTE_MS);
  announceWorkflowStall(context, {
    ...target,
    reason: `its agent stopped responding: it has written nothing for ${quietMinutes} minutes, and did not answer an interrupt.`,
    countedNudges: 0,
  });
  // Past the stall row, which the real clock stamped, so an agent that comes
  // back later is nudged on the schedule's first step, not read as a recovery
  // already spent.
  startWorkflowRecoveryOver(context, target, {
    after: new Date(Date.now() + 1),
    detail: 'Recovery starts over: the agent stopped responding, so the turn that comes back starts a new one.',
  });
}

/** Where the session's task stands in its workflow, or null when it is not in one or has moved to another session. */
function workflowTarget(context: IpcContext, session: Session): { projectId: string; taskId: string; workflowId: string; columnId: string } | null {
  const task = getProjectRepos(context, session.projectId).tasks.getById(session.taskId);
  if (!task?.workflow_id || task.session_id !== session.id) return null;
  return { projectId: session.projectId, taskId: task.id, workflowId: task.workflow_id, columnId: task.swimlane_id };
}

/** A task agent shown working on a turn that has not ended. */
function isBusyTurn(context: IpcContext, session: Session): boolean {
  if (session.status !== 'running' || session.transient || session.workflowId) return false;
  // activity-state-ok: granular, only a turn the engine shows working can hang;
  // a question or a permission prompt waits on the user.
  if (context.sessionManager.getActivityCache()[session.id] !== 'thinking') return false;
  const reason = context.sessionManager.getActivityReason(session.id);
  return reason?.kind === 'tool' || reason?.kind === 'subagent' || reason?.kind === 'turn-active';
}

/** Someone is using the prompt: text typed into it, or a message on its way. */
function promptInUse(context: IpcContext, session: Session): boolean {
  if ((context.sessionManager.getPendingDraft(session.id) ?? '').trim() !== '') return true;
  return context.terminalSubmitScheduler.hasPending(session.taskId) || hasPendingMessageDelivery(session.taskId);
}

/**
 * The newest write to the session's history or any of its subagents', or null
 * when it has none. A history written at `enoughAt` or later answers on its
 * own: a subagent's write could only be newer, and the subagents' files are
 * read one by one on main. A CLI in a WSL distro keeps its history there.
 */
async function lastHistoryWriteAt(
  context: IpcContext,
  adapter: AgentAdapter,
  session: Session,
  agentSessionId: string,
  enoughAt: number,
): Promise<number | null> {
  const cwd = session.cwd;
  const place = placeFromStored(context.sessionManager.getSessionCliTarget(session.id));
  const historyFile = await adapter.locateSessionHistoryFile(agentSessionId, cwd, place);
  if (!historyFile) return null;
  let newest: number;
  try {
    newest = (await fs.promises.stat(historyFile)).mtimeMs;
  } catch {
    return null;
  }
  if (newest >= enoughAt) return newest;
  const subagents = adapter.statSubagentTranscripts?.(agentSessionId, cwd, place) ?? null;
  return subagents && subagents.maxMtimeMs > newest ? subagents.maxMtimeMs : newest;
}
