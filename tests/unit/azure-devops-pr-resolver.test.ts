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
  /**
   * Optional per-invocation stdout hook, keyed on the normalized argv tail.
   * Unset by default (every test but the deadlock guard uses the flat
   * `azStdout` string above); when set, it takes priority so a single mocked
   * `az` binary can answer differently for the PR-row call vs the policy
   * call within the SAME test, and can gate one response on another call
   * having already been observed.
   */
  azStdoutFor: undefined as ((args: readonly string[]) => Promise<string> | string) | undefined,
}));

const remotes = vi.hoisted(() => ({
  urls: ['git@ssh.dev.azure.com:v3/my-org/My%20Project/my-repo'] as readonly string[] | null,
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
      [promisifyCustom]: async (_file: string, args?: readonly string[] | unknown) => {
        const raw = Array.isArray(args) ? (args as readonly string[]) : [];
        // `execAz` branches on process.platform at MODULE LOAD:
        //   win32 -> ('cmd.exe', ['/c', 'az', ...tail]);  else -> ('az', [...tail]).
        // Normalize by argv SHAPE, never by platform, and assert only on the
        // tail - otherwise this file is green on Windows and red on ubuntu CI
        // (.claude/rules/cross-platform-parity.md).
        const tail = raw[0] === '/c' && raw[1] === 'az' ? raw.slice(2) : raw;
        state.azArgs = tail;
        state.azCallCount += 1;
        if (state.azError) throw state.azError;
        const stdout = state.azStdoutFor ? await state.azStdoutFor(tail) : state.azStdout;
        return { stdout, stderr: '' };
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

const ORG = 'my-org';
const PROJECT = 'My Project';
const REPO = 'my-repo';
const AZURE_CWD = '/repo';
/** A placeholder project GUID in the shape Azure returns (never a real organization's). */
const PROJECT_GUID = '00000000-0000-4000-8000-000000000001';
/** Azure's fixed policy type ids for the two reviewer policies (see the connector's REVIEWER_POLICY_TYPE_IDS). */
const MIN_REVIEWERS_TYPE = 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd';
const REQUIRED_REVIEWERS_TYPE = 'fd2167ab-b0be-447a-8ec8-39368250530e';
const BUILD_TYPE = '0609b952-1397-4640-95ec-e00a01b2c241';

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
    merge: 'succeeded',
    projectId: PROJECT_GUID,
    ...overrides,
  };
}

/** A projected policy evaluation record as `resolvePolicyEvaluations`'s `--query` produces it. */
function evaluation(overrides: Record<string, unknown> = {}) {
  return {
    status: 'approved',
    typeId: BUILD_TYPE,
    isBlocking: true,
    isEnabled: true,
    isDeleted: false,
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
  state.azStdoutFor = undefined;
  remotes.urls = ['git@ssh.dev.azure.com:v3/my-org/My%20Project/my-repo'];
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
    expect(state.azArgs[state.azArgs.indexOf('--organization') + 1]).toBe('https://dev.azure.com/my-org');
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
        mergeStatus: 'succeeded',
        projectId: PROJECT_GUID,
      },
    ]);
  });

  it('resolvePRByBranch projects the project GUID, and a null source stays a present null', async () => {
    state.azStdout = JSON.stringify([row({ projectId: null })]);
    const items = await importer().resolvePRByBranch(ORG, PROJECT, REPO, 'anything');
    expect(items[0]).toHaveProperty('projectId', null);
    const query = state.azArgs[state.azArgs.indexOf('--query') + 1];
    expect(query).toContain('projectId:repository.project.id');
  });

  it('resolvePRByBranch projects mergeStatus, and a null source stays a present null', async () => {
    // `--query` projects a null source as null rather than dropping the key, so
    // the item carries `mergeStatus: null` here and the connector reads that as
    // "no verdict yet", never as "this tier cannot judge it".
    state.azStdout = JSON.stringify([row({ merge: null })]);
    const items = await importer().resolvePRByBranch(ORG, PROJECT, REPO, 'anything');
    expect(items[0]).toHaveProperty('mergeStatus', null);
    const query = state.azArgs[state.azArgs.indexOf('--query') + 1];
    expect(query).toContain('merge:mergeStatus');
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
    // `pr show` takes no --project, so the GUID has to come off the payload.
    expect(item?.projectId).toBe(PROJECT_GUID);
    expect(state.azArgs[state.azArgs.indexOf('--query') + 1]).toContain('projectId:repository.project.id');
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
      'https://dev.azure.com/my-org/My%20Project/_apis/git/repositories/my-repo/pullrequestquery?api-version=7.0',
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

  it('resolvePRByCommit does not project mergeStatus, so commit-tier items carry no key at all', async () => {
    // The commit tier only ever matches completed PRs, so a verdict there is
    // moot, and leaving the key absent is what lets the connector omit the
    // verdict (preserve) instead of writing `unknown` over a real one.
    const projected = row();
    delete (projected as Record<string, unknown>).merge;
    delete (projected as Record<string, unknown>).fork;
    delete (projected as Record<string, unknown>).projectId;
    state.azStdout = JSON.stringify([projected]);
    const items = await importer().resolvePRByCommit(ORG, PROJECT, REPO, 'f7d613cc5a74b784bb258da4dae0d1032c7d484f');
    expect(items[0]).not.toHaveProperty('mergeStatus');
    expect(items[0]).not.toHaveProperty('projectId');
    const query = state.azArgs[state.azArgs.indexOf('--query') + 1];
    expect(query).not.toContain('mergeStatus');
    expect(query).not.toContain('projectId');
  });

  describe('resolvePolicyEvaluations', () => {
    it('GETs the evaluations for the PR artifact, with both query params on --url-parameters', async () => {
      state.azStdout = JSON.stringify([evaluation()]);
      const evaluations = await importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343);

      expect(state.azArgs.slice(0, 3)).toEqual(['rest', '--method', 'get']);
      // The GUID is the project segment (no name to encode), and the URL
      // carries no query string: `execAz` runs through cmd.exe on Windows,
      // where `&` would split the command.
      const url = state.azArgs[state.azArgs.indexOf('--url') + 1];
      expect(url).toBe(`https://dev.azure.com/my-org/${PROJECT_GUID}/_apis/policy/evaluations`);
      expect(url).not.toContain('?');
      expect(state.azArgs[state.azArgs.indexOf('--resource') + 1]).toBe('499b84ac-1321-427f-aa17-267ca6975798');
      const parametersAt = state.azArgs.indexOf('--url-parameters');
      expect(state.azArgs.slice(parametersAt + 1, parametersAt + 3)).toEqual([
        `artifactId=vstfs:///CodeReview/CodeReviewId/${PROJECT_GUID}/1343`,
        'api-version=7.0-preview.1',
      ]);
      expect(state.azArgs[state.azArgs.indexOf('--query') + 1]).toContain('typeId:configuration.type.id');
      expect(evaluations).toEqual([
        { status: 'approved', typeId: BUILD_TYPE, isBlocking: true, isEnabled: true, isDeleted: false },
      ]);
    });

    it('keeps "no policies" and "no readable answer" distinct: [] stays [], a non-array is null', async () => {
      state.azStdout = '[]';
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toEqual([]);
      // A payload without the `value` wrapper projects to null or to nothing.
      state.azStdout = 'null';
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toBeNull();
      state.azStdout = '';
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toBeNull();
    });

    it('drops a record without a string status and coerces the flags', async () => {
      state.azStdout = JSON.stringify([
        evaluation({ status: null }),
        evaluation({ status: 'running', isBlocking: null, isEnabled: 'yes', isDeleted: undefined, typeId: 7 }),
      ]);
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toEqual([
        { status: 'running', typeId: '', isBlocking: false, isEnabled: false, isDeleted: false },
      ]);
    });

    /**
     * Every failure is contained: this call enriches a PR row that was already
     * read, and a throw would fail the whole resolve (the ladder remembers a
     * degrade and rethrows it once no tier resolves), freezing the task's
     * `pr_state` behind a policy API that keeps failing.
     */
    it.each([
      ['a missing artifact', 'ERROR: Not Found({"typeKey":"ArtifactNotFoundException","message":"Artifact id does not exist or you do not have permission to view it."})'],
      ['a rejected api-version', 'ERROR: Bad Request({"typeKey":"VssInvalidPreviewVersionException"})'],
      ['an HTTP 503', 'ERROR: HTTP 503 Service Unavailable'],
      ['an auth failure', 'ERROR: Please run az login'],
    ])('returns null on %s instead of throwing', async (_label, stderr) => {
      state.azError = execError(stderr);
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toBeNull();
    });

    it('returns null on unparseable stdout instead of throwing', async () => {
      state.azStdout = 'not json';
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toBeNull();
    });

    /**
     * `describeAzFailure`'s no-stderr fallback: a `JSON.parse` failure on
     * unparseable stdout carries no `stderr` at all (this module's own read
     * failure, not something `az` reported), so the warned text has to fall
     * back to the SyntaxError's own message rather than the stderr line the
     * other cases above use.
     *
     * Deliberately a DIFFERENT unparseable fixture than the "returns null on
     * unparseable stdout" test above (not `'not json'`): `warnPolicyEvaluationOnce`
     * dedupes on the message text alone, with no `prNumber` in the key, so
     * reusing that exact fixture would produce the identical SyntaxError
     * message and the second occurrence (whichever test runs second) would be
     * silently swallowed by the dedupe Set - a fragile pass that depends on
     * declaration order. A distinct fixture makes this test's message unique
     * on its own, independent of test order or of anything left in the
     * module-level Set by a sibling test.
     */
    it('the no-stderr fallback names the JSON.parse failure, never "Command failed"', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unparseableStdout = 'not json (fallback probe)';
      state.azStdout = unparseableStdout;
      const prNumber = 4242;

      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, prNumber)).resolves.toBeNull();

      // Derived from the same fixture's actual JSON.parse failure - the
      // contract is "first line of the parse error", not a hardcoded string.
      let expectedFirstLine = '';
      try {
        JSON.parse(unparseableStdout);
      } catch (error) {
        expectedFirstLine = (error as Error).message.split('\n')[0];
      }
      expect(expectedFirstLine).not.toBe('');

      expect(warn).toHaveBeenCalledTimes(1);
      const warned = warn.mock.calls[0][0] as string;
      expect(warned).toContain(`PR #${prNumber}`);
      expect(warned).toContain(expectedFirstLine);
      expect(warned).not.toContain('Command failed');
    });

    it('warns once per cause, naming the stderr reason rather than the command line', async () => {
      // An execFile rejection's message opens with the whole command line,
      // which embeds the PR id; keying the dedupe on that would print one
      // line per PR for a single repo-wide cause such as a revoked scope.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stderr = 'ERROR: TF400813: The user is not authorized to access this resource (dedupe probe).';
      state.azError = execError(
        `Command failed: cmd.exe /c az rest --url-parameters artifactId=vstfs:///CodeReview/CodeReviewId/${PROJECT_GUID}/1343`,
        { stderr: `\n${stderr}\n` },
      );
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343)).resolves.toBeNull();
      state.azError = execError(
        `Command failed: cmd.exe /c az rest --url-parameters artifactId=vstfs:///CodeReview/CodeReviewId/${PROJECT_GUID}/1344`,
        { stderr: `\n${stderr}\n` },
      );
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1344)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('PR #1343');
      expect(warn.mock.calls[0][0]).toContain(stderr);
      expect(warn.mock.calls[0][0]).not.toContain('Command failed');
    });

    /**
     * `policyWarningsShown` is bounded at MAX_POLICY_WARNINGS (32), evicting
     * the oldest cause when full. Every message below is unique to THIS test
     * (never reused by a sibling test in this describe block), so the "33
     * warns" count is exact regardless of how many distinct causes earlier
     * sibling tests already left in the module-level Set: those are just
     * older entries this test's 33 new ones evict first. As long as that
     * leftover count is under 32 (it is - a small, fixed number of sibling
     * tests above), pushing 33 brand-new distinct causes through is
     * guaranteed to evict every leftover AND this test's own cause #1 before
     * the loop finishes, which is what "cause #1 warns again" below depends
     * on - independent of the exact leftover count or of test execution
     * order relative to those siblings.
     */
    it('evicts the oldest cause once the dedupe set is full, at MAX_POLICY_WARNINGS (32)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const causes = Array.from(
        { length: 33 },
        (_unused, index) =>
          `ERROR: Not Found({"typeKey":"SyntheticEvictionProbe","message":"synthetic eviction-probe cause #${index + 1}"})`,
      );
      const az = importer();

      for (const cause of causes) {
        state.azError = execError(cause);
        await az.resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343);
      }
      expect(warn).toHaveBeenCalledTimes(33);

      // Cause #1 was evicted while adding the later causes: it warns again.
      state.azError = execError(causes[0]);
      await az.resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343);
      expect(warn).toHaveBeenCalledTimes(34);

      // Cause #33, the most recently added, is still in the set: dedupe
      // swallows the repeat, so the count stays put.
      state.azError = execError(causes[32]);
      await az.resolvePolicyEvaluations(ORG, PROJECT_GUID, 1343);
      expect(warn).toHaveBeenCalledTimes(34);
    });

    it('refuses a non-GUID project id or a non-positive PR number without running az', async () => {
      await expect(importer().resolvePolicyEvaluations(ORG, 'My Project', 1343)).resolves.toBeNull();
      await expect(importer().resolvePolicyEvaluations(ORG, `${PROJECT_GUID}/x`, 1343)).resolves.toBeNull();
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 0)).resolves.toBeNull();
      await expect(importer().resolvePolicyEvaluations(ORG, PROJECT_GUID, 1.5)).resolves.toBeNull();
      expect(state.azCallCount).toBe(0);
    });
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
      'https://dev.azure.com/my-org/My%20Project/_git/my-repo/pullrequest/1343',
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

  function stubNumber(value: unknown) {
    return vi.spyOn(AzureDevOpsImporter.prototype, 'resolvePRByNumber').mockResolvedValue(value as never);
  }
  function stubPolicies(evaluations: unknown) {
    return vi
      .spyOn(AzureDevOpsImporter.prototype, 'resolvePolicyEvaluations')
      .mockResolvedValue(evaluations as never);
  }
  const EVALUATE = { evaluateBranchPolicies: true };
  /** An item the policy gate lets through: active, not draft, clean preview merge, GUID known. */
  const evaluable = (overrides: Record<string, unknown> = {}) =>
    item({ state: 'active', isDraft: false, mergeStatus: 'succeeded', projectId: PROJECT_GUID, ...overrides });

  /**
   * The verdict is folded HERE and never leaves the adapter as a raw
   * `mergeStatus`. With branch-policy evaluation OFF (the default), `succeeded`
   * is `unknown` on purpose: it only says the preview merge applied cleanly, and
   * nothing has evaluated branch policies, so `ready` would promise a Merge
   * click this code cannot vouch for. The policy call is never made.
   */
  const MERGE_STATUS_TABLE = [
    ['succeeded', 'unknown'],
    ['conflicts', 'conflicting'],
    ['rejectedByPolicy', 'blocked'],
    ['failure', 'blocked'],
    ['queued', 'unknown'],
    ['notSet', 'unknown'],
    [null, 'unknown'],
    ['somethingNew', 'unknown'],
  ] as Array<[string | null, string]>;

  it.each(MERGE_STATUS_TABLE)('resolveByNumber folds mergeStatus=%s into %s with policy evaluation off', async (mergeStatus, expected) => {
    stubNumber(item({ state: 'active', mergeStatus, projectId: PROJECT_GUID }));
    const policies = stubPolicies([]);
    expect((await azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1343))?.mergeReadiness).toBe(expected);
    expect(
      (await azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1343, { evaluateBranchPolicies: false }))?.mergeReadiness,
    ).toBe(expected);
    expect(policies).not.toHaveBeenCalled();
  });

  /**
   * With policy evaluation ON, `succeeded` becomes what the blocking policies
   * say. Only blocking, enabled, live policies count. A rejected or broken one
   * is `blocked`; a non-reviewer evaluation in flight is `running` / `queued`
   * EVEN IF a reviewer policy is also waiting (the chip tracks CI while it
   * runs); a reviewer policy waiting for approvals is `blocked`, matching
   * GitHub's REVIEW_REQUIRED; all approved (or no policies at all) is `ready`.
   */
  it.each([
    ['no policies at all', [], 'ready'],
    ['every blocking policy approved', [evaluation(), evaluation({ typeId: MIN_REVIEWERS_TYPE })], 'ready'],
    ['a non-blocking rejection', [evaluation(), evaluation({ status: 'rejected', isBlocking: false })], 'ready'],
    ['a disabled blocking rejection', [evaluation({ status: 'rejected', isEnabled: false })], 'ready'],
    ['a deleted blocking rejection', [evaluation({ status: 'rejected', isDeleted: true })], 'ready'],
    ['notApplicable only', [evaluation({ status: 'notApplicable' })], 'ready'],
    ['a blocking rejection', [evaluation(), evaluation({ status: 'rejected' })], 'blocked'],
    ['a broken blocking policy', [evaluation({ status: 'broken' })], 'blocked'],
    ['a rejection beside a running build', [evaluation({ status: 'rejected' }), evaluation({ status: 'running' })], 'blocked'],
    ['a queued build', [evaluation({ status: 'queued' })], 'queued'],
    ['a running build', [evaluation({ status: 'running' })], 'running'],
    ['a queued and a running build', [evaluation({ status: 'queued' }), evaluation({ status: 'running' })], 'running'],
    ['a running build while reviewers are waiting', [evaluation({ status: 'running' }), evaluation({ status: 'queued', typeId: MIN_REVIEWERS_TYPE })], 'running'],
    ['a queued build while reviewers are waiting', [evaluation({ status: 'queued' }), evaluation({ status: 'queued', typeId: REQUIRED_REVIEWERS_TYPE })], 'queued'],
    ['minimum reviewers waiting, builds green', [evaluation(), evaluation({ status: 'queued', typeId: MIN_REVIEWERS_TYPE })], 'blocked'],
    ['required reviewers waiting, no other policy', [evaluation({ status: 'queued', typeId: REQUIRED_REVIEWERS_TYPE })], 'blocked'],
    ['a queued NON-blocking build beside approved blocking ones', [evaluation(), evaluation({ status: 'queued', isBlocking: false })], 'ready'],
    ['an unrecognized status', [evaluation({ status: 'somethingNew' })], 'unknown'],
    ['no readable answer', null, 'unknown'],
  ])('resolveByNumber with policy evaluation on folds %s into %s', async (_label, evaluations, expected) => {
    stubNumber(evaluable());
    const policies = stubPolicies(evaluations);
    const resolvedPr = await azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1343, EVALUATE);
    expect(resolvedPr?.mergeReadiness).toBe(expected);
    expect(policies).toHaveBeenCalledTimes(1);
    expect(policies).toHaveBeenCalledWith(ORG, PROJECT_GUID, 1343);
  });

  /**
   * The gate: the second `az` call is skipped wherever its answer cannot
   * change the verdict, and the verdict is then exactly the setting-off one.
   */
  it.each([
    ['a draft', evaluable({ isDraft: true }), 'unknown'],
    ['a completed PR', evaluable({ state: 'completed' }), 'unknown'],
    ['an abandoned PR', evaluable({ state: 'abandoned' }), 'unknown'],
    ['mergeStatus conflicts', evaluable({ mergeStatus: 'conflicts' }), 'conflicting'],
    ['mergeStatus rejectedByPolicy', evaluable({ mergeStatus: 'rejectedByPolicy' }), 'blocked'],
    ['mergeStatus failure', evaluable({ mergeStatus: 'failure' }), 'blocked'],
    ['mergeStatus queued', evaluable({ mergeStatus: 'queued' }), 'unknown'],
    ['mergeStatus notSet', evaluable({ mergeStatus: 'notSet' }), 'unknown'],
    ['mergeStatus null', evaluable({ mergeStatus: null }), 'unknown'],
    ['a null project GUID', evaluable({ projectId: null }), 'unknown'],
    ['an absent project GUID', (() => { const value = evaluable(); delete value.projectId; return value; })(), 'unknown'],
  ])('resolveByNumber with policy evaluation on skips the policy call for %s', async (_label, prItem, expected) => {
    stubNumber(prItem);
    const policies = stubPolicies([evaluation({ status: 'rejected' })]);
    const resolvedPr = await azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1343, EVALUATE);
    expect(resolvedPr?.mergeReadiness).toBe(expected);
    expect(policies).not.toHaveBeenCalled();
  });

  it('resolveForBranch evaluates policies for the ONE disambiguated candidate only', async () => {
    stubBranch([
      evaluable({ number: 1343, state: 'completed' }),
      evaluable({ number: 1344, headRefName: 'bugfix/7927-dev-database-managed-identity' }),
    ]);
    const policies = stubPolicies([evaluation({ status: 'running' })]);
    const resolvedPr = await azureDevOpsPRConnector.resolveForBranch!(
      AZURE_CWD,
      'bugfix/7927-dev-database-managed-identity',
      undefined,
      EVALUATE,
    );
    expect(resolvedPr?.number).toBe(1344);
    expect(resolvedPr?.mergeReadiness).toBe('running');
    expect(policies).toHaveBeenCalledTimes(1);
    expect(policies).toHaveBeenCalledWith(ORG, PROJECT_GUID, 1344);
  });

  it('resolveForBranch makes no policy call when nothing survives disambiguation', async () => {
    stubBranch([]);
    const policies = stubPolicies([]);
    await expect(
      azureDevOpsPRConnector.resolveForBranch!(AZURE_CWD, 'nope', undefined, EVALUATE),
    ).resolves.toBeNull();
    expect(policies).not.toHaveBeenCalled();
  });

  it('omits the verdict when the item carries no mergeStatus key (the commit tier)', async () => {
    stubCommit([item()]);
    const policies = stubPolicies([]);
    const resolvedPr = await azureDevOpsPRConnector.resolveByCommit!(AZURE_CWD, 'abcdef1234567');
    expect(resolvedPr?.number).toBe(1343);
    expect(resolvedPr).not.toHaveProperty('mergeReadiness');
    // The commit tier takes no options and never evaluates policies.
    expect(policies).not.toHaveBeenCalled();
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

  /**
   * Deadlock guard. `policyVerdictFor` calls
   * `azImporter.resolvePolicyEvaluations` directly, never through its own
   * `viaAz(...)`. `azQueue` admits only AZ_CONCURRENCY (2) concurrent slots,
   * and a `resolveByNumber(..., { evaluateBranchPolicies: true })` call
   * occupies its slot for the WHOLE resolve (the PR-row fetch AND the policy
   * fetch), because `viaAz` wraps the entire body. If the policy call were
   * ever wrapped in its own `viaAz(...)`, that nested `add()` would be a
   * THIRD task on the same queue: with two concurrent `resolveByNumber`
   * calls already occupying both slots (each still "active" - awaiting its
   * own nested add, not yet resolved), the nested add can never be granted a
   * slot, and neither outer call can ever finish either, since each is
   * waiting on its own nested add to settle. Deadlock.
   *
   * Drives the connector through the REAL `az` mock rather than a prototype
   * spy on `resolvePolicyEvaluations` (what every other test in this file
   * uses, which bypasses the queue entirely), so `viaAz` is genuinely
   * exercised. The mocked policy call resolves only once BOTH PR-row calls
   * have been observed - proving the two `resolveByNumber` calls are truly
   * overlapping rather than accidentally serialized end-to-end, which is the
   * precondition the deadlock needs to be reachable at all.
   *
   * `Promise.all([...])` is raced against a short bounded timeout rather
   * than awaited directly: under the mutated (nested-viaAz) code neither
   * call ever settles, and awaiting that directly would hang the whole test
   * file instead of failing fast and legibly.
   *
   * Placed LAST in this describe: `azQueue` is a module-level singleton with
   * no reset between tests, so a run against the mutated code permanently
   * pins both of its slots (the two never-settling policy adds) for the rest
   * of the process - any other `viaAz`-driven test after this one in the
   * same file run would also time out as a knock-on effect, not a second
   * bug. Read only the FIRST failure in a mutated run as the red signal.
   */
  it('runs the policy evaluation call inside the caller\'s own viaAz slot, never a nested queue add (deadlock guard)', async () => {
    let prRowCallsObserved = 0;
    let policyCallCount = 0;
    let releasePolicyGate: () => void = () => {};
    const policyGate = new Promise<void>((resolve) => {
      releasePolicyGate = resolve;
    });

    state.azStdoutFor = async (args: readonly string[]) => {
      if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'show') {
        prRowCallsObserved += 1;
        if (prRowCallsObserved === 2) releasePolicyGate();
        const prNumber = Number(args[args.indexOf('--id') + 1]);
        return JSON.stringify(row({ id: prNumber, status: 'active', draft: false, merge: 'succeeded' }));
      }
      if (args[0] === 'rest' && args[1] === '--method' && args[2] === 'get') {
        policyCallCount += 1;
        await policyGate;
        return JSON.stringify([evaluation()]);
      }
      throw new Error(`unexpected az invocation in deadlock guard: ${JSON.stringify(args)}`);
    };

    const bothSettled = Promise.all([
      azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1343, EVALUATE),
      azureDevOpsPRConnector.resolveByNumber!(AZURE_CWD, 1344, EVALUATE),
    ]);

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        'two concurrent resolveByNumber(..., evaluateBranchPolicies) calls did not settle within 2000ms - '
        + 'likely deadlocked on a nested viaAz around the policy evaluation call',
      )), 2000);
    });

    let results: Awaited<typeof bothSettled>;
    try {
      results = await Promise.race([bothSettled, timeout]);
    } finally {
      clearTimeout(timer!);
    }

    expect(results.map((resolvedPr) => resolvedPr?.mergeReadiness)).toEqual(['ready', 'ready']);
    expect(policyCallCount).toBe(2);
    expect(prRowCallsObserved).toBe(2);
    // Two PR-row fetches, two policy fetches, nothing extra.
    expect(state.azCallCount).toBe(4);
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
    [
      'resolveForBranch with policy evaluation on',
      () => azureDevOpsPRConnector.resolveForBranch!('/repo', 'main', undefined, { evaluateBranchPolicies: true }),
    ],
    [
      'resolveByNumber with policy evaluation on',
      () => azureDevOpsPRConnector.resolveByNumber!('/repo', 42, { evaluateBranchPolicies: true }),
    ],
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
