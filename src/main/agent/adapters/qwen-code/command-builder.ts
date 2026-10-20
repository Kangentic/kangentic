import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { copyBridgeInto } from '../../shared/workspace-bridge-copy';
import { EVENTS_PATH_FROM_ENVIRONMENT } from '../../shared/hook-utils';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { backgroundShellHintCommandFor, offersMarkBackgroundService, shippedHintBridgePath } from '../../shared/background-command-hooks';
import {
  buildHooks,
  QWEN_BACKGROUND_COMMAND_SPEC,
  QWEN_BRIDGE_COPY_NAME,
  QWEN_HINT_BRIDGE_COPY_NAME,
  QWEN_HOOK_SHELL,
} from './hook-manager';
import type { QwenHookEntry } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

/** Qwen-specific subset of settings.json that we read/write. */
interface QwenSettings {
  hooks?: Record<string, QwenHookEntry[]>;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QwenCommandOptions {
  qwenPath: string;
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
   * The detected `qwen --version`, or null when detection has not run. Only
   * picks how Kangentic's MCP server is delivered (see `supportsMcpConfigFlag`).
   */
  cliVersion?: string | null;
}

/**
 * How a spawn hands Qwen Kangentic's MCP server.
 *
 * - `'flag'`: `--mcp-config <sessionDir>/mcp.json`.
 * - `'settings'`: an `mcpServers.kangentic` entry in the folder's
 *   `.qwen/settings.json`, for a Qwen too old to have the flag.
 * - `'none'`: no server (switched off, or no URL or token).
 */
type QwenMcpDelivery = 'flag' | 'settings' | 'none';

/**
 * The first Qwen Code minor release with `--mcp-config`: the option is absent
 * from v0.15.3's `packages/cli/src/config/config.ts` and present in v0.16.0's.
 * Qwen's top-level yargs is `.strict()`, so an older CLI exits on the unknown
 * flag instead of ignoring it.
 */
const MCP_CONFIG_FLAG_MIN_MINOR = 16;

/**
 * True when this Qwen takes `--mcp-config`. An unknown or unparsable version
 * takes the flag: every Qwen with the workspace MCP approval gate (0.20 and
 * later) has it, and the settings fallback is what that gate stops on.
 */
export function supportsMcpConfigFlag(cliVersion: string | null | undefined): boolean {
  const match = cliVersion ? /^v?(\d+)\.(\d+)/.exec(cliVersion.trim()) : null;
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= MCP_CONFIG_FLAG_MIN_MINOR;
}

/** Kangentic's own server entry, in Qwen's native shape (`httpUrl` is streamable HTTP). */
function kangenticServerEntry(url: string, token: string): { httpUrl: string; headers: Record<string, string> } {
  return { httpUrl: url, headers: { 'X-Kangentic-Token': token } };
}

/**
 * The user's own servers: `mcpServers` with any `kangentic` entry removed. An
 * older Kangentic wrote that entry into `.qwen/settings.json`, and a crash
 * before `removeHooks` leaves it in the baseline with a dead token. Returns the
 * object unchanged when it has no such entry, and undefined when removing it
 * leaves nothing.
 */
function withoutKangenticEntry(servers: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, 'kangentic')) return servers;
  const userServers = { ...servers };
  delete userServers.kangentic;
  return Object.keys(userServers).length > 0 ? userServers : undefined;
}

export class QwenCommandBuilder {
  /**
   * Cache of merged base settings keyed by project root path.
   *
   * Cached intentionally so that re-spawns do not re-ingest the
   * Kangentic-injected `hooks` and `mcpServers.kangentic` entries we
   * wrote on the prior spawn. Each spawn re-merges fresh entries on top
   * of the original user baseline. Call `clearSettingsCache()` if the
   * user edits `.qwen/settings.json` between spawns.
   */
  private projectSettingsCache = new Map<string, QwenSettings>();

  /** Clear the cached project settings. */
  clearSettingsCache(): void {
    this.projectSettingsCache.clear();
  }

