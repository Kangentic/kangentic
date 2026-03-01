import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash, quoteArg } from '../../shared/paths';
import type { PermissionMode, Task } from '../../shared/types';

/** Hook entry in Claude Code's settings.json. */
interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

/** Subset of Claude Code settings.json that we read/write. */
interface ClaudeSettings {
  statusLine?: { type: string; command: string };
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown; // preserve unknown keys from user's settings
}

interface CommandOptions {
  claudePath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string; // main repo root (for worktree settings resolution)
  sessionId?: string;
  resume?: boolean; // true = --resume (existing session), false = --session-id (new session)
  nonInteractive?: boolean;
  statusOutputPath?: string; // path where the status bridge writes JSON
  activityOutputPath?: string; // path where the activity bridge writes JSON
  eventsOutputPath?: string; // path where the event bridge appends JSONL
}

/**
 * Replace `{{key}}` placeholders in a template string with values from `vars`.
 */
export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Merge hook arrays per event type. Local hooks come after project hooks;
 * Kangentic hooks are appended last by the caller.
 */
function mergeHookArrays(
  base: Record<string, ClaudeHookEntry[]> | undefined,
  overlay: Record<string, ClaudeHookEntry[]> | undefined,
): Record<string, ClaudeHookEntry[]> {
  if (!base && !overlay) return {};
  if (!base) return { ...overlay! };
  if (!overlay) return { ...base };

  const merged: Record<string, ClaudeHookEntry[]> = { ...base };
  for (const [event, entries] of Object.entries(overlay)) {
    merged[event] = [...(merged[event] || []), ...entries];
  }
  return merged;
}

