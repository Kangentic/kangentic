/**
 * RemoteItemCacheRepository behavior: upsert (added vs updated), the MAX
 * high-water mark used as the reconcile `since`, prune of vanished items, and the
 * invariant that `alreadyImported` is never persisted.
 *
 * better-sqlite3 cannot load under vitest (it is compiled for Electron's Node
 * ABI), so this runs against a small in-memory fake DB that interprets exactly
 * the queries the repository issues, mirroring the SQL-mock approach in
 * tests/unit/backlog-import-promote-dedup.test.ts but keeping real row behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { ExternalIssue } from '../../src/shared/types';
import { RemoteItemCacheRepository } from '../../src/main/db/repositories/remote-item-cache-repository';

interface CacheRow {
  external_source: string;
  repository: string;
  external_id: string;
  remote_updated_at: string;
  state_category: string;
  payload: string;
  fetched_at: string;
}

/** In-memory fake that implements only the query shapes the repository uses. */
function createFakeDb(): Database.Database {
  const rows: CacheRow[] = [];
  const match = (args: unknown[]) => rows.filter(
    (row) => row.external_source === args[0] && row.repository === args[1],
  );
  const db = {
    prepare(sql: string) {
      return {
        all: (...args: unknown[]) => {
          if (sql.includes('SELECT payload')) {
            return match(args)
              .slice()
              .sort((a, b) => (a.remote_updated_at < b.remote_updated_at ? 1 : -1))
              .map((row) => ({ payload: row.payload }));
          }
          if (sql.includes('SELECT external_id')) {
            return match(args).map((row) => ({ external_id: row.external_id }));
          }
          return [];
        },
        get: (...args: unknown[]) => {
          if (sql.includes('MAX(remote_updated_at)')) {
            const values = match(args).map((row) => row.remote_updated_at);
            return { watermark: values.length ? values.reduce((a, b) => (a > b ? a : b)) : null };
          }
          if (sql.includes('COUNT(*)')) {
            return { c: match(args).length };
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (sql.trimStart().startsWith('INSERT')) {
            const [external_source, repository, external_id, remote_updated_at, state_category, payload, fetched_at] =
              args as string[];
            const existing = rows.find(
              (row) => row.external_source === external_source && row.repository === repository && row.external_id === external_id,
            );
            if (existing) {
              Object.assign(existing, { remote_updated_at, state_category, payload, fetched_at });
            } else {
              rows.push({ external_source, repository, external_id, remote_updated_at, state_category, payload, fetched_at });
            }
          } else if (sql.includes('DELETE') && sql.includes('external_id = ?')) {
            const [external_source, repository, external_id] = args as string[];
            const idx = rows.findIndex(
              (row) => row.external_source === external_source && row.repository === repository && row.external_id === external_id,
            );
            if (idx >= 0) rows.splice(idx, 1);
          } else if (sql.includes('DELETE')) {
            const [external_source, repository] = args as string[];
            for (let i = rows.length - 1; i >= 0; i--) {
              if (rows[i].external_source === external_source && rows[i].repository === repository) rows.splice(i, 1);
            }
          }
          return { changes: 0, lastInsertRowid: 0 };
        },
      };
    },
    transaction<T extends (arg: never) => unknown>(fn: T): T {
      return fn;
    },
  };
  return db as unknown as Database.Database;
}

function makeIssue(overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    externalId: '1',
    externalSource: 'azure_devops',
    externalUrl: 'https://dev.azure.com/org/proj/_workitems/edit/1',
    title: 'Item 1',
    body: 'Body',
    labels: [],
    assignee: null,
    state: 'Active',
    stateCategory: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    alreadyImported: false,
    attachmentCount: 0,
    ...overrides,
  };
}

const SOURCE = 'azure_devops';
const REPO = 'org/proj';

