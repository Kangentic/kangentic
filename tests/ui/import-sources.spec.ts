/**
 * Import Tasks' saved sources and their Label, in the browser: a saved row's
 * menu (Edit source, Remove) that neither opens the source nor closes the
 * popover, the Label a link's form fills in until it is typed in, the
 * Repository folder form's Browse list, and the Import dialog's rows for a
 * repository folder source. Driven against the headless mock
 * (`__mockImportSourcesPreset`, `__mockRepoFolders`, `__mockImportReconcile`).
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

interface ImportMockWindow {
  __mockImportSourcesPreset?: unknown;
  __mockImportSourcesAddCalls?: unknown[];
  __mockImportSourcesUpdateCalls?: unknown[];
  __mockImportSourcesRemoved?: string[];
  __mockRepoFolders?: unknown;
  __mockImportReconcile?: unknown;
  __lastImportExecuteInput?: { sourceId?: string; source: string };
}

const GITHUB_SOURCE = {
  id: 'github-src',
  source: 'github_issues',
  label: 'example-org/example-repo',
  repository: 'example-org/example-repo',
  url: 'https://github.com/example-org/example-repo',
  createdAt: new Date().toISOString(),
};

const REPO_FOLDER_SOURCE = {
  id: 'repo-src',
  source: 'repo_folder',
  label: 'openspec/changes',
  repository: 'openspec/changes',
  url: 'openspec/changes',
  createdAt: new Date().toISOString(),
  taskLabel: 'openspec',
};

async function readMock<Key extends keyof ImportMockWindow>(page: Page, key: Key): Promise<ImportMockWindow[Key]> {
  return page.evaluate((name) => (window as unknown as ImportMockWindow)[name], key);
}

async function openPopover(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
}

test.describe('A saved source row', () => {
  test('its menu edits the Label and removes the source, and never opens it or closes the popover', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'import-source-menu');
    await page.evaluate((source) => {
      (window as unknown as ImportMockWindow).__mockImportSourcesPreset = [source];
    }, GITHUB_SOURCE);
    await openPopover(page);

    const menuButton = page.locator('[data-testid="import-source-menu-btn-github-src"]');
    const menu = page.locator('[data-testid="import-source-menu"]');

    await test.step('the menu is always on the row, and Escape closes only the menu', async () => {
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
      await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0);
    });

    await test.step('Edit source shows the link read-only and saves the Label', async () => {
      await menuButton.click();
      await page.locator('[data-testid="edit-source-github-src"]').click();
      await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
      await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="import-source-url-readonly"]')).toHaveText(GITHUB_SOURCE.url);
      await expect(page.locator('[data-testid="import-source-url-input"]')).toHaveCount(0);
      const labelInput = page.locator('[data-testid="import-source-label-input"]');
      await expect(labelInput).toHaveValue('');
      await labelInput.fill('web');
      await page.locator('[data-testid="import-source-save-btn"]').click();

      await expect(page.locator('[data-testid="import-source-github-src"]')).toBeVisible();
      expect(await readMock(page, '__mockImportSourcesUpdateCalls')).toEqual([{ id: 'github-src', taskLabel: 'web' }]);
    });

    await test.step('Edit source opens with the saved Label, and the back arrow saves nothing', async () => {
      await menuButton.click();
      await page.locator('[data-testid="edit-source-github-src"]').click();
      await expect(page.locator('[data-testid="import-source-label-input"]')).toHaveValue('web');
      await page.locator('[data-testid="import-source-back-btn"]').click();
      await expect(page.locator('[data-testid="import-source-github-src"]')).toBeVisible();
      expect(await readMock(page, '__mockImportSourcesUpdateCalls')).toHaveLength(1);
    });

    await test.step('Remove removes the row and leaves the popover open', async () => {
      await menuButton.click();
      await page.locator('[data-testid="remove-source-github-src"]').click();
      await expect(page.locator('[data-testid="import-source-github-src"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
      await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0);
      expect(await readMock(page, '__mockImportSourcesRemoved')).toEqual(['github-src']);
    });

    await browser.close();
  });
});

test.describe('A link source form', () => {
  test('fills the Label from the link until it is typed in, and a cleared Label is not sent', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'import-link-label');
    await openPopover(page);
    await page.locator('[data-testid="add-import-source-btn"]').click();
    await page.locator('[data-testid="import-provider-github"]').click();
    await page.locator('[data-testid="import-source-type-github_issues"]').click();

    const urlInput = page.locator('[data-testid="import-source-url-input"]');
    const labelInput = page.locator('[data-testid="import-source-label-input"]');
    // The old hint line is the field's tip now.
    await expect(page.locator('[data-testid="import-source-field-info"]')).toHaveAccessibleDescription('Paste the full URL to your GitHub repository');

    await urlInput.fill('https://github.com/acme/web.git');
    await expect(labelInput).toHaveValue('web');

    await labelInput.fill('frontend');
    await urlInput.fill('https://github.com/acme/api');
    await expect(labelInput).toHaveValue('frontend');

    await labelInput.fill('');
    await page.locator('[data-testid="import-source-connect-btn"]').click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
    expect(await readMock(page, '__mockImportSourcesAddCalls')).toEqual([{ source: 'github_issues', url: 'https://github.com/acme/api' }]);

    await browser.close();
  });

  test('Escape steps back from the form to the source types', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'import-link-escape');
    await openPopover(page);
    await page.locator('[data-testid="add-import-source-btn"]').click();
    await page.locator('[data-testid="import-provider-github"]').click();
    await page.locator('[data-testid="import-source-type-github_issues"]').click();
    await expect(page.locator('[data-testid="import-source-form"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="import-source-type-github_issues"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();

    await browser.close();
  });
});

test.describe('The Repository folder source', () => {
  test('Browse lists the branch folders, typing narrows them, and a pick fills the folder and its Label', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'import-repo-folder');
    await page.evaluate(() => {
      (window as unknown as ImportMockWindow).__mockRepoFolders = {
        baseBranch: 'main',
        folders: [
          { path: 'docs/adr', itemCount: 5 },
          { path: 'openspec/changes', itemCount: 3 },
        ],
      };
    });
    await openPopover(page);
    await page.locator('[data-testid="add-import-source-btn"]').click();
    await page.locator('[data-testid="import-provider-repo-folder"]').click();

    const folderInput = page.locator('[data-testid="import-source-url-input"]');
    const labelInput = page.locator('[data-testid="import-source-label-input"]');
    const list = page.locator('[data-testid="import-source-browse-list"]');

    await test.step('the Label appears only once a folder is named', async () => {
      await expect(folderInput).toBeVisible();
      await expect(labelInput).toHaveCount(0);
      await expect(page.locator('[data-testid="import-source-connect-btn"]')).toBeDisabled();
    });

    await test.step('Browse shows the folders on the default branch with their counts', async () => {
      await page.locator('[data-testid="import-source-browse-btn"]').click();
      await expect(list).toContainText('Folders on main');
      await expect(page.locator('[data-testid="import-source-browse-folder-docs/adr"]')).toContainText('5');
      await expect(page.locator('[data-testid="import-source-browse-folder-openspec/changes"]')).toContainText('3');
    });

    await test.step('typing narrows the list', async () => {
      await folderInput.fill('open');
      await expect(page.locator('[data-testid="import-source-browse-folder-docs/adr"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="import-source-browse-folder-openspec/changes"]')).toBeVisible();
    });

    await test.step('a pick fills the folder, closes the list and fills the Label from its name', async () => {
      await page.locator('[data-testid="import-source-browse-folder-openspec/changes"]').click();
      await expect(folderInput).toHaveValue('openspec/changes');
      await expect(list).toHaveCount(0);
      await expect(labelInput).toHaveValue('changes');
      await expect(page.locator('[data-testid="import-source-label-info"]')).toHaveAccessibleDescription('From the folder name. Put on every task it imports.');
    });

    await test.step('Connect saves the folder with its Label', async () => {
      await labelInput.fill('openspec');
      await page.locator('[data-testid="import-source-connect-btn"]').click();
      await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
      expect(await readMock(page, '__mockImportSourcesAddCalls')).toEqual([{ source: 'repo_folder', url: 'openspec/changes', taskLabel: 'openspec' }]);
    });

    await browser.close();
  });

  test('its Import dialog has no Open/Closed toggle, shows the Label and the file names, and imports from the saved source', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'import-repo-folder-dialog');
    await page.evaluate((sources) => {
      const mock = window as unknown as ImportMockWindow;
      mock.__mockImportSourcesPreset = sources;
      mock.__mockImportReconcile = [{
        externalId: 'add-login',
        externalSource: 'repo_folder',
        externalUrl: '',
        title: 'add-login',
        displayId: 'add-login',
        body: '- openspec/changes/add-login/proposal.md\n- openspec/changes/add-login/specs/',
        labels: [],
        assignee: null,
        state: '',
        stateCategory: 'open',
        createdAt: new Date('2025-01-01').toISOString(),
        updatedAt: new Date('2025-01-01').toISOString(),
        alreadyImported: false,
        attachmentCount: 0,
      }];
    }, [REPO_FOLDER_SOURCE, GITHUB_SOURCE]);
    await openPopover(page);

    await test.step('a GitHub source has the toggle', async () => {
      await page.locator('[data-testid="import-source-github-src"]').click();
      const dialog = page.locator('[data-testid="import-dialog"]');
      await expect(dialog.getByRole('button', { name: 'Closed', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });

    await test.step('the repository folder source does not, and its row carries the Label and the names', async () => {
      await page.locator('[data-testid="import-sources-btn"]').first().click();
      await page.locator('[data-testid="import-source-repo-src"]').click();
      const dialog = page.locator('[data-testid="import-dialog"]');
      const row = page.locator('[data-testid="import-issue-add-login"]');
      await expect(row).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Closed', exact: true })).toHaveCount(0);
      await expect(row).toContainText('openspec');
      await expect(row.locator('[data-testid="import-issue-paths"]')).toHaveText('proposal.md, specs/');
    });

    await test.step('the import names the saved source, whose Label main adds', async () => {
      await page.locator('[data-testid="import-issue-add-login"]').click();
      await page.locator('[data-testid="import-execute-btn"]').click();
      await expect.poll(() => readMock(page, '__lastImportExecuteInput')).toMatchObject({
        source: 'repo_folder',
        sourceId: 'repo-src',
        taskLabel: 'openspec',
      });
    });

    await browser.close();
  });
});

test.describe('The Script source', () => {
  test('saves a command and its Label, with no Browse', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'import-script');
    await openPopover(page);
    await page.locator('[data-testid="add-import-source-btn"]').click();
    await page.locator('[data-testid="import-provider-script"]').click();

    const scriptInput = page.locator('[data-testid="import-source-url-input"]');
    const labelInput = page.locator('[data-testid="import-source-label-input"]');

    await expect(scriptInput).toBeVisible();
    await expect(page.locator('[data-testid="import-source-browse-btn"]')).toHaveCount(0);
    await expect(scriptInput).toHaveJSProperty('tagName', 'TEXTAREA');

    await scriptInput.fill('node scripts/list-changes.js');
    await expect(labelInput).toHaveValue('list-changes.js');
    await labelInput.fill('openspec');
    await page.locator('[data-testid="import-source-connect-btn"]').click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
    expect(await readMock(page, '__mockImportSourcesAddCalls')).toEqual([
      { source: 'script', url: 'node scripts/list-changes.js', taskLabel: 'openspec' },
    ]);

    await browser.close();
  });
});
