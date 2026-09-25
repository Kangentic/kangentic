import type Database from 'better-sqlite3';
import type { ExternalIssue, ExternalSource } from '../../../shared/types';

/**
 * Canonicalize a provider timestamp to UTC ISO 8601 before it becomes a
 * `remote_updated_at` value. The column is TEXT, so `MAX()` and `ORDER BY`
 * compare it lexicographically: a provider that ever emitted an offset form
 * (`+02:00`) or a different sub-second precision would sort against the `Z`
 * forms wrongly and hand the reconcile a watermark that skips items. Every live
 * adapter emits `Z` today, so this normalizes what is already canonical rather
 * than fixing a live bug, and an unparseable value is kept verbatim so a new
 * provider's format is visible rather than silently rewritten to an epoch.
 */
function normalizeRemoteTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * A cached payload is JSON we wrote, but it is still a parse boundary: the row
 * may predate a field the current `ExternalIssue` requires. Check the two fields
 * the dialog cannot function without rather than casting blind - a row whose
 * `stateCategory` is missing or unrecognized would otherwise match neither the
 * Open nor the Closed filter and vanish from both while still showing under All.
 */
function isUsableCachedIssue(value: unknown): value is ExternalIssue {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExternalIssue>;
  return typeof candidate.externalId === 'string'
    && (candidate.stateCategory === 'open' || candidate.stateCategory === 'closed');
}

/**
 * Persistent cache of remote board items (the `remote_item_cache` table) for the
 * Import dialog, keyed by (external_source, repository, external_id). Lets the
 * dialog paint instantly on open and reconcile only items changed since the
 * cache's high-water mark.
 *
 * `alreadyImported` is never persisted (it is re-stamped from the live backlog on
 * every read); `upsertMany` forces it false before serializing.
 */
export class RemoteItemCacheRepository {
  constructor(private db: Database.Database) {}

