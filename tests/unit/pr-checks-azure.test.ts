/**
 * The Azure DevOps half of the PR Checks list and "Send to agent", end to end
 * over a stubbed `az`: the client's argv and parsing, and the connector's
 * `listChecks` / `fetchCheckLog`.
 *
 * THESE FIXTURES FOLLOW THE PUBLISHED SHAPE, NOT A LIVE CAPTURE. `az` on the
 * authoring machine is signed in to an organization that is not this project's,
 * and a capture from it would put someone else's pipelines in a public repo. The
 * files in tests/fixtures/ follow Microsoft's documentation, with placeholder
 * ids, organization and names:
 * - `azure-devops-policy-evaluations.json`: Policy Evaluations List (a
 *   PolicyEvaluationRecord per policy: `configuration.type`, `settings`,
 *   `status`, `context`).
 * - `azure-devops-build-timeline.json`: Build Timeline Get (`records[]` of Stage,
 *   Job and Task with `result` and `log.id`).
 * - `azure-devops-build-log.txt`: Get Build Log, plain text, one
 *   `<ISO timestamp> <text>` line each.
 *
 * Real `az rest` applies the client's `--query` itself, so the stub does too:
 * `project` below runs the query string the client SENDS over the published
 * body, which makes a wrong field path in the client's query fail here (a
 * projected null) instead of passing against a hand-projected answer. It
 * supports only the two query forms the client uses and throws on any other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PRCheck } from '../../src/shared/types';

const state = vi.hoisted(() => ({
  /** Answers one `az` call from its normalized argv tail; a thrown Error is the CLI failing. */
  respond: (() => '') as (args: readonly string[]) => string,
  calls: [] as Array<readonly string[]>,
}));

const remotes = vi.hoisted(() => ({
  urls: ['git@ssh.dev.azure.com:v3/my-org/My%20Project/my-repo'] as readonly string[] | null,
}));
vi.mock('../../src/main/git/git-remotes', () => ({
  readRemoteUrls: async () => remotes.urls,
  invalidateRemoteUrlsCache: () => {},
}));

vi.mock('which', () => ({ default: async () => '/usr/bin/az' }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const mockExecFile = Object.assign(() => undefined, {
    [promisifyCustom]: async (_file: string, args?: readonly string[]) => {
      const raw = Array.isArray(args) ? args : [];
      // execAz runs `cmd.exe /c az ...` on win32 and `az ...` elsewhere; assert on the tail only.
      const tail = raw[0] === '/c' && raw[1] === 'az' ? raw.slice(2) : raw;
      state.calls.push(tail);
      return { stdout: state.respond(tail), stderr: '' };
    },
  });
  return { ...original, execFile: mockExecFile };
});

const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');
const { azureDevOpsPRConnector } = await import('../../src/main/pr/adapters/azure-devops/azure-devops-connector');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const POLICY_EVALUATIONS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'azure-devops-policy-evaluations.json'), 'utf-8')) as unknown;
const BUILD_TIMELINE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'azure-devops-build-timeline.json'), 'utf-8')) as unknown;
const BUILD_LOG = fs.readFileSync(path.join(FIXTURES, 'azure-devops-build-log.txt'), 'utf-8');

const PROJECT_GUID = '00000000-0000-4000-8000-000000000001';
const ORG_URL = 'https://dev.azure.com/my-org';
const PR_URL_PREFIX = 'https://dev.azure.com/my-org/My%20Project/_git/my-repo/pullrequest';
const RESULTS_URL = 'https://dev.azure.com/my-org/My%20Project/_build/results?buildId=711';

/** A PR row as the client's `--query` projects it. */
function prRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 'active',
    draft: false,
    src: 'refs/heads/feature/x',
    tgt: 'refs/heads/develop',
    created: '2026-10-22T16:00:00Z',
    closed: null,
    fork: null,
    merge: 'succeeded',
    projectId: PROJECT_GUID,
    ...overrides,
  };
}

