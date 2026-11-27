/**
 * What a user loses if `isInsideGitCheckout` breaks: a task with no worktree in a project
 * that is an SSH project, a subfolder of a repository, or a worktree itself either has its
 * lines changed skipped for good, or reads in a folder with no repository and fails every
 * time with git's exit 128.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInsideGitCheckout } from '../../src/main/git/git-checks';
import { setRemoteGitResolver, type RemoteGitRunner } from '../../src/main/git/remote-git';

const temporaryFolders: string[] = [];

function temporaryFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'inside-checkout-'));
  temporaryFolders.push(folder);
  return folder;
}

afterEach(() => {
  setRemoteGitResolver(null);
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('isInsideGitCheckout', () => {
  it('answers true for a remote project path with no .git anywhere above it', () => {
    // A folder under the filesystem root that is never created, so nothing above it holds a .git.
    const standIn = path.join(path.parse(os.tmpdir()).root, `kangentic-remote-standin-${process.pid}`, 'project');
    setRemoteGitResolver((directory) => (directory === standIn ? ({} as unknown as RemoteGitRunner) : null));

    expect(isInsideGitCheckout(standIn)).toBe(true);
  });

  it('answers true for a folder that holds a .git directory', () => {
    const folder = temporaryFolder();
    fs.mkdirSync(path.join(folder, '.git'));

    expect(isInsideGitCheckout(folder)).toBe(true);
  });

  it('answers true for a folder whose .git is a file, as a worktree has', () => {
    const folder = temporaryFolder();
    fs.writeFileSync(path.join(folder, '.git'), 'gitdir: /mock/project/.git/worktrees/1\n');

    expect(isInsideGitCheckout(folder)).toBe(true);
  });

  it('answers true for a subfolder of a repository', () => {
    const repository = temporaryFolder();
    fs.mkdirSync(path.join(repository, '.git'));
    const subfolder = path.join(repository, 'packages', 'app');
    fs.mkdirSync(subfolder, { recursive: true });

    expect(isInsideGitCheckout(subfolder)).toBe(true);
  });

  it('answers false for a folder with no repository at or above it and no remote project', () => {
    const folderWithNoRepository = path.join(path.parse(os.tmpdir()).root, `kangentic-no-repository-${process.pid}`, 'project');

    expect(isInsideGitCheckout(folderWithNoRepository)).toBe(false);
  });
});
