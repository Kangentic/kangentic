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
  workItemTypeIsItemType?: boolean;
};

vi.mock('../../src/main/boards', () => ({
  boardRegistry: { requireStable: vi.fn(() => adapter), get: vi.fn(() => null) },
  ImportSourceStore: class { list = vi.fn(() => []); add = vi.fn(); remove = vi.fn(); updateLabel = vi.fn(); },
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/jira', () => ({ registerJiraIpcHandlers: vi.fn() }));

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

/** The project's priority scale, as `config.backlog.priorities`; empty reads as the seeded five. */
let projectPriorities: Array<{ label: string; color: string }> = [];

const context = {
  currentProjectId: 'proj-1',
  currentProjectPath: '/mock/proj',
  configManager: { getEffectiveConfig: vi.fn(() => ({ backlog: { priorities: projectPriorities } })) },
} as unknown as IpcContext;

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
  projectPriorities = [];
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
    }) as { items: unknown[]; detailUnavailable: number };

    expect(backlogRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Original body' }),
    );
    expect(result.items).toHaveLength(1);
    // The import succeeds, so the only way the user learns the comments are missing
    // is this count reaching the toast.
    expect(result.detailUnavailable).toBe(1);
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

  // The import loop iterates issuesToImport (hydrateForImport's result), while
  // alreadyImportedIds was computed from the ORIGINAL input.issues. Nothing else
  // here checks what happens when the two disagree in order or count.
  it('imports the hydrateForImport result in ITS OWN order and count, even when reordered and shorter than the input', async () => {
    const firstIssue = makeIssue({ externalId: '1', title: 'Issue One', body: 'Body one' });
    const secondIssue = makeIssue({ externalId: '2', title: 'Issue Two', body: 'Body two' });
    const thirdIssue = makeIssue({ externalId: '3', title: 'Issue Three', body: 'Body three' });

    // Reordered (third then first) AND missing the second issue entirely.
    adapter.hydrateForImport = vi.fn(async () => [thirdIssue, firstIssue]);

    const result = await executeHandler()(null, {
      source: 'azure_devops',
      repository: 'my-org/my-project',
      issues: [firstIssue, secondIssue, thirdIssue],
    }) as { items: unknown[] };

    expect(backlogRepoMock.create).toHaveBeenCalledTimes(2);
    expect(backlogRepoMock.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ externalId: '3', description: 'Body three' }),
    );
    expect(backlogRepoMock.create.mock.calls[1][0]).toEqual(
      expect.objectContaining({ externalId: '1', description: 'Body one' }),
    );
    // Reflects the RETURNED count, not input.issues.length (which is 3).
    expect(result.items).toHaveLength(2);
  });
});

// A provider's priority arrives as a name (Linear's "High"). The project's own
// scale decides the index, so a renamed scale must not land an issue on a guess.
describe('importExecute - priority names', () => {
  async function importedPriority(priority: string | undefined): Promise<unknown> {
    await executeHandler()(null, {
      source: 'linear',
      repository: 'ENG',
      issues: [makeIssue({ externalId: 'issue-uuid', priority })],
    });
    return backlogRepoMock.create.mock.calls[0][0].priority;
  }

  it('lands a name on the seeded scale at its index, ignoring case', async () => {
    expect(await importedPriority('High')).toBe(3);
    backlogRepoMock.create.mockClear();
    expect(await importedPriority('urgent')).toBe(4);
  });

  it('imports at 0 with no priority', async () => {
    expect(await importedPriority(undefined)).toBe(0);
  });

  it('follows a project scale that reorders the levels', async () => {
    projectPriorities = [
      { label: 'None', color: '#6b7280' },
      { label: 'High', color: '#f97316' },
      { label: 'Low', color: '#3b82f6' },
    ];
    expect(await importedPriority('High')).toBe(1);
  });

  it('imports at 0 when the project renamed the level away', async () => {
    projectPriorities = [
      { label: 'Someday', color: '#6b7280' },
      { label: 'Soon', color: '#3b82f6' },
      { label: 'Now', color: '#ef4444' },
    ];
    expect(await importedPriority('Urgent')).toBe(0);
  });
});

// Jira's names include two no stock scale carries, and its issue type is a real type.
describe('importExecute - Jira priority, type and due date', () => {
  it('matches the provider priority by name against the project scale and carries type and due date', async () => {
    adapter.workItemTypeIsItemType = true;
    await executeHandler()(null, {
      source: 'jira',
      repository: 'https://acme.atlassian.net::board::12',
      issues: [makeIssue({ externalId: '10001', priority: 'high', itemType: 'Bug', dueDate: '2026-12-01' })],
    });
    expect(backlogRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 3, itemType: 'Bug', dueDate: '2026-12-01' }),
    );
  });

  it('maps Highest to the top of the scale and an unknown name to None', async () => {
    await executeHandler()(null, {
      source: 'jira',
      repository: 'https://acme.atlassian.net::board::12',
      issues: [
        makeIssue({ externalId: '1', priority: 'Highest' }),
        makeIssue({ externalId: '2', priority: 'Blocker' }),
      ],
    });
    expect(backlogRepoMock.create.mock.calls[0][0]).toEqual(expect.objectContaining({ priority: 4 }));
    expect(backlogRepoMock.create.mock.calls[1][0]).toEqual(expect.objectContaining({ priority: 0 }));
  });

  it('does not store the item type for a provider whose type field is not a type (Asana sections)', async () => {
    adapter.workItemTypeIsItemType = false;
    await executeHandler()(null, {
      source: 'asana',
      repository: '1234567890',
      issues: [makeIssue({ externalId: '7', itemType: 'In Progress' })],
    });
    expect(backlogRepoMock.create.mock.calls[0][0]).toEqual(expect.objectContaining({ itemType: undefined }));
  });
});
