import type Database from 'better-sqlite3';
import type { AgentCallUsage, BackgroundCallJob, BackgroundCallOutcome } from '../../../shared/types';

/**
 * The ledger of headless agent calls Kangentic makes on the user's behalf: a
 * Condition check, a workflow step check, a task summary batch, a task title,
 * a Command Terminal name. None of them is a session, so none reaches
 * `usage_history`; before this table the only way to see which model answered
 * a check was a hand-run probe.
 *
 * One row per CLI call, written when the call settles (`record-background-call.ts`).
 * A check that answered several automation rows is one row here, and each run
 * row names it through `automation_runs.background_call_id`.
 *
 * Token and cost columns are NULL, never 0, when the agent's CLI reports no
 * usage: an estimate would read as a measurement.
 */

export interface RecordBackgroundCallInput {
  id: string;
  job: BackgroundCallJob;
  taskId: string | null;
  swimlaneId: string | null;
  agent: string;
  /** The model Kangentic asked for, or null for the agent's own default. */
  requestedModel: string | null;
  effort: string | null;
  /** What the CLI reported, or null when it reported nothing. */
  usage: AgentCallUsage | null;
  durationMs: number;
  outcome: BackgroundCallOutcome;
  /** Why a call failed, or null. */
  detail: string | null;
  /** When the call started (UTC ISO 8601). */
  startedAt: string;
}

/**
 * Calls grouped into fixed UTC buckets of `groupMs` by job, agent and model,
 * for the usage dashboard to fold into local days. `modelId` is the model the
 * CLI reported, else the one asked for, else null (the agent's default).
 */
export interface BackgroundCallGroupRow {
  bucketStartMs: number;
  job: string;
  agent: string;
  modelId: string | null;
  calls: number;
  /** Calls whose CLI run did not succeed (failed or timed out). */
  failedCalls: number;
  /** Calls whose CLI reported usage; the token sums cover only these. */
  reportedCalls: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Summed cost, or null when no call in the group reported one. */
  costUsd: number | null;
  durationMs: number;
}

/** One task's call, as the completed task view lists it. */
export interface TaskBackgroundCallRow {
  id: string;
  job: string;
  swimlaneId: string | null;
  /** The model the CLI reported, else the one asked for, else null (the agent's default). */
  modelId: string | null;
  effort: string | null;
  /** Null, never zero, when the agent reported no usage. */
  tokens: number | null;
  costUsd: number | null;
  durationMs: number;
  startedAt: string;
}

/** True once the table exists. The retrieval worker opens a project's database
 *  with migrations off, so a project main has not opened since the upgrade has
 *  none yet, and its dashboard read must come back empty rather than throw. */
function hasBackgroundCallsTable(db: Database.Database): boolean {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'background_calls'")
    .get() !== undefined;
}

export class BackgroundCallRepository {
  constructor(private db: Database.Database) {}

  record(input: RecordBackgroundCallInput): void {
    const usage = input.usage;
    this.db
      .prepare(`
        INSERT INTO background_calls
          (id, job, task_id, swimlane_id, agent, requested_model, model, effort,
           input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd,
           duration_ms, outcome, detail, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.job,
        input.taskId,
        input.swimlaneId,
        input.agent,
        input.requestedModel,
        usage?.model ?? null,
        input.effort,
        usage ? usage.inputTokens : null,
        usage ? usage.cacheCreationInputTokens : null,
        usage ? usage.cacheReadInputTokens : null,
        usage ? usage.outputTokens : null,
        usage?.costUsd ?? null,
        Math.max(0, Math.round(input.durationMs)),
        input.outcome,
        input.detail,
        input.startedAt,
      );
  }

  /** Every call made for one task, oldest first. Empty for a database with no table yet. */
  listForTask(taskId: string): TaskBackgroundCallRow[] {
    if (!hasBackgroundCallsTable(this.db)) return [];
    return this.db.prepare(`
      SELECT id,
             job,
             swimlane_id AS swimlaneId,
             COALESCE(model, requested_model) AS modelId,
             effort,
             CASE
               WHEN input_tokens IS NULL AND output_tokens IS NULL
                 AND cache_creation_input_tokens IS NULL AND cache_read_input_tokens IS NULL THEN NULL
               ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                 + COALESCE(cache_creation_input_tokens, 0) + COALESCE(cache_read_input_tokens, 0)
             END AS tokens,
             cost_usd AS costUsd,
             duration_ms AS durationMs,
             started_at AS startedAt
      FROM background_calls
      WHERE task_id = ?
      ORDER BY started_at ASC
    `).all(taskId) as TaskBackgroundCallRow[];
  }

  /**
   * The window's calls grouped to fixed UTC buckets of `groupMs` by job, agent
   * and model. `since`/`until` bound `started_at` (inclusive, exclusive); null
   * leaves that side open. Empty for a database with no table yet.
   */
  listGroups(sinceIso: string | null, untilIso: string | null, groupMs: number): BackgroundCallGroupRow[] {
    if (!hasBackgroundCallsTable(this.db)) return [];
    const clauses = [`CAST(strftime('%s', started_at) AS INTEGER) IS NOT NULL`];
    const params: Array<string | number> = [groupMs, groupMs];
    if (sinceIso !== null) {
      clauses.push('started_at >= ?');
      params.push(sinceIso);
    }
    if (untilIso !== null) {
      clauses.push('started_at < ?');
      params.push(untilIso);
    }
    return this.db.prepare(`
      SELECT
        CAST(CAST(strftime('%s', started_at) AS INTEGER) * 1000 / ? AS INTEGER) * ? AS bucketStartMs,
        job,
        agent,
        COALESCE(model, requested_model) AS modelId,
        COUNT(*) AS calls,
        SUM(CASE WHEN outcome = 'succeeded' THEN 0 ELSE 1 END) AS failedCalls,
        COUNT(input_tokens) AS reportedCalls,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        SUM(cost_usd) AS costUsd,
        COALESCE(SUM(duration_ms), 0) AS durationMs
      FROM background_calls
      WHERE ${clauses.join(' AND ')}
      GROUP BY bucketStartMs, job, agent, modelId
      ORDER BY bucketStartMs ASC, job ASC
    `).all(...params) as BackgroundCallGroupRow[];
  }
}
