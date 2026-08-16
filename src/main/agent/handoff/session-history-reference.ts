/**
 * Build a prompt that points the receiving agent to the source agent's
 * native session history file. This replaces the old handoff-context.md
 * generation pipeline - instead of manufacturing a synthetic document,
 * we pass the real file path and let the agent read it directly.
 *
 * Named "session history reference" (not "handoff prompt") to leave room
 * for a future `buildHandoffPlan` that would ask the outgoing agent to
 * author its own handoff summary.
 */

import { buildHandoffXml } from '../shared';

export interface SessionHistoryReferenceOptions {
  /** Agent identifier that previously worked on the task (e.g. 'claude', 'codex'). */
  sourceAgent: string;
  /** Absolute path to the source agent's native session history file, or null if unavailable. */
  sessionFilePath: string | null;
  /** Whether the target agent has MCP access (currently only Claude). */
  targetHasMcpAccess: boolean;
}

/**
 * Build a prompt reference to the source agent's session history file.
 * Appended to the receiving agent's initial prompt during handoff.
 */
export function buildSessionHistoryReference(options: SessionHistoryReferenceOptions): string {
  return buildHandoffXml({
    sourceDisplayName: agentDisplayLabel(options.sourceAgent),
    sessionFilePath: options.sessionFilePath,
    targetHasMcpAccess: options.targetHasMcpAccess,
  });
}

function agentDisplayLabel(agent: string): string {
  switch (agent) {
    case 'claude': return 'Claude Code';
    case 'gemini': return 'Gemini CLI';
    case 'codex': return 'Codex CLI';
    case 'aider': return 'Aider';
    case 'kimi': return 'Kimi Code';
    case 'droid': return 'Droid';
    case 'grok': return 'Grok Build';
    case 'antigravity': return 'Antigravity CLI';
    default: return agent;
  }
}
