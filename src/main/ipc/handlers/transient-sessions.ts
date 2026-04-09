import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { resolveProjectRoot } from '../../../shared/git-utils';
import { fetchIfStale } from '../../git/worktree-manager';
import { trackEvent } from '../../analytics/analytics';
import { agentRegistry } from '../../agent/agent-registry';
import { DEFAULT_AGENT } from '../../../shared/types';
import type { SpawnTransientSessionInput, PermissionMode } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Transient sessions are ephemeral Claude Code terminals spawned from the
 * command bar (Ctrl+Shift+P). They run at the project root with no task
 * association, no DB persistence, and no resume capability.
 */
export function registerTransientSessionHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.SESSION_SPAWN_TRANSIENT, async (_, input: SpawnTransientSessionInput) => {
    if (!context.currentProjectId) throw new Error('Cannot spawn transient session: no project is currently open');

    const project = context.projectRepo.getById(input.projectId);
    if (!project) throw new Error('Cannot spawn transient session: project not found');

    const projectRoot = resolveProjectRoot(project.path);
    const config = context.configManager.getEffectiveConfig(projectRoot);

    const agentName = project.default_agent || DEFAULT_AGENT;
    const adapter = agentRegistry.getOrThrow(agentName);
    const cliPathOverride = config.agent.cliPaths[agentName] ?? null;

    const detection = await adapter.detect(cliPathOverride);
    if (!detection.found || !detection.path) throw new Error(`${adapter.displayName} CLI not found. Please install it first.`);
    const permissionMode = config.agent.permissionMode as PermissionMode;
    const transientTaskId = uuidv4();

    // Fetch latest from origin and checkout the requested branch before spawning.
    // This ensures Claude Code loads up-to-date commands/skills from the remote.
    const git = simpleGit(projectRoot);
    const targetBranch = input.branch || config.git.defaultBaseBranch || 'main';

    // Best-effort fetch from origin (throttled, network-failure-safe)
    const startPoint = await fetchIfStale(git, projectRoot, targetBranch);

    let branch = targetBranch;
    let checkoutError: string | undefined;
    try {
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== targetBranch) {
        await git.checkout(targetBranch);
      }
      branch = targetBranch;

      // Fast-forward merge to incorporate fetched remote changes
      if (startPoint.startsWith('origin/')) {
        try {
          await git.merge([startPoint, '--ff-only']);
        } catch {
          // ff-only failed (dirty tree, diverged history) - use local state
        }
      }
    } catch (error) {
      // Checkout may fail (dirty working tree, branch doesn't exist locally)
      // Fall back to whatever branch is currently checked out
      try {
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      } catch {
        branch = 'unknown';
      }
      const reason = error instanceof Error ? error.message : String(error);
      checkoutError = `Could not switch to "${targetBranch}" - staying on "${branch}". ${reason}`;
    }

    // Create session directory for status/events bridge files so the
    // shimmer overlay can detect when Claude Code is ready.
    const sessionDirectory = path.join(projectRoot, '.kangentic', 'sessions', transientTaskId);
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const statusOutputPath = path.join(sessionDirectory, 'status.json');
    const eventsOutputPath = path.join(sessionDirectory, 'activity.json');

    const command = adapter.buildCommand({
      agentPath: detection.path,
      taskId: transientTaskId,
      cwd: projectRoot,
      permissionMode,
      projectRoot,
      statusOutputPath,
      eventsOutputPath,
      mcpServerEnabled: config.mcpServer.enabled,
      mcpServerUrl: context.mcpServerHandle?.urlForProject(input.projectId),
      mcpServerToken: context.mcpServerHandle?.token,
    });

    const session = await context.sessionManager.spawn({
      taskId: transientTaskId,
      projectId: input.projectId,
      command,
      cwd: projectRoot,
      statusOutputPath,
      eventsOutputPath,
      transient: true,
      agentParser: adapter,
      agentName: adapter.name,
      exitSequence: adapter.getExitSequence?.() ?? ['\x03'],
    });

    trackEvent('transient_session_spawn');
    return { session, branch, checkoutError };
  });

  ipcMain.handle(IPC.SESSION_KILL_TRANSIENT, (_, sessionId: string) => {
    // Capture session info before removal for cleanup
    const session = context.sessionManager.getSession(sessionId);
    context.sessionManager.remove(sessionId);

    // Clean up the transient session directory on disk
    if (session?.transient) {
      const sessionDirectory = path.join(session.cwd, '.kangentic', 'sessions', session.taskId);
      try {
        fs.rmSync(sessionDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  });
}
