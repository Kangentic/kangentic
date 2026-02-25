import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg } from '../../shared/paths';
import type { PermissionMode, Task } from '../../shared/types';

interface CommandOptions {
  claudePath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string; // main repo root (for worktree settings resolution)
  sessionId?: string;
  resume?: boolean; // true = --resume (existing session), false = --session-id (new session)
  nonInteractive?: boolean;
  statusOutputPath?: string; // path where the status bridge writes JSON
  activityOutputPath?: string; // path where the activity bridge writes JSON
}

export class CommandBuilder {
  buildClaudeCommand(options: CommandOptions): string {
    const parts = [quoteArg(options.claudePath)];

    // Build the --settings path. When statusOutputPath is provided we always
    // create a merged settings file that includes the statusLine config so
    // Claude Code pipes usage data to our bridge script.
    const mergedSettingsPath = options.statusOutputPath
      ? this.createMergedSettings(options)
      : null;

    // Permission mode flags
    switch (options.permissionMode) {
      case 'dangerously-skip':
        parts.push('--dangerously-skip-permissions');
        // Still pass merged settings for the status line even with skip-permissions
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        }
        break;
      case 'plan-mode':
        parts.push('--permission-mode', 'plan');
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        } else {
          const settingsArg = this.getProjectSettingsArg(options);
          if (settingsArg) parts.push('--settings', quoteArg(settingsArg));
        }
        break;
      case 'project-settings':
        // When running from a worktree, Claude resolves settings from CWD,
        // not the git root. Explicitly pass --settings for the main project.
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        } else {
          const settingsArg = this.getProjectSettingsArg(options);
          if (settingsArg) parts.push('--settings', quoteArg(settingsArg));
        }
        break;
      case 'manual':
        // No permission flags, but still pass merged settings for status line
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        }
        break;
    }

    // Session: --resume for existing conversations, --session-id for new ones
    if (options.sessionId) {
      const flag = options.resume ? '--resume' : '--session-id';
      parts.push(flag, quoteArg(options.sessionId));
    }

    // Non-interactive mode (print and exit) vs interactive
    if (options.nonInteractive) {
      parts.push('--print');
    }

    // The prompt as positional argument (omitted for resumed sessions)
    if (options.prompt) {
      parts.push(quoteArg(options.prompt));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return result;
  }

  /**
   * Get the project settings path for worktree scenarios (no status bridge).
   */
  private getProjectSettingsArg(options: CommandOptions): string | null {
    if (options.projectRoot && options.cwd !== options.projectRoot) {
      return toForwardSlash(path.join(options.projectRoot, '.claude', 'settings.json'));
    }
    return null;
  }

  /**
   * Create a merged Claude settings file that includes the statusLine config
   * pointing to our bridge script. Reads the project's existing settings.json
   * (if any) and deep-merges the statusLine key.
   *
   * Returns the absolute path to the merged settings file.
   */
  private createMergedSettings(options: CommandOptions): string {
    const projectRoot = options.projectRoot || options.cwd;

    // Read existing project settings
    let existingSettings: Record<string, any> = {};
    const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      existingSettings = JSON.parse(raw);
    } catch {
      // No existing settings — start fresh
    }

    // Build the bridge command. In production, status-bridge.js is copied
    // next to the main bundle by scripts/build.js. In dev (Forge Vite plugin),
    // __dirname is .vite/build/ so we fall back to the source tree.
    const candidates = [
      path.join(__dirname, 'status-bridge.js'),                                   // production build
      path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', 'status-bridge.js'), // Forge dev (.vite/build/ → project root)
      path.resolve(process.cwd(), 'src', 'main', 'agent', 'status-bridge.js'),   // fallback from CWD
    ];
    const bridgeScript = candidates.find(p => fs.existsSync(p)) || candidates[0];
    const bridgePath = toForwardSlash(bridgeScript);
    const statusPath = toForwardSlash(options.statusOutputPath!);

    // Resolve activity bridge (same candidate pattern as status bridge)
    const activityCandidates = [
      path.join(__dirname, 'activity-bridge.js'),
      path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', 'activity-bridge.js'),
      path.resolve(process.cwd(), 'src', 'main', 'agent', 'activity-bridge.js'),
    ];
    const activityBridge = toForwardSlash(activityCandidates.find(p => fs.existsSync(p)) || activityCandidates[0]);
    const activityPath = options.activityOutputPath ? toForwardSlash(options.activityOutputPath) : null;

    const merged: Record<string, any> = {
      ...existingSettings,
      statusLine: {
        type: 'command',
        command: `node "${bridgePath}" "${statusPath}"`,
      },
    };

    // Deep-merge hooks for activity tracking (preserve existing user hooks)
    if (activityPath) {
      const existingHooks = existingSettings.hooks || {};
      merged.hooks = {
        ...existingHooks,
        UserPromptSubmit: [
          ...(existingHooks.UserPromptSubmit || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" thinking` }] },
        ],
        Stop: [
          ...(existingHooks.Stop || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
        ],
      };
    }

    // Write to .kangentic/sessions/<sessionId>/settings.json
    const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', options.sessionId || options.taskId);
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create session directory: ${sessionDir}`, err);
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
    }
    const mergedPath = path.join(sessionDir, 'settings.json');
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

    // Also write hooks to <cwd>/.claude/settings.local.json so Claude Code
    // picks them up from its standard settings hierarchy. The --settings flag
    // may not load hooks in all Claude Code versions.
    if (activityPath) {
      this.injectActivityHooks(options.cwd, activityBridge, activityPath);
    }

    return mergedPath;
  }

  /**
   * Write activity hooks into <cwd>/.claude/settings.local.json.
   * Claude Code reads this file from its standard settings hierarchy,
   * ensuring hooks fire regardless of --settings support.
   *
   * Preserves existing user settings and hooks.
   */
  private injectActivityHooks(cwd: string, activityBridge: string, activityPath: string): void {
    const localSettingsDir = path.join(cwd, '.claude');
    fs.mkdirSync(localSettingsDir, { recursive: true });
    const localSettingsPath = path.join(localSettingsDir, 'settings.local.json');

    let localSettings: Record<string, any> = {};
    try {
      const raw = fs.readFileSync(localSettingsPath, 'utf-8');
      localSettings = JSON.parse(raw);
    } catch {
      // Doesn't exist or malformed — start fresh
    }

    const existingHooks = localSettings.hooks || {};

    // Filter out any stale activity-bridge entries from previous sessions
    const filterStale = (entries: any[] | undefined): any[] =>
      (entries || []).filter((e: any) =>
        !e?.hooks?.some?.((h: any) => typeof h.command === 'string' && h.command.includes('activity-bridge')),
      );

    localSettings.hooks = {
      ...existingHooks,
      UserPromptSubmit: [
        ...filterStale(existingHooks.UserPromptSubmit),
        { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" thinking` }] },
      ],
      Stop: [
        ...filterStale(existingHooks.Stop),
        { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
      ],
    };

    fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));
  }
}
