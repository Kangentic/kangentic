import { canColumnRun } from '../../../shared/automation-manifest';
import type { ColumnAutomation, Swimlane, Task } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import type { TurnEndedPayload } from '../../pty/session-manager';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { createTransitionEngine, resolveInjectionVerifier } from '../../ipc/helpers/agent-spawn';
import { reportAutomationFailures } from '../../ipc/helpers/automation-failures';
import { showDesktopNotification } from '../../ipc/handlers/system';
import { handleTaskMove } from '../../ipc/handlers/task-move';
import { createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { waitForTurnCompletion } from '../../transition-engine/turn-completion';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import { agentRegistry } from '../../agent/agent-registry';
import { frequencyLimitReason, hasCondition } from '../automation-runner';
import { automationRegistry } from '../automation-registry';
import { resolveMoveTarget, routeOf } from '../move-target';
import { runWorkflowStep, workflowStepApplies } from '../../workflows/workflow-step';
import type { RunConditionAnswer } from '../../db/repositories/automation-run-repository';
import { deliverMessageAfterMove, deliverMessageToSession } from './deliver-message';
import { trackTurnEndGroup } from './turn-end-passes';

/**
 * A column's On agent turn end automations: what runs when the agent working a
 * task finishes a turn.
 *
 * The rule (#732, the Code Review loop), and why each part is here:
 *
 * - **A turn end is the agent's own,** the activity engine's `'turn-ended'`:
 *   a Stop, settled past any background work, never an interrupt, a failed
 *   turn or a watchdog guess. Then 1.5 s of PTY silence (`waitForTurnCompletion`).
 * - **Only a turn that began in this visit counts.** A task dragged in while
 *   its agent was mid-turn ends that turn here, but the turn did the last
 *   column's work, and `{{agentReply}}` would carry the wrong reply.
 * - **Rows run top to bottom, each at most once per visit, and only a row that
 *   executes counts.** A Condition that answers no has not run, so the next
 *   turn end checks it again. A Move to column row that runs ends the group:
 *   the task has left.
 * - **Outside the task lock.** A row can take minutes, and a Move to column
 *   row's own move takes that lock (`withTaskLock` is not reentrant). A move
 *   made meanwhile supersedes the group instead (`supersedeTurnEndWork`).
 * - **One pass per task at a time.** "Has it run this visit" is read before the
 *   run row is written, so two passes would both run the same row. A turn end
 *   that arrives during a pass (a background job restarting the agent while a
 *   check is out) runs once more after it.
 * - **Nothing acts on a turn that is no longer the latest.** The pass judges
 *   the turn its payload names (`workSerial`), and before the check and again
 *   before the rows it asks whether that turn is still the session's latest
 *   (`isLatestTurn`). Being idle is not enough: a turn the user started
 *   meanwhile can fail (`turn_failed`) or be interrupted back to idle with no
 *   turn end of its own, and acting then would act on the old turn's reply.
 *   A newer turn abandons the pass and writes nothing.
 * - **Cheap when there is nothing to do.** Every hook agent's every turn ends
 *   here; a column with no turn-end rows costs one indexed query.
 */

interface TaskPassState {
  /** A turn end that arrived while a pass was running, run once more after it. */
  pending: TurnEndedPayload | null;
}

const passes = new Map<string, TaskPassState>();

/** How long a final-reply read may take before `{{agentReply}}` resolves empty. */
const AGENT_REPLY_TIMEOUT_MS = 15_000;

export function registerTurnEndAutomations(context: IpcContext): void {
  context.sessionManager.on('turn-ended', (payload: TurnEndedPayload) => {
    // Off the engine's commit stack: this fires inside `commitTransition`, and
    // even a DB read belongs after it has unwound.
    setImmediate(() => {
      void schedulePass(context, payload);
    });
  });
}

async function schedulePass(context: IpcContext, payload: TurnEndedPayload): Promise<void> {
  const existing = passes.get(payload.taskId);
  if (existing) {
    existing.pending = payload;
    return;
  }
  const state: TaskPassState = { pending: null };
  passes.set(payload.taskId, state);
  try {
    let next: TurnEndedPayload | null = payload;
    while (next) {
      state.pending = null;
      try {
        await runPass(context, next);
      } catch (error) {
        console.error(`[turn-end] Pass failed for task ${next.taskId.slice(0, 8)}:`, error);
      }
      next = state.pending;
    }
  } finally {
    passes.delete(payload.taskId);
  }
}

/** The task and column a turn end is for, or null when it no longer applies. */
function resolveSubject(
  context: IpcContext,
  payload: TurnEndedPayload,
): { task: Task; column: Swimlane; repos: ReturnType<typeof getProjectRepos> } | null {
  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, payload.projectId);
  } catch {
    return null;
  }
  const task = repos.tasks.getById(payload.taskId);
  if (!task || task.archived_at) return null;
  // The session that ended its turn must still be the task's live one: the
  // agent may have moved its own task, or the session been suspended for
  // another column's.
  if (task.session_id !== payload.sessionId) return null;
  // An isolated column's session belongs to that column alone.
  if (payload.isolatedSwimlaneId && payload.isolatedSwimlaneId !== task.swimlane_id) return null;
  const column = repos.swimlanes.getById(task.swimlane_id);
  if (!column) return null;
  return { task, column, repos };
}

