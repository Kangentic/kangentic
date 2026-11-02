#!/usr/bin/env node
/**
 * Decides whether a push to main needs its tests run again.
 *
 * main requires a PR to be up to date before it merges, and PRs land by rebase, so a merged PR puts
 * on main the exact tree its own head was tested on. Testing that tree a second time can only find
 * a flake. This compares the pushed tree with the head of the PR it came from and answers `tested`
 * only when the trees match and every check on that head passed. A push with no merged PR behind
 * it (a direct /merge-back) answers false and runs everything.
 *
 * Any doubt runs the tests. An API error, a check still running, a head missing one of the checks
 * this relies on: each answers false, and the reason is printed on every run.
 *
 * Usage (from .github/actions/tested-tree): node scripts/tested-tree.mjs <sha>
 * Reads GITHUB_REPOSITORY and GITHUB_TOKEN, and writes `tested=` to GITHUB_OUTPUT.
 */
import { appendFileSync } from 'node:fs';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

/** The checks a tree must have passed. Each is a ci.yml job, so a rename fails tested-tree.test.ts. */
export const REQUIRED_PASSES = [
  'Lint, Typecheck, Build',
  'Unit tests (Vitest)',
  'UI tests (Playwright)',
  'E2E tests (Electron)',
  'Web demo (build + smoke)',
];

const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * @typedef {object} Api
 * @property {(sha: string) => Promise<Array<{ number: number, merged_at: string | null, base: { ref: string }, head: { sha: string } }>>} pullsForCommit
 * @property {(sha: string) => Promise<string>} treeOf
 * @property {(sha: string) => Promise<Array<{ name: string, status: string, conclusion: string | null }>>} checksOn
 */

/**
 * @param {string} sha the pushed commit
 * @param {Api} api
 * @returns {Promise<{ tested: boolean, reason: string }>}
 */
export async function decideTestedTree(sha, api) {
  let pulls;
  try {
    pulls = await api.pullsForCommit(sha);
  } catch (error) {
    return { tested: false, reason: `could not read the PRs for ${sha}: ${describe(error)}` };
  }
  const merged = pulls.filter((pull) => pull.merged_at !== null && pull.base.ref === 'main');
  if (merged.length === 0) {
    return { tested: false, reason: `${sha} has no merged PR behind it` };
  }

  const reasons = [];
  for (const pull of merged) {
    const verdict = await judgePull(sha, pull, api);
    if (verdict.tested) return verdict;
    reasons.push(verdict.reason);
  }
  return { tested: false, reason: reasons.join('; ') };
}

async function judgePull(sha, pull, api) {
  const label = `PR #${pull.number}`;
  try {
    const [pushedTree, headTree] = await Promise.all([api.treeOf(sha), api.treeOf(pull.head.sha)]);
    if (pushedTree !== headTree) {
      return { tested: false, reason: `${label}: the pushed tree differs from its head's` };
    }

    const checks = await api.checksOn(pull.head.sha);
    const unfinished = checks.filter((check) => check.status !== 'completed').map((check) => check.name);
    if (unfinished.length > 0) {
      return { tested: false, reason: `${label}: still running on its head: ${unfinished.join(', ')}` };
    }
    const failing = checks.filter((check) => !PASSING_CONCLUSIONS.has(check.conclusion ?? '')).map((check) => check.name);
    if (failing.length > 0) {
      return { tested: false, reason: `${label}: did not pass on its head: ${failing.join(', ')}` };
    }
    const absent = REQUIRED_PASSES.filter((name) =>
      !checks.some((check) => check.name === name && check.conclusion === 'success'));
    if (absent.length > 0) {
      return { tested: false, reason: `${label}: no passing run on its head of: ${absent.join(', ')}` };
    }
    return { tested: true, reason: `${label} tested this tree on ${pull.head.sha}` };
  } catch (error) {
    return { tested: false, reason: `${label}: could not read its head: ${describe(error)}` };
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function githubApi(repository, token) {
  const request = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
  };
  return {
    pullsForCommit: (sha) => request(`commits/${sha}/pulls`),
    treeOf: async (sha) => (await request(`git/commits/${sha}`)).tree.sha,
    checksOn: async (sha) => {
      const checks = [];
      for (let page = 1; ; page += 1) {
        const body = await request(`commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
        checks.push(...body.check_runs);
        if (checks.length >= body.total_count || body.check_runs.length === 0) return checks;
      }
    },
  };
}

async function main() {
  const sha = process.argv[2];
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, GITHUB_OUTPUT: outputPath } = process.env;
  const decision = sha && repository && token
    ? await decideTestedTree(sha, githubApi(repository, token))
    : { tested: false, reason: 'the sha, GITHUB_REPOSITORY or GITHUB_TOKEN is missing' };
  console.log(`[tested-tree] ${decision.tested ? 'skipping the tests' : 'running the tests'}: ${decision.reason}`);
  if (outputPath) appendFileSync(outputPath, `tested=${decision.tested}\n`);
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
