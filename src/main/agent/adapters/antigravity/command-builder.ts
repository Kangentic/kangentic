import fs from 'node:fs';
import path from 'node:path';
import { quoteArg, isUnixLikeShell, toForwardSlash } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import {
  antigravityHooksPath,
  buildHooks,
  deployWorkspaceBridgeCopy,
  spaceFreeAgentsToken,
  wslAgentsHookCommand,
  type AntigravityHooksFile,
} from './hook-manager';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { cliPathForTarget, type CliPlace, type CliTarget } from '../../shared/cli-target';
import { kangenticMcpServer, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { prepareWslHookTransport, wslStatusLineCommand, type WslHookPaths } from '../../shared/wsl-hook-transport';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { quoteBridgePath, type HookShell } from '../../shared/hook-utils';
import { antigravityHelpFeatures } from './capability-discovery';
import { antigravitySettingsPath } from './data-paths';
import { readSettings } from './trust-manager';
import type { PermissionMode } from '../../../../shared/types';

/**
 * How agy runs a status line command on Windows: `cmd /c` (statusline doc,
 * https://antigravity.google/docs/cli/statusline). Whether agy hands cmd the
 * command verbatim or escaped is not documented, and an escaped command line
 * turns every `"` into `\"`, so every token stays bare. A path with a space
 * then gets no status line rather than a broken one.
 */
const AGY_STATUS_LINE_SHELL: HookShell = 'bare-tokens';

/** The per-session settings file passed with `--settings`, beside the session's status file. */
export const AGY_SESSION_SETTINGS_FILE = 'antigravity-settings.json';

/** CLI paths already logged as spawned before discovery read their `--help`, so each is logged once. */
const undiscoveredCliPathsLogged = new Set<string>();

/**
 * Single gate for the Kangentic MCP plugin, shared by "should we write" and
 * the block that writes it, so the two cannot drift (same shape as
 * `geminiMcpWiringEnabled` / `codexMcpWiringEnabled`). Default-on: only an
 * explicit `false` suppresses it.
 */
export function antigravityMcpWiringEnabled(
  options: AntigravityCommandOptions,
): options is AntigravityCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return (
    options.mcpServerEnabled !== false
    && Boolean(options.mcpServerUrl)
    && Boolean(options.mcpServerToken)
  );
}

export interface AntigravityCommandOptions {
  agyPath: string;
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
  /**
   * An agy installed in a WSL distro (`CommandOptions.cliTarget`): named by the
   * path the distro sees, its hooks run the WSL hook transport's script, and
   * on NAT networking its MCP plugin names the transport's stdio bridge.
   */
  cliTarget?: CliTarget | null;
}

