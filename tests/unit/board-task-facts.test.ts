/**
 * Real-DB test for BOARD_TASK_FACTS_SQL, the query the Ask answer table and the
 * on-demand Ask eval harness under scripts/ both read. Cost, duration and tokens
 * roll up per conversation lineage, the way the task summary does, so the
 * answer table and the summary cannot disagree on what a task cost.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BOARD_TASK_FACTS_SQL, toBoardTaskFacts, type BoardTaskFactsRow } from '../../src/main/retrieval/board-task-facts';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';

interface SessionRow {
  id: string;
  taskId: string;
  agentSessionId?: string | null;
  startedAt: string;
  costUsd?: number | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
  /** The model the agent was launched with (`applied_model`); `model` is the statusLine's display name. */
  appliedModel?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
}

describe('BOARD_TASK_FACTS_SQL (real DB)', () => {
  let db: Database.Database;

  function insertTask(taskId: string): void {
    const swimlaneId = (db.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
    db.prepare(`
      INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at)
      VALUES (?, ?, ?, 0, '2026-10-12T08:00:00.000Z', '2026-10-12T08:00:00.000Z')
    `).run(taskId, `Task ${taskId}`, swimlaneId);
  }

  function insertSession(row: SessionRow): void {
    db.prepare(`
      INSERT INTO sessions (
        id, task_id, session_type, agent_session_id, command, cwd, started_at,
        total_cost_usd, total_duration_ms, total_input_tokens, total_output_tokens,
        model_display_name, applied_model, lines_added, lines_removed, files_changed
      ) VALUES (?, ?, 'claude', ?, 'claude', '/mock/project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.taskId, row.agentSessionId ?? null, row.startedAt,
      row.costUsd ?? null, row.durationMs ?? null, row.inputTokens ?? null, row.outputTokens ?? null,
      row.model ?? null, row.appliedModel ?? null, row.linesAdded ?? null, row.linesRemoved ?? null, row.filesChanged ?? null,
    );
  }

  function factsFor(taskId: string) {
    const rows = db.prepare(BOARD_TASK_FACTS_SQL).all() as BoardTaskFactsRow[];
    const row = rows.find((candidate) => candidate.taskId === taskId);
    if (!row) throw new Error(`no facts for ${taskId}`);
    return toBoardTaskFacts(row);
  }

  beforeEach(() => {
    db = openTestDatabase();
    runProjectMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('counts each conversation once: a resumed lineage by its final reading, plus an isolated lineage', () => {
    insertTask('task-797');
    // The main conversation resumed twice: each row is the conversation's cumulative.
    insertSession({ id: 'leg-1', taskId: 'task-797', agentSessionId: 'main', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1.85, durationMs: 722_000, inputTokens: 10, outputTokens: 1, model: 'Opus 5.5' });
    insertSession({ id: 'leg-2', taskId: 'task-797', agentSessionId: 'main', startedAt: '2026-10-12T10:00:00.000Z', costUsd: 26.04, durationMs: 4_622_000, inputTokens: 20, outputTokens: 2, model: 'Opus 5.5' });
    insertSession({ id: 'leg-3', taskId: 'task-797', agentSessionId: 'main', startedAt: '2026-10-12T12:00:00.000Z', costUsd: 30.84, durationMs: 5_629_000, inputTokens: 30, outputTokens: 3, model: 'Sonnet 5.5', linesAdded: 789, linesRemoved: 103, filesChanged: 13 });
    // The isolated Code Review conversation.
    insertSession({ id: 'review', taskId: 'task-797', agentSessionId: 'review', startedAt: '2026-10-12T11:00:00.000Z', costUsd: 16.74, durationMs: 1_415_000, inputTokens: 5, outputTokens: 1, model: 'Opus 5.5' });

    const facts = factsFor('task-797');

    expect(facts.sessions).toBe(4);
    expect(facts.costUsd).toBeCloseTo(30.84 + 16.74, 10);
    expect(facts.durationMs).toBe(5_629_000 + 1_415_000);
    // Latest reading per lineage: main's leg-3 (33) plus review (6).
    expect(facts.tokens).toBe(33 + 6);
    // The newest session's model, not the alphabetically last ("Sonnet" > "Opus" by chance here,
    // so the next case pins the order).
    expect(facts.model).toBe('Sonnet 5.5');
    expect(facts.linesAdded).toBe(789);
    expect(facts.linesRemoved).toBe(103);
    expect(facts.filesChanged).toBe(13);
  });

  it("takes the newest session's model, even when an older one sorts later", () => {
    insertTask('task-model');
    insertSession({ id: 'older', taskId: 'task-model', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1, model: 'Sonnet 5.5' });
    insertSession({ id: 'newer', taskId: 'task-model', startedAt: '2026-10-12T10:00:00.000Z', costUsd: 2, model: 'Haiku 5.5' });

    expect(factsFor('task-model').model).toBe('Haiku 5.5');
  });

  it('takes the model the agent was launched with over the statusLine display name', () => {
    insertTask('task-applied');
    insertSession({ id: 'applied', taskId: 'task-applied', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1, model: 'Opus 5.5', appliedModel: 'claude-opus-5-5' });

    expect(factsFor('task-applied').model).toBe('claude-opus-5-5');
  });

  it('falls back to the display name for a session that recorded no applied model', () => {
    insertTask('task-display');
    insertSession({ id: 'display', taskId: 'task-display', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1, model: 'Opus 5.5' });

    expect(factsFor('task-display').model).toBe('Opus 5.5');
  });

  it('rolls cost, duration and tokens up exactly as the task summary does', () => {
    const taskId = 'task-parity';
    insertTask(taskId);
    // The main conversation, resumed three times: each row is the conversation's cumulative.
    insertSession({ id: 'leg-1', taskId, agentSessionId: 'main', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1.85, durationMs: 722_000, inputTokens: 10, outputTokens: 1 });
    insertSession({ id: 'leg-2', taskId, agentSessionId: 'main', startedAt: '2026-10-12T10:00:00.000Z', costUsd: 26.04, durationMs: 4_622_000, inputTokens: 20, outputTokens: 2 });
    insertSession({ id: 'leg-3', taskId, agentSessionId: 'main', startedAt: '2026-10-12T12:00:00.000Z', costUsd: 30.84, durationMs: 5_629_000, inputTokens: 30, outputTokens: 3 });
    // The isolated Code Review conversation: separate spend, added on top.
    insertSession({ id: 'review', taskId, agentSessionId: 'review', startedAt: '2026-10-12T11:00:00.000Z', costUsd: 16.74, durationMs: 1_415_000, inputTokens: 5, outputTokens: 1 });
    // A row that never recorded a conversation id is its own lineage.
    insertSession({ id: 'orphan', taskId, startedAt: '2026-10-12T08:00:00.000Z', costUsd: 0.5, durationMs: 60_000, inputTokens: 7, outputTokens: 1 });
    // The NEWEST row of the main lineage reported no cost, but carries a longer duration and
    // more tokens. Neither reader takes a reading from a row without a cost, so none of it counts.
    insertSession({ id: 'leg-4', taskId, agentSessionId: 'main', startedAt: '2026-10-12T14:00:00.000Z', costUsd: null, durationMs: 9_999_000, inputTokens: 500, outputTokens: 50 });

    const facts = factsFor(taskId);
    const summary = new SessionRepository(db).getSummaryForTask(taskId);
    if (!summary) throw new Error('no summary for the task');

    // The two readers agree with each other...
    expect(facts.costUsd).toBeCloseTo(summary.totalCostUsd, 10);
    expect(facts.durationMs).toBe(summary.durationMs);
    expect(facts.tokens).toBe(summary.totalInputTokens + summary.totalOutputTokens);
    // ...and with the arithmetic: each lineage's final reading, added up (main + review + orphan).
    expect(facts.costUsd).toBeCloseTo(30.84 + 16.74 + 0.5, 10);
    expect(facts.durationMs).toBe(5_629_000 + 1_415_000 + 60_000);
    expect(facts.tokens).toBe(33 + 6 + 8);
  });

  it('takes a lineage\'s tokens from its latest leg that reported tokens, in both readers', () => {
    const taskId = 'task-null-leg';
    insertTask(taskId);
    insertSession({ id: 'leg-1', taskId, agentSessionId: 'main', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1, inputTokens: 10, outputTokens: 1 });
    insertSession({ id: 'leg-2', taskId, agentSessionId: 'main', startedAt: '2026-10-12T10:00:00.000Z', costUsd: 2, inputTokens: 20, outputTokens: 2 });
    // The newest leg reported a cost but no tokens: no reading, so leg-2's stands.
    insertSession({ id: 'leg-3', taskId, agentSessionId: 'main', startedAt: '2026-10-12T11:00:00.000Z', costUsd: 3, inputTokens: null, outputTokens: null });

    const facts = factsFor(taskId);
    const summary = new SessionRepository(db).getSummaryForTask(taskId);
    if (!summary) throw new Error('no summary for the task');

    expect(facts.tokens).toBe(22);
    expect(summary.totalInputTokens).toBe(20);
    expect(summary.totalOutputTokens).toBe(2);
  });

  it('keeps a task whose costed rows report no tokens in the summary, at zero, where the facts read null', () => {
    const taskId = 'task-no-tokens';
    insertTask(taskId);
    insertSession({ id: 'costed', taskId, agentSessionId: 'main', startedAt: '2026-10-12T09:00:00.000Z', costUsd: 1.5, durationMs: 60_000 });

    const repository = new SessionRepository(db);
    const summary = repository.getSummaryForTask(taskId);
    if (!summary) throw new Error('no summary for the task');
    expect(summary.totalCostUsd).toBe(1.5);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(repository.listAllSummaries()[taskId]).toBeDefined();

    expect(factsFor(taskId).tokens).toBeNull();
  });

  it('reads null, not zero, for a task with no recorded cost, duration or tokens', () => {
    insertTask('task-empty');
    insertSession({ id: 'empty', taskId: 'task-empty', startedAt: '2026-10-12T09:00:00.000Z' });
    insertTask('task-none');

    const withSession = factsFor('task-empty');
    expect(withSession.sessions).toBe(1);
    expect(withSession.costUsd).toBeNull();
    expect(withSession.durationMs).toBeNull();
    expect(withSession.tokens).toBeNull();

    const withoutSession = factsFor('task-none');
    expect(withoutSession.sessions).toBe(0);
    expect(withoutSession.costUsd).toBeNull();
    expect(withoutSession.model).toBeNull();
  });
});
