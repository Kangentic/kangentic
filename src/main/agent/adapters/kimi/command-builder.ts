import path from 'node:path';
import { quoteArg } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import type { PermissionMode } from '../../../../shared/types';
import type { SpawnCommandOptions } from '../../agent-adapter';
import { kimiKangenticMcpEntry, writeKimiProjectMcpConfig } from './mcp-config';

/**
 * Build the shell command that starts Kimi Code CLI's interactive session.
 *
 * Flags from `en/reference/kimi-command.md` and
 * `apps/kimi-code/src/cli/options.ts` (Kimi Code CLI 2.4.1, read 2026-11-03):
 *
 *   -S, --session [id]   resume that session (it never creates one with a chosen id)
 *   -c, --continue       continue the working directory's previous session
 *   -m, --model <alias>  a model alias from `config.toml`
 *   -y, --yolo           "Ask When Needed" permission mode
 *   --auto               "Never Ask" permission mode
 *   --plan               start in Plan mode
 *
 * There is no working-directory flag (the CLI uses its process cwd, which the
 * PTY sets) and no way to start the session with a prompt: a positional
 * argument fails with "unknown command", and `-p` runs one prompt and exits.
 * So the builder never puts a prompt on the command line, and the adapter
 * declares `freshPromptDelivery` and `resumePromptDelivery` as `'typed'`: the
 * engine types the prompt in once the TUI is ready. `--continue` conflicts
 * with `--session`, and `--yolo` with `--auto`.
 *
 * Built from the docs and source, not yet checked against a real run.
 */
export interface KimiCommandOptions extends Omit<SpawnCommandOptions, 'agentPath'> {
  kimiPath: string;
  /**
   * When true and no `sessionId` is supplied, emit `--continue` so Kimi
   * resumes the working directory's most recent session. Ignored when
   * `sessionId` is set (the explicit id always wins).
   */
  useContinueFallback?: boolean;
}

/**
 * Map Kangentic's permission mode to Kimi Code's flags
 * (`en/guides/interaction.md`, "The three permission modes"):
 *
 *   plan               -> --plan  (read-only Plan mode)
 *   default            -> no flag ("Always Ask", the CLI's `manual` default)
 *   auto               -> --yolo  ("Ask When Needed": still asks for sensitive
 *                                  files, dangerous commands and a plan exit)
 *   bypassPermissions  -> --auto  ("Never Ask": only a plan waits for review)
 *
 * Kimi Code has no accept-edits or deny-unless-allowed mode, so the adapter
 * does not offer acceptEdits or dontAsk; a stored one maps to no flag. A
 * resume passes the mode again, which overrides the one stored in the session
 * (since 0.14.2).
 */
export function kimiPermissionFlags(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--plan'];
    case 'auto':
      return ['--yolo'];
    case 'bypassPermissions':
      return ['--auto'];
    case 'default':
    case 'acceptEdits':
    case 'dontAsk':
      return [];
  }
}

/** Whether a session's Kangentic MCP entry is written (`kangenticMcp: 'shared-folder'`). */
export function kimiMcpWiringEnabled(
  options: Pick<KimiCommandOptions, 'mcpServerEnabled' | 'mcpServerUrl' | 'mcpServerToken'>,
): options is typeof options & { mcpServerUrl: string; mcpServerToken: string } {
  return options.mcpServerEnabled !== false && Boolean(options.mcpServerUrl) && Boolean(options.mcpServerToken);
}

export class KimiCommandBuilder {
  buildKimiCommand(options: KimiCommandOptions): string {
    const { shell } = options;
    // A Kimi Code installed in a WSL distro is started by the path the distro sees.
    const place = options.cliTarget ?? null;
    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.kimiPath, shell)];

    if (options.sessionId) {
      parts.push('--session', quoteArg(options.sessionId, shell));
    } else if (options.useContinueFallback) {
      parts.push('--continue');
    }

    parts.push(...kimiPermissionFlags(options.permissionMode));

    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    this.writeMcpConfig(options);

    return parts.join(' ');
  }

  /**
   * Write Kangentic's server into the working folder's `.kimi-code/mcp.json`
   * (see `mcp-config.ts`). The bridge for a distro on NAT networking is
   * prepared in the session's own directory, beside its status file.
   */
  writeMcpConfig(options: KimiCommandOptions): void {
    if (!kimiMcpWiringEnabled(options)) return;
    if (!options.statusOutputPath) {
      console.warn('[kimi command-builder] mcpServerEnabled is true but statusOutputPath is missing - skipping MCP config wiring');
      return;
    }
    const entry = kimiKangenticMcpEntry({
      url: options.mcpServerUrl,
      token: options.mcpServerToken,
      place: options.cliTarget ?? null,
      sessionDirectory: path.dirname(options.statusOutputPath),
    });
    writeKimiProjectMcpConfig(options.cwd, entry);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
