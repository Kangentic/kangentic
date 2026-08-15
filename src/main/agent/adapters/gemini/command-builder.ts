import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { buildHooks } from './hook-manager';
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
}

export class GeminiCommandBuilder {
  /** Cache of merged base settings keyed by project root path. */
  private projectSettingsCache = new Map<string, GeminiSettings>();

  /** Clear the cached project settings. */
  clearSettingsCache(): void {
    this.projectSettingsCache.clear();
  }

  buildGeminiCommand(options: GeminiCommandOptions): string {
    const { shell } = options;
    const parts = [quoteArg(options.geminiPath, shell)];

    // Write merged settings with event-bridge hooks and / or the Kangentic
    // MCP server entry.
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

  /** Read and merge project settings, with per-projectRoot caching. */
  private readBaseSettings(projectRoot: string): GeminiSettings {
    const cached = this.projectSettingsCache.get(projectRoot);
    if (cached) return structuredClone(cached);

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

    this.projectSettingsCache.set(projectRoot, baseSettings);
    return structuredClone(baseSettings);
  }

  private shouldWriteMergedSettings(options: GeminiCommandOptions): boolean {
    return Boolean(options.eventsOutputPath) || geminiMcpWiringEnabled(options);
  }

  /**
   * Create a merged Gemini settings file that includes event-bridge hooks
   * and / or the Kangentic MCP server entry. Writes to
   * `.gemini/settings.json` in the cwd since Gemini CLI reads settings from
   * the project directory (no --settings flag available).
   *
   * Gemini has no --settings flag, so hooks live in a project-shared file.
   * Concurrent sessions in the same cwd are serialized by GeminiAdapter's
   * hook reference counter: each spawn retains one reference, and
   * removeHooks() only strips the file when the count drops to zero. The
   * isKangenticHook() guard prevents affecting user-defined hooks. On crash
   * / force-quit, stripping on the next spawn (buildHooks) cleans up.
   *
   * MCP server entry: Gemini natively supports inline `mcpServers` in
   * settings.json. Verified against gemini 0.54.4 that the Gemini-fork
   * `httpUrl` key (not the Anthropic/fastmcp `url` used by Claude/Kimi)
   * plus a `headers` map connects to the in-process MCP HTTP server. This
   * matches the sibling Qwen fork's wiring exactly. User-defined
   * `mcpServers` are preserved via spread.
   *
   * Security trade-off (identical to Qwen's): `.gemini/settings.json` is
   * project-shared and may be intentionally committed, so it cannot be
   * blanket-gitignored like `.kangentic/`. The injected token is therefore
   * plaintext on disk during the active session. Mitigations: tokens
   * rotate per app launch (see `mcp-http-server.ts`), and `removeHooks()`
   * strips the entry on session exit / suspend. Consequence: do not commit
   * `.gemini/settings.json` while a Kangentic-spawned Gemini session runs.
   *
   * That strip does NOT run on app quit: the synchronous shutdown path
   * disposes each session's PTY listeners before killing it, precisely so no
   * handler fires on a later tick, and `removeHooks` only runs from the exit
   * handler. What is left behind is a token whose server died with the app,
   * so the residue is a stale entry rather than a live credential.
   */
  private createMergedSettings(options: GeminiCommandOptions): void {
    const projectRoot = options.projectRoot || options.cwd;
    const baseSettings = this.readBaseSettings(projectRoot);

    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;
    const merged: GeminiSettings = { ...baseSettings };

    if (eventsPath) {
      const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
      merged.hooks = buildHooks(eventBridge, eventsPath, baseSettings.hooks || {});
    }

    if (geminiMcpWiringEnabled(options)) {
      merged.mcpServers = {
        ...(baseSettings.mcpServers ?? {}),
        kangentic: {
          httpUrl: options.mcpServerUrl,
          headers: { 'X-Kangentic-Token': options.mcpServerToken },
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
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    const hookCount = Object.keys(merged.hooks || {}).length;
    const mcpCount = Object.keys(merged.mcpServers || {}).length;
    console.log(`[gemini] Wrote settings to ${settingsPath} (${hookCount} hook event types, ${mcpCount} mcp servers, events -> ${eventsPath ?? 'none'})`);
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