function valueAt(source: unknown, dottedPath: string): unknown {
  let current: unknown = source;
  for (const key of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? null : current;
}

/** The part of `az --query` this stub understands: `<array path>[?filter].{key:path,...}`. */
function project(query: string, body: unknown): unknown {
  const match = /^(\w+)\[(?:\?(\w+)=='(\w+)' && (\w+)=='(\w+)')?\]\.\{(.+)\}$/.exec(query);
  if (!match) throw new Error(`the stub cannot run this az --query: ${query}`);
  const [, arrayKey, filterKeyA, filterValueA, filterKeyB, filterValueB, fields] = match;
  let records = (body as Record<string, unknown[]>)[arrayKey];
  if (filterKeyA) {
    records = records.filter((record) => valueAt(record, filterKeyA) === filterValueA && valueAt(record, filterKeyB) === filterValueB);
  }
  const pairs = fields.split(',').map((pair) => {
    const separator = pair.indexOf(':');
    return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
  });
  return records.map((record) => Object.fromEntries(pairs.map(([key, fieldPath]) => [key, valueAt(record, fieldPath)])));
}

const argAfter = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1];

/** A well-behaved Azure: the PR row, the published policy and timeline bodies, the build log. */
function azureAnswers(args: readonly string[]): string {
  if (args[0] === 'repos' && args[1] === 'pr' && args[2] === 'show') return JSON.stringify(prRow({ id: Number(argAfter(args, '--id')) }));
  if (args[0] !== 'rest') throw new Error(`unexpected az call: ${args.join(' ')}`);
  const url = argAfter(args, '--url');
  const query = args.includes('--query') ? argAfter(args, '--query') : null;
  if (url.endsWith('/_apis/policy/evaluations')) return JSON.stringify(project(query!, POLICY_EVALUATIONS));
  if (url.endsWith('/builds/711/timeline')) return JSON.stringify(project(query!, BUILD_TIMELINE));
  if (url.endsWith('/builds/711/logs/9')) return BUILD_LOG;
  throw new Error(`unexpected az rest url: ${url}`);
}

const prShowCalls = () => state.calls.filter((args) => args[0] === 'repos' && args[2] === 'show');

beforeEach(() => {
  state.respond = azureAnswers;
  state.calls = [];
  remotes.urls = ['git@ssh.dev.azure.com:v3/my-org/My%20Project/my-repo'];
});

