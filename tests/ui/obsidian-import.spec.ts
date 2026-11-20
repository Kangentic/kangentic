/**
 * Obsidian in Import Tasks: a source added by choosing a folder, not by typing a
 * URL. Picking a source type opens the system folder dialog at once, a folder
 * outside a vault is refused on one line under the source types, and a saved
 * source whose folder moved offers Choose folder in place of the list.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

interface ObsidianMockWindow {
  __mockFolderPath?: string | null;
  __mockSelectFolderCancel?: boolean;
  __mockSelectFolderLastOptions?: { title?: string } | null;
  __mockImportSourcesAddError?: string;
  __mockImportSourcesAddCalls?: Array<{ source: string; url: string }>;
  __mockImportSourcesRemoved?: string[];
  __mockImportSourcesPreset?: unknown;
  __mockImportCheckCli?: unknown;
  __mockImportReconcile?: unknown;
  __mockSelectFolderError?: string;
  __mockImportSourcesRemoveError?: string;
  __mockOpenedPaths?: string[];
  __openedExternalUrls?: string[];
}

interface SeedBacklogItem {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  position: number;
  assignee: null;
  due_date: null;
  item_type: null;
  external_id: string;
  external_source: string;
  external_url: string;
  sync_status: null;
  external_metadata: null;
  attachment_count: number;
  created_at: string;
  updated_at: string;
}

function makeSeedItem(overrides: Partial<SeedBacklogItem> & Pick<SeedBacklogItem, 'id' | 'title' | 'external_source' | 'external_url'>, position: number): SeedBacklogItem {
  const now = new Date().toISOString();
  return {
    description: '',
    priority: 0,
    labels: [],
    position,
    assignee: null,
    due_date: null,
    item_type: null,
    external_id: overrides.id,
    sync_status: null,
    external_metadata: null,
    attachment_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const MOVED_SOURCE = {
  id: 'obsidian-src',
  source: 'obsidian_notes',
  label: 'Work: Projects',
  repository: '/vaults/Work/Projects',
  url: '/vaults/Work/Projects',
  createdAt: new Date().toISOString(),
};

/** A saved Obsidian source whose folder is gone, opened to its Import dialog banner. */
async function openMovedSourceDialog(page: Page): Promise<void> {
  await page.evaluate((source) => {
    const mock = window as unknown as ObsidianMockWindow;
    mock.__mockImportSourcesPreset = [source];
    mock.__mockImportCheckCli = {
      [source.repository]: { available: false, authenticated: false, error: `Folder not found: ${source.repository}` },
    };
  }, MOVED_SOURCE);
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.getByText('Work: Projects').click();
  await expect(page.locator('[data-testid="import-cli-error"]')).toContainText('Folder not found: /vaults/Work/Projects');
}

async function readRemoved(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockImportSourcesRemoved ?? []);
}

async function readAddCalls(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockImportSourcesAddCalls ?? []);
}

async function openObsidianSourceTypes(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.locator('[data-testid="add-import-source-btn"]').first().click();
  await page.getByRole('button', { name: /Obsidian/ }).click();
  await expect(page.locator('[data-testid="import-source-type-obsidian_notes"]')).toBeVisible();
}

