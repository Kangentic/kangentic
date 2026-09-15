import type Database from 'better-sqlite3';
import type { ExternalIssue, ExternalSource } from '../../../shared/types';

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
      try {
        issues.push(JSON.parse(row.payload) as ExternalIssue);
      } catch {
        // A corrupted payload (e.g. a partial write from a crash) must not fail the
        // whole source's read; skip the bad row so the rest of the cache still paints.
      }
    }
    return issues;
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
        if (existing.has(issue.externalId)) updated++;
        else added++;
        const payload = JSON.stringify({ ...issue, alreadyImported: false });
        statement.run(
          source, repository, issue.externalId, issue.updatedAt, issue.stateCategory, payload, fetchedAt,
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

  /** Drop every cached row for a source (used before a full re-seed). */
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
