import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearProjectEntrySearchCache, searchProjectEntries } from '../../src/main/ipc/helpers/project-entry-search';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, contents = ''): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, 'utf8');
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

describe('searchProjectEntries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearProjectEntrySearchCache();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns files and directories relative to cwd', async () => {
    const cwd = makeTempDir('kangentic-project-search-');
    writeFile(cwd, 'src/components/Composer.tsx');
    writeFile(cwd, 'src/index.ts');
    writeFile(cwd, 'README.md');
    writeFile(cwd, '.git/HEAD');
    writeFile(cwd, '.kangentic/tmp/meta.json');
    writeFile(cwd, 'node_modules/pkg/index.js');

    const result = await searchProjectEntries({ cwd, query: '', limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain('src');
    expect(paths).toContain('src/components');
    expect(paths).toContain('src/components/Composer.tsx');
    expect(paths).toContain('README.md');
    expect(paths.some((entryPath) => entryPath.startsWith('.git'))).toBe(false);
    expect(paths.some((entryPath) => entryPath.startsWith('.kangentic'))).toBe(false);
    expect(paths.some((entryPath) => entryPath.startsWith('node_modules'))).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('ranks exact, prefix, substring, and fuzzy matches', async () => {
    const cwd = makeTempDir('kangentic-project-search-ranking-');
    writeFile(cwd, 'src/components/index.ts');
    writeFile(cwd, 'src/main/index.ts');
    writeFile(cwd, 'docs/indexing-guide.md');

    const exact = await searchProjectEntries({ cwd, query: 'index.ts', limit: 10 });
    expect(exact.entries[0]?.path).toBe('src/components/index.ts');

    const prefix = await searchProjectEntries({ cwd, query: 'inde', limit: 10 });
    expect(prefix.entries.map((entry) => entry.path)).toContain('src/main/index.ts');

    const fuzzy = await searchProjectEntries({ cwd, query: 'idx', limit: 10 });
    expect(fuzzy.entries.map((entry) => entry.path)).toContain('src/components/index.ts');
  });

  it('excludes gitignored paths including tracked files that now match .gitignore', async () => {
    const cwd = makeTempDir('kangentic-project-search-gitignore-');
    runGit(cwd, ['init']);
    writeFile(cwd, '.kangentic/internal/log.txt', 'hidden');
    writeFile(cwd, '.gitignore', '.kangentic/\nignored.txt\n');
    writeFile(cwd, 'src/keep.ts', 'export {};');
    writeFile(cwd, 'ignored.txt', 'ignore me');
    writeFile(cwd, 'tracked-now-ignored.txt', 'tracked');
    runGit(cwd, ['add', 'src/keep.ts', 'tracked-now-ignored.txt']);
    fs.appendFileSync(path.join(cwd, '.gitignore'), 'tracked-now-ignored.txt\n');

    const result = await searchProjectEntries({ cwd, query: '', limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain('src/keep.ts');
    expect(paths).not.toContain('ignored.txt');
    expect(paths).not.toContain('tracked-now-ignored.txt');
    expect(paths.some((entryPath) => entryPath.startsWith('.kangentic/'))).toBe(false);
  });

  it('leaves out tracked files sparse-checkout keeps off disk, as in a task worktree', async () => {
    // `ls-files --cached` lists skip-worktree entries too, so a task worktree's
    // file picker offered `.claude/commands/` files that were not there.
    const cwd = makeTempDir('kangentic-project-search-sparse-');
    runGit(cwd, ['init']);
    runGit(cwd, ['config', 'user.email', 'dev@example.com']);
    runGit(cwd, ['config', 'user.name', 'Dev']);
    runGit(cwd, ['config', 'core.excludesFile', path.join(cwd, 'no-global-excludes')]);
    writeFile(cwd, 'src/keep.ts', 'export {};');
    writeFile(cwd, '.claude/commands/review.md', '# review');
    writeFile(cwd, '.claude/skills/review/SKILL.md', '# skill');
    runGit(cwd, ['add', '-A']);
    runGit(cwd, ['commit', '-m', 'init']);
    runGit(cwd, ['sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/commands/']);
    writeFile(cwd, 'untracked-note.md', 'note');
    expect(fs.existsSync(path.join(cwd, '.claude', 'commands', 'review.md'))).toBe(false);

    const result = await searchProjectEntries({ cwd, query: '', limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain('src/keep.ts');
    expect(paths).toContain('.claude/skills/review/SKILL.md');
    expect(paths).toContain('untracked-note.md');
    expect(paths).not.toContain('.claude/commands/review.md');
    expect(paths).not.toContain('.claude/commands');
  });

  it('keeps a skip-worktree file that is still on disk', async () => {
    // `git update-index --skip-worktree` is also how developers keep local edits to a
    // tracked file (a config) out of git status. That file is on disk and must stay
    // searchable; only entries sparse-checkout actually left off disk are dropped.
    const cwd = makeTempDir('kangentic-project-search-skip-worktree-');
    runGit(cwd, ['init']);
    runGit(cwd, ['config', 'user.email', 'dev@example.com']);
    runGit(cwd, ['config', 'user.name', 'Dev']);
    runGit(cwd, ['config', 'core.excludesFile', path.join(cwd, 'no-global-excludes')]);
    writeFile(cwd, 'config/local-settings.json', '{}');
    writeFile(cwd, 'src/keep.ts', 'export {};');
    runGit(cwd, ['add', '-A']);
    runGit(cwd, ['commit', '-m', 'init']);
    runGit(cwd, ['update-index', '--skip-worktree', 'config/local-settings.json']);
    writeFile(cwd, 'config/local-settings.json', '{"mine":true}');

    const result = await searchProjectEntries({ cwd, query: '', limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain('config/local-settings.json');
    expect(paths).toContain('src/keep.ts');
  });

  it('tracks truncation when matches exceed the provided limit', async () => {
    const cwd = makeTempDir('kangentic-project-search-limit-');
    writeFile(cwd, 'src/components/Composer.tsx');
    writeFile(cwd, 'src/components/composePrompt.ts');
    writeFile(cwd, 'docs/composition.md');

    const result = await searchProjectEntries({ cwd, query: 'cmp', limit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('deduplicates concurrent index builds for the same cwd', async () => {
    const cwd = makeTempDir('kangentic-project-search-concurrent-');
    writeFile(cwd, 'src/components/Composer.tsx');

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, 'readdir').mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await Promise.all([
      searchProjectEntries({ cwd, query: '', limit: 100 }),
      searchProjectEntries({ cwd, query: 'comp', limit: 100 }),
      searchProjectEntries({ cwd, query: 'src', limit: 100 }),
    ]);

    expect(rootReadCount).toBe(1);
  });
});
