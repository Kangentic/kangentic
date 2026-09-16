/**
 * AzureDevOpsAdapter.listExternalIds: parses the "org/project" (optionally
 * "org/project::iterationPath") repository reference and delegates to the
 * client's cheap ids-only WIQL fetch. This is the reconcile handler's
 * auto-prune sweep (BACKLOG_IMPORT_RECONCILE in
 * src/main/ipc/handlers/backlog.ts); tests/unit/import-reconcile.test.ts
 * drives that handler against a MOCKED adapter.listExternalIds, so this file
 * pins the REAL implementation the handler calls through: the repository
 * parsing, the iteration-path split, and the numeric-id -> string mapping.
 *
 * DI pattern matches tests/unit/azure-devops-hydrate-import.test.ts: a real
 * AzureDevOpsImporter with the one CLI-backed method spied/stubbed, so no `az`
 * process is ever spawned.
 */
import { describe, it, expect, vi } from 'vitest';
import { AzureDevOpsAdapter } from '../../src/main/boards/adapters/azure-devops/adapter';
import { AzureDevOpsImporter } from '../../src/main/boards/adapters/azure-devops/client';

function makeAdapter() {
  const importer = new AzureDevOpsImporter();
  const fetchWorkItemIds = vi.spyOn(importer, 'fetchWorkItemIds');
  return { adapter: new AzureDevOpsAdapter(importer), fetchWorkItemIds };
}

describe('AzureDevOpsAdapter.listExternalIds', () => {
  it('parses org/project and delegates to the client, stringifying the numeric ids', async () => {
    const { adapter, fetchWorkItemIds } = makeAdapter();
    fetchWorkItemIds.mockResolvedValue([1, 2, 42]);

    const ids = await adapter.listExternalIds({ source: 'azure_devops', repository: 'my-org/my-project' });

    expect(fetchWorkItemIds).toHaveBeenCalledWith('my-org', 'my-project', undefined);
    expect(ids).toEqual(['1', '2', '42']);
  });

  it('splits off the iteration path segment and forwards it', async () => {
    const { adapter, fetchWorkItemIds } = makeAdapter();
    fetchWorkItemIds.mockResolvedValue([5]);

    await adapter.listExternalIds({
      source: 'azure_devops',
      repository: String.raw`my-org/my-project::my-project\Sprint 1`,
    });

    expect(fetchWorkItemIds).toHaveBeenCalledWith('my-org', 'my-project', String.raw`my-project\Sprint 1`);
  });

  // The reconcile prunes cache rows against whatever this resolves to, so an empty
  // array has to mean "the project has no work items" and nothing else. Returning
  // [] for an unparseable reference would claim the remote is empty and wipe the
  // source's entire cache; throwing routes it to the handler's prune try/catch,
  // which degrades to no prune for that round.
  it('throws without calling the client when the repository reference is malformed', async () => {
    const { adapter, fetchWorkItemIds } = makeAdapter();

    await expect(
      adapter.listExternalIds({ source: 'azure_devops', repository: 'not-a-valid-reference' }),
    ).rejects.toThrow(/Malformed Azure DevOps repository reference/);
    expect(fetchWorkItemIds).not.toHaveBeenCalled();
  });

  it('drops entries the CLI returned without a numeric id', async () => {
    const { adapter, fetchWorkItemIds } = makeAdapter();
    // A non-numeric id would not match any cached row, so passing it through to the
    // prune keep-list would delete a live item instead of keeping it.
    fetchWorkItemIds.mockResolvedValue([5, undefined, 7]);

    const ids = await adapter.listExternalIds({ source: 'azure_devops', repository: 'my-org/my-project' });

    expect(ids).toEqual(['5', '7']);
  });
});
