/**
 * Real-DB tests for the UsageHistoryRepository aggregate reads that replaced
 * the raw-row listRowsAfter path (getUsageTotals / listUsageRollup /
 * listUsageCostGroups / countSessionsRepresented). Pins the semantics the
 * mock-level suite (usage-history-repository.test.ts) cannot: window edge
 * behavior (`>= since`, `< until`), NULL model/agent/effort as real buckets,
 * SQLite's strftime parsing of `toISOString()` output (ms + Z suffix),
 * 15-minute UTC bucket math, and the earliest-session orderings the JS
 * regrouping relies on for first-encounter behavior.
 *
 * Uses a real in-memory better-sqlite3 DB bootstrapped via
 * runProjectMigrations. Skips cleanly when better-sqlite3 cannot load under
 * the test runner's Node ABI; mirrors usage-history-migration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors usage-history-migration.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    // Use a variable for the module name to avoid the static-require lint rule
    // (which targets string-literal bare requires in bundled main/preload code;
    // this is a test helper for a native probe, not a bundled require).
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { UsageHistoryRepository } from '../../src/main/db/repositories/usage-history-repository';
import { ActivityIntervalStore } from '../../src/main/activity-engine/activity-interval-store';
import { COST_GROUP_MS } from '../../src/main/usage-stats/bucketing';

interface UsageFixture {
  sessionRecordId: string;
  sessionStartedAt: string;
  totalCostUsd: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalDurationMs?: number | null;
  toolCallCount?: number;
  modelId?: string | null;
  modelDisplayName?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  compactionCount?: number;
  agent?: string | null;
  effort?: string | null;
}

const SINCE = '2026-01-02T00:00:00.000Z';
const UNTIL = '2026-01-04T00:00:00.000Z';

describe.runIf(CAN_RUN)('UsageHistoryRepository aggregate reads (real DB)', () => {
  let db: InstanceType<typeof DatabaseType>;
  let repository: UsageHistoryRepository;

  function insertUsage(fixture: UsageFixture): void {
    db.prepare(`
      INSERT INTO usage_history (id, session_record_id, recorded_at,
        session_started_at, total_cost_usd, total_input_tokens,
        total_output_tokens, total_duration_ms, tool_call_count, model_id,
        model_display_name, lines_added, lines_removed, files_changed,
        compaction_count, agent, effort)
      VALUES (?, ?, '2026-01-05T00:00:00.000Z', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `id-${fixture.sessionRecordId}`,
      fixture.sessionRecordId,
      fixture.sessionStartedAt,
      fixture.totalCostUsd,
      fixture.totalInputTokens ?? 0,
      fixture.totalOutputTokens ?? 0,
      fixture.totalDurationMs ?? null,
      fixture.toolCallCount ?? 0,
      fixture.modelId ?? null,
      fixture.modelDisplayName ?? null,
      fixture.linesAdded ?? 0,
      fixture.linesRemoved ?? 0,
      fixture.filesChanged ?? 0,
      fixture.compactionCount ?? 0,
      fixture.agent ?? null,
      fixture.effort ?? null,
    );
  }

  /** One main-thread turn for a session, so the rollup has real tokens to
   *  read. The rollup's token columns come from this ledger, not from
   *  usage_history, whose token columns are context-window snapshots. */
  function insertTurn(
    turnUuid: string,
    sessionId: string,
    tsMs: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    db.prepare(`
      INSERT INTO conversation_turn_usage
        (turn_uuid, session_id, ts, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, recorded_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, '2026-01-05T00:00:00.000Z')
    `).run(turnUuid, sessionId, tsMs, inputTokens, outputTokens);
  }

  /** The window fixture shared by most tests: four rows inside
   *  [SINCE, UNTIL), one at the exclusive upper edge, one before. */
  function seedWindowFixture(): void {
    insertUsage({ sessionRecordId: 'sess-1', sessionStartedAt: '2026-01-02T09:07:30.500Z', totalCostUsd: 1.5, totalInputTokens: 1000, totalOutputTokens: 200, totalDurationMs: 60_000, toolCallCount: 4, modelId: 'claude-opus-4-8', modelDisplayName: 'Opus 4.8', linesAdded: 10, linesRemoved: 3, filesChanged: 2, compactionCount: 1, agent: 'claude', effort: 'high' });
    insertUsage({ sessionRecordId: 'sess-2', sessionStartedAt: '2026-01-02T09:12:00.000Z', totalCostUsd: 0, totalInputTokens: 500, totalOutputTokens: 50, totalDurationMs: null, toolCallCount: 2, modelId: 'claude-opus-4-8-20250815', modelDisplayName: 'Opus 4.8 pinned', agent: 'claude', effort: null });
    insertUsage({ sessionRecordId: 'sess-3', sessionStartedAt: '2026-01-03T22:00:00.000Z', totalCostUsd: 2.25, totalInputTokens: 3000, totalOutputTokens: 700, totalDurationMs: 120_000, toolCallCount: 9, modelId: null, modelDisplayName: null, linesAdded: 5, linesRemoved: 1, filesChanged: 1, compactionCount: 2, agent: 'codex', effort: 'low' });
    insertUsage({ sessionRecordId: 'sess-5', sessionStartedAt: '2026-01-02T00:00:00.000Z', totalCostUsd: 0.5, totalInputTokens: 100, totalOutputTokens: 10, totalDurationMs: 500, toolCallCount: 1, modelId: 'claude-opus-4-8', modelDisplayName: 'Opus 4.8', agent: null, effort: 'high' });
    // Exactly at UNTIL: excluded (strictly-before upper bound).
    insertUsage({ sessionRecordId: 'sess-4', sessionStartedAt: UNTIL, totalCostUsd: 9.99, totalInputTokens: 9999 });
    // Before the window.
    insertUsage({ sessionRecordId: 'sess-6', sessionStartedAt: '2026-01-01T10:00:00.000Z', totalCostUsd: 3.0, totalInputTokens: 400, totalOutputTokens: 40, agent: 'gemini' });
  }

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
    repository = new UsageHistoryRepository(db);
  });

  afterEach(() => {
    db?.close();
  });

  describe('getUsageTotals', () => {
    it('sums the window with inclusive-since / exclusive-until edges', () => {
      seedWindowFixture();
      const totals = repository.getUsageTotals(SINCE, UNTIL);

      // sess-5 (exactly at since) is in; sess-4 (exactly at until) is out.
      expect(totals.sessionCount).toBe(4);
      expect(totals.totalCostUsd).toBeCloseTo(4.25, 10);
      expect(totals.totalInputTokens).toBe(4600);
      expect(totals.totalOutputTokens).toBe(960);
      expect(totals.toolCallCount).toBe(16);
      expect(totals.linesAdded).toBe(15);
      expect(totals.linesRemoved).toBe(4);
      expect(totals.filesChanged).toBe(3);
      expect(totals.compactionCount).toBe(3);
      // NULL total_duration_ms rows are neutral (SUM ignores NULL).
      expect(totals.totalDurationMs).toBe(180_500);
      // Zero-cost sess-2 does not count as cost-known.
      expect(totals.costKnownCount).toBe(3);
      expect(totals.minSessionStartedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(totals.maxSessionStartedAt).toBe('2026-01-03T22:00:00.000Z');
    });

    it('returns zero counters and null timestamps for an empty window', () => {
      seedWindowFixture();
      const totals = repository.getUsageTotals('2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');

      expect(totals.sessionCount).toBe(0);
      expect(totals.totalCostUsd).toBe(0);
      expect(totals.totalDurationMs).toBe(0);
      expect(totals.costKnownCount).toBe(0);
      expect(totals.minSessionStartedAt).toBeNull();
      expect(totals.maxSessionStartedAt).toBeNull();
    });

    it('aggregates all time when since is null', () => {
      seedWindowFixture();
      const totals = repository.getUsageTotals(null);

      expect(totals.sessionCount).toBe(6);
      expect(totals.minSessionStartedAt).toBe('2026-01-01T10:00:00.000Z');
      expect(totals.maxSessionStartedAt).toBe(UNTIL);
    });
  });

  describe('listUsageRollup', () => {
    it('groups by the four dimensions with NULLs as real buckets, ordered by earliest session', () => {
      seedWindowFixture();
      const rollup = repository.listUsageRollup(SINCE, UNTIL);

      expect(rollup).toHaveLength(4);
      // Earliest-session order: sess-5 (00:00), sess-1 (09:07), sess-2 (09:12), sess-3 (next day).
      expect(rollup[0]).toMatchObject({ modelId: 'claude-opus-4-8', agent: null, effort: 'high', sessionCount: 1 });
      expect(rollup[1]).toMatchObject({ modelId: 'claude-opus-4-8', agent: 'claude', effort: 'high', costUsd: 1.5 });
      expect(rollup[2]).toMatchObject({ modelId: 'claude-opus-4-8-20250815', agent: 'claude', effort: null });
      expect(rollup[3]).toMatchObject({ modelId: null, modelDisplayName: null, agent: 'codex', effort: 'low' });
    });

    it('takes cost from the ledger and TOKENS from the turn ledger, per dimension combo', () => {
      // The usage_history token columns (100/10 and 200/20 below) are
      // context-window snapshots, so a breakdown built on them ranked models
      // by how large their contexts happened to be. Real tokens come from the
      // turns, and the two sets of numbers are deliberately different here so
      // a regression to the snapshot columns cannot pass.
      insertUsage({ sessionRecordId: 'a', sessionStartedAt: '2026-01-02T10:00:00.000Z', totalCostUsd: 1, totalInputTokens: 100, totalOutputTokens: 10, modelId: 'm', modelDisplayName: 'M', agent: 'claude', effort: 'high' });
      insertUsage({ sessionRecordId: 'b', sessionStartedAt: '2026-01-02T11:00:00.000Z', totalCostUsd: 2, totalInputTokens: 200, totalOutputTokens: 20, modelId: 'm', modelDisplayName: 'M', agent: 'claude', effort: 'high' });
      insertTurn('t1', 'a', Date.parse('2026-01-02T10:05:00.000Z'), 7, 3);
      insertTurn('t2', 'a', Date.parse('2026-01-02T10:06:00.000Z'), 11, 5);
      insertTurn('t3', 'b', Date.parse('2026-01-02T11:05:00.000Z'), 13, 2);

      const rollup = repository.listUsageRollup(SINCE, UNTIL, Date.parse(SINCE), Date.parse(UNTIL));

      expect(rollup).toHaveLength(1);
      expect(rollup[0]).toMatchObject({ inputTokens: 31, outputTokens: 10, costUsd: 3, sessionCount: 2 });
    });

    it('reports zero tokens, not a dropped row, for a session with no turns', () => {
      // Everything before the turn ledger shipped. The session still has cost
      // and still has to appear in the breakdown.
      insertUsage({ sessionRecordId: 'old', sessionStartedAt: '2026-01-02T10:00:00.000Z', totalCostUsd: 4, totalInputTokens: 900, totalOutputTokens: 90, modelId: 'm', agent: 'claude', effort: 'high' });

      const rollup = repository.listUsageRollup(SINCE, UNTIL, Date.parse(SINCE), Date.parse(UNTIL));

      expect(rollup).toHaveLength(1);
      expect(rollup[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 4, sessionCount: 1 });
    });

    it('excludes subagent turns from the breakdown, as the Tokens tile does', () => {
      insertUsage({ sessionRecordId: 'a', sessionStartedAt: '2026-01-02T10:00:00.000Z', totalCostUsd: 1, modelId: 'm', agent: 'claude', effort: 'high' });
      insertTurn('main-1', 'a', Date.parse('2026-01-02T10:05:00.000Z'), 10, 4);
      db.prepare(`
        INSERT INTO conversation_turn_usage
          (turn_uuid, session_id, ts, input_tokens, output_tokens,
           cache_creation_input_tokens, cache_read_input_tokens, recorded_at, subagent_id)
        VALUES ('sub-1', 'a', ?, 500, 200, 0, 0, '2026-01-05T00:00:00.000Z', 'subagent-x')
      `).run(Date.parse('2026-01-02T10:06:00.000Z'));

      const rollup = repository.listUsageRollup(SINCE, UNTIL, Date.parse(SINCE), Date.parse(UNTIL));

      expect(rollup[0]).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    });
  });

  describe('recordSessionUsage per-leg deltas', () => {
    function record(
      sessionRecordId: string,
      sessionStartedAt: string,
      conversationId: string | null,
      cumulativeCostUsd: number,
      cumulativeDurationMs: number | null = null,
    ): void {
      repository.recordSessionUsage({
        sessionRecordId,
        sessionStartedAt,
        sessionType: 'claude_agent',
        conversationId,
        cumulativeCostUsd,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cumulativeDurationMs,
        toolCallCount: 0,
        modelId: 'm',
        modelDisplayName: 'M',
        compactionCount: 0,
        agent: 'claude',
        effort: 'high',
      });
    }

    it('sums a resumed conversation to its LAST reading, not once per leg', () => {
      // The shipped defect: the CLI reports a running total for the whole
      // conversation, every `--resume` leg is its own usage_history row, and
      // the dashboard flat-SUMmed them. Three legs of a $30 conversation read
      // as $60.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 10, 1_000);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 25, 2_500);
      record('leg-3', '2026-01-02T03:00:00.000Z', 'conv', 30, 4_000);

      const totals = repository.getUsageTotals(SINCE, UNTIL);
      expect(totals.totalCostUsd).toBeCloseTo(30, 10);
      expect(totals.totalDurationMs).toBe(4_000);
      expect(totals.sessionCount).toBe(3);
    });

    it('adds nothing for a leg that re-reports the previous reading unchanged', () => {
      // A resume where nothing happened re-reads the same status file. On the
      // dogfooding install one lineage had ~20 of these in a row.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 22.16);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 22.16);
      record('leg-3', '2026-01-02T03:00:00.000Z', 'conv', 22.16);

      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(22.16, 10);
    });

    it('is idempotent when the SAME record is re-captured', () => {
      // The 45s metrics timer, suspend, and shutdown all re-capture one record.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 10);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 25);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 25);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 25);

      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(25, 10);
    });

    it('re-measures later legs when an EARLIER one is re-captured', () => {
      // The shutdown sweep captures every session, not just the newest, so an
      // earlier leg's reading can rise after its successors already stored a
      // delta against the old baseline. Deriving one delta per write drifts
      // here (this reads $27 that way); recomputing forward keeps the lineage
      // summing to its highest reading.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 10);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 25);
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 12);

      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(25, 10);
    });

    it('holds sum(deltas) == the lineage max across an interleaved capture order', () => {
      // The invariant the whole scheme rests on, driven through the orders a
      // real install produces: periodic re-captures of the live leg mixed with
      // a shutdown sweep touching older ones.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 5);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 9);
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 6);
      record('leg-3', '2026-01-02T03:00:00.000Z', 'conv', 14);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 11);
      record('leg-3', '2026-01-02T03:00:00.000Z', 'conv', 20);

      const maxCumulative = (db.prepare(
        'SELECT MAX(cumulative_cost_usd) AS m FROM usage_history WHERE conversation_id = ?',
      ).get('conv') as { m: number }).m;
      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(maxCumulative, 10);
      expect(maxCumulative).toBeCloseTo(20, 10);
    });

    it('clamps at zero when a leg reports LESS than a prior one', () => {
      // A counter reset mid-record. Contributing nothing errs low, which is
      // the safe direction; a negative delta would silently refund real spend.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 40);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 5);

      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(40, 10);
    });

    it('treats a fork as a new lineage, so its first leg counts in full', () => {
      // `/clear` forks the CLI session id, and both the resume-time reconcile
      // and the stale-ID recovery persist the new one.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv-a', 10);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv-a', 25);
      record('leg-3', '2026-01-02T03:00:00.000Z', 'conv-b', 7);

      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(32, 10);
    });

    it('gives every null-conversation row its own lineage', () => {
      // Rows whose session was deleted have no lineage to join to. Baselining
      // them against each other would erase all but one.
      record('orphan-1', '2026-01-02T01:00:00.000Z', null, 3);
      record('orphan-2', '2026-01-02T02:00:00.000Z', null, 4);

      expect(repository.getUsageTotals(SINCE, UNTIL).totalCostUsd).toBeCloseTo(7, 10);
    });

    it('keeps a null duration null rather than turning it into a zero delta', () => {
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 1, null);
      const row = db.prepare('SELECT total_duration_ms AS d FROM usage_history').get() as { d: number | null };
      expect(row.d).toBeNull();
    });

    it('still reports cost as KNOWN for a leg whose delta is zero', () => {
      // `costKnown` gates whether the Cost tile and the $/hr line render at
      // all. Once cost became a per-leg delta, a resume that did no work
      // carries a real cumulative reading and a zero delta - 539 of 2,434 rows
      // on the dogfooding install. Counting the delta would make a window made
      // only of such legs claim no agent reported any cost, over a
      // conversation that genuinely spent money.
      record('leg-1', '2026-01-02T01:00:00.000Z', 'conv', 40);
      record('leg-2', '2026-01-02T02:00:00.000Z', 'conv', 40);

      // Window the second leg alone: its delta is 0, its reading is not.
      const totals = repository.getUsageTotals('2026-01-02T01:30:00.000Z', UNTIL);
      expect(totals.totalCostUsd).toBe(0);
      expect(totals.costKnownCount).toBe(1);
    });

    it('reports cost as unknown only when no agent reported any', () => {
      record('free-1', '2026-01-02T01:00:00.000Z', 'conv-a', 0);
      record('free-2', '2026-01-02T02:00:00.000Z', 'conv-b', 0);

      expect(repository.getUsageTotals(SINCE, UNTIL).costKnownCount).toBe(0);
    });
  });

  describe('sumSessionsRepresented', () => {
    it('returns what the ledger already holds for the given live ids', () => {
      seedWindowFixture();
      const represented = repository.sumSessionsRepresented(SINCE, UNTIL, ['sess-1', 'sess-3']);
      expect(represented.costUsd).toBeCloseTo(3.75, 10);
      expect(represented.inputTokens).toBe(4000);
      expect(represented.outputTokens).toBe(900);
    });

    it('ignores ids outside the window and returns zeros for an empty list', () => {
      seedWindowFixture();
      // sess-6 is before the window, sess-4 exactly at the exclusive edge.
      expect(repository.sumSessionsRepresented(SINCE, UNTIL, ['sess-6', 'sess-4']).costUsd).toBe(0);
      expect(repository.sumSessionsRepresented(SINCE, UNTIL, [])).toEqual({
        costUsd: 0, inputTokens: 0, outputTokens: 0,
      });
    });
  });

  describe('listUsageCostGroups', () => {
    it('floors toISOString() timestamps onto the 15-minute UTC grid (strftime parses ms + Z)', () => {
      seedWindowFixture();
      const groups = repository.listUsageCostGroups(SINCE, UNTIL, COST_GROUP_MS);

      const bucketOf = (iso: string): number => Math.floor(Date.parse(iso) / COST_GROUP_MS) * COST_GROUP_MS;
      expect(groups).toHaveLength(4);
      // sess-1 (09:07:30.500) and sess-2 (09:12) share the 09:00 bucket but
      // differ in model_id, so they stay separate groups - ordered by each
      // group's earliest session within the shared bucket.
      expect(groups[0]).toMatchObject({ bucketStartMs: bucketOf('2026-01-02T00:00:00.000Z'), modelId: 'claude-opus-4-8', sessionCount: 1 });
      expect(groups[1]).toMatchObject({ bucketStartMs: bucketOf('2026-01-02T09:07:30.500Z'), modelId: 'claude-opus-4-8' });
      expect(groups[2]).toMatchObject({ bucketStartMs: groups[1].bucketStartMs, modelId: 'claude-opus-4-8-20250815' });
      expect(groups[3]).toMatchObject({ bucketStartMs: bucketOf('2026-01-03T22:00:00.000Z'), modelId: null, costUsd: 2.25 });
      // Every bucket start is a grid multiple.
      for (const group of groups) {
        expect(group.bucketStartMs % COST_GROUP_MS).toBe(0);
      }
    });

    it('merges same-bucket same-model sessions into one group', () => {
      insertUsage({ sessionRecordId: 'a', sessionStartedAt: '2026-01-02T10:01:00.000Z', totalCostUsd: 1, totalInputTokens: 100, modelId: 'm' });
      insertUsage({ sessionRecordId: 'b', sessionStartedAt: '2026-01-02T10:14:00.000Z', totalCostUsd: 2, totalInputTokens: 50, modelId: 'm' });
      const groups = repository.listUsageCostGroups(SINCE, UNTIL, COST_GROUP_MS);

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ costUsd: 3, inputTokens: 150, sessionCount: 2 });
    });
  });

  describe('ActivityIntervalStore.getActiveTotals (the Avg Active tile)', () => {
    // Lives in this file rather than with the other interval-store tests
    // because those run against a hand-rolled fake `Database`, where an
    // aggregate test would only re-assert the fake's own arithmetic. This one
    // is a real SQLite aggregate, which is the thing that can be wrong.
    function insertInterval(
      sessionId: string,
      disposition: 'active' | 'idle',
      startedMs: number,
      durationMs: number | null,
    ): void {
      db.prepare(`
        INSERT INTO session_activity_intervals
          (session_id, task_id, disposition, state, previous_state, enter_trigger,
           started_ms, started_at, ended_ms, ended_at, duration_ms, exit_trigger, recorded_at)
        VALUES (?, 'task-1', ?, 'thinking', 'idle', 'test', ?, ?, ?, ?, ?, 'test', ?)
      `).run(
        sessionId,
        disposition,
        startedMs,
        new Date(startedMs).toISOString(),
        durationMs === null ? null : startedMs + durationMs,
        durationMs === null ? null : new Date(startedMs + durationMs).toISOString(),
        durationMs,
        new Date(startedMs).toISOString(),
      );
    }

    const BASE = Date.parse('2026-01-02T12:00:00.000Z');

    it('sums only active, closed intervals and counts the sessions they cover', () => {
      insertInterval('s1', 'active', BASE, 60_000);
      insertInterval('s1', 'idle', BASE + 60_000, 600_000);
      insertInterval('s2', 'active', BASE + 100_000, 30_000);
      // Open interval: a session still in that state, or one killed mid-state.
      // Its duration is unknowable, so it contributes neither time nor a
      // session - matching the MCP reader in activity-interval-commands.ts.
      insertInterval('s3', 'active', BASE + 200_000, null);

      const totals = new ActivityIntervalStore(db).getActiveTotals(null, null);
      expect(totals.activeMs).toBe(90_000);
      expect(totals.sessionsCovered).toBe(2);
    });

    it('counts a session once however many intervals it contributed', () => {
      insertInterval('s1', 'active', BASE, 10_000);
      insertInterval('s1', 'active', BASE + 20_000, 10_000);
      insertInterval('s1', 'active', BASE + 40_000, 10_000);

      const totals = new ActivityIntervalStore(db).getActiveTotals(null, null);
      expect(totals.activeMs).toBe(30_000);
      expect(totals.sessionsCovered).toBe(1);
    });

    it('windows on started_ms, inclusive since and exclusive until', () => {
      insertInterval('s1', 'active', BASE - 1, 5_000);
      insertInterval('s2', 'active', BASE, 7_000);
      insertInterval('s3', 'active', BASE + 1_000, 11_000);

      const totals = new ActivityIntervalStore(db).getActiveTotals(BASE, BASE + 1_000);
      expect(totals.activeMs).toBe(7_000);
      expect(totals.sessionsCovered).toBe(1);
    });

    it('reports zero coverage, not zero activity, for a range the ledger does not reach', () => {
      insertInterval('s1', 'active', BASE, 10_000);

      // The tile renders "-" on this rather than "0s": per-interval recording
      // shipped later than the usage ledger, so an old range has no data
      // rather than no activity.
      const totals = new ActivityIntervalStore(db).getActiveTotals(BASE + 1_000_000, null);
      expect(totals.activeMs).toBe(0);
      expect(totals.sessionsCovered).toBe(0);
    });
  });

  describe('countSessionsRepresented', () => {
    it('counts only ids with a ledger row INSIDE the window', () => {
      seedWindowFixture();
      // sess-1 in window; sess-6 exists but outside; sess-live-new absent.
      const count = repository.countSessionsRepresented(SINCE, UNTIL, ['sess-1', 'sess-6', 'sess-live-new']);
      expect(count).toBe(1);
    });

    it('counts across the whole ledger when the window is unbounded', () => {
      seedWindowFixture();
      expect(repository.countSessionsRepresented(null, null, ['sess-1', 'sess-6'])).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Skip-notice for environments where better-sqlite3 cannot load.
// ---------------------------------------------------------------------------

describe.runIf(!CAN_RUN)('UsageHistoryRepository aggregate tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
