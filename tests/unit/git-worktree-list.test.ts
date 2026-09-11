/**
 * Unit tests for `src/main/git/worktree-list.ts`.
 *
 * Two layers. The no-projects paths pin what the MCP tool falls into when no
 * project is registered. The ahead/behind cases drive `enumerateWorktrees`
 * against a mocked `simple-git` (the pattern tests/unit/branch-summary.test.ts
 * uses) and pin WHICH ref the counts are measured against: the base branch the
 * work is based on when the injected resolver names one (`origin/<base>`
 * first, then the local ref), and the branch's own upstream only when no base
 * resolves. A branch can be 0 behind its remote and far behind its base; the
 * old upstream-only count reported the first as "up to date".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getVersion: vi.fn(() => '1.0.0'), getPath: vi.fn(() => '/tmp') },
}));

vi.mock('../../src/main/db/database', () => ({
  getGlobalDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  })),
}));

// The project rows the enumeration walks. Empty by default (the no-projects
// cases); the ahead/behind cases push one fixture project in.
const { projectsFixture, mockGit } = vi.hoisted(() => ({
  projectsFixture: [] as Array<{ id: string; name: string; path: string }>,
  mockGit: {
    raw: vi.fn<(args: string[]) => Promise<string>>(),
    status: vi.fn(async () => ({ isClean: () => true })),
  },
}));

vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class {
    list() { return projectsFixture; }
    getById(id: string) { return projectsFixture.find((project) => project.id === id); }
  },
}));

// Every path is "present": the fixture paths never touch the disk.
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

const PROJECT_PATH = '/mock/repo';
const TASK_WORKTREE_PATH = '/mock/repo/.kangentic/worktrees/task-a';

const PORCELAIN = [
  `worktree ${PROJECT_PATH}`,
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/feature/main-checkout-work',
  '',
  `worktree ${TASK_WORKTREE_PATH}`,
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/task-a',
  '',
].join('\n');

/** Route `git.raw` by its leading args; unmatched rev-list refs reject like a missing ref would. */
function routeGit(handlers: { revList?: (ref: string) => Promise<string>; upstream?: () => Promise<string> }): void {
  mockGit.raw.mockImplementation(async (args: string[]) => {
    if (args[0] === 'worktree') return PORCELAIN;
    if (args[0] === 'log') return '2026-09-01T00:00:00Z\n';
    if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
      if (!handlers.upstream) throw new Error('fatal: no upstream configured');
      return handlers.upstream();
    }
    if (args[0] === 'rev-list') {
      const range = args[args.length - 1] ?? '';
      const ref = range.replace(/\.\.\.HEAD$/, '');
      if (!handlers.revList) throw new Error(`fatal: bad revision '${range}'`);
      return handlers.revList(ref);
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

function revListRefsQueried(): string[] {
  return mockGit.raw.mock.calls
    .filter((call) => call[0][0] === 'rev-list')
    .map((call) => (call[0][call[0].length - 1] ?? '').replace(/\.\.\.HEAD$/, ''));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  projectsFixture.length = 0;
});

describe('worktree-list', () => {
  it('returns an empty array when no projects are registered', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');
    const result = await enumerateWorktrees();
    expect(result).toEqual([]);
  });

  it('returns an empty array when a specific projectId is unknown', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');
    const result = await enumerateWorktrees({ projectId: 'does-not-exist' });
    expect(result).toEqual([]);
  });
});

