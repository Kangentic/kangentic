/**
 * A linked folder is the main checkout's own data, and a recursive delete
 * follows a junction. Measured on Windows: `git worktree remove --force` deleted
 * a junction target's contents. So these run real git over a real link with a
 * sentinel file behind it, through every path a worktree can be removed by, and
 * the sentinel must survive each. What a user loses if one goes is the folder.
 *
 * CI's Linux has no junctions, and git there does not follow a symlink, so a
 * regression here reads green on CI. Run this file on Windows after touching
 * removal: `npx vitest run tests/unit/worktree-links.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  WorktreeManager,
  prepareStaleWorktreeForCreation,
  prepareWorktreeForRemoval,
  type WorktreeCreateResult,
} from '../../src/main/git/worktree-manager';
import { clearMovedWorktreeLinks, clearWorktreeLinks, linkWorktreeFolders } from '../../src/main/git/worktree-links';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import { copyEntries } from '../../src/main/git/worktree-copy/copy-entries';
import { worktreeCopyClient } from '../../src/main/git/worktree-copy/worktree-copy-client';

const { linkRemovalFails } = vi.hoisted(() => ({ linkRemovalFails: { value: false } }));

vi.mock('../../src/main/git/node-modules-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/node-modules-link')>();
  return {
    ...actual,
    removeLinkOnly: (target: string) => (linkRemovalFails.value ? false : actual.removeLinkOnly(target)),
  };
});

vi.setConfig({ testTimeout: 60_000 });

let workspace: string;
let projectPath: string;
let sharedFolder: string;
let sentinel: string;
let nextDisplayId = 100;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function newWorktree(manager: WorktreeManager): Promise<WorktreeCreateResult> {
  nextDisplayId += 1;
  return manager.withLock(() => manager.createWorktree({
    id: `${nextDisplayId}aaaaa-0000-0000-0000-000000000000`,
    title: `Task ${nextDisplayId}`,
    display_id: nextDisplayId,
    worktree_path: null,
    worktree_folder: null,
    branch_name: null,
  }, 'main'));
}

function isLink(target: string): boolean {
  try {
    fs.readlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function recordOf(worktreePath: string): string[] {
  const gitDir = run(worktreePath, ['rev-parse', '--absolute-git-dir']).trim();
  return JSON.parse(fs.readFileSync(path.join(gitDir, 'kangentic-links.json'), 'utf8')) as string[];
}

beforeAll(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-links-')));
  projectPath = path.join(workspace, 'project');
  fs.mkdirSync(projectPath);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  // A trailing slash on purpose: it does not match a link, which git sees as a file.
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\ndatasets/\nlater/\nbehind/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  fs.mkdirSync(path.join(projectPath, 'tracked'));
  fs.writeFileSync(path.join(projectPath, 'tracked', 'file.txt'), 'tracked\n');
  run(projectPath, ['add', '-A']);
  run(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  sharedFolder = path.join(projectPath, 'datasets');
  fs.mkdirSync(sharedFolder);
  sentinel = path.join(sharedFolder, 'sentinel.txt');
  clearFetchCache();
});

beforeEach(() => {
  linkRemovalFails.value = false;
  fs.writeFileSync(sentinel, 'the main checkout\'s data');
});

afterAll(async () => {
  clearFetchCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('linkWorktreeFolders', () => {
  it('links a folder at its relative path, shared both ways', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);

    await linkWorktreeFolders(worktreePath, projectPath, ['datasets/']);

    expect(isLink(path.join(worktreePath, 'datasets'))).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, 'datasets', 'sentinel.txt'), 'utf8')).toBe('the main checkout\'s data');
  });

  it('keeps the link out of git status and git add, though .gitignore says datasets/ with a slash', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);

    expect(run(worktreePath, ['status', '--porcelain'])).toBe('');
    run(worktreePath, ['add', '-A']);
    expect(run(worktreePath, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('writes the record before it makes the link, so no junction ever exists without one', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const realSymlink = fs.promises.symlink;
    let recordedAtLink: string[] = [];
    const spy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (...args: Parameters<typeof realSymlink>) => {
      recordedAtLink = recordOf(worktreePath);
      await realSymlink(...args);
    });

    await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);

    spy.mockRestore();
    expect(recordedAtLink).toEqual(['datasets']);
  });

  it('never replaces what the worktree already has at the path', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);

    await linkWorktreeFolders(worktreePath, projectPath, ['tracked']);

    expect(isLink(path.join(worktreePath, 'tracked'))).toBe(false);
    expect(fs.readFileSync(path.join(worktreePath, 'tracked', 'file.txt'), 'utf8').trim()).toBe('tracked');
  });

  it('links what can link and skips the rest: missing, a glob, node_modules, an escape', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);

    await linkWorktreeFolders(worktreePath, projectPath, ['missing', 'data*', 'node_modules', '../outside', 'datasets']);

    expect(recordOf(worktreePath)).toEqual(['datasets']);
    expect(fs.existsSync(path.join(worktreePath, 'missing'))).toBe(false);
  });

  it('runs again safely, as a spare claim does, and adds to the record', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);
    const later = path.join(projectPath, 'later');
    fs.mkdirSync(later);

    await linkWorktreeFolders(worktreePath, projectPath, ['datasets', 'later']);

    expect(recordOf(worktreePath)).toEqual(['datasets', 'later']);
    expect(isLink(path.join(worktreePath, 'later'))).toBe(true);
    await clearWorktreeLinks(worktreePath);
    fs.rmSync(later, { recursive: true, force: true });
  });

  it('never links under another link, where the new link would land in what that one names', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    fs.mkdirSync(path.join(projectPath, 'behind', 'inner'), { recursive: true });
    const elsewhere = path.join(workspace, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(worktreePath, 'behind'), process.platform === 'win32' ? 'junction' : 'dir');

    await linkWorktreeFolders(worktreePath, projectPath, ['behind/inner']);

    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(path.join(worktreePath, 'behind'), { recursive: true, force: true });
    fs.rmSync(path.join(projectPath, 'behind'), { recursive: true, force: true });
  });

  it('links nothing and leaves the record\'s bytes alone when the record cannot be read', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const recordFile = path.join(run(worktreePath, ['rev-parse', '--absolute-git-dir']).trim(), 'kangentic-links.json');
    fs.writeFileSync(recordFile, 'this is not json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);

      expect(isLink(path.join(worktreePath, 'datasets'))).toBe(false);
      expect(fs.existsSync(path.join(worktreePath, 'datasets'))).toBe(false);
      expect(fs.readFileSync(recordFile, 'utf8')).toBe('this is not json');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read the link record'));
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(recordFile, { force: true });
    }
  });

  it('leaves a folder git does not ignore unlinked, because the exclude line would hide it in the main checkout', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const unignored = path.join(projectPath, 'untracked-work');
    fs.mkdirSync(unignored);
    fs.writeFileSync(path.join(unignored, 'mine.txt'), 'in progress');

    await linkWorktreeFolders(worktreePath, projectPath, ['untracked-work']);

    expect(fs.existsSync(path.join(worktreePath, 'untracked-work'))).toBe(false);
    expect(run(projectPath, ['status', '--porcelain'])).toContain('untracked-work');
    fs.rmSync(unignored, { recursive: true, force: true });
  });
});

describe('a removal leaves the linked folder alone', () => {
  async function linkedWorktree(manager: WorktreeManager): Promise<string> {
    const { worktreePath } = await newWorktree(manager);
    await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);
    return worktreePath;
  }

  it('removeWorktree: git worktree remove', async () => {
    const manager = new WorktreeManager(projectPath);
    const worktreePath = await linkedWorktree(manager);

    expect(await manager.withLock(() => manager.removeWorktree(worktreePath))).toBe(true);

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('prepareWorktreeForRemoval, then removeWorktree, as a To Do move and a delete do', async () => {
    const manager = new WorktreeManager(projectPath);
    const worktreePath = await linkedWorktree(manager);

    await prepareWorktreeForRemoval(worktreePath, 'thorough');
    expect(isLink(path.join(worktreePath, 'datasets'))).toBe(false);
    await manager.withLock(() => manager.removeWorktree(worktreePath));

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('moveWorktreeAside, then the deleter, as a Done move does', async () => {
    const manager = new WorktreeManager(projectPath);
    const worktreePath = await linkedWorktree(manager);

    expect(await manager.withLock(() => manager.moveWorktreeAside(worktreePath))).toBe(true);

    const asideRoot = path.join(projectPath, '.kangentic', 'removed-worktrees');
    const moved = fs.readdirSync(asideRoot).map((name) => path.join(asideRoot, name));
    for (const copy of moved) expect(isLink(path.join(copy, 'datasets'))).toBe(false);
    for (const copy of moved) fs.rmSync(copy, { recursive: true, force: true });
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('prepareStaleWorktreeForCreation clears the link ahead of the stale-directory delete', async () => {
    const manager = new WorktreeManager(projectPath);
    const created = await newWorktree(manager);
    await linkWorktreeFolders(created.worktreePath, projectPath, ['datasets']);

    await prepareStaleWorktreeForCreation(
      { display_id: nextDisplayId, worktree_path: null, worktree_folder: created.worktreeFolder },
      projectPath,
      { worktreesEnabled: true },
    );

    expect(isLink(path.join(created.worktreePath, 'datasets'))).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    await manager.withLock(() => manager.removeWorktree(created.worktreePath));
  });

  it('holds after the entry was taken out of Settings: the record decides, never the setting', async () => {
    const manager = new WorktreeManager(projectPath);
    const worktreePath = await linkedWorktree(manager);
    // Nothing below reads config, so the entry being gone from it changes nothing.

    await manager.withLock(() => manager.removeWorktree(worktreePath));

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('refuses the removal when a link will not come out, rather than deleting through it', async () => {
    const manager = new WorktreeManager(projectPath);
    const worktreePath = await linkedWorktree(manager);
    linkRemovalFails.value = true;

    expect(await clearWorktreeLinks(worktreePath)).toBe(false);
    expect(await manager.withLock(() => manager.removeWorktree(worktreePath))).toBe(false);

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
    linkRemovalFails.value = false;
    await manager.withLock(() => manager.removeWorktree(worktreePath));
  });
});

describe('clearWorktreeLinks', () => {
  it('removes only a link, so a real folder at a recorded path goes with the worktree as usual', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);
    await clearWorktreeLinks(worktreePath);
    const realFolder = path.join(worktreePath, 'datasets');
    fs.mkdirSync(realFolder);
    fs.writeFileSync(path.join(realFolder, 'own.txt'), 'the branch\'s');

    expect(await clearWorktreeLinks(worktreePath)).toBe(true);

    expect(fs.existsSync(path.join(realFolder, 'own.txt'))).toBe(true);
  });

  it('is true for a worktree with no record, and for a folder with no git at all', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    expect(await clearWorktreeLinks(worktreePath)).toBe(true);
    const plainFolder = path.join(workspace, 'plain');
    fs.mkdirSync(plainFolder);
    expect(await clearWorktreeLinks(plainFolder)).toBe(true);
  });

  describe('a record it cannot read is not an empty one', () => {
    it.each([
      ['is not valid JSON', 'this is not json'],
      ['holds JSON that is not a list', '{"datasets": true}'],
    ])('refuses when the record %s, and the removal leaves the link and the folder behind it', async (_label, contents) => {
      const manager = new WorktreeManager(projectPath);
      const { worktreePath } = await newWorktree(manager);
      await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);
      const recordFile = path.join(run(worktreePath, ['rev-parse', '--absolute-git-dir']).trim(), 'kangentic-links.json');
      const goodRecord = fs.readFileSync(recordFile, 'utf8');
      fs.writeFileSync(recordFile, contents);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await clearWorktreeLinks(worktreePath)).toBe(false);
        expect(await manager.withLock(() => manager.removeWorktree(worktreePath))).toBe(false);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read the link record'));
        expect(isLink(path.join(worktreePath, 'datasets'))).toBe(true);
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect(fs.existsSync(sentinel)).toBe(true);
      } finally {
        warnSpy.mockRestore();
        fs.writeFileSync(recordFile, goodRecord);
        await manager.withLock(() => manager.removeWorktree(worktreePath));
      }
      expect(fs.existsSync(sentinel)).toBe(true);
    });

    it('refuses when the .git file names a git folder that is gone, as in a repository moved by hand', async () => {
      const manager = new WorktreeManager(projectPath);
      const { worktreePath } = await newWorktree(manager);
      await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);
      const dotGit = path.join(worktreePath, '.git');
      const goodDotGit = fs.readFileSync(dotGit, 'utf8');
      // Replaced, not rewritten: Windows refuses to open the hidden file for writing.
      fs.rmSync(dotGit);
      fs.writeFileSync(dotGit, `gitdir: ${path.join(workspace, 'no-such-git-folder')}\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await clearWorktreeLinks(worktreePath)).toBe(false);
        expect(isLink(path.join(worktreePath, 'datasets'))).toBe(true);
        expect(fs.existsSync(sentinel)).toBe(true);
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(dotGit, { force: true });
        fs.writeFileSync(dotGit, goodDotGit);
        await manager.withLock(() => manager.removeWorktree(worktreePath));
      }
      expect(fs.existsSync(sentinel)).toBe(true);
    });

    it('refuses when a .git file is there but names nothing readable', async () => {
      const leftover = path.join(workspace, 'leftover-with-dot-git');
      fs.mkdirSync(leftover);
      fs.writeFileSync(path.join(leftover, '.git'), 'garbage\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await clearWorktreeLinks(leftover)).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('ignores a record that climbs out of the worktree', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const gitDir = run(worktreePath, ['rev-parse', '--absolute-git-dir']).trim();
    fs.writeFileSync(path.join(gitDir, 'kangentic-links.json'), JSON.stringify(['../..', 7, 'datasets']));

    expect(await clearWorktreeLinks(worktreePath)).toBe(true);

    expect(fs.existsSync(projectPath)).toBe(true);
  });

  it('reads the record through a moved copy\'s .git file', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    await linkWorktreeFolders(worktreePath, projectPath, ['datasets']);
    const movedPath = path.join(workspace, 'moved-copy');
    fs.renameSync(worktreePath, movedPath);

    await clearMovedWorktreeLinks(movedPath);

    expect(isLink(path.join(movedPath, 'datasets'))).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    fs.rmSync(movedPath, { recursive: true, force: true });
  });
});

describe('every removal goes through clearWorktreeLinks', () => {
  it('leaves removeNodeModulesPath to the two files that own it', () => {
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('removeNodeModulesPath(')) offenders.push(entry.name);
      }
    };
    walk(path.join(process.cwd(), 'src', 'main'));
    expect(offenders.sort()).toEqual(['node-modules-link.ts', 'worktree-links.ts']);
  });
});

/**
 * The worker needs Electron's utilityProcess, which vitest has none of, so the
 * client's `copy` runs the same `copyEntries` inline. What the tests read is
 * whether the manager sent a list there, and with what.
 */
