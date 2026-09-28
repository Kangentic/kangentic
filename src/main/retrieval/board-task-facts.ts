/**
 * Every task on the board, active and finished, with its facts rolled up from
 * its sessions, whether or not any conversation of it was ever indexed.
 *
 * The query and its mapping live here, with no runtime import, so the Ask
 * harness (`scripts/eval-ask.mjs`, run under bare node) reads the preview's
 * database with the SAME query the answer table is built from. A copy would
 * drift, and the harness would then grade the answer against its own
 * arithmetic.
 */

import type { BoardTaskFacts } from './answer-tasks';

/**
 * The outcome rule is the same lane-first CASE `documentMetadata` uses.
 *
 * Git churn is branch-cumulative and written to ONE session record per task,
 * with the task's other records zeroed (setTaskGitStats). It is rolled up the
 * way the task summary does (SessionRepository.getSummaryForTask): lines
 * summed, files by their largest capture. Null when no record ever captured it.
 */
export const BOARD_TASK_FACTS_SQL = `SELECT t.id AS taskId,
       t.display_id AS displayId,
       t.title AS title,
       CASE
         WHEN w.role = 'done' THEN 'done'
         WHEN t.archived_at IS NOT NULL THEN 'abandoned'
         ELSE 'active'
       END AS outcome,
       COUNT(s.id) AS sessions,
       SUM(s.total_cost_usd) AS costUsd,
       SUM(s.total_duration_ms) AS durationMs,
       -- Null, never zero, when no session recorded tokens.
       SUM(CASE
         WHEN s.total_input_tokens IS NULL AND s.total_output_tokens IS NULL THEN NULL
         ELSE COALESCE(s.total_input_tokens, 0) + COALESCE(s.total_output_tokens, 0)
       END) AS tokens,
       MAX(COALESCE(s.exited_at, s.suspended_at, s.started_at, t.updated_at)) AS lastActivity,
       MAX(s.session_type) AS agent,
       MAX(COALESCE(s.applied_model, s.model_display_name)) AS model,
       MAX(s.files_changed) AS filesChanged,
       SUM(s.lines_added) AS linesAdded,
       SUM(s.lines_removed) AS linesRemoved,
       t.pr_number AS prNumber,
       t.pr_state AS prState
FROM tasks t
LEFT JOIN swimlanes w ON w.id = t.swimlane_id
LEFT JOIN sessions s ON s.task_id = t.id
GROUP BY t.id`;

/** One row of `BOARD_TASK_FACTS_SQL`, as the database returns it. */
export interface BoardTaskFactsRow {
  taskId: string;
  displayId: number | null;
  title: string;
  outcome: 'done' | 'abandoned' | 'active';
  sessions: number;
  costUsd: number | null;
  durationMs: number | null;
  tokens: number | null;
  /** ISO timestamp of the latest session event or task edit. */
  lastActivity: string | null;
  agent: string | null;
  model: string | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  prNumber: number | null;
  prState: string | null;
}

/** A row as the answer table takes it: the activity timestamp in milliseconds. */
export function toBoardTaskFacts(row: BoardTaskFactsRow): BoardTaskFacts {
  const lastActivityMs = row.lastActivity ? Date.parse(row.lastActivity) : Number.NaN;
  return {
    taskId: row.taskId,
    displayId: row.displayId,
    title: row.title,
    outcome: row.outcome,
    sessions: row.sessions,
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    tokens: row.tokens,
    lastActivityMs: Number.isNaN(lastActivityMs) ? null : lastActivityMs,
    agent: row.agent,
    model: row.model,
    filesChanged: row.filesChanged,
    linesAdded: row.linesAdded,
    linesRemoved: row.linesRemoved,
    prNumber: row.prNumber,
    prState: row.prState,
  };
}