describe('AzureDevOpsImporter build reads (stubbed az, published shapes)', () => {
  const importer = () => new AzureDevOpsImporter();

  it('resolveFailedBuildSteps asks the timeline of the build for its failed Task records and drops one without a log', async () => {
    const steps = await importer().resolveFailedBuildSteps('my-org', PROJECT_GUID, 711);
    const call = state.calls[0];
    expect(call.slice(0, 4)).toEqual(['rest', '--method', 'get', '--url']);
    expect(argAfter(call, '--url')).toBe(`${ORG_URL}/${PROJECT_GUID}/_apis/build/builds/711/timeline`);
    expect(argAfter(call, '--url-parameters')).toBe('api-version=7.1');
    // The failed Stage and Job are not steps, and the failed Task with no log has nothing to read.
    expect(steps).toEqual([{ name: 'Lint', logId: 6 }, { name: 'Build', logId: 9 }]);
  });

  it('resolveFailedBuildSteps keeps only records with a name and a numeric logId', async () => {
    state.respond = () => JSON.stringify([
      { name: 'text id', logId: '3' },
      { name: 'null id', logId: null },
      { name: 'no id' },
      { logId: 4 },
      { name: 'kept', logId: 7 },
    ]);
    await expect(importer().resolveFailedBuildSteps('my-org', PROJECT_GUID, 711)).resolves.toEqual([{ name: 'kept', logId: 7 }]);
  });

  it('resolveFailedBuildSteps is null for output that is not a JSON array, and refuses a bad id without running az', async () => {
    state.respond = () => 'WARNING: not json';
    await expect(importer().resolveFailedBuildSteps('my-org', PROJECT_GUID, 711)).resolves.toBeNull();
    state.respond = () => '{"records":[]}';
    await expect(importer().resolveFailedBuildSteps('my-org', PROJECT_GUID, 711)).resolves.toBeNull();
    state.calls = [];
    await expect(importer().resolveFailedBuildSteps('my-org', 'not-a-guid', 711)).resolves.toBeNull();
    await expect(importer().resolveFailedBuildSteps('my-org', PROJECT_GUID, 0)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('fetchBuildLog reads one log as plain text, with no --query and the build api version', async () => {
    await expect(importer().fetchBuildLog('my-org', PROJECT_GUID, 711, 9)).resolves.toBe(BUILD_LOG);
    const call = state.calls[0];
    expect(argAfter(call, '--url')).toBe(`${ORG_URL}/${PROJECT_GUID}/_apis/build/builds/711/logs/9`);
    expect(argAfter(call, '--url-parameters')).toBe('api-version=7.1');
    expect(call).not.toContain('--query');
  });

  it('fetchBuildLog is null when az fails, and refuses a bad project id without running az', async () => {
    state.respond = () => { throw new Error('boom'); };
    await expect(importer().fetchBuildLog('my-org', PROJECT_GUID, 711, 9)).resolves.toBeNull();
    state.calls = [];
    await expect(importer().fetchBuildLog('my-org', 'not-a-guid', 711, 9)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });
});

describe('azureDevOpsPRConnector.listChecks over the published policy shape', () => {
  it('lists the build and status policies of the PR, a build linking to its results, and the PR as the checks page', async () => {
    const listed = await azureDevOpsPRConnector.listChecks!('/repo', 101);
    const prUrl = `${PR_URL_PREFIX}/101`;
    expect(listed?.checksPageUrl).toBe(prUrl);
    // The reviewer policy and the soft-deleted build are not checks. The build
    // policy with no display name is named by its pipeline.
    expect(listed?.checks).toEqual([
      { id: '6a1e0a7c-4d0e-4e57-9a52-0f0c6f1b0001', name: 'Web - CI', group: null, url: RESULTS_URL, status: 'failed', hasLog: true },
      { id: '6a1e0a7c-4d0e-4e57-9a52-0f0c6f1b0002', name: 'sonar/quality-gate', group: null, url: prUrl, status: 'pending', hasLog: false },
      { id: '6a1e0a7c-4d0e-4e57-9a52-0f0c6f1b0005', name: 'Docs build', group: null, url: prUrl, status: 'pending', hasLog: false },
    ]);
    // Resolved the PR by number for its project id, then asked for its evaluations of that PR.
    expect(state.calls[0].slice(0, 3)).toEqual(['repos', 'pr', 'show']);
    expect(argAfter(state.calls[0], '--id')).toBe('101');
    const evaluationsCall = state.calls[1];
    expect(argAfter(evaluationsCall, '--url')).toBe(`${ORG_URL}/${PROJECT_GUID}/_apis/policy/evaluations`);
    expect(evaluationsCall).toContain(`artifactId=vstfs:///CodeReview/CodeReviewId/${PROJECT_GUID}/101`);
  });

  it('is null when the PR is gone', async () => {
    state.respond = () => 'null';
    await expect(azureDevOpsPRConnector.listChecks!('/repo', 102)).resolves.toBeNull();
  });

  it('is null when the PR row carries no project id, without asking for evaluations', async () => {
    state.respond = () => JSON.stringify(prRow({ projectId: null }));
    await expect(azureDevOpsPRConnector.listChecks!('/repo', 103)).resolves.toBeNull();
    expect(state.calls).toHaveLength(1);
  });

  it('is null when the evaluations cannot be read, and an empty list when the PR has none', async () => {
    state.respond = (args) => (args[0] === 'rest' ? 'WARNING: not json' : azureAnswers(args));
    await expect(azureDevOpsPRConnector.listChecks!('/repo', 104)).resolves.toBeNull();
    state.respond = (args) => (args[0] === 'rest' ? '[]' : azureAnswers(args));
    await expect(azureDevOpsPRConnector.listChecks!('/repo', 104)).resolves.toEqual({ checks: [], checksPageUrl: `${PR_URL_PREFIX}/104` });
  });

  it('is null off an Azure remote, without running az', async () => {
    remotes.urls = ['https://github.com/owner/repo.git'];
    await expect(azureDevOpsPRConnector.listChecks!('/repo', 105)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });
});

describe('azureDevOpsPRConnector.fetchCheckLog over a build timeline and log', () => {
  const buildCheck: PRCheck = { id: 'e1', name: 'Web - CI', group: null, url: RESULTS_URL, status: 'failed', hasLog: true };

  it('reads the log of the LAST failed step and returns the output ending at its last error line', async () => {
    const tail = await azureDevOpsPRConnector.fetchCheckLog!('/repo', 201, buildCheck, 6_000);
    const logCall = state.calls.find((args) => argAfter(args, '--url')?.includes('/logs/'));
    // Lint (log 6) failed first, Build (log 9) is the one the build stopped on.
    expect(argAfter(logCall!, '--url')).toBe(`${ORG_URL}/${PROJECT_GUID}/_apis/build/builds/711/logs/9`);
    expect(state.calls.some((args) => argAfter(args, '--url')?.endsWith('/logs/6'))).toBe(false);
    expect(tail).toContain('error CS1501');
    expect(tail!.endsWith('##[error]Dotnet command failed with non-zero exit code on the following projects : /agent/_work/1/s/App.sln')).toBe(true);
    expect(tail).not.toContain('Finishing: Build');
    expect(tail).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(tail!.length).toBeLessThanOrEqual(6_000);
  });

  it('resolves the PR once across a list and a log read of the same PR (the project id is cached)', async () => {
    await azureDevOpsPRConnector.listChecks!('/repo', 301);
    await azureDevOpsPRConnector.fetchCheckLog!('/repo', 301, buildCheck, 6_000);
    await azureDevOpsPRConnector.fetchCheckLog!('/repo', 301, buildCheck, 6_000);
    expect(prShowCalls()).toHaveLength(1);
    // A different PR is its own question.
    await azureDevOpsPRConnector.fetchCheckLog!('/repo', 302, buildCheck, 6_000);
    expect(prShowCalls()).toHaveLength(2);
  });

  it('is null for a check that links to the PR instead of a build, without running az', async () => {
    const statusCheck: PRCheck = { ...buildCheck, url: `${PR_URL_PREFIX}/203`, hasLog: false };
    await expect(azureDevOpsPRConnector.fetchCheckLog!('/repo', 203, statusCheck, 6_000)).resolves.toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('is null when the PR is gone, has no project id, or the build has no failed step with a log', async () => {
    state.respond = () => 'null';
    await expect(azureDevOpsPRConnector.fetchCheckLog!('/repo', 204, buildCheck, 6_000)).resolves.toBeNull();
    state.respond = () => JSON.stringify(prRow({ projectId: null }));
    await expect(azureDevOpsPRConnector.fetchCheckLog!('/repo', 205, buildCheck, 6_000)).resolves.toBeNull();
    state.respond = (args) => (args[0] === 'rest' ? '[]' : azureAnswers(args));
    await expect(azureDevOpsPRConnector.fetchCheckLog!('/repo', 206, buildCheck, 6_000)).resolves.toBeNull();
  });

  it('is null when the log itself cannot be read', async () => {
    state.respond = (args) => {
      if (args[0] === 'rest' && argAfter(args, '--url').includes('/logs/')) throw new Error('boom');
      return azureAnswers(args);
    };
    await expect(azureDevOpsPRConnector.fetchCheckLog!('/repo', 207, buildCheck, 6_000)).resolves.toBeNull();
  });
});
