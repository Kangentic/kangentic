import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { AutomationRepository } from '../../db/repositories/automation-repository';
import { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { HandoffRepository } from '../../db/repositories/handoff-repository';
import { TransitionEngine } from '../../transition-engine/transition-engine';
import { getProjectDb } from '../../db/database';
import { interpolateTemplate, interpolateTaskTemplate, resolveTaskTemplateVars } from '../../agent/shared';
import { trackEvent } from '../../analytics/analytics';
import { reportHandledError } from '../../analytics/error-reporting';
import { resolveDefaultBaseBranch } from '../handlers/git-stats-capture';
import { getDevPortForTask } from '../../dev-ports/dev-port-allocator';
import { agentRegistry } from '../../agent/agent-registry';
import { placeOfRecord } from '../../agent/shared/cli-target';
import { buildSessionHistoryReference } from '../../agent/handoff/session-history-reference';
import { DEFAULT_AGENT, NEVER_AUTO_SPAWN_ROLES } from '../../../shared/types';
import type { Task, Swimlane, Project, AutoCommandMode } from '../../../shared/types';
import { showAutomationNotification } from '../../automations/shared/show-automation-notification';
import { reportAutomationFailures } from './automation-failures';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { isHeldPause } from '../../../shared/held-pause';
import { runSpawnPreamble, projectModelDefaultsApply } from '../../transition-engine/spawn-preamble';
import { isResumeEligible } from '../../transition-engine/spawn-intent';
import { resolveIsolatedSwimlaneId, resolveForceFresh } from '../../transition-engine/session-isolation';
import { resolveEffectiveAutoCommand, resolveColumnMessage, applyProfileToLane } from '../../transition-engine/column-strategy';
import { canTaskRunAutomations } from '../../../shared/automation-manifest';
import { loadTaskProfile } from './task-profile';
import { buildCommandInjectionVerifier } from '../../transition-engine/injection-plan';
import type { CommandVerifier } from '../../transition-engine/terminal-submit-scheduler';
import { reportAutoCommandOutcome } from './auto-command-outcome';
import { deliverAgentMessageInBackground, isSlashCommand, pasteAgentMessageInBackground } from '../../automations/turn-end/agent-message-delivery';
import {
  claimHeldMessages,
  commitWhenSessionRuns,
  composeOpeningMessage,
  pasteHeldAfterTurn,
  settleClaimFromReport,
  type HeldClaim,
} from '../../held-messages/held-messages';
import type { AgentStartReport } from '../../automations/automation-runner';
import { emitSpawnProgress, createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { ensureTaskWorktree, ensureTaskBranchCheckout, notifyConversationExpired, notifySpawnBlocked } from './task-git';
import { createExpiredRecapSources } from '../../transition-engine/expired-recap-sources';
import { getProjectRepos } from './project-repos';
import { withTaskLock } from '../task-lifecycle-lock';
import { registerResumeController, releaseResumeController } from '../handlers/session-resume-controllers';
import { runWithProjectLogContext } from '../../diagnostics/project-log-context';
import { checkAutomationConditions, type ConditionCheckDeps } from '../../automations/condition-check/condition-check';
import { automationAgentDeps } from './automation-agent-deps';
import { backgroundCallSink } from './background-call-sink';
import { readWorkflowPromptFacts } from '../../workflows/workflow-prompt-facts';
import { readCommitsSince, readWorktreeHead } from '../../git/worktree-head';
import type { IsolatedRunRecord } from '../../db/repositories/session-repository';
import type { SessionRecord, SessionResumer } from '../../../shared/types';
import type { InjectionReport } from '../../transition-engine/terminal-submit-scheduler';
import { forgetRecapSession, markRecapSession, whenRecapTurnEnds } from '../../automations/turn-end/recap-turns';
import { trackMessageDelivery } from '../../automations/turn-end/turn-end-passes';
import { readSessionFinalReply } from '../../automations/turn-end/final-reply-reader';
import {
  formatReturnRecap,
  gatherReturnRecap,
  mainConversationLeftAt,
  returnRecapOpeningFor,
  RETURN_RECAP_BUDGET_MS,
  RETURN_RECAP_REPLY_TIMEOUT_MS,
  RETURN_RECAP_TURN_WAIT_MS,
  withinBudget,
  type ReturnRecapFacts,
} from '../../transition-engine/return-recap';

/**
 * Whether a column may spawn an agent at all, independent of its `auto_spawn`
 * flag: the To Do and Done roles never do. `applyProfileToLane` preserves
 * `role`, so the folded lane is safe to ask.
 *
 * Not the same question as `laneHoldsSession` in
 * `src/renderer/utils/task-progress.ts`, which gates whether the renderer paints
 * an EXISTING session and so refuses To Do only. The two deliberately disagree
 * about `done`: a Done column never starts a new agent, but a Done task keeps
 * its finished row so its scrollback and summary stay readable. Do not unify them.
 */
function laneMaySpawn(lane: Pick<Swimlane, 'role'>): boolean {
  return lane.role === null || !NEVER_AUTO_SPAWN_ROLES.has(lane.role);
}

/**
 * Resolve the column-derived spawn overrides handed to
 * `engine.resumeSuspendedSession` and `engine.executeTransition`.
 *
 * model/effort: per-task override (set via the ContextBar popover) wins over the
 * swimlane override, which wins over the project-level default - the user's
 * explicit choice is sticky across column moves and respawns, and the project
 * default is the base fallback below both. Undefined values are returned
 * unchanged so a fully-unset (undefined / undefined / undefined) row produces
 * `undefined` rather than `null` and downstream `?? undefined` coalescing
 * stays a no-op.
 *
 * isolatedSwimlaneId / forceFresh: derived from the destination column's session
 * target + spawn strategy. This is the single resolution site for the spawn path,
 * so every spawn through spawnAgent (normal move, session switch, Phase 3 deferred
 * spawn) lands on the correct track with the correct fresh-vs-resume policy without
 * threading them as separate parameters.
 */
export function resolveSpawnOverrides(
  task: Pick<Task, 'agent_override' | 'model_override' | 'effort_override'>,
  lane: Pick<Swimlane, 'id' | 'agent_override' | 'model_override' | 'effort_override' | 'session_target' | 'session_spawn_strategy'> | null | undefined,
  project?: Pick<Project, 'default_agent' | 'default_model' | 'default_effort'> | null,
): { model: string | null | undefined; effort: string | null | undefined; isolatedSwimlaneId: string | null; forceFresh: boolean } {
  // The project-level model/effort fallback is skipped when a task or column
  // overrides the agent away from the project default: those ids are
  // adapter-specific and do not travel. See projectModelDefaultsApply.
  const resolvedAgent = task.agent_override ?? lane?.agent_override ?? project?.default_agent ?? DEFAULT_AGENT;
  const projectFallback = projectModelDefaultsApply(resolvedAgent, project?.default_agent);
  return {
    model: task.model_override ?? lane?.model_override
      ?? (projectFallback ? project?.default_model : undefined),
    effort: task.effort_override ?? lane?.effort_override
      ?? (projectFallback ? project?.default_effort : undefined),
    isolatedSwimlaneId: resolveIsolatedSwimlaneId(lane),
    forceFresh: resolveForceFresh(lane),
  };
}

/** The run log's reason for a column message not sent because the task's conversation expired. */
const EXPIRED_CONVERSATION_SKIP_REASON = 'Not sent. The agent\'s conversation had expired, so it started a new one from a recap and is waiting for you.';

/** Create a TransitionEngine wired to explicit project context (not singletons). */
export function createTransitionEngine(
  context: IpcContext,
  automations: AutomationRepository,
  automationRuns: AutomationRunRepository,
  tasks: TaskRepository,
  sessionRepo: SessionRepository,
  attachments: AttachmentRepository,
  projectId: string,
  projectPath: string | null,
): TransitionEngine {
  return new TransitionEngine(
    context.sessionManager, context.terminalSubmit, tasks,
    () => {
      const config = context.configManager.getEffectiveConfig(projectPath || undefined);
      const gitConfig = { ...config.git };
      // Overlay board config's defaultBaseBranch (team-shared) onto gitConfig
      const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
      if (boardDefaultBranch) {
        gitConfig.defaultBaseBranch = boardDefaultBranch;
      }
      const project = context.projectRepo.getById(projectId);
      return {
        permissionMode: config.agent.permissionMode,
        projectPath,
        projectId,
        projectName: project?.name ?? null,
        gitConfig,
        mcpServerEnabled: config.mcpServer?.enabled ?? true,
        mcpServerUrl: context.mcpServerHandle?.urlForProject(projectId),
        mcpServerToken: context.mcpServerHandle?.token,
        defaultAgent: project?.default_agent ?? DEFAULT_AGENT,
        cliPathOverrides: config.agent.cliPaths,
        executionServers: config.agent.executionServers,
        execution: config.agent.execution,
        launchOptions: config.agent.launchOptions,
      };
    },
    sessionRepo,
    attachments,
    automations,
    automationRuns,
    {
      checkConditions: (input, limits, call) => checkAutomationConditions(conditionCheckDeps(context, projectPath), input, limits, call),
      recapSources: createExpiredRecapSources(projectId),
      onConversationExpired: (notice) => notifyConversationExpired(context, notice),
      readStartHead: async (cwd) => (await readWorktreeHead(cwd)).sha,
    },
  );
}

/** What a Condition check reads from the app: the config (the CLI path the
 *  task's project sets), the agent registry, and where it records its call. */
export function conditionCheckDeps(context: IpcContext, projectPath: string | null): ConditionCheckDeps {
  return { ...automationAgentDeps(context, projectPath), recordCall: backgroundCallSink(context) };
}

export interface AgentSpawnOptions {
  context: IpcContext;
  engine: TransitionEngine;
  tasks: TaskRepository;
  sessionRepo: SessionRepository;
  task: Task;
  fromSwimlaneId: string;
  toLane: Swimlane;
  skipPromptTemplate?: boolean;
  signal?: AbortSignal;
  /** Project ID for handoff context resolution. Resolved from caller's context. */
  projectId?: string;
  /** Project filesystem path for handoff context resolution. */
  projectPath?: string | null;
  /**
   * Attachment repository for the task's project, used to resolve
   * {{attachments}} in the auto_command template context. Every spawnAgent
   * call site already has this from getProjectRepos; omitted only where a
   * caller has no project context, in which case {{attachments}} resolves
   * empty.
   */
  attachments?: AttachmentRepository;
  /**
   * Fallback resume prompt when the destination column has no auto_command.
   * Set by plan-exit auto-moves so a respawned session continues instead of
   * resuming idle; it names the column whose settings restarted the session
   * and asks the agent to proceed with the approved plan. Only delivered on a
   * RESUME of the same agent's conversation - a fresh session, or another
   * agent's conversation on a handoff, has no plan context to continue. The
   * column's auto_command always wins when present.
   */
  continuationPrompt?: string;
  /**
   * Recovery move out of Done: resume the session but do NOT inject the
   * destination column's auto_command (as prompt or keystroke). The session
   * resumes idle, ready for the user to inspect; the NEXT move injects per
   * column config. Set by handleTaskMove when fromLane.role === 'done' and
   * by the unarchive handlers (task-archive.ts, always a move out of Done).
   * Matches startup recovery (resume-suspended.ts), which also resumes
   * without injecting auto_command.
   */
  suppressAutoCommand?: boolean;
  /**
   * A message follows the move that started this agent (a Move to column row's
   * Message, `kangentic_move_task`'s `message`), usually the reply the last
   * column ended on. A return to the main conversation then leaves that reply
   * out of its recap (`return-recap.ts`).
   */
  moveCarriesMessage?: boolean;
  /**
   * The lane whose inherited settings the New Task / Edit dialog displayed
   * when the user configured the task. The Advanced override lock
   * (`lockAdvancedOverridesOnFirstSpawn`) resolves still-inherited fields
   * against THIS lane, never the destination column (whose settings the user
   * never saw in the dialog). Drag moves pass the SOURCE lane (null when it
   * no longer resolves); omit to fall back to `toLane` (creation, promotion,
   * MCP creation, or unarchive directly into a spawn column, where the
   * destination is the lane the user chose).
   */
  settingsSourceLane?: Swimlane | null;
  /**
   * An explicit user gesture asked for this agent: today the phone's
   * `start-session` verb (`handlers/session-start.ts`), the bridge twin of the
   * desktop's Resume button. It bypasses exactly two guards, the column's
   * `auto_spawn` default and the manually-paused check, because both exist to
   * stop an AUTOMATIC spawn from overriding a choice the user made, and an
   * explicit Start is that user changing their mind. Nothing else changes:
   * the To Do / Done role gate still refuses, and the column's enter
   * automations still run.
   *
   * Passed only by a user-initiated path. A create, promote, unarchive,
   * startup, or `reconcileAutoSpawnChange` caller never sets it, or a column
   * flip would silently un-pause a task the user paused.
   */
  explicitStart?: boolean;
  /**
   * The user's Resume of an agent that was paused when its task entered this
   * column (`resumeTaskSession`). A move never starts a paused agent, so the
   * entry ran only its rows that need no agent; this start does the rest of
   * what the entry would have: the column's own session strategy (a fresh
   * conversation in a column that always starts new, the conversation resumed
   * in one that resumes) and the enter rows that need the agent. After an entry
   * out of Done the caller adds `suppressAutoCommand`, as a recovery move does.
   *
   * It lifts only the held-pause check, which is the pause this Resume ends.
   * The column's `auto_spawn` and the To Do / Done role gate still apply.
   * Passed only by `resumeTaskSession`.
   */
  resumesEntry?: boolean;
  /**
   * Who resumes the conversation when it is not a person, for a `resumesEntry`
   * start: the workflow's memory resume passes `'memory'`, which rides the
   * resumed session's `session-resumed` event to workflow recovery. Unset means
   * a person.
   */
  resumedBy?: SessionResumer;
}

/**
 * Single entry point for spawning or resuming an agent session for a task.
 *
 * Implements the "ensure" pattern: idempotent, safe to call multiple times.
 * 1. Runs configured transition actions (which may spawn via spawn_agent action)
 * 2. Verifies whether a session was created (re-reads from DB)
 * 3. If not, spawns or resumes a session as fallback
 * 4. Schedules auto_command injection when appropriate
 *
 * No-ops when: toLane.auto_spawn is false, task already has a session, or
 * task was deleted mid-operation. AbortError always propagates for cancellation.
 */
export async function spawnAgent(options: AgentSpawnOptions): Promise<void> {
  const { context, engine, tasks, sessionRepo, task, fromSwimlaneId, skipPromptTemplate, signal } = options;

  // Board Profiles: fold the task's profile over the destination column ONCE,
  // here, and shadow `toLane` with the result. Everything below then reads the
  // profile-resolved strategy without threading a parallel argument through each
  // downstream call - which is how one path ends up honoring a profile while
  // another silently ignores it.
  //
  // Only strategy fields are re-pointed; identity (id, name, role, ...) passes
  // through untouched. A task with no profile gets the lane back unchanged, so
  // a board with no profiles behaves exactly as before.
  const toLane = applyProfileToLane(
    options.toLane,
    loadTaskProfile(context, task, options.projectPath),
  ) ?? options.toLane;

  // Resolve the owning project once: used for the default-agent fallback below
  // and to tag every log this spawn emits with [projectName] (see
  // project-log-context.ts). When no project id is supplied the body runs
  // without establishing a new context, inheriting any ambient tag (e.g. from
  // an enclosing task-move).
  const project = options.projectId ? context.projectRepo.getById(options.projectId) : null;

  // NOTE: no dev-server port is reserved here, deliberately.
  //
  // An earlier version leased one per task at spawn. That was backwards: a
  // project configures its OWN ports (angular.json, vite config, a compose
  // file), often several, so a number Kangentic invents is meaningless to it -
  // and reserving one implied a server existed there when nothing had been
  // started. Ports are now RESERVED ON REQUEST, by whoever is about to bind
  // one: see kangentic_reserve_dev_ports.
  //
  // Auto_command template vars for the current task snapshot. defaultBaseBranch
  // is resolved once per spawn (board config -> project/global config ->
  // 'main') so {{baseBranch}} matches resolveDefaultBaseBranch everywhere else
  // it's used, rather than resolving empty for the ~99% of tasks with no
  // per-task base_branch override.
  const resolveAutoCommandVars = (currentTask: Task): Record<string, string> =>
    resolveTaskTemplateVars({
      task: currentTask,
      defaultBaseBranch: resolveDefaultBaseBranch(context, options.projectPath),
      attachmentPaths: options.attachments?.getPathsForTask(currentTask.id) ?? [],
      devPort: getDevPortForTask(currentTask.id),
      projectPath: options.projectPath ?? null,
      projectName: project?.name ?? null,
      // A spawn prompt is not a move; the picker does not offer the move
      // keywords in this context.
      move: null,
      workflow: readWorkflowPromptFacts(currentTask, options.projectId ?? null),
    });

  /**
   * Messages held for the task while no agent ran (src/main/held-messages),
   * claimed as this start begins. They go out in the agent's opening message,
   * after the column's own: on the spawn's command line where it has a prompt
   * slot, or typed with the first message otherwise.
   */
  let heldClaim: HeldClaim | null = null;
  /** The claim went to a delivery or a command-line ride, which settles it. */
  let heldHandedOff = false;
  /** The held text waits to join the next message typed at the agent. */
  let heldJoinsNextMessage = false;
  /** The held text waits for the opening message's turn to end: it is a slash command. */
  let heldAfterLeadTurn = false;
  /** A plan continuation the resume could not carry on its command line, typed after the group. */
  let unsentContinuation: string | null = null;
  /**
   * Task #952: a return recap the resume could not carry on its command line,
   * typed ahead of the next message this start sends (`return-recap.ts`).
   */
  let pendingRecap: string | null = null;
  /**
   * Task #952: set when the return recap is the resume's whole prompt ahead of
   * a slash command. Resolves once the recap's turn ends (true) or the session
   * leaves first (false). The column's message and held messages wait on it.
   */
  let recapTurnGate: Promise<boolean> | null = null;

  /**
   * Send now, or, behind a return recap, once its turn has ended. A move of the
   * task meanwhile (`supersedeMessageDeliveries`), or the session leaving, sends
   * nothing and calls `dropped` instead. Calls made in order send in order.
   */
  const afterRecapTurn = (send: (freshlySpawned: boolean) => void, dropped: () => void): void => {
    const gate = recapTurnGate;
    if (gate === null) {
      send(true);
      return;
    }
    const controller = new AbortController();
    const release = trackMessageDelivery(task.id, controller);
    let settled = false;
    const settle = (proceed: boolean): void => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      release();
      // The recap's turn is over and the session idles: no first edge to wait for.
      if (proceed && !controller.signal.aborted) send(false);
      else dropped();
    };
    // A move drops the message at once, not when the recap's turn ends, so
    // its held messages are free for the next start.
    const onAbort = (): void => settle(false);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    void gate.then(settle);
  };

  /**
   * What the task's isolated column sessions did while its main conversation
   * was away, or null when none ran or none left anything to say. Bounded:
   * this runs under the task lock.
   */
  const readReturnRecap = async (mainRecord: SessionRecord, current: Task): Promise<ReturnRecapFacts | null> => {
    let isolatedRuns: IsolatedRunRecord[];
    let columnName: (swimlaneId: string) => string | null;
    try {
      isolatedRuns = sessionRepo.listIsolatedSince(task.id, mainConversationLeftAt(mainRecord));
      if (isolatedRuns.length === 0) return null;
      const swimlanes = getProjectRepos(context, options.projectId).swimlanes;
      columnName = (swimlaneId) => swimlanes.getById(swimlaneId)?.name ?? null;
    } catch (error) {
      console.warn(`[spawnAgent] Could not read the column sessions task ${task.id.slice(0, 8)} ran while its conversation was away:`, error);
      return null;
    }
    const cwd = current.worktree_path ?? options.projectPath ?? mainRecord.cwd;
    return withinBudget(gatherReturnRecap(
      // A move that carries its own message usually carries this reply too.
      { cwd, isolatedRuns, includeReplies: options.moveCarriesMessage !== true },
      {
        readCommitsSince,
        readFinalReply: async (run) => {
          const reply = await readSessionFinalReply(
            { sessionId: run.id, agentSessionId: run.agent_session_id },
            sessionRepo,
            RETURN_RECAP_REPLY_TIMEOUT_MS,
          );
          return reply?.text ?? null;
        },
        columnName,
      },
    ), RETURN_RECAP_BUDGET_MS, null);
  };

  /** A message that waited on a return recap's turn and was not sent: the task moved, or the session ended. */
  const droppedAfterRecapReport = (sessionId: string, message: string): InjectionReport => ({
    taskId: task.id,
    sessionId,
    commands: [message],
    outcome: 'cancelled',
    unconfirmedCommands: [message],
    discardedDraft: null,
    interruptedTurn: false,
    escalated: false,
    reason: 'The task moved on, or its agent ended, before the recap turn was over, so the message was not sent.',
    textReachedAgent: false,
  });

  const run = async (): Promise<void> => {
  // Guard: if the target column doesn't want agents, no-op. An explicit user
  // Start overrides the column's default, as the desktop's Resume button does.
  if (!toLane.auto_spawn && !options.explicitStart) return;

  // Guard: a To Do or Done column never spawns, whatever its flag says. The
  // move path branches on role before it gets here (task-move.ts), and the
  // startup and reconcile paths gate on NEVER_AUTO_SPAWN_ROLES, but the flag
  // itself can be written onto a role lane over MCP (update_column) or by a
  // Board Profile fold, and this chokepoint used to honor it for a task
  // created, promoted, or restored straight into To Do. The renderer treats
  // a To Do task as sessionless (its card opens the edit form), so a live
  // agent there would be invisible.
  if (!laneMaySpawn(toLane)) return;

  // Guard: if the task is held paused (the user paused it, or Kangentic did
  // while it waited on the user), don't auto-resume. Only an explicit user
  // gesture restarts it: the desktop's Resume button (SESSION_RESUME, which
  // reaches here with `resumesEntry` after the task changed column) or a
  // caller passing `explicitStart` (the phone's start-session verb).
  const latestSession = sessionRepo.getLatestForTask(task.id);
  if (isHeldPause(latestSession) && !options.explicitStart && !options.resumesEntry) {
    console.log(`[spawnAgent] Skipping auto-spawn for task ${task.id.slice(0, 8)} (paused until the user resumes it)`);
    return;
  }

  // Shared spawn preamble: lock the Advanced overrides on the task's very
  // first ever spawn, then resolve the target agent ONCE (single source of
  // truth) - a just-locked agent_override is what the resolution picks up,
  // and the in-flight spawn below already resolves against the locked values.
  const { agent: targetAgent, isHandoff } = runSpawnPreamble({
    task,
    hasSessionRecord: latestSession !== undefined,
    settingsLane: options.settingsSourceLane === undefined ? toLane : options.settingsSourceLane,
    destinationLane: toLane,
    project,
    globalPermissionMode: () => context.configManager.getEffectiveConfig(options.projectPath || undefined).agent.permissionMode,
    tasks,
  });

  // Handoff also requires a previous session to exist, a project context,
  // and the target column's handoff_context toggle to be enabled (default: false).
  // When disabled (default), the agent change is still detected but no context
  // is packaged - the new agent starts fresh with just the task title/description.
  const hasHandoffContext = toLane.handoff_context !== false
    && isHandoff
    && options.projectId !== undefined
    && sessionRepo.getLatestForTask(task.id) !== null;

  console.log(`[spawnAgent] task=${task.id.slice(0, 8)} targetAgent=${targetAgent} isHandoff=${isHandoff} hasHandoffContext=${hasHandoffContext}`);

  // --- Handoff path: locate source session file and spawn target agent ---
  if (hasHandoffContext) {
    // Guard: hasHandoffContext implies isHandoff which implies task.agent !== null
    const sourceAgent = task.agent!;
    console.log(`[spawnAgent] Handoff: ${sourceAgent} -> ${targetAgent} for task ${task.id.slice(0, 8)}`);
    emitSpawnProgress(context.mainWindow, task.id, 'packaging-handoff');
    signal?.throwIfAborted();

    let handoffPromptPrefix: string | undefined;
    let handoffId: string | undefined;
    const handoffProjectId = options.projectId!;
    const handoffDb = getProjectDb(handoffProjectId);

    try {
      // Locate the source agent's native session history file: where the
      // agent reported writing it, else derived from agent_session_id + cwd.
      const latestSessionRecord = sessionRepo.getLatestForTask(task.id);
      let sessionFilePath: string | null = null;

      if (latestSessionRecord?.agent_session_id) {
        const sourceAdapter = agentRegistry.get(sourceAgent);
        if (sourceAdapter) {
          sessionFilePath = await sourceAdapter.locateSessionHistoryFile(
            latestSessionRecord.agent_session_id,
            latestSessionRecord.cwd,
            // A source CLI that ran in a WSL distro left its history there.
            placeOfRecord(latestSessionRecord),
            latestSessionRecord.transcript_path,
          );
        }
      }

      // Whether the target agent reaches Kangentic's MCP server, as its adapter declares.
      const targetAdapter = agentRegistry.get(targetAgent);
      const targetHasMcpAccess = targetAdapter?.kangenticMcp !== undefined;

      handoffPromptPrefix = buildSessionHistoryReference({
        sourceAgent,
        sessionFilePath,
        targetHasMcpAccess,
      });

      // Store a handoff record for audit trail.
      try {
        const handoffRepo = new HandoffRepository(handoffDb);
        const handoffRecord = handoffRepo.insert({
          task_id: task.id,
          from_session_id: latestSessionRecord?.id ?? null,
          to_session_id: null, // Filled after target agent spawns
          from_agent: sourceAgent,
          to_agent: targetAgent,
          trigger: 'column_transition',
          session_history_path: sessionFilePath,
        });
        handoffId = handoffRecord.id;
      } catch (handoffDbError) {
        console.error('[spawnAgent] Failed to store handoff record:', handoffDbError);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error('[spawnAgent] Handoff preparation failed (continuing without context):', error);
    }

    emitSpawnProgress(context.mainWindow, task.id, 'detecting-agent');

    // Messages held for the task go to this agent with the column's message.
    heldClaim = options.projectId ? claimHeldMessages(context, options.projectId, task.id) : null;

    let handoffRecapOnly: boolean;
    let handoffUnsentPrompt: string | null;
    try {
      const handoffOutcome = await engine.resumeSuspendedSession(
        task, toLane.permission_mode, skipPromptTemplate, undefined, signal,
        targetAgent,
        handoffPromptPrefix,
        resolveSpawnOverrides(task, toLane, project),
      );
      // The target agent's own earlier conversation was resumed, and the agent
      // had deleted it: the new session opened on a recap that asks it to
      // summarize and wait, so the column's message below is not sent.
      handoffRecapOnly = handoffOutcome?.recapOnly ?? false;
      // The resume could not carry the pointer to the source agent's history on
      // its command line (`SpawnOutcome.unsentPrompt`), so it is typed in, ahead
      // of the column's message, in the same delivery.
      handoffUnsentPrompt = handoffOutcome?.unsentPrompt ?? null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error('[spawnAgent] Failed to start handoff session:', error);
      return;
    }

    // Post-spawn: link handoff record to the target session.
    const currentTask = tasks.getById(task.id);
    if (currentTask?.session_id) {
      try {
        if (handoffId) {
          const handoffRepo = new HandoffRepository(handoffDb);
          const targetSessionRecord = sessionRepo.getLatestForTask(currentTask.id);
          if (targetSessionRecord) {
            handoffRepo.updateToSession(handoffId, targetSessionRecord.id);
          }
        }
      } catch (error) {
        console.error('[spawnAgent] Failed to finalize handoff:', error);
      }

      // The column's message now lives in its first enabled `send_message`
      // enter automation rather than in `swimlanes.auto_command`. The task's own
      // MCP-set command still outranks it, which is the precedence
      // `resolveEffectiveAutoCommand` exists to keep identical on every path.
      // A task with its automations disabled is sent no column message on a
      // handoff either; its own auto_command still goes.
      const resolvedColumnMessage = canTaskRunAutomations(currentTask).ok
        ? resolveColumnMessage(getProjectRepos(context, options.projectId).automations.listForColumn(toLane.id))
        : null;
      // A handoff runs no enter group, so nothing here can check a row's
      // Condition or Frequency. Sending a guarded row would skip both; it is
      // left unsent, as the runner leaves a row it cannot check.
      const columnMessage = resolvedColumnMessage && !resolvedColumnMessage.guarded ? resolvedColumnMessage : null;
      if (resolvedColumnMessage?.guarded) {
        console.log(`[spawnAgent] Handoff for task ${task.id.slice(0, 8)}: the column's message has a Condition or Frequency limit, so it is not sent.`);
      }
      const taskOverride = currentTask.auto_command?.trim();
      const effectiveAutoCommand = resolveEffectiveAutoCommand(currentTask.auto_command, columnMessage?.message);
      let columnText: string | undefined;
      if (handoffRecapOnly && effectiveAutoCommand?.trim()) {
        console.log(`[spawnAgent] Handoff for task ${task.id.slice(0, 8)}: the conversation had expired and the agent is waiting on its recap, so the column's message is not sent.`);
      } else if (!options.suppressAutoCommand && effectiveAutoCommand?.trim()) {
        // Which interpolator depends on which tier won, and the two genuinely
        // differ. A task's `auto_command` keeps DROP-AND-COLLAPSE, which is the
        // rule `task-template-vars-parity.md` states for it. A column's message
        // is an automation field, and every automation field substitutes
        // literally through the runner's `interpolateAutomationConfig` - which
        // is also what the field's own editor promises, in as many words:
        // "Unknown variable: nope. It will be sent as written."
        //
        // The normal path already splits them exactly here (`takeMessage`
        // swaps a drop-and-collapse task override over a literally-interpolated
        // column row). This branch is the cross-agent handoff, and it used to
        // drop-and-collapse BOTH, so the same message delivered one way on a
        // handoff and another way on every other move.
        const vars = resolveAutoCommandVars(currentTask);
        columnText = taskOverride
          ? interpolateTaskTemplate(effectiveAutoCommand, vars)
          : interpolateTemplate(effectiveAutoCommand, vars);
      }

      // One typed delivery: the history pointer the resume could not carry,
      // the column's message, then the held messages (none after an expired
      // conversation's recap, which withholds them as it withholds the column's).
      // Text put ahead of a slash command stops it running, and text after one
      // becomes its arguments, so beside one they are pasted after its turn.
      const handoffSessionId = currentTask.session_id;
      const heldText = handoffRecapOnly ? undefined : heldClaim?.text;
      const opening = composeOpeningMessage(columnText, heldText);
      let typedMessage = opening.prompt;
      const pointerAfterTurn = handoffUnsentPrompt !== null && typedMessage !== undefined && isSlashCommand(typedMessage);
      if (handoffUnsentPrompt !== null && !pointerAfterTurn) {
        typedMessage = typedMessage === undefined ? handoffUnsentPrompt : `${handoffUnsentPrompt}\n\n${typedMessage}`;
      }
      const carried = heldClaim !== null && heldText !== undefined && !opening.heldAfterTurn ? heldClaim : null;
      if (typedMessage !== undefined) {
        // Keystrokes once the new agent is alive, or, for a message with line
        // breaks, a paste once its first turn ends.
        deliverAgentMessageInBackground(context, {
          taskId: currentTask.id,
          sessionId: handoffSessionId,
          message: typedMessage,
          mode: columnMessage?.mode ?? 'immediate',
          verifier: resolveInjectionVerifier(targetAgent, sessionRepo, currentTask.id),
          freshlySpawned: true,
          onOutcome: (report) => {
            if (columnText !== undefined) reportAutoCommandOutcome(context, tasks, currentTask, report, options.projectId);
            if (carried) settleClaimFromReport(carried, report, { flushOnRelease: true });
          },
        });
        if (carried) heldHandedOff = true;
      }
      // What waits out the slash command's turn goes as ONE paste, the pointer
      // first: two pastes waiting on the same turn could land in either order.
      const heldAfterLead = heldClaim !== null && heldText !== undefined && opening.heldAfterTurn ? heldClaim : null;
      const afterTurn = [pointerAfterTurn ? handoffUnsentPrompt : null, heldAfterLead?.text ?? null]
        .filter((part): part is string => part !== null);
      if (afterTurn.length > 0) {
        pasteAgentMessageInBackground(context, {
          taskId: currentTask.id,
          sessionId: handoffSessionId,
          message: afterTurn.join('\n\n'),
          onOutcome: (report) => {
            if (heldAfterLead) {
              settleClaimFromReport(heldAfterLead, report, { flushOnRelease: true });
            } else if (report.outcome !== 'confirmed' && report.outcome !== 'unconfirmed') {
              console.warn(`[spawnAgent] Handoff for task ${currentTask.id.slice(0, 8)}: the history pointer was not pasted (${report.outcome}).`);
            }
          },
        });
        if (heldAfterLead) heldHandedOff = true;
      }
    }
    // A recap-only start, or one that left no session, keeps them held for the
    // next start (the `finally` around this function releases them).
    if (handoffRecapOnly) heldClaim?.release();

    return;
  }

  // --- Normal path: the column's enter automations, then the fallback spawn ---
  //
  // The automations own the ordered list; the spawn is injected into it as
  // `startAgent`, so the agent starts before the FIRST row that needs one
  // rather than at a fixed point in the list. A script row above a message row
  // therefore still runs before the agent exists, which is the order the list
  // shows the user.

  /**
   * The task's own MCP-set `auto_command` outranks the column's first message.
   * That precedence is `resolveEffectiveAutoCommand`'s rule, which exists because
   * the spawn path and the live-injection path once disagreed about it, so a
   * task carrying its own command worked on a cold spawn and was silently
   * dropped on a warm move. Consumed ONCE: a second message row belongs to the
   * column, not the task.
   */
  let pendingTaskOverride: string | null = null;
  if (!options.suppressAutoCommand && task.auto_command?.trim()) {
    pendingTaskOverride = interpolateTaskTemplate(task.auto_command.trim(), resolveAutoCommandVars(task));
  }

  const takeMessage = (message: string): string => {
    if (pendingTaskOverride === null) return message;
    const override = pendingTaskOverride;
    pendingTaskOverride = null;
    return override;
  };

  /**
   * The row whose message the spawn took as its own opening prompt, so
   * `deliverToAgent` does not then type it at the agent a second time.
   */
  let promptTakenFromRow: string | null = null;

  /**
   * Set when a legacy Start agent row opened the agent on an expired
   * conversation's recap alone. That row needs no agent, so the runner asks
   * `startAgent` at the next row that does, which finds the session already
   * there and reports the withhold the row could not.
   */
  let legacyStartReport: AgentStartReport | null = null;

  /**
   * Set once a row in the enter group has started the agent: a legacy Start
   * agent row, or the first row that needs the agent. Neither always sends the
   * task's own command (a Start agent row sends no message, and a Send message
   * row whose message is empty sends nothing), so when no row did, it still has
   * to go out once the group ends.
   */
  let startedAgentInGroup = false;

  /**
   * The column the task came FROM, for `{{fromColumn}}` and a webhook payload.
   * A drag move already carries it as the settings-source lane; every other
   * entry point (create, promote, MCP create, unarchive) passes the `'*'`
   * wildcard, which means there is no specific source to name.
   */
  const resolveFromColumn = (): Swimlane | null => {
    if (options.settingsSourceLane) return options.settingsSourceLane;
    if (fromSwimlaneId === '*') return null;
    try {
      return getProjectRepos(context, options.projectId).swimlanes.getById(fromSwimlaneId) ?? null;
    } catch {
      // No project open. A template variable resolving empty is the right
      // degradation here; refusing to run the automations would not be.
      return null;
    }
  };

  const startAgent = async (pendingPrompt?: string): Promise<AgentStartReport | void> => {
    const beforeSpawn = tasks.getById(task.id);
    if (!beforeSpawn || beforeSpawn.session_id) return legacyStartReport ?? undefined;

    console.log(`[spawnAgent] Starting ${targetAgent} for task ${task.id.slice(0, 8)}`);

    // Resume eligibility scoped to the DESTINATION session (agent type +
    // isolated swimlane), mirroring executeSpawnAgent's resolveSpawnIntent. A
    // task-level check (getLatestForTask) would treat a suspended MAIN session
    // as resumable when entering an isolated column, which would mis-route the
    // message and drop it.
    const destinationIsolatedSwimlaneId = resolveIsolatedSwimlaneId(toLane);
    const destinationAdapter = agentRegistry.get(targetAgent);
    const destinationResumeRecord = destinationAdapter
      ? sessionRepo.getLatestForTaskByTypeAndIsolation(task.id, destinationAdapter.sessionType, destinationIsolatedSwimlaneId)
      : undefined;
    const canResumeDestination = isResumeEligible(destinationResumeRecord);

    // A message takes the spawn's INITIAL PROMPT slot whenever the session has
    // no task prompt of its own to run: a resume carries it as the next
    // message, and a promptless fresh spawn (an isolated review column) would
    // otherwise sit at an empty prompt, emit no 'thinking' event, and make the
    // keystroke scheduler wait out its full 30s fallback before the message
    // appears. That reads as "the automation never ran".
    const overrideBeforeTake = pendingTaskOverride;
    const message = takeMessage(pendingPrompt ?? '');
    const promptSlotOpen = canResumeDestination || skipPromptTemplate === true;
    const takesPromptSlot = message !== '' && promptSlotOpen;
    if (takesPromptSlot && pendingPrompt !== undefined) promptTakenFromRow = pendingPrompt;

    // The continuation prompt (plan-exit auto-move) says why the session
    // restarted and asks the agent to proceed. It is a resume-only fallback:
    // the column's message is the user's explicit automation and wins, and a
    // fresh spawn has no prior conversation for "proceed" to refer to. A
    // handoff drops it too. The resume check above is scoped to the TARGET
    // agent, so on a handoff it finds that agent's older conversation, which
    // never saw the plan. The handoff-context branch above already passes none.
    const continuation = !takesPromptSlot && canResumeDestination && !isHandoff ? options.continuationPrompt : undefined;
    const lead = takesPromptSlot ? message : continuation;

    // Task #952: the task returns to its main conversation after an isolated
    // column's session (Code Review, then Testing), so the conversation is told
    // what that session did. Only on a resume of the same agent's main
    // conversation: a fresh one has nothing to catch up, a handoff gets the
    // other agent's history, and a recovery move out of Done sends nothing.
    // Messages held for the task join the opening message, after the lead,
    // wherever the spawn has a prompt slot. Claimed here, once, as the agent
    // starts; a later start finds them gone. Behind a deferred lead they wait
    // for its turn, as they do behind any slash command.
    if (heldClaim === null && options.projectId) heldClaim = claimHeldMessages(context, options.projectId, task.id);

    const recapFacts = canResumeDestination && destinationResumeRecord !== undefined
      && destinationIsolatedSwimlaneId === null && !isHandoff && !options.suppressAutoCommand && !resolveForceFresh(toLane)
      ? await readReturnRecap(destinationResumeRecord, beforeSpawn)
      : null;
    const recap = recapFacts !== null ? { facts: recapFacts, opening: returnRecapOpeningFor(lead, heldClaim !== null) } : null;
    const recapOpening = recap?.opening ?? null;
    const recapText = recap !== null ? formatReturnRecap(recap.facts, recap.opening) : null;
    // Ahead of a slash command the recap is the whole prompt, and the command
    // goes once the recap's turn ends, through `deliverToAgent`.
    const recapDefersLead = recapOpening === 'before-command';
    if (recapDefersLead) {
      promptTakenFromRow = null;
      pendingTaskOverride = overrideBeforeTake;
    }
    const hasLead = lead !== undefined && lead.trim() !== '';
    // A prefix with no lead goes ahead of the held messages, which join it below.
    const openingLead = recapText === null ? lead : (recapOpening === 'prefix' && hasLead ? `${recapText}\n\n${lead}` : recapText);
    if (recapOpening !== null) {
      console.log(`[spawnAgent] Task ${task.id.slice(0, 8)} returns to its main conversation after a column session of its own; its recap opens the resume (${recapOpening}).`);
    }

    const opening = recapDefersLead
      ? { prompt: openingLead, heldAfterTurn: heldClaim !== null }
      : (promptSlotOpen ? composeOpeningMessage(openingLead, heldClaim?.text) : { prompt: openingLead, heldAfterTurn: false });
    const heldInPrompt = heldClaim !== null && promptSlotOpen && !opening.heldAfterTurn;

    try {
      // Always pass targetAgent so the column's agent_override is respected.
      // Without it a first-time spawn would fall through to the project default.
      const outcome = await engine.resumeSuspendedSession(
        beforeSpawn, toLane.permission_mode, skipPromptTemplate, opening.prompt, signal,
        targetAgent,
        undefined,
        {
          ...resolveSpawnOverrides(beforeSpawn, toLane, project),
          ...(options.resumedBy ? { resumedBy: options.resumedBy } : {}),
        },
      );
      startedAgentInGroup = true;
      // The agent deleted the conversation this move would have resumed, so
      // the task started over from a recap that asks the agent to summarize and
      // wait. The column's messages, the one in the prompt slot included, are
      // not sent; the runner records each as skipped with this reason. Held
      // messages wait for the next start.
      if (outcome?.recapOnly) {
        heldClaim?.release();
        return { withholdMessages: EXPIRED_CONVERSATION_SKIP_REASON };
      }
      // A message the spawn did not send goes out after it, and so does the
      // task's own command: `deliverToAgent` sends both. The spawn did not send
      // it when it did not take the prompt slot, when the engine spawned fresh
      // with the task template as the prompt (the conversation never started
      // or expired on an isolated column, or the column always spawns new), or
      // when the resume could not carry it on its command line
      // (`SpawnOutcome.unsentPrompt`).
      const unsentPrompt = outcome?.unsentPrompt ?? null;
      if (!takesPromptSlot || unsentPrompt !== null) {
        promptTakenFromRow = null;
        pendingTaskOverride = overrideBeforeTake;
      }
      // A continuation the recap took the prompt from (it is a slash command)
      // goes once the recap's turn ends too, with the remainder.
      const continuationDeferred = recapDefersLead && !takesPromptSlot && recapText !== null && !outcome?.startOver;
      if (continuation !== undefined && (unsentPrompt !== null || continuationDeferred)) unsentContinuation = continuation;
      const startedSessionId = tasks.getById(task.id)?.session_id;
      // A resume that started over (its conversation never began) has no
      // conversation to catch up: the recap goes nowhere, and the lead goes as
      // it would have.
      if (recapText !== null && startedSessionId && !outcome?.startOver) {
        // A recap that is the whole opening and could not ride the command
        // line is typed on its own at once, so the turn its mark names is the
        // recap's and no message of this start's goes ahead of it. If it fails,
        // nothing waits on it.
        const typeRecapAlone = (): void => {
          deliverAgentMessageInBackground(context, {
            taskId: task.id,
            sessionId: startedSessionId,
            message: recapText,
            mode: 'immediate',
            verifier: resolveInjectionVerifier(targetAgent, sessionRepo, task.id),
            freshlySpawned: true,
            onOutcome: (report) => {
              if (report.outcome !== 'confirmed' && report.outcome !== 'unconfirmed') forgetRecapSession(startedSessionId, true);
            },
          });
        };
        if (recapDefersLead) {
          markRecapSession(startedSessionId, 'return');
          recapTurnGate = whenRecapTurnEnds(startedSessionId, RETURN_RECAP_TURN_WAIT_MS);
          if (unsentPrompt !== null) typeRecapAlone();
        } else if (recapOpening === 'acknowledge') {
          // Answered in a line with nothing of this start behind it: its turn
          // is a context turn too, so a send-back's findings, which follow the
          // move once this turn ends, start the turn the rows and step judge.
          // Held for the next message instead, the mark would name that
          // message's turn, and its rows and step would not run.
          markRecapSession(startedSessionId, 'return');
          if (unsentPrompt !== null) typeRecapAlone();
        } else if (unsentPrompt !== null) {
          // A prefix goes ahead of the next message this start sends.
          pendingRecap = recapText;
        }
      }
      if (heldClaim !== null && startedSessionId) {
        if (opening.heldAfterTurn) {
          heldAfterLeadTurn = true;
        } else if (heldInPrompt && unsentPrompt === null) {
          // They rode the command line; they count as delivered once it runs.
          commitWhenSessionRuns(context, heldClaim, startedSessionId);
          heldHandedOff = true;
        } else {
          heldJoinsNextMessage = true;
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      // This used to be the deepest silent failure on the board path. The
      // counter stays unconditional; the Sentry report self-excludes for a user
      // configuration error such as a missing CLI, so a misconfigured machine is
      // counted and surfaced without becoming an un-actionable issue.
      console.error('[spawnAgent] Failed to start session:', error);
      trackEvent('spawn_failed', { agent: targetAgent, reason: 'resume' });
      reportHandledError(error, { source: 'spawn', reason: 'resume', agent: targetAgent });
      notifySpawnBlocked(context, beforeSpawn, 'agent', error, options.projectId);
      // Rethrown, unlike the old fallback which returned: the runner records
      // the row that asked for the agent as skipped with this reason, so a
      // failed spawn is visible per automation rather than only in the log.
      throw error;
    }
  };

  const deliverToAgent = async (message: string, mode: AutoCommandMode): Promise<void> => {
    // A recovery move (out of Done) suppresses the column's messages, so
    // everything downstream degrades naturally rather than re-running work.
    if (options.suppressAutoCommand) return;
    if (promptTakenFromRow !== null && promptTakenFromRow === message) {
      promptTakenFromRow = null;
      return;
    }

    const effective = takeMessage(message);
    if (!effective) return;

    const currentTask = tasks.getById(task.id);
    if (!currentTask?.session_id) return;

    // Held messages the spawn's prompt could not carry join the first message
    // typed at the agent, as one delivery. After a slash command they wait for
    // its turn instead (`deliverHeldRemainder`).
    let outgoing = effective;
    let carried: HeldClaim | null = null;
    if (heldJoinsNextMessage && heldClaim !== null && !heldClaim.isSettled()) {
      heldJoinsNextMessage = false;
      const opening = composeOpeningMessage(effective, heldClaim.text);
      if (opening.heldAfterTurn) {
        heldAfterLeadTurn = true;
      } else {
        outgoing = opening.prompt ?? effective;
        carried = heldClaim;
        heldHandedOff = true;
      }
    }
    // A return recap the resume's command line could not carry goes first, in
    // the same message. Never ahead of a slash command, which it would stop:
    // that waits for the remainder instead.
    if (pendingRecap !== null && !isSlashCommand(outgoing)) {
      outgoing = `${pendingRecap}\n\n${outgoing}`;
      pendingRecap = null;
    }

    const sessionId = currentTask.session_id;
    // Keystrokes once the CLI is alive, or, for a message with line breaks, a
    // paste once the fresh agent's first turn ends, whatever the row's mode.
    // Behind a return recap, once the recap's turn has ended.
    afterRecapTurn((freshlySpawned) => {
      deliverAgentMessageInBackground(context, {
        taskId: currentTask.id,
        sessionId,
        message: outgoing,
        mode,
        verifier: resolveInjectionVerifier(targetAgent, sessionRepo, currentTask.id),
        freshlySpawned,
        onOutcome: (report) => {
          reportAutoCommandOutcome(context, tasks, currentTask, report, options.projectId);
          if (carried) settleClaimFromReport(carried, report, { flushOnRelease: true });
        },
      });
    }, () => {
      reportAutoCommandOutcome(context, tasks, currentTask, droppedAfterRecapReport(sessionId, outgoing), options.projectId);
      carried?.release({ flush: true });
    });
  };

  /**
   * What the start owes the agent once the enter group is done and no row
   * carried it: held messages waiting out a slash command's turn, or held
   * messages and a plan continuation the spawn's prompt could not carry, sent
   * on their own. A move superseded meanwhile sends nothing; the `finally`
   * around this function puts the held messages back.
   */
  const deliverHeldRemainder = (): void => {
    if (signal?.aborted) return;
    const sessionId = tasks.getById(task.id)?.session_id;
    if (!sessionId) return;
    const held = heldClaim !== null && !heldClaim.isSettled() && !heldHandedOff ? heldClaim : null;
    if (held !== null && heldAfterLeadTurn) {
      // Behind a return recap, the paste is queued once the recap's turn ends,
      // after the lead, and waits out the lead's own turn as usual.
      afterRecapTurn(() => pasteHeldAfterTurn(context, held, sessionId), () => held.release({ flush: true }));
      heldHandedOff = true;
    }
    const carried = held !== null && heldJoinsNextMessage ? held : null;
    const remainder = [pendingRecap, unsentContinuation, carried?.text].filter((part): part is string => Boolean(part?.trim())).join('\n\n');
    unsentContinuation = null;
    pendingRecap = null;
    if (!remainder) return;
    if (carried) {
      heldJoinsNextMessage = false;
      heldHandedOff = true;
    }
    afterRecapTurn((freshlySpawned) => {
      deliverAgentMessageInBackground(context, {
        taskId: task.id,
        sessionId,
        message: remainder,
        mode: 'immediate',
        verifier: resolveInjectionVerifier(targetAgent, sessionRepo, task.id),
        freshlySpawned,
        onOutcome: (report) => {
          if (carried) settleClaimFromReport(carried, report, { flushOnRelease: true });
        },
      });
    }, () => carried?.release({ flush: true }));
  };

  try {
    const enterSummary = await engine.executeTransition(task, toLane, 'enter', {
      // A caller with no signal (create, promote, MCP create) cannot be
      // superseded, so a controller that never aborts keeps the runner's
      // contract without making the parameter optional there.
      signal: signal ?? new AbortController().signal,
      startAgent,
      // The runner records the skip. `deliverToAgent`'s own early return would
      // leave `send_message` reporting "Delivered" for a message nobody got.
      suppressAgentMessages: options.suppressAutoCommand,
      // The entry this Resume completes already ran the rows that need no agent.
      onlyRowsNeedingAgent: options.resumesEntry,
      deliverToAgent,
      legacySpawnAgent: async (legacyConfig) => {
        const outcome = await engine.runLegacySpawnAgent(
          legacyConfig, task, toLane.permission_mode, signal, targetAgent,
          resolveSpawnOverrides(task, toLane, project),
        );
        startedAgentInGroup = true;
        if (outcome?.recapOnly) legacyStartReport = { withholdMessages: EXPIRED_CONVERSATION_SKIP_REASON };
      },
      showNotification: (input) => showAutomationNotification(context, input),
      onProgress: createProgressCallback(context.mainWindow, task.id),
      fromColumn: resolveFromColumn(),
      toColumn: toLane,
    });
    // The runner recorded every row; this is the other sink, the one that
    // interrupts, and it is rationed per automation per minute.
    reportAutomationFailures(context, enterSummary, task, options.projectId);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // The runner isolates each row, so reaching here means the LIST itself
    // could not run (a repository read failed). The fallback below still tries
    // to start the agent, which is the behavior a column with no automations
    // would have had anyway.
    console.error('[spawnAgent] Automations failed:', error);
  }

  const afterAutomations = tasks.getById(task.id);
  if (!afterAutomations) return;
  if (afterAutomations.session_id) {
    // A row in the group started the agent and no row sent the task's own
    // command, which a message row would have taken first. It goes out now, as
    // after the fallback start below, unless a legacy Start agent row opened on
    // an expired conversation's recap, which is the session's whole prompt. (A
    // recap-only start through `startAgent` already used the command up.)
    // A superseded move sends nothing: the runner rethrows a row's own error
    // when the move was aborted, which the catch above does not read as one.
    if (startedAgentInGroup && pendingTaskOverride !== null && !signal?.aborted) {
      if (legacyStartReport) {
        console.log(`[spawnAgent] Task ${task.id.slice(0, 8)}: the conversation had expired and the agent is waiting on its recap, so the task's command is not sent.`);
      } else {
        await deliverToAgent('', 'immediate');
      }
    }
    deliverHeldRemainder();
    return;
  }

  // Nothing in the list started the agent, so the column's own "Start an agent
  // here" setting does.

  try {
    await startAgent();
    // No row asked for the agent, so the only message is the task's own
    // command. When the spawn did not send it, it goes out now, as it does
    // after a message row. An expired conversation's recap-only start leaves
    // none to send.
    if (pendingTaskOverride !== null) await deliverToAgent('', 'immediate');
    deliverHeldRemainder();
  } catch (error) {
    if (isAbortError(error)) throw error;
    // startAgent has already logged, counted, and notified.
  }
  };

  // Held messages claimed for this start that nothing carried (a failed or
  // superseded spawn, a row that never sent its message) go back on hold, and
  // to the task's agent at once if one is live by now.
  const runAndSettleHeld = async (): Promise<void> => {
    try {
      await run();
    } finally {
      if (heldClaim !== null && !heldHandedOff) heldClaim.release({ flush: true });
    }
  };

  return project?.name ? runWithProjectLogContext(project.name, runAndSettleHeld) : runAndSettleHeld();
}

/**
 * Verifier for a fresh-spawn auto_command, or null when the agent exposes none.
 *
 * Built at SCHEDULE time but resolved at POLL time. That distinction is what
 * makes fresh-spawn injection verifiable at all: the agent's session id is
 * usually not captured yet when the spawn returns, but delivery is deferred
 * until the CLI comes alive, by which point it is. Building eagerly against
 * the id would give up on the exact path that most needed the check.
 */
export function resolveInjectionVerifier(
  agentName: string | null,
  sessionRepo: SessionRepository,
  taskId: string,
): CommandVerifier | null {
  // A task that never spawned records no agent, so there is nothing to resolve
  // and nothing to verify against. The exit-automation caller can reach that.
  if (!agentName) return null;
  const adapter = agentRegistry.get(agentName);
  if (!adapter) return null;
  return buildCommandInjectionVerifier(adapter, sessionRepo, taskId);
}

export interface AutoSpawnForTaskOptions {
  /** See `AgentSpawnOptions.explicitStart`. Forwarded, and also lifts this function's own `auto_spawn` gate. */
  explicitStart?: boolean;
}

/**
 * The gates `autoSpawnForTask` runs under the task lock: once before its
 * unlocked git phase, to decide whether there is anything to do, and once
 * after it, as the compare-and-swap that decides the spawn. Every input is
 * re-read from the DB and the registry on each call, because the column can
 * be edited, the task moved, and a session spawned by another caller while
 * the lock was released.
 *
 * Returns the task row and the profile-folded destination, or null when the
 * spawn must not proceed. The two skips a user can cause mid-flight log; the
 * rest are the quiet "this column does not want an agent" paths. The
 * manually-paused check is NOT here: it lives in `spawnAgent`, which every
 * caller of this function reaches, so it is inherited rather than repeated.
 */
function readAutoSpawnGates(
  context: IpcContext,
  projectId: string,
  projectPath: string,
  taskId: string,
  swimlaneId: string,
  options: AutoSpawnForTaskOptions,
): { fullTask: Task; toLane: Swimlane } | null {
  const rawLane = new SwimlaneRepository(getProjectDb(projectId)).getById(swimlaneId);
  if (!rawLane) return null;

  const fullTask = getProjectRepos(context, projectId).tasks.getById(taskId);
  if (!fullTask) return null;

  // The caller's `swimlaneId` is a snapshot. Callers that batch (the
  // auto_spawn reconcile walks a whole column, awaiting a worktree and a
  // branch checkout per task) can reach this many seconds later, by which
  // time a drag may have moved the task elsewhere. Spawning would then
  // apply the ORIGINAL column's agent, model, and permission mode to a task
  // that has left it. Same re-check task-move makes before its own spawn.
  if (fullTask.swimlane_id !== swimlaneId) {
    console.log(
      `[auto-spawn] Task ${fullTask.id.slice(0, 8)} left the column before its spawn - skipping`,
    );
    return null;
  }

  // A start that races itself. A second caller (two phone Starts a second
  // apart on a slow worktree ensure) arrives to find the session already
  // registered. spawnAgent's own startAgent would bail on the session_id, but
  // the column's enter list would still run, and its message row would deliver
  // to the LIVE session: the column message typed twice. task-move's Phase 3
  // makes an analogous check before its spawn, on `task.session_id` rather
  // than the registry (a stale pointer reads as occupied there; the
  // start-session reconcile has already cleared one here). The auto_spawn
  // reconcile filters live tasks before calling here, so for it this is
  // defense in depth.
  if (context.sessionManager.findLiveSessionByTaskId(fullTask.id)) {
    console.log(
      `[auto-spawn] Task ${fullTask.id.slice(0, 8)} already has a live session - skipping`,
    );
    return null;
  }

  // Fold the task's Board Profile BEFORE the auto_spawn guard. `auto_spawn`
  // is profile-scoped (see the `auto_spawn` case in `applyProfileToLane`),
  // so a profile can turn it on for a column whose base has it off.
  // Guarding on the raw lane rejected exactly those tasks here, before
  // spawnAgent's own fold could ever see them. spawnAgent folds again
  // internally, which is idempotent.
  const toLane = applyProfileToLane(rawLane, loadTaskProfile(context, fullTask, projectPath)) ?? rawLane;
  if (!toLane.auto_spawn && !options.explicitStart) return null;
  // Same role gate as spawnAgent, and for the same reason: a profile fold
  // or an MCP update can leave the flag on for a To Do column.
  if (!laneMaySpawn(toLane)) return null;

  return { fullTask, toLane };
}

/**
 * Auto-spawn an agent session for a newly created task when the target
 * swimlane has `auto_spawn` enabled. Handles worktree setup, branch checkout,
 * transition engine execution, session resume fallback, and auto-command
 * injection.
 *
 * Called from both the SessionManager `task-created` event (internal MCP
 * bridge) and the external CommandBridge `onTaskCreated` callback, from the
 * auto_spawn reconcile, from the startup pass for a task that never had an
 * agent (`autoSpawnTasks`' `startFirstAgent`, wired in `handlers/projects.ts`),
 * from a workflow's Resume for a task in an agent column with none
 * (`resumeWorkflow`), and from the phone's start-session verb
 * (`handlers/session-start.ts`), which is the one caller passing `explicitStart`.
 *
 * Split-locked the way SESSION_RESUME and handleTaskMove are (see
 * `withTaskLock`'s JSDoc): Phase 1 runs the gates under the task lock, Phase 2
 * releases it for the worktree ensure and branch checkout (a fetch can take
 * many seconds, and both are already serialized per project by
 * `WorktreeManager.projectQueues`), and Phase 3 re-acquires it, re-runs the
 * gates as the CAS, and spawns. Holding the lock across the git phase made a
 * desktop Pause or move on the same task wait behind a phone Start stuck in
 * a slow fetch.
 */
export async function autoSpawnForTask(
  context: IpcContext,
  projectId: string,
  task: { id: string; title: string },
  swimlaneId: string,
  options: AutoSpawnForTaskOptions = {},
): Promise<void> {
  // Tag the worktree/checkout/spawn logs below with the project the new task
  // belongs to. This is the entry point for MCP-created-task spawns, which
  // have no enclosing move context to inherit a tag from.
  const logProjectName = context.projectRepo.getById(projectId)?.name ?? null;
  const run = async (): Promise<void> => {
    // Registered on the same per-task registry SESSION_RESUME uses, so
    // SESSION_SUSPEND, SESSION_RESET, a newer SESSION_RESUME, and a project
    // relocation cancel this spawn's git phase exactly as they cancel a
    // desktop resume's. Registered WITHOUT `abortInFlightResume` first,
    // unlike SESSION_RESUME: a phone Start must never cancel desktop work
    // (see startTaskSession in handlers/session-start.ts). The registry holds
    // every in-flight controller per task, so registering alongside an
    // in-flight desktop resume leaves that resume just as cancellable, and
    // the two converge on one session through the Phase 3 gates.
    const controller = new AbortController();
    registerResumeController(task.id, controller);
    const { signal } = controller;
    try {
      // === Phase 1 (locked, short) ===
      const plan = await withTaskLock(task.id, async () => {
        const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
        if (!projectPath) return null;
        const gates = readAutoSpawnGates(context, projectId, projectPath, task.id, swimlaneId, options);
        return gates ? { ...gates, projectPath } : null;
      });
      if (!plan) return;
      const { fullTask, projectPath } = plan;
      const { tasks, automations, automationRuns, attachments } = getProjectRepos(context, projectId);

      // MCP auto-spawn used to be progress-silent end to end; the card now
      // shows the same fetch/branch/worktree phases the drag path does. The
      // finally clears the label on every exit: the blocked returns, a Phase 3
      // gate that changed during the git phase, and an abort.
      const onProgress = createProgressCallback(context.mainWindow, fullTask.id);
      try {
        // === Phase 2 (unlocked, slow) ===
        // The signal cancels an in-flight fetch; an AbortError is rethrown
        // past the per-step notice, since a cancelled spawn is not a blocked
        // one, and lands in the outer catch's abort branch.
        try {
          await ensureTaskWorktree(context, fullTask, tasks, projectPath, { signal, onProgress, projectId });
        } catch (worktreeError) {
          if (isAbortError(worktreeError)) throw worktreeError;
          console.error('[auto-spawn] Worktree creation failed:', worktreeError);
          notifySpawnBlocked(context, fullTask, 'worktree', worktreeError, projectId);
          return;
        }

        // Checkout the task's branch for non-worktree tasks. ensureTaskBranchCheckout
        // decides for itself whether there is anything to check out, and refuses to
        // touch a directory another task's agent is live in. The occupancy check
        // used to be inlined here "to avoid circular import with task-move.ts";
        // that cycle never existed from task-git.ts, and the copy had drifted from
        // the original in exactly the way that let a custom-branch task through.
        try {
          await ensureTaskBranchCheckout(context, fullTask, projectPath, { signal, onProgress, projectId });
        } catch (checkoutError) {
          if (isAbortError(checkoutError)) throw checkoutError;
          console.error('[auto-spawn] Branch checkout failed:', checkoutError);
          // The explicit projectId, never the ambient current one: MCP auto-spawn
          // targets whichever project the tool named, which is often not the
          // focused one. Falling back to `context.currentProjectId` would stamp
          // the notice with the wrong project, and the renderer filters on it.
          notifySpawnBlocked(context, fullTask, 'checkout', checkoutError, projectId);
          return;
        }

        // === Phase 3 (locked, short) ===
        // Re-read everything: the task may have moved, another caller may have
        // spawned, and the column may have been edited during Phase 2. The
        // task row is re-read rather than reusing Phase 1's, so the worktree
        // the git phase recorded on it is what the spawn sees.
        await withTaskLock(task.id, async () => {
          signal.throwIfAborted();
          const current = readAutoSpawnGates(context, projectId, projectPath, task.id, swimlaneId, options);
          if (!current) {
            console.log(
              `[auto-spawn] Task ${task.id.slice(0, 8)}: a spawn gate changed during the git phase - skipping`,
            );
            return;
          }

          const sessionRepo = new SessionRepository(getProjectDb(projectId));
          const engine = createTransitionEngine(context, automations, automationRuns, tasks, sessionRepo, attachments, projectId, projectPath);

          await spawnAgent({
            context, engine, tasks, sessionRepo, task: current.fullTask, fromSwimlaneId: '*', toLane: current.toLane,
            projectId, projectPath, attachments, signal,
            explicitStart: options.explicitStart,
          });

          console.log(`[auto-spawn] Spawned agent for "${task.title}" in ${current.toLane.name}`);
        });
      } finally {
        clearSpawnProgress(context.mainWindow, fullTask.id);
      }
    } catch (err) {
      if (isAbortError(err)) {
        // A suspend, reset, newer resume, or relocation took the task over.
        // Not a spawn failure: no counter, no Sentry report, no notice. And
        // no session cleanup, deliberately: executeSpawnAgent's last abort
        // checkpoint sits before sessionManager.spawn, and the session_id
        // write plus the session-record insert follow the spawn with no
        // further checkpoint, so an abort never leaves a half-written
        // session, and the aborter reconciles a live one under its own lock.
        // (An enter-automation row that already ran stays run, as it does
        // for an aborted drag.) resumeTaskSession's abort path
        // (session-resume.ts) cleans up nothing either, for the same reason: a
        // removeByTaskId there dropped the task's paused row.
        console.log(
          `[auto-spawn] Aborted in-flight spawn for task ${task.id.slice(0, 8)} (a suspend, reset, or newer resume took over)`,
        );
        return;
      }
      console.error('[auto-spawn] Failed:', err);
      // The task row is scoped to the try, so re-read it here; its override
      // is the best approximation of the agent on this path.
      let failedAgent = 'default';
      try {
        failedAgent =
          getProjectRepos(context, projectId).tasks.getById(task.id)?.agent_override ?? 'default';
      } catch {
        // DB may be closed; keep the placeholder
      }
      trackEvent('spawn_failed', { agent: failedAgent, reason: 'auto_spawn' });
      reportHandledError(err, { source: 'spawn', reason: 'auto_spawn', agent: failedAgent });
    } finally {
      releaseResumeController(task.id, controller);
    }
  };
  return logProjectName ? runWithProjectLogContext(logProjectName, run) : run();
}
