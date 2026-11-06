import fs from 'node:fs';
import path from 'node:path';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { backgroundShellHintCommandFor, shippedHintBridgePath, wslBackgroundShellHintCommandFor } from '../../shared/background-command-hooks';
import { cliPathForTarget, type CliPlace, type CliTarget } from '../../shared/cli-target';
import { kangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { prepareWslHookTransport, wslHookEventCommand, wslStatusLineCommand } from '../../shared/wsl-hook-transport';
import { COPILOT_BACKGROUND_COMMAND_SPEC, COPILOT_HOOK_SHELL, writeSessionConfig, type CopilotSessionHookOptions } from './hook-manager';
import { SESSION_CONFIG_DIR_NAME, seedResumedSessionState } from './session-state';
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
  /** Report the submitted prompt's text with the Prompt event (a Command Terminal names itself from it). */
  capturePromptText?: boolean;
  /**
   * A Copilot installed in a WSL distro (`CommandOptions.cliTarget`): named by
   * the path the distro sees, its session config seeded from the distro's
   * Copilot home with hooks and status line through the WSL hook transport,
   * and on NAT networking Kangentic's server given as the transport's bridge.
   */
  cliTarget?: CliTarget | null;
}

/**
 * Map Kangentic's PermissionMode to Copilot CLI flags.
 *
 *   plan              -> --plan (native plan mode)
 *   dontAsk           -> --plan --no-ask-user (read-only, autonomous)
 *   default           -> (no flags - default confirmation behavior)
 *   acceptEdits       -> --allow-tool=write (file edits only, as Claude's)
 *   auto              -> assisted permissions: `defaultPermissionMode:
 *                        "assisted"` in the session's settings.json, and
 *                        --assisted-approval in a non-interactive run
 *   bypassPermissions -> --yolo (allow all tools, paths, and URLs)
 *
 * acceptEdits: GitHub's command reference defines the `write` permission kind
 * as "file creation or modification", and `--allow-tool='write'` lets Copilot
 * edit files without asking
 * (https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).
 * A shell command still asks, as it does under Claude's acceptEdits.
 *
 * auto: Copilot's assisted permissions review each tool request and ask only
 * when the review is unsure
 * (https://docs.github.com/en/copilot/concepts/customizations/allowing-safe-commands).
 * `--assisted-approval` errors in an interactive session, so only `-p` gets it.
 *
 * Both are built from the docs (no CLI version stated) and have not run
 * against a real Copilot CLI.
 */
function mapPermissionMode(mode: PermissionMode, nonInteractive: boolean): string[] {
  switch (mode) {
    case 'plan':
      return ['--plan'];
    case 'dontAsk':
      return ['--plan', '--no-ask-user'];
    case 'default':
      return [];
    case 'acceptEdits':
      return ['--allow-tool=write'];
    case 'auto':
      return nonInteractive ? ['--assisted-approval'] : [];
    case 'bypassPermissions':
      return ['--yolo'];
  }
}

/**
 * The server key Kangentic's MCP config names (`mcpServers.kangentic`), and
 * so the name `--allow-tool` approves, here and in the answer run.
 */
export const KANGENTIC_MCP_SERVER_NAME = 'kangentic';

/** Modes whose session gets Kangentic's own tools approved up front. */
function allowsKangenticTools(mode: PermissionMode): boolean {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'auto';
}

/**
 * Prepare a prompt string for safe shell quoting.
 * On PowerShell/cmd, replaces double quotes with single quotes. quoteArg does
 * the same for every value it quotes for those shells
 * (escapeForDoubleQuotedShell).
 */
