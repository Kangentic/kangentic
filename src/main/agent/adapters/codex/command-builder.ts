import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { writeCodexHooks } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

export interface CodexCommandOptions {
  codexPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  nonInteractive?: boolean;
  statusOutputPath?: string;
  eventsOutputPath?: string;
  shell?: string;
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  mcpServerToken?: string;
}

/**
 * Map Kangentic's PermissionMode to Codex CLI sandbox + approval flags.
 * Each combination matches a documented Codex preset exactly:
 *   plan        → Safe read-only browsing
 *   dontAsk     → Read-only non-interactive (CI)
 *   default     → Automatically edit, ask for untrusted commands
 *   acceptEdits → Auto (preset)
 *   auto        → Auto (preset)
 *   bypass      → Dangerous full access (--yolo)
 */
function mapPermissionMode(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
    case 'dontAsk':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    case 'default':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'untrusted'];
    case 'acceptEdits':
    case 'auto':
      return ['--full-auto'];
    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

export class CodexCommandBuilder {
  buildCodexCommand(options: CodexCommandOptions): string {
    const { shell } = options;

    // Inject event-bridge hooks before building the command (analogous to
    // Claude's createMergedSettings side effect in buildClaudeCommand)
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      writeCodexHooks(projectRoot, options.eventsOutputPath);
    }

    const parts: string[] = [];

    // Resume is a subcommand: codex resume <sessionId> -C <cwd>
    if (options.resume && options.sessionId) {
      parts.push(quoteArg(options.codexPath, shell));
      parts.push('resume', quoteArg(options.sessionId, shell));
      parts.push('-C', quoteArg(toForwardSlash(options.cwd), shell));
      return parts.join(' ');
    }

    parts.push(quoteArg(options.codexPath, shell));

    // Non-interactive: codex -q --json ...
    if (options.nonInteractive) {
      parts.push('-q', '--json');
    }

    // Working directory
    parts.push('-C', quoteArg(toForwardSlash(options.cwd), shell));

    // Approval mode
    parts.push(...mapPermissionMode(options.permissionMode));

    // Prompt as positional argument
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