export class AntigravityCommandBuilder {
  buildAntigravityCommand(options: AntigravityCommandOptions): string {
    const { shell } = options;
    // An agy in a WSL distro is started by the path the distro sees; the PTY's
    // cwd reaches it as its `/mnt` path.
    const place = options.cliTarget ?? null;
    const parts = [quoteArg(place ? place.linuxCliPath : options.agyPath, shell)];

    // Side effects first: hooks.json (event bridge) and the MCP plugin dir.
    // Seed .git/info/exclude BEFORE the writes so the hooks.json
    // pre-existence check reflects the user's file, not ours: the runtime
    // files otherwise sit untracked in the worktree for the whole session,
    // polluting git status and riding along with any `git add -A` an agent
    // runs - which for the MCP plugin would commit the per-launch token.
    this.seedGitExcludes(options);
    // An agy in a WSL distro publishes its hooks and status line through the
    // session's WSL hook transport, prepared once for both. A failed write
    // throws to the spawn's caller, as the other files do.
    const statusLineOutputPath = this.sessionSettingsEnabled(options) ? options.statusOutputPath : undefined;
    const sessionFilePath = options.eventsOutputPath ?? statusLineOutputPath;
    const wslHooks = place && sessionFilePath ? prepareWslHookTransport(path.dirname(sessionFilePath)) : null;
    if (options.eventsOutputPath) {
      this.writeMergedHooks(options.cwd, options.eventsOutputPath, wslHooks);
    }
    if (antigravityMcpWiringEnabled(options)) {
      const server = this.kangenticServer(options, place);
      if (server) this.writeMcpPlugin(options.cwd, server);
    }

    // Permission mode mapping onto agy's native modes
    // (https://antigravity.google/docs/cli/modes): `--mode plan`,
    // `--mode accept-edits`, `--mode auto`, and `--dangerously-skip-permissions`.
    // No flag leaves agy in its own saved mode, which is `auto` where the
    // terminal sandbox and the account allow it and `default` (review before
    // each write and command) otherwise.
    switch (options.permissionMode) {
      // dontAsk: agy has no deny-unless-allowed mode. Plan mode investigates
      // with read-only tools, which keeps dontAsk's promise that nothing
      // unapproved runs (Gemini, Qwen and Copilot map it the same way).
      case 'plan':
      case 'dontAsk':
        parts.push('--mode', 'plan');
        break;
      case 'auto':
        // `--mode auto` exists from agy 1.3.5 (macOS, Linux) and 1.4.4
        // (Windows). Where the sandbox or the account rules it out agy starts
        // in `default` (modes doc). Passed only when this CLI's `--help`
        // lists it; an older CLI keeps the accept-edits mapping.
        parts.push('--mode', antigravityHelpFeatures(options.agyPath)?.modes.includes('auto') ? 'auto' : 'accept-edits');
        break;
      case 'acceptEdits':
        parts.push('--mode', 'accept-edits');
        break;
      case 'bypassPermissions':
        parts.push('--dangerously-skip-permissions');
        break;
      case 'default':
      default:
        break;
    }

    // Live telemetry: a per-session status line through `--settings`.
    const settingsPath = statusLineOutputPath ? this.writeSessionSettings(statusLineOutputPath, place, wslHooks) : null;
    if (settingsPath) {
      parts.push('--settings', quoteArg(place ? cliPathForTarget(settingsPath, place) : settingsPath, shell));
    }

    // Resume a specific prior conversation. Works cross-directory (verified),
    // so a relocated worktree still reaches its conversation. New sessions
    // pass nothing - agy allocates the conversation id lazily at first turn.
    if (options.resume && options.sessionId) {
      parts.push('--conversation', quoteArg(options.sessionId, shell));
    }

    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    if (options.effort && options.effort.trim().length > 0) {
      parts.push('--effort', quoteArg(options.effort.trim(), shell));
    }

    // Prompt delivery: `-p` runs once and exits (print mode); `-i` runs the
    // prompt and keeps the TUI session (the interactive spawn path). agy has
    // no bare positional prompt form.
    if (options.prompt) {
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push(options.nonInteractive ? '-p' : '-i');
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Merge the Kangentic named hook into `<cwd>/.agents/hooks.json`,
   * preserving user hooks and self-healing stale Kangentic entries from a
   * crashed session (filterOurHooks inside buildHooks).
   *
   * Both the bridge script and the events file are referenced by
   * `.agents`-relative, space-free tokens because agy's hook runner
   * tokenizes on whitespace with literal quotes (see hook-manager.ts). When
   * either token cannot be made space-free (cross-drive events path), hook
   * wiring is skipped: the session still works, activity falls back to the
   * PTY silence timer (`hooks_and_pty`), and session-id capture falls back
   * to the shutdown-summary PTY scrape.
   *
   * `wslHooks` is the session's prepared WSL hook transport for an agy in a
   * WSL distro, else null.
   */
  private writeMergedHooks(cwd: string, eventsOutputPath: string, wslHooks: WslHookPaths | null): void {
    let bridgeToken: string | null;
    let eventsToken: string | null;
    let eventCommand: ((eventType: string, ...directives: string[]) => string) | undefined;
    if (wslHooks) {
      // An agy in a WSL distro may have no node: its hooks publish through the
      // WSL hook transport, the session's script named by a space-free token.
      const scriptToken = spaceFreeAgentsToken(cwd, wslHooks.script);
      bridgeToken = scriptToken;
      eventsToken = scriptToken;
      if (scriptToken) eventCommand = (eventType, ...directives) => wslAgentsHookCommand(scriptToken, eventType, ...directives);
    } else {
      bridgeToken = deployWorkspaceBridgeCopy(cwd);
      eventsToken = spaceFreeAgentsToken(cwd, eventsOutputPath);
    }
    if (!bridgeToken || !eventsToken) {
      console.warn(
        '[antigravity] Skipping hook wiring (no space-free relative path available); '
        + 'PTY fallback will drive activity',
      );
      return;
    }

    let existingRoot: AntigravityHooksFile = {};
    const hooksPath = antigravityHooksPath(cwd);
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingRoot = parsed as AntigravityHooksFile;
      }
    } catch {
      // No existing hooks file - start fresh.
    }

    const merged = buildHooks(bridgeToken, eventsToken, existingRoot, eventCommand);
    try {
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify(merged, null, 2));
      console.log(`[antigravity] Wrote hooks to ${hooksPath} (events -> ${eventsToken})`);
    } catch (error) {
      console.error(`[antigravity] Failed to write hooks file: ${hooksPath}`, error);
    }
  }

  /**
   * Whether this spawn gets a per-session status line: it has a status file to
   * report to and this CLI's `--help` lists `--settings`. Discovery reads the
   * help when the agent list loads, so an agy spawned before that (a session
   * resumed at startup) is treated as an older CLI for its lifetime. That is
   * logged once per CLI path rather than left silent.
   */
  private sessionSettingsEnabled(options: AntigravityCommandOptions): boolean {
    if (!options.statusOutputPath) return false;
    const features = antigravityHelpFeatures(options.agyPath);
    if (!features && !undiscoveredCliPathsLogged.has(options.agyPath)) {
      undiscoveredCliPathsLogged.add(options.agyPath);
      console.warn(`[antigravity] Spawning ${options.agyPath} before its --help was read; no --settings status line or --mode auto for this session`);
    }
    return features?.sessionSettings === true;
  }

  /**
   * Write the session's `--settings` file and return its path, or null when
   * this spawn passes none.
   *
   * agy's custom status line (https://antigravity.google/docs/cli/statusline)
   * pipes a JSON state payload (model, context window, tokens, cost) to its
   * command on stdin whenever the agent state changes. Its documented home is
   * the user's global `settings.json`, which every agy session shares, so it
   * goes in `--settings` instead: "Settings for this session only, never
   * saved: a JSON object of settings.json keys, inline or as a file path"
   * (`agy --help`, 1.4.12; no changelog entry dates the flag, so it is passed
   * only when this CLI's help lists it). The command is `status-bridge.js`
   * with the session's status file, which it rewrites whole on every run. An
   * agy in a WSL distro runs the WSL hook transport's `status` mode instead,
   * since the distro may have no node.
   *
   * `stack_with_default: true` keeps agy's built-in status line, whose
   * `? for shortcuts` hint `detectIdle` reads; the bridge prints nothing below
   * it. Built from the documentation; not yet run against a real agy.
   *
   * The help does not say whether the file is merged over the saved
   * settings.json or replaces it for the session. Replaced, the session would
   * lose the saved trust (and stop at agy's folder trust prompt) and the
   * user's permission rules. So the file also carries the saved values of the
   * keys that keep a session unblocked and as guarded as the user set it
   * (`savedSessionGuards`), so the session sees them either way. Every spawn
   * path awaits `ensureTrust` before it builds the command, so the copied
   * trust list already names this folder.
   *
   * Never throws: a path a bare token cannot carry or a failed write leaves
   * the session without live telemetry, as an older agy is.
   */
  private writeSessionSettings(
    statusOutputPath: string,
    place: CliPlace | null,
    wslHooks: WslHookPaths | null,
  ): string | null {
    const sessionDir = path.dirname(statusOutputPath);
    const settingsPath = path.join(sessionDir, AGY_SESSION_SETTINGS_FILE);
    try {
      let statusLineCommand: string;
      if (place) {
        if (!wslHooks) return null;
        statusLineCommand = wslStatusLineCommand(wslHooks, place, statusOutputPath);
      } else {
        const statusBridge = toForwardSlash(resolveBridgeScript('status-bridge'));
        statusLineCommand = `node ${quoteBridgePath(statusBridge, AGY_STATUS_LINE_SHELL)} ${quoteBridgePath(toForwardSlash(statusOutputPath), AGY_STATUS_LINE_SHELL)}`;
      }
      const settings = {
        ...savedSessionGuards(place),
        statusLine: {
          type: 'command',
          command: statusLineCommand,
          stack_with_default: true,
        },
      };
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return settingsPath;
    } catch (error) {
      console.warn('[antigravity] No per-session status line for this spawn; live telemetry is off', error);
      return null;
    }
  }

  /**
   * Local-ignore the runtime files this builder is about to write, via
   * `.git/info/exclude` (never committed; ignore rules only hide UNTRACKED
   * files, so a user's own tracked `.agents` customizations keep normal git
   * visibility):
   * - `.agents/plugins/kangentic/` is wholly Kangentic-owned and carries the
   *   per-launch MCP token - always excluded.
   * - `.agents/hooks.json` is excluded only when it does not already exist
   *   (Kangentic is creating it); a user-authored file keeps its visibility.
   * - `.kangentic/` covers the workspace bridge copy in repos whose
   *   committed .gitignore lacks the line Kangentic adds at project open
   *   (a fresh worktree checks out only committed ignore rules).
   */
  private seedGitExcludes(options: AntigravityCommandOptions): void {
    const patterns: string[] = [];
    if (options.eventsOutputPath) {
      patterns.push('.kangentic/');
      if (!fs.existsSync(antigravityHooksPath(options.cwd))) {
        patterns.push('.agents/hooks.json');
      }
    }
    if (antigravityMcpWiringEnabled(options)) {
      patterns.push('.agents/plugins/kangentic/');
    }
    if (patterns.length > 0) {
      ensureLocalGitExcludes(options.cwd, patterns);
    }
  }

  /**
   * Write the Kangentic MCP server as a WORKSPACE PLUGIN at
   * `<cwd>/.agents/plugins/kangentic/{plugin.json,mcp_config.json}`.
   *
   * Verified against agy 1.1.13: a bare workspace `mcp_config.json` never
   * loads (upstream #60), but a workspace plugin's does - the client dials
   * `serverUrl` with a streamable-HTTP `POST /mcp` initialize and forwards
   * the `headers` map (undocumented in the builtin MCP guide but honored),
   * connecting lazily at the first agent turn. The plugin dir is wholly
   * Kangentic-owned (namespaced `kangentic`), so it is written and removed
   * wholesale - user MCP servers live in their own plugins or the global
   * config and are never touched.
   *
   * Security trade-off (identical to Gemini/Qwen): the per-launch token is
   * plaintext on disk during the active session. Mitigations: tokens rotate
   * per app launch, and `removeHooks()` deletes the plugin dir on session
   * exit / suspend.
   *
   * For an agy in a WSL distro on NAT networking the entry is the WSL hook
   * transport's stdio bridge (`command`, `args`, `env`), the token in the
   * bridge's `env`, as plaintext as the header form above.
   */
  private writeMcpPlugin(cwd: string, server: KangenticMcpServer): void {
    const pluginDir = path.join(cwd, '.agents', 'plugins', 'kangentic');
    try {
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'kangentic' }, null, 2),
      );
      fs.writeFileSync(
        path.join(pluginDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            kangentic: server.kind === 'stdio'
              ? { command: server.command, args: server.args, env: { [server.tokenEnv]: server.token } }
              : { serverUrl: server.url, headers: { 'X-Kangentic-Token': server.token } },
          },
        }, null, 2),
      );
      console.log(`[antigravity] Wrote MCP plugin to ${pluginDir}`);
    } catch (error) {
      console.error(`[antigravity] Failed to write MCP plugin: ${pluginDir}`, error);
    }
  }

  /**
   * Kangentic's server for this session (`kangenticMcpServer`): the URL, or
   * for an agy in a WSL distro on NAT networking the transport's bridge,
   * prepared in the session's directory, whose relay the spawn attaches. Null
   * for a distro build with no session directory, or a bridge that cannot be
   * written: the session then runs without Kangentic's tools.
   */
  private kangenticServer(
    options: AntigravityCommandOptions & { mcpServerUrl: string; mcpServerToken: string },
    place: CliPlace | null,
  ): KangenticMcpServer | null {
    if (!place) return { kind: 'http', url: options.mcpServerUrl, token: options.mcpServerToken };
    if (!options.eventsOutputPath) return null;
    try {
      return kangenticMcpServer({
        url: options.mcpServerUrl,
        token: options.mcpServerToken,
        place,
        directory: path.dirname(options.eventsOutputPath),
      });
    } catch (error) {
      console.error('[antigravity] Could not prepare the WSL MCP bridge; the session runs without Kangentic tools', error);
      return null;
    }
  }
}

