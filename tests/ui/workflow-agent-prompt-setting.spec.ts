/**
 * Settings > Workflows > Workflow agent prompt (#732, board 5b): a fixed-height
 * field holding the whole first message, saved when it loses focus, with Reset
 * to default; and Expand, a larger editor that edits a copy (Save writes it,
 * Cancel throws it away, a close gesture with edits asks first).
 *
 * Each test launches its own page (mode: 'parallel'), so no test leans on
 * another's state.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

const FIELD = '[data-testid="workflow-agent-prompt"]';
const DIALOG = '[data-testid="workflow-agent-prompt-dialog"]';
const DIALOG_FIELD = '[data-testid="workflow-agent-prompt-dialog-field"]';

async function openWorkflowsTab(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await expect(page.locator(FIELD)).toBeVisible({ timeout: 3000 });
}

async function storedPrompt(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const config = await window.electronAPI.config.getGlobal();
    return config.workflows?.agentPrompt ?? null;
  });
}

test('the field shows the default, saves an edit on blur, and resets to the default', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `WorkflowPrompt ${Date.now()}`);
    await openWorkflowsTab(page);
    const field = page.locator(FIELD);
    await expect(field).toHaveValue(/^<workflow_request>/);
    await expect(field).toHaveValue(/\{\{brief_xml\}\}/);
    expect(await storedPrompt(page)).toBeNull();

    await field.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nKeep it to three tasks.');
    // Nothing is written while typing.
    expect(await storedPrompt(page)).toBeNull();
    await page.locator('[data-testid="settings-card-workflow-agent-prompt"] h3').click();
    await expect.poll(() => storedPrompt(page)).toContain('Keep it to three tasks.');

    await page.locator('[data-testid="workflow-agent-prompt-reset"]').click();
    await expect.poll(() => storedPrompt(page)).toBeNull();
    await expect(field).not.toHaveValue(/Keep it to three tasks\./);
  } finally {
    await browser.close();
  }
});

test('clearing the field shows the default again, which is what a blank prompt sends', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `WorkflowPromptClear ${Date.now()}`);
    await openWorkflowsTab(page);
    const field = page.locator(FIELD);
    const heading = page.locator('[data-testid="settings-card-workflow-agent-prompt"] h3');

    // Holding the default, nothing was stored: the blank below saves as unset
    // again, so the stored text never changes and nothing remounts the field.
    await expect(field).toHaveValue(/^<workflow_request>/);
    expect(await storedPrompt(page)).toBeNull();
    await field.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await expect(field).toHaveValue('');

    await heading.click();
    await expect(field).toHaveValue(/^<workflow_request>/);
    await expect(field).toHaveValue(/\{\{brief_xml\}\}/);
    expect(await storedPrompt(page)).toBeNull();

    // An edited prompt that is then cleared lands in the same place: the default.
    await field.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nKeep it to three tasks.');
    await heading.click();
    await expect.poll(() => storedPrompt(page)).toContain('Keep it to three tasks.');
    await field.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await heading.click();
    await expect.poll(() => storedPrompt(page)).toBeNull();
    await expect(field).toHaveValue(/^<workflow_request>/);
    await expect(field).not.toHaveValue(/Keep it to three tasks\./);
  } finally {
    await browser.close();
  }
});

test('Template variable offers the workflow agent\'s variables only', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `WorkflowPromptVars ${Date.now()}`);
    await openWorkflowsTab(page);
    await page.locator('[data-testid="workflow-agent-prompt-variable-trigger"]').click();
    const menu = page.locator('[data-testid="workflow-agent-prompt-variable-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('{{columns}}');
    await expect(menu).toContainText('{{brief_xml}}');
    await expect(menu).toContainText('{{projectName}}');
    await expect(menu).not.toContainText('{{title}}');
    await expect(menu).not.toContainText('{{agentReply}}');
  } finally {
    await browser.close();
  }
});

test('Expand edits a copy: Cancel keeps the setting, a close with edits asks, Save writes it', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `WorkflowPromptExpand ${Date.now()}`);
    await openWorkflowsTab(page);

    // The button says what it opens on hover (board 5b).
    await expect(page.locator('[data-testid="workflow-agent-prompt-expand"]')).toHaveAccessibleDescription('Expand the prompt');

    // Cancel throws the copy away.
    await page.locator('[data-testid="workflow-agent-prompt-expand"]').click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.locator(DIALOG_FIELD).fill('Plan it small.');
    await page.locator('[data-testid="workflow-agent-prompt-dialog-cancel"]').click();
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(await storedPrompt(page)).toBeNull();

    // Escape with edits asks before discarding; Keep editing returns to the copy.
    await page.locator('[data-testid="workflow-agent-prompt-expand"]').click();
    await page.locator(DIALOG_FIELD).fill('Plan it small, {{projectName}}.');
    await page.keyboard.press('Escape');
    await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator(DIALOG_FIELD)).toHaveValue('Plan it small, {{projectName}}.');

    // Save writes it, and the card's field shows it.
    await page.locator('[data-testid="workflow-agent-prompt-dialog-save"]').click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect.poll(() => storedPrompt(page)).toBe('Plan it small, {{projectName}}.');
    await expect(page.locator(FIELD)).toHaveValue('Plan it small, {{projectName}}.');
    // The Settings panel underneath stayed open through all of it.
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  } finally {
    await browser.close();
  }
});
