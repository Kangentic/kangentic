import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the Azure DevOps PR resolver.
 *
 * Group A drives `AzureDevOpsImporter`'s three PR resolvers against a mocked
 * `az` binary, covering invocation shape, the clean-miss shapes, the argument
 * guards, and the unavailable / transient / not-found classification.
 *
 * Group B drives the connector's mapping and disambiguation by stubbing the
 * importer directly, so it is independent of exec details.
 *
 * Group C is the regression guard for registering this connector at all: on a
 * non-Azure remote every resolver must return null WITHOUT running `az` and
 * WITHOUT throwing.
 */

const state = vi.hoisted(() => ({
  whichResult: '/usr/bin/az' as string | Error,
  azStdout: '[]',
  azError: null as Error | null,
  /** Normalized argv tail - see the shim below. */
  azArgs: [] as readonly string[],
  azCallCount: 0,
}));

const remotes = vi.hoisted(() => ({
  urls: ['git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE'] as readonly string[] | null,
}));

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
  const mockExecFile = Object.assign(
    (...mockArgs: unknown[]) => {
      const callback = mockArgs[mockArgs.length - 1];
      if (typeof callback === 'function') callback(null, { stdout: state.azStdout, stderr: '' });
    },
    {
      [promisifyCustom]: (_file: string, args?: readonly string[] | unknown) => {
        const raw = Array.isArray(args) ? (args as readonly string[]) : [];
        // `execAz` branches on process.platform at MODULE LOAD:
        //   win32 -> ('cmd.exe', ['/c', 'az', ...tail]);  else -> ('az', [...tail]).
        // Normalize by argv SHAPE, never by platform, and assert only on the
        // tail - otherwise this file is green on Windows and red on ubuntu CI
        // (.claude/rules/cross-platform-parity.md).
        state.azArgs = raw[0] === '/c' && raw[1] === 'az' ? raw.slice(2) : raw;
        state.azCallCount += 1;
        if (state.azError) return Promise.reject(state.azError);
        return Promise.resolve({ stdout: state.azStdout, stderr: '' });
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

const { AzureDevOpsImporter, AzUnavailableError, AzTransientError } = await import(
  '../../src/main/boards/adapters/azure-devops/client'
);
const { azureDevOpsPRConnector } = await import(
  '../../src/main/pr/adapters/azure-devops/azure-devops-connector'
);
const { PRResolverUnavailableError, PRResolverTransientError } = await import(
  '../../src/main/pr/shared/pr-errors'
);

const ORG = 'SOA-DCCED';
const PROJECT = 'AOGCC AKWISE';
const REPO = 'AKWISE';
const AZURE_CWD = '/repo';

/** A projected PR row as the `--query` in the client produces it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1343,
    status: 'completed',
    draft: false,
    src: 'refs/heads/bugfix/7927-dev-database-managed-identity',
    tgt: 'refs/heads/develop',
    created: '2026-09-04T16:54:23Z',
    closed: '2026-09-04T17:09:11Z',
    fork: null,
    ...overrides,
  };
}

function execError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

beforeEach(() => {
  state.whichResult = '/usr/bin/az';
  state.azStdout = '[]';
  state.azError = null;
  state.azArgs = [];
  state.azCallCount = 0;
  remotes.urls = ['git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE'];
  vi.restoreAllMocks();
});

describe('AzureDevOpsImporter PR resolvers (mocked az)', () => {
  const importer = () => new AzureDevOpsImporter();

  it('resolvePRByBranch passes explicit org/project/repo and --detect false', async () => {
    state.azStdout = JSON.stringify([row()]);
    await importer().resolvePRByBranch(ORG, PROJECT, REPO, 'bugfix/7927-dev-database-managed-identity');

    expect(state.azArgs.slice(0, 3)).toEqual(['repos', 'pr', 'list']);
    expect(state.azArgs).toContain('--detect');
    expect(state.azArgs).toContain('false');
    // Explicit targeting is what makes this work from any cwd, including after
    // the task's worktree has been reclaimed.
    expect(state.azArgs[state.azArgs.indexOf('--organization') + 1]).toBe('https://dev.azure.com/SOA-DCCED');
    expect(state.azArgs[state.azArgs.indexOf('--project') + 1]).toBe(PROJECT);
    expect(state.azArgs[state.azArgs.indexOf('--repository') + 1]).toBe(REPO);
    expect(state.azArgs[state.azArgs.indexOf('--source-branch') + 1]).toBe(
      'bugfix/7927-dev-database-managed-identity',
    );
    expect(state.azArgs).toContain('--status');
    expect(state.azArgs).toContain('all');
  });

  it('resolvePRByBranch normalizes the projection into AzurePrItems', async () => {
    state.azStdout = JSON.stringify([row()]);
    const items = await importer().resolvePRByBranch(ORG, PROJECT, REPO, 'anything');
    expect(items).toEqual([
      {
        number: 1343,
        state: 'completed',
        isDraft: false,
        headRefName: 'bugfix/7927-dev-database-managed-identity',
        baseRefName: 'develop',
        updatedAt: '2026-09-04T17:09:11Z',
        isCrossRepository: false,
      },
    ]);
  });

  it('resolvePRByBranch treats an empty array as a clean miss', async () => {
    state.azStdout = '[]';
    await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'nope')).resolves.toEqual([]);
  });

  // `az` would parse a leading dash as a flag and rewrite the command.
  it('resolvePRByBranch refuses an option-shaped branch without running az', async () => {
    await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, '--output=/tmp/x')).resolves.toEqual([]);
    expect(state.azCallCount).toBe(0);
  });

  it('resolvePRByNumber targets the org and the id', async () => {
    state.azStdout = JSON.stringify(row());
    const item = await importer().resolvePRByNumber(ORG, 1343);
    expect(state.azArgs.slice(0, 3)).toEqual(['repos', 'pr', 'show']);
    expect(state.azArgs[state.azArgs.indexOf('--id') + 1]).toBe('1343');
    expect(item?.number).toBe(1343);
  });

  // The real string az prints for a missing id.
  it('resolvePRByNumber returns null on TF401180 rather than throwing', async () => {
    state.azError = execError('ERROR: TF401180: The requested pull request was not found.');
    await expect(importer().resolvePRByNumber(ORG, 99999999)).resolves.toBeNull();
  });

  it('resolvePRByCommit posts a commit query to pullrequestquery', async () => {
    state.azStdout = JSON.stringify([row()]);
    await importer().resolvePRByCommit(ORG, PROJECT, REPO, 'f7d613cc5a74b784bb258da4dae0d1032c7d484f');

    expect(state.azArgs.slice(0, 3)).toEqual(['rest', '--method', 'post']);
    const url = state.azArgs[state.azArgs.indexOf('--url') + 1];
    // The project segment is percent-encoded and the repo resolves by NAME.
    expect(url).toBe(
      'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_apis/git/repositories/AKWISE/pullrequestquery?api-version=7.0',
    );
    const body = JSON.parse(state.azArgs[state.azArgs.indexOf('--body') + 1]);
    expect(body).toEqual({
      queries: [{ type: 'commit', items: ['f7d613cc5a74b784bb258da4dae0d1032c7d484f'] }],
    });
  });

  it('resolvePRByCommit treats the projected empty result as a clean miss', async () => {
    state.azStdout = '[]';
    await expect(
      importer().resolvePRByCommit(ORG, PROJECT, REPO, '0000000000000000000000000000000000000000'),
    ).resolves.toEqual([]);
  });

  // Also the injection guard for the JSON --body.
  it('resolvePRByCommit refuses a non-hex sha without running az', async () => {
    await expect(importer().resolvePRByCommit(ORG, PROJECT, REPO, 'not-a-sha"}]}')).resolves.toEqual([]);
    expect(state.azCallCount).toBe(0);
  });

  describe('classification', () => {
    it('a missing az binary is unavailable on every tier', async () => {
      state.whichResult = new Error('not found');
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toBeInstanceOf(AzUnavailableError);
      await expect(importer().resolvePRByNumber(ORG, 1)).rejects.toBeInstanceOf(AzUnavailableError);
      await expect(importer().resolvePRByCommit(ORG, PROJECT, REPO, 'abcdef1')).rejects.toBeInstanceOf(
        AzUnavailableError,
      );
    });

    it('an az login prompt is unavailable', async () => {
      state.azError = execError("ERROR: Please run 'az login' to setup account.");
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toBeInstanceOf(AzUnavailableError);
    });

    it('a missing azure-devops extension is unavailable', async () => {
      state.azError = execError("ERROR: 'repos' is misspelled or not recognized by the system.");
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toBeInstanceOf(AzUnavailableError);
    });

    /**
     * RED-GREEN. TF401019's real text embeds "you do not have permissions", so
     * loosening the auth patterns to a bare `permission` would classify a
     * missing repo as an auth failure - which permanently suppresses the
     * confident-not-found clear for that project.
     */
    it('TF401019 is not-found, not an auth failure', async () => {
      state.azError = execError(
        'ERROR: Not Found({"$id":"1","message":"TF401019: The Git repository with name or identifier ' +
          'NoSuchRepo does not exist or you do not have permissions for the operation you are attempting."})',
      );
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).resolves.toEqual([]);
      await expect(importer().resolvePRByNumber(ORG, 1)).resolves.toBeNull();
    });

    it.each([
      ['a 503', execError('ERROR: HTTP 503 Service Unavailable')],
      ['a killed process', execError('timeout', { killed: true })],
      ['ETIMEDOUT', execError('boom', { code: 'ETIMEDOUT' })],
      ['a reset connection', execError('ECONNRESET while reading')],
    ])('%s is transient', async (_label, error) => {
      state.azError = error;
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toBeInstanceOf(AzTransientError);
    });
  });

  /**
   * THE FIX under test: `resolvePRByBranch` / `resolvePRByNumber` /
   * `resolvePRByCommit` each wrap BOTH the `execAz` call and the `JSON.parse`
   * of its stdout in one try. Before the fix, a SyntaxError from `JSON.parse`
   * (empty stdout, or a non-JSON banner) fell through every pattern in
   * `classifyAzError` to its 'not-found' default, so the resolver returned a
   * CLEAN MISS ([] / null). A clean miss from an owning, capable connector is
   * exactly what makes pr-linking.ts CLEAR the task's pr_url / pr_number /
   * pr_state - so an unreadable `az` response silently wiped a task's PR
   * link. `classifyAzError` and `azErrorToThrow` now check
   * `error instanceof SyntaxError || error instanceof TypeError` ahead of
   * every other pattern and degrade instead.
   */
  describe('an unreadable az response degrades instead of reporting a clean miss', () => {
    it('resolvePRByBranch rejects with AzUnavailableError on empty stdout (SyntaxError from JSON.parse)', async () => {
      state.azStdout = '';
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toBeInstanceOf(AzUnavailableError);
    });

    it('resolvePRByNumber rejects with AzUnavailableError on empty stdout, rather than resolving null', async () => {
      state.azStdout = '';
      await expect(importer().resolvePRByNumber(ORG, 1343)).rejects.toBeInstanceOf(AzUnavailableError);
    });

    it('resolvePRByCommit rejects with AzUnavailableError on empty stdout, rather than resolving []', async () => {
      state.azStdout = '';
      await expect(
        importer().resolvePRByCommit(ORG, PROJECT, REPO, 'f7d613cc5a74b784bb258da4dae0d1032c7d484f'),
      ).rejects.toBeInstanceOf(AzUnavailableError);
    });

    it('the degrade message names the real cause, not the az-login remedy', async () => {
      state.azStdout = '';
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toMatchObject({
        message: expect.stringContaining('Could not read the Azure DevOps CLI response'),
      });
    });

    // A non-string projected `src` field (e.g. a numeric work-item-like value)
    // makes `stripRefsHeads` call `.startsWith` on a non-string and throw a
    // TypeError. That must degrade too, not silently drop the row.
    it('a non-string src field (TypeError from stripRefsHeads) degrades rather than dropping the row', async () => {
      state.azStdout = JSON.stringify([row({ src: 12345 })]);
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).rejects.toBeInstanceOf(AzUnavailableError);
    });

    // REGRESSION GUARD: a genuine "not found" from az itself must still
    // resolve to a clean miss. The fix must not have widened the degrade
    // path to swallow real not-found responses.
    it('a genuine az not-found (TF401180 / TF401019) still resolves to a clean miss, not a throw', async () => {
      state.azError = execError('ERROR: TF401180: The requested pull request was not found.');
      await expect(importer().resolvePRByNumber(ORG, 99999999)).resolves.toBeNull();

      state.azError = execError(
        'ERROR: Not Found({"$id":"1","message":"TF401019: The Git repository with name or identifier ' +
          'NoSuchRepo does not exist or you do not have permissions for the operation you are attempting."})',
      );
      await expect(importer().resolvePRByBranch(ORG, PROJECT, REPO, 'b')).resolves.toEqual([]);
    });
  });
});

