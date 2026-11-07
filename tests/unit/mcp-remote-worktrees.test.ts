/**
 * `kangentic_list_worktrees` on a remote project. Git answers from the host in the host's paths, and the project row
 * holds this computer's stand-in. Before each entry was mapped back, every record read `dirty: false`, no ahead or
 * behind count and `isMainCheckout: false`, which an agent takes at its word.
 */
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_ID, HOST_PROJECT, HOST_WORKTREE, SHELL_FOLDER, STAND_IN_WORKTREE } from './helpers/remote-project-fixture';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getVersion: vi.fn(() => '1.0.0'), getPath: vi.fn(() => '/tmp') },
}));

const { projectsFixture, gitByDirectory, gitCalls } = vi.hoisted(() => ({
  projectsFixture: [] as Array<{ id: string; name: string; path: string; remote: { hostId: string; path: string } | null }>,
  gitByDirectory: { worktreeList: '' as string | Error },
  gitCalls: [] as string[],
}));

vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class {
    list() { return projectsFixture; }
    getById(id: string) { return projectsFixture.find((project) => project.id === id); }
  },
}));

// Only the stand-in exists on this computer, so a read of a host path here fails as it does on the real disk.
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));

vi.mock('../../src/main/git/git-client', () => ({
  gitAt: vi.fn((directory: string) => {
    gitCalls.push(directory);
    if (!directory.startsWith(SHELL_FOLDER)) throw new Error(`Cannot use simple-git on a directory that does not exist: ${directory}`);
    return {
      status: async () => ({ files: [{ path: 'changed.ts' }] }),
      raw: async (args: string[]) => {
        if (args[0] === 'worktree') {
          if (gitByDirectory.worktreeList instanceof Error) throw gitByDirectory.worktreeList;
          return gitByDirectory.worktreeList;
        }
        if (args[0] === 'log') return '2026-09-01T00:00:00Z\n';
        if (args[0] === 'rev-list') return '4\t2\n';
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };
  }),
}));

function porcelain(mainPath: string, worktreePath: string): string {
  return [
    `worktree ${mainPath}`, 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
    `worktree ${worktreePath}`, 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feature/remote', '',
  ].join('\n');
}

beforeEach(() => {
  vi.resetModules();
  gitCalls.length = 0;
  projectsFixture.length = 0;
  projectsFixture.push({ id: 'proj-1', name: 'Remote', path: SHELL_FOLDER, remote: { hostId: HOST_ID, path: HOST_PROJECT } });
  gitByDirectory.worktreeList = porcelain(HOST_PROJECT, HOST_WORKTREE);
});

describe('kangentic_list_worktrees on a remote project', () => {
  it('reports the host paths and the facts the host\'s git gives', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees({ resolveBaseRef: () => 'main' });

    expect(project).toMatchObject({ projectPath: HOST_PROJECT, shellFolder: SHELL_FOLDER, location: 'host' });
    expect(project.worktrees).toHaveLength(2);
    expect(project.worktrees[0]).toMatchObject({ path: HOST_PROJECT, localPath: SHELL_FOLDER, location: 'host', isMainCheckout: true, dirty: true });
    expect(project.worktrees[1]).toMatchObject({
      path: HOST_WORKTREE,
      localPath: STAND_IN_WORKTREE,
      location: 'host',
      isMainCheckout: false,
      dirty: true,
      baseRef: 'main',
      commitsAhead: 2,
      commitsBehind: 4,
      lastCommitTs: '2026-09-01T00:00:00Z',
    });
  });

  it('runs git through the stand-in, never at a host path on this computer', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    await enumerateWorktrees();

    expect(gitCalls.every((directory) => directory.startsWith(SHELL_FOLDER))).toBe(true);
    expect(gitCalls).not.toContain(HOST_WORKTREE);
  });

  it('asks for a task\'s base by the path its row holds, so the task is found', async () => {
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');
    const resolveBaseRef = vi.fn(() => 'develop');

    await enumerateWorktrees({ resolveBaseRef });

    expect(resolveBaseRef).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: STAND_IN_WORKTREE, projectPath: SHELL_FOLDER, isMainCheckout: false }));
  });

  it('maps from git\'s own spelling when the host\'s home is a symlink', async () => {
    const realProject = '/data/home/dev/proj';
    gitByDirectory.worktreeList = porcelain(realProject, `${realProject}/.kangentic/worktrees/12`);
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees();

    expect(project.worktrees[0]).toMatchObject({ path: realProject, isMainCheckout: true, dirty: true });
    expect(project.worktrees[1]).toMatchObject({ path: `${realProject}/.kangentic/worktrees/12`, localPath: STAND_IN_WORKTREE, isMainCheckout: false, dirty: true });
  });

  it('leaves a worktree outside the project with what git listed, and starts no git on this computer for it', async () => {
    gitByDirectory.worktreeList = porcelain(HOST_PROJECT, '/home/dev/elsewhere');
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees();

    expect(project.worktrees[1]).toMatchObject({ path: '/home/dev/elsewhere', location: 'host', isMainCheckout: false });
    expect(project.worktrees[1]).not.toHaveProperty('localPath');
    expect(gitCalls).not.toContain('/home/dev/elsewhere');
  });

  it('says a host that cannot answer, and never reads as no worktrees', async () => {
    gitByDirectory.worktreeList = new Error('the link is down');
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const [project] = await enumerateWorktrees();

    expect(project.worktrees).toEqual([]);
    expect(project.error).toContain('the link is down');
  });

  it('lets one host that is down leave the other projects alone', async () => {
    const localPath = path.resolve('/mock/local');
    projectsFixture.push({ id: 'proj-2', name: 'Local', path: localPath, remote: null });
    gitByDirectory.worktreeList = new Error('the link is down');
    const { enumerateWorktrees } = await import('../../src/main/git/worktree-list');

    const results = await enumerateWorktrees();

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ projectPath: localPath, location: 'local', worktrees: [] });
    expect(results[1]).not.toHaveProperty('error');
  });
});
