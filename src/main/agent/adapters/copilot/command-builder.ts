import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { writeSessionConfig } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

export interface CopilotCommandOptions {
  copilotPath: string;
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
}

/**
 * Map Kangentic's PermissionMode to Copilot CLI flags.
 *
 *   plan              -> --plan (native plan mode)
 *   dontAsk           -> --plan --no-ask-user (read-only, autonomous)
 *   default           -> (no flags - default confirmation behavior)
 *   acceptEdits/auto  -> --allow-all-tools (auto-approve tool usage)
 *   bypassPermissions -> --yolo (allow all tools, paths, and URLs)
 */
function mapPermissionMode(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--plan'];
    case 'dontAsk':
      return ['--plan', '--no-ask-user'];
    case 'default':
      return [];
    case 'acceptEdits':
    case 'auto':
      return ['--allow-all-tools'];
    case 'bypassPermissions':
      return ['--yolo'];
  }
}

/**
 * Prepare a prompt string for safe shell quoting.
 * On PowerShell/cmd, replaces double quotes with single quotes to prevent
 * quoting breakage (quoteArg wraps in "..." and escapes " as \" which
 * PowerShell misinterprets).
 */
function preparePrompt(prompt: string, shell?: string): string {
  const needsDoubleQuoteReplacement = shell
    ? !isUnixLikeShell(shell)
    : process.platform === 'win32';
  return needsDoubleQuoteReplacement
    ? prompt.replace(/"/g, "'")
    : prompt;
}

export class CopilotCommandBuilder {
  buildCopilotCommand(options: CopilotCommandOptions): string {
    const { shell } = options;

    // Write per-session Copilot config with hooks and statusLine.
    // The config merges the user's existing ~/.copilot/config.json with
    // our hooks/statusLine/banner overrides, then is placed in a
    // session-specific directory passed via --config-dir.
    let sessionConfigDir: string | null = null;
    if (options.eventsOutputPath) {
      // Place copilot config alongside the events file
      sessionConfigDir = path.join(path.dirname(options.eventsOutputPath), 'copilot-config');
      writeSessionConfig(
        sessionConfigDir,
        options.eventsOutputPath,
        options.statusOutputPath,
      );
    }

    const parts: string[] = [quoteArg(options.copilotPath, shell)];

    // Resume existing session or start new with caller-specified UUID.
    // Copilot --resume <uuid> works for both cases:
    //   - Existing session: resumes the session with that ID
    //   - New UUID: starts a fresh session with that ID
    if (options.sessionId) {
      parts.push('--resume', quoteArg(options.sessionId, shell));
    }

    // Per-session config directory (merged user config + hooks + statusLine)
    if (sessionConfigDir) {
      parts.push('--config-dir', quoteArg(toForwardSlash(sessionConfigDir), shell));
    }

    // Permission mode flags
    parts.push(...mapPermissionMode(options.permissionMode));

    // MCP server configuration. Emitted BEFORE the non-interactive branch
    // below, which returns early: keeping it further down silently stripped
    // the Kangentic MCP server from every non-interactive Copilot spawn.
    parts.push(...this.buildMcpConfigArgs(options));

    // Non-interactive mode
    if (options.nonInteractive) {
      parts.push('-p');
      if (options.prompt) {
        parts.push(quoteArg(preparePrompt(options.prompt, shell), shell, { multiline: true }));
      }
      // Per-column model/effort overrides in non-interactive mode
      if (options.model && options.model.trim().length > 0) {
        parts.push('--model', quoteArg(options.model.trim(), shell));
      }
      if (options.effort && options.effort.trim().length > 0) {
        parts.push('--reasoning-effort', quoteArg(options.effort.trim(), shell));
      }
      return parts.join(' ');
    }

    // Per-column model/effort overrides
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }
    if (options.effort && options.effort.trim().length > 0) {
      parts.push('--reasoning-effort', quoteArg(options.effort.trim(), shell));
    }

    // Interactive mode with initial prompt
    if (options.prompt && !options.resume) {
      parts.push('-i', quoteArg(preparePrompt(options.prompt, shell), shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  /**
   * Write the Kangentic MCP server config and return the flag that loads it.
   *
   * Copilot's `--additional-mcp-config` augments (rather than replaces) the
   * user's own mcp-config.json, so their servers survive alongside ours.
   * Returns an empty list when MCP is disabled or incompletely configured.
   */
  private buildMcpConfigArgs(options: CopilotCommandOptions): string[] {
    if (!options.mcpServerEnabled || !options.mcpServerUrl || !options.mcpServerToken) {
      return [];
    }
    const mcpConfigDir = path.dirname(options.eventsOutputPath || options.cwd);
    const mcpConfigPath = path.join(mcpConfigDir, 'copilot-mcp.json');
    const mcpConfig = {
      mcpServers: {
        kangentic: {
          type: 'http' as const,
          url: options.mcpServerUrl,
          headers: {
            'X-Kangentic-Token': options.mcpServerToken,
          },
        },
      },
    };
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    return [
      '--additional-mcp-config',
      quoteArg(`@${toForwardSlash(mcpConfigPath)}`, options.shell),
    ];
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