test.describe('Adding an Obsidian source', () => {
  test('picking Notes opens the folder dialog and stops at the form, whose Connect saves the folder with its Label', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-add');
    await page.evaluate(() => {
      (window as unknown as ObsidianMockWindow).__mockFolderPath = '/vaults/Work/Projects';
    });

    await openObsidianSourceTypes(page);
    await page.locator('[data-testid="import-source-type-obsidian_notes"]').click();

    // The picked folder waits in the form, read-only, with its Label from the folder name.
    await expect(page.locator('[data-testid="import-source-url-readonly"]')).toHaveText('/vaults/Work/Projects');
    await expect(page.locator('[data-testid="import-source-label-input"]')).toHaveValue('Projects');
    expect(await readAddCalls(page)).toEqual([]);

    await page.locator('[data-testid="import-source-connect-btn"]').click();

    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
    const calls = await page.evaluate(() => ({
      added: (window as unknown as ObsidianMockWindow).__mockImportSourcesAddCalls,
      options: (window as unknown as ObsidianMockWindow).__mockSelectFolderLastOptions,
    }));
    expect(calls.added).toEqual([{ source: 'obsidian_notes', url: '/vaults/Work/Projects', taskLabel: 'Projects' }]);
    expect(calls.options?.title).toBe('Choose a folder in your Obsidian vault');

    await browser.close();
  });

  test('a folder outside any vault is refused in the form, and nothing opens', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-refused');
    await page.evaluate(() => {
      const mock = window as unknown as ObsidianMockWindow;
      mock.__mockFolderPath = '/notes/Recipes';
      // As main's refusal arrives over IPC, decorated with the channel and error class.
      mock.__mockImportSourcesAddError = "Error invoking remote method 'backlog:importSourcesAdd': RefusalError: Not in a vault: /notes/Recipes";
    });

    await openObsidianSourceTypes(page);
    await page.locator('[data-testid="import-source-type-obsidian_checklist"]').click();
    await page.locator('[data-testid="import-source-connect-btn"]').click();

    await expect(page.locator('[data-testid="import-source-error"]')).toHaveText('Not in a vault: /notes/Recipes');
    await expect(page.locator('[data-testid="import-source-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0);

    // The header's back arrow returns to the source types to pick again.
    await page.locator('[data-testid="import-source-back-btn"]').click();
    await expect(page.locator('[data-testid="import-source-type-obsidian_notes"]')).toBeVisible();

    await browser.close();
  });

  test('cancelling the folder dialog adds nothing and keeps the source types up', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-cancel');
    await page.evaluate(() => {
      (window as unknown as ObsidianMockWindow).__mockSelectFolderCancel = true;
    });

    await openObsidianSourceTypes(page);
    await page.locator('[data-testid="import-source-type-obsidian_notes"]').click();

    await expect(page.locator('[data-testid="import-source-type-obsidian_notes"]')).toBeVisible();
    const added = await page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockImportSourcesAddCalls ?? []);
    expect(added).toEqual([]);

    await browser.close();
  });
});

