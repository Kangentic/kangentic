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
