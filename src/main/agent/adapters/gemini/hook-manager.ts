import path from 'node:path';
import { AgentTool, EventType, IdleReason } from '../../../../shared/types';
import { filterKangenticHooks, buildBridgeCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';
import { extractTool, extractDetail, setToolWhen, emitOnlyWhenDetailMatches, setDetail } from '../../shared/directive-builders';

/** Hook entry in Gemini CLI's settings.json. */
export interface GeminiHookEntry {
  matcher: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/**
 * Gemini CLI hook event names (settings.json keys).
 */
export const GeminiHookEvent = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  BeforeAgent: 'BeforeAgent',
  AfterAgent: 'AfterAgent',
  BeforeModel: 'BeforeModel',
  AfterModel: 'AfterModel',
  BeforeToolSelection: 'BeforeToolSelection',
  BeforeTool: 'BeforeTool',
  AfterTool: 'AfterTool',
  PreCompress: 'PreCompress',
  Notification: 'Notification',
} as const;
export type GeminiHookEvent = (typeof GeminiHookEvent)[keyof typeof GeminiHookEvent];

/** Gemini CLI's plan exit tool, the one that raises its plan approval dialog. */
const GEMINI_PLAN_EXIT_TOOL = 'exit_plan_mode';

/** The `notification_type` of the Notification Gemini sends for a tool confirmation dialog. */
const GEMINI_TOOL_PERMISSION_NOTIFICATION = 'ToolPermission';

/**
 * Reports Gemini's plan exit as Kangentic's (`AgentTool.ExitPlanMode`) only for
 * an approved plan, so the card moves to the column's After Plan Mode target as
 * Claude's does. Measured on Gemini CLI 0.63.0 (task 840): `exit_plan_mode`
 * fires AfterTool for a rejected plan too, and only `tool_response.llmContent`
 * tells them apart: "Plan approved. Switching to Auto-Edit mode ..." against
 * "Plan rejected. User feedback: ...".
 */
const APPROVED_PLAN_EXIT = setToolWhen({
  whenTool: GEMINI_PLAN_EXIT_TOOL,
  nested: ['tool_response', 'llmContent'],
  startsWith: 'Plan approved.',
  to: AgentTool.ExitPlanMode,
});

/** Filter out Kangentic-injected entries, keeping only user-defined hooks. */
function filterOurHooks(entries: GeminiHookEntry[] | undefined): GeminiHookEntry[] {
  return filterKangenticHooks(entries, (entry: GeminiHookEntry) => entry.hooks?.map((hook) => hook.command) ?? []);
}

/** Build a single Gemini hook entry for the event bridge. */
function bridgeEntry(eventBridge: string, eventsPath: string, eventType: string, ...directives: string[]): GeminiHookEntry {
  return {
    matcher: '*',
    hooks: [{
      name: `kangentic-${eventType}`,
      type: 'command',
      command: buildBridgeCommand(eventBridge, eventsPath, eventType, ...directives),
    }],
  };
}

/**
 * Build event-bridge hook entries to merge into Gemini CLI settings.
 * Maps available Gemini hook events to our event-bridge script.
 *
 * Strips any stale Kangentic hooks from existingHooks before injecting
 * fresh ones. Gemini has no --settings flag, so hooks live in the shared
 * project-level .gemini/settings.json. Normal cleanup runs via
 * removeHooks() on session exit/suspend, but if the app was killed
 * (force quit, crash, taskkill), those callbacks never fire and orphan
 * hooks would accumulate. Stripping here ensures each spawn starts with
 * exactly one set of Kangentic hooks regardless of how the previous
 * session ended.
 */
export function buildHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, GeminiHookEntry[]>,
): Record<string, GeminiHookEntry[]> {
  // Gemini CLI stdin field extraction directives:
  // - tool_name: tool identifier at top level
  // - tool_input: nested object with file_path, content, etc.
  // - message: notification text
  const H = GeminiHookEvent;
  const E = EventType;
  return {
    ...existingHooks,
    [H.BeforeTool]: [
      ...filterOurHooks(existingHooks[H.BeforeTool]),
      bridgeEntry(eventBridge, eventsPath, E.ToolStart,
        extractTool('tool_name'), extractDetail(['file_path', 'command', 'query'], { nested: 'tool_input' })),
    ],
    [H.AfterTool]: [
      ...filterOurHooks(existingHooks[H.AfterTool]),
      bridgeEntry(eventBridge, eventsPath, E.ToolEnd, extractTool('tool_name'), APPROVED_PLAN_EXIT),
    ],
    [H.SessionStart]: [
      ...filterOurHooks(existingHooks[H.SessionStart]),
      bridgeEntry(eventBridge, eventsPath, E.SessionStart),
    ],
    [H.SessionEnd]: [
      ...filterOurHooks(existingHooks[H.SessionEnd]),
      bridgeEntry(eventBridge, eventsPath, E.SessionEnd),
    ],
    [H.AfterAgent]: [
      ...filterOurHooks(existingHooks[H.AfterAgent]),
      bridgeEntry(eventBridge, eventsPath, E.Idle),
    ],
    [H.BeforeAgent]: [
      ...filterOurHooks(existingHooks[H.BeforeAgent]),
      bridgeEntry(eventBridge, eventsPath, E.Prompt),
    ],
    [H.Notification]: [
      ...filterOurHooks(existingHooks[H.Notification]),
      bridgeEntry(eventBridge, eventsPath, E.Notification, extractDetail(['message', 'notification'])),
      // A tool confirmation dialog (the plan prompt included) is a permission
      // wait, so the card shows the session needs you. Gemini 0.63.0 has no
      // permission hook: it reports each dialog as a Notification whose
      // `notification_type` is "ToolPermission" (`fireToolNotificationEvent`),
      // and the AfterTool that follows the answer clears it.
      bridgeEntry(eventBridge, eventsPath, E.Idle,
        extractDetail(['notification_type']),
        emitOnlyWhenDetailMatches(`^${GEMINI_TOOL_PERMISSION_NOTIFICATION}$`),
        setDetail(IdleReason.Permission)),
    ],
    [H.PreCompress]: [
      ...filterOurHooks(existingHooks[H.PreCompress]),
      bridgeEntry(eventBridge, eventsPath, E.Compact),
    ],
    [H.BeforeModel]: [
      ...filterOurHooks(existingHooks[H.BeforeModel]),
      bridgeEntry(eventBridge, eventsPath, E.ModelStart, extractDetail(['model'], { nested: 'llm_request' })),
    ],
    [H.AfterModel]: [
      ...filterOurHooks(existingHooks[H.AfterModel]),
      bridgeEntry(eventBridge, eventsPath, E.ModelEnd, extractDetail(['model'], { nested: 'llm_request' })),
    ],
    [H.BeforeToolSelection]: [
      ...filterOurHooks(existingHooks[H.BeforeToolSelection]),
      bridgeEntry(eventBridge, eventsPath, E.ToolSelectionStart),
    ],
  };
}

