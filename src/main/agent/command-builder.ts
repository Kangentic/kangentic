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
}

export class CommandBuilder {
  buildClaudeCommand(options: CommandOptions): string {
    const parts = [quoteArg(options.claudePath)];

    // Permission mode flags
    const settingsArg = options.projectRoot && options.cwd !== options.projectRoot
      ? toForwardSlash(path.join(options.projectRoot, '.claude', 'settings.json'))
      : null;

    switch (options.permissionMode) {
      case 'dangerously-skip':
        parts.push('--dangerously-skip-permissions');
        break;
      case 'plan-mode':
        parts.push('--permission-mode', 'plan');
        if (settingsArg) {
          parts.push('--settings', quoteArg(settingsArg));
        }
        break;
      case 'project-settings':
        // When running from a worktree, Claude resolves settings from CWD,
        // not the git root. Explicitly pass --settings for the main project.
        if (settingsArg) {
          parts.push('--settings', quoteArg(settingsArg));
        }
        break;
      case 'manual':
        // No flags - full interactive mode
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
}