function preparePrompt(prompt: string, shell?: string): string {
  const needsDoubleQuoteReplacement = shell
    ? !isUnixLikeShell(shell)
    : process.platform === 'win32';
  return needsDoubleQuoteReplacement
    ? prompt.replace(/"/g, "'")
    : prompt;
}

/**
 * Split a command this builder wrote into its arguments, keeping a quoted
 * value whole: a single-quoted run (POSIX shells, with `'\''` for a quote
 * inside), a double-quoted run (PowerShell and cmd), and a backslash escape
 * outside quotes (the `\'` of a POSIX `'\''`).
 *
 * Only for reading `--model` back, and only up to the prompt
 * (`copilotModelFlagValue`). It is not a general shell parser: fish escapes a
 * quote inside single quotes as `\'` and nushell inside double quotes as `\"`,
 * which this reads as the end of the run. The values before the prompt are
 * flags, a session id and paths, so only a path holding a quote on those two
 * shells could mislead it.
 */
function splitCommandArguments(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
      continue;
    }
    if (character === '\\' && index + 1 < command.length && command[index + 1] !== ' ') {
      current += command[index + 1];
      index++;
      inToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += character;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** The flags whose value is the prompt, always the builder's last argument. */
const PROMPT_FLAGS = new Set(['-p', '-i']);

/**
 * The model a built Copilot command passes with `--model` (or `--model=`).
 * The builder writes every flag before the prompt (`-p` or `-i`), so the scan
 * stops there: a prompt is never tokenized, and a `--model` or a quote inside
 * it can never be taken for the flag. Null when the command names none.
 */
export function copilotModelFlagValue(command: string): string | null {
  const tokens = splitCommandArguments(command);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (PROMPT_FLAGS.has(token)) return null;
    if (token === '--model') {
      const value = tokens[index + 1]?.trim();
      return value ? value : null;
    }
    if (token.startsWith('--model=')) {
      const value = token.slice('--model='.length).trim();
      return value ? value : null;
    }
  }
  return null;
}

export class CopilotCommandBuilder {
  buildCopilotCommand(options: CopilotCommandOptions): string {
    const { shell } = options;
    // A Copilot in a WSL distro is started by the path the distro sees; the
    // PTY's cwd reaches it as its `/mnt` path.
    const place = options.cliTarget ?? null;

    // Write the per-session Copilot config home: the event-bridge hooks in
    // hooks/kangentic.json, plus copies of the user's settings.json and
    // config.json carrying our statusLine/banner overrides (see
    // writeSessionConfig). The directory is passed via --config-dir.
    let sessionConfigDir: string | null = null;
    if (options.eventsOutputPath) {
      // Place copilot config alongside the events file
      const sessionDir = path.dirname(options.eventsOutputPath);
      sessionConfigDir = path.join(sessionDir, SESSION_CONFIG_DIR_NAME);
      const sessionSettings: CopilotSessionHookOptions = {
        capturePromptText: options.capturePromptText === true,
        assistedApprovals: options.permissionMode === 'auto',
      };
      writeSessionConfig(
        sessionConfigDir,
        options.eventsOutputPath,
        options.statusOutputPath,
        place ? { ...this.wslHookOptions(options, options.eventsOutputPath, place), ...sessionSettings } : {
          // Names kangentic_mark_background_service, so only a session
          // offered that tool gets it.
          backgroundShellHintCommand: backgroundShellHintCommandFor(
            options, COPILOT_BACKGROUND_COMMAND_SPEC, COPILOT_HOOK_SHELL, shippedHintBridgePath(),
          ),
          ...sessionSettings,
        },
      );
      // A resume starts in a new config home: bring the session's folder over,
      // or Copilot starts an empty session under the same id (session-state.ts).
      // A host's copy is the relay's (`remoteResumeSeed`): what Copilot reads is
      // there, and one seeded here would sit under the copy the host then sends.
      if (options.resume && options.sessionId && place?.kind !== 'ssh') {
        seedResumedSessionState({
          configHome: sessionConfigDir,
          sessionId: options.sessionId,
          sessionsDir: path.dirname(sessionDir),
          place,
        });
      }
    }

    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.copilotPath, shell)];

    // Resume an existing session or start a new one with the caller's UUID.
    // `--session-id <uuid>` does both (added in 1.0.51). `--resume <uuid>` no
    // longer starts a new session: 1.0.97 exits with "No session, task, or
    // name matched" for an id it has not seen, so no new Copilot task started.
    if (options.sessionId) {
      parts.push('--session-id', quoteArg(options.sessionId, shell));
    }

    // Per-session config home (hooks file + merged user settings). Copilot
    // 1.0.40+ prints a deprecation line for --config-dir but still honors it
    // (1.0.97 assigns it to COPILOT_HOME), and older versions know no
    // COPILOT_HOME, so the flag stays.
    if (sessionConfigDir) {
      parts.push('--config-dir', quoteArg(cliPathForTarget(sessionConfigDir, place), shell));
    }

    // Permission mode flags
    parts.push(...mapPermissionMode(options.permissionMode, options.nonInteractive === true));

    // MCP server configuration. Emitted BEFORE the non-interactive branch
    // below, which returns early: keeping it further down silently stripped
    // the Kangentic MCP server from every non-interactive Copilot spawn.
    const mcpConfigArgs = this.buildMcpConfigArgs(options);
    parts.push(...mcpConfigArgs);
    // Kangentic's own tools never wait on an approval, as Claude's
    // `mcp__kangentic` allow rule and Grok's `MCPTool(kangentic__*)` ensure:
    // `--allow-tool kangentic` approves every tool of that server (GitHub's
    // allowing-tools doc; the answer run uses the same flag, measured). Not in
    // the plan modes, where a mutating board tool must keep asking, and not
    // under --yolo, which already allows everything.
    if (mcpConfigArgs.length > 0 && allowsKangenticTools(options.permissionMode)) {
      parts.push('--allow-tool', KANGENTIC_MCP_SERVER_NAME);
    }

    // Per-column model/effort overrides. Before the prompt in both modes:
    // `copilotModelFlagValue` reads flags only up to the prompt.
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }
    if (options.effort && options.effort.trim().length > 0) {
      parts.push('--reasoning-effort', quoteArg(options.effort.trim(), shell));
    }

    // Non-interactive mode
    if (options.nonInteractive) {
      parts.push('-p');
      if (options.prompt) {
        parts.push(quoteArg(preparePrompt(options.prompt, shell), shell, { multiline: true }));
      }
      return parts.join(' ');
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
    const place = options.cliTarget ?? null;
    const mcpConfigDir = path.dirname(options.eventsOutputPath || options.cwd);
    const mcpConfigPath = path.join(mcpConfigDir, 'copilot-mcp.json');
    // A Copilot in a WSL distro on NAT networking cannot reach this machine's
    // loopback: its server is the WSL hook transport's stdio bridge, prepared
    // in the session's directory, the token in the bridge's env. GitHub's CLI
    // command reference: a local server's `type` is `local` or `stdio`, and
    // `command`, `args` and `tools` are required (`["*"]` enables them all).
    // A failed write of the bridge throws, as this file's write does.
    const server = place && options.eventsOutputPath
      ? kangenticMcpServer({ url: options.mcpServerUrl, token: options.mcpServerToken, place, directory: path.dirname(options.eventsOutputPath) })
      : null;
    const mcpConfig = {
      mcpServers: {
        [KANGENTIC_MCP_SERVER_NAME]: server?.kind === 'stdio'
          ? { type: 'stdio' as const, command: server.command, args: server.args, env: { [server.tokenEnv]: server.token }, tools: ['*'] }
          : {
            type: 'http' as const,
            url: options.mcpServerUrl,
            headers: {
              'X-Kangentic-Token': options.mcpServerToken,
            },
          },
      },
    };
    // sync-write-ok: this must throw, not degrade - the path below is passed
    // straight to --additional-mcp-config, so a swallowed failure would spawn
    // Copilot pointed at a config file that does not exist. The spawn preamble
    // already reports and notifies (notifySpawnBlocked) on throw.
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    // sync-write-ok: same reason as the mkdir above.
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    return [
      '--additional-mcp-config',
      quoteArg(`@${cliPathForTarget(mcpConfigPath, place)}`, options.shell),
    ];
  }

  /**
   * The session config's hooks for a Copilot in a WSL distro, which may have
   * no node: the WSL hook transport's `event` with the same events and
   * directives, its `status` for the status line, and its `reply` for the
   * background shell hint, all naming the session's own script (the config
   * home is the session's alone). Seeded from the distro's Copilot home.
   */
  private wslHookOptions(options: CopilotCommandOptions, eventsOutputPath: string, place: CliPlace): CopilotSessionHookOptions {
    const wslHooks = prepareWslHookTransport(path.dirname(eventsOutputPath));
    return {
      backgroundShellHintCommand: wslBackgroundShellHintCommandFor(options, COPILOT_BACKGROUND_COMMAND_SPEC, wslHooks, place),
      eventCommand: (eventType, ...directives) => wslHookEventCommand(wslHooks, place, eventType, ...directives),
      ...(options.statusOutputPath ? { statusLineCommand: wslStatusLineCommand(wslHooks, place, options.statusOutputPath) } : {}),
      place,
    };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
