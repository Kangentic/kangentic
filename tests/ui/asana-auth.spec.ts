import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

const SAMPLE_CLIENT_ID = '1208000000000001';
const SAMPLE_CLIENT_SECRET = 'this_is_a_sample_sixteen_char_secret';

/**
 * Seed the mock so the Asana app credentials are already stored (simulating
 * a user who completed the setup wizard earlier). Call BEFORE navigating into
 * the Asana provider to skip the wizard and land directly on the Connect step.
 */
async function preconfigureAsanaApp(
  page: Page,
  clientId = SAMPLE_CLIENT_ID,
  clientSecret = SAMPLE_CLIENT_SECRET,
): Promise<void> {
  await page.evaluate(({ id, secret }) => {
    (window as unknown as { __mockAsanaPreset?: unknown }).__mockAsanaPreset = {
      state: { clientId: id, clientSecret: secret, connected: false },
    };
  }, { id: clientId, secret: clientSecret });
}

async function openAsanaProvider(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.locator('[data-testid="add-import-source-btn"]').first().click();
  await page.getByRole('button', { name: /Asana/ }).click();
}

test.describe('Asana setup wizard (first-time)', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('selecting Asana with no credentials opens the setup dialog', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'asana-wizard-test');

    await openAsanaProvider(page);
    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="asana-setup-client-id-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="asana-setup-client-secret-input"]')).toBeVisible();

    await browser.close();
  });

  test('wizard rejects a non-numeric client ID with a clear error', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'asana-wizard-test');

    await openAsanaProvider(page);
    await page.locator('[data-testid="asana-setup-client-id-input"]').fill('not-a-real-id');
    await page.locator('[data-testid="asana-setup-client-secret-input"]').fill(SAMPLE_CLIENT_SECRET);
    await page.locator('[data-testid="asana-setup-save-btn"]').click();

    const error = page.locator('[data-testid="asana-setup-error"]');
    await expect(error).toBeVisible();
    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('wizard rejects missing client secret on first-time setup', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'asana-wizard-test');

    await openAsanaProvider(page);
    await page.locator('[data-testid="asana-setup-client-id-input"]').fill(SAMPLE_CLIENT_ID);
    // Leave secret blank.
    await page.locator('[data-testid="asana-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="asana-setup-error"]')).toContainText(/secret/i);
    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('saving valid credentials closes the wizard and reveals the Connect button', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'asana-wizard-test');

    await openAsanaProvider(page);
    await page.locator('[data-testid="asana-setup-client-id-input"]').fill(SAMPLE_CLIENT_ID);
    await page.locator('[data-testid="asana-setup-client-secret-input"]').fill(SAMPLE_CLIENT_SECRET);
    await page.locator('[data-testid="asana-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="asana-connect-btn"]')).toBeVisible();

    await browser.close();
  });

  test('client secret visibility toggle switches the input type', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'asana-wizard-test');

    await openAsanaProvider(page);
    const secretInput = page.locator('[data-testid="asana-setup-client-secret-input"]');
    await expect(secretInput).toHaveAttribute('type', 'password');

    await page.locator('[data-testid="asana-setup-toggle-secret-btn"]').click();
    await expect(secretInput).toHaveAttribute('type', 'text');

    await page.locator('[data-testid="asana-setup-toggle-secret-btn"]').click();
    await expect(secretInput).toHaveAttribute('type', 'password');

    await browser.close();
  });
});

test.describe('Asana auth phase in ImportPopover (app credentials already set)', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('selecting Asana with saved credentials jumps straight to the Connect step', async () => {
    const { browser, page } = await launchPage();
    await preconfigureAsanaApp(page);
    await createProject(page, 'asana-auth-test');

    await openAsanaProvider(page);
    await expect(page.locator('[data-testid="asana-connect-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeHidden();

    await browser.close();
  });

  test('Reconfigure re-opens the wizard pre-filled with the current client_id and secret placeholder', async () => {
    const { browser, page } = await launchPage();
    await preconfigureAsanaApp(page, '1208111111111111', SAMPLE_CLIENT_SECRET);
    await createProject(page, 'asana-auth-test');

    await openAsanaProvider(page);
    await page.locator('[data-testid="asana-reconfigure-btn"]').click();

    const idInput = page.locator('[data-testid="asana-setup-client-id-input"]');
    await expect(idInput).toBeVisible();
    await expect(idInput).toHaveValue('1208111111111111');

    const secretInput = page.locator('[data-testid="asana-setup-client-secret-input"]');
    await expect(secretInput).toHaveAttribute('placeholder', /stored/i);

    await browser.close();
  });

  test('successful OAuth flow advances to the URL phase', async () => {
    const { browser, page } = await launchPage();
    await preconfigureAsanaApp(page);
    await createProject(page, 'asana-auth-test');

    await openAsanaProvider(page);
    await page.locator('[data-testid="asana-connect-btn"]').click();
    await expect(page.locator('[data-testid="asana-auth-code-input"]')).toBeVisible();

    await page.locator('[data-testid="asana-auth-code-input"]').fill('mock-code-abc');
    await page.locator('[data-testid="asana-auth-continue-btn"]').click();

    await expect(page.locator('[data-testid="import-source-url-input"]')).toBeVisible();

    await browser.close();
  });

  test('invalid auth code surfaces a readable error without advancing', async () => {
    const { browser, page } = await launchPage();
    await page.evaluate((secret) => {
      (window as unknown as { __mockAsanaPreset?: unknown }).__mockAsanaPreset = {
        state: { clientId: '1208000000000001', clientSecret: secret, connected: false },
        invalidCode: 'nope',
      };
    }, SAMPLE_CLIENT_SECRET);
    await createProject(page, 'asana-auth-test');

    await openAsanaProvider(page);
    await page.locator('[data-testid="asana-connect-btn"]').click();
    await page.locator('[data-testid="asana-auth-code-input"]').fill('nope');
    await page.locator('[data-testid="asana-auth-continue-btn"]').click();

    const error = page.locator('[data-testid="asana-auth-error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText(/invalid/i);

    await expect(page.locator('[data-testid="import-auth-phase"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-source-url-input"]')).toBeHidden();

    await browser.close();
  });
});
