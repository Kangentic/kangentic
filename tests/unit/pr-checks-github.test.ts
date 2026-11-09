/**
 * The GitHub half of the PR Checks list and "Send to agent", end to end over a
 * stubbed `gh`: the client's argv, the connector's `listChecks` / `fetchCheckLog`,
 * and the registry's dispatch to them.
 *
 * Fixtures are real captures from this public repository, not hand-written:
 * - `github-pr-view-status-check-rollup.json`: `gh pr view 784 --json
 *   url,statusCheckRollup`, trimmed. The `cla`, `Tree already tested`, `Lint` and
 *   re-run `UI Test (10/11)` entries are verbatim. The two failed entries are the
 *   real job records of the earlier CI run (`gh run view 42436059750 --json
 *   jobs`) in rollup shape, because the PR's rollup no longer lists them after
 *   the re-run replaced them. The `StatusContext` follows gh's documented field
 *   names (the PR has no status contexts).
 * - `github-actions-failed-job.log.txt`: `gh run view --job 128595029334
 *   --log-failed`, trimmed to the BOM-carrying first line and the 52 lines up to
 *   and after the last `##[error]` line (the job's whole log is 96 KB).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PRCheck } from '../../src/shared/types';

const state = vi.hoisted(() => ({
  whichResult: '/usr/bin/gh' as string | Error,
  /** Answers a `gh` call from its argv; a thrown Error becomes the CLI's failure. */
  respond: (() => '') as (args: readonly string[]) => string,
  calls: [] as Array<{ args: readonly string[]; cwd: string | undefined }>,
}));

const remotes = vi.hoisted(() => ({ urls: ['https://github.com/Kangentic/kangentic.git'] as readonly string[] | null }));
vi.mock('../../src/main/git/git-remotes', () => ({
  readRemoteUrls: async () => remotes.urls,
  invalidateRemoteUrlsCache: () => {},
}));

