import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_PASSES, decideTestedTree, githubApi } from '../../scripts/tested-tree.mjs';
import { readWorkflow } from './helpers/read-workflow';

// The gate that lets a push to main skip its tests. A wrong yes lands a tree nothing tested, so
// every red case here is a way the answer must stay no. Tier: Unit.

const PUSHED_SHA = 'pushed0';
const HEAD_SHA = 'head0';
const ACTIONS_APP = { slug: 'github-actions' };

interface FakeCheck {
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug: string };
}

const greenChecks = (): FakeCheck[] => [
  ...REQUIRED_PASSES.map((name: string) => ({ name, status: 'completed', conclusion: 'success', app: ACTIONS_APP })),
  { name: 'cla', status: 'completed', conclusion: 'success', app: ACTIONS_APP },
];

const mergedPull = { number: 7, merged_at: '2026-11-02T00:00:00Z', base: { ref: 'main' }, head: { sha: HEAD_SHA } };

function fakeApi(overrides: Partial<{
  pulls: unknown[];
  pushedTree: string;
  headTree: string;
  checks: FakeCheck[];
}> = {}) {
  const { pulls = [mergedPull], pushedTree = 'tree-a', headTree = 'tree-a', checks = greenChecks() } = overrides;
  return {
    pullsForCommit: async () => pulls,
    treeOf: async (sha: string) => (sha === PUSHED_SHA ? pushedTree : headTree),
    checksOn: async () => checks,
  };
}

describe('decideTestedTree', () => {
  it('skips a push whose tree passed every check on its PR head', async () => {
    const decision = await decideTestedTree(PUSHED_SHA, fakeApi());
    expect(decision.tested).toBe(true);
    expect(decision.reason).toContain('PR #7');
  });

  it('accepts a skipped path-filtered job on the head', async () => {
    const checks = [...greenChecks(), { name: 'optional', status: 'completed', conclusion: 'skipped' }];
    expect((await decideTestedTree(PUSHED_SHA, fakeApi({ checks }))).tested).toBe(true);
  });

  it('runs a direct push, which has no PR', async () => {
    const decision = await decideTestedTree(PUSHED_SHA, fakeApi({ pulls: [] }));
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('no merged PR');
  });

  it('runs a commit whose PR never merged, or merged elsewhere', async () => {
    const open = { ...mergedPull, merged_at: null };
    const elsewhere = { ...mergedPull, base: { ref: 'release' } };
    expect((await decideTestedTree(PUSHED_SHA, fakeApi({ pulls: [open] }))).tested).toBe(false);
    expect((await decideTestedTree(PUSHED_SHA, fakeApi({ pulls: [elsewhere] }))).tested).toBe(false);
  });

  it('runs a tree that differs from the PR head, as when main moved under the merge', async () => {
    const decision = await decideTestedTree(PUSHED_SHA, fakeApi({ headTree: 'tree-b' }));
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('differs');
  });

  it('runs when a check on the head failed', async () => {
    const checks = [...greenChecks(), { name: 'Package smoke (windows-latest)', status: 'completed', conclusion: 'failure' }];
    const decision = await decideTestedTree(PUSHED_SHA, fakeApi({ checks }));
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('Package smoke (windows-latest)');
  });

  it('runs when a check on the head was cancelled or timed out', async () => {
    for (const conclusion of ['cancelled', 'timed_out']) {
      const checks = [...greenChecks(), { name: 'other', status: 'completed', conclusion }];
      expect((await decideTestedTree(PUSHED_SHA, fakeApi({ checks }))).tested).toBe(false);
    }
  });

  it('runs when a check on the head has not finished', async () => {
    const checks = [...greenChecks(), { name: 'slow', status: 'in_progress', conclusion: null }];
    const decision = await decideTestedTree(PUSHED_SHA, fakeApi({ checks }));
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('slow');
  });

  it.each(REQUIRED_PASSES)('runs when the head has no passing %s', async (missing) => {
    const absent = greenChecks().filter((check) => check.name !== missing);
    expect((await decideTestedTree(PUSHED_SHA, fakeApi({ checks: absent }))).tested).toBe(false);

    const skipped = greenChecks().map((check) => (check.name === missing ? { ...check, conclusion: 'skipped' } : check));
    expect((await decideTestedTree(PUSHED_SHA, fakeApi({ checks: skipped }))).tested).toBe(false);
  });

  it('counts a required check only when GitHub Actions posted it', async () => {
    const posted = greenChecks().map((check) => (
      check.name === REQUIRED_PASSES[0] ? { ...check, app: { slug: 'another-app' } } : check
    ));
    const decision = await decideTestedTree(PUSHED_SHA, fakeApi({ checks: posted }));
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain(REQUIRED_PASSES[0]);
  });

  it('runs when any API call fails, and says which', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('answered 502');
    };
    const onPulls = await decideTestedTree(PUSHED_SHA, { ...fakeApi(), pullsForCommit: failing });
    const onTree = await decideTestedTree(PUSHED_SHA, { ...fakeApi(), treeOf: failing });
    const onChecks = await decideTestedTree(PUSHED_SHA, { ...fakeApi(), checksOn: failing });
    for (const decision of [onPulls, onTree, onChecks]) {
      expect(decision.tested).toBe(false);
      expect(decision.reason).toContain('answered 502');
    }
  });

  it('takes the PR that tested the tree when a commit has two', async () => {
    const stale = { ...mergedPull, number: 6, head: { sha: 'other' } };
    const api = {
      ...fakeApi({ pulls: [stale, mergedPull] }),
      treeOf: async (sha: string) => (sha === 'other' ? 'tree-b' : 'tree-a'),
    };
    const decision = await decideTestedTree(PUSHED_SHA, api);
    expect(decision.tested).toBe(true);
    expect(decision.reason).toContain('PR #7');
  });
});

