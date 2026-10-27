import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { EVENTS_PATH_FROM_ENVIRONMENT } from '../../shared/hook-utils';
import { backgroundShellHintCommandFor, shippedHintBridgePath, wslBackgroundShellHintCommandFor } from '../../shared/background-command-hooks';
import type { CliTarget } from '../../shared/cli-target';
import { KANGENTIC_MCP_BRIDGE_SCRIPT_ENV, kangenticMcpServer, mcpBridgeScriptEnv } from '../../shared/kangentic-mcp-server';
import {
  WSL_MCP_REQUEST_HEAD,
  WSL_MCP_TOKEN_ENV,
  copyWslHookScriptInto,
  prepareWslHookTransport,
  wslHookEventCommand,
} from '../../shared/wsl-hook-transport';
import { buildHooks, GEMINI_BACKGROUND_COMMAND_SPEC, GEMINI_HOOK_SHELL, stripKangenticEntries } from './hook-manager';
import type { GeminiHookEntry } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

/**
 * Single gate for the Kangentic MCP entry, shared by the "should we write the
 * settings file at all" check and the block that builds the entry. Keeping one
 * predicate is what stops the two from drifting into a state where the file is
 * written with no MCP entry in it (or vice versa). Same shape as
 * `codexMcpWiringEnabled` / `droidMcpWiringEnabled`.
 *
 * Default-on: only an explicit `false` suppresses it.
 */
function geminiMcpWiringEnabled(
  options: GeminiCommandOptions,
): options is GeminiCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return (
    options.mcpServerEnabled !== false
    && Boolean(options.mcpServerUrl)
    && Boolean(options.mcpServerToken)
  );
}

/**
 * The variables the Kangentic MCP entry in `.gemini/settings.json` names, which
 * Gemini expands from its own environment and `buildGeminiEnv` sets per spawn.
 */
export const KANGENTIC_MCP_URL_ENV = 'KANGENTIC_MCP_URL';
export const KANGENTIC_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';

/**
 * The workspace copy of the WSL hook transport's script a Gemini in a WSL
 * distro runs its hooks with (`copyWslHookScriptInto`). The settings file is
 * shared by every session in the folder, so its commands name the folder's
 * copy, the same for each session, and the copy finds the session's own
 * folder through `KANGENTIC_WSL_HOOK_DIR`, which Gemini's hooks inherit.
 */
export const GEMINI_WSL_HOOK_COPY_NAME = 'gemini-wsl-hook.sh';

/**
 * Kangentic's entry for a Gemini in a WSL distro on NAT networking, which
 * cannot reach this machine's loopback: the transport's stdio bridge. Static
 * like the URL entry: the script, the URL and the token are references Gemini
 * expands from the session's environment (every settings string), so the
 * shared file stays the same bytes for every session.
 */
const GEMINI_BRIDGE_MCP_ENTRY = {
  command: 'sh',
  args: [`\${${KANGENTIC_MCP_BRIDGE_SCRIPT_ENV}}`, WSL_MCP_REQUEST_HEAD, `\${${KANGENTIC_MCP_URL_ENV}}`],
  env: { [WSL_MCP_TOKEN_ENV]: `\${${KANGENTIC_MCP_TOKEN_ENV}}` },
};