async function runPass(context: IpcContext, payload: TurnEndedPayload): Promise<void> {
  const subject = resolveSubject(context, payload);
  if (!subject) return;
  const { task, column, repos } = subject;

  // The fast path: most columns have no turn-end rows, and most tasks are in
  // no workflow.
  const rows = repos.automations.getForTrigger(column.id, 'turn_end');
  const stepApplies = workflowStepApplies(task, payload.projectId);
  if (rows.length === 0 && !stepApplies) return;

  const visitStartedAt = repos.taskMoves.visitStartedAt(task.id, column.id);
  if (visitStartedAt && payload.turnStartedAt !== null && payload.turnStartedAt < Date.parse(visitStartedAt)) {
    // A turn the task carried in from its last column.
    return;
  }

  const facts = { autoSpawn: column.auto_spawn, role: column.role };
  const runs = repos.automationRuns;
  // The rows still pending this visit. A row that already ran, has spent its
  // Frequency, or that the column cannot run is left out without a record: a
  // record at every turn end of a long chat would bury the ones that matter.
  const pending = rows.filter((row) => automationRegistry.get(row.type) !== undefined
    && canColumnRun(row.type, facts, 'turn_end').ok
    && !runs.hasRunSince(row.id, task.id, visitStartedAt)
    && frequencyLimitReason(row, runs, task.id) === null);
  if (pending.length === 0 && !stepApplies) return;

  const controller = new AbortController();
  const releaseGroup = trackTurnEndGroup(task.id, controller);
  try {
    // The turn's bytes may still be landing: wait out the CLI's last paint.
    const settled = await waitForTurnCompletion(context.sessionManager, payload.sessionId, { signal: controller.signal });
    if (settled !== 'completed') return;
    // Cheap, and ahead of the paid check: a turn begun since this turn end
    // has left this one with nothing to judge.
    if (!context.sessionManager.isLatestTurn(payload.sessionId, payload.workSerial)) return;

    // One read of the agent's final reply, shared by the rows and the step.
    const sessionRepo = new SessionRepository(getProjectDb(payload.projectId));
    let replyRead: Promise<string | null> | null = null;
    const readReply = (): Promise<string | null> => {
      replyRead ??= readAgentReply(context, payload, sessionRepo);
      return replyRead;
    };

    const rows = pending.length > 0
      ? await runRows(context, payload, { task, column, repos, sessionRepo, pending, visitStartedAt, controller, readReply })
      : { messagedAgent: false, newerTurn: false };
    // The workflow's own step comes after the column's rows: a row that moved
    // the task leaves the step nothing to do, and the step reads where the task
    // is now. A row that gave the agent a message started its next turn, so this
    // turn end gets no workflow decision; the turn that answers the message does.
    // A newer turn abandons the whole pass, the step's paid check included.
    if (stepApplies && !controller.signal.aborted && !rows.messagedAgent && !rows.newerTurn) {
      await runWorkflowStep(context, { payload, columnId: column.id, signal: controller.signal, readAgentReply: readReply });
    }
  } finally {
    releaseGroup();
    clearSpawnProgress(context.mainWindow, task.id);
  }
}

