/**
 * Settings search across the Dictation tab, with dictation off and on.
 *
 * `DictationTab` draws its Transcription card only while dictation is on
 * ("off means hidden, not greyed out"), but the settings registry still lists
 * that card's rows (Language, Punctuation and capitalization, Cloud endpoint)
 * under the Dictation tab. A search that matches only one of them switches to
 * the Dictation tab and then filters every card to the matching ids.
 *
 * While dictation is OFF the Transcription card is not there to show, and the
 * master card used to list only the ids of its own rows, so the tab came up
 * blank. The master card now also lists the Transcription ids, so the search
 * lands on the one control that turns those settings on.
 *
 * While dictation is ON the Transcription card is drawn and answers for its own
 * settings. The master card must then leave those ids out, or a search for
 * "multilingual" would show the Voice dictation card as well, whose rows have
 * nothing to do with it.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, gotoVite, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');

// One query per Transcription row, each a term that only that row's registry
// entry carries (its label or a keyword), so the match cannot come from the
// master row or from another tab.
const TRANSCRIPTION_QUERIES = [
  { row: 'Language', query: 'multilingual' },
  { row: 'Punctuation and capitalization', query: 'punctuation' },
  { row: 'Cloud endpoint', query: 'openai' },
];

/** A fresh browser with dictation already switched on, as an install that has
 *  turned it on starts. The mock carries no dictation defaults, so the whole
 *  `dictation` override is just the switch. */
async function launchWithDictationOn(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript((config: Record<string, unknown>) => {
    (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = config;
  }, { dictation: { enabled: true } });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await gotoVite(page);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

for (const { row, query } of TRANSCRIPTION_QUERIES) {
  test(`a search for the ${row} row finds the Dictation switch while dictation is off`, async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `Dictation Search Test ${Date.now()}`);
      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      await page.getByTestId('settings-search').fill(query);

      // The master card is what the query lands on, and dictation is off: the
      // Transcription card is not drawn, so this is the only card on the tab.
      const master = page.getByTestId('settings-card-dictation.enabled');
      await expect(master).toBeVisible();
      await expect(page.getByRole('switch', { name: 'Voice dictation' })).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByTestId('dictation-language-select')).toHaveCount(0);
      await expect(page.getByText('No settings found')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test(`a search for the ${row} row finds the Transcription card, not the Voice dictation card, while dictation is on`, async () => {
    const { browser, page } = await launchWithDictationOn();
    try {
      await createProject(page, `Dictation Search Test ${Date.now()}`);
      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      await page.getByTestId('settings-search').fill(query);

      // The Transcription card answers for its own setting. It is drawn only
      // while dictation is on, so this also proves the launch really has it on.
      await expect(page.getByRole('region', { name: 'Transcription' })).toBeVisible();
      // The master card lists none of the Transcription ids now, and its own
      // rows do not match this query, so it is not drawn at all. Playwright
      // retries this until the filter has applied, and the Transcription card
      // above is already showing, so the search has landed by the time it runs.
      await expect(page.getByTestId('settings-card-dictation.enabled')).toHaveCount(0);
      await expect(page.getByRole('switch', { name: 'Voice dictation' })).toHaveCount(0);
      await expect(page.getByText('No settings found')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
}
