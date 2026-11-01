import type { SessionRecord } from '../../shared/types';

/**
 * A session record for a workflow's own agent, which has no sessions row (it is
 * a transient session, decision 93), so the transcript readers can read its
 * conversation the way they read a task session's: by the conversation id, the
 * agent's session type, and the checkout it ran in, which is where the CLI
 * keeps the history. `task_id` is empty: the task-level stitch reads it as the
 * one session it is. Every metric column is null; Stats reads the agent's spend
 * from `usage_history` instead.
 *
 * Plain values only, so main (the MCP transcript tool) and the retrieval worker
 * (the conversation viewer) build it the same way.
 */
export function workflowAgentSessionRecord(input: {
  agentSessionId: string;
  sessionType: string;
  cwd: string;
  startedAt: string;
  /** Where the agent's CLI ran (`StoredCliTarget` JSON), or null for this machine. */
  cliTarget?: string | null;
}): SessionRecord {
  return {
    id: input.agentSessionId,
    task_id: '',
    session_type: input.sessionType,
    isolated_swimlane_id: null,
    start_head_sha: null,
    agent_session_id: input.agentSessionId,
    command: '',
    cwd: input.cwd,
    permission_mode: null,
    prompt: null,
    status: 'suspended',
    exit_code: null,
    started_at: input.startedAt,
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
    total_cost_usd: null,
    total_input_tokens: null,
    total_output_tokens: null,
    model_id: null,
    model_display_name: null,
    applied_model: null,
    applied_effort: null,
    total_duration_ms: null,
    tool_call_count: null,
    lines_added: null,
    lines_removed: null,
    files_changed: null,
    tool_breakdown: null,
    compaction_count: 0,
    last_pty_cols: null,
    last_pty_rows: null,
    result_tokens_read_at: null,
    transcript_path: null,
    cli_target: input.cliTarget ?? null,
  };
}
