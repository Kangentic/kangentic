/**
 * Coverage for the SettingTextInput commit boundary (src/renderer/components/settings/shared.tsx):
 * a settings text field now commits on blur, Enter, or unmount, never per keystroke.
 *
 * The headline case, and the reason this file exists: a value typed into the field and NEVER
 * blurred must still persist when the settings panel closes. React fires no blur when a focused
 * input unmounts, so before the unmount-flush fix the edit was silently discarded - a regression
 * against the old per-keystroke fields, which wrote on every change and so had nothing to lose on
 * unmount. Two close paths reach it and neither blurs: Escape (SettingsPanelShell's document
 * keydown -> requestClose, which unmounts the panel after its exit animation) and the
 * settings.toggle shortcut (AppLayout's `setSettingsOpen(false)`, which skips the exit animation
 * and unmounts immediately). Both are pinned below as separate cases, since either close path
 * could independently regress.
 *
 * Both headline cases also assert a SECOND, unrelated override survives the same close
 * (`git.worktreesEnabled`). `updateProjectOverride`'s write REPLACES the project's whole overrides
 * object wholesale (`config.setProjectOverridesByPath`), merged client-side over whatever
 * `projectOverrides` the store currently holds - and closing the panel nulls that same store field
 * in the same synchronous update that unmounts the field. A fix that rescues `projectSettingsPath`
 * but merges the flushed edit over an now-empty `projectOverrides` would silently WIPE every other
 * override the project had, which a test asserting only on `initScript` would not catch.
 *
 * Each test owns its own page (mirrors settings-write-failure-toast.spec.ts): no state is shared
 * across cases, so a page carrying a leftover open panel or dirty draft from one test can never
 * bleed into the next.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Page } from '@playwright/test';

/** Open the Settings panel via the title-bar gear. With a project open this also sets
 *  `projectSettingsPath`, which the project-scoped write path needs. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByTestId('settings-tab-list').getByRole('button', { name, exact: true }).click();
}

/**
 * Wraps `config.setProjectOverridesByPath` so a test can assert exactly what (and how many
 * times) it was called, without adding a new call-log hook to the shared mock file. Installed
 * AFTER the settings panel is already open, since the panel's own project-open plumbing does
 * not itself call this method.
 */
async function installProjectOverrideWriteSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as {
      electronAPI: { config: { setProjectOverridesByPath: (...args: unknown[]) => Promise<unknown> } };
    }).electronAPI;
    const original = api.config.setProjectOverridesByPath.bind(api.config);
    (window as unknown as { __projectOverrideWriteCalls: unknown[][] }).__projectOverrideWriteCalls = [];
    api.config.setProjectOverridesByPath = async (...args: unknown[]) => {
      (window as unknown as { __projectOverrideWriteCalls: unknown[][] }).__projectOverrideWriteCalls.push(args);
      return original(...args);
    };
  });
}

async function getProjectOverrideWriteCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(
    () => (window as unknown as { __projectOverrideWriteCalls?: unknown[][] }).__projectOverrideWriteCalls || [],
  );
}

/** Directly mutate the config store's `projectOverrides`, standing in for a config value
 *  landing from elsewhere (a project switch, another window's write) while the field is
 *  focused - the UI tier has no second window to drive a real cross-window write. */
async function setProjectOverrideGitInitScriptExternally(page: Page, value: string): Promise<void> {
  await page.evaluate((externalValue) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        config: {
          getState: () => { projectOverrides: { git?: Record<string, unknown> } | null };
          setState: (partial: { projectOverrides: Record<string, unknown> }) => void;
        };
      };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    const current = stores.config.getState().projectOverrides || {};
    stores.config.setState({
      projectOverrides: {
        ...current,
        git: { ...(current.git || {}), initScript: externalValue },
      },
    });
  }, value);
}