export class CommandBuilder {
  buildClaudeCommand(options: CommandOptions): string {
    const parts = [quoteArg(options.claudePath)];

    // Build the --settings path. When statusOutputPath is provided we always
    // create a merged settings file that includes the statusLine config so
    // Claude Code pipes usage data to our bridge script.
    const mergedSettingsPath = options.statusOutputPath
      ? this.createMergedSettings(options)
      : null;

    // Permission mode flags
    switch (options.permissionMode) {
      case 'bypass-permissions':
        parts.push('--dangerously-skip-permissions');
        // Still pass merged settings for the status line even with skip-permissions
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        }
        break;
      case 'default':
        // When running from a worktree, Claude resolves settings from CWD,
        // not the git root. Explicitly pass --settings for the main project.
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        } else {
          const settingsArg = this.getProjectSettingsArg(options);
          if (settingsArg) parts.push('--settings', quoteArg(settingsArg));
        }
        break;
      case 'plan':
        parts.push('--permission-mode', 'plan');
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        }
        break;
      case 'acceptEdits':
        parts.push('--permission-mode', 'acceptEdits');
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        }
        break;
      case 'manual':
        // No permission flags, but still pass merged settings for status line
        if (mergedSettingsPath) {
          parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath)));
        }
        break;
    }

    // Session: --resume for existing conversations, --session-id for new ones
    if (options.sessionId) {
      const flag = options.resume ? '--resume' : '--session-id';
      parts.push(flag, quoteArg(options.sessionId));
    }

    // Non-interactive mode (print and exit) vs interactive
    if (options.nonInteractive) {
      parts.push('--print');
    }

    // The prompt as positional argument (omitted for resumed sessions)
    if (options.prompt) {
      parts.push(quoteArg(options.prompt));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, vars: Record<string, string>): string {
    return interpolateTemplate(template, vars);
  }

  /**
   * Get the project settings path for worktree scenarios (no status bridge).
   */
  private getProjectSettingsArg(options: CommandOptions): string | null {
    if (options.projectRoot && options.cwd !== options.projectRoot) {
      return toForwardSlash(path.join(options.projectRoot, '.claude', 'settings.json'));
    }
    return null;
  }

  /**
   * Create a merged Claude settings file that includes the statusLine config
   * pointing to our bridge script. Reads the project's existing settings.json
   * (if any) and deep-merges the statusLine key.
   *
   * Returns the absolute path to the merged settings file.
   */
  private createMergedSettings(options: CommandOptions): string {
    const projectRoot = options.projectRoot || options.cwd;

    // Read existing project settings (committed, shared)
    let existingSettings: ClaudeSettings = {};
    const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      existingSettings = JSON.parse(raw);
    } catch {
      // No existing settings — start fresh
    }

    // Also read local settings (gitignored, personal).
    // Local overrides project, matching Claude's own precedence.
    const localSettingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    try {
      const raw = fs.readFileSync(localSettingsPath, 'utf-8');
      const localSettings: ClaudeSettings = JSON.parse(raw);
      const { hooks: localHooks, ...localRest } = localSettings;
      existingSettings = {
        ...existingSettings,
        ...localRest,
        hooks: mergeHookArrays(existingSettings.hooks, localHooks),
      };
    } catch {
      // No local settings
    }

    // Build the bridge command. In production, status-bridge.js is copied
    // next to the main bundle by scripts/build.js. In dev (Forge Vite plugin),
    // __dirname is .vite/build/ so we fall back to the source tree.
    const candidates = [
      path.join(__dirname, 'status-bridge.js'),                                   // production build
      path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', 'status-bridge.js'), // Forge dev (.vite/build/ → project root)
      path.resolve(process.cwd(), 'src', 'main', 'agent', 'status-bridge.js'),   // fallback from CWD
    ];
    const bridgeScript = candidates.find(p => fs.existsSync(p)) || candidates[0];
    const bridgePath = toForwardSlash(bridgeScript);
    const statusPath = toForwardSlash(options.statusOutputPath!);

    // Resolve activity bridge (same candidate pattern as status bridge)
    const activityCandidates = [
      path.join(__dirname, 'activity-bridge.js'),
      path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', 'activity-bridge.js'),
      path.resolve(process.cwd(), 'src', 'main', 'agent', 'activity-bridge.js'),
    ];
    const activityBridge = toForwardSlash(activityCandidates.find(p => fs.existsSync(p)) || activityCandidates[0]);
    const activityPath = options.activityOutputPath ? toForwardSlash(options.activityOutputPath) : null;

    const merged: ClaudeSettings = {
      ...existingSettings,
      statusLine: {
        type: 'command',
        command: `node "${bridgePath}" "${statusPath}"`,
      },
    };

    // Resolve event bridge (same candidate pattern as status/activity bridge)
    const eventCandidates = [
      path.join(__dirname, 'event-bridge.js'),
      path.resolve(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js'),
      path.resolve(process.cwd(), 'src', 'main', 'agent', 'event-bridge.js'),
    ];
    const eventBridge = toForwardSlash(eventCandidates.find(p => fs.existsSync(p)) || eventCandidates[0]);
    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;

    // Deep-merge hooks for activity tracking + event logging (preserve existing user hooks)
    if (activityPath || eventsPath) {
      const existingHooks = existingSettings.hooks || {};
      merged.hooks = { ...existingHooks };

      if (activityPath) {
        merged.hooks.PreToolUse = [
          ...(existingHooks.PreToolUse || []),
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
        ];
        merged.hooks.UserPromptSubmit = [
          ...(existingHooks.UserPromptSubmit || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" thinking` }] },
        ];
        merged.hooks.Stop = [
          ...(existingHooks.Stop || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
        ];
        merged.hooks.PermissionRequest = [
          ...(existingHooks.PermissionRequest || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
        ];
      }

      if (eventsPath) {
        // Append event-bridge hooks for all four hook points
        merged.hooks.PreToolUse = [
          ...(merged.hooks.PreToolUse || existingHooks.PreToolUse || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" tool_start` }] },
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" idle` }] },
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" idle` }] },
        ];
        merged.hooks.PostToolUse = [
          ...(merged.hooks.PostToolUse || existingHooks.PostToolUse || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" tool_end` }] },
        ];
        merged.hooks.UserPromptSubmit = [
          ...(merged.hooks.UserPromptSubmit || existingHooks.UserPromptSubmit || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" prompt` }] },
        ];
        merged.hooks.Stop = [
          ...(merged.hooks.Stop || existingHooks.Stop || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" idle` }] },
        ];
        merged.hooks.PermissionRequest = [
          ...(merged.hooks.PermissionRequest || existingHooks.PermissionRequest || []),
          { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" idle` }] },
        ];
      }
    }

    // Write to .kangentic/sessions/<sessionId>/settings.json
    const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', options.sessionId || options.taskId);
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create session directory: ${sessionDir}`, err);
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
    }
    const mergedPath = path.join(sessionDir, 'settings.json');
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

    return mergedPath;
  }
}
