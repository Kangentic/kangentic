/**
 * A complete `SessionRecord` row for unit tests that mock the session repository.
 *
 * Every column is spelled out with a neutral default (a running Claude record on
 * `task-1`, every nullable column null), so a test overrides only the columns its
 * case is about. Keeping the full literal in one place means a column added to
 * `SessionRecord` is one edit here instead of one per suite. Tests that need
 * different defaults (another task id, a queued status, no agent session id) pass
 * them as overrides at the call site.
 */
import type { SessionRecord } from '../../../src/shared/types';

export function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/tmp',
    permission_mode: null,
    prompt: null,
    status: 'running',
    exit_code: null,
    started_at: '2026-01-01T00:00:00.000Z',
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
    ...overrides,
  };
}