describe('azureDevOpsPRConnector mapping and disambiguation', () => {
  function stubBranch(items: unknown[]) {
    return vi
      .spyOn(AzureDevOpsImporter.prototype, 'resolvePRByBranch')
      .mockResolvedValue(items as never);
  }
  function stubCommit(items: unknown[]) {
    return vi.spyOn(AzureDevOpsImporter.prototype, 'resolvePRByCommit').mockResolvedValue(items as never);
  }

  const item = (overrides: Record<string, unknown> = {}) => ({
    number: 1343,
    state: 'completed',
    isDraft: false,
    headRefName: 'bugfix/7927-dev-database-managed-identity',
    baseRefName: 'develop',
    updatedAt: '2026-09-04T17:09:11Z',
    ...overrides,
  });

  it.each([
    ['active + not draft', { state: 'active', isDraft: false }, 'open'],
    ['active + draft', { state: 'active', isDraft: true }, 'draft'],
    ['completed', { state: 'completed' }, 'merged'],
    ['abandoned', { state: 'abandoned' }, 'closed'],
  ])('maps %s', async (_label, overrides, expected) => {
    stubBranch([item(overrides)]);
    const resolvedPr = await azureDevOpsPRConnector.resolveForBranch!(
      AZURE_CWD,
      'bugfix/7927-dev-database-managed-identity',
    );
    expect(resolvedPr?.state).toBe(expected);
  });

  it('constructs the browser URL, since Azure returns null for it on every tier', async () => {
    stubBranch([item()]);
    const resolvedPr = await azureDevOpsPRConnector.resolveForBranch!(
      AZURE_CWD,
      'bugfix/7927-dev-database-managed-identity',
    );
    expect(resolvedPr?.url).toBe(
      'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343',
    );
  });

  it('exposes bare ref names, not refs/heads/...', async () => {
    stubBranch([item()]);
    const resolvedPr = await azureDevOpsPRConnector.resolveForBranch!(
      AZURE_CWD,
      'bugfix/7927-dev-database-managed-identity',
    );
    expect(resolvedPr?.baseRefName).toBe('develop');
  });

  /**
   * RED-GREEN, and the reason the case this was written against links at all.
   * The hint is the task's
   * worktree slug; the PR's source branch is different; the pool has size 1, so
   * the lone non-matching candidate must WIN. A port that requires a hint match
   * returns null and leaves the task blank forever.
   */
  it('keeps a LONE candidate whose head does not match the branch hint', async () => {
    stubCommit([item()]);
    const resolvedPr = await azureDevOpsPRConnector.resolveByCommit!(
      AZURE_CWD,
      'f7d613cc5a74b784bb258da4dae0d1032c7d484f',
      'rework-dev-database-011d9fab',
    );
    expect(resolvedPr?.number).toBe(1343);
  });

  it('refuses to guess between SEVERAL candidates that all miss the hint', async () => {
    stubCommit([item({ number: 1343 }), item({ number: 1344, headRefName: 'other' })]);
    const resolvedPr = await azureDevOpsPRConnector.resolveByCommit!(
      AZURE_CWD,
      'f7d613cc5a74b784bb258da4dae0d1032c7d484f',
      'rework-dev-database-011d9fab',
    );
    expect(resolvedPr).toBeNull();
  });

  it('prefers an active PR over a completed one', async () => {
    stubCommit([item({ number: 1, state: 'completed' }), item({ number: 2, state: 'active' })]);
    const resolvedPr = await azureDevOpsPRConnector.resolveByCommit!(AZURE_CWD, 'abcdef1234567');
    expect(resolvedPr?.number).toBe(2);
  });

  it('drops fork PRs from an inferred branch match', async () => {
    stubBranch([item({ isCrossRepository: true })]);
    const resolvedPr = await azureDevOpsPRConnector.resolveForBranch!(
      AZURE_CWD,
      'bugfix/7927-dev-database-managed-identity',
    );
    expect(resolvedPr).toBeNull();
  });

  // The commit tier's payload has no forkSource at all, so undefined must pass.
  it('keeps commit-tier candidates whose fork status is unknown', async () => {
    stubCommit([item()]);
    const resolvedPr = await azureDevOpsPRConnector.resolveByCommit!(AZURE_CWD, 'abcdef1234567');
    expect(resolvedPr?.number).toBe(1343);
  });

  it('trusts an explicit number even for a fork PR', async () => {
    vi.spyOn(AzureDevOpsImporter.prototype, 'resolvePRByNumber').mockResolvedValue(
      item({ isCrossRepository: true }) as never,
    );
    const resolvedPr = await azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1343);
    expect(resolvedPr?.number).toBe(1343);
  });

  it('translates Azure errors into the platform-agnostic ones', async () => {
    vi.spyOn(AzureDevOpsImporter.prototype, 'resolvePRByBranch').mockRejectedValue(
      new AzUnavailableError('az missing'),
    );
    await expect(azureDevOpsPRConnector.resolveForBranch!(AZURE_CWD, 'b')).rejects.toBeInstanceOf(
      PRResolverUnavailableError,
    );

    vi.spyOn(AzureDevOpsImporter.prototype, 'resolvePRByBranch').mockRejectedValue(
      new AzTransientError('HTTP 503'),
    );
    await expect(azureDevOpsPRConnector.resolveForBranch!(AZURE_CWD, 'b')).rejects.toBeInstanceOf(
      PRResolverTransientError,
    );
  });
});

