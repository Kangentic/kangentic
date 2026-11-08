/**
 * What a task's base names, against real repositories (`src/main/git/base-ref.ts`).
 *
 * A base is free text from the picker or MCP `baseBranch`: a branch, a tag or a
 * commit. Every reader asks this module which, so the precedence pinned here is
 * the one the whole app uses. Real git, because the claims are about what
 * `rev-parse` does with each form, including the trap that a bare `--verify` of
 * any 40-hex string exits 0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyBaseRef,
  fetchTagFromOrigin,
  preferredBranchStartPoint,
  resolveRefForDisplay,
  isFixedBase,
} from '../../src/main/git/base-ref';

vi.setConfig({ testTimeout: 20000 });

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-base-ref-'));
});

afterEach(async () => {
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

let fileCounter = 0;
function commit(cwd: string, message: string): string {
  fileCounter += 1;
  fs.writeFileSync(path.join(cwd, `f${fileCounter}.txt`), `content ${fileCounter}`);
  run(cwd, ['add', '-A']);
  run(cwd, ['commit', '-q', '-m', message]);
  return run(cwd, ['rev-parse', 'HEAD']);
}

function initRepo(name: string): string {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.email', 'dev@example.com']);
  run(dir, ['config', 'user.name', 'Dev']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/** A clone of a one-commit origin, so both `main` and `origin/main` exist. */
function cloneOfOrigin(label: string): { origin: string; clone: string } {
  const origin = initRepo(`${label}-origin`);
  commit(origin, 'init');
  const clone = path.join(workspace, `${label}-clone`);
  execFileSync('git', ['clone', '-q', origin, clone], { windowsHide: true });
  run(clone, ['config', 'user.email', 'dev@example.com']);
  run(clone, ['config', 'user.name', 'Dev']);
  run(clone, ['config', 'commit.gpgsign', 'false']);
  return { origin, clone };
}

