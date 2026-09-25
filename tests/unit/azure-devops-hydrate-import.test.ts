/**
 * AzureDevOpsAdapter.hydrateForImport: comments are deferred from the list
 * fetch (one `az rest` per work item is the dominant cost), so this fold-in
 * runs only for the handful of items being imported (BACKLOG_IMPORT_EXECUTE).
 * Pins the append-vs-use-alone branch on whether the issue already has a body.
 *
 * DI pattern matches tests/unit/azure-devops-download-auth.test.ts: a real
 * AzureDevOpsImporter with the one CLI-backed method spied/stubbed, so no `az`
 * process is ever spawned.
 */
import { describe, it, expect, vi } from 'vitest';
import { AzureDevOpsAdapter } from '../../src/main/boards/adapters/azure-devops/adapter';
import { AzureDevOpsImporter } from '../../src/main/boards/adapters/azure-devops/client';
import type { ImportExecuteInput } from '../../src/shared/types';

function makeAdapter() {
  const importer = new AzureDevOpsImporter();
  const fetchCommentSectionsForItems = vi.spyOn(importer, 'fetchCommentSectionsForItems');
  return { adapter: new AzureDevOpsAdapter(importer), fetchCommentSectionsForItems };
}

function makeIssue(
  overrides: Partial<ImportExecuteInput['issues'][number]> = {},
): ImportExecuteInput['issues'][number] {
  return {
    externalId: '42',
    externalUrl: 'https://dev.azure.com/my-org/my-project/_workitems/edit/42',
    title: 'Test item',
    body: 'Original description',
    labels: [],
    assignee: null,
    ...overrides,
  };
}

describe('AzureDevOpsAdapter.hydrateForImport', () => {
  it('appends the fetched comment section to an issue with an existing body', async () => {
    const { adapter, fetchCommentSectionsForItems } = makeAdapter();
    fetchCommentSectionsForItems.mockResolvedValue(
      new Map([[42, '## Comments\n\n### Alice - Jan 1, 2026\n\nHello']]),
    );

    const [issue] = await adapter.hydrateForImport('my-org/my-project', [
      makeIssue({ body: 'Original description' }),
    ]);

    expect(issue.body).toBe('Original description\n\n## Comments\n\n### Alice - Jan 1, 2026\n\nHello');
  });

  it('uses the comment section alone when the issue has no existing body', async () => {
    const { adapter, fetchCommentSectionsForItems } = makeAdapter();
    fetchCommentSectionsForItems.mockResolvedValue(new Map([[42, '## Comments\n\n### Alice\n\nHello']]));

    const [issue] = await adapter.hydrateForImport('my-org/my-project', [makeIssue({ body: '' })]);

    expect(issue.body).toBe('## Comments\n\n### Alice\n\nHello');
  });

  it('leaves the body unchanged when no comment section was fetched for that item', async () => {
    const { adapter, fetchCommentSectionsForItems } = makeAdapter();
    fetchCommentSectionsForItems.mockResolvedValue(new Map());

    const [issue] = await adapter.hydrateForImport('my-org/my-project', [makeIssue({ body: 'Unchanged' })]);

    expect(issue.body).toBe('Unchanged');
    expect(fetchCommentSectionsForItems).toHaveBeenCalledWith('my-org', 'my-project', [42]);
  });
});
