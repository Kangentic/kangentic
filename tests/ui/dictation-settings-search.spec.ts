/**
 * Settings search across the Dictation tab while dictation is off.
 *
 * `DictationTab` draws its Transcription card only while dictation is on
 * ("off means hidden, not greyed out"), but the settings registry still lists
 * that card's rows (Language, Punctuation and capitalization, Cloud endpoint)
 * under the Dictation tab. A search that matches only one of them switches to
 * the Dictation tab and then filters every card to the matching ids. The
 * Transcription card is not there to show, and the master card used to list
 * only the ids of its own rows, so the tab came up blank. The master card now
 * also lists the Transcription ids, so the search lands on the one control that
 * turns those settings on.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

// One query per Transcription row, each a term that only that row's registry
// entry carries (its label or a keyword), so the match cannot come from the
// master row or from another tab.
const TRANSCRIPTION_QUERIES = [
  { row: 'Language', query: 'multilingual' },
  { row: 'Punctuation and capitalization', query: 'punctuation' },
  { row: 'Cloud endpoint', query: 'openai' },
];

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
}
