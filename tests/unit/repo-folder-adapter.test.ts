/**
 * The Repository folder source, read by real git from a temporary repository:
 * which direct children of a folder import as tasks, what their descriptions
 * list, which of local `main` and `origin/main` is read, and that the working
 * tree never is. A user loses the wrong task list if any of these drift, and an
 * archived item that stays listed is imported twice.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepoFolderAdapter } from '../../src/main/boards/adapters/repo-folder';
import { RefusalError } from '../../src/shared/refusal';
import type { ExternalIssue, ImportFetchInput } from '../../src/shared/types';

vi.setConfig({ testTimeout: 60_000 });

let workspace: string;

function git(cwd: string, args: string[], committerDate?: string): string {
  const env = committerDate
    ? { ...process.env, GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate }
    : process.env;
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, windowsHide: true }).toString().trim();
}

function writeFile(repository: string, relativePath: string, content = 'x\n'): void {
  const target = path.join(repository, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commitAll(repository: string, message: string, committerDate: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', message], committerDate);
  return git(repository, ['rev-parse', 'HEAD']);
}

function initRepository(name: string): string {
  const repository = path.join(workspace, name);
  fs.mkdirSync(repository);
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.email', 'dev@example.com']);
  git(repository, ['config', 'user.name', 'Dev']);
  git(repository, ['config', 'core.autocrlf', 'false']);
  return repository;
}

function fetchInput(repository: string): ImportFetchInput {
  return { source: 'repo_folder', repository, page: 1, perPage: 100, state: 'all' };
}

const noneImported = () => new Set<string>();

async function fetchTitles(adapter: RepoFolderAdapter, repositoryPath: string, folder: string, baseBranch = 'main'): Promise<string[]> {
  const result = await adapter.fetch(fetchInput(folder), noneImported, { path: repositoryPath, baseBranch });
  return result.issues.map((issue) => issue.title);
}

/** A changes folder shaped like OpenSpec's, committed on `main`. */
let changesRepository: string;

