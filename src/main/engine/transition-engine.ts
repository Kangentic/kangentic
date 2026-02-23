import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, Skill, SkillConfig, SwimlaneTransition, AppConfig } from '../../shared/types';
import { SessionManager } from '../pty/session-manager';
import { CommandBuilder } from '../agent/command-builder';
import { ClaudeDetector } from '../agent/claude-detector';
import { WorktreeManager } from '../git/worktree-manager';
import { ensureWorktreeTrust } from '../agent/trust-manager';
import type { SkillRepository } from '../db/repositories/skill-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { SessionRepository } from '../db/repositories/session-repository';

export class TransitionEngine {
  constructor(
    private sessionManager: SessionManager,
    private skillRepo: SkillRepository,
    private taskRepo: TaskRepository,
    private claudeDetector: ClaudeDetector,
    private commandBuilder: CommandBuilder,
    private getConfig: () => { permissionMode: string; claudePath: string | null; projectPath: string | null; gitConfig: AppConfig['git'] },
    private sessionRepo?: SessionRepository,
  ) {}

  async executeTransition(task: Task, fromSwimlaneId: string, toSwimlaneId: string): Promise<void> {
    const transitions = this.skillRepo.getTransitionsFor(fromSwimlaneId, toSwimlaneId);
    if (transitions.length === 0) return;

    for (const transition of transitions) {
      const skill = this.skillRepo.getById(transition.skill_id);
      if (!skill) continue;

      await this.executeSkill(skill, task);
    }
  }

  private async executeSkill(skill: Skill, task: Task): Promise<void> {
    let config: SkillConfig;
    try {
      config = JSON.parse(skill.config_json);
    } catch (err) {
      console.error(`Failed to parse config for skill ${skill.id}:`, err);
      return; // skip skill with malformed config
    }
    const templateVars: Record<string, string> = {
      title: task.title,
      description: task.description,
      taskId: task.id,
      worktreePath: task.worktree_path || '',
      branchName: task.branch_name || '',
    };

    switch (skill.type) {
      case 'spawn_agent':
        await this.executeSpawnAgent(config, task, templateVars);
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

  private async executeSpawnAgent(config: SkillConfig, task: Task, vars: Record<string, string>): Promise<void> {
    const appConfig = this.getConfig();
    const claude = await this.claudeDetector.detect(appConfig.claudePath);
    if (!claude.found || !claude.path) {
      throw new Error('Claude CLI not found on PATH');
    }

    const permissionMode = config.permissionMode || appConfig.permissionMode;
    const cwd = task.worktree_path || appConfig.projectPath || process.cwd();

    // Pre-populate trust so the agent doesn't block on the trust dialog
    if (cwd !== appConfig.projectPath) {
      ensureWorktreeTrust(cwd);
    }

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
      // Resume the previous Claude conversation — no extra prompt
      claudeSessionId = previousSession.claude_session_id!;
      console.log(`[spawn_agent] RESUMING with claude_session_id=${claudeSessionId.slice(0, 8)}`);
    } else {
      // Fresh session: generate a Claude session ID upfront so we can
      // resume with --session-id on recovery. Claude CLI accepts
      // --session-id <id> "prompt" to create a new session with a given ID.
      claudeSessionId = randomUUID();
      prompt = config.promptTemplate
        ? this.commandBuilder.interpolateTemplate(config.promptTemplate, vars)
        : `Task: ${task.title}\n\n${task.description}`;
    }

    // Ensure the status output directory exists and compute the output path
    const projectRoot = appConfig.projectPath || cwd;
    const statusDir = path.join(projectRoot, '.kangentic', 'status');
    fs.mkdirSync(statusDir, { recursive: true });
    const statusOutputPath = path.join(statusDir, `${claudeSessionId}.json`);

    const command = this.commandBuilder.buildClaudeCommand({
      claudePath: claude.path,
      taskId: task.id,
      prompt,
      cwd,
      permissionMode: permissionMode as any,
      projectRoot: appConfig.projectPath || undefined,
      sessionId: claudeSessionId,
      resume: !!canResume,
      nonInteractive: config.nonInteractive ?? false,
      statusOutputPath,
    });

    const session = await this.sessionManager.spawn({
      taskId: task.id,
      command,
      cwd,
      statusOutputPath,
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
        status: 'running',
        exit_code: null,
        started_at: new Date().toISOString(),
        suspended_at: null,
        exited_at: null,
      });
    }
  }

  private executeSendCommand(config: SkillConfig, task: Task, vars: Record<string, string>): void {
    if (!task.session_id) return;
    const command = config.command
      ? this.commandBuilder.interpolateTemplate(config.command, vars)
      : '';
    if (command) {
      this.sessionManager.write(task.session_id, command + '\r');
    }
  }

  private async executeRunScript(config: SkillConfig, task: Task, vars: Record<string, string>): Promise<void> {
    const script = config.script
      ? this.commandBuilder.interpolateTemplate(config.script, vars)
      : '';
    if (!script) return;

    const appConfig = this.getConfig();
    const cwd = config.workingDir === 'worktree' && task.worktree_path
      ? task.worktree_path
      : appConfig.projectPath || process.cwd();

    await this.sessionManager.spawn({
      taskId: task.id + '-script',
      command: script,
      cwd,
    });
  }

  private executeKillSession(task: Task): void {
    if (task.session_id) {
      // Mark session as 'suspended' in DB before killing the PTY.
      // This allows a subsequent spawn_agent skill (e.g. Planning → Running)
      // to resume the conversation via --resume, preserving Claude's context.
      if (this.sessionRepo) {
        const record = this.sessionRepo.getLatestForTask(task.id);
        if (record && record.status === 'running') {
          this.sessionRepo.updateStatus(record.id, 'suspended', {
            suspended_at: new Date().toISOString(),
          });
        }
      }

      this.sessionManager.kill(task.session_id);
      this.taskRepo.update({
        id: task.id,
        session_id: null,
      });
    }
  }

  private async executeWebhook(config: SkillConfig, vars: Record<string, string>): Promise<void> {
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
      console.error('Webhook failed:', err);
    }
  }

  private async executeCreateWorktree(config: SkillConfig, task: Task): Promise<void> {
    if (task.worktree_path) return; // already has one

    const appConfig = this.getConfig();
    if (!appConfig.projectPath || !appConfig.gitConfig.worktreesEnabled) return;

    const wm = new WorktreeManager(appConfig.projectPath);
    const baseBranch = config.baseBranch || appConfig.gitConfig.defaultBaseBranch;
    const copyFiles = config.copyFiles || appConfig.gitConfig.copyFiles;

    const { worktreePath, branchName } = await wm.createWorktree(
      task.id,
      task.title,
      baseBranch,
      copyFiles,
    );

    this.taskRepo.update({
      id: task.id,
      worktree_path: worktreePath,
      branch_name: branchName,
    });
  }

  private async executeCleanupWorktree(task: Task): Promise<void> {
    if (!task.worktree_path || !task.branch_name) return;

    const appConfig = this.getConfig();
    if (!appConfig.projectPath) return;

    const wm = new WorktreeManager(appConfig.projectPath);
    await wm.removeWorktree(task.worktree_path);
    if (appConfig.gitConfig.autoCleanup) {
      await wm.removeBranch(task.branch_name);
    }

    this.taskRepo.update({
      id: task.id,
      worktree_path: null,
      branch_name: null,
    });
  }
}
