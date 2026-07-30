import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, Action, ActionConfig, AppConfig, PermissionMode } from '../../shared/types';
import { sanitizeForPty } from '../../shared/paths';
import { SessionManager } from '../pty/session-manager';
import type { TerminalSubmit } from '../pty/terminal-submit';
import { interpolateTemplate, resolveTaskTemplateVars } from '../agent/shared';
import { resolveExecutionTarget } from '../agent/shared/execution-target';
import { resolveLaunchOptions } from '../agent/shared/launch-options';
import { WorktreeManager, prepareWorktreeForRemoval, GitQueuePriority } from '../git/worktree-manager';
import { prepareWorktreeFolder } from '../git/task-worktree-folder';
import { agentRegistry } from '../agent/agent-registry';
import { appendCallerSession } from '../agent/mcp-http/caller-url';
import { retireRecord, markRecordSuspended } from './session-lifecycle';
import { resolveEffectivePermissionMode } from './spawn-preamble';
import { resolveSpawnIntent } from './spawn-intent';
import { migrateResumeCwdIfRenamed } from './resume-cwd-migration';
import { sessionOutputPaths } from './session-paths';
import type { ActionRepository } from '../db/repositories/action-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { AttachmentRepository } from '../db/repositories/attachment-repository';

interface TransitionEngineConfig {
  permissionMode: string;
  projectPath: string | null;
  projectId: string;
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
    private actionRepo: ActionRepository,
    private taskRepo: TaskRepository,
    private getConfig: () => TransitionEngineConfig,
    private sessionRepo?: SessionRepository,
    private attachmentRepo?: AttachmentRepository,
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
    });
    await this.executeSpawnAgent({
      promptTemplate: skipPromptTemplate ? undefined : '{{task_xml}}{{attachments}}',
    }, task, templateVars, permissionOverride, resumePrompt, signal, agentOverride, handoffPromptPrefix, spawnOverrides);
  }

  async executeTransition(task: Task, fromSwimlaneId: string, toSwimlaneId: string, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, signal?: AbortSignal, agentOverride?: string, spawnOverrides?: SpawnOverrides, onProgress?: (phase: string) => void): Promise<void> {
    const transitions = this.actionRepo.getTransitionsFor(fromSwimlaneId, toSwimlaneId);
    if (transitions.length === 0) return;

    for (const transition of transitions) {
      signal?.throwIfAborted();
      const action = this.actionRepo.getById(transition.action_id);
      if (!action) continue;

      await this.executeAction(action, task, permissionOverride, skipPromptTemplate, signal, agentOverride, spawnOverrides, onProgress);
    }
  }

  private async executeAction(action: Action, task: Task, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, signal?: AbortSignal, agentOverride?: string, spawnOverrides?: SpawnOverrides, onProgress?: (phase: string) => void): Promise<void> {
    let config: ActionConfig;
    try {
      config = JSON.parse(action.config_json);
    } catch (err) {
      console.error(`[TRANSITION] Failed to parse config for action ${action.id}:`, err);
      return; // skip action with malformed config
    }
    const attachmentPaths = this.attachmentRepo?.getPathsForTask(task.id) ?? [];
    // task_xml gets the RAW description so multi-line markdown survives;
    // {{description}} stays sanitized for legacy single-line prose templates.
    const templateVars = resolveTaskTemplateVars({
      task,
      defaultBaseBranch: this.getConfig().gitConfig.defaultBaseBranch,
      attachmentPaths,
    });

    switch (action.type) {
      case 'spawn_agent':
        if (skipPromptTemplate) {
          config.promptTemplate = undefined;
        }
        await this.executeSpawnAgent(config, task, templateVars, permissionOverride, undefined, signal, agentOverride, undefined, spawnOverrides);
        break;

      case 'send_command':
        // Fire-and-forget: executeSendCommand internally spawns a fire-and-
        // forget keystroke burst, so awaiting here would just hold the action
        // chain on the synchronous prefix (interpolate + sanitize). `void`
        // signals intent to TypeScript and any future no-floating-promises
        // lint rule.
        void this.executeSendCommand(config, task, templateVars);
        break;

      case 'run_script':
        await this.executeRunScript(config, task, templateVars);
        break;

      case 'kill_session':
        await this.executeKillSession(task);
        break;

      case 'webhook':
        await this.executeWebhook(config, templateVars);
        break;

      case 'create_worktree':
        await this.executeCreateWorktree(config, task, signal, onProgress);
        break;

      case 'cleanup_worktree':
        await this.executeCleanupWorktree(task);
        break;
    }
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
      throw new Error(`${adapter.displayName} CLI not found on PATH`);
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
    const intent = resolveSpawnIntent({
      taskId: task.id,
      sessionType: adapter.sessionType,
      isolatedSwimlaneId,
      sessionRepo: this.sessionRepo,
      promptTemplate: config.promptTemplate,
      templateVars: vars,
      resumePrompt,
      forceFresh: spawnOverrides?.forceFresh,
    });

    const canResume = intent.mode === 'resume';

    // agent_session_id: the agent CLI's real session ID for --resume/--session-id.
    // - Resume: use the captured/specified ID from the DB record
    // - Fresh + Claude (supportsCallerSessionId): generate UUID, pass via --session-id
    // - Fresh + Codex/Gemini: null (CLI generates its own ID, captured later via hooks)
    const agentSessionId = canResume
      ? intent.agentSessionId
      : (adapter.supportsCallerSessionId ? randomUUID() : null);

    let prompt = intent.prompt;

    // Generate PTY session ID upfront (used for directory naming, DB primary key).
    // This is Kangentic's internal ID, separate from the agent CLI's session ID.
    const ptySessionId = randomUUID();

    console.log(
      `[spawnAgent] task=${task.id.slice(0, 8)} intent=${intent.mode} session=${isolatedSwimlaneId ?? 'main'}`
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
    const executionTarget = resolveExecutionTarget(agentName, appConfig.executionServers, appConfig.execution) ?? undefined;
    const launchOptions = resolveLaunchOptions(adapter, appConfig.launchOptions);
    const commandOptions = {
      agentPath: detection.path,
      taskId: task.id,
      prompt,
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

  private async executeSendCommand(config: ActionConfig, task: Task, vars: Record<string, string>): Promise<void> {
    if (!task.session_id) return;
    const raw = config.command
      ? interpolateTemplate(config.command, vars)
      : '';
    const command = sanitizeForPty(raw);
    if (!command) return;
    // Route through TerminalSubmit so the keystroke pattern (Ctrl+C → text →
    // Esc → Enter) matches auto_command and settings injection. Sending raw
    // `text + '\r'` directly leaves the slash-command picker open - the
    // same regression class that bit auto_command. Fire-and-forget here:
    // executeSendCommand is called from `executeAction` which has no
    // back-pressure on the action chain; awaiting would serialize all
    // transition actions on the keystroke settle.
    void this.terminalSubmit.submitKeystrokes(task.session_id, [command], {
      sendCtrlC: true,
      source: `send_command:${task.id.slice(0, 8)}`,
    }).catch((error) => {
      console.error('[TRANSITION] executeSendCommand failed:', error);
    });
  }

  private async executeRunScript(config: ActionConfig, task: Task, vars: Record<string, string>): Promise<void> {
    const script = config.script
      ? interpolateTemplate(config.script, vars)
      : '';
    if (!script) return;

    const appConfig = this.getConfig();
    const cwd = config.workingDir === 'worktree' && task.worktree_path
      ? task.worktree_path
      : appConfig.projectPath || process.cwd();

    await this.sessionManager.spawn({
      id: randomUUID(),
      taskId: task.id + '-script',
      projectId: appConfig.projectId,
      command: script,
      cwd,
    });
  }

  private async executeKillSession(task: Task): Promise<void> {
    if (task.session_id) {
      // Mark session as 'suspended' in DB before killing the PTY.
      // This allows a subsequent spawn_agent action (e.g. Planning → Running)
      // to resume the conversation via --resume, preserving Claude's context.
      if (this.sessionRepo) {
        const record = this.sessionRepo.getLatestForTask(task.id);
        if (record) {
          markRecordSuspended(this.sessionRepo, record.id, 'system');
        }
      }

      await this.sessionManager.suspend(task.session_id);
      this.taskRepo.update({
        id: task.id,
        session_id: null,
      });
    }
  }

  private async executeWebhook(config: ActionConfig, vars: Record<string, string>): Promise<void> {
    if (!config.url) return;
    const url = interpolateTemplate(config.url, vars);
    const body = config.body
      ? interpolateTemplate(config.body, vars)
      : undefined;

    try {
      await fetch(url, {
        method: config.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body,
      });
    } catch (err) {
      console.error('[TRANSITION] Webhook failed:', err);
    }
  }

  private async executeCreateWorktree(config: ActionConfig, task: Task, signal?: AbortSignal, onProgress?: (phase: string) => void): Promise<void> {
    const appConfig = this.getConfig();
    if (!appConfig.projectPath) return;

    // Recover the pre-numeric-scheme folder for a legacy task whose worktree_path
    // was already cleared by a Done move, so it returns to its original path
    // rather than being relocated. See TaskRepository.recoverLegacyWorktreeFolder.
    prepareWorktreeFolder(task, this.taskRepo, appConfig.projectPath);

    const wm = new WorktreeManager(appConfig.projectPath);
    const gitConfig = {
      ...appConfig.gitConfig,
      defaultBaseBranch: config.baseBranch || appConfig.gitConfig.defaultBaseBranch,
      copyFiles: config.copyFiles || appConfig.gitConfig.copyFiles,
    };

    // Forward the abort signal and progress callback so this action path matches
    // the normal task-move spawn path: an abort cancels an in-flight worktree
    // create / init script, and the card shows the "Creating worktree..." /
    // "Running setup script..." phases. The signal originates in executeAction;
    // onProgress is supplied by the spawn caller that holds the renderer window.
    const result = await wm.withLock(
      () => wm.ensureWorktree(task, gitConfig, { signal, onProgress }),
      { label: `transition-ensure:${task.id.slice(0, 8)}` },
    );
    if (!result) return;

    this.taskRepo.recordWorktree(task.id, result.worktreePath, result.branchName, result.worktreeFolder);
  }

  private async executeCleanupWorktree(task: Task): Promise<void> {
    if (!task.worktree_path || !task.branch_name) return;

    const appConfig = this.getConfig();
    if (!appConfig.projectPath) return;

    // Kill the PTY session and wait for process exit before removing the
    // worktree directory. The PTY holds CWD + conpty handles that block
    // directory removal on Windows.
    if (task.session_id) {
      this.sessionManager.kill(task.session_id);
      await this.sessionManager.awaitExit(task.session_id);
    }

    const wm = new WorktreeManager(appConfig.projectPath);
    let removed = false;
    // Reap orphans + clear node_modules BEFORE taking the git lock, mirroring
    // task-cleanup.ts: the multi-second fs removal must not hold the
    // per-project queue and head-of-line-block spawns. Safe outside the lock:
    // executeTransition callers hold withTaskLock(taskId), and removeWorktree
    // re-runs prepareWorktreeForRemoval internally as a cheap no-op.
    await prepareWorktreeForRemoval(task.worktree_path, 'moderate');
    await wm.withLock(async () => {
      removed = await wm.removeWorktree(task.worktree_path!, { removalProfile: 'moderate' });
      if (removed && appConfig.gitConfig.autoCleanup) {
        await wm.removeBranch(task.branch_name!);
      }
      // BACKGROUND: same rationale as task-cleanup.ts - batch cleanup must not
      // park a fresh spawn at USER priority.
    }, { label: `transition-cleanup:${task.id.slice(0, 8)}`, priority: GitQueuePriority.BACKGROUND });

    // Only clear DB fields if the directory was actually removed.
    // Keeping them set allows resource-cleanup to retry on next startup.
    if (removed) {
      this.taskRepo.update({
        id: task.id,
        worktree_path: null,
        branch_name: null,
      });
    }
  }
}
