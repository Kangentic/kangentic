import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Task,
  ActionConfig,
  AppConfig,
  PermissionMode,
  Swimlane,
  AutomationConfig,
  AutomationTrigger,
  AutoCommandMode,
  ColumnAutomation,
  ConversationExpiredNotice,
  NotificationInput,
  SessionResumer,
} from '../../shared/types';
import { runAutomations, SENT_WITH_THE_MOVE, type AgentStartReport, type AutomationRunSummary } from '../automations/automation-runner';
import { automationNeedsAgent, canTaskRunAutomations } from '../../shared/automation-manifest';
import { englishText } from '../../shared/i18n/english';
import type { AutomationContext } from '../automations/shared/automation-adapter';
import type { ConditionCheckCall, ConditionCheckLimits, ConditionCheckOutcome } from '../automations/condition-check/condition-check';
import type { ConditionPromptInput } from '../automations/condition-check/condition-prompt';
import type { AutomationRepository } from '../db/repositories/automation-repository';
import type { AutomationRunRepository, RunConditionAnswer } from '../db/repositories/automation-run-repository';
import { interpolateTaskTemplate } from '../agent/shared/template-utils';
import { DEFAULT_SPAWN_PROMPT_TEMPLATE } from '../../shared/task-template-vars';
import { readWorkflowPromptFacts } from '../workflows/workflow-prompt-facts';
import { SessionManager } from '../pty/session-manager';
import { releaseCommandHold } from '../pty/lifecycle/adapter-lifecycle';
import type { TerminalSubmit } from '../pty/terminal-submit';
import { resolveTaskTemplateVars } from '../agent/shared';
import { resolveExecutionTarget } from '../agent/shared/execution-target';
import { resolveLaunchOptions } from '../agent/shared/launch-options';
import { resolveShimLaunch } from '../agent/shared/shim-launch';
import { cliPathForTarget, resolveCliTarget, serializeCliTarget, shellForTarget, toStoredCliTarget } from '../agent/shared/cli-target';
import { mapHandoffSessionPath } from '../agent/shared/prompt-xml';
import { agentRegistry } from '../agent/agent-registry';
import { AgentCliNotFoundError } from '../agent/shared/agent-cli-not-found';
import { appendCallerSession } from '../agent/mcp-http/caller-url';
import { getDevPortForTask } from '../dev-ports/dev-port-allocator';
import { retireRecord } from './session-lifecycle';
import { resolveEffectivePermissionMode } from './spawn-preamble';
import { resolveSpawnIntent } from './spawn-intent';
import { migrateResumeCwdIfRenamed } from './resume-cwd-migration';
import { resumePromptRidesCommandLine } from './resume-prompt-delivery';
import { reconcileResumeAgentSessionId } from './resume-id-reconcile';
import { assessResumeConversation, resolveResumeLineage, type StartOverReason } from './resume-conversation-guard';
import { commandLineLength } from '../agent/shared/prompt-budget';
import { markRecapSession } from '../automations/turn-end/recap-turns';
import {
  buildExpiredConversationRecap,
  type ExpiredConversationRecapSources,
} from '../agent/shared/expired-conversation-recap';
import { sessionOutputPaths } from './session-paths';
import { notePlanApprovalSpawn, planSpawnNeedsBypass } from '../plan-approval/plan-approval-spawns';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { AttachmentRepository } from '../db/repositories/attachment-repository';

interface TransitionEngineConfig {
  permissionMode: string;
  projectPath: string | null;
  projectId: string;
  /**
   * The open project's display name. Carried so `{{projectName}}` can resolve
   * and so a webhook payload can say which project it came from. The factory
   * already reads the project row for `default_agent` and used to drop the rest.
   */
  projectName: string | null;
  gitConfig: AppConfig['git'];
  mcpServerEnabled?: boolean;
  /** Project-scoped URL for the in-process MCP HTTP server. */
  mcpServerUrl?: string;
  /** Per-launch MCP server token (X-Kangentic-Token header). */
  mcpServerToken?: string;
  defaultAgent: string;
  cliPathOverrides: Record<string, string | null>;
  /** Global, agent-keyed remote-server identity (url + auth). */
  executionServers: AppConfig['agent']['executionServers'];
  /** Per-project, agent-keyed local/remote choice + server working directory. */
  execution: AppConfig['agent']['execution'];
  /** Global, agent-keyed boolean launch-option toggles (agent name -> option id -> enabled). */
  launchOptions: AppConfig['agent']['launchOptions'];
}

/**
 * Column-resolved spawn knobs. `model`/`effort` are passed through to
 * `CommandOptions` and translated to CLI flags by the resolved adapter (e.g.
 * Claude `--model` / `--effort`); empty/null values are forwarded as undefined,
 * leaving the agent default in place. `isolatedSwimlaneId` is consumed by the
 * spawn-intent resolver and persistence (not the CLI): it selects which session to
 * resume (null = the task's main session, a swimlane id = that column's isolated
 * session).
 */
export interface SpawnOverrides {
  model?: string | null;
  effort?: string | null;
  /** Isolated swimlane to resume/persist. Defaults to null (main session). */
  isolatedSwimlaneId?: string | null;
  /**
   * Force a fresh spawn on the target track (retiring any prior session), set by
   * an 'always_spawn_new' column. Defaults to false (resume if one exists).
   */
  forceFresh?: boolean;
  /**
   * Who resumes the session when it is not a person (`SpawnSessionInput.resumedBy`):
   * the workflow's memory resume passes `'memory'`.
   */
  resumedBy?: SessionResumer;
}

