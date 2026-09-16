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
  NotificationInput,
} from '../../shared/types';
import { runAutomations, type AutomationRunSummary } from '../automations/automation-runner';
import type { AutomationRepository } from '../db/repositories/automation-repository';
import type { AutomationRunRepository } from '../db/repositories/automation-run-repository';
import { DEFAULT_SPAWN_PROMPT_TEMPLATE } from '../../shared/task-template-vars';
import { SessionManager } from '../pty/session-manager';
import type { TerminalSubmit } from '../pty/terminal-submit';
import { resolveTaskTemplateVars } from '../agent/shared';
import { resolveExecutionTarget } from '../agent/shared/execution-target';
import { resolveLaunchOptions } from '../agent/shared/launch-options';
import { resolveShimLaunch } from '../agent/shared/shim-launch';
import { agentRegistry } from '../agent/agent-registry';
import { AgentCliNotFoundError } from '../agent/shared/agent-cli-not-found';
import { appendCallerSession } from '../agent/mcp-http/caller-url';
import { getDevPortForTask } from '../dev-ports/dev-port-allocator';
import { retireRecord } from './session-lifecycle';
import { resolveEffectivePermissionMode } from './spawn-preamble';
import { resolveSpawnIntent } from './spawn-intent';
import { migrateResumeCwdIfRenamed } from './resume-cwd-migration';
import { reconcileResumeAgentSessionId } from './resume-id-reconcile';
import { isResumeConversationAbsent } from './resume-conversation-guard';
import { sessionOutputPaths } from './session-paths';
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
  ) {}

  /**
   * Resume a suspended session for a task. Used when moving out of
   * Backlog/Done into a non-agent column (no spawn_agent transition fires).
   */
  async resumeSuspendedSession(task: Task, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, resumePrompt?: string, signal?: AbortSignal, agentOverride?: string, handoffPromptPrefix?: string, spawnOverrides?: SpawnOverrides): Promise<void> {
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
    });
    await this.executeSpawnAgent({
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
    options: {
      signal: AbortSignal;
      startAgent?: (pendingPrompt?: string) => Promise<void>;
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
    },
  ): Promise<AutomationRunSummary> {
    const empty: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
    if (!this.automationRepo || !this.automationRunRepo) return empty;

    const automations = this.automationRepo.getForTrigger(column.id, trigger);
    if (automations.length === 0) return empty;

    return this.runAutomationGroup(automations, task, column, trigger, options);
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

  /** The shared body: template variables, the adapter context, and the runner. */
  private async runAutomationGroup(
    automations: ColumnAutomation[],
    task: Task,
    column: Swimlane,
    trigger: AutomationTrigger,
    options: {
      signal: AbortSignal;
      startAgent?: (pendingPrompt?: string) => Promise<void>;
      deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal) => Promise<void>;
      legacySpawnAgent?: (config: AutomationConfig) => Promise<void>;
      showNotification: (input: NotificationInput) => void;
      onProgress?: (phase: string) => void;
      fromColumn?: Swimlane | null;
      toColumn?: Swimlane | null;
      alreadyDelivered?: ReadonlySet<string>;
      suppressAgentMessages?: boolean;
      groupBudgetMs?: number;
    },
  ): Promise<AutomationRunSummary> {
    const empty: AutomationRunSummary = { outcomes: [], failures: [], startedAgent: false };
    if (!this.automationRunRepo) return empty;

    const config = this.getConfig();
    const attachmentPaths = this.attachmentRepo?.getPathsForTask(task.id) ?? [];
    // task_xml gets the RAW description so multi-line markdown survives;
    // {{description}} stays sanitized for legacy single-line prose templates.
    const templateVars = resolveTaskTemplateVars({
      task,
      defaultBaseBranch: config.gitConfig.defaultBaseBranch,
      attachmentPaths,
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
    });

    return runAutomations({
      automations,
      column,
      runs: this.automationRunRepo,
      signal: options.signal,
      startAgent: options.startAgent,
      alreadyDelivered: options.alreadyDelivered,
      suppressAgentMessages: options.suppressAgentMessages,
      groupBudgetMs: options.groupBudgetMs,
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
  ): Promise<void> {
    const engineConfig = this.getConfig();
    const templateVars = resolveTaskTemplateVars({
      task,
      defaultBaseBranch: engineConfig.gitConfig.defaultBaseBranch,
      attachmentPaths: this.attachmentRepo?.getPathsForTask(task.id) ?? [],
      devPort: getDevPortForTask(task.id),
      projectPath: engineConfig.projectPath,
      projectName: engineConfig.projectName ?? null,
      move: null,
    });
    await this.executeSpawnAgent(config, task, templateVars, permissionOverride, undefined, signal, agentOverride, undefined, spawnOverrides);
  }

  private async executeSpawnAgent(config: ActionConfig, task: Task, vars: Record<string, string>, permissionOverride?: PermissionMode | null, resumePrompt?: string, signal?: AbortSignal, agentOverride?: string, handoffPromptPrefix?: string, spawnOverrides?: SpawnOverrides): Promise<void> {
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
    await adapter.ensureTrust(cwd);
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

    // A resume whose conversation the agent never persisted (a session that
    // ended before its first turn - see resume-conversation-guard.ts) would
    // spawn `--resume <id>`, get "No conversation found", and leave the user on
    // a bare shell. Downgrade it to a fresh spawn instead. The probe only fires
    // on positive evidence of an empty conversation and returns false on every
    // uncertainty, so a real conversation is never discarded.
    if (intent.mode === 'resume') {
      // Every record that ran this conversation, newest first: a record whose CLI
      // died on a failed resume wrote no status file, so the proof of emptiness
      // can only be on an older one (see the guard's `recordIds` doc). Built
      // BEFORE the re-resolve below, which clears both fields it reads.
      const conversationRecordIds = [
        intent.retireRecordId,
        ...(this.sessionRepo?.listForTaskNewestFirst(task.id) ?? [])
          .filter((record) => record.agent_session_id === intent.agentSessionId)
          .map((record) => record.id),
      ];
      if (await isResumeConversationAbsent({
        adapter,
        recordIds: conversationRecordIds,
        projectPath: appConfig.projectPath || cwd,
      })) {
        console.log(
          `[spawnAgent] Resume downgraded to fresh for task ${task.id.slice(0, 8)}:`
          + ` agent session ${intent.agentSessionId?.slice(0, 8)} never wrote a conversation`
          + ` (session ended before its first turn)`,
        );
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
      }
    }
    const canResume = intent.mode === 'resume';

    // agent_session_id: the agent CLI's real session ID for --resume/--session-id.
    // - Resume: use the captured/specified ID from the DB record, reconciled
    //   against the retiring record's own status.json (a /clear-style fork in
    //   the final seconds before suspend can leave the DB one id behind - see
    //   resume-id-reconcile.ts). Runs BEFORE migrateResumeCwdIfRenamed below so
    //   the cwd migration keys on the id actually being resumed.
    // - Fresh + Claude (supportsCallerSessionId): generate UUID, pass via --session-id
    // - Fresh + Codex/Gemini: null (CLI generates its own ID, captured later via hooks)
    const agentSessionId = canResume
      ? await reconcileResumeAgentSessionId({
          adapter,
          recordId: intent.retireRecordId,
          storedAgentSessionId: intent.agentSessionId,
          cwd: intent.resumeFromCwd,
          projectPath: appConfig.projectPath || cwd,
          sessionRepo: this.sessionRepo,
        })
      : (adapter.supportsCallerSessionId ? randomUUID() : null);

    let prompt = intent.prompt;

    // Generate PTY session ID upfront (used for directory naming, DB primary key).
    // This is Kangentic's internal ID, separate from the agent CLI's session ID.
    const ptySessionId = randomUUID();

    console.log(
      // Reports the mode actually spawned, not the resolver's proposal: a
      // never-persisted conversation is downgraded to fresh above.
      `[spawnAgent] task=${task.id.slice(0, 8)} intent=${canResume ? 'resume' : 'fresh'} session=${isolatedSwimlaneId ?? 'main'}`
      + ` agent=${agentName} ptySessionId=${ptySessionId.slice(0, 8)}`
      + (agentSessionId ? ` agentSessionId=${agentSessionId.slice(0, 8)}` : '')
      + (intent.retireRecordId ? ` retiring=${intent.retireRecordId.slice(0, 8)}` : ''),
    );

    // If the task's worktree was renamed since the session last ran, its history
    // lives under the OLD cwd's slug and `--resume` would look under the new cwd
    // and find nothing. Migrate it to the new cwd before building the command.
    // Best-effort; on failure the resume proceeds unchanged.
    await migrateResumeCwdIfRenamed({
      adapter,
      agentSessionId,
      canResume,
      oldCwd: intent.resumeFromCwd,
      newCwd: cwd,
      projectPath: appConfig.projectPath,
    });

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
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
    }
    const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);

    const shell = await this.sessionManager.getShell();
    // A `.cmd` head under a PowerShell or Git Bash host hands the multi-line
    // prompt to cmd.exe, which keeps only its first line (#353). Swap in the
    // sibling shim the host can run, else flatten the prompt. Sits after
    // ensureTrust and before buildCommand (spawn-entry-point-parity). The
    // session row below persists the ORIGINAL prompt: flattening is a
    // delivery detail, not what the user wrote.
    const launch = await resolveShimLaunch({ agentPath: detection.path, shell, prompt });
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
    };
    const command = adapter.buildCommand(commandOptions);
    const extraEnv = adapter.buildEnv?.(commandOptions) ?? null;

    console.log(`[spawnAgent] agent=${agentName} Command: ${command.slice(0, 120)}...`);

    // Last chance to abort before creating a PTY process
    signal?.throwIfAborted();

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
      agentParser: adapter,
      agentName: adapter.name,
      agentSessionId,
      isolatedSwimlaneId,
      exitSequence: adapter.getExitSequence?.() ?? ['\x03'],
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
      });

      // Record the model/effort this spawn/resume actually applied via the CLI
      // flags (the same `spawnOverrides` that fed `commandOptions`). This is the
      // ground truth a later column transition diffs against, so a move into a
      // same-valued column never re-injects `/model` / `/effort`. null = agent
      // default (no flag).
      this.sessionRepo.updateAppliedSettings(ptySessionId, {
        model: spawnOverrides?.model ?? null,
        effort: spawnOverrides?.effort ?? null,
      });
    }
  }

}
