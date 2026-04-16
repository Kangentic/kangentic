/**
 * UI spec: externalRef survives the ImportDialog mapping through to importExecute.
 *
 * The key invariant: ImportDialog.tsx line 238 spreads `issue.fileAttachments`
 * directly into the importExecute payload. If that line were changed to omit
 * or remap the field, the executor would silently lose the gid needed for
 * URL refresh, reverting the core Asana attachment-import bug.
 *
 * This test drives the full user-visible flow: open the backlog import dialog,
 * fetch issues with a pre-seeded fileAttachments array, select all, click
 * Import, and assert that the captured importExecute payload preserves
 * fileAttachments[0].externalRef.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

/** Pre-connect Asana so the setup dialog is skipped when opening a source. */
async function preconnectAsana(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockAsanaPreset?: unknown }).__mockAsanaPreset = {
      state: { connected: true, email: 'mock-user@example.com' },
    };
  });
}

/** Seed a single Asana import source so the popover shows it immediately. */
async function seedImportSource(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockImportSourcesPreset?: unknown }).__mockImportSourcesPreset = [
      {
        id: 'test-asana-src',
        source: 'asana',
        label: 'My Asana Project',
        repository: '1234567890',
        url: 'https://app.asana.com/0/1234567890',
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

/** Seed importFetch to return one issue that has fileAttachments with externalRef. */
async function seedFetchWithAttachment(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
      issues: [
        {
          externalId: 'task-42',
          externalUrl: 'https://app.asana.com/0/1/42',
          title: 'Task with attached photo',
          body: 'See the attached image.',
          labels: [],
          assignee: null,
          state: 'open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          alreadyImported: false,
          fileAttachments: [
            {
              url: 'https://app.asana.com/api/1.0/attachments/999/photo.png',
              filename: 'photo.png',
              sizeBytes: 1234,
              externalRef: '999',
            },
          ],
        },
      ],
      totalCount: 1,
      hasNextPage: false,
    };
  });
}

test.describe('ImportDialog - externalRef passthrough to importExecute', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('fileAttachments with externalRef are preserved in the importExecute payload', async () => {
    const { browser, page } = await launchPage();

    // Pre-configure mocks before React mounts (evaluate runs in the browser
    // after load, so we set the global presets that the mock reads on each call).
    await preconnectAsana(page);
    await seedImportSource(page);
    await seedFetchWithAttachment(page);

    await createProject(page, 'import-attachment-test');

    // Navigate to the backlog view.
    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Open the import popover.
    const importSourcesBtn = page.locator('[data-testid="import-sources-btn"]').first();
    await importSourcesBtn.click();
    await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();

    // Click the pre-seeded Asana source to open ImportDialog.
    await page.getByText('My Asana Project').click();

    // Wait for ImportDialog to load the issue list.
    const issueRow = page.locator('[data-testid="import-issue-task-42"]');
    await issueRow.waitFor({ state: 'visible', timeout: 8000 });

    // Select all issues (the one seeded issue).
    await page.locator('[data-testid="import-select-all"]').click();
    await expect(issueRow.locator('input[type="checkbox"]')).toBeChecked();

    // Click Import.
    const importButton = page.locator('[data-testid="import-execute-btn"]');
    await expect(importButton).toBeEnabled();
    await importButton.click();

    // Wait for the import to complete (dialog closes, toast appears).
    await expect.poll(async () => {
      return page.evaluate(() => {
        return (window as unknown as { __lastImportExecuteInput?: unknown }).__lastImportExecuteInput != null;
      });
    }, { timeout: 5000 }).toBe(true);

    // Read the captured importExecute payload.
    const capturedInput = await page.evaluate(() => {
      return (window as unknown as {
        __lastImportExecuteInput?: {
          issues: Array<{
            externalId: string;
            fileAttachments?: Array<{
              url: string;
              filename: string;
              sizeBytes: number;
              externalRef?: string;
            }>;
          }>;
        };
      }).__lastImportExecuteInput;
    });

    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.issues).toHaveLength(1);

    const importedIssue = capturedInput!.issues[0];
    expect(importedIssue.externalId).toBe('task-42');
    expect(importedIssue.fileAttachments).toHaveLength(1);

    const attachment = importedIssue.fileAttachments![0];
    expect(attachment.externalRef).toBe('999');
    expect(attachment.url).toBe('https://app.asana.com/api/1.0/attachments/999/photo.png');
    expect(attachment.filename).toBe('photo.png');

    await browser.close();
  });
});
