import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg } from '../../shared/paths';
import type { PermissionMode, Task, SkillConfig } from '../../shared/types';

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

    const merged = {
      ...existingSettings,
      statusLine: {
        type: 'command',
        command: `node "${bridgePath}" "${statusPath}"`,
      },
    };

    // Write to .kangentic/claude-settings-<sessionId>.json
    const kangenticDir = path.join(projectRoot, '.kangentic');
    fs.mkdirSync(kangenticDir, { recursive: true });
    const mergedPath = path.join(kangenticDir, `claude-settings-${options.sessionId || options.taskId}.json`);
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

    return mergedPath;
  }
}
