import fs from 'node:fs';
import path from 'node:path';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
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
import type { CliPlace, CliTarget } from '../../shared/cli-target';
import { kangenticMcpServer, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { prepareWslHookTransport } from '../../shared/wsl-hook-transport';
import type { PermissionMode } from '../../../../shared/types';

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
    if (options.eventsOutputPath) {
      this.writeMergedHooks(options.cwd, options.eventsOutputPath, place);
    }
    if (antigravityMcpWiringEnabled(options)) {
      const server = this.kangenticServer(options, place);
      if (server) this.writeMcpPlugin(options.cwd, server);
    }

    // Permission mode mapping onto agy's native autonomy flags
    // (`--mode accept-edits|plan`, `--dangerously-skip-permissions`; the
    // unflagged default is agy's "request-review"). dontAsk maps to the skip
    // flag because agy's plan mode still executes read tools and its
    // description ("Auto-approve all tool permission requests without
    // prompting") is exactly dontAsk's contract.
    switch (options.permissionMode) {
      case 'plan':
        parts.push('--mode', 'plan');
        break;
      case 'acceptEdits':
      case 'auto':
        parts.push('--mode', 'accept-edits');
        break;
      case 'bypassPermissions':
      case 'dontAsk':
        parts.push('--dangerously-skip-permissions');
        break;
      case 'default':
      default:
        break;
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
   */
  private writeMergedHooks(cwd: string, eventsOutputPath: string, place: CliPlace | null): void {
    let bridgeToken: string | null;
    let eventsToken: string | null;
    let eventCommand: ((eventType: string, ...directives: string[]) => string) | undefined;
    if (place) {
      // An agy in a WSL distro may have no node: its hooks publish through the
      // WSL hook transport, the session's script named by a space-free token.
      // A failed write throws to the spawn's caller, as the other files do.
      const scriptToken = spaceFreeAgentsToken(cwd, prepareWslHookTransport(path.dirname(eventsOutputPath)).script);
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
