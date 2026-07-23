import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { buildHooks } from './hook-manager';
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
  model?: string;
  effort?: string;
  /** Fully-defaulted launch-option values (`AgentLaunchOptionInfo.id` -> enabled). */
  launchOptions?: Record<string, boolean>;
}

/**
 * Map Kangentic's PermissionMode to Codex CLI sandbox + approval flags.
 *
 * Codex no longer ships `--full-auto`; everything is now expressed via the
 * pair `--sandbox <mode>` and `--ask-for-approval <policy>`. Mappings:
 *   plan        → Safe read-only browsing (model can request escalation)
 *   dontAsk     → Read-only non-interactive (CI; failures returned to model)
 *   default     → Workspace-write, escalate on untrusted commands
 *   acceptEdits → Workspace-write, never ask (replaces old --full-auto)
 *   auto        → Workspace-write, model decides when to ask
 *   bypass      → Dangerous full access (no sandbox, no approval)
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
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
    case 'auto':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

export class CodexCommandBuilder {
  buildCodexCommand(options: CodexCommandOptions): string {
    const { shell } = options;

    // Codex 0.128 redesigned the hook system; the legacy `.codex/hooks.json`
    // we used to write is no longer parsed and now produces a yellow warning
    // banner at session start. `buildHooks` is now a cleanup-only call that
    // strips Kangentic-owned entries from any pre-upgrade legacy file.
    // See hook-manager.ts for the full context. The eventsOutputPath gate
    // is preserved so non-hookable spawns (no events pipeline requested)
    // skip the disk sweep entirely.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      buildHooks(projectRoot);
    }

    const parts: string[] = [];

    // Resume is a subcommand: codex resume <sessionId> -C <cwd>
    if (options.resume && options.sessionId) {
      parts.push(quoteArg(options.codexPath, shell));
      parts.push('resume', quoteArg(options.sessionId, shell));
      parts.push('-C', quoteArg(toForwardSlash(options.cwd), shell));
      // Same ChatGPT Apps opt-out as the new-session branch below; a resumed
      // session boots the connector too, so the flag has to be repeated here.
      if (options.launchOptions?.disableApps) {
        parts.push('--disable', 'apps');
      }
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

    // Skip the optional cloud ChatGPT Apps MCP connector, which can hang
    // startup at "Booting MCP server: codex_apps" (openai/codex#20167).
    if (options.launchOptions?.disableApps) {
      parts.push('--disable', 'apps');
    }

    // Per-column model override
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    // Prompt as positional argument
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
