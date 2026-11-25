/**
 * A provider CLI read ends in a catch that sorts what the CLI said: missing or
 * signed out, a transient failure, and everything else, which reads as "no PR
 * here" and returns empty. That catch also holds what the CLI never said: output
 * that will not parse, and a throw of the client's own. Read as "no PR", those
 * unlink a PR a task really has, and the scan passes the catch because its other
 * branch throws (`src/main/boards/shared/unclassified-defect.ts`).
 *
 * These run the real `gh` and `az` clients over the which/execFile shim
 * `gh-client-import.test.ts` uses, and check that the empty branch reports the
 * two classes that are never the CLI's answer and nothing else.
 */
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stdout: '[]',
  /** When set, every CLI call rejects with it. */
  failure: null as Error | null,
}));

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

vi.mock('which', () => ({ default: async () => '/usr/bin/cli' }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const mockExecFile = Object.assign(
    (...mockArgs: unknown[]) => {
      const callback = mockArgs[mockArgs.length - 1];
      if (typeof callback === 'function') callback(null, { stdout: state.stdout, stderr: '' });
    },
    {
      [promisifyCustom]: async () => {
        if (state.failure) throw state.failure;
        return { stdout: state.stdout, stderr: '' };
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

const { GitHubImporter } = await import('../../src/main/boards/adapters/github-common/gh-client');
const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');
const { prReporter } = await import('../../src/main/pr/pr-report');

/** Output cut off mid-object, holding a title a report must never carry. */
const TRUNCATED_OUTPUT = '[{"number": 12, "title": "Fix Acme billing", ';

/** A rejection shaped like execFile's, as the CLI's own ordinary refusal. */
function cliRefusal(stderr: string): Error {
  return Object.assign(new Error(`Command failed: cli pr list --head fix-acme-billing\n${stderr}`), {
    code: 1,
    killed: false,
    signal: null,
    stdout: '',
    stderr,
  });
}

function reportedTags(): Record<string, string> {
  expect(reportHandledError).toHaveBeenCalledTimes(1);
  return reportHandledError.mock.calls[0][1] as Record<string, string>;
}

beforeEach(() => {
  reportHandledError.mockReset();
  prReporter.reset();
  state.stdout = '[]';
  state.failure = null;
});

describe('a provider CLI read that fails for a reason the CLI never gave', () => {
  const projectFolder = os.tmpdir();

  it('reports gh output that will not parse, and still answers that there is no PR', async () => {
    state.stdout = TRUNCATED_OUTPUT;

    await expect(new GitHubImporter().resolvePRByBranch(projectFolder, 'fix-acme-billing')).resolves.toEqual([]);

    expect(reportedTags()).toMatchObject({
      source: 'pr',
      provider: 'github',
      stage: 'pr_by_branch',
      error_name: 'SyntaxError',
    });
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toMatch(/acme/i);
  });

  it.each([
    ['pr_by_number', (importer: InstanceType<typeof GitHubImporter>) => importer.resolvePRByNumber(projectFolder, 12)],
    ['pr_checks', (importer: InstanceType<typeof GitHubImporter>) => importer.viewPullRequestChecks(projectFolder, 12)],
    ['pr_by_commit', (importer: InstanceType<typeof GitHubImporter>) => importer.resolvePRByCommit(projectFolder, 'a'.repeat(40))],
  ])('names the gh read that failed: %s', async (stage, read) => {
    state.stdout = TRUNCATED_OUTPUT;

    await read(new GitHubImporter());

    expect(reportedTags()).toMatchObject({ provider: 'github', stage });
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toMatch(/acme/i);
  });

  // az sorts an unreadable response itself, as unavailable, which keeps the
  // link. So on that client the empty branch only ever sees a throw of the
  // client's own code, and an unreadable response must not be sent twice.
  it('leaves az output that will not parse to az\'s own classification, which keeps the link', async () => {
    state.stdout = TRUNCATED_OUTPUT;

    await expect(new AzureDevOpsImporter().resolvePRByNumber('organization', 12)).rejects.toMatchObject({
      name: 'AzUnavailableError',
    });

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  // The branch this guards exists for these: the CLI ran and said no.
  it('reports nothing when the CLI itself says there is no pull request', async () => {
    state.failure = cliRefusal('no pull requests found for branch "fix-acme-billing"');

    await expect(new GitHubImporter().resolvePRByBranch(projectFolder, 'fix-acme-billing')).resolves.toEqual([]);
    await expect(new GitHubImporter().resolvePRByNumber(projectFolder, 12)).resolves.toBeNull();

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
