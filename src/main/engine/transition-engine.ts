import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, Action, ActionConfig, AppConfig, PermissionMode } from '../../shared/types';
import { sanitizeForPty } from '../../shared/paths';
import { SessionManager } from '../pty/session-manager';
import { CommandBuilder } from '../agent/command-builder';
import { ClaudeDetector } from '../agent/claude-detector';
import { WorktreeManager } from '../git/worktree-manager';
import { ensureWorktreeTrust, ensureMcpServerTrust } from '../agent/trust-manager';
import { sessionOutputPaths } from './session-paths';
import type { ActionRepository } from '../db/repositories/action-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { SessionRepository } from '../db/repositories/session-repository';
import type { AttachmentRepository } from '../db/repositories/attachment-repository';

export class TransitionEngine {
  constructor(
    private sessionManager: SessionManager,
    private actionRepo: ActionRepository,
    private taskRepo: TaskRepository,
    private claudeDetector: ClaudeDetector,
    private commandBuilder: CommandBuilder,
    private getConfig: () => { permissionMode: string; claudePath: string | null; projectPath: string | null; projectId: string; gitConfig: AppConfig['git']; mcpServerEnabled?: boolean },
    private sessionRepo?: SessionRepository,
    private attachmentRepo?: AttachmentRepository,
  ) {}

  /**
   * Resume a suspended session for a task. Used when moving out of
   * Backlog/Done into a non-agent column (no spawn_agent transition fires).
   */
  async resumeSuspendedSession(task: Task, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, resumePrompt?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const attachmentPaths = this.attachmentRepo?.getPathsForTask(task.id) ?? [];
    const cleanTitle = sanitizeForPty(task.title);
    const cleanDesc = sanitizeForPty(task.description);
    // {{description}} includes its own ": " separator when non-empty,
    // producing "Title: Description" or just "Title" when blank.
    await this.executeSpawnAgent({
      promptTemplate: skipPromptTemplate ? undefined : '{{title}}{{description}}{{attachments}}',
    }, task, {
      title: cleanTitle,
      description: cleanDesc ? `: ${cleanDesc}` : '',
      taskId: task.id,
      worktreePath: task.worktree_path || '',
      branchName: task.branch_name || '',
      attachments: attachmentPaths.length > 0
        ? `\n${attachmentPaths.join('\n')}`
        : '',
    }, permissionOverride, resumePrompt, signal);
  }

  async executeTransition(task: Task, fromSwimlaneId: string, toSwimlaneId: string, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, signal?: AbortSignal): Promise<void> {
    const transitions = this.actionRepo.getTransitionsFor(fromSwimlaneId, toSwimlaneId);
    if (transitions.length === 0) return;

    for (const transition of transitions) {
      signal?.throwIfAborted();
      const action = this.actionRepo.getById(transition.action_id);
      if (!action) continue;

      await this.executeAction(action, task, permissionOverride, skipPromptTemplate, signal);
    }
  }

  private async executeAction(action: Action, task: Task, permissionOverride?: PermissionMode | null, skipPromptTemplate?: boolean, signal?: AbortSignal): Promise<void> {
    let config: ActionConfig;
    try {
      config = JSON.parse(action.config_json);
    } catch (err) {
      console.error(`[TRANSITION] Failed to parse config for action ${action.id}:`, err);
      return; // skip action with malformed config
    }
    const attachmentPaths = this.attachmentRepo?.getPathsForTask(task.id) ?? [];
    const cleanTitle = sanitizeForPty(task.title);
    const cleanDesc = sanitizeForPty(task.description);
    const templateVars: Record<string, string> = {
      title: cleanTitle,
      description: cleanDesc ? `: ${cleanDesc}` : '',
      taskId: task.id,
      worktreePath: task.worktree_path || '',
      branchName: task.branch_name || '',
      prUrl: task.pr_url || '',
      prNumber: task.pr_number ? String(task.pr_number) : '',
      attachments: attachmentPaths.length > 0
        ? `\n${attachmentPaths.join('\n')}`
        : '',
    };

    switch (action.type) {
      case 'spawn_agent':
        if (skipPromptTemplate) {
          config.promptTemplate = undefined;
        }
        await this.executeSpawnAgent(config, task, templateVars, permissionOverride, undefined, signal);
        break;

      case 'send_command':
        this.executeSendCommand(config, task, templateVars);
        break;

      case 'run_script':
        await this.executeRunScript(config, task, templateVars);
        break;

      case 'kill_session':
        this.executeKillSession(task);
        break;

      case 'webhook':
        await this.executeWebhook(config, templateVars);
        break;

      case 'create_worktree':
        await this.executeCreateWorktree(config, task);
        break;

      case 'cleanup_worktree':
        await this.executeCleanupWorktree(task);
        break;
    }
  }

