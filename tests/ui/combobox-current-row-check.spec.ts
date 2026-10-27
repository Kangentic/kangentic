/**
 * Every combobox marks its current row the way ColumnPicker and
 * AutomationTypePicker do: the row stays `role="option"` with
 * `aria-selected="true"` and ends with an accent check, and every other row
 * carries neither. The menu is a `role="listbox"`.
 *
 * The shared Combobox is covered here by the Settings > Agent permission field,
 * FontCombobox by Settings > Terminal's font family, and ModelCombobox by the
 * New Task dialog's model field (which marked no row before). The Language
 * picker, also the shared Combobox, has its own cases in display-language.spec.ts.
 */
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

test.describe.configure({ mode: 'parallel', timeout: 30_000 });

/** No aliases, so every current version, Opus with its 1M chip, is a top-level row. */
const CLAUDE_MODELS = {
  claude: {
    capabilities: {
      effortLevels: ['low', 'medium', 'high'],
      supportsModelOverride: true,
      models: ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5'],
      modelDisplayNames: {
        'claude-haiku-4-5': 'Haiku 4.5',
        'claude-opus-5-5': 'Opus 5.5',
        'claude-opus-5-5[1m]': 'Opus 5.5 (1M)',
        'claude-sonnet-5-5': 'Sonnet 5.5',
      },
    },
  },
};

/** The same with an `opus` alias, which leads the menu in its Latest group. */
const CLAUDE_MODELS_WITH_ALIAS = {
  claude: {
    capabilities: {
      ...CLAUDE_MODELS.claude.capabilities,
      modelDisplayNames: { ...CLAUDE_MODELS.claude.capabilities.modelDisplayNames, opus: 'Opus' },
      modelAliases: [{ id: 'opus', resolvesTo: 'claude-opus-5-5' }],
    },
  },
};

async function withProjectPage(body: (page: Page) => Promise<void>): Promise<void> {
  const { browser, page }: { browser: Browser; page: Page } = await launchPage();
  try {
    await createProject(page, `RowCheck ${Date.now()}`);
    await waitForBoard(page);
    await body(page);
  } finally {
    await browser.close();
  }
}

/** The one current row: selected, with the check, and every other row without either. */
async function expectOnlyCurrentRowChecked(menu: Locator, current: Locator): Promise<void> {
  await expect(menu).toHaveAttribute('role', 'listbox');
  await expect(current).toHaveAttribute('role', 'option');
  await expect(current).toHaveAttribute('aria-selected', 'true');
  await expect(menu.locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(menu.locator('svg.lucide-check')).toHaveCount(1);
}

async function openSettingsTab(page: Page, tabName: string): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: tabName, exact: true }).click();
}

test('the shared Combobox checks the current row', async () => {
  await withProjectPage(async (page) => {
    await openSettingsTab(page, 'Agent');
    const field = page.getByTestId('agent-permission-mode');
    await field.click();
    await page.getByTestId('agent-permission-mode-option-plan').click();
    const closedLabel = await field.inputValue();

    await field.click();
    const menu = page.getByTestId('agent-permission-mode-menu');
    await expect(menu).toBeVisible();
    const current = page.getByTestId('agent-permission-mode-option-plan');
    await expectOnlyCurrentRowChecked(menu, current);
    // The checked row is the one the closed field named.
    await expect(current).toHaveText(closedLabel);
  });
});

test('FontCombobox checks the current font', async () => {
  await withProjectPage(async (page) => {
    await openSettingsTab(page, 'Terminal');
    const field = page.locator('[data-testid="setting-row-terminal.fontFamily"] [data-testid="terminal-font-family"]');
    await field.click();
    await page.getByTestId('terminal-font-family-option-Consolas').click();
    await expect(field).toHaveValue('Consolas');

    await field.click();
    const menu = page.getByTestId('terminal-font-family-menu');
    await expect(menu).toBeVisible();
    const current = page.getByTestId('terminal-font-family-option-Consolas');
    await expectOnlyCurrentRowChecked(menu, current);
    await expect(current.locator('svg.lucide-check')).toHaveCount(1);
  });
});

test.describe('ModelCombobox', () => {
  async function openNewTaskModelMenu(
    page: Page,
    agentListOverrides: Record<string, unknown> = CLAUDE_MODELS,
  ): Promise<{ field: Locator; menu: Locator }> {
    await page.evaluate(async (overrides) => {
      const testWindow = window as unknown as {
        __mockAgentListOverrides?: Record<string, unknown>;
        __zustandStores?: { config: { getState: () => { loadAgentList: () => Promise<void> } } };
      };
      testWindow.__mockAgentListOverrides = overrides;
      await testWindow.__zustandStores?.config.getState().loadAgentList();
    }, agentListOverrides);
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    const field = page.locator('input[data-testid="task-model-override"]');
    await field.click();
    const menu = page.locator('[data-testid="task-model-override-menu"]');
    await expect(menu).toBeVisible();
    return { field, menu };
  }

  test('checks a picked model row after its 1M chip, and no row before a pick', async () => {
    await withProjectPage(async (page) => {
      const { field, menu } = await openNewTaskModelMenu(page);
      await expect(menu).toHaveAttribute('role', 'listbox');
      await expect(menu.locator('svg.lucide-check')).toHaveCount(0);

      await menu.locator('[data-model-option][data-model-id="claude-opus-5-5"]').click();
      await field.click();
      const current = menu.locator('[data-model-option][data-model-id="claude-opus-5-5"]');
      await expectOnlyCurrentRowChecked(menu, current);
      // The check closes the row, after the 1M chip, which is an option of its own and not selected.
      const row = current.locator('xpath=ancestor::*[@data-model-row][1]');
      await expect(row.locator('[data-model-1m]')).toHaveAttribute('aria-selected', 'false');
      const order = await row.evaluate((element) => {
        const chip = element.querySelector('[data-model-1m]');
        const check = element.querySelector('svg.lucide-check');
        return chip && check ? (chip.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : null;
      });
      expect(order, 'the check sits after the 1M chip').toBe(true);
    });
  });

  test('checks the 1M row when the 1M version is the value', async () => {
    await withProjectPage(async (page) => {
      const { field, menu } = await openNewTaskModelMenu(page);
      await menu.locator('[data-model-1m][data-model-id="claude-opus-5-5[1m]"]').click();
      await field.click();
      const chip = menu.locator('[data-model-1m][data-model-id="claude-opus-5-5[1m]"]');
      await expectOnlyCurrentRowChecked(menu, chip);
      await expect(menu.locator('[data-model-option][data-model-id="claude-opus-5-5"]')).toHaveAttribute('aria-selected', 'false');
    });
  });

  test('checks an alias row when an alias is the value', async () => {
    await withProjectPage(async (page) => {
      const { field, menu } = await openNewTaskModelMenu(page, CLAUDE_MODELS_WITH_ALIAS);
      await menu.locator('[data-model-option][data-model-alias="opus"]').click();
      await field.click();
      await expectOnlyCurrentRowChecked(menu, menu.locator('[data-model-option][data-model-alias="opus"]'));
    });
  });
});