/**
 * What the engine borrows from the app for automations, injected so the engine
 * stays free of the IPC context. `checkConditions` answers Conditions on the
 * Automation agent (`automations/condition-check/`); absent, a row with a
 * Condition is skipped with the reason.
 */
export interface TransitionEngineServices {
  checkConditions?: (
    input: ConditionPromptInput,
    limits?: ConditionCheckLimits,
    call?: ConditionCheckCall,
  ) => Promise<ConditionCheckOutcome>;
  /**
   * Where the recap of an expired conversation reads the task's summary, the
   * old conversation's last turns and the branch. Absent, the recap carries the
   * task alone.
   */
  recapSources?: ExpiredConversationRecapSources;
  /** Told once a session has started fresh because the agent deleted its conversation. */
  onConversationExpired?: (notice: ConversationExpiredNotice) => void;
  /**
   * The HEAD commit of the checkout an isolated column's session starts in, or
   * null when it cannot be read (`SessionRecord.start_head_sha`). Absent, no
   * start HEAD is recorded.
   */
  readStartHead?: (cwd: string) => Promise<string | null>;
}

/**
 * What a spawn did with the resume it was asked for. A caller that put a
 * column's message in the resume's prompt slot reads it to record that message
 * as not sent.
 */
export interface SpawnOutcome {
  /**
   * Why a resume became a fresh spawn: the conversation never had a turn, or
   * the agent deleted it. Null when the spawn ran as resolved.
   */
  startOver: StartOverReason | null;
  /**
   * True when the new session's only prompt is the recap (an expired main
   * session): it asks the agent to summarize and wait, so nothing else is sent
   * to it on this move.
   */
  recapOnly: boolean;
  /**
   * The text the caller handed this spawn that is not in its command, for the
   * caller to type in once the agent is ready. Null when nothing was left out.
   *
   * Set in two cases. A fresh spawn takes the task template over the resume's
   * prompt (a resume that started over, a forced-fresh spawn), so the carried
   * message is left out. And a resume whose prompt cannot ride its command
   * line (`resumePromptRidesCommandLine`: an adapter whose CLI takes no prompt
   * on resume, a launch that would flatten its lines, a prompt over the cap)
   * keeps the whole prompt off it, the handoff pointer included. Several CLIs
   * once dropped a resume prompt while the spawn reported it sent, so the
   * caller skipped its typed fallback and the column's message never arrived.
   */
  unsentPrompt: string | null;
}

/** Options shared by every way into an automation group. */
interface AutomationGroupOptions {
  signal: AbortSignal;
  startAgent?: (pendingPrompt?: string) => Promise<AgentStartReport | void>;
  // `signal` is the automation run's own, so a caller that WAITS for
  // delivery (the exit hook does; see `deliverExitMessage`) is bounded by
  // the same budget that bounds every other row. A caller that only
  // schedules delivery ignores it.
  deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal) => Promise<void>;
  legacySpawnAgent?: (config: AutomationConfig) => Promise<void>;
  showNotification: (input: NotificationInput) => void;
  onProgress?: (phase: string) => void;
  fromColumn?: Swimlane | null;
  toColumn?: Swimlane | null;
  /** Rows the caller delivered itself. See `RunAutomationsOptions`. */
  alreadyDelivered?: ReadonlySet<string>;
  /** A recovery move out of Done. See `RunAutomationsOptions`. */
  suppressAgentMessages?: boolean;
  /** The task's agent is paused. See `RunAutomationsOptions`. */
  agentPaused?: boolean;
  groupBudgetMs?: number;
  /** Turn end only: the agent's final message of the turn, for `{{agentReply}}` and Conditions. */
  agentReply?: string | null;
  /** Turn end only: Conditions the caller already answered (see `RunAutomationsOptions`). */
  conditionAnswers?: ReadonlyMap<string, RunConditionAnswer>;
  /** Turn end only: why a Condition without an answer could not be checked. */
  conditionUnavailableReason?: string;
  /** Turn end only: the call that ran without answering (a timeout), so its skips link to it. */
  conditionUnavailableCallId?: string | null;
  /** Turn end only: move the task, for a Move to column row (`AutomationContext.moveTask`). */
  moveTask?: AutomationContext['moveTask'];
}

export class TransitionEngine {
  constructor(
    private sessionManager: SessionManager,
    private terminalSubmit: TerminalSubmit,
    private taskRepo: TaskRepository,
    private getConfig: () => TransitionEngineConfig,
    private sessionRepo?: SessionRepository,
    private attachmentRepo?: AttachmentRepository,
    private automationRepo?: AutomationRepository,
    private automationRunRepo?: AutomationRunRepository,
    private services: TransitionEngineServices = {},
  ) {}

