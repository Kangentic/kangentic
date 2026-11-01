/**
 * Claude Code SessionStart hook payloads in the shape event-bridge.js records
 * them: the hook's stdin JSON, stringified into `hookContext` on a
 * `session_start` line of the session's events.jsonl.
 *
 * Modeled on the three lines a live 2.1.316 task recorded when Claude Code
 * moved it into its background daemon (2026-10-31): the spawn's own `resume`,
 * the daemon's empty spare (`startup`, with `agent_type`), and the moved
 * conversation (`fork`). Paths are generic placeholders.
 */

const CWD = 'C:\\Users\\dev\\projects\\app\\.kangentic\\worktrees\\79';
const PROJECTS_DIR = 'C:\\Users\\dev\\.claude\\projects\\C--Users-dev-projects-app--kangentic-worktrees-79';
const SCRATCH_DIR = 'C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\C--Users-dev-projects-app--kangentic-worktrees-79';

export type ClaudeSessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork';

/** The hook's stdin payload, as the JSON string the bridge stores in `hookContext`. */
export function claudeSessionStartContext(agentSessionId: string, source: ClaudeSessionStartSource): string {
  const payload: Record<string, unknown> = {
    session_id: agentSessionId,
    transcript_path: `${PROJECTS_DIR}\\${agentSessionId}.jsonl`,
    cwd: CWD,
    scratchpad_dir: `${SCRATCH_DIR}\\${agentSessionId}\\scratchpad`,
  };
  if (source === 'startup') payload.agent_type = 'claude';
  payload.hook_event_name = 'SessionStart';
  payload.source = source;
  if (source === 'startup') {
    payload.model = 'claude-opus-4-8';
  } else {
    payload.seconds_since_last_response = 7;
    payload.context_tokens = 629_571;
  }
  return JSON.stringify(payload);
}

/** One events.jsonl line for that hook, as event-bridge.js writes it. */
export function claudeSessionStartLine(agentSessionId: string, source: ClaudeSessionStartSource, ts = 1): string {
  return JSON.stringify({ ts, type: 'session_start', hookContext: claudeSessionStartContext(agentSessionId, source) });
}