test.describe('SettingTextInput commit boundary', () => {
  test('an edit that is never blurred still persists when the panel closes via Escape, alongside an earlier unrelated override', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `setting-text-unmount-escape-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Git');

      // An earlier, already-committed override under the SAME top-level `git` key.
      // `setProjectOverridesByPath` replaces the project's overrides object wholesale,
      // so this is what proves the flush merges onto the project's OTHER settings
      // rather than onto an empty object.
      const worktreesToggle = page.getByTestId('setting-row-git.worktreesEnabled');
      await worktreesToggle.click();
      await expect(worktreesToggle).toHaveAttribute('aria-checked', 'false');

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.type('npm run build', { delay: 20 });
      // Deliberately no blur and no Enter: the whole point is that React unmounts the
      // still-focused input with no blur event, so the persisted value can only come from
      // the input's own unmount-flush effect.

      await page.keyboard.press('Escape');
      // Escape starts the exit animation; the panel unmounts only once it finishes, so this
      // is a real condition to poll for, not a fixed wait.
      await page.locator('[data-testid="settings-panel"]').waitFor({ state: 'hidden', timeout: 5000 });

      await openSettings(page);
      await openTab(page, 'Git');
      await expect(page.getByTestId('setting-row-git.initScript').locator('input')).toHaveValue('npm run build');
      await expect(page.getByTestId('setting-row-git.worktreesEnabled')).toHaveAttribute('aria-checked', 'false');
    } finally {
      await browser.close();
    }
  });

  test('an edit that is never blurred still persists when the panel closes via the settings.toggle shortcut, alongside an earlier unrelated override', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `setting-text-unmount-shortcut-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Git');

      const worktreesToggle = page.getByTestId('setting-row-git.worktreesEnabled');
      await worktreesToggle.click();
      await expect(worktreesToggle).toHaveAttribute('aria-checked', 'false');

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.type('npm run lint', { delay: 20 });

      // Mod+Shift+S (Ctrl on this non-mac mock platform) calls setSettingsOpen(false)
      // directly, which unmounts the panel with NO exit animation at all.
      await page.keyboard.press('Control+Shift+S');
      await page.locator('[data-testid="settings-panel"]').waitFor({ state: 'hidden', timeout: 5000 });

      await openSettings(page);
      await openTab(page, 'Git');
      await expect(page.getByTestId('setting-row-git.initScript').locator('input')).toHaveValue('npm run lint');
      await expect(page.getByTestId('setting-row-git.worktreesEnabled')).toHaveAttribute('aria-checked', 'false');
    } finally {
      await browser.close();
    }
  });

  test('Enter commits the edit without an explicit blur', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `setting-text-enter-commits-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Git');
      await installProjectOverrideWriteSpy(page);

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.type('npm ci', { delay: 20 });
      await initScript.press('Enter');

      await expect.poll(async () => (await getProjectOverrideWriteCalls(page)).length).toBeGreaterThan(0);
      const calls = await getProjectOverrideWriteCalls(page);
      const lastCall = calls[calls.length - 1] as [string, { git?: { initScript?: string } }];
      expect(lastCall[1].git?.initScript).toBe('npm ci');
    } finally {
      await browser.close();
    }
  });

  test('a blur with no edit writes nothing', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `setting-text-blur-no-edit-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Git');
      await installProjectOverrideWriteSpy(page);

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.blur();

      // Intentional fixed budget - we cannot poll for "nothing happens". Gives any errant
      // write a chance to land before asserting its absence.
      await page.waitForTimeout(500);
      expect(await getProjectOverrideWriteCalls(page)).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('git.copyFiles splits, trims, and filters at the commit', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `setting-text-copyfiles-commit-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Git');
      await installProjectOverrideWriteSpy(page);

      const copyFiles = page.getByTestId('setting-row-git.copyFiles').locator('input');
      await copyFiles.click();
      await copyFiles.fill('.env, , .env.local');
      await copyFiles.blur();

      await expect.poll(async () => (await getProjectOverrideWriteCalls(page)).length).toBeGreaterThan(0);
      const calls = await getProjectOverrideWriteCalls(page);
      const lastCall = calls[calls.length - 1] as [string, { git?: { copyFiles?: string[] } }];
      expect(lastCall[1].git?.copyFiles).toEqual(['.env', '.env.local']);
    } finally {
      await browser.close();
    }
  });

  test('an external config change mid-edit does not clobber the draft, and the users edit still wins on blur', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `setting-text-external-change-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Git');
      await installProjectOverrideWriteSpy(page);

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.fill('user-typed-value');

      await setProjectOverrideGitInitScriptExternally(page, 'external-change');

      // The draft is untouched: a config value landing while the field is focused must not
      // overwrite what the user is mid-typing (the focus-gated resync in the useEffect).
      await expect(initScript).toHaveValue('user-typed-value');

      await initScript.blur();
      await expect.poll(async () => (await getProjectOverrideWriteCalls(page)).length).toBeGreaterThan(0);
      const calls = await getProjectOverrideWriteCalls(page);
      const lastCall = calls[calls.length - 1] as [string, { git?: { initScript?: string } }];
      // The user's edit reaches the write, not the external value that raced it.
      expect(lastCall[1].git?.initScript).toBe('user-typed-value');
    } finally {
      await browser.close();
    }
  });
});
