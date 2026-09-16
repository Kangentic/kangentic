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
  azArgs: [] as readonly string[],
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
        return { stdout: state.azStdout, stderr: '' };
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');

beforeEach(() => {
  state.whichResult = '/usr/bin/az';
  state.azStdout = '[]';
  state.azArgs = [];
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

  it('forwards the iteration path filter into the WIQL when given', async () => {
    state.azStdout = '[]';
    await new AzureDevOpsImporter().fetchWorkItemIds('my-org', 'My Project', String.raw`My Project\Sprint 1`);

    const wiqlArgument = state.azArgs[state.azArgs.indexOf('--wiql') + 1];
    expect(wiqlArgument).toContain(String.raw`[System.IterationPath] UNDER 'My Project\Sprint 1'`);
  });
});
