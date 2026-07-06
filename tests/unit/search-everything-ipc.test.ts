/**
 * Unit tests for the search IPC adapter (`src/main/ipc/handlers/search.ts`).
 *
 * Strategy: mock `runSearchEverything` and the `ipcMain.handle` registration so
 * we can exercise only the adapter's own branch logic - the empty-query
 * short-circuit, the scope routing, and the early-return guard when no matching
 * project is found. Core search behaviour is covered by
 * search-everything-core.test.ts.
 *
 * Pattern mirrors task-create-handler.test.ts: capture the handler registered
 * via ipcMain.handle and invoke it directly from tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, SearchRequest } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be declared before any imports that trigger module
// evaluation. vi.hoisted() runs before module resolution.
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const { mockRunSearchEverything } = vi.hoisted(() => ({
  mockRunSearchEverything: vi.fn(async () => []),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/search/search-core', () => ({
  runSearchEverything: mockRunSearchEverything,
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER mocks are declared).
// ---------------------------------------------------------------------------

import { registerSearchHandlers } from '../../src/main/ipc/handlers/search';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    name: overrides.name ?? 'Default',
    path: overrides.path ?? '/tmp/default',
    github_url: overrides.github_url ?? null,
    default_agent: overrides.default_agent ?? 'claude',
    group_id: overrides.group_id ?? null,
    position: overrides.position ?? 0,
    last_opened: overrides.last_opened ?? '2026-05-01T00:00:00Z',
    created_at: overrides.created_at ?? '2026-04-01T00:00:00Z',
  };
}

const DEFAULT_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_PROJECT = makeProject({ id: DEFAULT_PROJECT_ID, name: 'Default', path: '/tmp/default' });
const OTHER_PROJECT = makeProject({ id: OTHER_PROJECT_ID, name: 'Other', path: '/tmp/other' });

function makeContext(projects: Project[] = [DEFAULT_PROJECT, OTHER_PROJECT]) {
  return {
    projectRepo: {
      list: vi.fn(() => projects),
    },
    // The handler reads memory.indexingEnabled to gate conversation search.
    configManager: {
      load: vi.fn(() => ({ memory: { indexingEnabled: true } })),
    },
  };
}

/** Invoke the captured SEARCH_EVERYTHING handler with a synthetic IPC event. */
async function callHandler(
  request: SearchRequest,
  context: ReturnType<typeof makeContext>,
): Promise<unknown> {
  // Register fresh handlers for the given context.
  capturedHandlers.clear();
  registerSearchHandlers(context as never);

  const handler = capturedHandlers.get(IPC.SEARCH_EVERYTHING);
  if (!handler) throw new Error(`Handler for ${IPC.SEARCH_EVERYTHING} was not registered`);

  // ipcMain.handle callbacks receive (event, ...args); we pass a stub event.
  return handler({} as Electron.IpcMainInvokeEvent, request);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('search IPC adapter (registerSearchHandlers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSearchEverything.mockResolvedValue([]);
  });

  it('returns [] immediately for an empty query without calling runSearchEverything', async () => {
    const context = makeContext();
    const request: SearchRequest = { query: '   ', scope: 'current', currentProjectId: DEFAULT_PROJECT_ID };

    const result = await callHandler(request, context);

    expect(result).toEqual([]);
    expect(mockRunSearchEverything).not.toHaveBeenCalled();
    // The projectRepo.list() call should also be skipped because the empty
    // query short-circuits before that.
    expect(context.projectRepo.list).not.toHaveBeenCalled();
  });

  it('scope="current" passes only the matching project and sets includeProjectHits=false', async () => {
    const context = makeContext();
    const request: SearchRequest = { query: 'hello', scope: 'current', currentProjectId: DEFAULT_PROJECT_ID };

    await callHandler(request, context);

    expect(mockRunSearchEverything).toHaveBeenCalledOnce();
    const callArg = mockRunSearchEverything.mock.calls[0][0] as {
      projects: Project[];
      includeProjectHits: boolean;
      projectsForProjectHits: Project[];
    };
    expect(callArg.projects.map((project) => project.id)).toEqual([DEFAULT_PROJECT_ID]);
    expect(callArg.includeProjectHits).toBe(false);
    // projectsForProjectHits must still be the full list so project-name hits
    // would be available if scope were widened in future.
    expect(callArg.projectsForProjectHits.map((project) => project.id).sort()).toEqual(
      [DEFAULT_PROJECT_ID, OTHER_PROJECT_ID].sort(),
    );
  });

  it('scope="all" passes all projects and sets includeProjectHits=true', async () => {
    const context = makeContext();
    const request: SearchRequest = { query: 'world', scope: 'all', currentProjectId: DEFAULT_PROJECT_ID };

    await callHandler(request, context);

    expect(mockRunSearchEverything).toHaveBeenCalledOnce();
    const callArg = mockRunSearchEverything.mock.calls[0][0] as {
      projects: Project[];
      includeProjectHits: boolean;
      projectsForProjectHits: Project[];
    };
    expect(callArg.projects.map((project) => project.id).sort()).toEqual(
      [DEFAULT_PROJECT_ID, OTHER_PROJECT_ID].sort(),
    );
    expect(callArg.includeProjectHits).toBe(true);
  });

  it('returns [] without calling runSearchEverything when currentProjectId matches no registered project', async () => {
    // Covers the `projects.length === 0` early-return guard.
    const context = makeContext([DEFAULT_PROJECT, OTHER_PROJECT]);
    const request: SearchRequest = {
      query: 'anything',
      scope: 'current',
      currentProjectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    };

    const result = await callHandler(request, context);

    expect(result).toEqual([]);
    expect(mockRunSearchEverything).not.toHaveBeenCalled();
  });
});