describe('RemoteItemCacheRepository', () => {
  let repo: RemoteItemCacheRepository;

  beforeEach(() => {
    repo = new RemoteItemCacheRepository(createFakeDb());
  });

  it('reports every item as added on an empty cache and returns them newest-first', () => {
    const result = repo.upsertMany(SOURCE, REPO, [
      makeIssue({ externalId: '1', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeIssue({ externalId: '2', updatedAt: '2026-01-03T00:00:00.000Z' }),
      makeIssue({ externalId: '3', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ], '2026-02-01T00:00:00.000Z');

    expect(result).toEqual({ added: 3, updated: 0 });
    expect(repo.getForSource(SOURCE, REPO).map((issue) => issue.externalId)).toEqual(['2', '3', '1']);
  });

  it('splits added vs updated on a second upsert', () => {
    repo.upsertMany(SOURCE, REPO, [makeIssue({ externalId: '1' })], '2026-02-01T00:00:00.000Z');
    const result = repo.upsertMany(SOURCE, REPO, [
      makeIssue({ externalId: '1', updatedAt: '2026-01-05T00:00:00.000Z' }),
      makeIssue({ externalId: '2' }),
    ], '2026-02-02T00:00:00.000Z');

    expect(result).toEqual({ added: 1, updated: 1 });
    expect(repo.count(SOURCE, REPO)).toBe(2);
  });

  it('never persists alreadyImported (always stores false)', () => {
    repo.upsertMany(SOURCE, REPO, [makeIssue({ externalId: '1', alreadyImported: true })], '2026-02-01T00:00:00.000Z');
    expect(repo.getForSource(SOURCE, REPO)[0].alreadyImported).toBe(false);
  });

  it('overwrites state on a state change (single bucket)', () => {
    repo.upsertMany(SOURCE, REPO, [makeIssue({ externalId: '1', state: 'Active', stateCategory: 'open' })], '2026-02-01T00:00:00.000Z');
    repo.upsertMany(SOURCE, REPO, [makeIssue({ externalId: '1', state: 'Closed', stateCategory: 'closed', updatedAt: '2026-01-06T00:00:00.000Z' })], '2026-02-02T00:00:00.000Z');

    const stored = repo.getForSource(SOURCE, REPO);
    expect(stored).toHaveLength(1);
    expect(stored[0].stateCategory).toBe('closed');
  });

  it('reports the MAX remote_updated_at as the watermark', () => {
    expect(repo.getWatermark(SOURCE, REPO)).toBeUndefined();
    repo.upsertMany(SOURCE, REPO, [
      makeIssue({ externalId: '1', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeIssue({ externalId: '2', updatedAt: '2026-03-09T00:00:00.000Z' }),
      makeIssue({ externalId: '3', updatedAt: '2026-02-15T00:00:00.000Z' }),
    ], '2026-04-01T00:00:00.000Z');
    expect(repo.getWatermark(SOURCE, REPO)).toBe('2026-03-09T00:00:00.000Z');
  });

  it('prunes cached rows not present in the current id set', () => {
    repo.upsertMany(SOURCE, REPO, [
      makeIssue({ externalId: '1' }),
      makeIssue({ externalId: '2' }),
      makeIssue({ externalId: '3' }),
    ], '2026-02-01T00:00:00.000Z');

    const removed = repo.pruneMissing(SOURCE, REPO, ['1', '3']);
    expect(removed).toBe(1);
    expect(repo.getForSource(SOURCE, REPO).map((issue) => issue.externalId).sort()).toEqual(['1', '3']);
  });

  it('prunes nothing when every cached id is still present', () => {
    repo.upsertMany(SOURCE, REPO, [makeIssue({ externalId: '1' }), makeIssue({ externalId: '2' })], '2026-02-01T00:00:00.000Z');
    expect(repo.pruneMissing(SOURCE, REPO, ['1', '2'])).toBe(0);
  });

  it('is a no-op for an empty upsert', () => {
    expect(repo.upsertMany(SOURCE, REPO, [], '2026-02-01T00:00:00.000Z')).toEqual({ added: 0, updated: 0 });
    expect(repo.count(SOURCE, REPO)).toBe(0);
  });

  it('skips a corrupt payload row and returns the valid ones, without throwing', () => {
    const db = createFakeDb();
    const corruptRepo = new RemoteItemCacheRepository(db);
    corruptRepo.upsertMany(SOURCE, REPO, [
      makeIssue({ externalId: '1', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeIssue({ externalId: '2', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ], '2026-02-01T00:00:00.000Z');

    // Bypass upsertMany's JSON.stringify to plant a corrupted payload (e.g. a
    // partial write from a crash) alongside the valid rows.
    db.prepare(
      'INSERT INTO remote_item_cache (external_source, repository, external_id, remote_updated_at, state_category, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(SOURCE, REPO, '3', '2026-01-03T00:00:00.000Z', 'open', '{not valid json', '2026-02-01T00:00:00.000Z');

    let issues: ExternalIssue[] = [];
    expect(() => { issues = corruptRepo.getForSource(SOURCE, REPO); }).not.toThrow();
    expect(issues.map((issue) => issue.externalId).sort()).toEqual(['1', '2']);
  });

  it('scopes rows by (source, repository)', () => {
    repo.upsertMany(SOURCE, REPO, [makeIssue({ externalId: '1' })], '2026-02-01T00:00:00.000Z');
    repo.upsertMany('github_issues', 'owner/repo', [makeIssue({ externalId: '1', externalSource: 'github_issues' })], '2026-02-01T00:00:00.000Z');
    expect(repo.count(SOURCE, REPO)).toBe(1);
    expect(repo.count('github_issues', 'owner/repo')).toBe(1);
    repo.clear(SOURCE, REPO);
    expect(repo.count(SOURCE, REPO)).toBe(0);
    expect(repo.count('github_issues', 'owner/repo')).toBe(1);
  });
});