/** Gemini-specific subset of settings.json that we read/write. */
interface GeminiSettings {
  hooks?: Record<string, GeminiHookEntry[]>;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GeminiCommandOptions {
  geminiPath: string;
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
   * A Gemini installed in a WSL distro (`CommandOptions.cliTarget`): named by
   * the path the distro sees, its hooks run the WSL hook transport's script
   * instead of the node bridge, and on NAT networking Kangentic's server is the
   * transport's stdio bridge.
   */
  cliTarget?: CliTarget | null;
}

export class GeminiCommandBuilder {
  buildGeminiCommand(options: GeminiCommandOptions): string {
    const { shell } = options;
    // A Gemini in a WSL distro is started by the path the distro sees; the
    // PTY's cwd reaches it as its `/mnt` path.
    const place = options.cliTarget ?? null;
    const parts = [quoteArg(place ? place.linuxCliPath : options.geminiPath, shell)];

    // Write merged settings with event-bridge hooks and / or the Kangentic
    // MCP server entry. Seed .git/info/exclude BEFORE the write so the
    // settings.json pre-existence check reflects the user's file, not ours:
    // the merged file otherwise sits untracked in the worktree for the whole
    // session, polluting git status and riding along with any `git add -A`
    // an agent runs - which would commit the per-launch plaintext token.
    this.seedGitExcludes(options);
    if (this.shouldWriteMergedSettings(options)) {
      this.createMergedSettings(options);
    }

    // Permission mode mapping to Gemini CLI --approval-mode flags.
    // Gemini CLI choices: default, auto_edit, yolo, plan
    switch (options.permissionMode) {
      case 'plan':
      case 'dontAsk':
        parts.push('--approval-mode', 'plan');
        break;
      case 'acceptEdits':
      case 'auto':
        parts.push('--approval-mode', 'auto_edit');
        break;
      case 'bypassPermissions':
        parts.push('--approval-mode', 'yolo');
        break;
      case 'default':
      default:
        // 'default' is Gemini's default - no flag needed
        break;
    }

    // Session resume: Gemini uses --resume <id> for existing sessions.
    // For new sessions, no flag is needed (Gemini creates implicitly).
    if (options.resume && options.sessionId) {
      parts.push('--resume', quoteArg(options.sessionId, shell));
    }

    // Per-column model override
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    // Prompt delivery differs between interactive and non-interactive mode
    if (options.nonInteractive && options.prompt) {
      // Non-interactive: use -p flag
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push('-p', quoteArg(safePrompt, shell, { multiline: true }));
    } else if (options.prompt) {
      // Interactive: prompt as positional argument
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Environment injected into the Gemini PTY: the MCP URL (which carries the
   * caller session) and the per-launch token that the folder-shared
   * `.gemini/settings.json` names by reference. The events path rides
   * `KANGENTIC_EVENTS_PATH`, which every session spawn sets.
   */
  buildGeminiEnv(options: GeminiCommandOptions): Record<string, string> | null {
    if (!geminiMcpWiringEnabled(options)) return null;
    const place = options.cliTarget ?? null;
    return {
      [KANGENTIC_MCP_URL_ENV]: options.mcpServerUrl,
      [KANGENTIC_MCP_TOKEN_ENV]: options.mcpServerToken,
      // The bridge entry's script, for a Gemini in a WSL distro (read on NAT
      // networking, unused on mirrored).
      ...(place && options.eventsOutputPath ? mcpBridgeScriptEnv(path.dirname(options.eventsOutputPath), place) : {}),
    };
  }

  /**
   * The project's `.gemini/settings.json` with Kangentic's own hooks and
   * `mcpServers.kangentic` entry stripped (`stripKangenticEntries`), read from
   * disk on every spawn so an edit or a pull reaches the next session with no
   * restart. In the main repo (`cwd` is the project root) this is the file the
   * previous spawn wrote, and the strip keeps that spawn's entries out of the
   * user's baseline.
   */
  private readBaseSettings(projectRoot: string): GeminiSettings {
    let baseSettings: GeminiSettings = {};
    const projectSettingsPath = path.join(projectRoot, '.gemini', 'settings.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf-8'));
      // A settings.json that parses to an array or a scalar would spread into
      // the merged object as index keys, so only take a plain object. Same
      // guard the Droid adapter applies to its own config read.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) baseSettings = parsed;
    } catch {
      // No existing settings - start fresh
    }

    stripKangenticEntries(baseSettings);
    return baseSettings;
  }

  /**
   * Whether this session's Gemini gets Kangentic's server as the WSL hook
   * transport's bridge (`kangenticMcpServer` decides: a distro on NAT
   * networking), prepared in the session's directory, whose relay the spawn
   * attaches. A build with no session directory, which every production spawn
   * path supplies, keeps the URL entry.
   */
  private usesMcpBridge(options: GeminiCommandOptions & { mcpServerUrl: string; mcpServerToken: string }): boolean {
    const place = options.cliTarget ?? null;
    if (!place || !options.eventsOutputPath) return false;
    return kangenticMcpServer({
      url: options.mcpServerUrl,
      token: options.mcpServerToken,
      place,
      directory: path.dirname(options.eventsOutputPath),
    }).kind === 'stdio';
  }

  /**
   * True when the build writes the folder-shared `.gemini/settings.json`. The
   * adapter takes its session's hold on the file under the same test.
   */
  shouldWriteMergedSettings(options: GeminiCommandOptions): boolean {
    return Boolean(options.eventsOutputPath) || geminiMcpWiringEnabled(options);
  }

  /**
   * Hide the Kangentic-written runtime files from git for the untracked
   * case. `.gemini/settings.json` gets the created-by-us carve-out: a file
   * already present in the cwd may be the user's own, possibly destined for
   * a commit, so only a file Kangentic is about to create is excluded.
   * Ignore rules never affect tracked files, so a committed settings.json
   * keeps its normal git visibility either way.
   */
  private seedGitExcludes(options: GeminiCommandOptions): void {
    if (!this.shouldWriteMergedSettings(options)) return;
    const patterns = ['.kangentic/'];
    if (!fs.existsSync(path.join(options.cwd, '.gemini', 'settings.json'))) {
      patterns.push('.gemini/settings.json');
    }
    ensureLocalGitExcludes(options.cwd, patterns);
  }