describe('classifyBaseRef', () => {
  it('reads a branch, a tag, a full SHA and a short SHA as what they are', async () => {
    const repo = initRepo('kinds');
    const first = commit(repo, 'first');
    run(repo, ['tag', '-a', 'v1.0.0', '-m', 'release', first]);
    const second = commit(repo, 'second');

    expect(await classifyBaseRef(repo, 'main')).toEqual({ kind: 'branch', localSha: second, remoteSha: null });
    // An annotated tag peels to its commit, not the tag object.
    expect(await classifyBaseRef(repo, 'v1.0.0')).toEqual({ kind: 'tag', ref: 'refs/tags/v1.0.0', sha: first });
    expect(await classifyBaseRef(repo, first)).toEqual({ kind: 'commit', sha: first });
    expect(await classifyBaseRef(repo, first.slice(0, 8))).toEqual({ kind: 'commit', sha: first });
  });

  it('reads a 40-hex string with no such object as unresolved, which a bare rev-parse --verify does not', async () => {
    const repo = initRepo('missing-sha');
    commit(repo, 'first');
    const missing = '0123456789abcdef0123456789abcdef01234567';
    // The trap this module closes: git itself "verifies" it.
    expect(run(repo, ['rev-parse', '--verify', '--quiet', missing])).toBe(missing);

    expect(await classifyBaseRef(repo, missing)).toEqual({ kind: 'unresolved' });
  });

  it('reads a branch named like a tag as the branch, at every reader', async () => {
    const repo = initRepo('branch-like-tag');
    const first = commit(repo, 'first');
    run(repo, ['tag', 'release', first]);
    commit(repo, 'second');
    run(repo, ['branch', 'release']);

    const classified = await classifyBaseRef(repo, 'release');

    expect(classified.kind).toBe('branch');
    expect(isFixedBase(classified)).toBe(false);
  });

  it('never hands git an option-shaped value', async () => {
    const repo = initRepo('option-shaped');
    commit(repo, 'first');

    expect(await classifyBaseRef(repo, '--output=pwned')).toEqual({ kind: 'unresolved' });
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
  });

  // Each of these resolves under git, but each moves, so freezing it as a base would be wrong.
  it('reads HEAD as unresolved', async () => {
    const repo = initRepo('expr-head');
    commit(repo, 'first');
    expect(run(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).toMatch(/^[0-9a-f]{40}$/);

    expect(await classifyBaseRef(repo, 'HEAD')).toEqual({ kind: 'unresolved' });
  });

  it('reads main~1 as unresolved', async () => {
    const repo = initRepo('expr-ancestor');
    commit(repo, 'first');
    commit(repo, 'second');
    expect(run(repo, ['rev-parse', '--verify', 'main~1^{commit}'])).toMatch(/^[0-9a-f]{40}$/);

    expect(await classifyBaseRef(repo, 'main~1')).toEqual({ kind: 'unresolved' });
  });

  it('reads origin/main in a clone as unresolved', async () => {
    const { clone } = cloneOfOrigin('expr-origin-main');
    expect(run(clone, ['rev-parse', '--verify', 'origin/main^{commit}'])).toMatch(/^[0-9a-f]{40}$/);

    expect(await classifyBaseRef(clone, 'origin/main')).toEqual({ kind: 'unresolved' });
  });

  it('reads HEAD in a clone as unresolved, where refs/remotes/origin/HEAD also exists', async () => {
    const { clone } = cloneOfOrigin('expr-head-clone');

    expect(await classifyBaseRef(clone, 'HEAD')).toEqual({ kind: 'unresolved' });
  });
});

describe('preferredBranchStartPoint (origin unless local is ahead)', () => {
  it('takes origin when the two agree', async () => {
    const { clone } = cloneOfOrigin('agree');
    expect(await preferredBranchStartPoint(clone, 'main')).toBe('origin/main');
  });

  it('takes local when local holds commits origin does not have yet, by its full ref', async () => {
    const { clone } = cloneOfOrigin('local-ahead');
    commit(clone, 'merged but not pushed');
    expect(await preferredBranchStartPoint(clone, 'main')).toBe('refs/heads/main');
  });

  it('names the local branch so a tag of the same name cannot take the cut', async () => {
    const { clone } = cloneOfOrigin('tag-shadow');
    const tagged = run(clone, ['rev-parse', 'HEAD']);
    run(clone, ['tag', 'main', tagged]);
    const localTip = commit(clone, 'merged but not pushed');

    const startPoint = await preferredBranchStartPoint(clone, 'main');

    expect(run(clone, ['rev-parse', `${startPoint}^{commit}`])).toBe(localTip);
  });

  it('takes origin when local is behind it', async () => {
    const { origin, clone } = cloneOfOrigin('local-behind');
    commit(origin, 'teammate pushed');
    run(clone, ['fetch', '-q', 'origin']);
    expect(await preferredBranchStartPoint(clone, 'main')).toBe('origin/main');
  });

  it('takes origin when the two have diverged', async () => {
    const { origin, clone } = cloneOfOrigin('diverged');
    commit(origin, 'teammate pushed');
    run(clone, ['fetch', '-q', 'origin']);
    commit(clone, 'local only');
    expect(await preferredBranchStartPoint(clone, 'main')).toBe('origin/main');
  });

  it('takes whichever one exists', async () => {
    const { clone } = cloneOfOrigin('one-side');
    run(clone, ['branch', 'local-only']);
    run(clone, ['update-ref', 'refs/remotes/origin/remote-only', 'HEAD']);

    expect(await preferredBranchStartPoint(clone, 'local-only')).toBe('refs/heads/local-only');
    expect(await preferredBranchStartPoint(clone, 'remote-only')).toBe('origin/remote-only');
    expect(await preferredBranchStartPoint(clone, 'nowhere')).toBeNull();
  });
});

describe('resolveRefForDisplay', () => {
  it('answers a typed tag or commit with its kind and commit', async () => {
    const repo = initRepo('display-ok');
    const first = commit(repo, 'first');
    run(repo, ['tag', 'v2.4.0', first]);
    commit(repo, 'second');

    expect(await resolveRefForDisplay(repo, ' v2.4.0 ')).toEqual({ ok: true, kind: 'tag', sha: first });
    expect(await resolveRefForDisplay(repo, first.slice(0, 7))).toEqual({ ok: true, kind: 'commit', sha: first });
  });

  it('answers a ref that does not resolve with git\'s own stderr', async () => {
    const repo = initRepo('display-miss');
    commit(repo, 'first');

    const result = await resolveRefForDisplay(repo, 'v9.9.9');

    // git's own text, not ours. Its wording follows the machine's locale, so
    // only its presence is pinned.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('git');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('refuses an option-shaped value without running git on it', async () => {
    const repo = initRepo('display-option');
    commit(repo, 'first');

    const result = await resolveRefForDisplay(repo, '--output=pwned');

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
  });

  it('answers blank input as empty', async () => {
    const repo = initRepo('display-empty');
    commit(repo, 'first');

    expect(await resolveRefForDisplay(repo, '   ')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('answers an expression git resolves but that is not a base as not-a-base', async () => {
    const repo = initRepo('display-not-a-base');
    commit(repo, 'first');
    commit(repo, 'second');

    expect(await resolveRefForDisplay(repo, 'main~1')).toMatchObject({ ok: false, reason: 'not-a-base' });
  });

  it('answers HEAD as not-a-base', async () => {
    const repo = initRepo('display-not-a-base-head');
    commit(repo, 'first');

    expect(await resolveRefForDisplay(repo, 'HEAD')).toMatchObject({ ok: false, reason: 'not-a-base' });
  });

  it('reports a branch\'s local tip when local is ahead of origin', async () => {
    const { clone } = cloneOfOrigin('display-local-ahead');
    const localTip = commit(clone, 'merged but not pushed');

    expect(await resolveRefForDisplay(clone, 'main')).toEqual({ ok: true, kind: 'branch', sha: localTip });
  });

  it('reports origin\'s tip when a branch is equal on both sides', async () => {
    const { clone } = cloneOfOrigin('display-equal');
    const originTip = run(clone, ['rev-parse', 'refs/remotes/origin/main']);

    expect(await resolveRefForDisplay(clone, 'main')).toEqual({ ok: true, kind: 'branch', sha: originTip });
  });

  it('fetches a tag that exists only on origin only when fetchTag is set', async () => {
    const { origin, clone } = cloneOfOrigin('display-origin-tag');
    const tagged = commit(origin, 'release commit');
    run(origin, ['tag', 'v7.0.0', tagged]);

    const passive = await resolveRefForDisplay(clone, 'v7.0.0');
    expect(passive).toMatchObject({ ok: false, reason: 'git' });
    expect(run(clone, ['tag', '--list', 'v7.0.0'])).toBe('');

    const fetched = await resolveRefForDisplay(clone, 'v7.0.0', { fetchTag: true });
    expect(fetched).toEqual({ ok: true, kind: 'tag', sha: tagged });
    expect(run(clone, ['tag', '--list', 'v7.0.0'])).toBe('v7.0.0');
  });
});

describe('fetchTagFromOrigin', () => {
  it('refuses a glob without running git, so none of origin\'s tags arrive', async () => {
    const { origin, clone } = cloneOfOrigin('fetch-glob');
    const tagged = commit(origin, 'release commit');
    run(origin, ['tag', 'v1.0.0', tagged]);
    run(origin, ['tag', 'v2.0.0', tagged]);

    expect(await fetchTagFromOrigin(clone, '*')).toBe(false);
    expect(await fetchTagFromOrigin(clone, 'v*')).toBe(false);
    expect(run(clone, ['tag', '--list'])).toBe('');
  });
});