  buildQwenCommand(options: QwenCommandOptions): string {
    const { shell } = options;
    const parts = [quoteArg(options.qwenPath, shell)];
    const mcpDelivery = this.mcpDelivery(options);
    const writesSettings = this.shouldWriteMergedSettings(options);

    // Seed .git/info/exclude BEFORE any write so the settings.json
    // pre-existence check reflects the user's file, not ours: the merged
    // file otherwise sits untracked in the worktree for the whole session,
    // polluting git status and riding along with any `git add -A` an agent
    // runs.
    this.seedGitExcludes(options, mcpDelivery, writesSettings);
    if (writesSettings) {
      this.createMergedSettings(options, mcpDelivery);
    }

    // Permission mode mapping to Qwen Code --approval-mode flags.
    // Qwen Code choices (verified against packages/cli/src/config/config.ts):
    //   'plan' | 'default' | 'auto-edit' | 'yolo'
    //
    // Note the HYPHEN in 'auto-edit' - this is the canonical fork delta
    // from gemini-cli (which uses 'auto_edit' with an underscore).
    switch (options.permissionMode) {
      case 'plan':
      case 'dontAsk':
        parts.push('--approval-mode', 'plan');
        break;
      case 'acceptEdits':
      case 'auto':
        parts.push('--approval-mode', 'auto-edit');
        break;
      case 'bypassPermissions':
        parts.push('--approval-mode', 'yolo');
        break;
      case 'default':
      default:
        // 'default' is Qwen's default - no flag needed
        break;
    }

    // Session: --resume for existing conversations, --session-id for
    // new ones. Qwen Code's yargs validates these as mutex with
    // --continue, so we never combine them. Caller-owned IDs eliminate
    // the filesystem-polling capture path Gemini still needs.
    if (options.sessionId) {
      const flag = options.resume ? '--resume' : '--session-id';
      parts.push(flag, quoteArg(options.sessionId, shell));
    }

    // Per-column model override
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    // Kangentic's MCP server, on a fresh start and on a resume alike. A file
    // path, never inline JSON, so the token stays out of the command line.
    if (mcpDelivery === 'flag') {
      const mcpConfigPath = this.writeMcpConfigFile(options);
      if (mcpConfigPath) {
        parts.push('--mcp-config', quoteArg(toForwardSlash(mcpConfigPath), shell));
      }
    }

    // Prompt delivery: Qwen Code requires an explicit flag for prompts.
    // A bare positional argument is treated as headless / one-shot
    // (equivalent to -p) and exits after printing a single response, so
    // we never use one. Use -p for non-interactive and -i
    // (--prompt-interactive) to launch the TUI with the prompt
    // pre-loaded.
    if (options.prompt) {
      const safePrompt = sanitizePrompt(options.prompt, shell);
      const flag = options.nonInteractive ? '-p' : '-i';
      parts.push(flag, quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /** Read and merge project settings, with per-projectRoot caching. */
  private readBaseSettings(projectRoot: string): QwenSettings {
    const cached = this.projectSettingsCache.get(projectRoot);
    if (cached) return structuredClone(cached);

    let baseSettings: QwenSettings = {};
    const projectSettingsPath = path.join(projectRoot, '.qwen', 'settings.json');
    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      baseSettings = JSON.parse(raw);
    } catch {
      // No existing settings - start fresh
    }

    this.projectSettingsCache.set(projectRoot, baseSettings);
    return structuredClone(baseSettings);
  }

  /**
   * True when the build writes the folder-shared `.qwen/settings.json`: for
   * the event-bridge hooks, or for the MCP entry on a Qwen without
   * `--mcp-config`. The adapter takes its session's hold on the file under
   * the same test.
   */
  shouldWriteMergedSettings(options: QwenCommandOptions): boolean {
    if (options.eventsOutputPath) return true;
    return this.mcpDelivery(options) === 'settings';
  }

  /**
   * How this spawn delivers Kangentic's MCP server.
   *
   * The flag is the default because of Qwen's workspace MCP approval gate
   * (0.20 and later). Qwen tags a server from the folder's
   * `.qwen/settings.json` with scope `workspace` (and one from `.mcp.json`
   * with `project`), and `useMcpApproval` holds every server of those two
   * scopes behind an "Untrusted MCP server" dialog until
   * `~/.qwen/mcpApprovals.json` records an approval for that folder, name,
   * and a hash of the server's exact config. Kangentic's URL and token change
   * every spawn, so an approval never matched and every board session waited
   * on the dialog. A `--mcp-config` server carries no scope, so the gate
   * never sees it, and the CLI tier is merged last, so it also replaces a
   * same-named entry a settings file still holds. The user's own servers
   * keep their gate.
   */
  private mcpDelivery(options: QwenCommandOptions): QwenMcpDelivery {
    if (options.mcpServerEnabled === false || !options.mcpServerUrl || !options.mcpServerToken) {
      return 'none';
    }
    return supportsMcpConfigFlag(options.cliVersion) ? 'flag' : 'settings';
  }

  /**
   * Write the session's `mcp.json` beside its status and events files and
   * return its path, or null (logged) when the build has no session directory,
   * which every production spawn path supplies.
   */
  private writeMcpConfigFile(options: QwenCommandOptions): string | null {
    const sessionFile = options.statusOutputPath ?? options.eventsOutputPath;
    if (!sessionFile || !options.mcpServerUrl || !options.mcpServerToken) {
      console.warn('[qwen] MCP server enabled but no session directory to write mcp.json into - skipping MCP wiring');
      return null;
    }
    const sessionDir = path.dirname(sessionFile);
    // sync-write-ok: this must throw, not degrade - the file below is named by
    // --mcp-config, and Qwen exits with a FatalConfigError when that path does
    // not exist. The spawn preamble already reports and notifies
    // (notifySpawnBlocked) on any throw from buildCommand.
    fs.mkdirSync(sessionDir, { recursive: true });
    const mcpConfigPath = path.join(sessionDir, 'mcp.json');
    const mcpConfig = {
      mcpServers: { kangentic: kangenticServerEntry(options.mcpServerUrl, options.mcpServerToken) },
    };
    // sync-write-ok: same reason as the mkdir above.
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    return mcpConfigPath;
  }

  /**
   * Hide the Kangentic-written runtime files from git for the untracked
   * case. `.qwen/settings.json` gets the created-by-us carve-out: a file
   * already present in the cwd may be the user's own, possibly destined for
   * a commit, so only a file Kangentic is about to create is excluded.
   * Ignore rules never affect tracked files, so a committed settings.json
   * keeps its normal git visibility either way.
   */
  private seedGitExcludes(options: QwenCommandOptions, mcpDelivery: QwenMcpDelivery, writesSettings: boolean): void {
    if (!writesSettings && mcpDelivery !== 'flag') return;
    const patterns = ['.kangentic/'];
    if (writesSettings && !fs.existsSync(path.join(options.cwd, '.qwen', 'settings.json'))) {
      patterns.push('.qwen/settings.json');
    }
    ensureLocalGitExcludes(options.cwd, patterns);
  }

  /**
   * Create a merged Qwen settings file that includes the event-bridge hooks
   * (and, on a Qwen without `--mcp-config`, the Kangentic MCP server entry).
   * Writes to `.qwen/settings.json` in the cwd since Qwen Code reads settings
   * from the project directory (no --settings flag available).
   *
   * Qwen Code (like Gemini) has no --settings flag, so hooks live in a
   * project-shared file. Concurrent sessions in the same cwd are
   * serialized by QwenAdapter's per-session holds: each spawn holds the
   * file under its own session id, and removeHooks() only strips it when
   * the folder's last session releases. The isKangenticHook() guard prevents
   * affecting user-defined hooks. On crash / force-quit, stripping on
   * the next spawn (buildHooks) cleans up.
   *
   * MCP server entry: a current Qwen gets Kangentic's server through
   * `--mcp-config` (see `mcpDelivery`), so this file carries no `kangentic`
   * entry, and a stale one an older build or a crash left in the baseline is
   * dropped. Only a Qwen before 0.16 gets the entry here, in the Gemini-fork
   * `httpUrl` shape with the per-launch token in the `X-Kangentic-Token`
   * header. That copy is plaintext in a file users may commit, so
   * `removeHooks()` strips it on session exit / suspend. User-defined
   * `mcpServers` are preserved either way.
   */
  private createMergedSettings(options: QwenCommandOptions, mcpDelivery: QwenMcpDelivery): void {
    const projectRoot = options.projectRoot || options.cwd;
    const baseSettings = this.readBaseSettings(projectRoot);

    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;
    const merged: QwenSettings = { ...baseSettings };

    if (eventsPath) {
      // On Windows a hook command reaches node through an escaped cmd line, and
      // no quoted path survives that (QWEN_HOOK_SHELL). The command then names
      // a copy of the bridge relative to the cwd Qwen runs hooks in, and the
      // events path the bridge reads from the session's environment. A failed
      // copy throws, as the settings write below does, to the same caller.
      let eventBridge: string;
      let eventsToken: string;
      if (process.platform === 'win32') {
        const bridgeCopy = copyBridgeInto(options.cwd, 'event-bridge', QWEN_BRIDGE_COPY_NAME);
        eventBridge = toForwardSlash(path.relative(options.cwd, bridgeCopy));
        eventsToken = EVENTS_PATH_FROM_ENVIRONMENT;
      } else {
        eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
        eventsToken = eventsPath;
      }
      // The hint names kangentic_mark_background_service, so only a session
      // offered that tool gets it. On Windows it runs from a workspace copy for
      // the same bare-token reason as the event bridge.
      let backgroundShellHintCommand: string | null = null;
      if (offersMarkBackgroundService(options)) {
        const hintBridge = process.platform === 'win32'
          ? toForwardSlash(path.relative(options.cwd, copyBridgeInto(options.cwd, 'background-shell-hint-bridge', QWEN_HINT_BRIDGE_COPY_NAME)))
          : shippedHintBridgePath();
        backgroundShellHintCommand = backgroundShellHintCommandFor(options, QWEN_BACKGROUND_COMMAND_SPEC, QWEN_HOOK_SHELL, hintBridge);
      }
      merged.hooks = buildHooks(eventBridge, eventsToken, baseSettings.hooks || {}, { backgroundShellHintCommand });
    }

    const userMcpServers = withoutKangenticEntry(baseSettings.mcpServers);
    if (mcpDelivery === 'settings' && options.mcpServerUrl && options.mcpServerToken) {
      merged.mcpServers = {
        ...(userMcpServers ?? {}),
        kangentic: kangenticServerEntry(options.mcpServerUrl, options.mcpServerToken),
      };
    } else if (userMcpServers) {
      merged.mcpServers = userMcpServers;
    } else {
      delete merged.mcpServers;
    }

    // Write merged settings into the cwd's .qwen/settings.json
    const qwenDir = path.join(options.cwd, '.qwen');
    try {
      fs.mkdirSync(qwenDir, { recursive: true });
    } catch (error) {
      console.error(`[qwen] Failed to create .qwen directory: ${qwenDir}`, error);
      return;
    }

    const settingsPath = path.join(qwenDir, 'settings.json');
    // sync-write-ok: this must throw, not degrade - this file carries the
    // event-bridge hooks and the kangentic MCP entry, so a swallowed failure
    // would spawn Qwen with no activity tracking (the session reads as
    // permanently idle) and no kangentic_* tools, with nothing to say why.
    // The spawn preamble already reports and notifies (notifySpawnBlocked) on
    // any throw from buildCommand.
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    const hookCount = Object.keys(merged.hooks || {}).length;
    const mcpCount = Object.keys(merged.mcpServers || {}).length;
    console.log(`[qwen] Wrote settings to ${settingsPath} (${hookCount} hook event types, ${mcpCount} mcp servers, events -> ${eventsPath ?? 'none'})`);
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