/**
 * The saved settings keys a `--settings` file repeats, so a session keeps them
 * even if agy replaces the saved settings with the file rather than merging
 * it: the folder trust that keeps a spawn from blocking, and the user's own
 * guards (permission rules, the tool permission level, the terminal sandbox)
 * and saved mode, which the Default permission entry leaves to agy. Key names
 * from https://antigravity.google/docs/cli/reference. Nothing else is copied:
 * the file sits in the project's `.kangentic/`, and settings.json can hold a
 * custom model provider's credentials.
 */
export const AGY_SESSION_GUARD_KEYS = ['trustedWorkspaces', 'permissions', 'toolPermission', 'enableTerminalSandbox', 'agentMode'] as const;

/** The saved values of `AGY_SESSION_GUARD_KEYS`, from the settings of the agy at `place` (the distro's for a WSL agy). */
function savedSessionGuards(place: CliPlace | null): Record<string, unknown> {
  const saved = readSettings(antigravitySettingsPath(place));
  const guards: Record<string, unknown> = {};
  for (const key of AGY_SESSION_GUARD_KEYS) {
    if (saved[key] !== undefined) guards[key] = saved[key];
  }
  return guards;
}

/**
 * Sanitize prompt text for shell quoting: for double-quoted shells
 * (PowerShell, cmd) replace double quotes with single quotes; single-quoted
 * shells (bash, zsh) need no replacement. Same policy as the Gemini/Ollama
 * builders.
 */
function sanitizePrompt(prompt: string, shell?: string): string {
  const needsDoubleQuoteReplacement = shell
    ? !isUnixLikeShell(shell)
    : process.platform === 'win32';
  return needsDoubleQuoteReplacement
    ? prompt.replace(/"/g, "'")
    : prompt;
}
