/**
 * DiffService's branch scope on a repository with no commits yet (Sentry
 * DESKTOP-4A).
 *
 * With no commit, HEAD names nothing. No merge base resolves, so the fork point
 * fell back to `'HEAD'`, and `git diff --name-status HEAD` exits 128 with
 * "ambiguous argument 'HEAD': unknown revision". The Changes panel's default
 * scope rejected on every such project. The empty tree stands in for the missing
 * HEAD, so the panel shows the working tree, and it must stop standing in at the
 * first commit: a `DiffService` is cached per directory.
 *
 * Runs the real `git` binary against a temp directory, as
 * diff-service-range-real-git.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DiffService } from '../../src/main/git/diff-service';

let repository: string;

function run(args: string[]): string {
  return execFileSync('git', args, { cwd: repository, windowsHide: true }).toString().trim();
}

function writeFile(relativePath: string, content: string): void {
  fs.writeFileSync(path.join(repository, relativePath), content);
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-unborn-head-'));
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'dev@example.com']);
  run(['config', 'user.name', 'Dev']);
  run(['config', 'core.autocrlf', 'false']);
  run(['config', 'commit.gpgsign', 'false']);
});

afterEach(() => {
  // Retries: on Windows a handle the just-exited git process held a beat
  // longer surfaces as EBUSY/EPERM, which `force` does not cover.
  fs.rmSync(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the branch scope of a repository with no commits', () => {
  it('lists an untracked file instead of rejecting', async () => {
    writeFile('notes.txt', 'one\ntwo\n');

    const result = await new DiffService(repository).getDiffFiles({ projectPath: repository, baseBranch: 'main' });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'notes.txt', status: 'U', insertions: 2, deletions: 0, binary: false });
    expect(result.totalInsertions).toBe(2);
    expect(result.totalDeletions).toBe(0);
  });

  it('lists a staged file as added', async () => {
    writeFile('notes.txt', 'one\ntwo\n');
    run(['add', 'notes.txt']);

    const result = await new DiffService(repository).getDiffFiles({ projectPath: repository, baseBranch: 'main' });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'notes.txt', status: 'A', insertions: 2, deletions: 0, binary: false });
  });

  it('counts the same files as the churn of a task there', async () => {
    writeFile('notes.txt', 'one\ntwo\n');

    expect(await new DiffService(repository).getChurnSummary('main')).toEqual({ linesAdded: 2, linesRemoved: 0, filesChanged: 1 });
  });

  it('stops diffing against the empty tree once the first commit lands', async () => {
    const diffService = new DiffService(repository);
    writeFile('notes.txt', 'one\ntwo\n');
    expect((await diffService.getDiffFiles({ projectPath: repository, baseBranch: 'main' })).files).toHaveLength(1);

    run(['add', '-A']);
    run(['commit', '-q', '-m', 'initial']);

    // Against a cached empty tree every committed file would still read as added.
    expect((await diffService.getDiffFiles({ projectPath: repository, baseBranch: 'main' })).files).toEqual([]);
  });
});