test.describe('A saved Obsidian source whose folder moved', () => {
  test('shows the folder problem with Choose folder, which swaps in the new folder', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-moved');
    await page.evaluate(() => {
      const mock = window as unknown as ObsidianMockWindow;
      mock.__mockImportSourcesPreset = [{
        id: 'obsidian-src',
        source: 'obsidian_notes',
        label: 'Work: Projects',
        repository: '/vaults/Work/Projects',
        url: '/vaults/Work/Projects',
        createdAt: new Date().toISOString(),
      }];
      mock.__mockImportCheckCli = {
        '/vaults/Work/Projects': { available: false, authenticated: false, error: 'Folder not found: /vaults/Work/Projects' },
      };
    });

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="import-sources-btn"]').first().click();
    await page.getByText('Work: Projects').click();

    const banner = page.locator('[data-testid="import-cli-error"]');
    await expect(banner).toContainText('Folder not found: /vaults/Work/Projects');

    await page.evaluate(() => {
      (window as unknown as ObsidianMockWindow).__mockFolderPath = '/vaults/Moved/Work/Projects';
    });
    await page.locator('[data-testid="import-choose-folder-btn"]').click();

    // The dialog reopens on the new source (the mock labels a source by its URL), and the old one is removed.
    await expect(page.locator('[data-testid="import-dialog"]')).toContainText('/vaults/Moved/Work/Projects');
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    const removed = await page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockImportSourcesRemoved);
    expect(removed).toEqual(['obsidian-src']);

    await browser.close();
  });

  test('cancelling the folder dialog keeps the banner and neither adds nor removes', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-moved-cancel');
    await openMovedSourceDialog(page);
    await page.evaluate(() => {
      (window as unknown as ObsidianMockWindow).__mockSelectFolderCancel = true;
    });

    await page.locator('[data-testid="import-choose-folder-btn"]').click();
    // The dialog was asked for a folder, which is the point the cancel answers.
    await expect.poll(() => page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockSelectFolderLastOptions ?? null)).not.toBeNull();

    await expect(page.locator('[data-testid="import-cli-error"]')).toContainText('Folder not found: /vaults/Work/Projects');
    await expect(page.locator('[data-testid="import-choose-folder-btn"]')).toBeEnabled();
    expect(await readAddCalls(page)).toEqual([]);
    expect(await readRemoved(page)).toEqual([]);

    await browser.close();
  });

  test('a refused folder shows the refusal in the banner and removes nothing', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-moved-refused');
    await openMovedSourceDialog(page);
    await page.evaluate(() => {
      const mock = window as unknown as ObsidianMockWindow;
      mock.__mockFolderPath = '/notes/Recipes';
      mock.__mockImportSourcesAddError = "Error invoking remote method 'backlog:importSourcesAdd': RefusalError: Not in a vault: /notes/Recipes";
    });

    await page.locator('[data-testid="import-choose-folder-btn"]').click();

    const banner = page.locator('[data-testid="import-cli-error"]');
    await expect(banner).toContainText('Not in a vault: /notes/Recipes');
    await expect(banner).not.toContainText('Folder not found');
    await expect(page.locator('[data-testid="import-choose-folder-btn"]')).toBeEnabled();
    expect(await readRemoved(page)).toEqual([]);

    await browser.close();
  });

  test('choosing the same folder again removes nothing, clears the banner and loads the list', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-moved-same');
    await openMovedSourceDialog(page);
    // The drive is back: the check passes now, and the add answers the saved source's own id.
    await page.evaluate(() => {
      const mock = window as unknown as ObsidianMockWindow;
      mock.__mockFolderPath = '/vaults/Work/Projects';
      mock.__mockImportCheckCli = { '/vaults/Work/Projects': { available: true, authenticated: true } };
      mock.__mockImportReconcile = [{
        externalId: 'note-1',
        externalSource: 'obsidian_notes',
        externalUrl: 'file:///vaults/Work/Projects/Plan.md',
        title: 'Plan the launch',
        body: '',
        labels: [],
        assignee: null,
        state: 'open',
        stateCategory: 'open',
        workItemType: '',
        createdAt: new Date('2025-01-01').toISOString(),
        updatedAt: new Date('2025-01-01').toISOString(),
        alreadyImported: false,
        fileAttachments: [],
        attachmentCount: 0,
      }];
    });

    await page.locator('[data-testid="import-choose-folder-btn"]').click();

    await expect(page.locator('[data-testid="import-issue-note-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    expect(await readAddCalls(page)).toEqual([{ source: 'obsidian_notes', url: '/vaults/Work/Projects' }]);
    expect(await readRemoved(page)).toEqual([]);
    // Still the same dialog, on the same source.
    await expect(page.locator('[data-testid="import-dialog"]')).toContainText('Work: Projects');

    await browser.close();
  });

  test('a failed remove of the old source still opens the dialog on the new folder', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-moved-remove-fails');
    await openMovedSourceDialog(page);
    await page.evaluate(() => {
      const mock = window as unknown as ObsidianMockWindow;
      mock.__mockFolderPath = '/vaults/Moved/Work/Projects';
      mock.__mockImportSourcesRemoveError = 'database is locked';
    });

    await page.locator('[data-testid="import-choose-folder-btn"]').click();

    // The mock labels a source by its URL, so the header shows the new folder.
    await expect(page.locator('[data-testid="import-dialog"]')).toContainText('/vaults/Moved/Work/Projects');
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    expect(await readRemoved(page)).toEqual(['obsidian-src']);

    await browser.close();
  });
});

test.describe('The Import popover for folder sources', () => {
  test('a folder dialog that fails adds nothing, shows no error and keeps the source types up', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-dialog-fails');
    await page.evaluate(() => {
      (window as unknown as ObsidianMockWindow).__mockSelectFolderError = 'The folder dialog could not open';
    });

    await openObsidianSourceTypes(page);
    await page.locator('[data-testid="import-source-type-obsidian_notes"]').click();

    // The rejection is handled after the dialog was asked, so wait for the ask before asserting absence.
    await expect.poll(() => page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockSelectFolderLastOptions ?? null)).not.toBeNull();
    await expect(page.locator('[data-testid="import-source-type-obsidian_notes"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-source-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-popover"]')).not.toContainText('could not open');
    expect(await readAddCalls(page)).toEqual([]);

    await browser.close();
  });

  test('a saved Obsidian source describes itself by its folder, a GitHub source has no such tip', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-row-tip');
    await page.evaluate((obsidianSource) => {
      (window as unknown as ObsidianMockWindow).__mockImportSourcesPreset = [
        obsidianSource,
        {
          id: 'github-src',
          source: 'github_issues',
          label: 'example-org/example-repo',
          repository: 'example-org/example-repo',
          url: 'https://github.com/example-org/example-repo',
          createdAt: new Date().toISOString(),
        },
      ];
    }, MOVED_SOURCE);

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="import-sources-btn"]').first().click();

    const obsidianLabel = page.locator('[data-testid="import-source-obsidian-src"]').getByText('Work: Projects');
    await obsidianLabel.hover();
    await expect(obsidianLabel).toHaveAccessibleDescription('/vaults/Work/Projects');

    const githubLabel = page.locator('[data-testid="import-source-github-src"]').getByText('example-org/example-repo');
    await githubLabel.hover();
    await expect(githubLabel).toHaveAccessibleDescription('');

    await browser.close();
  });
});