  /**
   * Resume a suspended session for a task. Used when moving out of
   * Backlog/Done into a non-agent column (no spawn_agent transition fires).
   */
  async resumeSuspendedSession(task: Task, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, resumePrompt?: string, signal?: AbortSignal, agentOverride?: string, handoffPromptPrefix?: string, spawnOverrides?: SpawnOverrides): Promise<SpawnOutcome> {
    signal?.throwIfAborted();
    const attachmentPaths = this.attachmentRepo?.getPathsForTask(task.id) ?? [];
    // {{task_xml}} wraps title/description in a <task> envelope (Anthropic +
    // OpenAI guidance for clear data/instruction boundaries). The XML body
    // uses the RAW description so multi-line markdown content survives end
    // to end - quoteArg's `multiline: true` opt-in keeps newlines through
    // shell delivery. The legacy `{{description}}` prose var stays sanitized
    // so user-customized single-line templates don't break.
    const templateVars = resolveTaskTemplateVars({
      task,
      defaultBaseBranch: this.getConfig().gitConfig.defaultBaseBranch,
      attachmentPaths,
      devPort: getDevPortForTask(task.id),
      projectPath: this.getConfig().projectPath,
      projectName: this.getConfig().projectName ?? null,
      // A spawn prompt is not a move, so the four move keywords resolve empty
      // here and the picker does not offer them in this context.
      move: null,
      // A workflow task's <workflow> block; null for every other task.
      workflow: readWorkflowPromptFacts(task, this.getConfig().projectId),
    });
    return this.executeSpawnAgent({
      promptTemplate: skipPromptTemplate ? undefined : DEFAULT_SPAWN_PROMPT_TEMPLATE,
    }, task, templateVars, permissionOverride, resumePrompt, signal, agentOverride, handoffPromptPrefix, spawnOverrides);
  }

  /**
   * Run one column's automations for one trigger.
   *
   * This replaced a `switch` over seven action types. The dispatch now goes
   * through `automationRegistry`, and the per-row guarantees (isolation,
   * timeouts, the run record, retry) live in `runAutomations`, which is where
   * they can be tested once instead of being re-implemented per type.
   *
   * Kept named `executeTransition` deliberately: it is one of the two call
   * sites `spawn-entry-point-parity.test.ts` classifies, and renaming it would
   * quietly take the board path out of that guard's sight.
   */
  async executeTransition(
    task: Task,
    column: Swimlane,
    trigger: AutomationTrigger,
    options: AutomationGroupOptions & {
      /**
       * Run only these rows of the group, in the group's order. The turn-end
       * group passes the rows still pending this visit; every other caller
       * runs the whole group.
       */
      onlyIds?: ReadonlySet<string>;
      /**
       * Run only the rows that need the agent, and record nothing for the
       * rest: the Resume of an agent that was paused when its task entered this
       * column, whose other rows ran at that entry (`agentPaused`). A recovery
       * entry out of Done ran none, and its Resume sends the agent nothing.
       */
      onlyRowsNeedingAgent?: boolean;
    },
  ): Promise<AutomationRunSummary> {
    const empty: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
    if (!this.automationRepo || !this.automationRunRepo) return empty;

    const all = this.automationRepo.getForTrigger(column.id, trigger);
    const automations = all.filter((row) => (!options.onlyIds || options.onlyIds.has(row.id))
      && (!options.onlyRowsNeedingAgent || automationNeedsAgent(row.type)));
    if (automations.length === 0) return empty;

    // The task's own switch, read fresh rather than from the caller's object:
    // a turn end's object predates its paint wait and Condition check.
    const runnable = canTaskRunAutomations(this.taskRepo.getById(task.id) ?? task);
    if (!runnable.ok) return this.recordTaskHeld(automations, task, column, englishText(runnable.reason), options.alreadyDelivered);

    return this.runAutomationGroup(automations, task, column, trigger, options);
  }

  /**
   * Every row of a group skipped because the task's automations are disabled,
   * one record each with the reason, so the run log says why the task did not
   * move. Nothing runs and no agent starts here: a cold spawn's own fallback
   * still starts the agent as the column's Start an agent setting says.
   *
   * A row the move already typed went out before the switch was thrown, so it
   * is recorded as sent, the way the runner records it, not as skipped.
   */
  private recordTaskHeld(
    automations: ColumnAutomation[],
    task: Task,
    column: Swimlane,
    reason: string,
    alreadyDelivered: ReadonlySet<string> | undefined,
  ): AutomationRunSummary {
    const summary: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
    for (const automation of automations) {
      const runId = randomUUID();
      if (alreadyDelivered?.has(automation.id)) {
        this.automationRunRepo?.recordDeliveredByCaller({ id: runId, automation, taskId: task.id }, SENT_WITH_THE_MOVE);
        summary.outcomes.push({ runId, automationId: automation.id, name: automation.name, columnName: column.name, status: 'succeeded', detail: SENT_WITH_THE_MOVE });
        continue;
      }
      this.automationRunRepo?.recordSkipped({ id: runId, automation, taskId: task.id }, reason);
      summary.outcomes.push({ runId, automationId: automation.id, name: automation.name, columnName: column.name, status: 'skipped', detail: reason });
    }
    return summary;
  }

