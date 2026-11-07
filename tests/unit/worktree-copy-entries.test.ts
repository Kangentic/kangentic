/**
 * What `git.copyFiles` copies into a worktree, on real files. A user loses a
 * start, or files in the main checkout, when one of these goes wrong: a folder
 * entry used to fail the start outright, a `**` glob reaches every other
 * worktree unless the walk prunes `.kangentic`, and a copy under a link writes
 * into the main checkout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyEntries, COPY_LIMITS } from '../../src/main/git/worktree-copy/copy-entries';
import {
  globBaseSegments,
  globMaxDepth,
  hasGlobMagic,
  linkedFoldersOf,
  normalizeEntry,
} from '../../src/main/git/worktree-copy/entry-path';
import { WorktreeCopyLimitError } from '../../src/main/git/worktree-errors';
import { isUserConfigurationError } from '../../src/shared/user-configuration-error';

let workspace: string;
let projectPath: string;
let worktreePath: string;

function writeProjectFile(relative: string, contents = 'contents'): string {
  const target = path.join(projectPath, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function copied(relative: string): boolean {
  return fs.existsSync(path.join(worktreePath, ...relative.split('/')));
}

function copy(entries: string[], linkedFolders: string[] = []) {
  return copyEntries({ projectPath, worktreePath, entries, linkedFolders });
}

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-copy-')));
  projectPath = path.join(workspace, 'project');
  worktreePath = path.join(workspace, 'worktree');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(worktreePath);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('normalizeEntry', () => {
  it.each([
    ['.env', '.env'],
    ['config/', 'config'],
    ['./config/local', 'config/local'],
    ['config\\local', 'config/local'],
    ['  .env  ', '.env'],
  ])('reads %s as %s', (entry, expected) => {
    expect(normalizeEntry(entry)).toBe(expected);
  });

  it.each([
    '', '.', './', '../secret', 'config/../../secret', '/etc/passwd', 'C:\\Windows', 'C:foo', '\\\\server\\share',
    '.git', '.git/config', 'packages/app/.git', '.kangentic', '.KANGENTIC/worktrees', '.kangentic/**',
    // Windows drops a segment's trailing dots and spaces, so these name .git and .kangentic.
    '.git.', '.git ', '.git. ', '.kangentic.', 'foo/.git./x', 'foo/.KANGENTIC. /x',
  ])('refuses %s', (entry) => {
    expect(normalizeEntry(entry)).toBeNull();
  });

  it.each([
    ['foo.', 'foo.'],
    ['.github', '.github'],
    ['.github/workflows/', '.github/workflows'],
    ['.gitignore', '.gitignore'],
  ])('still accepts %s', (entry, expected) => {
    expect(normalizeEntry(entry)).toBe(expected);
  });
});

describe('glob helpers', () => {
  it('tells a glob from a path', () => {
    for (const glob of ['*.env', 'config/**', 'file?.txt', '*.{a,b}', '[ab].txt', '@(a|b).txt']) expect(hasGlobMagic(glob)).toBe(true);
    for (const literal of ['.env', 'config/local', 'a-b_c.d']) expect(hasGlobMagic(literal)).toBe(false);
  });

  it('starts a walk at the static prefix and bounds it by depth unless ** is in the pattern', () => {
    expect(globBaseSegments('packages/app/*.json')).toEqual(['packages', 'app']);
    expect(globBaseSegments('**/.env')).toEqual([]);
    expect(globMaxDepth('packages/*/dist')).toBe(3);
    expect(globMaxDepth('packages/**/dist')).toBeNull();
  });
});

describe('linkedFoldersOf', () => {
  it('holds node_modules unless its link is off, and the link entries as paths', () => {
    expect(linkedFoldersOf({})).toEqual(['node_modules']);
    expect(linkedFoldersOf({ linkNodeModules: false, linkFolders: ['data/models/', '../out'] })).toEqual(['data/models']);
  });
});

