/**
 * UI tests for the display language (GitHub #489): Settings > Language, the
 * restart prompt a change asks through, and the one-time first-launch toast that
 * offers the OS language. docs/architecture/i18n.md has the design.
 *
 * The mock stands in for main: `language.getInfo()` lists
 * `window.__mockShippedLocales` (English alone by default, as SHIPPED_LOCALES is
 * today) and offers `window.__mockLanguageSuggestion` until config records an
 * answer, and `setLanguageAndRestart` records each call in
 * `window.__mockLanguageRestartRequests` and applies main's config write. The
 * zh-CN strings asserted below are the design's own, seeded in
 * src/locales/zh-CN/language.po.
 *
 * Every launch skips seeding a project: the Language tab is a system tab and
 * renders with no project open, and an open project raises the onboarding
 * checklist, whose backdrop takes the clicks.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

interface LaunchOptions {
  shippedLocales?: string[];
  /** The OS language main would offer; only shown while config has not answered. */
  suggestion?: string;
  /** The session's language (config `displayLanguage`), which the mock boots in. */
  displayLanguage?: string;
  restartRejects?: boolean;
}

async function launch(options: LaunchOptions = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockShippedLocales = ${JSON.stringify(options.shippedLocales ?? ['en'])};
    window.__mockLanguageSuggestion = ${JSON.stringify(options.suggestion ?? null)};
    window.__mockLanguageRestartRejects = ${options.restartRejects === true};
    window.__mockPreConfigure(function (state) {
      state.config.displayLanguage = ${JSON.stringify(options.displayLanguage ?? 'en')};
      state.config.hasAnsweredLanguageSuggestion = ${options.suggestion ? 'false' : 'true'};
      state.config.onboardedProjectIds = [];
      return {};
    });
  `);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/** Opens the settings panel on the Language tab, the way a toast action does. */
async function openLanguageTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => Record<string, unknown> } };
    }).__zustandStores;
    const state = stores.config.getState();
    (state.setLastSettingsTab as (tab: string) => void)('language');
    (state.setSettingsOpen as (open: boolean) => void)(true);
  });
  await expect(page.getByTestId('setting-row-displayLanguage')).toBeVisible();
}

async function openPicker(page: Page): Promise<void> {
  await page.getByTestId('setting-row-displayLanguage').getByRole('button', { name: 'Open dropdown' }).click();
  await expect(page.getByTestId('display-language-menu')).toBeVisible();
}

const restartRequests = (page: Page) => page.evaluate(
  () => (window as unknown as { __mockLanguageRestartRequests?: string[] }).__mockLanguageRestartRequests ?? [],
);

const languageGetInfoCalls = (page: Page) => page.evaluate(
  () => (window as unknown as { __mockLanguageGetInfoCalls?: number }).__mockLanguageGetInfoCalls ?? 0,
);

/** Lets two animation frames pass, so React has committed whatever an event or a settled promise queued. */
const flushFrames = (page: Page) => page.evaluate(
  () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }),
);

const answeredSuggestion = (page: Page) => page.evaluate(async () => {
  const config = await window.electronAPI.config.getGlobal();
  return (config as { hasAnsweredLanguageSuggestion?: boolean }).hasAnsweredLanguageSuggestion;
});

test.describe('Settings > Language', () => {
  test('is the first System tab, with the Languages icon', async () => {
    const { browser, page } = await launch();
    try {
      await openLanguageTab(page);
      const tabIds = await page.getByTestId('settings-tab-list').locator('[data-testid^="settings-tab-"]')
        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-testid')));
      // With no project open, the list is the System group alone, and Language leads it.
      expect(tabIds[0]).toBe('settings-tab-language');
      expect(tabIds.indexOf('settings-tab-language')).toBeLessThan(tabIds.indexOf('settings-tab-board'));
      await expect(page.getByTestId('settings-tab-language').locator('svg.lucide-languages')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('holds one Display language card with one Language row', async () => {
    const { browser, page } = await launch();
    try {
      await openLanguageTab(page);
      const card = page.getByRole('region', { name: 'Display language' });
      await expect(card).toContainText('The language of menus, settings and dialogs.');
      await expect(card.getByTestId('setting-row-displayLanguage')).toContainText('Language');
      await expect(page.getByTestId('display-language')).toHaveValue('English');
    } finally {
      await browser.close();
    }
  });

  test('lists each shipped language by its own name and code, and checks the current one', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN', 'fr'] });
    try {
      await openLanguageTab(page);
      await openPicker(page);
      // While the menu is open, the field shows its placeholder.
      await expect(page.getByTestId('display-language')).toHaveValue('');
      await expect(page.getByTestId('display-language')).toHaveAttribute('placeholder', 'Select display language');

      const menu = page.getByTestId('display-language-menu');
      await expect(menu).toHaveAttribute('role', 'listbox');
      const options = menu.getByRole('option');
      await expect(options).toHaveText(['English (en)', '中文(简体) (zh-cn)', 'Français (fr)']);

      const english = page.getByTestId('display-language-option-en');
      await expect(english).toHaveAttribute('aria-selected', 'true');
      await expect(english.locator('svg.lucide-check')).toHaveCount(1);
      const french = page.getByTestId('display-language-option-fr');
      await expect(french).toHaveAttribute('aria-selected', 'false');
      await expect(french.locator('svg.lucide-check')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('filters on the code as well as the name', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN', 'zh-TW', 'fr'] });
    try {
      await openLanguageTab(page);
      await page.getByTestId('display-language').fill('zh');
      await expect(page.getByTestId('display-language-menu').getByRole('option')).toHaveText([
        '中文(简体) (zh-cn)',
        '中文(繁體) (zh-tw)',
      ]);
    } finally {
      await browser.close();
    }
  });

  test('filters on the parenthesised code, which only the option detail carries', async () => {
    // '(zh' is in no label ('English', 'Français', the Chinese names) and in no
    // option value ('zh-CN'), so only the detail clause of Combobox's filter
    // ('(zh-cn)', '(zh-tw)') can keep these two rows.
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN', 'zh-TW', 'fr'] });
    try {
      await openLanguageTab(page);
      await page.getByTestId('display-language').fill('(zh');
      await expect(page.getByTestId('display-language-menu').getByRole('option')).toHaveText([
        '中文(简体) (zh-cn)',
        '中文(繁體) (zh-tw)',
      ]);
    } finally {
      await browser.close();
    }
  });

  test('picking another language asks to restart, named in its own name, and Cancel changes nothing', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'fr'] });
    try {
      await openLanguageTab(page);
      await openPicker(page);
      await page.getByTestId('display-language-option-fr').click();

      const dialog = page.getByTestId('language-restart-confirm');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Switch to Français?');
      await expect(dialog).toContainText('Kangentic restarts to change the language.');
      await expect(dialog.locator('svg.lucide-rotate-cw')).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('display-language')).toHaveValue('English');
      expect(await restartRequests(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('Restart now saves the language and restarts in one call', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'fr'] });
    try {
      await openLanguageTab(page);
      await openPicker(page);
      await page.getByTestId('display-language-option-fr').click();
      await page.getByTestId('language-restart-confirm').getByRole('button', { name: 'Restart now' }).click();

      await expect(page.getByTestId('language-restart-confirm')).toHaveCount(0);
      await expect.poll(() => restartRequests(page)).toEqual(['fr']);
    } finally {
      await browser.close();
    }
  });

  test('a second confirm while the restart is still pending reaches main once', async () => {
    // ConfirmDialog confirms on Enter and its buttons are never disabled, so
    // useLanguageRestart guards with restartInFlightRef: a second confirm before
    // the first setLanguageAndRestart call settles must return early rather than
    // ask main to save and restart twice. The mock's hold keeps the first call
    // pending, so the dialog is still up (LanguageTab clears pendingLocale only
    // when a call settles) when the second confirm arrives.
    const { browser, page } = await launch({ shippedLocales: ['en', 'fr'] });
    try {
      await openLanguageTab(page);
      await openPicker(page);
      await page.getByTestId('display-language-option-fr').click();
      const dialog = page.getByTestId('language-restart-confirm');
      await expect(dialog).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as { __mockLanguageRestartHold?: boolean }).__mockLanguageRestartHold = true;
      });
      const restartButton = dialog.getByRole('button', { name: 'Restart now' });

      await restartButton.click();
      await expect.poll(() => restartRequests(page)).toEqual(['fr']);
      // The first call is held, so the dialog is still up: exactly the double
      // confirm the guard exists for.
      await expect(dialog).toBeVisible();

      // Enter is handled by ConfirmDialog's capture-phase document listener.
      // The guarded call returns at once, which settles LanguageTab's `.finally`
      // and closes the dialog, so there is no second click to make after it.
      await page.keyboard.press('Enter');
      // The guard is a synchronous early return, so a missing guard has already
      // pushed its second request by now. The frames only let React commit.
      await flushFrames(page);
      expect(
        await restartRequests(page),
        'a second confirm while the first restart call is pending must not reach main again',
      ).toEqual(['fr']);

      // Releasing settles every held call, so a call the guard let through would
      // show up in the exact list as well.
      await page.evaluate(() => {
        const release = (window as unknown as { __mockLanguageRestartHoldRelease?: () => void })
          .__mockLanguageRestartHoldRelease;
        if (release) release();
      });
      await expect(dialog).toHaveCount(0);
      expect(await restartRequests(page)).toEqual(['fr']);
    } finally {
      await browser.close();
    }
  });

  test('says so when the restart fails', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'fr'], restartRejects: true });
    try {
      await openLanguageTab(page);
      await openPicker(page);
      await page.getByTestId('display-language-option-fr').click();
      await page.getByTestId('language-restart-confirm').getByRole('button', { name: 'Restart now' }).click();

      const failureToast = page.getByTestId('toast').filter({ hasText: "Couldn't restart" });
      await expect(failureToast).toHaveCount(1);
      await expect(failureToast.getByTestId('toast-body')).toHaveText('Restart Kangentic to apply the change.');
      await expect(page.getByTestId('display-language')).toHaveValue('English');
    } finally {
      await browser.close();
    }
  });

  test('picking the current language asks nothing', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'fr'] });
    try {
      await openLanguageTab(page);
      await openPicker(page);
      await page.getByTestId('display-language-option-en').click();
      await expect(page.getByTestId('display-language-menu')).toBeHidden();
      await expect(page.getByTestId('language-restart-confirm')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('settings search finds the row by its card and its keywords', async () => {
    const { browser, page } = await launch();
    try {
      await openLanguageTab(page);
      await page.getByTestId('settings-search').fill('display language');
      await expect(page.getByTestId('setting-row-displayLanguage')).toBeVisible();
      await expect(page.getByTestId('settings-search-count-language')).toHaveText('1');
    } finally {
      await browser.close();
    }
  });
});

test.describe('the first-launch language suggestion', () => {
  test('offers the OS language in that language, with the question in English beneath', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN'], suggestion: 'zh-CN' });
    try {
      const toast = page.getByTestId('toast').filter({ hasText: '中文(简体)' });
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('将显示语言更改为中文(简体)?');
      await expect(toast.getByTestId('toast-body')).toHaveText('Change the display language to 中文(简体)?');
      const action = toast.getByTestId('toast-action');
      await expect(action).toHaveText('更改并重启');
      await expect(action.locator('svg.lucide-rotate-cw')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('its button opens the restart prompt in the OS language, and Cancel records the answer', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN'], suggestion: 'zh-CN' });
    try {
      await page.getByTestId('toast').getByTestId('toast-action').click();
      const dialog = page.getByTestId('language-suggestion-confirm');
      await expect(dialog).toContainText('切换到中文(简体)?');
      await expect(dialog).toContainText('Kangentic 将重启以更改语言。');
      await expect(dialog.getByRole('button', { name: '立即重启' })).toBeVisible();
      await dialog.getByRole('button', { name: '取消' }).click();

      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('toast').filter({ hasText: '中文(简体)' })).toHaveCount(0);
      await expect.poll(() => answeredSuggestion(page)).toBe(true);
      expect(await restartRequests(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('Restart now from its prompt switches to the OS language', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN'], suggestion: 'zh-CN' });
    try {
      await page.getByTestId('toast').getByTestId('toast-action').click();
      await page.getByTestId('language-suggestion-confirm').getByRole('button', { name: '立即重启' }).click();
      await expect.poll(() => restartRequests(page)).toEqual(['zh-CN']);
      await expect.poll(() => answeredSuggestion(page)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('closing it records the answer, so it never asks again', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN'], suggestion: 'zh-CN' });
    try {
      const toast = page.getByTestId('toast').filter({ hasText: '中文(简体)' });
      await toast.getByTestId('toast-dismiss').click();
      await expect(toast).toHaveCount(0);
      await expect.poll(() => answeredSuggestion(page)).toBe(true);
      const info = await page.evaluate(() => window.electronAPI.language.getInfo());
      expect(info.suggestion).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('raises nothing when there is no language to offer', async () => {
    const { browser, page } = await launch();
    try {
      await expect(page.getByTestId('settings-button')).toBeVisible();
      // The count of getInfo calls is read before this test calls getInfo or opens
      // Settings (whose Language tab asks too), so a call here is LanguageSuggestion
      // asking main whether there is a language to offer. Without this the assertion
      // below holds for a component that never asked at all.
      await expect.poll(() => languageGetInfoCalls(page)).toBeGreaterThanOrEqual(1);
      // A toast would rise after that answer is awaited. Let it settle and commit.
      await flushFrames(page);
      await expect(page.getByTestId('toast')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('a session in another language', () => {
  test('marks the document with its language and draws the restart prompt in it', async () => {
    const { browser, page } = await launch({ shippedLocales: ['en', 'zh-CN'], displayLanguage: 'zh-CN' });
    try {
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
      await openLanguageTab(page);
      await expect(page.getByTestId('display-language')).toHaveValue('中文(简体)');
      await openPicker(page);
      await page.getByTestId('display-language-option-en').click();
      const dialog = page.getByTestId('language-restart-confirm');
      await expect(dialog).toContainText('切换到English?');
      await expect(dialog.getByRole('button', { name: '立即重启' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
