/**
 * Real-DB tests for ConversationUsageStore.getGroupedUsageSince's SQL-side
 * cost allocation (the usage_history LEFT JOIN that replaced the service's
 * buildSessionTokenTotals / allocateGroupCost JS maps) and its bucket-only
 * output (per-turn allocation summed per UTC bucket, so the result is
 * O(active buckets), never O(sessions x buckets)). Pins:
 *
 *   - proportional allocation by fresh-token share across the WHOLE queried
 *     window (not per bucket), reassembling each session's full cost;
 *   - $0 for a session with no ledger row inside the COST window, even when
 *     a ledger row exists outside it (the windowed-map semantics the old JS
 *     path had);
 *   - $0 for zero-cost sessions, unknown sessions, and NULL session ids;
 *   - the cost window being independent of the ts window;
 *   - cross-session merge into one bucket row, NULL-ts exclusion, and the
 *     UTC bucket grid.
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
import { ConversationUsageStore } from '../../src/main/retrieval/conversation/conversation-usage-store';
import { TURN_GROUP_MS } from '../../src/main/usage-stats/bucketing';

const SINCE_ISO = '2026-01-02T00:00:00.000Z';
const UNTIL_ISO = '2026-01-04T00:00:00.000Z';
const T0 = Date.parse('2026-01-02T09:00:00.000Z');

describe.runIf(CAN_RUN)('ConversationUsageStore.getGroupedUsageSince cost allocation (real DB)', () => {
  let db: InstanceType<typeof DatabaseType>;
  let store: ConversationUsageStore;

  function insertLedgerRow(sessionRecordId: string, sessionStartedAt: string, totalCostUsd: number): void {
    db.prepare(`
      INSERT INTO usage_history (id, session_record_id, recorded_at, session_started_at, total_cost_usd)
      VALUES (?, ?, '2026-01-05T00:00:00.000Z', ?, ?)
    `).run(`id-${sessionRecordId}`, sessionRecordId, sessionStartedAt, totalCostUsd);
  }

  function insertTurn(turnUuid: string, sessionId: string | null, ts: number | null, inputTokens: number, outputTokens: number, cacheCreation = 0, cacheRead = 0): void {
    db.prepare(`
      INSERT INTO conversation_turn_usage (turn_uuid, session_id, model, ts,
        input_tokens, output_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, recorded_at)
      VALUES (?, ?, 'model-x', ?, ?, ?, ?, ?, '2026-01-05T00:00:00.000Z')
    `).run(turnUuid, sessionId, ts, inputTokens, outputTokens, cacheCreation, cacheRead);
  }

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
    store = new ConversationUsageStore(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('splits a session cost across its groups proportionally by fresh-token share', () => {
    insertLedgerRow('sess-1', '2026-01-02T09:00:00.000Z', 1.5);
    // 300 fresh tokens in bucket 1, 100 in bucket 2 -> 1.5 splits 3:1.
    insertTurn('t1', 'sess-1', T0 + 60_000, 200, 100);
    insertTurn('t2', 'sess-1', T0 + 6 * 60_000, 80, 20);

    const groups = store.getGroupedUsageSince(
      Date.parse(SINCE_ISO), TURN_GROUP_MS, Date.parse(UNTIL_ISO), SINCE_ISO, UNTIL_ISO,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0].allocatedCostUsd).toBeCloseTo(1.5 * (300 / 400), 12);
    expect(groups[1].allocatedCostUsd).toBeCloseTo(1.5 * (100 / 400), 12);
    // The shares reassemble the session's full reported cost.
    expect(groups[0].allocatedCostUsd + groups[1].allocatedCostUsd).toBeCloseTo(1.5, 12);
  });

  it('allocates $0 when the session has no ledger row INSIDE the cost window (row exists outside)', () => {
    // Ledger row started before the window: visible in the table, invisible
    // to this window's cost map - exactly like the old windowed-row JS map.
    insertLedgerRow('sess-outside', '2026-01-01T10:00:00.000Z', 3.0);
    insertTurn('t1', 'sess-outside', T0 + 60_000, 100, 50);

    const windowed = store.getGroupedUsageSince(
      Date.parse(SINCE_ISO), TURN_GROUP_MS, Date.parse(UNTIL_ISO), SINCE_ISO, UNTIL_ISO,
    );
    expect(windowed).toHaveLength(1);
    expect(windowed[0].allocatedCostUsd).toBe(0);

    // The same read with an unbounded cost window (All Time) allocates it.
    const unbounded = store.getGroupedUsageSince(
      Date.parse(SINCE_ISO), TURN_GROUP_MS, Date.parse(UNTIL_ISO), null, null,
    );
    expect(unbounded[0].allocatedCostUsd).toBeCloseTo(3.0, 12);
  });

  it('allocates $0 for zero-cost sessions, unknown sessions, and NULL session ids (merged into one bucket row)', () => {
    insertLedgerRow('sess-zero', '2026-01-02T09:00:00.000Z', 0);
    insertTurn('t1', 'sess-zero', T0 + 60_000, 100, 50);
    insertTurn('t2', 'sess-unknown', T0 + 60_000, 40, 10);
    insertTurn('t3', null, T0 + 60_000, 30, 5);

    const groups = store.getGroupedUsageSince(null, TURN_GROUP_MS, null, null, null);

    // Bucket-only output: all three same-bucket turns fold into one row.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ inputTokens: 170, outputTokens: 65, turnCount: 3 });
    expect(groups[0].allocatedCostUsd).toBe(0);
  });

  it('keeps the grouping behavior: NULL ts excluded, UTC grid buckets, per-bucket token sums', () => {
    insertLedgerRow('sess-1', '2026-01-02T09:00:00.000Z', 2);
    insertTurn('t1', 'sess-1', T0 + 60_000, 10, 5, 7, 900);
    insertTurn('t2', 'sess-1', T0 + 120_000, 20, 15, 3, 100);
    insertTurn('t-null-ts', 'sess-1', null, 999, 999);

    const groups = store.getGroupedUsageSince(null, TURN_GROUP_MS, null, null, null);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      bucketStartMs: Math.floor((T0 + 60_000) / TURN_GROUP_MS) * TURN_GROUP_MS,
      inputTokens: 30,
      outputTokens: 20,
      cacheCreationTokens: 10,
      cacheReadTokens: 1000,
      turnCount: 2,
    });
    expect(groups[0].bucketStartMs % TURN_GROUP_MS).toBe(0);
    // The NULL-ts turn contributed nothing (it cannot sit on a time axis).
    expect(groups[0].allocatedCostUsd).toBeCloseTo(2, 12);
  });

  it('merges turns from DIFFERENT sessions in the same bucket, summing their independent cost shares', () => {
    insertLedgerRow('sess-a', '2026-01-02T09:00:00.000Z', 1);
    insertLedgerRow('sess-b', '2026-01-02T09:01:00.000Z', 3);
    // sess-a: all tokens in this bucket -> full $1. sess-b: half its tokens
    // here (100 of 200) -> $1.5. Bucket total = $2.5.
    insertTurn('t1', 'sess-a', T0 + 60_000, 50, 0);
    insertTurn('t2', 'sess-b', T0 + 60_000, 100, 0);
    insertTurn('t3', 'sess-b', T0 + TURN_GROUP_MS + 60_000, 100, 0);

    const groups = store.getGroupedUsageSince(null, TURN_GROUP_MS, null, null, null);

    expect(groups).toHaveLength(2);
    expect(groups[0].allocatedCostUsd).toBeCloseTo(1 + 1.5, 12);
    expect(groups[1].allocatedCostUsd).toBeCloseTo(1.5, 12);
    expect(groups[0].turnCount).toBe(2);
  });

  it('token-share totals span the whole queried ts window, not just one bucket', () => {
    insertLedgerRow('sess-1', '2026-01-02T09:00:00.000Z', 4);
    insertTurn('t1', 'sess-1', T0, 100, 0);
    insertTurn('t2', 'sess-1', T0 + TURN_GROUP_MS, 300, 0);

    // Bounding ts to ONLY the first bucket changes the share denominator to
    // that bucket alone: the surviving group carries the full cost.
    const bounded = store.getGroupedUsageSince(T0, TURN_GROUP_MS, T0 + TURN_GROUP_MS, null, null);
    expect(bounded).toHaveLength(1);
    expect(bounded[0].allocatedCostUsd).toBeCloseTo(4, 12);

    const full = store.getGroupedUsageSince(T0, TURN_GROUP_MS, T0 + 2 * TURN_GROUP_MS, null, null);
    expect(full).toHaveLength(2);
    expect(full[0].allocatedCostUsd).toBeCloseTo(1, 12);
    expect(full[1].allocatedCostUsd).toBeCloseTo(3, 12);
  });
});

// ---------------------------------------------------------------------------
// Skip-notice for environments where better-sqlite3 cannot load.
// ---------------------------------------------------------------------------

describe.runIf(!CAN_RUN)('ConversationUsageStore cost allocation tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
