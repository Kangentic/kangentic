import { describe, it, expect, vi, beforeEach } from 'vitest';

// buildCommandContextForProject pulls in Electron bindings transitively
// (WorktreeManager, IPC channels). Stub it before importing the module
// under test so the unit scope stays pure. `vi.hoisted` lifts the mock
// factory above the synthesized module init so it's ready when the
// project-resolver import runs.
const { buildCommandContextForProject } = vi.hoisted(() => ({
  buildCommandContextForProject: vi.fn((_ipcContext: unknown, projectId: string) => ({
    getProjectDb: () => ({ projectId }),
    getProjectPath: () => `/projects/${projectId}`,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  })),
}));

vi.mock('../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject,
}));

import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import { withProject, type McpToolResult } from '../../src/main/agent/mcp-http/handler-helpers';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Example',
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

function makeContext(): CommandContext {
  return {
    getProjectDb: () => ({}) as never,
    getProjectPath: () => '/projects/default',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

function makeResolver(projects: Project[], defaultProjectId: string) {
  const defaultProject = projects.find((project) => project.id === defaultProjectId);
  if (!defaultProject) throw new Error('default project missing from fixtures');
  const ipcContext = { projectRepo: { list: () => projects } } as unknown as IpcContext;
  return new RequestResolver({
    ipcContext,
    defaultContext: makeContext(),
    defaultProjectId,
    defaultProjectName: defaultProject.name,
  });
}

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';

describe('RequestResolver.resolveProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default factory behaviour so tests that flipped it
    // don't leak into neighbours.
    buildCommandContextForProject.mockImplementation((_ipcContext: unknown, projectId: string) => ({
      getProjectDb: () => ({ projectId }),
      getProjectPath: () => `/projects/${projectId}`,
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onTaskMove: vi.fn(),
      onSwimlaneUpdated: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
    }));
  });

  it('returns the default context when selector is null/undefined/empty', () => {
    const resolver = makeResolver(
      [makeProject({ id: DEFAULT_ID, name: 'Active' })],
      DEFAULT_ID,
    );

    for (const selector of [null, undefined, '', '   ']) {
      const result = resolver.resolveProject(selector);
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.isDefault).toBe(true);
      expect(result.projectId).toBe(DEFAULT_ID);
      expect(result.projectName).toBe('Active');
    }
  });

  it('resolves by UUID (case-insensitive) to the non-default project', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const result = resolver.resolveProject(OTHER_ID.toUpperCase());
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.isDefault).toBe(false);
    expect(result.projectId).toBe(OTHER_ID);
    expect(result.projectName).toBe('Kangentic');
  });

  it('resolves by name exact match (case-insensitive)', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const result = resolver.resolveProject('kangentic');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.isDefault).toBe(false);
    expect(result.projectId).toBe(OTHER_ID);
    expect(result.projectName).toBe('Kangentic');
  });

  it('flags the default project as isDefault=true when selector points at the active URL-path project', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const byId = resolver.resolveProject(DEFAULT_ID);
    expect('error' in byId).toBe(false);
    if ('error' in byId) return;
    expect(byId.isDefault).toBe(true);

    const byName = resolver.resolveProject('Active');
    expect('error' in byName).toBe(false);
    if ('error' in byName) return;
    expect(byName.isDefault).toBe(true);
  });

  it('returns an error with candidate IDs when a name is ambiguous', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Shared' }),
        makeProject({ id: THIRD_ID, name: 'Shared' }),
      ],
      DEFAULT_ID,
    );

    const result = resolver.resolveProject('shared');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('Multiple projects');
    expect(result.error).toContain(OTHER_ID);
    expect(result.error).toContain(THIRD_ID);
  });

  it('returns an error listing available projects when no match is found', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const result = resolver.resolveProject('Nonexistent');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('No project matching "Nonexistent"');
    expect(result.error).toContain('Active');
    expect(result.error).toContain('Kangentic');
  });

  it('returns an error (not a silent default-project redirect) when buildCommandContextForProject vanishes mid-request', () => {
    buildCommandContextForProject.mockImplementationOnce(() => null);
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const result = resolver.resolveProject(OTHER_ID);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('disappeared');
    expect(result.error).toContain(OTHER_ID);
  });

  it('falls back to name lookup when a UUID-shaped selector does not match any id', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({
          id: OTHER_ID,
          // Deliberately weird: project literally named like a UUID.
          name: '99999999-9999-4999-8999-999999999999',
        }),
      ],
      DEFAULT_ID,
    );

    const result = resolver.resolveProject('99999999-9999-4999-8999-999999999999');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.projectId).toBe(OTHER_ID);
  });
});