  /** All cached items for a source, newest-changed first. */
  getForSource(source: ExternalSource, repository: string): ExternalIssue[] {
    const rows = this.db.prepare(
      'SELECT payload FROM remote_item_cache WHERE external_source = ? AND repository = ? ORDER BY remote_updated_at DESC',
    ).all(source, repository) as Array<{ payload: string }>;
    const issues: ExternalIssue[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        // A corrupted payload (e.g. a partial write from a crash) must not fail the
        // whole source's read; skip the bad row so the rest of the cache still paints.
        continue;
      }
      // Same reasoning for a payload that parses but no longer matches the shape.
      // Warn rather than dropping it silently: the row still counts toward the
      // cache size and is not prunable, so on a provider that only ever fetches
      // changed items it stays invisible until that item changes remotely, and the
      // symptom ("an item vanished from the list") gives no other clue.
      if (isUsableCachedIssue(parsed)) {
        issues.push(parsed);
      } else {
        console.warn('[RemoteItemCacheRepository] skipping a cached row with an unusable shape');
      }
    }
    return issues;
  }

  /**
   * The oldest `fetched_at` still in the cache for a source. A full reconcile
   * stamps every row with one sync time, so this is when the cache was last known
   * complete: an incremental pass only re-stamps the rows it touched, leaving the
   * untouched ones at the previous full sync. The reconcile uses it to decide when
   * a provider with no cheap id listing is overdue for an authoritative pass.
   * Undefined when the cache is empty.
   */
  getOldestFetchedAt(source: ExternalSource, repository: string): string | undefined {
    const row = this.db.prepare(
      'SELECT MIN(fetched_at) AS oldest FROM remote_item_cache WHERE external_source = ? AND repository = ?',
    ).get(source, repository) as { oldest: string | null } | undefined;
    return row?.oldest ?? undefined;
  }

  /**
   * The most recent remote change timestamp in the cache, used as the `since`
   * watermark for an incremental reconcile. Anchored to the remote's own
   * timestamps, not our wall clock, so it is immune to clock skew. Undefined when
   * the cache is empty.
   */
  getWatermark(source: ExternalSource, repository: string): string | undefined {
    const row = this.db.prepare(
      'SELECT MAX(remote_updated_at) AS watermark FROM remote_item_cache WHERE external_source = ? AND repository = ?',
    ).get(source, repository) as { watermark: string | null } | undefined;
    return row?.watermark ?? undefined;
  }

  count(source: ExternalSource, repository: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS c FROM remote_item_cache WHERE external_source = ? AND repository = ?',
    ).get(source, repository) as { c: number };
    return row.c;
  }

  /**
   * Insert new items and overwrite existing ones (matched on the composite key),
   * returning how many were new vs updated. `fetchedAt` is the caller's single
   * ISO-8601 sync timestamp for the whole batch.
   */
  upsertMany(
    source: ExternalSource,
    repository: string,
    issues: ExternalIssue[],
    fetchedAt: string,
  ): { added: number; updated: number } {
    if (issues.length === 0) return { added: 0, updated: 0 };
    const existing = this.cachedIds(source, repository);
    let added = 0;
    let updated = 0;
    // `state_category` duplicates the `stateCategory` inside `payload`, which is
    // the copy the dialog actually filters on. It stays written because the column
    // is NOT NULL and the table is created with `IF NOT EXISTS`: any database that
    // already has the table keeps its original shape, so omitting the column here
    // would fail the NOT NULL constraint on every upsert rather than migrate it.
    const statement = this.db.prepare(`
      INSERT INTO remote_item_cache
        (external_source, repository, external_id, remote_updated_at, state_category, payload, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_source, repository, external_id) DO UPDATE SET
        remote_updated_at = excluded.remote_updated_at,
        state_category = excluded.state_category,
        payload = excluded.payload,
        fetched_at = excluded.fetched_at
    `);
    const runAll = this.db.transaction((list: ExternalIssue[]) => {
      for (const issue of list) {
        // Track ids as they land, so a duplicate inside one batch counts as an
        // update on its second appearance rather than a second insert. The
        // reconcile dedupes before calling this, so the snapshot alone was right in
        // practice, but the count belongs to this method's contract, not its caller's.
        if (existing.has(issue.externalId)) {
          updated++;
        } else {
          added++;
          existing.add(issue.externalId);
        }
        const payload = JSON.stringify({ ...issue, alreadyImported: false });
        statement.run(
          source, repository, issue.externalId, normalizeRemoteTimestamp(issue.updatedAt),
          issue.stateCategory, payload, fetchedAt,
        );
      }
    });
    runAll(issues);
    return { added, updated };
  }

  /**
   * Delete cached rows whose external_id is not in `keepIds` (the current remote
   * set), so items deleted on the remote clear from the cache. Returns the number
   * removed.
   */
  pruneMissing(source: ExternalSource, repository: string, keepIds: string[]): number {
    const keep = new Set(keepIds);
    const toDelete = [...this.cachedIds(source, repository)].filter((id) => !keep.has(id));
    if (toDelete.length === 0) return 0;
    const statement = this.db.prepare(
      'DELETE FROM remote_item_cache WHERE external_source = ? AND repository = ? AND external_id = ?',
    );
    const runAll = this.db.transaction((ids: string[]) => {
      for (const id of ids) statement.run(source, repository, id);
    });
    runAll(toDelete);
    return toDelete.length;
  }

  /**
   * Drop every cached row for a source. The reconcile does not use this: a full
   * pass prunes against its own fetched set instead, so the cache is never empty
   * between the delete and the re-seed. Kept as the explicit reset primitive for
   * tests and for a future "forget this source" action.
   */
  clear(source: ExternalSource, repository: string): void {
    this.db.prepare(
      'DELETE FROM remote_item_cache WHERE external_source = ? AND repository = ?',
    ).run(source, repository);
  }

  private cachedIds(source: ExternalSource, repository: string): Set<string> {
    const rows = this.db.prepare(
      'SELECT external_id FROM remote_item_cache WHERE external_source = ? AND repository = ?',
    ).all(source, repository) as Array<{ external_id: string }>;
    return new Set(rows.map((row) => row.external_id));
  }
}
