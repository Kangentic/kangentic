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

    // Non-interactive mode
    if (options.nonInteractive) {
      parts.push('-p');
      if (options.prompt) {
        parts.push(quoteArg(preparePrompt(options.prompt, shell), shell));
      }
      return parts.join(' ');
    }

    // MCP server configuration
    // Copilot supports --additional-mcp-config which augments (not replaces)
    // the user's mcp-config.json. Write a proper MCP server config file.
    if (options.mcpServerEnabled && options.mcpServerUrl && options.mcpServerToken) {
      const mcpConfigDir = path.dirname(options.eventsOutputPath || options.cwd);
      const mcpConfigPath = path.join(mcpConfigDir, 'copilot-mcp.json');
      const mcpConfig = {
        mcpServers: {
          kangentic: {
            url: options.mcpServerUrl,
            headers: {
              'X-Kangentic-Token': options.mcpServerToken,
            },
          },
        },
      };
      fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      parts.push('--additional-mcp-config', quoteArg(`@${toForwardSlash(mcpConfigPath)}`, shell));
    }

    // Interactive mode with initial prompt
    if (options.prompt && !options.resume) {
      parts.push('-i', quoteArg(preparePrompt(options.prompt, shell), shell));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
