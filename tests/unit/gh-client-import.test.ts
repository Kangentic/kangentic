/**
 * GitHubImporter import-path behavior: the `stateCategory` bucket
 * `mapToExternalIssues` stamps from GitHub's raw issue `state`, and the
 * `since` watermark `fetchIssues` wires onto the REST issues query for the
 * reconcile's incremental fetch.
 *
 * `mapToExternalIssues` is pure and needs no CLI mock. `fetchIssues` drives a
 * mocked `gh` binary via the same which/execFile shim as
 * tests/unit/azure-devops-pr-resolver.test.ts, normalized to argv shape (not
 * platform) per .claude/rules/cross-platform-parity.md.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  whichResult: '/usr/bin/gh' as string | Error,
  lastArgs: [] as readonly string[],
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
      if (typeof callback === 'function') callback(null, { stdout: '[]', stderr: '' });
    },
    {
      [promisifyCustom]: async (_file: string, args?: readonly string[] | unknown) => {
        state.lastArgs = Array.isArray(args) ? (args as readonly string[]) : [];
        return { stdout: '[]', stderr: '' };
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

const { GitHubImporter } = await import('../../src/main/boards/adapters/github-common/gh-client');

function makeRawIssue(overrides: Partial<{
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  milestone: { title: string; number: number } | null;
  reactions: Record<string, number>;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    number: 1,
    title: 'Issue title',
    body: 'Body text',
    html_url: 'https://github.com/owner/repo/issues/1',
    state: 'open',
    labels: [],
    assignee: null,
    milestone: null,
    reactions: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  state.whichResult = '/usr/bin/gh';
  state.lastArgs = [];
});

describe('GitHubImporter.mapToExternalIssues - stateCategory bucketing', () => {
  it('buckets a closed issue as closed and an open issue as open', () => {
    const importer = new GitHubImporter();
    const [closedIssue, openIssue] = importer.mapToExternalIssues(
      [makeRawIssue({ number: 1, state: 'closed' }), makeRawIssue({ number: 2, state: 'open' })],
      new Set(),
    );
    expect(closedIssue.stateCategory).toBe('closed');
    expect(openIssue.stateCategory).toBe('open');
  });
});

describe('GitHubImporter.mapProjectItemsToExternalIssues - stateCategory bucketing', () => {
  it('always buckets a project item as open, regardless of its freeform status column', () => {
    // GitHub Projects statuses are freeform columns, not an open/closed axis, and
    // the Import dialog hides the state toggle for projects (see the comment on
    // mapProjectItemsToExternalIssues in gh-client.ts), so every item must stay
    // in the 'open' bucket no matter what its status says.
    const importer = new GitHubImporter();
    const [inProgress, done] = importer.mapProjectItemsToExternalIssues(
      [
        { id: 'item-1', title: 'In progress item', status: 'In Progress' },
        { id: 'item-2', title: 'Done item', status: 'Done' },
      ],
      new Set(),
    );
    expect(inProgress.stateCategory).toBe('open');
    expect(done.stateCategory).toBe('open');
  });
});

describe('GitHubImporter.fetchIssues - since query param', () => {
  // The watermark is a MAX over timestamps we already hold, so an exclusive
  // boundary would drop an item that changed in the same second as the newest one
  // we cached, permanently - GitHub timestamps have one-second resolution, and
  // GitHub documents `since` as "after". Azure DevOps's WIQL clause is an explicit
  // `>=`, and both adapters feed the same watermark, so this side rewinds a second
  // to match. Re-fetching a second of items upserts idempotently.
  it('rewinds since by one second so the watermark boundary is inclusive', async () => {
    const importer = new GitHubImporter();
    await importer.fetchIssues('owner/repo', 1, 50, undefined, 'all', '2026-03-01T00:00:00.000Z');

    const apiArg = state.lastArgs.find((arg) => arg.startsWith('repos/'));
    expect(apiArg).toBeDefined();
    const query = new URLSearchParams(apiArg?.split('?')[1] ?? '');
    expect(query.get('since')).toBe('2026-02-28T23:59:59.000Z');
  });

  it('omits since from the request URL when not passed', async () => {
    const importer = new GitHubImporter();
    await importer.fetchIssues('owner/repo', 1, 50, undefined, 'all');

    const apiArg = state.lastArgs.find((arg) => arg.startsWith('repos/'));
    expect(apiArg).toBeDefined();
    const query = new URLSearchParams(apiArg?.split('?')[1] ?? '');
    expect(query.has('since')).toBe(false);
  });

  // rewindOneSecond's Number.isNaN guard exists so a malformed watermark is never
  // silently turned into an epoch date - `new Date('not-a-timestamp').getTime() - 1000`
  // would otherwise re-fetch the entire remote history on every incremental sync.
  // Passing the value through verbatim keeps the bad watermark visible (and the
  // request harmless) instead of manufacturing a new, worse one.
  it('passes through an unparseable since value verbatim instead of rewinding it', async () => {
    const importer = new GitHubImporter();
    await importer.fetchIssues('owner/repo', 1, 50, undefined, 'all', 'not-a-timestamp');

    const apiArg = state.lastArgs.find((arg) => arg.startsWith('repos/'));
    expect(apiArg).toBeDefined();
    const query = new URLSearchParams(apiArg?.split('?')[1] ?? '');
    expect(query.get('since')).toBe('not-a-timestamp');
  });
});
