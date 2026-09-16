/**
 * BACKLOG_IMPORT_RECONCILE / BACKLOG_IMPORT_GET_CACHED handler behavior.
 *
 * Verifies the reconcile orchestration without a DB or network: the `since`
 * watermark (incremental) vs full re-fetch, multi-page accumulation, the
 * auto-prune paths (cheap id-list vs full-only), and the alreadyImported re-stamp
 * on every read. Uses the captured-IPC-handler pattern from
 * tests/unit/backlog-import-promote-dedup.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExternalIssue, ExternalSource } from '../../src/shared/types';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => false), readFileSync: vi.fn(() => Buffer.from('')), mkdirSync: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

const backlogRepoMock = { findByExternalIds: vi.fn(() => new Set<string>()) };
const cacheRepoMock = {
  count: vi.fn((_source: ExternalSource, _repository: string) => 0),
  getWatermark: vi.fn((_source: ExternalSource, _repository: string) => undefined as string | undefined),
  getOldestFetchedAt: vi.fn((_source: ExternalSource, _repository: string) => undefined as string | undefined),
  upsertMany: vi.fn(
    (_source: ExternalSource, _repository: string, _issues: ExternalIssue[], _fetchedAt: string) => ({ added: 0, updated: 0 }),
  ),
  pruneMissing: vi.fn((_source: ExternalSource, _repository: string, _keepIds: string[]) => 0),
  getForSource: vi.fn((_source: ExternalSource, _repository: string) => [] as ExternalIssue[]),
};

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class { findByExternalIds = backlogRepoMock.findByExternalIds; },
}));
vi.mock('../../src/main/db/repositories/remote-item-cache-repository', () => ({
  RemoteItemCacheRepository: class {
    count = cacheRepoMock.count;
    getWatermark = cacheRepoMock.getWatermark;
    getOldestFetchedAt = cacheRepoMock.getOldestFetchedAt;
    upsertMany = cacheRepoMock.upsertMany;
    pruneMissing = cacheRepoMock.pruneMissing;
    getForSource = cacheRepoMock.getForSource;
  },
}));
// The remaining repos backlog.ts imports are type-only at runtime here; stub the
// ones with real side effects to keep the module load clean.
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({ BacklogAttachmentRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({ withTaskLock: vi.fn() }));

let adapter: {
  fetch: ReturnType<typeof vi.fn>;
  listExternalIds?: ReturnType<typeof vi.fn>;
  hydrateForImport?: ReturnType<typeof vi.fn>;
};

vi.mock('../../src/main/boards', () => ({
  boardRegistry: { requireStable: vi.fn(() => adapter), get: vi.fn(() => null) },
  ImportSourceStore: class { list = vi.fn(() => []); add = vi.fn(); remove = vi.fn(); updateLabel = vi.fn(); },
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function makeIssue(overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    externalId: '1',
    externalSource: 'azure_devops',
    externalUrl: 'https://dev.azure.com/org/proj/_workitems/edit/1',
    title: 'Item',
    body: '',
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

const context = { currentProjectId: 'proj-1', currentProjectPath: '/mock/proj' } as unknown as IpcContext;
const INPUT = { source: 'azure_devops' as const, repository: 'org/proj' };

function reconcileHandler() {
  const handler = capturedHandlers.get(IPC.BACKLOG_IMPORT_RECONCILE);
  if (!handler) throw new Error('reconcile handler not registered');
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  backlogRepoMock.findByExternalIds.mockReturnValue(new Set<string>());
  cacheRepoMock.count.mockReturnValue(0);
  cacheRepoMock.getWatermark.mockReturnValue(undefined);
  cacheRepoMock.getOldestFetchedAt.mockReturnValue(undefined);
  cacheRepoMock.upsertMany.mockReturnValue({ added: 0, updated: 0 });
  cacheRepoMock.pruneMissing.mockReturnValue(0);
  cacheRepoMock.getForSource.mockReturnValue([]);
  adapter = { fetch: vi.fn(async () => ({ issues: [], totalCount: 0, hasNextPage: false })) };
  registerBacklogHandlers(context);
});

describe('importReconcile', () => {
  it('passes the watermark as `since` on an incremental reconcile of a non-empty cache', async () => {
    cacheRepoMock.count.mockReturnValue(5);
    cacheRepoMock.getWatermark.mockReturnValue('2026-03-01T00:00:00.000Z');
    adapter.listExternalIds = vi.fn(async () => ['1']);

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    const fetchInput = adapter.fetch.mock.calls[0][0];
    expect(fetchInput.since).toBe('2026-03-01T00:00:00.000Z');
    expect(fetchInput.state).toBe('all');
  });

  it('treats an empty cache as a full fetch (no `since`)', async () => {
    cacheRepoMock.count.mockReturnValue(0);
    cacheRepoMock.getWatermark.mockReturnValue('2026-03-01T00:00:00.000Z');

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(adapter.fetch.mock.calls[0][0].since).toBeUndefined();
  });

  it('ignores the watermark in full mode', async () => {
    cacheRepoMock.count.mockReturnValue(5);
    cacheRepoMock.getWatermark.mockReturnValue('2026-03-01T00:00:00.000Z');

    await reconcileHandler()(null, { ...INPUT, mode: 'full' });

    expect(adapter.fetch.mock.calls[0][0].since).toBeUndefined();
  });

  it('accumulates across pages until hasNextPage is false', async () => {
    adapter.fetch = vi.fn()
      .mockResolvedValueOnce({ issues: [makeIssue({ externalId: '1' })], totalCount: 2, hasNextPage: true })
      .mockResolvedValueOnce({ issues: [makeIssue({ externalId: '2' })], totalCount: 2, hasNextPage: false });

    await reconcileHandler()(null, { ...INPUT, mode: 'full' });

    expect(adapter.fetch).toHaveBeenCalledTimes(2);
    expect(adapter.fetch.mock.calls[0][0].page).toBe(1);
    expect(adapter.fetch.mock.calls[1][0].page).toBe(2);
    const upserted = cacheRepoMock.upsertMany.mock.calls[0][2] as ExternalIssue[];
    expect(upserted.map((issue) => issue.externalId)).toEqual(['1', '2']);
  });

  it('prunes against the cheap id-list when the adapter provides one', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    adapter.listExternalIds = vi.fn(async () => ['1', '2']);

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(adapter.listExternalIds).toHaveBeenCalledOnce();
    expect(cacheRepoMock.pruneMissing).toHaveBeenCalledWith('azure_devops', 'org/proj', ['1', '2']);
  });

  it('does not prune on an incremental reconcile when the adapter has no id-list', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    // no adapter.listExternalIds

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(cacheRepoMock.pruneMissing).not.toHaveBeenCalled();
  });

  // "The remote really is empty" and "the provider could not answer" both arrive as
  // an empty array, and pruning against it deletes every cached row for the source.
  // Skipping costs a stale row for one round; not skipping costs the whole cache.
  it('does not prune when the cheap id-list comes back empty', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    adapter.listExternalIds = vi.fn(async () => []);

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(adapter.listExternalIds).toHaveBeenCalledOnce();
    expect(cacheRepoMock.pruneMissing).not.toHaveBeenCalled();
  });

  // Same asymmetry on the other prune branch: a full fetch that returned nothing
  // while the cache holds rows is far more likely a transient failure than a real
  // mass deletion.
  it('does not prune on a full reconcile whose fetch returned nothing', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    adapter.fetch = vi.fn(async () => ({ issues: [], totalCount: 0, hasNextPage: false }));

    await reconcileHandler()(null, { ...INPUT, mode: 'full' });

    expect(cacheRepoMock.pruneMissing).not.toHaveBeenCalled();
  });

  // Providers without a cheap id listing prune only on a full pass, and the only UI
  // that asks for one is the all-imported empty state a subset-importer never sees.
  // Escalating on staleness is what stops a deleted item living in the cache forever.
  it('escalates to a full fetch when a cache with no id-list provider goes stale', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    cacheRepoMock.getWatermark.mockReturnValue('2026-03-01T00:00:00.000Z');
    cacheRepoMock.getOldestFetchedAt.mockReturnValue(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    // no adapter.listExternalIds

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(adapter.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ since: undefined }),
      expect.any(Function),
    );
  });

  it('stays incremental when a stale cache belongs to a provider that prunes every round', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    cacheRepoMock.getWatermark.mockReturnValue('2026-03-01T00:00:00.000Z');
    cacheRepoMock.getOldestFetchedAt.mockReturnValue(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    adapter.listExternalIds = vi.fn(async () => ['1']);

    await reconcileHandler()(null, { ...INPUT, mode: 'incremental' });

    expect(adapter.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ since: '2026-03-01T00:00:00.000Z' }),
      expect.any(Function),
    );
  });

  // The watermark must never advance past items that never landed, so a failure on
  // any page has to discard the whole round rather than commit the pages before it.
  it('commits nothing when a later page of the fetch rejects', async () => {
    cacheRepoMock.count.mockReturnValue(3);
    adapter.fetch = vi.fn()
      .mockResolvedValueOnce({ issues: [makeIssue({ externalId: '1' })], totalCount: 2, hasNextPage: true })
      .mockRejectedValueOnce(new Error('rate limited'));

    await expect(reconcileHandler()(null, { ...INPUT, mode: 'incremental' })).rejects.toThrow('rate limited');
    expect(cacheRepoMock.upsertMany).not.toHaveBeenCalled();
    expect(cacheRepoMock.pruneMissing).not.toHaveBeenCalled();
  });

  it('prunes against the fetched set on a full reconcile without an id-list', async () => {
    adapter.fetch = vi.fn(async () => ({
      issues: [makeIssue({ externalId: '1' }), makeIssue({ externalId: '2' })],
      totalCount: 2,
      hasNextPage: false,
    }));

    await reconcileHandler()(null, { ...INPUT, mode: 'full' });

    expect(cacheRepoMock.pruneMissing).toHaveBeenCalledWith('azure_devops', 'org/proj', ['1', '2']);
  });

  it('dedupes a page-overlap duplicate before upsert (added counts it once, cache ends with one row)', async () => {
    // Mirrors the REAL RemoteItemCacheRepository.upsertMany: `existing` is
    // captured once from the cache's current keys BEFORE the batch loop runs,
    // so a batch containing the same externalId twice counts `added` TWICE
    // even though the row only ends up written once (the second write just
    // overwrites the first). This is what makes the handler's own
    // dedupe-by-externalId step (before calling upsertMany) observable: only
    // that step can keep `added` at 1 here.
    const cacheState = new Map<string, ExternalIssue>();
    cacheRepoMock.upsertMany.mockImplementation((_source, _repository, issues) => {
      const existingBefore = new Set(cacheState.keys());
      let added = 0;
      let updated = 0;
      for (const issue of issues) {
        if (existingBefore.has(issue.externalId)) updated++;
        else added++;
        cacheState.set(issue.externalId, issue);
      }
      return { added, updated };
    });
    cacheRepoMock.getForSource.mockImplementation(() => [...cacheState.values()]);

    // Same externalId shows up on two sequential pages - an ordering shift
    // mid-sync, which real sources can produce.
    adapter.fetch = vi.fn()
      .mockResolvedValueOnce({ issues: [makeIssue({ externalId: '1', title: 'first fetch' })], totalCount: 1, hasNextPage: true })
      .mockResolvedValueOnce({ issues: [makeIssue({ externalId: '1', title: 'second fetch' })], totalCount: 1, hasNextPage: false });

    const result = await reconcileHandler()(null, { ...INPUT, mode: 'full' }) as { added: number; issues: ExternalIssue[] };

    expect(result.added).toBe(1);
    expect(cacheState.size).toBe(1);
    expect(result.issues).toHaveLength(1);
  });

  it('resolves with removed=0 (not a rejection) when the prune step throws', async () => {
    // adapter.fetch succeeds and its result is already committed; a transient
    // failure listing the current remote ids (the prune step) must not fail
    // the whole reconcile and hide the just-synced data.
    adapter.fetch = vi.fn(async () => ({
      issues: [makeIssue({ externalId: '1' })],
      totalCount: 1,
      hasNextPage: false,
    }));
    adapter.listExternalIds = vi.fn(async () => {
      throw new Error('transient CLI failure listing ids');
    });
    cacheRepoMock.upsertMany.mockReturnValue({ added: 1, updated: 0 });
    cacheRepoMock.getForSource.mockReturnValue([makeIssue({ externalId: '1' })]);

    const result = await reconcileHandler()(null, { ...INPUT, mode: 'full' }) as {
      issues: ExternalIssue[];
      added: number;
      updated: number;
      removed: number;
    };

    expect(result.removed).toBe(0);
    expect(result.added).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(cacheRepoMock.pruneMissing).not.toHaveBeenCalled();
  });

  it('re-stamps alreadyImported from the live backlog on the returned set', async () => {
    cacheRepoMock.getForSource.mockReturnValue([
      makeIssue({ externalId: '1', alreadyImported: false }),
      makeIssue({ externalId: '2', alreadyImported: false }),
    ]);
    backlogRepoMock.findByExternalIds.mockReturnValue(new Set(['1']));

    const result = await reconcileHandler()(null, { ...INPUT, mode: 'full' }) as { issues: ExternalIssue[] };

    expect(result.issues.find((issue) => issue.externalId === '1')?.alreadyImported).toBe(true);
    expect(result.issues.find((issue) => issue.externalId === '2')?.alreadyImported).toBe(false);
  });
});

describe('importGetCached', () => {
  it('returns the cache re-stamped, with no network fetch', async () => {
    cacheRepoMock.getForSource.mockReturnValue([makeIssue({ externalId: '1', alreadyImported: false })]);
    backlogRepoMock.findByExternalIds.mockReturnValue(new Set(['1']));

    const handler = capturedHandlers.get(IPC.BACKLOG_IMPORT_GET_CACHED);
    if (!handler) throw new Error('getCached handler not registered');
    const result = await handler(null, INPUT) as { issues: ExternalIssue[] };

    expect(adapter.fetch).not.toHaveBeenCalled();
    expect(result.issues[0].alreadyImported).toBe(true);
  });
});
