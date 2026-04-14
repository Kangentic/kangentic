import path from 'node:path';
import { CopilotDetector } from './detector';
import { CopilotCommandBuilder } from './command-builder';
import { removeSessionConfig } from './hook-manager';
import { CopilotStatusParser } from './status-parser';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * GitHub Copilot CLI adapter - wraps CopilotDetector, CopilotCommandBuilder,
 * and copilot-hook-manager behind the generic AgentAdapter interface.
 *
 * Copilot CLI (v1.0+) supports:
 * - statusLine config (same pattern as Claude Code)
 * - Inline hooks in config.json (preToolUse, postToolUse, agentStop, preCompact)
 * - Explicit session ID resume via --resume <uuid>
 * - Native --plan mode
 * - --yolo for full permission bypass
 */
export class CopilotAdapter implements AgentAdapter {
  readonly name = 'copilot';
  readonly displayName = 'GitHub Copilot CLI';
  readonly sessionType = 'copilot_agent';

  /**
   * Copilot supports caller-specified session IDs via --resume <uuid>.
   * Passing a new UUID starts a fresh session with that ID; passing an
   * existing UUID resumes it. Same semantics as Claude's --session-id.
   */
  readonly supportsCallerSessionId = true;

  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'dontAsk', label: 'Plan Non-Interactive (CI)' },
    { mode: 'default', label: 'Default (Confirm Actions)' },
    { mode: 'acceptEdits', label: 'Allow All Tools' },
    { mode: 'auto', label: 'Autopilot (Allow All Tools)' },
    { mode: 'bypassPermissions', label: 'YOLO (Full Access)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new CopilotDetector();
  private readonly commandBuilder = new CopilotCommandBuilder();

  /**
   * Track per-session config directories keyed by project root (cwd).
   * The session-manager calls removeHooks(session.cwd, session.taskId),
   * so we must key by project root to match. The value maps taskId to
   * the per-session copilot-config directory path for cleanup.
   */
  private readonly sessionConfigDirs = new Map<string, Map<string, string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Copilot CLI handles directory trust via --add-dir at runtime.
    // No pre-approval step needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const command = this.commandBuilder.buildCopilotCommand({
      copilotPath: agentPath,
      ...rest,
    });
    // Track session config dir keyed by project root for cleanup.
    // The session-manager will call removeHooks(session.cwd, taskId).
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      const configDir = path.resolve(path.dirname(options.eventsOutputPath), 'copilot-config');
      this.trackSessionConfig(projectRoot, options.taskId, configDir);
    }
    return command;
  }

  private trackSessionConfig(projectRoot: string, taskId: string, configDir: string): void {
    let taskMap = this.sessionConfigDirs.get(projectRoot);
    if (!taskMap) {
      taskMap = new Map<string, string>();
      this.sessionConfigDirs.set(projectRoot, taskMap);
    }
    taskMap.set(taskId, configDir);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Copilot exposes activity state and session data.
   *
   * - Activity: hooks primary (Copilot's preToolUse/postToolUse/agentStop),
   *   PTY silence timer as fallback.
   * - StatusFile: Copilot supports the same statusLine config as Claude Code.
   *   parseStatus is initially null (format unverified); parseEvent handles
   *   generic event-bridge JSONL.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    statusFile: {
      parseStatus: CopilotStatusParser.parseStatus,
      parseEvent: CopilotStatusParser.parseEvent,
      isFullRewrite: true,
    },
    activity: ActivityDetection.hooksAndPty(),
  };

  removeHooks(directory: string, taskId?: string): void {
    // `directory` is the project root (session.cwd), matching the key
    // used in trackSessionConfig during buildCommand.
    const taskMap = this.sessionConfigDirs.get(directory);
    if (!taskMap) return;

    if (taskId) {
      const configDir = taskMap.get(taskId);
      if (configDir) {
        removeSessionConfig(configDir);
      }
      taskMap.delete(taskId);
      if (taskMap.size === 0) {
        this.sessionConfigDirs.delete(directory);
      }
    } else {
      // No taskId - clean up all sessions for this directory
      for (const configDir of taskMap.values()) {
        removeSessionConfig(configDir);
      }
      this.sessionConfigDirs.delete(directory);
    }
  }

  clearSettingsCache(): void {
    // Copilot uses per-session config dirs, no shared settings cache.
  }

  getExitSequence(): string[] {
    // Ctrl+C to interrupt, then /exit to quit the Copilot CLI TUI.
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Copilot CLI hides the cursor when its TUI takes over the terminal.
    // Same heuristic as Codex and Gemini adapters.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(
    _agentSessionId: string,
    _cwd: string,
  ): Promise<string | null> {
    // Copilot session history file location is not yet empirically verified.
    // Activity events flow through the hooks pipeline (event-bridge JSONL).
    return null;
  }
}