  /**
   * Re-run ONE automation against the task's CURRENT state.
   *
   * Separate from `executeTransition` because there is no transition: the task
   * is wherever it is now, which may not be this automation's column at all.
   * That is deliberate and is what the toast and the row both say, because a
   * task can have moved twice since a failure and replaying a stale context
   * would be a worse lie than not offering the button.
   *
   * No `startAgent`: a re-run is not a move, so it must not spawn. A row that
   * needs an agent the task does not have records the skip with the reason,
   * exactly as an exit row does.
   */
  async executeSingleAutomation(
    task: Task,
    column: Swimlane,
    automation: ColumnAutomation,
    options: {
      signal: AbortSignal;
      deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal) => Promise<void>;
      showNotification: (input: NotificationInput) => void;
      onProgress?: (phase: string) => void;
      /**
       * The caller's own budget. Without it the runner falls back to the
       * trigger default, which caps a re-run of an EXIT row at the 60s
       * short-lock budget the re-run path explicitly does not inherit.
       */
      groupBudgetMs?: number;
      /**
       * A re-run of a Move to column row moves the task through this. Run again
       * passes it only for such a row, which it runs outside the task lock.
       */
      moveTask?: AutomationContext['moveTask'];
      /**
       * A re-run of a turn-end row: the session's latest final message, so its
       * Text match and its Condition judge the text a turn end would. Omitted
       * for an enter or exit row, which has none.
       */
      agentReply?: string | null;
    },
  ): Promise<AutomationRunSummary> {
    const empty: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
    if (!this.automationRepo || !this.automationRunRepo) return empty;

    return this.runAutomationGroup([automation], task, column, automation.trigger, {
      ...options,
      // A re-run has no move to name, so the two move keywords resolve empty
      // rather than to whatever the task's last move happened to be.
      fromColumn: null,
      toColumn: null,
    });
  }

  /**
   * The template variables a group's rows resolve against, built once per
   * group. Public so the turn-end group can resolve a Condition's own
   * variables before it checks, with exactly what its rows will see.
   */
  resolveGroupTemplateVars(
    task: Task,
    column: Swimlane,
    trigger: AutomationTrigger,
    options: { fromColumn?: Swimlane | null; toColumn?: Swimlane | null; agentReply?: string | null },
  ): Record<string, string> {
    const config = this.getConfig();
    // task_xml gets the RAW description so multi-line markdown survives;
    // {{description}} stays sanitized for legacy single-line prose templates.
    return resolveTaskTemplateVars({
      task,
      defaultBaseBranch: config.gitConfig.defaultBaseBranch,
      attachmentPaths: this.attachmentRepo?.getPathsForTask(task.id) ?? [],
      devPort: getDevPortForTask(task.id),
      projectPath: config.projectPath,
      projectName: config.projectName ?? null,
      // `column` is the column this automation BELONGS to, which is the same
      // column either end of the move names, but a row should be able to say so
      // without knowing which end it is on. `fromColumn` is legitimately empty
      // for a task born into a column rather than moved into one.
      move: {
        column: column.name,
        fromColumn: options.fromColumn?.name ?? null,
        toColumn: options.toColumn?.name ?? null,
        trigger,
      },
      agentReply: options.agentReply ?? null,
      workflow: readWorkflowPromptFacts(task, config.projectId),
    });
  }

  /**
   * Build the Condition check's input for these rows, each Condition's own
   * template variables resolved. Null when nothing can check them.
   */
  conditionCheckInput(
    task: Task,
    column: Swimlane,
    trigger: AutomationTrigger,
    rows: ColumnAutomation[],
    templateVars: Record<string, string>,
    options: { fromColumn?: Swimlane | null; toColumn?: Swimlane | null; agentReply?: string | null },
  ): ConditionPromptInput {
    return {
      task: {
        title: task.title,
        description: task.description,
        labels: task.labels,
        prUrl: task.pr_url,
        prState: task.pr_state,
        prMergeReadiness: task.pr_merge_readiness,
      },
      column: column.name,
      trigger,
      move: trigger === 'turn_end'
        ? null
        : { fromColumn: options.fromColumn?.name ?? null, toColumn: options.toColumn?.name ?? null },
      agentReply: options.agentReply ?? null,
      rows: rows.map((row) => ({
        automationId: row.id,
        name: row.name,
        condition: interpolateTaskTemplate(row.condition ?? '', templateVars),
      })),
    };
  }

  /** Who a column's Condition check is for, so its call is recorded against
   *  this project's ledger with the task and column it judged. */
  conditionCheckCall(task: Task, column: Swimlane): ConditionCheckCall {
    return { projectId: this.getConfig().projectId, taskId: task.id, swimlaneId: column.id, job: 'condition_check' };
  }

  /** Answer Conditions on the Automation agent, or say why that cannot happen. */
  async checkConditions(input: ConditionPromptInput, limits?: ConditionCheckLimits, call?: ConditionCheckCall): Promise<ConditionCheckOutcome> {
    if (!this.services.checkConditions) {
      return { ok: false, reason: 'Set up an Automation agent in Settings > Workflows to check this condition.', cause: 'unavailable' };
    }
    return this.services.checkConditions(input, limits, call);
  }

  /** The shared body: template variables, the adapter context, and the runner. */
  private async runAutomationGroup(
    automations: ColumnAutomation[],
    task: Task,
    column: Swimlane,
    trigger: AutomationTrigger,
    options: AutomationGroupOptions,
  ): Promise<AutomationRunSummary> {
    const empty: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
    if (!this.automationRunRepo) return empty;

    const config = this.getConfig();
    const templateVars = this.resolveGroupTemplateVars(task, column, trigger, options);

    return runAutomations({
      automations,
      column,
      runs: this.automationRunRepo,
      signal: options.signal,
      startAgent: options.startAgent,
      alreadyDelivered: options.alreadyDelivered,
      suppressAgentMessages: options.suppressAgentMessages,
      agentPaused: options.agentPaused,
      groupBudgetMs: options.groupBudgetMs,
      conditionAnswers: options.conditionAnswers,
      conditionUnavailableReason: options.conditionUnavailableReason,
      conditionUnavailableCallId: options.conditionUnavailableCallId,
      // A Text match reads it in code. Left undefined, not null, on enter and
      // exit: there is no final message there, rather than one that failed to read.
      agentReply: options.agentReply,
      // Enter and exit check their Conditions here, once for the group. The
      // turn-end group checked before it ran anything and passes its answers.
      // Each answer names the call that gave it, so the run rows link to it.
      checkConditions: options.conditionAnswers
        ? undefined
        : async (rows, limits) => {
          const outcome = await this.checkConditions(
            this.conditionCheckInput(task, column, trigger, rows, templateVars, options),
            limits,
            this.conditionCheckCall(task, column),
          );
          return outcome.ok
            ? { ok: true, answers: outcome.answers }
            : { ok: false, reason: outcome.reason, callId: outcome.callId ?? null };
        },
      context: {
        task,
        column,
        fromColumn: options.fromColumn ?? null,
        toColumn: options.toColumn ?? null,
        trigger,
        // A script always runs task-relative now: its worktree, or the project
        // checkout when it has none. The old `workingDir` setting existed to opt
        // INTO the worktree, which is what happens by default here.
        cwd: task.worktree_path || config.projectPath || process.cwd(),
        projectId: config.projectId,
        projectPath: config.projectPath,
        projectName: config.projectName ?? null,
        templateVars,
        sessionHost: this.sessionManager,
        deliverToAgent: options.deliverToAgent,
        showNotification: options.showNotification,
        legacySpawnAgent: options.legacySpawnAgent,
        moveTask: options.moveTask,
        onProgress: options.onProgress,
      },
    });
  }

  /**
   * The legacy `spawn_agent` automation's body, reached only through
   * `AutomationContext.legacySpawnAgent`. Public because the adapter cannot
   * carry it: spawning needs CLI detection, trust, permission resolution and
   * the PTY, none of which belongs behind the adapter contract.
   */
  async runLegacySpawnAgent(
    config: AutomationConfig,
    task: Task,
    permissionOverride?: PermissionMode | null,
    signal?: AbortSignal,
    agentOverride?: string,
    spawnOverrides?: SpawnOverrides,
  ): Promise<SpawnOutcome> {
    const engineConfig = this.getConfig();
    const templateVars = resolveTaskTemplateVars({
      task,
      defaultBaseBranch: engineConfig.gitConfig.defaultBaseBranch,
      attachmentPaths: this.attachmentRepo?.getPathsForTask(task.id) ?? [],
      devPort: getDevPortForTask(task.id),
      projectPath: engineConfig.projectPath,
      projectName: engineConfig.projectName ?? null,
      move: null,
      workflow: readWorkflowPromptFacts(task, engineConfig.projectId),
    });
    return this.executeSpawnAgent(config, task, templateVars, permissionOverride, undefined, signal, agentOverride, undefined, spawnOverrides);
  }

  private async executeSpawnAgent(config: ActionConfig, task: Task, vars: Record<string, string>, permissionOverride?: PermissionMode | null, resumePrompt?: string, signal?: AbortSignal, agentOverride?: string, handoffPromptPrefix?: string, spawnOverrides?: SpawnOverrides): Promise<SpawnOutcome> {
    const appConfig = this.getConfig();

    // Resolve which agent adapter to use.
    // agentOverride is always populated by the caller (from resolveTargetAgent).
    // config.agent is a legacy field kept for user-customized actions.
    // appConfig.defaultAgent is the project-level fallback.
    const agentName = agentOverride ?? config.agent ?? appConfig.defaultAgent ?? 'claude';
    const adapter = agentRegistry.getOrThrow(agentName);
    const cliPathOverride = appConfig.cliPathOverrides[agentName] ?? null;

    console.log(`[spawnAgent] Detecting ${agentName} CLI...`);
    const detection = await adapter.detect(cliPathOverride);
    if (!detection.found || !detection.path) {
      throw new AgentCliNotFoundError(agentName, adapter.displayName);
    }
    console.log(`[spawnAgent] ${agentName} CLI found at ${detection.path} (v${detection.version})`);
    // Where the CLI runs (a WSL distro, for a CLI installed in one), resolved
    // once for this spawn. A distro CLI runs in that distro's shell, whatever
    // the Terminal setting says.
    const cliTarget = await resolveCliTarget(detection.path, adapter.supportsWslCli === true);
    // A handoff points the receiving agent at the prior session's file; a CLI
    // in a WSL distro opens it by the path the distro sees.
    if (cliTarget && handoffPromptPrefix) {
      handoffPromptPrefix = mapHandoffSessionPath(handoffPromptPrefix, (hostPath) => cliPathForTarget(hostPath, cliTarget));
    }

    // permissionOverride carries the destination lane's mode; the "plan
    // always wins, else task -> lane -> global" rule lives in
    // resolveEffectivePermissionMode (spawn-preamble.ts).
    const permissionMode = resolveEffectivePermissionMode(
      task.permission_mode, permissionOverride, appConfig.permissionMode as PermissionMode,
    );
    const cwd = task.worktree_path || appConfig.projectPath || process.cwd();

    // Pre-populate trust so the agent doesn't block on the trust dialog.
    // This covers both worktree paths and the main project path (important
    // for demo mode where the project has never been opened in Claude Code).
    await adapter.ensureTrust(cwd, cliTarget);
    console.log(`[spawnAgent] Trust ensured for ${cwd}`);

    // Which session this spawn belongs to: null = the task's main session, the
    // swimlane id for an 'isolated'-strategy column.
    const isolatedSwimlaneId = spawnOverrides?.isolatedSwimlaneId ?? null;

    // Resolve whether to resume an existing session or spawn fresh.
    // The intent resolver queries by adapter.sessionType AND isolated_swimlane_id,
    // so cross-agent and main-vs-isolated resume mismatches are structurally
    // impossible (no guard needed). Resume is only attempted when agent_session_id
    // is non-null (real CLI session ID has been captured or pre-specified).
    const spawnIntentOptions = {
      taskId: task.id,
      sessionType: adapter.sessionType,
      isolatedSwimlaneId,
      sessionRepo: this.sessionRepo,
      promptTemplate: config.promptTemplate,
      templateVars: vars,
      resumePrompt,
      forceFresh: spawnOverrides?.forceFresh,
    };
    let intent = resolveSpawnIntent(spawnIntentOptions);

    // The id a resume would hand the CLI: the captured/specified ID from the DB
    // record, reconciled against the retiring record's own status.json (a
    // /clear-style fork in the final seconds before suspend can leave the DB
    // one id behind - see resume-id-reconcile.ts). Runs BEFORE the cwd
    // migration so the migration keys on the id actually being resumed, and
    // both run before the conversation check below, which needs that id and
    // the migrated file.
    const resumedAgentSessionId = intent.mode === 'resume'
      ? await reconcileResumeAgentSessionId({
          adapter,
          recordId: intent.retireRecordId,
          storedAgentSessionId: intent.agentSessionId,
          cwd: intent.resumeFromCwd,
          projectPath: appConfig.projectPath || cwd,
          sessionRepo: this.sessionRepo,
          // The conversation resumes where this spawn's CLI runs.
          place: cliTarget,
          // Stops the CLI's own background session holding the conversation, if any.
          cliPath: detection.path,
        })
      : null;

    // If the task's worktree was renamed since the session last ran, its history
    // lives under the OLD cwd's slug and `--resume` would look under the new cwd
    // and find nothing. Migrate it to the new cwd before the check and the
    // command. Best-effort; on failure the resume proceeds unchanged.
    if (intent.mode === 'resume') {
      await migrateResumeCwdIfRenamed({
        adapter,
        agentSessionId: resumedAgentSessionId,
        canResume: true,
        oldCwd: intent.resumeFromCwd,
        newCwd: cwd,
        projectPath: appConfig.projectPath,
        place: cliTarget,
      });
    }

    // A resume the CLI cannot serve would spawn `--resume <id>`, get "No
    // conversation found", and leave the user on a bare shell. Two cases are
    // decided here (resume-conversation-guard.ts); anything the check cannot
    // prove resumes as before.
    let startOver: SpawnOutcome['startOver'] = null;
    let recapOnly = false;
    let expiredNotice: ConversationExpiredNotice | null = null;
    if (intent.mode === 'resume' && resumedAgentSessionId) {
      const { lineage, lastActiveAt } = resolveResumeLineage({
        taskRecords: this.sessionRepo?.listForTaskNewestFirst(task.id) ?? [],
        retiringRecordId: intent.retireRecordId,
        resumedAgentSessionId,
      });
      const verdict = await assessResumeConversation({
        adapter,
        agentSessionId: resumedAgentSessionId,
        records: lineage,
        cwd,
        projectPath: appConfig.projectPath || cwd,
        place: cliTarget,
      });

      if (verdict === 'never-started') {
        console.log(
          `[spawnAgent] Resume downgraded to fresh for task ${task.id.slice(0, 8)}:`
          + ` agent session ${resumedAgentSessionId.slice(0, 8)} never wrote a conversation`
          + ` (session ended before its first turn)`,
        );
        startOver = 'never-started';
        // Re-RESOLVE, rather than just clearing a boolean. The two branches of
        // resolveSpawnIntent do not carry the same prompt: resume takes
        // `resumePrompt` (undefined for an ordinary task spawn) while fresh
        // interpolates `promptTemplate`. Flipping a flag would therefore boot a
        // brand-new `--session-id` with NO task prompt - and a promptless
        // session suspended before the user types is precisely the zero-turn
        // conversation this guard detects, so the downgrade would seed its own
        // next false positive. `forceFresh` takes the fresh branch whole: the
        // interpolated prompt, a null agentSessionId, and the same poisoned
        // record still retired.
        intent = resolveSpawnIntent({ ...spawnIntentOptions, forceFresh: true });
      } else if (verdict === 'expired') {
        startOver = 'expired';
        // The task's main session starts from the recap alone: a conversation
        // old enough for the agent to delete belongs to a stale task, so the
        // carried message (a column's message, a plan-exit continuation) and
        // the column's task template are not sent, and the agent summarizes
        // where the work stands and waits. An isolated column set to keep its
        // own conversation runs its normal fresh pass, with the recap as
        // context: its conversation being old says nothing about the task.
        const onMainSession = isolatedSwimlaneId === null;
        console.log(
          `[spawnAgent] Resume replaced by a fresh session for task ${task.id.slice(0, 8)}:`
          + ` agent session ${resumedAgentSessionId.slice(0, 8)} was deleted by ${adapter.displayName}`
          + ` (last active ${lastActiveAt ?? 'unknown'})`,
        );
        // `forceFresh` retires the old record (kept, marked exited) and
        // resolves a fresh intent; only the prompt differs between the cases.
        const freshIntent = resolveSpawnIntent({ ...spawnIntentOptions, forceFresh: true });
        // The recap shares the command line with the column's own prompt (an
        // isolated column) and a handoff pointer, so it fits in what they leave.
        const besideRecap = [onMainSession ? null : freshIntent.prompt, handoffPromptPrefix]
          .filter((text): text is string => Boolean(text));
        const recap = await buildExpiredConversationRecap({
          task,
          agentDisplayName: adapter.displayName,
          previousAgentSessionId: resumedAgentSessionId,
          lastActiveAt,
          cwd,
          baseBranch: vars.baseBranch || 'main',
          mode: onMainSession ? 'whole-prompt' : 'context',
          // Each joins the recap with a blank line.
          reservedChars: besideRecap.reduce((total, text) => total + commandLineLength(text) + 2, 0),
        }, this.services.recapSources);
        if (onMainSession) {
          recapOnly = true;
          intent = { ...freshIntent, prompt: recap };
        } else {
          // An empty recap left no room beside the column's prompt.
          intent = { ...freshIntent, prompt: [recap, freshIntent.prompt].filter(Boolean).join('\n\n') };
        }
        expiredNotice = {
          projectId: appConfig.projectId,
          taskId: task.id,
          taskTitle: task.title,
          lastActiveAt,
        };
      }
    }
    const canResume = intent.mode === 'resume';

    // agent_session_id: the agent CLI's real session ID for --resume/--session-id.
    // - Resume: the reconciled id above.
    // - Fresh + Claude (supportsCallerSessionId): generate UUID, pass via --session-id
    // - Fresh + Codex/Gemini: null (CLI generates its own ID, captured later via hooks)
    const agentSessionId = canResume
      ? resumedAgentSessionId
      : (adapter.supportsCallerSessionId ? randomUUID() : null);

    let prompt = intent.prompt;

    // Generate PTY session ID upfront (used for directory naming, DB primary key).
    // This is Kangentic's internal ID, separate from the agent CLI's session ID.
    const ptySessionId = randomUUID();

    console.log(
      // Reports the mode actually spawned, not the resolver's proposal: a
      // conversation that never started or was deleted becomes fresh above.
      `[spawnAgent] task=${task.id.slice(0, 8)} intent=${canResume ? 'resume' : 'fresh'} session=${isolatedSwimlaneId ?? 'main'}`
      + ` agent=${agentName} ptySessionId=${ptySessionId.slice(0, 8)}`
      + (agentSessionId ? ` agentSessionId=${agentSessionId.slice(0, 8)}` : '')
      + (intent.retireRecordId ? ` retiring=${intent.retireRecordId.slice(0, 8)}` : '')
      + (startOver ? ` startOver=${startOver}` : ''),
    );

    // Session history reference overlay (separate from the resume/fresh decision).
    // Prepends a pointer to the source agent's native session file.
    if (handoffPromptPrefix) {
      prompt = prompt
        ? handoffPromptPrefix + '\n\n' + prompt
        : handoffPromptPrefix;
    }

    // Ensure the per-session directory exists and compute output paths.
    // Directory is named by ptySessionId (internal), NOT agentSessionId (CLI-specific).
    const projectRoot = appConfig.projectPath || cwd;
    const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', ptySessionId);
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error(`[spawnAgent] Failed to create session directory: ${sessionDir}`, err);
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`, { cause: err });
    }
    const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);
    // A plan Kangentic approves into a bypass column can switch to bypass only
    // in a session launched with it available. The writer reads both facts.
    const bypassAvailable = planSpawnNeedsBypass({
      permissionMode,
      agentApprovesPlans: adapter.supportsPlanAutoApproval === true,
      projectId: appConfig.projectId,
      taskId: task.id,
    });

    const shell = shellForTarget(cliTarget) ?? await this.sessionManager.getShell();
    // A `.cmd` head under a PowerShell or Git Bash host hands the multi-line
    // prompt to cmd.exe, which keeps only its first line (#353). Swap in the
    // sibling shim the host can run, else flatten the prompt. Sits after
    // ensureTrust and before buildCommand (spawn-entry-point-parity). The
    // session row below persists the ORIGINAL prompt: flattening is a
    // delivery detail, not what the user wrote.
    let launch = await resolveShimLaunch({ agentPath: detection.path, shell, prompt });
    // A resume's prompt rides its command line only where it arrives whole
    // (resume-prompt-delivery.ts). Otherwise it is kept off the command line
    // and handed back in `unsentPrompt`, and the caller types it in.
    const resumePromptKeptOff = canResume && prompt !== undefined && prompt.trim() !== ''
      && !resumePromptRidesCommandLine({ delivery: adapter.resumePromptDelivery, prompt, launchStrategy: launch.strategy, shell });
    if (resumePromptKeptOff) launch = { ...launch, prompt: undefined };
    const executionTarget = resolveExecutionTarget(agentName, appConfig.executionServers, appConfig.execution) ?? undefined;
    const launchOptions = resolveLaunchOptions(adapter, appConfig.launchOptions);
    const commandOptions = {
      agentPath: launch.agentPath,
      taskId: task.id,
      prompt: launch.prompt,
      cwd,
      permissionMode,
      projectRoot: appConfig.projectPath || undefined,
      sessionId: agentSessionId ?? undefined,
      resume: canResume,
      nonInteractive: config.nonInteractive ?? false,
      statusOutputPath,
      eventsOutputPath,
      shell,
      mcpServerEnabled: appConfig.mcpServerEnabled,
      // Carries this session's own id so the MCP server can identify the caller
      // (see appendCallerSession). Stamped, never looked up, so it cannot drift.
      mcpServerUrl: appendCallerSession(appConfig.mcpServerUrl, ptySessionId),
      mcpServerToken: appConfig.mcpServerToken,
      model: spawnOverrides?.model ?? undefined,
      effort: spawnOverrides?.effort ?? undefined,
      executionTarget,
      launchOptions,
      taskProcessTag: task.id,
      // The session's own id, which a folder-shared adapter file is held under.
      ptySessionId,
      bypassAvailable,
      cliTarget,
    };
    const command = adapter.buildCommand(commandOptions);
    notePlanApprovalSpawn(ptySessionId, { sessionDir, bypassAvailable });

    let extraEnv: Record<string, string> | null;
    try {
      extraEnv = adapter.buildEnv?.(commandOptions) ?? null;

      console.log(`[spawnAgent] agent=${agentName} Command: ${command.slice(0, 120)}...`);

      // Last chance to abort before creating a PTY process
      signal?.throwIfAborted();
    } catch (error) {
      // The built command never reached spawn() (an abort or a buildEnv
      // failure), so release the hold it took. From the spawn() call on,
      // spawn() releases a spawn that never runs and a session owns its own.
      releaseCommandHold(adapter, cwd, ptySessionId);
      throw error;
    }

    // Where an isolated column's pass begins, so the main conversation, resumed
    // after it, can be told the commits it made. Read before the spawn: the
    // agent may commit within its first seconds. Never fails the spawn.
    let startHeadSha: string | null = null;
    if (isolatedSwimlaneId !== null && this.services.readStartHead) {
      try {
        startHeadSha = await this.services.readStartHead(cwd);
      } catch {
        startHeadSha = null;
      }
    }

    console.log(`[spawnAgent] Spawning PTY session for ${agentName}...`);
    const session = await this.sessionManager.spawn({
      id: ptySessionId,
      taskId: task.id,
      projectId: appConfig.projectId,
      command,
      cwd,
      env: extraEnv ?? undefined,
      statusOutputPath,
      eventsOutputPath,
      resuming: canResume,
      ...(canResume && spawnOverrides?.resumedBy ? { resumedBy: spawnOverrides.resumedBy } : {}),
      agentParser: adapter,
      agentName: adapter.name,
      agentSessionId,
      isolatedSwimlaneId,
      permissionMode,
      exitSequence: adapter.getExitSequence?.() ?? ['\x03'],
      // The grid recorded on the record this spawn retires. Only used when no
      // in-memory predecessor speaks for it (a resume after a desktop restart).
      ...(intent.restoredGrid ? { restoredGrid: intent.restoredGrid } : {}),
      // The shell the command was built for, and where its CLI runs.
      shell,
      cliTarget: toStoredCliTarget(cliTarget),
    });

    console.log(`[spawnAgent] PTY session created: id=${session.id.slice(0, 8)} status=${session.status}`);

    this.taskRepo.update({
      id: task.id,
      session_id: session.id,
      agent: agentName,
    });

    // Persist session record for resume capability
    if (this.sessionRepo) {
      // Retire the old same-type record if resuming (suspended/orphaned -> exited).
      // Type-scoped: only retires the matching agent's record, preserving
      // other agents' suspended sessions for future resume.
      if (intent.retireRecordId) {
        retireRecord(this.sessionRepo, intent.retireRecordId);
      }

      this.sessionRepo.insert({
        id: ptySessionId,
        task_id: task.id,
        session_type: adapter.sessionType,
        isolated_swimlane_id: isolatedSwimlaneId,
        agent_session_id: agentSessionId ?? null,
        command,
        cwd,
        permission_mode: permissionMode,
        prompt: prompt ?? null,
        status: session.status as 'running' | 'queued',
        exit_code: null,
        started_at: new Date().toISOString(),
        suspended_at: null,
        exited_at: null,
        suspended_by: null,
        cli_target: serializeCliTarget(cliTarget),
        start_head_sha: startHeadSha,
      });

      // Record the model/effort this spawn/resume actually applied via the CLI
      // flags (the same `spawnOverrides` that fed `commandOptions`). This is the
      // ground truth a later column transition diffs against, so a move into a
      // same-valued column never restarts the session. null = agent default
      // (no flag).
      this.sessionRepo.updateAppliedSettings(ptySessionId, {
        model: spawnOverrides?.model ?? null,
        effort: spawnOverrides?.effort ?? null,
      });
    }

    // Told only once the new session exists: a spawn that failed or was
    // cancelled above started nothing to announce. A recap-only session's
    // first turn is a summary for the user, so it runs no turn-end rows.
    if (recapOnly) markRecapSession(session.id);
    if (expiredNotice) this.services.onConversationExpired?.(expiredNotice);
    // A resume whose prompt was kept off its command line opens idle, and the
    // caller types the prompt in once the agent is ready. Claude's resume
    // reloads its context with no hook, which the status heartbeat would read as
    // thinking for 30 s, holding that delivery back; the restart path asserts
    // idle for the same reason. Any real turn hook clears it.
    if (resumePromptKeptOff) this.sessionManager.markIdleAuthoritative(session.id);
    // A fresh spawn takes the template over `resumePrompt` (resolveSpawnIntent),
    // so a resume that started over, or a forced-fresh spawn, left the carried
    // message out. A recap-only start withholds it on purpose instead.
    const templateTookSlot = !canResume && !recapOnly
      && Boolean(resumePrompt?.trim()) && Boolean(spawnIntentOptions.promptTemplate);
    const unsentPrompt = resumePromptKeptOff
      ? prompt ?? null
      : (templateTookSlot ? resumePrompt ?? null : null);
    return { startOver, recapOnly, unsentPrompt };
  }

}