test.describe('The link on an imported backlog item', () => {
  const NOTE_ITEM = makeSeedItem({
    id: 'backlog-note',
    title: 'Plan the launch',
    external_source: 'obsidian_notes',
    external_url: 'file:///D:/Notes/Projects/Plan.md',
  }, 0);
  const LINEAR_ITEM = makeSeedItem({
    id: 'backlog-linear',
    title: 'Fix the importer',
    external_source: 'linear',
    external_url: 'https://linear.app/example/issue/ENG-1/fix',
  }, 1);

  async function seedAndOpenBacklog(page: Page): Promise<void> {
    await page.evaluate((items) => {
      (window as unknown as { __mockPreConfigure: (fn: (state: { backlogTasks: unknown[] }) => undefined) => void }).__mockPreConfigure((state) => {
        state.backlogTasks.push(...items);
        return undefined;
      });
    }, [NOTE_ITEM, LINEAR_ITEM]);
    // The store loaded its (empty) list when the project opened, so announce the seed the way an agent write is.
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.evaluate(() => {
      const stores = (window as unknown as { __zustandStores?: { project: { getState: () => { currentProject: { id: string } | null } } } }).__zustandStores;
      const fire = (window as unknown as { __mockFireBacklogChangedByAgent?: (projectId: string) => void }).__mockFireBacklogChangedByAgent;
      fire?.(stores?.project.getState().currentProject?.id ?? '');
    });
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(2);
  }

  test('a local note opens its file, any other item opens its web page', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-row-link');
    await seedAndOpenBacklog(page);

    const noteRow = page.locator('[data-testid="backlog-task-row"]').filter({ hasText: 'Plan the launch' });
    await noteRow.getByRole('button', { name: 'Open file', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockOpenedPaths ?? [])).toEqual(['D:/Notes/Projects/Plan.md']);
    expect(await page.evaluate(() => (window as unknown as ObsidianMockWindow).__openedExternalUrls ?? [])).toEqual([]);

    const linearRow = page.locator('[data-testid="backlog-task-row"]').filter({ hasText: 'Fix the importer' });
    await linearRow.getByRole('button', { name: 'Open in Linear', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as ObsidianMockWindow).__openedExternalUrls ?? [])).toEqual(['https://linear.app/example/issue/ENG-1/fix']);
    expect(await page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockOpenedPaths ?? [])).toEqual(['D:/Notes/Projects/Plan.md']);

    await browser.close();
  });

  test('the edit dialog link is named and routed the same way', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'obsidian-dialog-link');
    await seedAndOpenBacklog(page);

    const openEditor = async (item: SeedBacklogItem): Promise<void> => {
      await page.evaluate((editing) => {
        const stores = (window as unknown as {
          __zustandStores?: { backlog?: { getState: () => { setEditingItem: (task: unknown) => void } } };
        }).__zustandStores;
        if (!stores?.backlog) throw new Error('backlog store not exposed on __zustandStores');
        stores.backlog.getState().setEditingItem(editing);
      }, item);
      await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();
    };

    await openEditor(NOTE_ITEM);
    const noteLink = page.locator('[data-testid="backlog-task-external-link"]');
    await expect(noteLink).toHaveAccessibleName('Open file');
    await noteLink.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as ObsidianMockWindow).__mockOpenedPaths ?? [])).toEqual(['D:/Notes/Projects/Plan.md']);
    expect(await page.evaluate(() => (window as unknown as ObsidianMockWindow).__openedExternalUrls ?? [])).toEqual([]);

    // Escape closes the clean dialog (no xterm here, so the key reaches the document).
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toHaveCount(0);

    await openEditor(LINEAR_ITEM);
    const linearLink = page.locator('[data-testid="backlog-task-external-link"]');
    await expect(linearLink).toHaveAccessibleName('Open in Linear');
    await linearLink.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as ObsidianMockWindow).__openedExternalUrls ?? [])).toEqual(['https://linear.app/example/issue/ENG-1/fix']);

    await browser.close();
  });
});
