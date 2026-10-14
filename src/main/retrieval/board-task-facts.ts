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
 * The outcome rule is the same CASE `documentMetadata` uses: a Done lane or an
 * archived task is done, since only the move into Done archives.
 *
 * Cost, duration and tokens roll up the way the task summary does
 * (SessionRepository.getSummaryForTask; keep the two in step): a session row
 * holds its whole conversation's CUMULATIVE reading and a `--resume` is a new
 * row, so each conversation lineage (`COALESCE(agent_session_id, id)`) counts
 * once, cost and duration by their final (MAX) reading and tokens by the
 * lineage's latest reading, and the lineages add up. A flat SUM billed a
 * resumed conversation once per leg. Like the summary, only rows that reported
 * usage (a cost, zero when the agent has none) are readings, and a row with no
 * tokens is no token reading, so a lineage's tokens come from its latest row
 * that has them. The one difference is the empty case: a task with no token
 * reading at all reads null here and zero in the summary, whose
 * `SessionSummary` field is a number.
 * The model is the newest session's, not the alphabetically last.
 *
 * Git churn is branch-cumulative and written to ONE session record per task,
 * with the task's other records zeroed (setTaskGitStats): lines summed, files by
 * their largest capture. Null when no record ever captured it.
 */
export const BOARD_TASK_FACTS_SQL = `WITH lineage_totals AS (
  SELECT task_id,
         SUM(lineage_cost_usd) AS cost_usd,
         SUM(lineage_duration_ms) AS duration_ms
  FROM (
    SELECT task_id,
           MAX(total_cost_usd) AS lineage_cost_usd,
           MAX(total_duration_ms) AS lineage_duration_ms
    FROM sessions
    WHERE total_cost_usd IS NOT NULL
    GROUP BY task_id, COALESCE(agent_session_id, id)
  )
  GROUP BY task_id
),
lineage_tokens AS (
  SELECT task_id,
         SUM(COALESCE(total_input_tokens, 0) + COALESCE(total_output_tokens, 0)) AS tokens
  FROM (
    SELECT task_id, total_input_tokens, total_output_tokens,
           ROW_NUMBER() OVER (
             PARTITION BY task_id, COALESCE(agent_session_id, id)
             ORDER BY started_at DESC, id DESC
           ) AS rn
    FROM sessions
    -- Null, never zero, when no session recorded tokens.
    WHERE total_cost_usd IS NOT NULL
      AND (total_input_tokens IS NOT NULL OR total_output_tokens IS NOT NULL)
  )
  WHERE rn = 1
  GROUP BY task_id
),
latest_model AS (
  SELECT task_id,
         COALESCE(applied_model, model_display_name) AS model,
         ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC, id DESC) AS rn
  FROM sessions
  WHERE COALESCE(applied_model, model_display_name) IS NOT NULL
)
SELECT t.id AS taskId,
       t.display_id AS displayId,
       t.title AS title,
       CASE
         WHEN w.role = 'done' OR t.archived_at IS NOT NULL THEN 'done'
         ELSE 'active'
       END AS outcome,
       COUNT(s.id) AS sessions,
       lineage_totals.cost_usd AS costUsd,
       lineage_totals.duration_ms AS durationMs,
       lineage_tokens.tokens AS tokens,
       MAX(COALESCE(s.exited_at, s.suspended_at, s.started_at, t.updated_at)) AS lastActivity,
       MAX(s.session_type) AS agent,
       latest_model.model AS model,
       MAX(s.files_changed) AS filesChanged,
       SUM(s.lines_added) AS linesAdded,
       SUM(s.lines_removed) AS linesRemoved,
       t.pr_number AS prNumber,
       t.pr_state AS prState
FROM tasks t
LEFT JOIN swimlanes w ON w.id = t.swimlane_id
LEFT JOIN sessions s ON s.task_id = t.id
LEFT JOIN lineage_totals ON lineage_totals.task_id = t.id
LEFT JOIN lineage_tokens ON lineage_tokens.task_id = t.id
LEFT JOIN latest_model ON latest_model.task_id = t.id AND latest_model.rn = 1
GROUP BY t.id`;

/** One row of `BOARD_TASK_FACTS_SQL`, as the database returns it. */
export interface BoardTaskFactsRow {
  taskId: string;
  displayId: number | null;
  title: string;
  outcome: 'done' | 'active';
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
