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
import { buildSessionHistoryReference } from '../../agent/handoff/session-history-reference';
import { DEFAULT_AGENT, NEVER_AUTO_SPAWN_ROLES } from '../../../shared/types';
import type { Task, Swimlane, Project, AutoCommandMode } from '../../../shared/types';
import { showDesktopNotification } from '../handlers/system';
import { reportAutomationFailures } from './automation-failures';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { runSpawnPreamble, projectModelDefaultsApply } from '../../transition-engine/spawn-preamble';
import { isResumeEligible } from '../../transition-engine/spawn-intent';
import { resolveIsolatedSwimlaneId, resolveForceFresh } from '../../transition-engine/session-isolation';
import { resolveEffectiveAutoCommand, resolveColumnMessage, applyProfileToLane } from '../../transition-engine/column-strategy';
import { loadTaskProfile } from './task-profile';
import { buildCommandInjectionVerifier } from '../../transition-engine/injection-plan';
import type { CommandVerifier } from '../../transition-engine/terminal-submit-scheduler';
import { reportAutoCommandOutcome } from './auto-command-outcome';
import { emitSpawnProgress, createProgressCallback, clearSpawnProgress } from '../../transition-engine/spawn-progress';
import { ensureTaskWorktree, ensureTaskBranchCheckout, notifySpawnBlocked } from './task-git';
import { getProjectRepos } from './project-repos';
import { withTaskLock } from '../task-lifecycle-lock';
import { runWithProjectLogContext } from '../../diagnostics/project-log-context';

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
  );
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
   * Set by plan-exit auto-moves ("Your plan was approved...") so a respawned
   * session continues instead of resuming idle. Only delivered on a RESUME of
   * an existing conversation - a fresh session has no plan context to
   * continue. The column's auto_command always wins when present.
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

  // Guard: if the user manually paused this task, don't auto-resume. Only an
  // explicit user gesture restarts it: the desktop's Resume button
  // (SESSION_RESUME) or a caller passing `explicitStart` (the phone's
  // start-session verb).
  const latestSession = sessionRepo.getLatestForTask(task.id);
  if (
    latestSession?.status === 'suspended'
    && latestSession.suspended_by === 'user'
    && !options.explicitStart
  ) {
    console.log(`[spawnAgent] Skipping auto-spawn for task ${task.id.slice(0, 8)} (manually paused by user)`);
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
      // Locate the source agent's native session history file.
      // The file path is derived from the session's agent_session_id + cwd.
      const latestSessionRecord = sessionRepo.getLatestForTask(task.id);
      let sessionFilePath: string | null = null;

      if (latestSessionRecord?.agent_session_id) {
        const sourceAdapter = agentRegistry.get(sourceAgent);
        if (sourceAdapter) {
          sessionFilePath = await sourceAdapter.locateSessionHistoryFile(
            latestSessionRecord.agent_session_id,
            latestSessionRecord.cwd,
          );
        }
      }

      // Determine if the target agent has MCP access (currently only Claude).
      const targetAdapter = agentRegistry.get(targetAgent);
      const targetHasMcpAccess = targetAdapter?.name === 'claude';

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

    try {
      await engine.resumeSuspendedSession(
        task, toLane.permission_mode, skipPromptTemplate, undefined, signal,
        targetAgent,
        handoffPromptPrefix,
        resolveSpawnOverrides(task, toLane, project),
      );
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
      const columnMessage = resolveColumnMessage(
        getProjectRepos(context, options.projectId).automations.listForColumn(toLane.id),
      );
      const taskOverride = currentTask.auto_command?.trim();
      const effectiveAutoCommand = resolveEffectiveAutoCommand(currentTask.auto_command, columnMessage?.message);
      if (!options.suppressAutoCommand && effectiveAutoCommand?.trim()) {
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
        const interpolated = taskOverride
          ? interpolateTaskTemplate(effectiveAutoCommand, vars)
          : interpolateTemplate(effectiveAutoCommand, vars);
        context.terminalSubmitScheduler.scheduleKeystrokes(
          currentTask.id,
          currentTask.session_id,
          [{ text: interpolated, verify: 'submitted' }],
          {
            freshlySpawned: true,
            verifier: resolveInjectionVerifier(targetAgent, sessionRepo, currentTask.id),
            mode: columnMessage?.mode ?? 'immediate',
            onOutcome: (report) => reportAutoCommandOutcome(context, tasks, currentTask, report, options.projectId),
          },
        );
      }
    }

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

  const startAgent = async (pendingPrompt?: string): Promise<void> => {
    const beforeSpawn = tasks.getById(task.id);
    if (!beforeSpawn || beforeSpawn.session_id) return;

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
    const message = takeMessage(pendingPrompt ?? '');
    const takesPromptSlot = message !== '' && (canResumeDestination || skipPromptTemplate === true);
    if (takesPromptSlot && pendingPrompt !== undefined) promptTakenFromRow = pendingPrompt;

    // The continuation prompt (plan-exit auto-move) is a resume-only fallback:
    // the column's message is the user's explicit automation and wins, and a
    // fresh spawn has no prior conversation for "proceed" to refer to.
    const resumePrompt = takesPromptSlot
      ? message
      : (canResumeDestination ? options.continuationPrompt : undefined);

    try {
      // Always pass targetAgent so the column's agent_override is respected.
      // Without it a first-time spawn would fall through to the project default.
      await engine.resumeSuspendedSession(
        beforeSpawn, toLane.permission_mode, skipPromptTemplate, resumePrompt, signal,
        targetAgent,
        undefined,
        resolveSpawnOverrides(beforeSpawn, toLane, project),
      );
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

    context.terminalSubmitScheduler.scheduleKeystrokes(
      currentTask.id,
      currentTask.session_id,
      [{ text: effective, verify: 'submitted' }],
      {
        freshlySpawned: true,
        verifier: resolveInjectionVerifier(targetAgent, sessionRepo, currentTask.id),
        mode,
        onOutcome: (report) => reportAutoCommandOutcome(context, tasks, currentTask, report, options.projectId),
      },
    );
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
      deliverToAgent,
      legacySpawnAgent: (legacyConfig) => engine.runLegacySpawnAgent(
        legacyConfig, task, toLane.permission_mode, signal, targetAgent,
        resolveSpawnOverrides(task, toLane, project),
      ),
      showNotification: (input) => showDesktopNotification(context, input),
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

  // Nothing in the list started the agent, so the column's own "Start an agent
  // here" setting does. An automation that started one already returned above.
  const afterAutomations = tasks.getById(task.id);
  if (!afterAutomations || afterAutomations.session_id) return;

  try {
    await startAgent();
  } catch (error) {
    if (isAbortError(error)) throw error;
    // startAgent has already logged, counted, and notified.
  }
  };

  return project?.name ? runWithProjectLogContext(project.name, run) : run();
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
 * Auto-spawn an agent session for a newly created task when the target
 * swimlane has `auto_spawn` enabled. Handles worktree setup, branch checkout,
 * transition engine execution, session resume fallback, and auto-command
 * injection.
 *
 * Called from both the SessionManager `task-created` event (internal MCP
 * bridge) and the external CommandBridge `onTaskCreated` callback, from the
 * auto_spawn reconcile, and from the phone's start-session verb
 * (`handlers/session-start.ts`), which is the one caller passing
 * `explicitStart`.
 */
export async function autoSpawnForTask(
  context: IpcContext,
  projectId: string,
  task: { id: string; title: string },
  swimlaneId: string,
  options: AutoSpawnForTaskOptions = {},
): Promise<void> {
  // Serialize against any other task-lifecycle op (suspend/resume/move/kill)
  // so an MCP-created auto-spawn can't race a user drag of the same task.
  return withTaskLock(task.id, async () => {
    // Tag the worktree/checkout/spawn logs below with the project the new task
    // belongs to. This is the entry point for MCP-created-task spawns, which
    // have no enclosing move context to inherit a tag from.
    const logProjectName = context.projectRepo.getById(projectId)?.name ?? null;
    const run = async (): Promise<void> => {
    try {
      const db = getProjectDb(projectId);
      const swimlaneRepo = new SwimlaneRepository(db);
      const rawLane = swimlaneRepo.getById(swimlaneId);
      if (!rawLane) return;

      const project = context.projectRepo.getById(projectId);
      const projectPath = project?.path ?? null;
      if (!projectPath) return;

      const { tasks, automations, automationRuns, attachments } = getProjectRepos(context, projectId);
      const fullTask = tasks.getById(task.id);
      if (!fullTask) return;

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
        return;
      }

      // A start that races itself. A second caller queued on this lock while
      // the first was still spawning (two phone Starts a second apart on a slow
      // worktree ensure) arrives to find the session already registered.
      // spawnAgent's own startAgent would bail on the session_id, but the
      // column's enter list would still run, and its message row would deliver
      // to the LIVE session: the column message typed twice. task-move's Phase
      // 3 makes an analogous check before its spawn, on `task.session_id`
      // rather than the registry (a stale pointer reads as occupied there; the
      // reconcile above has already cleared one here). The auto_spawn
      // reconcile filters live tasks before calling here, so for it this is
      // defense in depth.
      if (context.sessionManager.findLiveSessionByTaskId(fullTask.id)) {
        console.log(
          `[auto-spawn] Task ${fullTask.id.slice(0, 8)} already has a live session - skipping`,
        );
        return;
      }

      // Fold the task's Board Profile BEFORE the auto_spawn guard. `auto_spawn`
      // is profile-scoped (see the `auto_spawn` case in `applyProfileToLane`),
      // so a profile can turn it on for a column whose base has it off.
      // Guarding on the raw lane rejected exactly those tasks here, before
      // spawnAgent's own fold could ever see them. spawnAgent folds again
      // internally, which is idempotent.
      const toLane = applyProfileToLane(rawLane, loadTaskProfile(context, fullTask, projectPath)) ?? rawLane;
      if (!toLane.auto_spawn && !options.explicitStart) return;
      // Same role gate as spawnAgent, and for the same reason: a profile fold
      // or an MCP update can leave the flag on for a To Do column.
      if (!laneMaySpawn(toLane)) return;

      // MCP auto-spawn used to be progress-silent end to end; the card now
      // shows the same fetch/branch/worktree phases the drag path does. The
      // finally clears the label on every exit, including the blocked returns.
      const onProgress = createProgressCallback(context.mainWindow, fullTask.id);
      try {
        try {
          await ensureTaskWorktree(context, fullTask, tasks, projectPath, { onProgress, projectId });
        } catch (worktreeError) {
          console.error('[MCP auto-spawn] Worktree creation failed:', worktreeError);
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
          await ensureTaskBranchCheckout(context, fullTask, projectPath, { onProgress, projectId });
        } catch (checkoutError) {
          console.error('[MCP auto-spawn] Branch checkout failed:', checkoutError);
          // The explicit projectId, never the ambient current one: MCP auto-spawn
          // targets whichever project the tool named, which is often not the
          // focused one. Falling back to `context.currentProjectId` would stamp
          // the notice with the wrong project, and the renderer filters on it.
          notifySpawnBlocked(context, fullTask, 'checkout', checkoutError, projectId);
          return;
        }

        const sessionRepo = new SessionRepository(db);
        const engine = createTransitionEngine(context, automations, automationRuns, tasks, sessionRepo, attachments, projectId, projectPath);

        await spawnAgent({
          context, engine, tasks, sessionRepo, task: fullTask, fromSwimlaneId: '*', toLane, projectId, projectPath, attachments,
          explicitStart: options.explicitStart,
        });

        console.log(`[MCP auto-spawn] Spawned agent for "${task.title}" in ${toLane.name}`);
      } finally {
        clearSpawnProgress(context.mainWindow, fullTask.id);
      }
    } catch (err) {
      console.error('[MCP auto-spawn] Failed:', err);
      // fullTask/toLane are declared inside the try, so re-read the row here;
      // its override is the best approximation of the agent on this path.
      let failedAgent = 'default';
      try {
        failedAgent =
          getProjectRepos(context, projectId).tasks.getById(task.id)?.agent_override ?? 'default';
      } catch {
        // DB may be closed; keep the placeholder
      }
      trackEvent('spawn_failed', { agent: failedAgent, reason: 'auto_spawn' });
      reportHandledError(err, { source: 'spawn', reason: 'auto_spawn', agent: failedAgent });
    }
    };
    return logProjectName ? runWithProjectLogContext(logProjectName, run) : run();
  });
}