  private async executeSpawnAgent(config: ActionConfig, task: Task, vars: Record<string, string>, permissionOverride?: PermissionMode | null, resumePrompt?: string, signal?: AbortSignal): Promise<void> {
    const appConfig = this.getConfig();
    const claude = await this.claudeDetector.detect(appConfig.claudePath);
    if (!claude.found || !claude.path) {
      throw new Error('Claude CLI not found on PATH');
    }

    // Resolution order: swimlane override → global setting
    const permissionMode = permissionOverride ?? appConfig.permissionMode;
    const cwd = task.worktree_path || appConfig.projectPath || process.cwd();

    // Pre-populate trust so the agent doesn't block on the trust dialog.
    // This covers both worktree paths and the main project path (important
    // for demo mode where the project has never been opened in Claude Code).
    await ensureWorktreeTrust(cwd);
    await ensureMcpServerTrust(cwd);

    // Check for a previous session to resume (only explicitly suspended sessions)
    const previousSession = this.sessionRepo?.getLatestForTask(task.id);
    const canResume = previousSession
      && previousSession.claude_session_id
      && previousSession.session_type === 'claude_agent'
      && previousSession.status === 'suspended';

    console.log(
      `[spawn_agent] task=${task.id.slice(0, 8)} previousSession=${previousSession ? `{id=${previousSession.id.slice(0, 8)}, status=${previousSession.status}, claude_id=${previousSession.claude_session_id?.slice(0, 8)}}` : 'none'} canResume=${!!canResume}`,
    );

    let prompt: string | undefined;
    let claudeSessionId: string;

    if (canResume) {
      // Resume the previous Claude conversation, optionally with a preloaded command
      claudeSessionId = previousSession.claude_session_id!;
      prompt = resumePrompt;
      console.log(`[spawn_agent] RESUMING with claude_session_id=${claudeSessionId.slice(0, 8)}${resumePrompt ? ` prompt="${resumePrompt.slice(0, 40)}"` : ''}`);
    } else {
      // Fresh session: generate a Claude session ID upfront so we can
      // resume with --session-id on recovery. Claude CLI accepts
      // --session-id <id> "prompt" to create a new session with a given ID.
      claudeSessionId = randomUUID();
      prompt = config.promptTemplate
        ? this.commandBuilder.interpolateTemplate(config.promptTemplate, vars)
        : undefined;
    }

    // Ensure the per-session directory exists and compute output paths
    const projectRoot = appConfig.projectPath || cwd;
    const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', claudeSessionId);
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error(`[spawn_agent] Failed to create session directory: ${sessionDir}`, err);
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
    }
    const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);

    const shell = await this.sessionManager.getShell();
    const command = this.commandBuilder.buildClaudeCommand({
      claudePath: claude.path,
      taskId: task.id,
      prompt,
      cwd,
      permissionMode: permissionMode as PermissionMode,
      projectRoot: appConfig.projectPath || undefined,
      sessionId: claudeSessionId,
      resume: !!canResume,
      nonInteractive: config.nonInteractive ?? false,
      statusOutputPath,
      eventsOutputPath,
      shell,
      mcpServerEnabled: appConfig.mcpServerEnabled,
    });

    // Last chance to abort before creating a PTY process
    signal?.throwIfAborted();

    const session = await this.sessionManager.spawn({
      id: randomUUID(),
      taskId: task.id,
      projectId: appConfig.projectId,
      command,
      cwd,
      statusOutputPath,
      eventsOutputPath,
      resuming: !!canResume,
    });

    this.taskRepo.update({
      id: task.id,
      session_id: session.id,
      agent: config.agent || 'claude',
    });

    // Persist session record for resume capability
    if (this.sessionRepo) {
      // Mark the old record as exited if we're resuming
      if (canResume && previousSession) {
        this.sessionRepo.updateStatus(previousSession.id, 'exited', {
          exited_at: new Date().toISOString(),
        });
      }

      this.sessionRepo.insert({
        task_id: task.id,
        session_type: 'claude_agent',
        claude_session_id: claudeSessionId,
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
    }
  }

  private executeSendCommand(config: ActionConfig, task: Task, vars: Record<string, string>): void {
    if (!task.session_id) return;
    const raw = config.command
      ? this.commandBuilder.interpolateTemplate(config.command, vars)
      : '';
    const command = sanitizeForPty(raw);
    if (command) {
      this.sessionManager.write(task.session_id, command + '\r');
    }
  }

  private async executeRunScript(config: ActionConfig, task: Task, vars: Record<string, string>): Promise<void> {
    const script = config.script
      ? this.commandBuilder.interpolateTemplate(config.script, vars)
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

  private executeKillSession(task: Task): void {
    if (task.session_id) {
      // Mark session as 'suspended' in DB before killing the PTY.
      // This allows a subsequent spawn_agent action (e.g. Planning → Running)
      // to resume the conversation via --resume, preserving Claude's context.
      if (this.sessionRepo) {
        const record = this.sessionRepo.getLatestForTask(task.id);
        if (record && record.status === 'running') {
          this.sessionRepo.updateStatus(record.id, 'suspended', {
            suspended_at: new Date().toISOString(),
          });
        }
      }

      this.sessionManager.suspend(task.session_id);
      this.taskRepo.update({
        id: task.id,
        session_id: null,
      });
    }
  }

  private async executeWebhook(config: ActionConfig, vars: Record<string, string>): Promise<void> {
    if (!config.url) return;
    const url = this.commandBuilder.interpolateTemplate(config.url, vars);
    const body = config.body
      ? this.commandBuilder.interpolateTemplate(config.body, vars)
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

  private async executeCreateWorktree(config: ActionConfig, task: Task): Promise<void> {
    const appConfig = this.getConfig();
    if (!appConfig.projectPath) return;

    const wm = new WorktreeManager(appConfig.projectPath);
    const gitConfig = {
      ...appConfig.gitConfig,
      defaultBaseBranch: config.baseBranch || appConfig.gitConfig.defaultBaseBranch,
      copyFiles: config.copyFiles || appConfig.gitConfig.copyFiles,
    };

    const result = await wm.withLock(() => wm.ensureWorktree(task, gitConfig));
    if (!result) return;

    this.taskRepo.update({
      id: task.id,
      worktree_path: result.worktreePath,
      branch_name: result.branchName,
    });
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
    await wm.withLock(async () => {
      removed = await wm.removeWorktree(task.worktree_path!);
      if (removed && appConfig.gitConfig.autoCleanup) {
        await wm.removeBranch(task.branch_name!);
      }
    });

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