function spyOnWorker() {
  return vi.spyOn(worktreeCopyClient, 'copy').mockImplementation((request, signal) => copyEntries(request, signal));
}

describe('WorktreeManager.copyWorktreeFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a plain-file list off the worker, and out of a linked folder and off a climbing path', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    fs.writeFileSync(path.join(workspace, 'outside.txt'), 'outside');
    fs.writeFileSync(path.join(projectPath, 'local.env'), 'env');

    const workerCopy = spyOnWorker();

    await manager.copyWorktreeFiles(worktreePath, {
      copyFiles: ['local.env', 'datasets/sentinel.txt', '../outside.txt'],
      linkFolders: ['datasets'],
    });

    expect(workerCopy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktreePath, 'local.env'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'datasets'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'outside.txt'))).toBe(true);
    fs.rmSync(path.join(projectPath, 'local.env'), { force: true });
  });

  it('keeps a plain file under a name with glob characters off the worker, because it exists as named', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const pageFile = path.join(projectPath, 'app', '[id]', 'page.tsx');
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, 'page');
    const workerCopy = spyOnWorker();
    try {
      await manager.copyWorktreeFiles(worktreePath, { copyFiles: ['app/[id]/page.tsx'] });

      expect(workerCopy).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(worktreePath, 'app', '[id]', 'page.tsx'), 'utf8')).toBe('page');
    } finally {
      fs.rmSync(path.join(projectPath, 'app'), { recursive: true, force: true });
    }
  });

  it('sends a list with a folder, and a list with a glob, to the worker', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const folder = path.join(projectPath, 'local-config');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.json'), '{}');
    fs.writeFileSync(path.join(projectPath, 'glob-me.local'), 'glob');
    const workerCopy = spyOnWorker();
    try {
      await manager.copyWorktreeFiles(worktreePath, { copyFiles: ['README.md', 'local-config'] });
      expect(workerCopy).toHaveBeenCalledTimes(1);

      await manager.copyWorktreeFiles(worktreePath, { copyFiles: ['*.local'] });
      expect(workerCopy).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(path.join(worktreePath, 'glob-me.local'))).toBe(true);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(path.join(projectPath, 'glob-me.local'), { force: true });
    }
  });

  it('hands the worker the linked folders of the setup and the caller\'s abort signal', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const folder = path.join(projectPath, 'local-config');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.json'), '{}');
    const workerCopy = spyOnWorker();
    const controller = new AbortController();
    try {
      const setup = { copyFiles: ['local-config'], linkFolders: ['datasets', '../outside'] };
      await manager.copyWorktreeFiles(worktreePath, setup, { signal: controller.signal });
      await manager.copyWorktreeFiles(worktreePath, { ...setup, linkNodeModules: false });

      expect(workerCopy).toHaveBeenNthCalledWith(
        1,
        { projectPath, worktreePath, entries: ['local-config'], linkedFolders: ['node_modules', 'datasets'] },
        controller.signal,
      );
      expect(workerCopy.mock.calls[1][0].linkedFolders).toEqual(['datasets']);
      expect(workerCopy.mock.calls[1][1]).toBeUndefined();
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('copies a folder whole except a subfolder the setup links', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const folder = path.join(projectPath, 'local-config');
    fs.mkdirSync(path.join(folder, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'own.json'), '{}');
    fs.writeFileSync(path.join(folder, 'shared', 'big.bin'), 'shared');
    spyOnWorker();

    await manager.setUpWorktree(worktreePath, {
      copyFiles: ['local-config'],
      linkNodeModules: false,
      linkFolders: ['local-config/shared'],
    });

    expect(fs.existsSync(path.join(worktreePath, 'local-config', 'own.json'))).toBe(true);
    // Not copied as files into the worktree, and not linked either: git does not ignore it.
    expect(fs.existsSync(path.join(worktreePath, 'local-config', 'shared'))).toBe(false);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('copies a folder entry, which used to fail the start', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);
    const folder = path.join(projectPath, 'local-config');
    fs.mkdirSync(path.join(folder, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'nested', 'a.json'), '{}');

    await manager.setUpWorktree(worktreePath, { copyFiles: ['local-config', '*.nothing'], linkNodeModules: false });

    expect(fs.existsSync(path.join(worktreePath, 'local-config', 'nested', 'a.json'))).toBe(true);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('links folders in setUpWorktree, after the copy, so the script sees them', async () => {
    const manager = new WorktreeManager(projectPath);
    const { worktreePath } = await newWorktree(manager);

    await manager.setUpWorktree(worktreePath, { copyFiles: [], linkNodeModules: false, linkFolders: ['datasets'] });

    expect(isLink(path.join(worktreePath, 'datasets'))).toBe(true);
    await manager.withLock(() => manager.removeWorktree(worktreePath));
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});
