/**
 * LinearAdapter: how the Import dialog's Linear source reads a team.
 *
 * What a user loses without each case: a team's board order that is not cached
 * makes a 10-page reconcile ask Linear for the states ten times, and one that is
 * never refreshed imports cards in last week's column order; a missing team that
 * does not refuse leaves an import that silently shows nothing; an already
 * imported issue that is not marked comes back as a duplicate card; a failed
 * sign-in check that is not reported leaves the Connect banner blank; a label
 * lookup that throws breaks the team picker instead of keeping "Linear team KEY".
 * A listExternalIds that crept back would walk every issue id on each reconcile.
 *
 * The LinearClient is a stub object, so nothing here touches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExternalSource, ImportFetchInput } from '../../src/shared/types';
import { RefusalError } from '../../src/shared/refusal';
import { LinearAdapter } from '../../src/main/boards/adapters/linear/adapter';
import type {
  LinearClient,
  LinearIssueRaw,
  LinearTeamWithStates,
  LinearViewer,
} from '../../src/main/boards/adapters/linear/client';
import { LinearError } from '../../src/main/boards/adapters/linear/linear-error';

interface ClientStub {
  hasCredential: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  getViewer: ReturnType<typeof vi.fn<() => Promise<LinearViewer>>>;
  getTeam: ReturnType<typeof vi.fn<(teamKey: string) => Promise<LinearTeamWithStates | null>>>;
  listIssues: ReturnType<
    typeof vi.fn<(teamKey: string, options: { page: number; perPage: number; since?: string }) => Promise<{ issues: LinearIssueRaw[]; hasNextPage: boolean }>>
  >;
}

const VIEWER: LinearViewer = {
  id: 'user-1',
  name: 'Dana Park',
  displayName: 'dana',
  email: null,
  organization: { urlKey: 'acme' },
};

function teamWithStates(stateIds: string[], teamName = 'Platform'): LinearTeamWithStates {
  return {
    team: { id: 'team-1', key: 'PLT', name: teamName },
    states: stateIds.map((id, index) => ({ id, name: `State ${id}`, type: 'started', position: index })),
  };
}

function rawIssue(id: string, stateId: string): LinearIssueRaw {
  return {
    id,
    identifier: `PLT-${id}`,
    title: `Issue ${id}`,
    description: null,
    url: `https://linear.app/acme/issue/PLT-${id}`,
    priority: 0,
    priorityLabel: 'No priority',
    estimate: null,
    dueDate: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    state: { id: stateId, name: `State ${stateId}`, type: 'started', position: 0 },
    assignee: null,
    labels: { nodes: [] },
    cycle: null,
    project: null,
  };
}

function createStub(): ClientStub {
  return {
    hasCredential: vi.fn(async () => true),
    getViewer: vi.fn(async () => VIEWER),
    getTeam: vi.fn(async () => teamWithStates(['s-a', 's-b', 's-c'])),
    listIssues: vi.fn(async () => ({ issues: [], hasNextPage: false })),
  };
}

function createAdapter(stub: ClientStub): LinearAdapter {
  return new LinearAdapter(stub as unknown as LinearClient);
}

function fetchInput(page: number): ImportFetchInput {
  return { repository: 'PLT', page, perPage: 50 } as ImportFetchInput;
}

const noneImported = (): Set<string> => new Set<string>();

describe('LinearAdapter.fetch', () => {
  it('reads the team state order on page 1, reuses it on pages 2 and 3, and re-reads on the next page 1', async () => {
    const stub = createStub();
    stub.listIssues.mockResolvedValue({ issues: [rawIssue('i1', 's-c')], hasNextPage: true });
    const adapter = createAdapter(stub);

    await adapter.fetch(fetchInput(1), noneImported);
    expect(stub.getTeam).toHaveBeenCalledTimes(1);

    const secondPage = await adapter.fetch(fetchInput(2), noneImported);
    await adapter.fetch(fetchInput(3), noneImported);
    expect(stub.getTeam).toHaveBeenCalledTimes(1);
    // 's-c' is the third state of the cached order, so its rank is 2.
    expect(secondPage.issues[0].stateOrder).toBe(2);

    stub.getTeam.mockResolvedValue(teamWithStates(['s-c', 's-b', 's-a']));
    const refreshed = await adapter.fetch(fetchInput(1), noneImported);
    expect(stub.getTeam).toHaveBeenCalledTimes(2);
    expect(refreshed.issues[0].stateOrder).toBe(0);
  });

  it('rejects with a RefusalError when the team is not visible to the sign-in', async () => {
    const stub = createStub();
    stub.getTeam.mockResolvedValue(null);
    const adapter = createAdapter(stub);

    const rejection = adapter.fetch(fetchInput(1), noneImported);
    await expect(rejection).rejects.toBeInstanceOf(RefusalError);
    await expect(rejection).rejects.toThrow('PLT');
    expect(stub.listIssues).not.toHaveBeenCalled();
  });

  it('asks which issues are already imported by raw id and marks them', async () => {
    const stub = createStub();
    stub.listIssues.mockResolvedValue({ issues: [rawIssue('i1', 's-a'), rawIssue('i2', 's-a')], hasNextPage: false });
    const findAlreadyImported = vi.fn((_source: ExternalSource, _externalIds: string[]) => new Set<string>(['i2']));

    const result = await createAdapter(stub).fetch(fetchInput(1), findAlreadyImported);

    expect(findAlreadyImported).toHaveBeenCalledWith('linear', ['i1', 'i2']);
    expect(result.issues.map((issue) => [issue.externalId, issue.alreadyImported])).toEqual([
      ['i1', false],
      ['i2', true],
    ]);
  });

  it('passes hasNextPage through and counts the page it mapped', async () => {
    const stub = createStub();
    stub.listIssues.mockResolvedValue({ issues: [rawIssue('i1', 's-a')], hasNextPage: true });

    const result = await createAdapter(stub).fetch(fetchInput(1), noneImported);

    expect(result.hasNextPage).toBe(true);
    expect(result.totalCount).toBe(1);
  });
});

describe('LinearAdapter.checkPrerequisites and checkCli', () => {
  it('reports not connected when there is no credential, without calling Linear', async () => {
    const stub = createStub();
    stub.hasCredential.mockResolvedValue(false);
    const adapter = createAdapter(stub);

    expect(await adapter.checkPrerequisites()).toEqual({ cliOk: true, authOk: false, message: 'Not connected to Linear.' });
    expect(await adapter.checkCli()).toEqual({ available: true, authenticated: false, error: 'Not connected to Linear.' });
    expect(stub.getViewer).not.toHaveBeenCalled();
  });

  it('reports authenticated when the viewer resolves', async () => {
    const adapter = createAdapter(createStub());

    expect(await adapter.checkPrerequisites()).toEqual({ cliOk: true, authOk: true });
    expect(await adapter.checkCli()).toEqual({ available: true, authenticated: true, error: undefined });
  });

  it('reports Linear\'s own message when the viewer is refused', async () => {
    const stub = createStub();
    stub.getViewer.mockRejectedValue(new LinearError('Authentication required', 401, 'AUTHENTICATION_ERROR'));
    const adapter = createAdapter(stub);

    expect(await adapter.checkPrerequisites()).toEqual({ cliOk: true, authOk: false, message: 'Authentication required' });
    expect(await adapter.checkCli()).toEqual({ available: true, authenticated: false, error: 'Authentication required' });
  });
});

describe('LinearAdapter.resolveLabel', () => {
  it('returns the trimmed team name', async () => {
    const stub = createStub();
    stub.getTeam.mockResolvedValue(teamWithStates(['s-a'], '  Platform  '));

    expect(await createAdapter(stub).resolveLabel('PLT')).toBe('Platform');
  });

  it('returns null when the team is not found', async () => {
    const stub = createStub();
    stub.getTeam.mockResolvedValue(null);

    expect(await createAdapter(stub).resolveLabel('PLT')).toBeNull();
  });

  it('returns null instead of throwing when the lookup fails', async () => {
    const stub = createStub();
    stub.getTeam.mockRejectedValue(new LinearError('Rate limited', 429, 'RATELIMITED'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(await createAdapter(stub).resolveLabel('PLT')).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('LinearAdapter reconcile contract', () => {
  it('has no listExternalIds', () => {
    // An id walk on every reconcile was removed on purpose: backlog.ts escalates a provider without one to a full pass once a day.
    expect(new LinearAdapter(createStub() as unknown as LinearClient).listExternalIds).toBeUndefined();
  });
});