/** The column's pending turn-end rows: one Condition check, a re-check, then the rows. */
async function runRows(
  context: IpcContext,
  payload: TurnEndedPayload,
  input: {
    task: Task;
    column: Swimlane;
    repos: ReturnType<typeof getProjectRepos>;
    sessionRepo: SessionRepository;
    pending: ColumnAutomation[];
    visitStartedAt: string | null;
    controller: AbortController;
    readReply: () => Promise<string | null>;
  },
): Promise<{ messagedAgent: boolean; newerTurn: boolean }> {
  const { task, column, repos, sessionRepo, pending, visitStartedAt, controller } = input;
  const none = { messagedAgent: false, newerTurn: false };
  const runs = repos.automationRuns;
  const project = context.projectRepo.getById(payload.projectId);
  const projectPath = project?.path ?? null;
  const engine = createTransitionEngine(
    context, repos.automations, repos.automationRuns, repos.tasks, sessionRepo, repos.attachments,
    payload.projectId, projectPath,
  );

  const needsReply = pending.some((row) => hasCondition(row) || mentionsAgentReply(row));
  const agentReply = needsReply ? await input.readReply() : null;

  // Conditions: one check for every pending row that has one.
  const conditional = pending.filter((row) => hasCondition(row));
  const answers = new Map<string, RunConditionAnswer>();
  let conditionUnavailableReason: string | undefined;
  let runnable = pending;
  if (conditional.length > 0) {
    const templateVars = engine.resolveGroupTemplateVars(task, column, 'turn_end', { agentReply });
    const outcome = await engine.checkConditions(
      engine.conditionCheckInput(task, column, 'turn_end', conditional, templateVars, { agentReply }),
    );
    if (outcome.ok) {
      for (const [automationId, answer] of outcome.answers) answers.set(automationId, answer);
    } else {
      conditionUnavailableReason = outcome.reason;
      // Recorded once per visit, not at every turn end of a long chat.
      runnable = pending.filter((row) => !hasCondition(row)
        || !runs.hasSkipSince(row.id, task.id, visitStartedAt, outcome.reason));
    }
  }
  if (runnable.length === 0 || controller.signal.aborted) return none;

  // The check can take a while. Run nothing unless the turn it judged is
  // still the latest: same session, same column, no turn begun since, and the
  // agent still idle. Idle alone passes a turn the user began meanwhile that
  // failed or was interrupted back to idle, since neither emits a turn end.
  const current = resolveSubject(context, payload);
  if (!current || current.column.id !== column.id) return none;
  if (!context.sessionManager.isLatestTurn(payload.sessionId, payload.workSerial)) {
    return { messagedAgent: false, newerTurn: true };
  }
  // activity-state-ok: granular, a row must not land on a running turn or a
  // permission prompt.
  if (context.sessionManager.getActivityCache()[payload.sessionId] !== 'idle') return none;

  let messagedAgent = false;
  const summary = await engine.executeTransition(current.task, column, 'turn_end', {
    // Classified in spawn-entry-point-parity.test.ts: no `startAgent`, so a
    // turn end never spawns; it acts on the agent that just finished.
    signal: controller.signal,
    onlyIds: new Set(runnable.map((row) => row.id)),
    agentReply,
    conditionAnswers: answers,
    conditionUnavailableReason,
    deliverToAgent: async (message, mode, runSignal) => {
      await deliverMessageToSession(context, {
        taskId: task.id,
        sessionId: payload.sessionId,
        message,
        mode,
        verifier: resolveInjectionVerifier(current.task.agent, sessionRepo, task.id),
        signal: runSignal,
      });
      // Counted once it landed: a delivery that failed starts no turn.
      messagedAgent = true;
    },
    moveTask: (moveInput) => moveFromTurnEnd(context, payload.projectId, projectPath, current.task, column, moveInput),
    showNotification: (notification) => showDesktopNotification(context, notification),
    onProgress: createProgressCallback(context.mainWindow, task.id),
  });
  reportAutomationFailures(context, summary, current.task, payload.projectId);
  return { messagedAgent, newerTurn: false };
}

function mentionsAgentReply(row: ColumnAutomation): boolean {
  return JSON.stringify(row.config).includes('{{agentReply}}');
}

/** The session's final reply, read in the retrieval worker. Empty on any failure. */
async function readAgentReply(
  context: IpcContext,
  payload: TurnEndedPayload,
  sessionRepo: SessionRepository,
): Promise<string | null> {
  try {
    const record = sessionRepo.findByAnyId(payload.sessionId);
    const agentSessionId = record?.agent_session_id ?? payload.agentSessionId;
    if (!record || !agentSessionId) return null;
    const reply = await retrievalClient.call(
      'transcript.finalReply',
      {
        facts: { sessionType: record.session_type, agentSessionId, cwd: record.cwd },
        remoteTargets: collectRemoteTargets(agentRegistry),
      },
      { timeoutMs: AGENT_REPLY_TIMEOUT_MS },
    );
    return reply?.text ?? null;
  } catch (error) {
    console.warn(`[turn-end] Could not read the agent's reply for ${payload.sessionId.slice(0, 8)}:`, error);
    return null;
  }
}

/**
 * A Move to column row's move. Resolves once the move is committed and the
 * destination's own enter rows have run; the row's message then reaches the
 * agent there in the background, once its turn ends, so the run row does not
 * wait an hour on a long first turn.
 */
async function moveFromTurnEnd(
  context: IpcContext,
  projectId: string,
  projectPath: string | null,
  task: Task,
  fromColumn: Swimlane,
  input: { column: string | null; message: string | null; reason: string },
): Promise<{ columnName: string }> {
  const repos = getProjectRepos(context, projectId);
  // A workflow task's Next column is the next one on its route.
  const target = resolveMoveTarget(repos.swimlanes.list(), fromColumn.id, input.column, routeOf(task));
  if (!target.ok) throw new Error(target.reason);

  await handleTaskMove(
    context,
    { taskId: task.id, targetSwimlaneId: target.column.id, targetPosition: repos.tasks.list(target.column.id).length },
    'automation',
    projectId,
    projectPath,
    { moveReason: input.reason, fromTurnEndGroup: true },
  );

  const moved = repos.tasks.getById(task.id);
  if (!moved || moved.swimlane_id !== target.column.id) {
    throw new Error(`The move to ${target.column.name} did not complete.`);
  }

  const message = input.message?.trim() ?? '';
  if (message) void deliverMessageAfterMove(context, projectId, task.id, target.column.name, message);
  return { columnName: target.column.name };
}