/**
 * Registering this connector must not degrade PR linking on GitHub repos. If a
 * resolver threw here instead of returning null, `degradeStatus` would be set
 * for every GitHub task on any machine without `az`, permanently disabling the
 * confident-not-found clear and reporting a resolver failure for tasks that
 * simply have no PR.
 */
describe('non-Azure remotes are refused without running az', () => {
  beforeEach(() => {
    remotes.urls = ['https://github.com/owner/repo.git'];
  });

  it.each([
    ['resolveForBranch', () => azureDevOpsPRConnector.resolveForBranch!('/repo', 'main')],
    ['resolveByNumber', () => azureDevOpsPRConnector.resolveByNumber!('/repo', 42)],
    ['resolveByCommit', () => azureDevOpsPRConnector.resolveByCommit!('/repo', 'abcdef1234567')],
  ])('%s resolves null and never spawns az', async (_label, call) => {
    // `resolves`, not a falsy check: a throw is the failure mode this guards.
    await expect(call()).resolves.toBeNull();
    expect(state.azCallCount).toBe(0);
  });

  it('also refuses when the remotes could not be read at all', async () => {
    remotes.urls = null;
    await expect(azureDevOpsPRConnector.resolveForBranch!('/repo', 'main')).resolves.toBeNull();
    expect(state.azCallCount).toBe(0);
  });

  it('matchesRemote claims Azure remotes only', () => {
    expect(azureDevOpsPRConnector.matchesRemote(['git@ssh.dev.azure.com:v3/O/P/R'])).toBe(true);
    expect(azureDevOpsPRConnector.matchesRemote(['https://dev.azure.com/O/P/_git/R'])).toBe(true);
    expect(azureDevOpsPRConnector.matchesRemote(['https://github.com/owner/repo.git'])).toBe(false);
    expect(azureDevOpsPRConnector.matchesRemote([])).toBe(false);
  });
});
