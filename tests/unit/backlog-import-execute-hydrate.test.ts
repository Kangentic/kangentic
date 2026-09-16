/**
 * BACKLOG_IMPORT_EXECUTE: the adapter.hydrateForImport branch.
 *
 * importExecute now folds in adapter.hydrateForImport(repository, issues) before
 * creating backlog items, when the adapter declares one (Azure DevOps folds in
 * deferred comments; see tests/unit/azure-devops-hydrate-import.test.ts for that
 * adapter's OWN hydrateForImport body). This file pins the HANDLER's wiring: it
 * calls hydrateForImport with the right arguments and imports ITS result rather
 * than the raw input, and it falls back to the raw input.issues unchanged when
 * the adapter has no hydrateForImport at all (e.g. GitHub, whose list body is
 * already complete).
 *
 * Uses the captured-IPC-handler DI pattern from tests/unit/import-reconcile.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportExecuteInput } from '../../src/shared/types';

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

const backlogRepoMock = {
  findByExternalIds: vi.fn(() => new Set<string>()),
  create: vi.fn((input: Record<string, unknown>) => ({ id: 'backlog-new', ...input })),
  getById: vi.fn((_id: string) => undefined as Record<string, unknown> | undefined),
};

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    findByExternalIds = backlogRepoMock.findByExternalIds;
    create = backlogRepoMock.create;
    getById = backlogRepoMock.getById;
  },
}));
vi.mock('../../src/main/db/repositories/remote-item-cache-repository', () => ({
  RemoteItemCacheRepository: class {},
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
  downloadImages: ReturnType<typeof vi.fn>;
  downloadFileAttachments?: ReturnType<typeof vi.fn>;
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

function makeIssue(
  overrides: Partial<ImportExecuteInput['issues'][number]> = {},
): ImportExecuteInput['issues'][number] {
  return {
    externalId: '42',
    externalUrl: 'https://dev.azure.com/my-org/my-project/_workitems/edit/42',
    title: 'Original title',
    body: 'Original body',
    labels: [],
    assignee: null,
    ...overrides,
  };
}

const context = { currentProjectId: 'proj-1', currentProjectPath: '/mock/proj' } as unknown as IpcContext;

function executeHandler() {
  const handler = capturedHandlers.get(IPC.BACKLOG_IMPORT_EXECUTE);
  if (!handler) throw new Error('execute handler not registered');
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.clear();
  backlogRepoMock.findByExternalIds.mockReturnValue(new Set<string>());
  backlogRepoMock.create.mockImplementation((input: Record<string, unknown>) => ({ id: 'backlog-new', ...input }));
  backlogRepoMock.getById.mockReturnValue(undefined);
  adapter = {
    downloadImages: vi.fn(async () => ({ attachments: [], skippedCount: 0 })),
  };
  registerBacklogHandlers(context);
});

describe('importExecute - hydrateForImport branch', () => {
  it('imports the hydrateForImport result, not the raw input issues, when the adapter declares one', async () => {
    adapter.hydrateForImport = vi.fn(async (_repository: string, issues: ImportExecuteInput['issues']) =>
      issues.map((issue) => ({ ...issue, body: `${issue.body}\n\nhydrated comment section` })),
    );

    const result = await executeHandler()(null, {
      source: 'azure_devops',
      repository: 'my-org/my-project',
      issues: [makeIssue({ body: 'Original body' })],
    }) as { items: unknown[] };

    expect(adapter.hydrateForImport).toHaveBeenCalledWith('my-org/my-project', [makeIssue({ body: 'Original body' })]);
    expect(backlogRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Original body\n\nhydrated comment section' }),
    );
    expect(result.items).toHaveLength(1);
  });

  // Deferring comments moved this call from list time to import time, so its failure
  // moved too: it would now discard an import the user had already chosen items for.
  // The comments are supplementary, so the import has to survive without them.
  it('still imports, without the deferred detail, when hydrateForImport fails', async () => {
    adapter.hydrateForImport = vi.fn(async () => { throw new Error('az rest failed'); });

    const result = await executeHandler()(null, {
      source: 'azure_devops',
      repository: 'my-org/my-project',
      issues: [makeIssue({ body: 'Original body' })],
    }) as { items: unknown[] };

    expect(backlogRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Original body' }),
    );
    expect(result.items).toHaveLength(1);
  });

  it('imports the raw input issues unchanged when the adapter has no hydrateForImport', async () => {
    // adapter.hydrateForImport is intentionally absent here (matches GitHub,
    // which has no deferred per-item detail to fold in).

    await executeHandler()(null, {
      source: 'github_issues',
      repository: 'owner/repo',
      issues: [makeIssue({ body: 'Plain body', externalId: '7' })],
    });

    expect(backlogRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Plain body' }),
    );
  });
});