/**
 * Return the path to `.gemini/settings.json` for the given directory.
 */
function geminiSettingsPath(directory: string): string {
  return path.join(directory, '.gemini', 'settings.json');
}

/**
 * Remove ALL Kangentic hook entries AND the Kangentic MCP server entry from
 * `.gemini/settings.json` at the given directory. Preserves all other user
 * hooks, MCP servers, and settings.
 *
 * Called on session exit/suspend to clean up what buildHooks() and the
 * command builder injected. Gemini has no --settings flag, so both live in
 * the shared project-level file and must be explicitly removed when the
 * session ends. Removing the MCP entry matters beyond tidiness: it carries
 * the per-launch token in plaintext, so leaving it behind would strand a
 * credential in a file users may commit.
 */
export function removeHooks(directory: string): void {
  safelyUpdateSettingsFile(geminiSettingsPath(directory), (parsed) => {
    const settings = parsed as {
      hooks?: Record<string, GeminiHookEntry[]>;
      mcpServers?: Record<string, unknown>;
    };
    if (!settings || typeof settings !== 'object') return null;

    let changed = false;

    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const key of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[key])) continue;
        const before = settings.hooks[key].length;
        settings.hooks[key] = filterOurHooks(settings.hooks[key]);
        if (settings.hooks[key].length !== before) changed = true;
        if (settings.hooks[key].length === 0) delete settings.hooks[key];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (
      settings.mcpServers
      && typeof settings.mcpServers === 'object'
      && 'kangentic' in settings.mcpServers
    ) {
      delete settings.mcpServers.kangentic;
      changed = true;
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    }

    if (!changed) return null;
    return settings;
  }, 'removeHooks');
}