beforeAll(() => {
  // The real path: git resolves the working directory but not GIT_CEILING_DIRECTORIES, so a temp
  // folder behind a symlink (macOS's /var) or an 8.3 short name (Windows) would not stop its search.
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-folder-adapter-')));
  changesRepository = initRepository('changes');
  writeFile(changesRepository, 'openspec/changes/add-login/proposal.md');
  writeFile(changesRepository, 'openspec/changes/add-login/tasks.md');
  writeFile(changesRepository, 'openspec/changes/add-login/.openspec.yaml');
  writeFile(changesRepository, 'openspec/changes/add-login/specs/auth/spec.md');
  writeFile(changesRepository, 'openspec/changes/archive/2025-01-01-old-change/proposal.md');
  writeFile(changesRepository, 'openspec/changes/archive/.gitkeep', '');
  writeFile(changesRepository, 'openspec/changes/only-dots/.gitkeep', '');
  writeFile(changesRepository, 'openspec/changes/README.md');
  writeFile(changesRepository, 'openspec/changes/.hidden-note.md');
  writeFile(changesRepository, 'openspec/changes/loose-note.md');
  writeFile(changesRepository, '.github/workflows/ci/run.yml');
  commitAll(changesRepository, 'add login', '2024-01-01T10:00:00Z');
  writeFile(changesRepository, 'openspec/changes/fix-search/proposal.md');
  commitAll(changesRepository, 'fix search', '2025-06-01T10:00:00Z');
  // Never committed: the working tree is not what imports.
  writeFile(changesRepository, 'openspec/changes/uncommitted-change/proposal.md');
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('a folder on the default branch', () => {
  it('imports each direct child, drops a folder of only subfolders and dot-files, and skips dot-files and READMEs', async () => {
    const titles = await fetchTitles(new RepoFolderAdapter(), changesRepository, 'openspec/changes');
    expect(titles).toEqual(['add-login', 'fix-search', 'loose-note.md']);
  });

  it('names each item by its child name and lists its paths, copying no file content', async () => {
    const result = await new RepoFolderAdapter().fetch(fetchInput('openspec/changes'), noneImported, { path: changesRepository, baseBranch: 'main' });
    const byTitle = new Map<string, ExternalIssue>(result.issues.map((issue) => [issue.title, issue]));

    const folderItem = byTitle.get('add-login');
    expect(folderItem).toMatchObject({ externalId: 'add-login', displayId: 'add-login', externalUrl: '', stateCategory: 'open', assignee: null });
    expect(folderItem?.body).toBe([
      '- openspec/changes/add-login/proposal.md',
      '- openspec/changes/add-login/tasks.md',
      '- openspec/changes/add-login/specs/',
    ].join('\n'));

    expect(byTitle.get('loose-note.md')?.body).toBe('- openspec/changes/loose-note.md');
  });

  it('dates each item by the last commit that touched it', async () => {
    const result = await new RepoFolderAdapter().fetch(fetchInput('openspec/changes'), noneImported, { path: changesRepository, baseBranch: 'main' });
    const byTitle = new Map(result.issues.map((issue) => [issue.title, issue]));
    expect(new Date(byTitle.get('add-login')?.updatedAt ?? '').toISOString()).toBe('2024-01-01T10:00:00.000Z');
    expect(new Date(byTitle.get('fix-search')?.updatedAt ?? '').toISOString()).toBe('2025-06-01T10:00:00.000Z');
  });

  it('skips a README in any form but imports a name that only starts with readme', async () => {
    const repository = initRepository('readmes');
    writeFile(repository, 'notes/README');
    writeFile(repository, 'notes/README.md');
    writeFile(repository, 'notes/readme.en.md');
    writeFile(repository, 'notes/readme-guide.md');
    writeFile(repository, 'notes/readme-assets/diagram.txt');
    commitAll(repository, 'notes', '2024-01-01T10:00:00Z');
    expect(await fetchTitles(new RepoFolderAdapter(), repository, 'notes')).toEqual(['readme-assets', 'readme-guide.md']);
  });

  it('dates an item whose name is pathspec syntax by its own history, not a pattern match', async () => {
    const repository = initRepository('pathspec-names');
    writeFile(repository, 'changes/[x].md');
    commitAll(repository, 'bracketed', '2024-01-01T10:00:00Z');
    // As a pattern, `[x].md` matches `x.md`, which this later commit adds.
    writeFile(repository, 'changes/x.md');
    commitAll(repository, 'plain', '2025-01-01T10:00:00Z');
    const result = await new RepoFolderAdapter().fetch(fetchInput('changes'), noneImported, { path: repository, baseBranch: 'main' });
    const byTitle = new Map(result.issues.map((issue) => [issue.title, issue]));
    expect(new Date(byTitle.get('[x].md')?.updatedAt ?? '').toISOString()).toBe('2024-01-01T10:00:00.000Z');
    expect(new Date(byTitle.get('x.md')?.updatedAt ?? '').toISOString()).toBe('2025-01-01T10:00:00.000Z');
  });

  it('marks the items the backlog already holds', async () => {
    const result = await new RepoFolderAdapter().fetch(
      fetchInput('openspec/changes'),
      (_source, ids) => new Set(ids.filter((id) => id === 'fix-search')),
      { path: changesRepository, baseBranch: 'main' },
    );
    expect(result.issues.filter((issue) => issue.alreadyImported).map((issue) => issue.externalId)).toEqual(['fix-search']);
  });

  it('lists the same ids for the prune, so an item moved out of the folder drops from the list', async () => {
    const repository = initRepository('archived');
    writeFile(repository, 'changes/first/proposal.md');
    writeFile(repository, 'changes/second/proposal.md');
    commitAll(repository, 'two changes', '2024-01-01T10:00:00Z');
    const project = { path: repository, baseBranch: 'main' };
    expect(await new RepoFolderAdapter().listExternalIds({ source: 'repo_folder', repository: 'changes' }, project)).toEqual(['first', 'second']);

    fs.mkdirSync(path.join(repository, 'changes', 'archive'));
    fs.renameSync(path.join(repository, 'changes', 'first'), path.join(repository, 'changes', 'archive', 'first'));
    commitAll(repository, 'archive first', '2024-02-01T10:00:00Z');
    expect(await new RepoFolderAdapter().listExternalIds({ source: 'repo_folder', repository: 'changes' }, project)).toEqual(['second']);
  });

  it('refuses a folder the branch does not have, before saving and when listing', async () => {
    const project = { path: changesRepository, baseBranch: 'main' };
    await expect(new RepoFolderAdapter().prepareSource('openspec/missing', project)).rejects.toBeInstanceOf(RefusalError);
    // In the working tree only, so still not on the branch.
    await expect(new RepoFolderAdapter().prepareSource('openspec/changes/uncommitted-change', project)).rejects.toThrow('No folder openspec/changes/uncommitted-change on main.');
    await expect(new RepoFolderAdapter().fetch(fetchInput('openspec/missing'), noneImported, project)).rejects.toBeInstanceOf(RefusalError);
    await expect(new RepoFolderAdapter().prepareSource('openspec/changes', project)).resolves.toEqual({ label: 'openspec/changes', repository: 'openspec/changes' });
  });
});

describe('Browse', () => {
  it('lists every folder with how many tasks it would import, leaving out empty ones and dot-folders', async () => {
    const listing = await new RepoFolderAdapter().listFolders({ path: changesRepository, baseBranch: 'main' });
    expect(listing.baseBranch).toBe('main');
    const counts = new Map(listing.folders.map((folder) => [folder.path, folder.itemCount]));
    expect(counts.get('openspec/changes')).toBe(3);
    expect(counts.get('openspec/changes/archive')).toBe(1);
    // Two files; `specs/` holds no top-level file, so it is no item of its own.
    expect(counts.get('openspec/changes/add-login')).toBe(2);
    // `auth/` holds `spec.md`, so it is one.
    expect(counts.get('openspec/changes/add-login/specs')).toBe(1);
    // Holds only `.gitkeep`.
    expect(counts.has('openspec/changes/only-dots')).toBe(false);
    expect([...counts.keys()].some((folderPath) => folderPath.startsWith('.github'))).toBe(false);
  });
});

describe('which branch tip is read', () => {
  /** `main` at commit one, then a second commit adding `later`, with refs placed by each case. */
  function twoCommitRepository(name: string): { repository: string; first: string; second: string } {
    const repository = initRepository(name);
    writeFile(repository, 'changes/early/proposal.md');
    const first = commitAll(repository, 'early', '2024-01-01T10:00:00Z');
    writeFile(repository, 'changes/later/proposal.md');
    const second = commitAll(repository, 'later', '2024-02-01T10:00:00Z');
    return { repository, first, second };
  }

  it('reads origin when it is ahead of local main, with no fetch', async () => {
    const { repository, first, second } = twoCommitRepository('origin-ahead');
    git(repository, ['update-ref', 'refs/remotes/origin/main', second]);
    git(repository, ['update-ref', 'refs/heads/main', first]);
    expect(await fetchTitles(new RepoFolderAdapter(), repository, 'changes')).toEqual(['early', 'later']);
  });

  it('reads local main when it is ahead of origin', async () => {
    const { repository, first } = twoCommitRepository('local-ahead');
    git(repository, ['update-ref', 'refs/remotes/origin/main', first]);
    expect(await fetchTitles(new RepoFolderAdapter(), repository, 'changes')).toEqual(['early', 'later']);
  });

  it('reads the later commit when the two have diverged', async () => {
    const { repository, first, second } = twoCommitRepository('diverged');
    git(repository, ['checkout', '-q', '-b', 'side', first]);
    writeFile(repository, 'changes/side-change/proposal.md');
    const sideCommit = commitAll(repository, 'side', '2030-01-01T10:00:00Z');
    git(repository, ['checkout', '-q', 'main']);
    git(repository, ['update-ref', 'refs/remotes/origin/main', sideCommit]);
    expect(git(repository, ['rev-parse', 'main'])).toBe(second);
    expect(await fetchTitles(new RepoFolderAdapter(), repository, 'changes')).toEqual(['early', 'side-change']);
  });

  it('refuses a project folder that is no git repository, as a refusal rather than a git failure', async () => {
    const plainFolder = path.join(workspace, 'not-a-repository');
    fs.mkdirSync(plainFolder);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    // Stop git looking above the temp folder for a repository that holds it.
    process.env.GIT_CEILING_DIRECTORIES = workspace;
    try {
      const listing = new RepoFolderAdapter().listFolders({ path: plainFolder, baseBranch: 'main' });
      await expect(listing).rejects.toBeInstanceOf(RefusalError);
      await expect(listing).rejects.toThrow('This project is not a git repository.');
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it('reads origin alone when there is no local branch of that name, and refuses a branch neither has', async () => {
    const { repository, second } = twoCommitRepository('origin-only');
    git(repository, ['update-ref', 'refs/remotes/origin/trunk', second]);
    expect(await fetchTitles(new RepoFolderAdapter(), repository, 'changes', 'trunk')).toEqual(['early', 'later']);
    await expect(fetchTitles(new RepoFolderAdapter(), repository, 'changes', 'release')).rejects.toThrow('No branch release in this repository.');
  });
});
