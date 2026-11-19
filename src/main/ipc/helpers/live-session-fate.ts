import type { Project, Swimlane, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import type { SessionRepository } from '../../db/repositories/session-repository';
import { agentRegistry } from '../../agent/agent-registry';
import { resolveTargetAgent } from '../../transition-engine/agent-resolver';
import { prepareInjectionPlan, resolveReportedEffort, type InjectionRestartReason } from '../../transition-engine/injection-plan';
import { resolveForceFresh, resolveIsolatedSwimlaneId } from '../../transition-engine/session-isolation';

/**
 * What a move does to the task's live session when the destination keeps an
 * agent (`moveEndsAgent` is null), in the order `handleTaskMove`'s Priority 3
 * tests it:
 *
 * - `'switch'`: the destination wants another session track (an isolated
 *   column, or back to main from one) or always starts a new session. The live
 *   session is suspended and Phase 3 resumes or spawns the target session.
 * - `'handoff'`: the destination runs another agent. The live session is
 *   suspended and the new agent starts.
 * - `'restart'`: same agent, but a concrete model or effort the session is not
 *   running at. The session is suspended and resumed with the new launch flags.
 * - `'yield'`: same agent and settings, but the destination column is full.
 *   The session is suspended and resumes in the same conversation on its turn.
 * - `'keep'`: the session stays up, and the column's message is typed into it.
 *
 * Decided ONCE, before the exit automations run, and read by both the exit hook
 * and Priority 3. The exit group can run up to its 60 s budget, and in that
 * time an exit row can type `/effort` (which changes the reported effort the
 * restart rule reads) or the column can fill or free a slot. Recomputing in
 * Priority 3 could then disagree with what the exit hook already did with a
 * message: carry it for a restart that never comes, or type it into a session
 * that is cut off a second later (kangentic.com #145).
 */
export type LiveSessionFate =
  | { kind: 'switch' }
  | { kind: 'handoff'; targetAgent: string }
  | { kind: 'restart'; reason: InjectionRestartReason }
  | { kind: 'yield' }
  | { kind: 'keep' };

/** The facts the decision reads, gathered by `readLiveSessionFate`. */
export interface LiveSessionFateFacts {
  /** The destination column was found. Without one there is no track to switch to. */
  hasDestination: boolean;
  /** The live session's track (`isolated_swimlane_id` on its record), null for main. */
  activeIsolatedSwimlaneId: string | null;
  /** The track the destination wants (`resolveIsolatedSwimlaneId`). */
  targetIsolatedSwimlaneId: string | null;
  /** The destination always starts a new session (`resolveForceFresh`). */
  targetForceFresh: boolean;
  /** The agent the destination resolves to, and whether it differs from the task's. */
  targetAgent: string;
  isAgentChange: boolean;
  /** `prepareInjectionPlan`'s restart answer for this move. */
  restartReason: InjectionRestartReason | null;
  /** The session is running (a queued one holds no slot, so never yields). */
  sessionRunning: boolean;
  /** The destination column has no free slot for this task (`columnBlocks`). */
  columnBlocks: boolean;
}

/** The decision itself, with no reads, in Priority 3's order. */
export function decideLiveSessionFate(facts: LiveSessionFateFacts): LiveSessionFate {
  if (switchesSession(facts)) return { kind: 'switch' };
  if (facts.isAgentChange) return { kind: 'handoff', targetAgent: facts.targetAgent };
  if (facts.restartReason) return { kind: 'restart', reason: facts.restartReason };
  if (facts.sessionRunning && facts.columnBlocks) return { kind: 'yield' };
  return { kind: 'keep' };
}

function switchesSession(facts: LiveSessionFateFacts): boolean {
  return facts.hasDestination
    && (facts.activeIsolatedSwimlaneId !== facts.targetIsolatedSwimlaneId || facts.targetForceFresh);
}

/**
 * Read what the decision needs for a task with a live session moving into
 * `toLane`. The restart answer comes from `prepareInjectionPlan` with no
 * message, so the restart rule stays in `injection-plan.ts`.
 */
export function readLiveSessionFate(input: {
  context: Pick<IpcContext, 'sessionManager'>;
  sessionRepo: SessionRepository;
  task: Task;
  liveSessionId: string;
  toLane: Swimlane | undefined;
  project: Project | undefined;
  projectId: string;
}): LiveSessionFate {
  const { context, sessionRepo, task, liveSessionId, toLane, project, projectId } = input;
  const activeRecord = sessionRepo.getLatestForTask(task.id);
  const { agent: targetAgent, isHandoff } = resolveTargetAgent({
    taskAgentOverride: task.agent_override,
    columnAgent: toLane?.agent_override ?? null,
    taskAgent: task.agent,
    projectDefaultAgent: project?.default_agent ?? null,
  });
  const facts: LiveSessionFateFacts = {
    hasDestination: toLane !== undefined,
    activeIsolatedSwimlaneId: activeRecord?.isolated_swimlane_id ?? null,
    targetIsolatedSwimlaneId: resolveIsolatedSwimlaneId(toLane),
    targetForceFresh: resolveForceFresh(toLane),
    targetAgent,
    isAgentChange: isHandoff,
    restartReason: null,
    sessionRunning: false,
    columnBlocks: false,
  };
  // A switch or a handoff outranks a restart and a full column, so neither
  // reads the restart rule or the column gate, as Priority 3 never did.
  if (!switchesSession(facts) && !isHandoff) {
    const adapter = task.agent ? agentRegistry.get(task.agent) : undefined;
    facts.restartReason = prepareInjectionPlan({
      adapter,
      sessionRepo,
      task,
      toLane: toLane ?? null,
      project,
      autoCommand: '',
      ...resolveReportedEffort(context.sessionManager, liveSessionId),
    })?.restartReason ?? null;
    if (!facts.restartReason) {
      facts.sessionRunning = context.sessionManager.getSession(liveSessionId)?.status === 'running';
      facts.columnBlocks = facts.sessionRunning
        && context.sessionManager.columnBlocks({ taskId: task.id, projectId });
    }
  }
  return decideLiveSessionFate(facts);
}
