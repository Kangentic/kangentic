import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { buildGeminiEventHooks } from './hook-manager';
import type { GeminiHookEntry } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

/** Gemini-specific subset of settings.json that we read/write. */
interface GeminiSettings {
  hooks?: Record<string, GeminiHookEntry[]>;
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

    // Write merged settings with event-bridge hooks when we have output paths
    if (options.eventsOutputPath) {
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

    // Prompt delivery differs between interactive and non-interactive mode
    if (options.nonInteractive && options.prompt) {
      // Non-interactive: use -p flag
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push('-p', quoteArg(safePrompt, shell));
    } else if (options.prompt) {
      // Interactive: prompt as positional argument
      const safePrompt = sanitizePrompt(options.prompt, shell);
      parts.push(quoteArg(safePrompt, shell));
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
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      baseSettings = JSON.parse(raw);
    } catch {
      // No existing settings - start fresh
    }

    this.projectSettingsCache.set(projectRoot, baseSettings);
    return structuredClone(baseSettings);
  }

  /**
   * Create a merged Gemini settings file that includes event-bridge hooks.
   * Writes to `.gemini/settings.json` in the cwd since Gemini CLI reads
   * settings from the project directory (no --settings flag available).
   *
   * Known limitation: unlike Claude's --settings flag, Gemini has no way
   * to point to a per-session settings file. Writing directly to the cwd
   * means concurrent Gemini sessions in the same project race on this file,
   * and a crash may leave hooks in the user's settings. stripHooks() cleans
   * up on normal shutdown; the isKangenticHook() guard prevents affecting
   * user-defined hooks.
   */
  private createMergedSettings(options: GeminiCommandOptions): void {
    const projectRoot = options.projectRoot || options.cwd;
    const baseSettings = this.readBaseSettings(projectRoot);

    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;
    if (!eventsPath) return;

    const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
    const merged: GeminiSettings = {
      ...baseSettings,
      hooks: buildGeminiEventHooks(eventBridge, eventsPath, baseSettings.hooks || {}),
    };

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
    console.log(`[gemini] Wrote hooks to ${settingsPath} (${Object.keys(merged.hooks || {}).length} event types, events -> ${eventsPath})`);
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
