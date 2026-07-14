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

    it('sums tokens/cost and counts sessions within one dimension combo', () => {
      insertUsage({ sessionRecordId: 'a', sessionStartedAt: '2026-01-02T10:00:00.000Z', totalCostUsd: 1, totalInputTokens: 100, totalOutputTokens: 10, modelId: 'm', modelDisplayName: 'M', agent: 'claude', effort: 'high' });
      insertUsage({ sessionRecordId: 'b', sessionStartedAt: '2026-01-02T11:00:00.000Z', totalCostUsd: 2, totalInputTokens: 200, totalOutputTokens: 20, modelId: 'm', modelDisplayName: 'M', agent: 'claude', effort: 'high' });
      const rollup = repository.listUsageRollup(SINCE, UNTIL);

      expect(rollup).toHaveLength(1);
      expect(rollup[0]).toMatchObject({ inputTokens: 300, outputTokens: 30, costUsd: 3, sessionCount: 2 });
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
