import path from 'node:path';
import type { PermissionMode, Task, SkillConfig } from '../../shared/types';

interface CommandOptions {
  claudePath: string;
  taskId: string;
  prompt: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string; // main repo root (for worktree settings resolution)
  sessionId?: string;
  nonInteractive?: boolean;
}

export class CommandBuilder {
  buildClaudeCommand(options: CommandOptions): string {
    const parts = [this.quoteArg(options.claudePath)];

    // Permission mode flags
    switch (options.permissionMode) {
      case 'dangerously-skip':
        parts.push('--dangerously-skip-permissions');
        break;
      case 'plan-mode':
        parts.push('--permission-mode', 'plan');
        if (options.projectRoot && options.cwd !== options.projectRoot) {
          parts.push('--settings', this.quoteArg(this.settingsPath(options.projectRoot)));
        }
        break;
      case 'project-settings':
        // When running from a worktree, Claude resolves settings from CWD,
        // not the git root. Explicitly pass --settings for the main project.
        if (options.projectRoot && options.cwd !== options.projectRoot) {
          parts.push('--settings', this.quoteArg(this.settingsPath(options.projectRoot)));
        }
        break;
      case 'manual':
        // No flags - full interactive mode
        break;
    }

    // Session resumption
    if (options.sessionId) {
      parts.push('--session-id', this.quoteArg(options.sessionId));
    }

    // Non-interactive mode (print and exit) vs interactive
    if (options.nonInteractive) {
      parts.push('--print');
    }

    // The prompt as positional argument
    parts.push(this.quoteArg(options.prompt));

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
   * Build the path to the project's .claude/settings.json.
   * Always uses forward slashes so the path works in Git Bash, WSL,
   * PowerShell, and cmd without shell-specific conversion.
   */
  private settingsPath(projectRoot: string): string {
    return path.join(projectRoot, '.claude', 'settings.json').replace(/\\/g, '/');
  }

  /**
   * Quote a CLI argument if it contains characters that need escaping.
   * Path arguments should use forward slashes (via `settingsPath()`) so
   * they work correctly across all shells without conversion.
   */
  private quoteArg(arg: string): string {
    // Skip quoting for simple args with no spaces or special chars.
    // Backslashes are NOT considered simple — they're escape characters
    // in Unix-like shells (Git Bash, WSL).
    if (/^[a-zA-Z0-9_.\/:-]+$/.test(arg)) {
      return arg;
    }
    if (process.platform === 'win32') {
      // Windows: use double quotes and escape internal double quotes
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    // Unix: use single quotes and escape internal single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
