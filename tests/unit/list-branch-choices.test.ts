/**
 * The base picker's list (`WorktreeManager.listBranchChoices`), against a real
 * clone. Every task leaves a local branch named like `<slug>-<8 hex>`: one repo
 * measured 501 local-only branches, 473 of them a task's own. The list keeps
 * origin's branches, adds the local-only ones a person made, and leaves the
 * task branches out, so they never bury the rest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { hasAutoBranchShape, computeAutoBranchName } from '../../src/shared/slugify';

vi.setConfig({ testTimeout: 20000 });

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-branch-choices-'));
});

afterEach(async () => {
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

describe('hasAutoBranchShape', () => {
  it('matches the name computeAutoBranchName gives a task, and not a name a person picks', () => {
    expect(hasAutoBranchShape(computeAutoBranchName('fix-login-redirect', '67c04b9a'))).toBe(true);
    expect(hasAutoBranchShape('feat/prompt-options')).toBe(false);
    expect(hasAutoBranchShape('release-2024')).toBe(false);
    expect(hasAutoBranchShape('pr-762')).toBe(false);
  });

  it('needs a letter among the eight trailing hex digits, so a date stamp is not hidden', () => {
    expect(hasAutoBranchShape('release-20240115')).toBe(false);
    expect(hasAutoBranchShape('fix-thing-12345678')).toBe(false);
    expect(hasAutoBranchShape('fix-thing-ab12cd34')).toBe(true);
    expect(hasAutoBranchShape('fix-thing-1234567a')).toBe(true);
    expect(hasAutoBranchShape('fix-thing-a2345678')).toBe(true);
  });
});

describe('WorktreeManager.listBranchChoices', () => {
  it('lists origin\'s branches, then local-only ones a person made, and leaves task branches out', async () => {
    const origin = path.join(workspace, 'origin');
    fs.mkdirSync(origin);
    run(origin, ['init', '-q', '-b', 'main']);
    run(origin, ['config', 'user.email', 'dev@example.com']);
    run(origin, ['config', 'user.name', 'Dev']);
    run(origin, ['commit', '-q', '--allow-empty', '-m', 'init']);
    run(origin, ['branch', 'develop']);

    const clone = path.join(workspace, 'clone');
    execFileSync('git', ['clone', '-q', origin, clone], { windowsHide: true });
    run(clone, ['branch', 'wip/cache-spike']);
    run(clone, ['branch', computeAutoBranchName('fix-the-thing', 'ab12cd34')]);
    // A local branch origin also has is listed once, as origin's.
    run(clone, ['branch', 'develop', 'origin/develop']);

    const choices = await new WorktreeManager(clone).listBranchChoices();

    expect(choices.filter((choice) => !choice.local).map((choice) => choice.name).sort()).toEqual(['develop', 'main']);
    expect(choices.filter((choice) => choice.local)).toEqual([{ name: 'wip/cache-spike', local: true }]);
    // Origin's rows come first.
    expect(choices.at(-1)).toEqual({ name: 'wip/cache-spike', local: true });
  });

  it('lists a local branch under its own name when a tag shares it, and by the date-stamp rule', async () => {
    const origin = path.join(workspace, 'origin-tags');
    fs.mkdirSync(origin);
    run(origin, ['init', '-q', '-b', 'main']);
    run(origin, ['config', 'user.email', 'dev@example.com']);
    run(origin, ['config', 'user.name', 'Dev']);
    run(origin, ['commit', '-q', '--allow-empty', '-m', 'init']);

    const clone = path.join(workspace, 'clone-tags');
    execFileSync('git', ['clone', '-q', origin, clone], { windowsHide: true });
    // `%(refname:short)` prints `heads/v1` for a branch whose name a tag shares.
    run(clone, ['tag', 'v1']);
    run(clone, ['branch', 'v1']);
    run(clone, ['branch', 'release-20240115']);
    run(clone, ['branch', 'fix-thing-ab12cd34']);

    const choices = await new WorktreeManager(clone).listBranchChoices();
    const localNames = choices.filter((choice) => choice.local).map((choice) => choice.name).sort();

    expect(choices).toContainEqual({ name: 'v1', local: true });
    expect(localNames).toEqual(['release-20240115', 'v1']);
  });
});
