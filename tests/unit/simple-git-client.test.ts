/**
 * Every simple-git client the app opens keeps `GIT_CEILING_DIRECTORIES`.
 *
 * simple-git 4 removes every inherited `GIT_*` variable from the environment it
 * gives git unless `allowEnvironment` names it. A dev preview sets
 * `GIT_CEILING_DIRECTORIES` (scripts/dev.js, scripts/preview-isolation.js) so a
 * git command run in a preview project whose `.git` is missing cannot climb into
 * the worktree above it. A preview once hard-reset a worktree that way. These
 * tests pin that the factory in src/main/git/simple-git-client.ts keeps the
 * variable, and that nothing opens a client around it.
 *
 * Tier: Unit. Runs real git in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { openSimpleGit, SIMPLE_GIT_ALLOWED_ENVIRONMENT } from '../../src/main/git/simple-git-client';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let workspace: string;
let previewProjectsDirectory: string;
let projectWithoutGit: string;

beforeAll(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-simple-git-client-')));
  // The worktree: a real repository, with the preview's projects folder inside it.
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  previewProjectsDirectory = path.join(workspace, 'preview-projects');
  // A preview project whose `.git` is gone, the state the incident started from.
  projectWithoutGit = path.join(previewProjectsDirectory, 'project-1');
  fs.mkdirSync(projectWithoutGit, { recursive: true });
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('openSimpleGit', () => {
  it('allows only GIT_CEILING_DIRECTORIES through simple-git 4\'s environment guard', () => {
    expect(SIMPLE_GIT_ALLOWED_ENVIRONMENT).toEqual(['GIT_CEILING_DIRECTORIES']);
  });

  it('keeps the ceiling, so git in a project with no .git never finds the worktree above it', async () => {
    vi.stubEnv('GIT_CEILING_DIRECTORIES', previewProjectsDirectory);
    try {
      await expect(openSimpleGit(projectWithoutGit).revparse(['--show-toplevel'])).rejects.toThrow(/not a git repository/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is what keeps it: a plain client has the variable stripped and finds the worktree', async () => {
    // The control. Without it the test above would pass against a client that
    // never saw the ceiling for some other reason.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', previewProjectsDirectory);
    try {
      const toplevel = (await simpleGit(projectWithoutGit).revparse(['--show-toplevel'])).trim();
      expect(fs.realpathSync(toplevel)).toBe(workspace);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still reads a repository normally with no ceiling set', async () => {
    const toplevel = (await openSimpleGit(workspace).revparse(['--show-toplevel'])).trim();
    expect(fs.realpathSync(toplevel)).toBe(workspace);
  });
});

describe('no simple-git client is opened around the factory', () => {
  function collectSourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...collectSourceFiles(entryPath));
      else if (/\.tsx?$/.test(entry.name)) files.push(entryPath);
    }
    return files;
  }

  it('only simple-git-client.ts imports the simpleGit factory function from simple-git', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(path.join(REPO_ROOT, 'src'))) {
      if (path.basename(file) === 'simple-git-client.ts') continue;
      const source = fs.readFileSync(file, 'utf8');
      // A value import of `simpleGit` (or the default export). `import type` is erased and harmless.
      const importPattern = /^import\s+(?!type\b)([^;]*?)\s+from\s+'simple-git';/gm;
      for (const match of source.matchAll(importPattern)) {
        if (/\bsimpleGit\b/.test(match[1]) || !match[1].includes('{')) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(
      offenders,
      'Open a client through openSimpleGit (src/main/git/simple-git-client.ts), which keeps GIT_CEILING_DIRECTORIES '
      + 'that simple-git 4 would otherwise strip. A dev preview relies on it.',
    ).toEqual([]);
  });

  it('the scan finds the factory\'s own import, so it cannot pass by matching nothing', () => {
    const factorySource = fs.readFileSync(path.join(REPO_ROOT, 'src/main/git/simple-git-client.ts'), 'utf8');
    expect(factorySource).toMatch(/^import\s+\{\s*simpleGit/m);
  });
});
