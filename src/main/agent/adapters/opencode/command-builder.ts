import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { buildHooks } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

export interface OpenCodeCommandOptions {
  opencodePath: string;
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
 * Build the shell command string that spawns OpenCode in interactive
 * TUI mode. CLI surface (verified against /anomalyco/opencode docs):
 *
 *   opencode [--session <id>] [--prompt <text>] [--model <provider/model>]
 *
 * Important shape constraints:
 *
 * - The TUI's positional argument is a PROJECT DIRECTORY, not a prompt.
 *   Initial prompts must go through `--prompt <text>`, otherwise
 *   OpenCode tries to chdir into the prompt text. The PTY layer already
 *   sets the shell cwd, so we never emit a positional/`--dir` value.
 *
 * - Resume uses `--session <id>` (alias `-s`). The flag is part of the
 *   TUI command (the docs list it under "TUI - Terminal User
 *   Interface"), not the `run` subcommand. We omit `--prompt` when
 *   resuming so the user can continue the prior conversation.
 *
 * - There is no `--dangerously-skip-permissions` flag in TUI mode.
 *   That flag is only documented for `opencode run` (non-interactive).
 *   For TUI mode users must configure auto-approve in `opencode.json`.
 *
 * - There is no merged settings file and no `--mcp-config` CLI flag.
 *   OpenCode reads MCP and provider config from `opencode.json` (project)
 *   or `~/.config/opencode/opencode.json` (global), plus the
 *   `OPENCODE_CONFIG_CONTENT` env var for inline overrides. The Kangentic
 *   MCP server is wired via `buildOpenCodeEnv()` below, which emits
 *   `OPENCODE_CONFIG_CONTENT` per PTY spawn so we never have to touch
 *   the user's checked-in `opencode.json`. Configs are deep-merged across
 *   sources, so user-defined `mcp.*` entries are preserved.
 */
export class OpenCodeCommandBuilder {
  buildOpenCodeCommand(options: OpenCodeCommandOptions): string {
    const { shell } = options;

    // Install the activity-stream plugin into the project's
    // `.opencode/plugins/` directory before the CLI launches. OpenCode
    // auto-discovers plugins from that directory at TUI startup, so no
    // CLI flag or `opencode.json` mutation is required. Mirrors the
    // `buildHooks` side effect in CodexCommandBuilder.buildCodexCommand.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      buildHooks(projectRoot);
    }

    const parts: string[] = [quoteArg(options.opencodePath, shell)];

    if (options.resume && options.sessionId) {
      parts.push('--session', quoteArg(options.sessionId, shell));
      // Resume attaches to the existing OpenCode session - no prompt
      // is delivered (mirrors Claude's --resume convention).
      return parts.join(' ');
    }

    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('--prompt', quoteArg(safePrompt, shell));
    }

    return parts.join(' ');
  }

  /**
   * Build env vars that inject the Kangentic MCP server into OpenCode.
   *
   * OpenCode loads config from multiple sources and deep-merges them by
   * key. The `OPENCODE_CONFIG_CONTENT` env var is one of those sources,
   * with higher precedence than the project's `opencode.json`, so the
   * launch-fresh URL + token always win. Because the merge is per-key,
   * any user-defined `mcp.*` entries (filesystem, github, etc.) are
   * preserved alongside our `mcp.kangentic` entry.
   *
   * Schema verified against /anomalyco/opencode docs: remote MCP servers
   * use `type: "remote"` (not Claude's `"http"`), `url`, and optional
   * `headers`. We pass the per-launch token via the `X-Kangentic-Token`
   * header that the in-process MCP HTTP server expects.
   *
   * Returns `null` when MCP wiring is disabled or any of the required
   * URL / token values are missing.
   */
  buildOpenCodeEnv(options: OpenCodeCommandOptions): Record<string, string> | null {
    if (!options.mcpServerEnabled) return null;
    if (!options.mcpServerUrl || !options.mcpServerToken) return null;

    const inlineConfig = {
      mcp: {
        kangentic: {
          type: 'remote',
          url: options.mcpServerUrl,
          enabled: true,
          headers: {
            'X-Kangentic-Token': options.mcpServerToken,
          },
        },
      },
    };

    return { OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig) };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
