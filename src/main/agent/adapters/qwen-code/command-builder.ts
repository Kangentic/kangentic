import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { buildHooks } from './hook-manager';
import type { QwenHookEntry } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

/** Qwen-specific subset of settings.json that we read/write. */
interface QwenSettings {
  hooks?: Record<string, QwenHookEntry[]>;
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
}

export class QwenCommandBuilder {
  /** Cache of merged base settings keyed by project root path. */
  private projectSettingsCache = new Map<string, QwenSettings>();

  /** Clear the cached project settings. */
  clearSettingsCache(): void {
    this.projectSettingsCache.clear();
  }

  buildQwenCommand(options: QwenCommandOptions): string {
    const { shell } = options;
    const parts = [quoteArg(options.qwenPath, shell)];

    // Write merged settings with event-bridge hooks when we have output paths
    if (options.eventsOutputPath) {
      this.createMergedSettings(options);
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

    // Prompt delivery differs between interactive and non-interactive mode.
    // Qwen Code's yargs validation rejects combining a positional prompt
    // with --prompt/-p, so we pick exactly one based on nonInteractive.
    if (options.nonInteractive && options.prompt) {
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push('-p', quoteArg(safePrompt, shell));
    } else if (options.prompt) {
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push(quoteArg(safePrompt, shell));
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
   * Create a merged Qwen settings file that includes event-bridge hooks.
   * Writes to `.qwen/settings.json` in the cwd since Qwen Code reads
   * settings from the project directory (no --settings flag available).
   *
   * Qwen Code (like Gemini) has no --settings flag, so hooks live in a
   * project-shared file. Concurrent sessions in the same cwd are
   * serialized by QwenAdapter's hook reference counter: each spawn
   * retains one reference, and removeHooks() only strips the file when
   * the count drops to zero. The isKangenticHook() guard prevents
   * affecting user-defined hooks. On crash / force-quit, stripping on
   * the next spawn (buildHooks) cleans up.
   */
  private createMergedSettings(options: QwenCommandOptions): void {
    const projectRoot = options.projectRoot || options.cwd;
    const baseSettings = this.readBaseSettings(projectRoot);

    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;
    if (!eventsPath) return;

    const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
    const merged: QwenSettings = {
      ...baseSettings,
      hooks: buildHooks(eventBridge, eventsPath, baseSettings.hooks || {}),
    };

    // Write merged settings into the cwd's .qwen/settings.json
    const qwenDir = path.join(options.cwd, '.qwen');
    try {
      fs.mkdirSync(qwenDir, { recursive: true });
    } catch (error) {
      console.error(`[qwen] Failed to create .qwen directory: ${qwenDir}`, error);
      return;
    }

    const settingsPath = path.join(qwenDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    console.log(`[qwen] Wrote hooks to ${settingsPath} (${Object.keys(merged.hooks || {}).length} event types, events -> ${eventsPath})`);
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