  /**
   * Create a merged Gemini settings file that includes event-bridge hooks
   * and / or the Kangentic MCP server entry. Writes to
   * `.gemini/settings.json` in the cwd since Gemini CLI reads settings from
   * the project directory (no --settings flag available).
   *
   * Gemini has no --settings flag, so hooks live in a project-shared file.
   * Concurrent sessions in the same cwd are serialized by GeminiAdapter's
   * per-session holds: each spawn holds the file under its own session id,
   * and removeHooks() only strips it when the folder's last session
   * releases. The isKangenticHook() guard prevents affecting user-defined hooks. On crash
   * / force-quit, stripping on the next spawn (buildHooks) cleans up.
   *
   * MCP server entry: Gemini natively supports inline `mcpServers` in
   * settings.json. Verified against gemini 0.54.4 that the Gemini-fork
   * `httpUrl` key (not the Anthropic/fastmcp `url` used by Claude/Kimi)
   * plus a `headers` map connects to the in-process MCP HTTP server.
   * User-defined `mcpServers` are preserved via spread.
   *
   * The entry names the URL and the token as env references, which Gemini
   * expands from its own environment (task #859, measured on 0.64.0), and
   * `buildGeminiEnv` sets them per spawn. So the folder-shared file carries
   * no caller URL a later spawn could overwrite, and no token: both live only
   * in the session's environment. `removeHooks()` still strips the entry on
   * session exit / suspend, and an entry an app quit leaves behind names
   * variables, not a credential.
   */
  private createMergedSettings(options: GeminiCommandOptions): void {
    const projectRoot = options.projectRoot || options.cwd;
    const baseSettings = this.readBaseSettings(projectRoot);

    const merged: GeminiSettings = { ...baseSettings };
    const place = options.cliTarget ?? null;

    if (options.eventsOutputPath && place) {
      // A Gemini in a WSL distro may have no node, so its hooks publish through
      // the WSL hook transport (same events and directives), and the background
      // shell hint goes through its `reply`. The commands name the folder's
      // copy of the script, the same for every session sharing this file.
      const sessionHooks = prepareWslHookTransport(path.dirname(options.eventsOutputPath));
      const folderHooks = { ...sessionHooks, script: copyWslHookScriptInto(options.cwd, GEMINI_WSL_HOOK_COPY_NAME) };
      merged.hooks = buildHooks('', '', baseSettings.hooks || {}, {
        backgroundShellHintCommand: wslBackgroundShellHintCommandFor(options, GEMINI_BACKGROUND_COMMAND_SPEC, folderHooks, place),
        eventCommand: (eventType, ...directives) => wslHookEventCommand(folderHooks, place, eventType, ...directives),
      });
    } else if (options.eventsOutputPath) {
      const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
      // The file is shared by every session in the folder, so the hooks name
      // the events path from each session's own environment (the bridge's
      // `env:` sentinel), never one session's literal path.
      merged.hooks = buildHooks(eventBridge, EVENTS_PATH_FROM_ENVIRONMENT, baseSettings.hooks || {}, {
        backgroundShellHintCommand: backgroundShellHintCommandFor(
          options, GEMINI_BACKGROUND_COMMAND_SPEC, GEMINI_HOOK_SHELL, shippedHintBridgePath(),
        ),
      });
    }

    if (geminiMcpWiringEnabled(options)) {
      // Env references Gemini expands from its own process environment
      // (`resolveEnvVarsInString`, measured on 0.64.0: the MCP request arrived
      // at the value the spawn set), filled per session by `buildGeminiEnv`. So
      // two sessions in one folder each reach their own caller URL, and the
      // per-launch token never touches this file.
      merged.mcpServers = {
        ...(baseSettings.mcpServers ?? {}),
        kangentic: this.usesMcpBridge(options) ? GEMINI_BRIDGE_MCP_ENTRY : {
          httpUrl: `\${${KANGENTIC_MCP_URL_ENV}}`,
          headers: { 'X-Kangentic-Token': `\${${KANGENTIC_MCP_TOKEN_ENV}}` },
        },
      };
    }

    // Write merged settings into the cwd's .gemini/settings.json
    const geminiDir = path.join(options.cwd, '.gemini');
    try {
      fs.mkdirSync(geminiDir, { recursive: true });
    } catch (error) {
      console.error(`[gemini] Failed to create .gemini directory: ${geminiDir}`, error);
      return;
    }

    const settingsPath = path.join(geminiDir, 'settings.json');
    // sync-write-ok: this must throw, not degrade - this file carries the
    // event-bridge hooks and the kangentic MCP entry, so a swallowed failure
    // would spawn Gemini with no activity tracking (the session reads as
    // permanently idle) and no kangentic_* tools, with nothing to say why.
    // The spawn preamble already reports and notifies (notifySpawnBlocked) on
    // any throw from buildCommand.
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    const hookCount = Object.keys(merged.hooks || {}).length;
    const mcpCount = Object.keys(merged.mcpServers || {}).length;
    console.log(`[gemini] Wrote settings to ${settingsPath} (${hookCount} hook event types, ${mcpCount} mcp servers, events -> ${options.eventsOutputPath ?? 'none'})`);
  }
}

/**
 * Sanitize prompt text for shell quoting.
 * For double-quoted shells (PowerShell, cmd), replace double quotes with
 * single quotes. For single-quoted shells (bash, zsh), no replacement needed.
 */
function sanitizePrompt(prompt: string, shell?: string): string {
  const needsDoubleQuoteReplacement = shell
    ? !isUnixLikeShell(shell)
    : process.platform === 'win32';
  return needsDoubleQuoteReplacement
    ? prompt.replace(/"/g, "'")
    : prompt;
}
