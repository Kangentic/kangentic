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
  const { sourceAgent, sessionFilePath, targetHasMcpAccess } = options;
  const sourceDisplayName = agentDisplayLabel(sourceAgent);

  const lines: string[] = [];
  lines.push(`You are continuing work on this task that was previously handled by ${sourceDisplayName}.`);

  if (sessionFilePath) {
    lines.push(`The prior agent's full session history is at: ${sessionFilePath}`);
    lines.push('Read this file for context on what was done, decisions made, and current state.');

    if (targetHasMcpAccess) {
      lines.push('');
      lines.push('You can also use the `kangentic_get_session_history` MCP tool to read the prior session content directly.');
    }
  } else {
    lines.push('No session history file is available for the prior session.');
    lines.push('Check `git log` for prior changes on this branch.');
  }

  return lines.join('\n');
}

function agentDisplayLabel(agent: string): string {
  switch (agent) {
    case 'claude': return 'Claude Code';
    case 'gemini': return 'Gemini CLI';
    case 'codex': return 'Codex CLI';
    case 'aider': return 'Aider';
    case 'kimi': return 'Kimi Code';
    case 'droid': return 'Droid';
    default: return agent;
  }
}