vi.mock('which', () => ({
  default: async () => {
    if (state.whichResult instanceof Error) throw state.whichResult;
    return state.whichResult;
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const mockExecFile = Object.assign(() => undefined, {
    [promisifyCustom]: async (_file: string, args?: readonly string[], options?: { cwd?: string }) => {
      const argv = Array.isArray(args) ? args : [];
      state.calls.push({ args: argv, cwd: options?.cwd });
      return { stdout: state.respond(argv), stderr: '' };
    },
  });
  return { ...original, execFile: mockExecFile };
});

const { GitHubImporter, GhTransientError } = await import('../../src/main/boards/adapters/github-common/gh-client');
const { gitHubPRConnector } = await import('../../src/main/pr/adapters/github/github-connector');
const { listPRChecks, fetchPRCheckLog } = await import('../../src/main/pr/pr-registry');
const { PRResolverTransientError } = await import('../../src/main/pr/shared/pr-errors');
const { EARLIER_LINES_CUT } = await import('../../src/main/pr/shared/ci-log-tail');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const ROLLUP_JSON = fs.readFileSync(path.join(FIXTURES, 'github-pr-view-status-check-rollup.json'), 'utf-8');
const JOB_LOG = fs.readFileSync(path.join(FIXTURES, 'github-actions-failed-job.log.txt'), 'utf-8');
const FAILED_JOB_ID = '128596975697';
const LOG_JOB_ID = '128595029334';

/** What `gh` does for an id it cannot find: exits 1 with a message no retry would change. */
function ghFails(message: string): never {
  throw Object.assign(new Error(`Command failed: gh\n${message}`), { stderr: message, code: 1 });
}

function ghAnswers(args: readonly string[]): string {
  if (args[0] === 'pr' && args[1] === 'view') return ROLLUP_JSON;
  if (args[0] === 'run' && args[1] === 'view') return JOB_LOG;
  return ghFails('unexpected call');
}

beforeEach(() => {
  state.whichResult = '/usr/bin/gh';
  state.respond = ghAnswers;
  state.calls = [];
  remotes.urls = ['https://github.com/Kangentic/kangentic.git'];
});

describe('GitHubImporter check reads (stubbed gh)', () => {
  it('viewPullRequestChecks asks for the url and the rollup of that PR, from the repo cwd', async () => {
    const result = await new GitHubImporter().viewPullRequestChecks('/repo', 784);
    expect(state.calls).toEqual([{ args: ['pr', 'view', '784', '--json', 'url,statusCheckRollup'], cwd: '/repo' }]);
    expect(result?.url).toBe('https://github.com/Kangentic/kangentic/pull/784');
    expect(result?.statusCheckRollup).toHaveLength(8);
  });

  it('viewPullRequestChecks is null when the PR no longer resolves', async () => {
    state.respond = () => ghFails('no pull requests found for branch');
    await expect(new GitHubImporter().viewPullRequestChecks('/repo', 784)).resolves.toBeNull();
  });

  it('viewJobFailedLog runs gh run view --job <id> --log-failed and returns the raw log', async () => {
    const raw = await new GitHubImporter().viewJobFailedLog('/repo', LOG_JOB_ID);
    expect(state.calls).toEqual([{ args: ['run', 'view', '--job', LOG_JOB_ID, '--log-failed'], cwd: '/repo' }]);
    expect(raw).toBe(JOB_LOG);
  });

  it('viewJobFailedLog is null on a generic failure such as an expired log, and throws on a transient one', async () => {
    state.respond = () => ghFails('log not found');
    await expect(new GitHubImporter().viewJobFailedLog('/repo', LOG_JOB_ID)).resolves.toBeNull();
    state.respond = () => ghFails('HTTP 502: Bad Gateway');
    await expect(new GitHubImporter().viewJobFailedLog('/repo', LOG_JOB_ID)).rejects.toBeInstanceOf(GhTransientError);
  });
});

describe('gitHubPRConnector.listChecks over the real rollup shape', () => {
  it('lists one row per check with the checks page of the PR, a re-run replacing the run it superseded', async () => {
    const listed = await gitHubPRConnector.listChecks!('/repo', 784);
    expect(listed?.checksPageUrl).toBe('https://github.com/Kangentic/kangentic/pull/784/checks');
    const checks = listed!.checks;
    // Eight rollup entries: the failed UI Test (10/11) and its later green re-run
    // are one row, and the two `cla` runs (a re-run) are one row.
    expect(checks).toHaveLength(6);
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(byName['UI Test (10/11)']).toMatchObject({ status: 'passed', id: '128603151940', group: 'CI', hasLog: true });
    expect(byName.cla).toMatchObject({ status: 'passed', id: '128606081952', group: 'CLA Assistant' });
    expect(byName['Tree already tested'].status).toBe('skipped');
    expect(byName['Lint, Typecheck, Build'].status).toBe('passed');
    expect(byName['UI tests (Playwright)']).toEqual({
      id: FAILED_JOB_ID,
      name: 'UI tests (Playwright)',
      group: 'CI',
      url: `https://github.com/Kangentic/kangentic/actions/runs/42436059750/job/${FAILED_JOB_ID}`,
      status: 'failed',
      hasLog: true,
    });
    expect(byName['codecov/patch']).toMatchObject({ status: 'failed', hasLog: false, group: null, url: 'https://app.codecov.io/gh/example-org/example-repo/pull/784' });
  });

  it('is null when the PR is gone', async () => {
    state.respond = () => ghFails('no pull requests found');
    await expect(gitHubPRConnector.listChecks!('/repo', 784)).resolves.toBeNull();
  });

  it('turns a rollup-less PR into an empty list, never a crash', async () => {
    state.respond = () => JSON.stringify({ url: 'https://github.com/Kangentic/kangentic/pull/9' });
    await expect(gitHubPRConnector.listChecks!('/repo', 9)).resolves.toEqual({
      checks: [],
      checksPageUrl: 'https://github.com/Kangentic/kangentic/pull/9/checks',
    });
  });

  it('surfaces a transient gh failure as the generic transient error', async () => {
    state.respond = () => ghFails('HTTP 503: Service Unavailable');
    await expect(gitHubPRConnector.listChecks!('/repo', 784)).rejects.toBeInstanceOf(PRResolverTransientError);
  });
});

describe('gitHubPRConnector.fetchCheckLog over a real failed job log', () => {
  const actionsCheck: PRCheck = {
    id: LOG_JOB_ID,
    name: 'UI Test (10/11)',
    group: 'CI',
    url: `https://github.com/Kangentic/kangentic/actions/runs/42436059750/job/${LOG_JOB_ID}`,
    status: 'failed',
    hasLog: true,
  };

  it('reads the job named in the check url and returns the output ending at the last error line, columns stripped', async () => {
    const tail = await gitHubPRConnector.fetchCheckLog!('/repo', 784, actionsCheck, 6_000);
    expect(state.calls.map((call) => call.args)).toEqual([['run', 'view', '--job', LOG_JOB_ID, '--log-failed']]);
    expect(tail).not.toBeNull();
    expect(tail!.length).toBeLessThanOrEqual(6_000);
    expect(tail!.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
    expect(tail).toContain('tests/ui/terminal-find-bar.spec.ts:369');
    expect(tail).toContain("toHaveText('1 of 3')");
    // Runner cleanup after the last error line is dropped.
    expect(tail).not.toContain('Post job cleanup');
    expect(tail).not.toContain('git config --global');
    // The job and step columns, the byte-order mark and the timestamps are gone.
    expect(tail).not.toContain('UNKNOWN STEP');
    expect(tail).not.toContain('﻿');
    expect(tail).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('keeps the end of the log within a small cap and says the start was cut', async () => {
    const tail = await gitHubPRConnector.fetchCheckLog!('/repo', 784, actionsCheck, 600);
    expect(tail!.length).toBeLessThanOrEqual(600);
    expect(tail!.startsWith(`${EARLIER_LINES_CUT}\n`)).toBe(true);
    expect(tail!.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
  });

  it('is null for a check that is not an Actions job, without running gh', async () => {
    const statusCheck: PRCheck = { ...actionsCheck, id: 'status/codecov/patch', url: 'https://app.codecov.io/gh/x/y/pull/784', hasLog: false };
    await expect(gitHubPRConnector.fetchCheckLog!('/repo', 784, statusCheck, 6_000)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('is null when gh cannot read the log', async () => {
    state.respond = () => ghFails('log not found');
    await expect(gitHubPRConnector.fetchCheckLog!('/repo', 784, actionsCheck, 6_000)).resolves.toBeNull();
  });
});

describe('pr-registry check dispatch', () => {
  const logCheck: PRCheck = {
    id: LOG_JOB_ID,
    name: 'UI Test (10/11)',
    group: 'CI',
    url: `https://github.com/Kangentic/kangentic/actions/runs/42436059750/job/${LOG_JOB_ID}`,
    status: 'failed',
    hasLog: true,
  };

  it('fetchPRCheckLog returns null without asking the connector when the check has no log', async () => {
    await expect(fetchPRCheckLog('/repo', 784, { ...logCheck, hasLog: false }, 6_000)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('fetchPRCheckLog reaches the owning connector for a check that has one', async () => {
    const tail = await fetchPRCheckLog('/repo', 784, logCheck, 6_000);
    expect(tail?.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
    expect(state.calls).toHaveLength(1);
  });

  it('listPRChecks lists from the owner of the primary remote', async () => {
    const listed = await listPRChecks('/repo', 784);
    expect(listed?.checks).toHaveLength(6);
  });

  it('reads checks from the primary remote only: a GitHub secondary behind a foreign origin is not consulted', async () => {
    remotes.urls = ['https://gitea.corp.example/owner/repo.git', 'https://github.com/Kangentic/kangentic.git'];
    await expect(listPRChecks('/repo', 784)).resolves.toBeNull();
    await expect(fetchPRCheckLog('/repo', 784, logCheck, 6_000)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('answers null when the remotes cannot be read', async () => {
    remotes.urls = null;
    await expect(listPRChecks('/repo', 784)).resolves.toBeNull();
  });
});