describe('copyEntries', () => {
  it('copies a folder whole, keeping relative paths, an empty folder included', async () => {
    writeProjectFile('config/local/a.json');
    writeProjectFile('config/local/deep/b.json');
    fs.mkdirSync(path.join(projectPath, 'config', 'empty'));

    const result = await copy(['config']);

    expect(copied('config/local/a.json')).toBe(true);
    expect(copied('config/local/deep/b.json')).toBe(true);
    expect(fs.statSync(path.join(worktreePath, 'config', 'empty')).isDirectory()).toBe(true);
    expect(result.copied).toBe(2);
  });

  it('copies glob matches at their relative paths and nothing else', async () => {
    writeProjectFile('app.local.json');
    writeProjectFile('app.dev.json');
    writeProjectFile('app.prod.json');
    writeProjectFile('packages/one/x.local.json');

    await copy(['*.{local,dev}.json']);

    expect(copied('app.local.json')).toBe(true);
    expect(copied('app.dev.json')).toBe(true);
    expect(copied('app.prod.json')).toBe(false);
    expect(copied('packages/one/x.local.json')).toBe(false);
  });

  it('finds a ** glob at any depth, and copies a folder a glob matches whole', async () => {
    writeProjectFile('.env');
    writeProjectFile('packages/one/.env');
    writeProjectFile('packages/one/dist/bundle.js');
    writeProjectFile('packages/two/dist/nested/bundle.js');

    await copy(['**/.env', 'packages/*/dist']);

    expect(copied('.env')).toBe(true);
    expect(copied('packages/one/.env')).toBe(true);
    expect(copied('packages/one/dist/bundle.js')).toBe(true);
    expect(copied('packages/two/dist/nested/bundle.js')).toBe(true);
  });

  it('counts a file two entries reach once', async () => {
    writeProjectFile('config/a.json');
    const result = await copy(['config', 'config/*.json', 'config/a.json']);
    expect(result.copied).toBe(1);
  });

  it('skips a missing entry, and a glob that matches nothing, without failing', async () => {
    writeProjectFile('.env');
    const result = await copy(['missing', 'missing/*.json', '*.nothing', '.env']);
    expect(result.copied).toBe(1);
  });

  it('never leaves the project for an entry that climbs out of it', async () => {
    fs.writeFileSync(path.join(workspace, 'secret.txt'), 'secret');
    await copy(['../secret.txt', path.join(workspace, 'secret.txt')]);
    expect(fs.readdirSync(worktreePath)).toEqual([]);
    expect(fs.readdirSync(workspace).sort()).toEqual(['project', 'secret.txt', 'worktree']);
  });

  it('walks past .git, .kangentic and node_modules, so ** cannot reach another worktree', async () => {
    writeProjectFile('.env');
    writeProjectFile('.git/.env');
    writeProjectFile('.kangentic/worktrees/other/.env');
    writeProjectFile('.kangentic/removed-worktrees/gone/.env');
    writeProjectFile('node_modules/some-package/.env');

    const result = await copy(['**/.env', '**/*']);

    expect(copied('.env')).toBe(true);
    expect(copied('.git')).toBe(false);
    expect(copied('.kangentic')).toBe(false);
    expect(copied('node_modules')).toBe(false);
    expect(result.copied).toBe(1);
  });

  it('leaves a nested node_modules behind when it copies a folder', async () => {
    writeProjectFile('packages/app/index.js');
    writeProjectFile('packages/app/node_modules/dep/index.js');
    await copy(['packages/app'], []);
    expect(copied('packages/app/index.js')).toBe(true);
    expect(copied('packages/app/node_modules')).toBe(false);
  });

  it('skips .claude under the root however an entry reaches it, but not a package\'s own', async () => {
    writeProjectFile('.claude/settings.local.json');
    writeProjectFile('settings.json');
    writeProjectFile('packages/app/.claude/keep.json');

    await copy(['.claude', '.claude/settings.local.json', '**/*.json', '.claude/*.json', 'packages']);

    expect(copied('.claude')).toBe(false);
    expect(copied('settings.json')).toBe(true);
    expect(copied('packages/app/.claude/keep.json')).toBe(true);
  });

  it('copies nothing a linked folder holds, whatever names it', async () => {
    writeProjectFile('data/models/big.bin');
    writeProjectFile('data/other.txt');
    writeProjectFile('node_modules/dep/index.js');

    await copy(['data', 'data/models/big.bin', 'node_modules/dep/index.js'], ['data/models', 'node_modules']);

    expect(copied('data/other.txt')).toBe(true);
    expect(copied('data/models')).toBe(false);
    expect(copied('node_modules')).toBe(false);
  });

  it('never writes through a link in the worktree, so a spare claim leaves the main checkout alone', async () => {
    const mainFolder = path.join(workspace, 'main-checkout-folder');
    fs.mkdirSync(mainFolder);
    const sentinel = path.join(mainFolder, 'file.txt');
    fs.writeFileSync(sentinel, 'the main checkout');
    fs.symlinkSync(mainFolder, path.join(worktreePath, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
    writeProjectFile('shared/file.txt', 'from the copy');
    writeProjectFile('shared/new.txt', 'from the copy');

    const result = await copy(['shared']);

    expect(fs.readFileSync(sentinel, 'utf8')).toBe('the main checkout');
    expect(fs.readdirSync(mainFolder)).toEqual(['file.txt']);
    expect(result.copied).toBe(0);
  });

  it('never follows a link in the source, and leaves out one that reaches elsewhere', async () => {
    const outside = path.join(workspace, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
    writeProjectFile('config/a.json');
    fs.symlinkSync(outside, path.join(projectPath, 'config', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await copy(['config', '**/private.txt']);

    expect(copied('config/a.json')).toBe(true);
    expect(copied('config/escape')).toBe(false);
    expect(result.skippedLinks).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('recreates a relative link that stays inside the copied folder', async () => {
    writeProjectFile('tool/lib/cli.js');
    fs.mkdirSync(path.join(projectPath, 'tool', 'bin'));
    fs.symlinkSync('../lib/cli.js', path.join(projectPath, 'tool', 'bin', 'cli'));

    await copy(['tool']);

    expect(fs.readlinkSync(path.join(worktreePath, 'tool', 'bin', 'cli'))).toBe('../lib/cli.js');
  });

  it('copies through a link an entry names when it is a file, as a plain entry always has', async () => {
    const shared = path.join(workspace, 'shared.env');
    fs.writeFileSync(shared, 'shared');
    writeProjectFile('real.txt');
    try {
      fs.symlinkSync(shared, path.join(projectPath, '.env'));
    } catch {
      return; // A file symlink needs Developer Mode on Windows.
    }
    await copy(['.env', 'real.txt']);
    expect(fs.readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('shared');
    expect(fs.lstatSync(path.join(worktreePath, '.env')).isSymbolicLink()).toBe(false);
  });

  it('copies a path that exists under a name with glob characters by name, and not its glob siblings', async () => {
    writeProjectFile('app/[id]/page.tsx', 'named');
    writeProjectFile('app/i/page.tsx', 'sibling');
    writeProjectFile('app/d/page.tsx', 'sibling');

    const result = await copy(['app/[id]/page.tsx']);

    expect(fs.readFileSync(path.join(worktreePath, 'app', '[id]', 'page.tsx'), 'utf8')).toBe('named');
    expect(copied('app/i/page.tsx')).toBe(false);
    expect(copied('app/d/page.tsx')).toBe(false);
    expect(result.copied).toBe(1);
  });

  it('still reads a glob that names nothing as a glob', async () => {
    writeProjectFile('app/a/page.tsx');
    writeProjectFile('app/b/page.tsx');
    writeProjectFile('app/c/page.tsx');

    await copy(['app/[ab]/page.tsx']);

    expect(copied('app/a/page.tsx')).toBe(true);
    expect(copied('app/b/page.tsx')).toBe(true);
    expect(copied('app/c/page.tsx')).toBe(false);
  });

  describe('a link on the source path', () => {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    let outside: string;

    beforeEach(() => {
      outside = path.join(workspace, 'outside');
      fs.mkdirSync(path.join(outside, 'private'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'private', 'secret.txt'), 'private');
      fs.writeFileSync(path.join(outside, 'data.json'), '{}');
    });

    it('copies nothing of a folder entry reached through a link', async () => {
      fs.mkdirSync(path.join(projectPath, 'config'));
      fs.symlinkSync(outside, path.join(projectPath, 'config', 'escape'), linkType);

      const result = await copy(['config/escape/private']);

      expect(fs.readdirSync(worktreePath)).toEqual([]);
      expect(result.copied).toBe(0);
    });

    it('copies nothing of a glob whose base is a link', async () => {
      fs.symlinkSync(outside, path.join(projectPath, 'shared'), linkType);

      const result = await copy(['shared/*.json']);

      expect(fs.readdirSync(worktreePath)).toEqual([]);
      expect(result.copied).toBe(0);
    });

    it('still copies a file entry reached through a link in the middle of its path, as the plain loop always did', async () => {
      fs.symlinkSync(outside, path.join(projectPath, 'shared'), linkType);

      await copy(['shared/data.json']);

      expect(fs.readFileSync(path.join(worktreePath, 'shared', 'data.json'), 'utf8')).toBe('{}');
    });
  });

  it('skips a literal entry under a file instead of failing the copy', async () => {
    // Windows reports ENOENT for this and Linux ENOTDIR. Neither may fail the start.
    writeProjectFile('package.json', '{}');
    writeProjectFile('.env');

    const result = await copy(['package.json/x', '.env']);

    expect(copied('.env')).toBe(true);
    expect(copied('package.json/x')).toBe(false);
    expect(result.copied).toBe(1);
  });

  it('keeps a link to a child named ..data inside the copied folder, and recreates it', async () => {
    writeProjectFile('mounted/..data/value.txt', 'value');
    try {
      fs.symlinkSync('..data', path.join(projectPath, 'mounted', 'current'), 'dir');
    } catch {
      return; // A symlink needs Developer Mode on Windows.
    }

    const result = await copy(['mounted']);

    expect(result.skippedLinks).toBe(0);
    expect(fs.readlinkSync(path.join(worktreePath, 'mounted', 'current'))).toBe('..data');
    expect(fs.readFileSync(path.join(worktreePath, 'mounted', 'current', 'value.txt'), 'utf8')).toBe('value');
  });

  it('leaves out a relative link this machine refuses to make, counts it, and still copies the files', async () => {
    writeProjectFile('tool/lib/cli.js');
    fs.mkdirSync(path.join(projectPath, 'tool', 'bin'));
    try {
      fs.symlinkSync('../lib/cli.js', path.join(projectPath, 'tool', 'bin', 'cli'));
    } catch {
      return; // A symlink needs Developer Mode on Windows.
    }
    // What Windows answers a relative symlink without Developer Mode.
    const refused = Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    const symlink = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(refused);
    try {
      const result = await copy(['tool']);

      expect(symlink).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ copied: 1, skippedLinks: 1 });
      expect(copied('tool/lib/cli.js')).toBe(true);
      expect(() => fs.lstatSync(path.join(worktreePath, 'tool', 'bin', 'cli'))).toThrow();
    } finally {
      symlink.mockRestore();
    }
  });

  describe('a second run', () => {
    it('replaces a read-only copy whose source changed, which a plain copyFile fails on with EPERM', async () => {
      const source = writeProjectFile('config.json', 'one');
      fs.chmodSync(source, 0o444);
      const destination = path.join(worktreePath, 'config.json');
      try {
        expect((await copy(['config.json'])).copied).toBe(1);
        expect(fs.statSync(destination).mode & 0o200).toBe(0);

        fs.chmodSync(source, 0o666);
        fs.writeFileSync(source, 'three');
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(source, later, later);
        fs.chmodSync(source, 0o444);

        const after = await copy(['config.json']);

        expect(after.copied).toBe(1);
        expect(fs.readFileSync(destination, 'utf8')).toBe('three');
      } finally {
        // So the folder can be deleted.
        for (const target of [source, destination]) {
          try {
            fs.chmodSync(target, 0o666);
          } catch { /* not there */ }
        }
      }
    });

    it('leaves files that match alone, and copies only what changed', async () => {
      writeProjectFile('config/a.json', 'one');
      writeProjectFile('config/b.json', 'two');
      expect((await copy(['config'])).copied).toBe(2);
      const copyFile = vi.spyOn(fs.promises, 'copyFile');

      const unchanged = await copy(['config']);
      expect(unchanged).toMatchObject({ copied: 0, unchanged: 2 });
      expect(copyFile).not.toHaveBeenCalled();

      const changed = writeProjectFile('config/b.json', 'three');
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(changed, later, later);
      const after = await copy(['config']);
      expect(after).toMatchObject({ copied: 1, unchanged: 1 });
      expect(fs.readFileSync(path.join(worktreePath, 'config', 'b.json'), 'utf8')).toBe('three');
      copyFile.mockRestore();
    });

    it('overwrites a file of the same size whose time differs', async () => {
      const source = writeProjectFile('config.json', 'aaaa');
      const destination = path.join(worktreePath, 'config.json');
      fs.writeFileSync(destination, 'bbbb');
      fs.utimesSync(destination, new Date(0), new Date(0));
      fs.utimesSync(source, new Date(), new Date());
      await copy(['config.json', '*.nothing']);
      expect(fs.readFileSync(destination, 'utf8')).toBe('aaaa');
    });
  });

  describe('the limits', () => {
    const noBudget = { ...COPY_LIMITS };

    it('fails a list over the file limit, naming the entry, before anything is copied', async () => {
      writeProjectFile('.env');
      writeProjectFile('datasets/a.bin');
      writeProjectFile('datasets/b.bin');
      writeProjectFile('datasets/c.bin');

      const failed = copyEntries(
        { projectPath, worktreePath, entries: ['.env', 'datasets'], linkedFolders: [] },
        undefined,
        { ...noBudget, files: 3 },
      );

      await expect(failed).rejects.toThrow('datasets has over 3 files');
      await expect(failed).rejects.toBeInstanceOf(WorktreeCopyLimitError);
      expect(fs.readdirSync(worktreePath)).toEqual([]);
    });

    it('fails a list over the byte limit, before anything is copied', async () => {
      writeProjectFile('datasets/a.bin', 'x'.repeat(2048));
      await expect(copyEntries(
        { projectPath, worktreePath, entries: ['datasets'], linkedFolders: [] },
        undefined,
        { ...noBudget, bytes: 1024 },
      )).rejects.toThrow(/^datasets is over /);
      expect(fs.readdirSync(worktreePath)).toEqual([]);
    });

    it('fails a glob over the walk limit, which is what bounds a ** across a huge project', async () => {
      for (let index = 0; index < 5; index += 1) writeProjectFile(`folder/${index}.txt`);
      await expect(copyEntries(
        { projectPath, worktreePath, entries: ['**/.env'], linkedFolders: [] },
        undefined,
        { ...noBudget, walkedEntries: 3 },
      )).rejects.toThrow('**/.env has over 3 entries to search');
    });

    it('is a settings mistake, so it stays out of crash reports', () => {
      expect(isUserConfigurationError(new WorktreeCopyLimitError('datasets has over 3 files'))).toBe(true);
    });

    it('holds at the limit itself', async () => {
      writeProjectFile('datasets/a.bin');
      writeProjectFile('datasets/b.bin');
      const result = await copyEntries(
        { projectPath, worktreePath, entries: ['datasets'], linkedFolders: [] },
        undefined,
        { ...noBudget, files: 2 },
      );
      expect(result.copied).toBe(2);
    });
  });

  it('stops on an abort with nothing written', async () => {
    writeProjectFile('config/a.json');
    const controller = new AbortController();
    controller.abort();
    await expect(copyEntries(
      { projectPath, worktreePath, entries: ['config'], linkedFolders: [] },
      controller.signal,
    )).rejects.toThrow();
    expect(fs.readdirSync(worktreePath)).toEqual([]);
  });

  it('has no write left running once a failure rejects', async () => {
    for (let index = 0; index < 20; index += 1) writeProjectFile(`config/${index}.json`);
    const realCopyFile = fs.promises.copyFile;
    let running = 0;
    const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args: Parameters<typeof realCopyFile>) => {
      running += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (String(args[0]).endsWith('3.json')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      await realCopyFile(...args);
    });
    await expect(copy(['config'])).rejects.toThrow('locked');
    expect(running).toBe(0);
    spy.mockRestore();
  });
});
