import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test (`mcp-project-context.ts`) pulls in several
// Electron/Node-native dependencies through its own imports:
//   - getProjectDb   -> better-sqlite3 native module
//   - autoSpawnForTask -> Electron ipcMain, PTY session manager
//   - handleTaskMove  -> Electron ipcMain, DB handlers
//   - WorktreeManager -> simple-git, fs.access
//   - RequestResolver -> project-resolver (would re-import mcp-project-context)
//
// We stub each of these so the unit scope stays pure (no Electron process,
// no native SQLite). The stubs are intentionally minimal - just enough for
// the module-level imports to resolve without crashing.

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  autoSpawnForTask: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  handleTaskMove: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: vi.fn().mockImplementation(() => ({
    withLock: vi.fn(() => Promise.resolve()),
    removeWorktree: vi.fn(() => Promise.resolve(false)),
    pruneWorktrees: vi.fn(() => Promise.resolve()),
    removeBranch: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../../src/shared/ipc-channels', () => ({
  IPC: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

// RequestResolver is imported by mcp-project-context and called with `new`.
// Track constructor calls via a hoisted spy variable that the test body can
// inspect after each call.
const resolverConstructorCalls: Array<Record<string, unknown>> = [];

vi.mock('../../src/main/agent/mcp-http/project-resolver', () => {
  function RequestResolver(params: Record<string, unknown>) {
    resolverConstructorCalls.push(params);
    Object.assign(this as object, { _params: params });
  }
  return { RequestResolver };
});

import { createRequestResolver, buildCommandContextForProject } from '../../src/main/agent/mcp-project-context';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Example Project',
    path: '/projects/example',
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeIpcContext(projectResult: Project | null): IpcContext {
  return {
    projectRepo: {
      getById: vi.fn(() => projectResult),
      list: vi.fn(() => (projectResult ? [projectResult] : [])),
    },
  } as unknown as IpcContext;
}

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111';

describe('createRequestResolver', () => {
  beforeEach(() => {
    resolverConstructorCalls.length = 0;
    vi.clearAllMocks();
  });

  it('returns null when projectRepo.getById returns null (unknown project ID)', () => {
    const ipcContext = makeIpcContext(null);
    const result = createRequestResolver(ipcContext, DEFAULT_ID);
    expect(result).toBeNull();
    // RequestResolver constructor must NOT be called - nothing to bind a
    // context to when the project row doesn't exist.
    expect(resolverConstructorCalls).toHaveLength(0);
  });

  it('returns null when buildCommandContextForProject returns null (project vanished after getById)', () => {
    // createRequestResolver does its own getById check first, then calls
    // buildCommandContextForProject which does a second getById internally.
    // When that second call returns null, buildCommandContextForProject returns
    // null, so createRequestResolver must also return null.
    const project = makeProject({ id: DEFAULT_ID, name: 'Board A' });
    const getById = vi.fn()
      .mockReturnValueOnce(project)  // outer check in createRequestResolver
      .mockReturnValueOnce(null);    // inner check inside buildCommandContextForProject
    const ipcContext = { projectRepo: { getById, list: vi.fn(() => [project]) } } as unknown as IpcContext;

    const result = createRequestResolver(ipcContext, DEFAULT_ID);

    expect(result).toBeNull();
    expect(resolverConstructorCalls).toHaveLength(0);
  });

  it('constructs a RequestResolver when the project exists and context builds successfully', () => {
    const project = makeProject({ id: DEFAULT_ID, name: 'My Board' });
    const ipcContext = makeIpcContext(project);

    const result = createRequestResolver(ipcContext, DEFAULT_ID);

    expect(result).not.toBeNull();
    expect(resolverConstructorCalls).toHaveLength(1);
    const constructorArg = resolverConstructorCalls[0];
    expect(constructorArg.defaultProjectId).toBe(DEFAULT_ID);
    expect(constructorArg.defaultProjectName).toBe('My Board');
    expect(constructorArg.ipcContext).toBe(ipcContext);
    // defaultContext must be the CommandContext returned by
    // buildCommandContextForProject - verify its shape.
    const defaultContext = constructorArg.defaultContext as Record<string, unknown>;
    expect(typeof defaultContext.getProjectPath).toBe('function');
  });

  it('passes the project name from the DB row into the resolver (not a hardcoded value)', () => {
    const project = makeProject({ id: DEFAULT_ID, name: 'Custom Board Name' });
    const ipcContext = makeIpcContext(project);

    createRequestResolver(ipcContext, DEFAULT_ID);

    expect(resolverConstructorCalls[0].defaultProjectName).toBe('Custom Board Name');
  });

  it('passes the ipcContext reference unchanged into the resolver', () => {
    const project = makeProject({ id: DEFAULT_ID });
    const ipcContext = makeIpcContext(project);

    createRequestResolver(ipcContext, DEFAULT_ID);

    expect(resolverConstructorCalls[0].ipcContext).toBe(ipcContext);
  });
});

describe('buildCommandContextForProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when projectRepo.getById returns null', () => {
    const ipcContext = makeIpcContext(null);
    const result = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(result).toBeNull();
  });

  it('returns a CommandContext with getProjectPath returning the project path', () => {
    const project = makeProject({ id: DEFAULT_ID, path: '/repos/myboard' });
    const ipcContext = makeIpcContext(project);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();
    expect(context!.getProjectPath()).toBe('/repos/myboard');
  });

  it('returned CommandContext exposes all required lifecycle callbacks', () => {
    const project = makeProject({ id: DEFAULT_ID });
    const ipcContext = makeIpcContext(project);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();
    expect(typeof context!.onTaskCreated).toBe('function');
    expect(typeof context!.onTaskUpdated).toBe('function');
    expect(typeof context!.onTaskDeleted).toBe('function');
    expect(typeof context!.onTaskMove).toBe('function');
    expect(typeof context!.onSwimlaneUpdated).toBe('function');
    expect(typeof context!.onBacklogChanged).toBe('function');
    expect(typeof context!.onLabelColorsChanged).toBe('function');
  });
});
