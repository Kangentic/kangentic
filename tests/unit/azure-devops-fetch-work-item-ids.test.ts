import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for AzureDevOpsImporter.fetchWorkItemIds: the ids-only WIQL fetch
 * that feeds the reconcile's auto-prune keep-list (see the JSDoc on
 * fetchWorkItemIds in client.ts). tests/unit/azure-devops-list-external-ids.test.ts
 * covers the caller (AzureDevOpsAdapter.listExternalIds) by spying on this
 * method directly, so the real `JSON.parse` -> filter body never runs there.
 * This file drives fetchWorkItemIds itself against a mocked `az` binary, the
 * same which/execFile shim as tests/unit/azure-devops-pr-resolver.test.ts and
 * tests/unit/gh-client-import.test.ts, normalized to argv shape (not
 * platform) per .claude/rules/cross-platform-parity.md.
 *
 * The output feeds a prune keep-list: a wrong id here DELETES a live cache
 * row, so the malformed-entry case is the load-bearing assertion, not the
 * happy path.
 */

const state = vi.hoisted(() => ({
  whichResult: '/usr/bin/az' as string | Error,
  azStdout: '[]',
  /** When set, answers each query from its WIQL instead of `azStdout`. */
  azStdoutForWiql: null as ((wiql: string) => string) | null,
  azArgs: [] as readonly string[],
  wiqlsRun: [] as string[],
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
        const rawArgs = Array.isArray(args) ? (args as readonly string[]) : [];
        // `execAz` branches on process.platform at MODULE LOAD:
        //   win32 -> ('cmd.exe', ['/c', 'az', ...tail]);  else -> ('az', [...tail]).
        // Normalize by argv SHAPE, never by platform, so this file is green on
        // Windows and on ubuntu CI alike.
        const tailArgs = rawArgs[0] === '/c' && rawArgs[1] === 'az' ? rawArgs.slice(2) : rawArgs;
        state.azArgs = tailArgs;
        const wiql = tailArgs[tailArgs.indexOf('--wiql') + 1] ?? '';
        state.wiqlsRun.push(wiql);
        return { stdout: state.azStdoutForWiql ? state.azStdoutForWiql(wiql) : state.azStdout, stderr: '' };
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');

beforeEach(() => {
  state.whichResult = '/usr/bin/az';
  state.azStdout = '[]';
  state.azStdoutForWiql = null;
  state.azArgs = [];
  state.wiqlsRun = [];
});

describe('AzureDevOpsImporter.fetchWorkItemIds', () => {
  it('parses a realistic `az boards query --output json` response into numeric ids', async () => {
    // Shape `az boards query` prints for an ids-only WIQL: an array of
    // { id, url } records, no `fields` payload since none was projected.
    state.azStdout = JSON.stringify([
      { id: 101, url: 'https://dev.azure.com/my-org/My%20Project/_apis/wit/workItems/101' },
      { id: 102, url: 'https://dev.azure.com/my-org/My%20Project/_apis/wit/workItems/102' },
    ]);

    const workItemIds = await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project');

    expect(workItemIds).toEqual([101, 102]);
    expect(state.azArgs.slice(0, 2)).toEqual(['boards', 'query']);
    expect(state.azArgs[state.azArgs.indexOf('--organization') + 1]).toBe('https://dev.azure.com/my-org');
    expect(state.azArgs[state.azArgs.indexOf('--project') + 1]).toBe('My Project');
    expect(state.azArgs).toContain('--output');
    const wiqlArgument = state.azArgs[state.azArgs.indexOf('--wiql') + 1];
    expect(wiqlArgument).toContain('SELECT [System.Id]');
  });

  // The ids feed the reconcile's prune keep-list, where a stray malformed id
  // would not match any cached row and would therefore delete a live item.
  it('drops a non-numeric id and an entry missing an id entirely, keeping only real numeric ids', async () => {
    state.azStdout = JSON.stringify([
      { id: 201, url: 'https://dev.azure.com/my-org/My%20Project/_apis/wit/workItems/201' },
      // A malformed entry: id came back as a string rather than a number.
      { id: '202', url: 'https://dev.azure.com/my-org/My%20Project/_apis/wit/workItems/202' },
      // A malformed entry: no id field at all.
      { url: 'https://dev.azure.com/my-org/My%20Project/_apis/wit/workItems/203' },
      { id: 204, url: 'https://dev.azure.com/my-org/My%20Project/_apis/wit/workItems/204' },
    ]);

    const workItemIds = await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project');

    expect(workItemIds).toEqual([201, 204]);
  });

  it('returns an empty array for a project with no work items', async () => {
    state.azStdout = '[]';
    const workItemIds = await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project');
    expect(workItemIds).toEqual([]);
  });

  // az prints nothing at all for a query that matches nothing (measured,
  // extension 1.0.2), not `[]`.
  it('returns an empty array when az prints nothing', async () => {
    state.azStdout = '';
    const workItemIds = await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project');
    expect(workItemIds).toEqual([]);
  });

  // az keeps only the first 1000 work items of a query. Ordered by id, that is
  // the oldest 1000, and a keep-list cut there would prune the recently changed
  // items the fetch just cached. So a full page is followed by the page past it.
  it('pages past az\'s 1000-item cap by id until a page comes back short', async () => {
    const idsFrom = (firstId: number, count: number): string => JSON.stringify(
      Array.from({ length: count }, (_unused, index) => ({ id: firstId + index })),
    );
    state.azStdoutForWiql = (wiql) => {
      if (wiql.includes('[System.Id] > 2000')) return idsFrom(2001, 5);
      if (wiql.includes('[System.Id] > 1000')) return idsFrom(1001, 1000);
      return idsFrom(1, 1000);
    };

    const workItemIds = await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project');

    expect(workItemIds).toHaveLength(2005);
    expect(workItemIds.at(-1)).toBe(2005);
    expect(state.wiqlsRun).toHaveLength(3);
    expect(state.wiqlsRun[0]).not.toContain('[System.Id] >');
  });

  it('runs one query when the first page is under the cap', async () => {
    state.azStdout = JSON.stringify(Array.from({ length: 999 }, (_unused, index) => ({ id: index + 1 })));
    expect(await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project')).toHaveLength(999);
    expect(state.wiqlsRun).toHaveLength(1);
  });

  it('throws when a full page would not advance, rather than loop', async () => {
    state.azStdout = JSON.stringify(Array.from({ length: 1000 }, () => ({ id: 7 })));
    await expect(new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project')).rejects.toThrow('did not advance');
  });

  it('throws after 25 pages when every page is full and keeps advancing', async () => {
    state.azStdoutForWiql = (wiql) => {
      const afterIdMatch = /\[System\.Id\] > (\d+)/.exec(wiql);
      const afterId = afterIdMatch ? Number(afterIdMatch[1]) : 0;
      return JSON.stringify(Array.from({ length: 1000 }, (_unused, index) => ({ id: afterId + index + 1 })));
    };

    await expect(new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project')).rejects.toThrow('passed 25 pages');
    expect(state.wiqlsRun).toHaveLength(25);
  });

  it('throws when a full page carries no numeric ids, after one query', async () => {
    state.azStdout = JSON.stringify(Array.from({ length: 1000 }, () => ({ url: 'x' })));

    await expect(new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project')).rejects.toThrow('did not advance');
    expect(state.wiqlsRun).toHaveLength(1);
  });

  it('forwards the iteration path filter into the WIQL when given', async () => {
    state.azStdout = '[]';
    await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project', String.raw`My Project\Sprint 1`);

    const wiqlArgument = state.azArgs[state.azArgs.indexOf('--wiql') + 1];
    expect(wiqlArgument).toContain(String.raw`[System.IterationPath] UNDER 'My Project\Sprint 1'`);
  });
});