describe('worktree-list ahead/behind: the base branch, not the tracking ref', () => {
  beforeEach(() => {
    projectsFixture.push({ id: 'proj-1', name: 'Project', path: PROJECT_PATH });
  });

  it('measures against origin/<base> when the resolver names a base, and never consults the upstream', async () => {
    routeGit({
      revList: async (ref) => {
        if (ref === 'origin/develop') return '7\t2\n';
        throw new Error(`fatal: bad revision '${ref}'`);
      },
      // Current with its own remote: the answer the old code reported.
      upstream: async () => 'origin/feature/task-a\n',
    });
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees({ resolveBaseRef: () => 'develop' });
    const record = project.worktrees.find((worktree) => worktree.path === TASK_WORKTREE_PATH);

    expect(record).toMatchObject({ baseRef: 'develop', commitsBehind: 7, commitsAhead: 2 });
    expect(revListRefsQueried()).not.toContain('origin/feature/task-a');
    expect(mockGit.raw).not.toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', '@{upstream}']);
  });

  it('falls back to the local <base> when origin/<base> does not exist', async () => {
    routeGit({
      revList: async (ref) => {
        if (ref === 'develop') return '3\t0\n';
        throw new Error(`fatal: bad revision '${ref}'`);
      },
    });
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees({ resolveBaseRef: () => 'develop' });
    const record = project.worktrees.find((worktree) => worktree.path === TASK_WORKTREE_PATH);

    expect(record).toMatchObject({ baseRef: 'develop', commitsBehind: 3, commitsAhead: 0 });
    // origin/<base> is tried first: the local ref may be stale. Both worktrees
    // are built concurrently, so compare first occurrences rather than adjacency.
    const queried = revListRefsQueried();
    expect(queried).toContain('origin/develop');
    expect(queried).toContain('develop');
    expect(queried.indexOf('origin/develop')).toBeLessThan(queried.indexOf('develop'));
  });

  it('falls back to the upstream, with a null baseRef, only when neither base ref resolves', async () => {
    routeGit({
      revList: async (ref) => {
        if (ref === 'origin/feature/task-a') return '0\t3\n';
        throw new Error(`fatal: bad revision '${ref}'`);
      },
      upstream: async () => 'origin/feature/task-a\n',
    });
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees({ resolveBaseRef: () => 'develop' });
    const record = project.worktrees.find((worktree) => worktree.path === TASK_WORKTREE_PATH);

    // A null baseRef is what tells the reader these counts are upstream-relative.
    expect(record).toMatchObject({ baseRef: null, commitsBehind: 0, commitsAhead: 3 });
  });

  it('uses the upstream directly when no resolver is given, or the resolver returns null or throws', async () => {
    routeGit({
      revList: async (ref) => {
        if (ref === 'origin/feature/task-a') return '1\t4\n';
        throw new Error(`fatal: bad revision '${ref}'`);
      },
      upstream: async () => 'origin/feature/task-a\n',
    });
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    for (const options of [
      {},
      { resolveBaseRef: () => null },
      { resolveBaseRef: () => { throw new Error('db unreadable'); } },
    ]) {
      mockGit.raw.mockClear();
      const [project] = await enumerateWorktrees(options);
      const record = project.worktrees.find((worktree) => worktree.path === TASK_WORKTREE_PATH);
      expect(record).toMatchObject({ baseRef: null, commitsBehind: 1, commitsAhead: 4 });
      expect(revListRefsQueried()).toEqual(['origin/feature/task-a', 'origin/feature/task-a']);
    }
  });

  it('recognises the main checkout by resolved path, not by string identity', async () => {
    // The porcelain listing spells the path differently from the project row
    // (forward slashes on Windows, here a `.` segment); both are the same place.
    projectsFixture[0] = { id: 'proj-1', name: 'Project', path: `${PROJECT_PATH}/./` };
    routeGit({ revList: async () => '0\t0\n' });
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees({});

    const flags = project.worktrees.map((worktree) => [worktree.path, worktree.isMainCheckout]);
    expect(flags).toEqual([[PROJECT_PATH, true], [TASK_WORKTREE_PATH, false]]);
  });

  it('reports null counts when there is no base and no upstream', async () => {
    routeGit({});
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees({});
    const record = project.worktrees.find((worktree) => worktree.path === TASK_WORKTREE_PATH);

    expect(record).toMatchObject({ baseRef: null, commitsBehind: null, commitsAhead: null });
  });

  it('tells the resolver which worktree it is asked about, main checkout included', async () => {
    routeGit({ revList: async () => '0\t0\n' });
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');
    const resolveBaseRef = vi.fn(() => 'main');

    const [project] = await enumerateWorktrees({ resolveBaseRef });

    expect(resolveBaseRef).toHaveBeenCalledWith({
      projectId: 'proj-1',
      projectPath: PROJECT_PATH,
      worktreePath: PROJECT_PATH,
      branch: 'feature/main-checkout-work',
      isMainCheckout: true,
    });
    expect(resolveBaseRef).toHaveBeenCalledWith({
      projectId: 'proj-1',
      projectPath: PROJECT_PATH,
      worktreePath: TASK_WORKTREE_PATH,
      branch: 'feature/task-a',
      isMainCheckout: false,
    });
    // The main checkout is measured against the base too: a Command Terminal
    // on a feature branch of the main checkout is the case that needs it.
    const mainRecord = project.worktrees.find((worktree) => worktree.isMainCheckout);
    expect(mainRecord).toMatchObject({ baseRef: 'main', commitsBehind: 0, commitsAhead: 0 });
  });
});