describe('RequestResolver.listProjects', () => {
  it('marks the default project as isActive and surfaces all rows in order', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active', path: '/a' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic', path: '/b' }),
      ],
      DEFAULT_ID,
    );

    const listed = resolver.listProjects();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ id: DEFAULT_ID, name: 'Active', path: '/a', isActive: true });
    expect(listed[1]).toMatchObject({ id: OTHER_ID, name: 'Kangentic', path: '/b', isActive: false });
  });

  it('caches the projectRepo.list() call across multiple resolver calls', () => {
    const list = vi.fn(() => [
      makeProject({ id: DEFAULT_ID, name: 'Active' }),
      makeProject({ id: OTHER_ID, name: 'Kangentic' }),
    ]);
    const ipcContext = { projectRepo: { list } } as unknown as IpcContext;
    const resolver = new RequestResolver({
      ipcContext,
      defaultContext: makeContext(),
      defaultProjectId: DEFAULT_ID,
      defaultProjectName: 'Active',
    });

    resolver.resolveProject('kangentic');
    resolver.resolveProject(OTHER_ID);
    resolver.listProjects();

    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('RequestResolver.defaultContextResolved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the pre-built default context with isDefault=true', () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const resolved = resolver.defaultContextResolved();
    expect(resolved.isDefault).toBe(true);
    expect(resolved.projectId).toBe(DEFAULT_ID);
    expect(resolved.projectName).toBe('Active');
    // Importantly, this path does NOT invoke buildCommandContextForProject.
    expect(buildCommandContextForProject).not.toHaveBeenCalled();
  });
});

describe('withProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function textOf(result: McpToolResult): string {
    const first = result.content[0];
    return first && first.type === 'text' ? first.text : '';
  }

  it('passes through the inner result unchanged when selector is omitted', async () => {
    const resolver = makeResolver([makeProject({ id: DEFAULT_ID, name: 'Active' })], DEFAULT_ID);

    const result = await withProject(resolver, undefined, async () => ({
      content: [{ type: 'text' as const, text: 'Created task "x" in To Do (#1)' }],
    }));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('Created task "x" in To Do (#1)');
    // Critical: no [Project: ...] prefix on the default path.
    expect(textOf(result)).not.toContain('[Project:');
  });

  it('prepends the project marker to the first text block when crossing projects', async () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const result = await withProject(resolver, 'Kangentic', async () => ({
      content: [{ type: 'text' as const, text: 'Created task "x" in To Do (#1)' }],
    }));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(`[Project: Kangentic (${OTHER_ID.slice(0, 8)})]\nCreated task "x" in To Do (#1)`);
  });

  it('returns an error result when the project selector cannot be resolved', async () => {
    const resolver = makeResolver(
      [makeProject({ id: DEFAULT_ID, name: 'Active' })],
      DEFAULT_ID,
    );
    const innerRun = vi.fn();

    const result = await withProject(resolver, 'Nonexistent', innerRun);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No project matching "Nonexistent"');
    // Body must NOT have run if resolution failed.
    expect(innerRun).not.toHaveBeenCalled();
  });

  it('preserves the isError flag on the inner result and still annotates cross-project', async () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kangentic' }),
      ],
      DEFAULT_ID,
    );

    const result = await withProject(resolver, 'Kangentic', async () => ({
      content: [{ type: 'text' as const, text: 'Task not found' }],
      isError: true,
    }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`[Project: Kangentic (${OTHER_ID.slice(0, 8)})]\nTask not found`);
  });

  it('sanitizes project names that contain newlines or `]` before embedding in the marker', async () => {
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: 'Kan]gen\ntic' }),
      ],
      DEFAULT_ID,
    );

    const result = await withProject(resolver, OTHER_ID, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const firstLine = textOf(result).split('\n')[0];
    expect(firstLine).toBe(`[Project: Kan gen tic (${OTHER_ID.slice(0, 8)})]`);
    expect(firstLine).not.toContain('\n');
  });

  it('truncates pathologically long project names to keep the marker on one line', async () => {
    const longName = 'x'.repeat(200);
    const resolver = makeResolver(
      [
        makeProject({ id: DEFAULT_ID, name: 'Active' }),
        makeProject({ id: OTHER_ID, name: longName }),
      ],
      DEFAULT_ID,
    );

    const result = await withProject(resolver, OTHER_ID, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const firstLine = textOf(result).split('\n')[0];
    // 57 chars + "..." + framing text.
    expect(firstLine).toContain(`${'x'.repeat(57)}...`);
    expect(firstLine.length).toBeLessThan(200);
  });
});