// The three endpoints' real answers for a rebase-merged PR, trimmed to what a reader needs. The check
// runs are split over two pages to reach the second request, and all but the first two carry
// placeholder ids and times.
describe('githubApi over recorded GitHub responses', () => {
  interface RecordedCheckRunPage {
    total_count: number;
    check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
  }
  interface Recorded {
    pushedSha: string;
    headSha: string;
    pulls: unknown[];
    commits: Record<string, { tree: { sha: string } }>;
    checkRunPages: RecordedCheckRunPage[];
  }

  const loadRecorded = (): Recorded => JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../fixtures/github-tested-tree-api.json'), 'utf8'),
  ) as Recorded;

  const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  const replay = (recorded: Recorded) => async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith(`/commits/${recorded.pushedSha}/pulls`)) return answer(recorded.pulls);
    const commit = /\/git\/commits\/(\w+)$/.exec(pathname);
    if (commit) return answer(recorded.commits[commit[1]]);
    if (pathname.endsWith(`/commits/${recorded.headSha}/check-runs`)) {
      return answer(recorded.checkRunPages[Number(searchParams.get('page')) - 1]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const decide = (recorded: Recorded, fetchResponse: (url: string) => Promise<unknown> = replay(recorded)) =>
    decideTestedTree(recorded.pushedSha, githubApi('owner/repo', 'token', fetchResponse as typeof fetch));

  it('answers tested for a merged PR, reading every check-run page', async () => {
    const decision = await decide(loadRecorded());
    expect(decision).toMatchObject({ tested: true });
    expect(decision.reason).toContain('PR #717');
  });

  it('sees a run still in progress on the second page', async () => {
    const recorded = loadRecorded();
    Object.assign(recorded.checkRunPages[1].check_runs[0], { status: 'in_progress', conclusion: null });
    const decision = await decide(recorded);
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('still running');
  });

  it('runs when the head tree differs from the pushed one', async () => {
    const recorded = loadRecorded();
    recorded.commits[recorded.headSha].tree.sha = 'another-tree';
    const decision = await decide(recorded);
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('differs');
  });

  it('turns an error status into a no with the status in the reason', async () => {
    const recorded = loadRecorded();
    const failing = async () => ({ ok: false, status: 502, json: async () => ({}) });
    const decision = await decide(recorded, failing);
    expect(decision.tested).toBe(false);
    expect(decision.reason).toContain('answered 502');
  });
});

describe('the workflows wire the gate', () => {
  it('REQUIRED_PASSES names real ci.yml jobs', () => {
    const ciSource = readWorkflow('ci.yml');
    for (const name of REQUIRED_PASSES) {
      expect(ciSource, `ci.yml has no job named "${name}"`).toContain(`name: ${name}`);
    }
  });

  it.each([
    'ci.yml',
    'task-reap-real-processes.yml',
    'shell-quoting-windows.yml',
    'shell-quoting-posix.yml',
    'macos-spawn-helper.yml',
  ])('%s runs the gate only on a push, and keeps its checkout ahead of the action', (workflowName) => {
    const source = readWorkflow(workflowName);
    const gateJob = source.slice(source.indexOf('  tested-tree:'));
    expect(gateJob).toContain("if: github.event_name == 'push'");
    expect(gateJob.indexOf('actions/checkout')).toBeLessThan(gateJob.indexOf('./.github/actions/tested-tree'));
  });

  it.each([
    'ci.yml',
    'task-reap-real-processes.yml',
    'shell-quoting-windows.yml',
    'shell-quoting-posix.yml',
    'macos-spawn-helper.yml',
  ])('every job in %s after the gate answers to it', (workflowName) => {
    const source = readWorkflow(workflowName);
    const jobsBlock = source.slice(source.indexOf('\njobs:\n'));
    const jobBodies = jobsBlock.split(/\n(?= {2}[a-z][\w-]*:\n)/).slice(1);
    expect(jobBodies.length).toBeGreaterThan(1);
    for (const body of jobBodies.filter((candidate) => !candidate.startsWith('  tested-tree:'))) {
      expect(body, `this job can run past the gate:\n${body.slice(0, 80)}`).toContain("needs.tested-tree.outputs.tested != 'true'");
    }
  });
});
