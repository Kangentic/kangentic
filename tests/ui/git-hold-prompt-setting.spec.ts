/**
 * UI tests for the Git tab's "Hold prompt for script" switch
 * (`git.holdPromptForInitScript`, src/renderer/components/settings/tabs/GitTab.tsx).
 *
 * The switch decides whether a task's agent waits for the worktree's Post-worktree
 * script before it gets its first prompt. It means nothing without a script, so the
 * tab shows it only while the script field holds a non-blank script. Pinned here:
 *
 * 1. No script: the switch is absent, while the rest of the Worktrees card shows
 *    (so the absence is not just "the card is closed").
 * 2. A committed script makes the switch appear, on by default. Clearing the script
 *    hides it again.
 * 3. A whitespace-only script counts as no script (the `.trim()` in the gate).
 * 4. Toggling it writes `git.holdPromptForInitScript` through the project override
 *    (`config.setProjectOverridesByPath`) without dropping the script beside it.
 * 5. The off choice survives closing and reopening the settings panel.
 *
 * Each test owns its page, so a panel or draft left by one test cannot reach the next.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

const HOLD_SWITCH_TEST_ID = 'setting-row-git.holdPromptForInitScript';
const INIT_SCRIPT_ROW_TEST_ID = 'setting-row-git.initScript';
/** A sibling row inside the Worktrees card body, there whenever worktrees are on. */
const LINK_NODE_MODULES_TEST_ID = 'setting-row-git.linkNodeModules';
const SCRIPT = 'npm install';

type ProjectOverrideWriteCall = [string, { git?: { initScript?: string | null; holdPromptForInitScript?: boolean } }];

let browser: Browser;
let page: Page;

test.beforeEach(async () => {
  ({ browser, page } = await launchPage());
  await createProject(page, `git-hold-prompt-${Date.now()}`);
});

test.afterEach(async () => {
  await browser?.close();
});

/** Open Settings and land on the Git tab, waiting for the Worktrees card body. */
async function openGitTab(): Promise<void> {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-panel').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Git', exact: true }).click();
  await expect(page.getByTestId(INIT_SCRIPT_ROW_TEST_ID)).toBeVisible();
}

/** Type a script into the Post-worktree script field and commit it. Enter blurs the
 *  field, and the blur is the commit (SettingTextInput). */
async function commitInitScript(script: string): Promise<void> {
  const input = page.getByTestId(INIT_SCRIPT_ROW_TEST_ID).locator('input');
  await input.fill(script);
  await input.press('Enter');
}

/** Wraps `config.setProjectOverridesByPath` so a test can read what the switch wrote,
 *  without adding a call-log hook to the shared mock. Install it only once the page is
 *  quiet, so an earlier write cannot land in the log. */
async function installProjectOverrideWriteSpy(): Promise<void> {
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

async function lastProjectOverrideWrite(): Promise<ProjectOverrideWriteCall | undefined> {
  const calls = await page.evaluate(
    () => (window as unknown as { __projectOverrideWriteCalls?: unknown[][] }).__projectOverrideWriteCalls || [],
  );
  return calls[calls.length - 1] as ProjectOverrideWriteCall | undefined;
}

test.describe('Git tab: Hold prompt for script switch', () => {
  test('is absent while no Post-worktree script is set, though the Worktrees card is open', async () => {
    await openGitTab();

    await expect(page.getByTestId(INIT_SCRIPT_ROW_TEST_ID).locator('input')).toHaveValue('');
    // The card body is on screen (a sibling row is visible), so the missing switch
    // is the script gate and not a collapsed card.
    await expect(page.getByTestId(LINK_NODE_MODULES_TEST_ID)).toBeVisible();
    await expect(page.getByTestId(HOLD_SWITCH_TEST_ID)).toHaveCount(0);
  });

  test('appears, on by default, once a script is committed, and hides again when the script is cleared', async () => {
    await openGitTab();
    await expect(page.getByTestId(HOLD_SWITCH_TEST_ID)).toHaveCount(0);

    await commitInitScript(SCRIPT);

    const holdSwitch = page.getByTestId(HOLD_SWITCH_TEST_ID);
    await expect(holdSwitch).toBeVisible();
    // The shipped default holds the prompt, so a project with no override reads on.
    await expect(holdSwitch).toHaveAttribute('aria-checked', 'true');

    await commitInitScript('');
    await expect(holdSwitch).toHaveCount(0);
  });

  test('stays hidden for a whitespace-only script, which is no script', async () => {
    await openGitTab();
    await commitInitScript(SCRIPT);
    const holdSwitch = page.getByTestId(HOLD_SWITCH_TEST_ID);
    await expect(holdSwitch).toBeVisible();

    // Visible first, so the wait below is for the switch to LEAVE: it only goes if
    // the gate trims the script, and times out against a bare truthiness check.
    await commitInitScript('   ');
    await expect(holdSwitch).toHaveCount(0);
  });

  test('toggling it writes holdPromptForInitScript through the project override and keeps the script', async () => {
    await openGitTab();
    await commitInitScript(SCRIPT);
    const holdSwitch = page.getByTestId(HOLD_SWITCH_TEST_ID);
    await expect(holdSwitch).toHaveAttribute('aria-checked', 'true');
    await installProjectOverrideWriteSpy();

    await holdSwitch.click();

    await expect(holdSwitch).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await lastProjectOverrideWrite())?.[1].git).toEqual(
      expect.objectContaining({ holdPromptForInitScript: false, initScript: SCRIPT }),
    );

    // Back on writes the default value explicitly: the project's choice is the
    // override, so turning it back on must not leave the old `false` behind.
    await holdSwitch.click();

    await expect(holdSwitch).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await lastProjectOverrideWrite())?.[1].git).toEqual(
      expect.objectContaining({ holdPromptForInitScript: true, initScript: SCRIPT }),
    );
  });

  test('keeps the off choice and the script after the settings panel is closed and reopened', async () => {
    await openGitTab();
    await commitInitScript(SCRIPT);
    const holdSwitch = page.getByTestId(HOLD_SWITCH_TEST_ID);
    await installProjectOverrideWriteSpy();
    await holdSwitch.click();
    await expect(holdSwitch).toHaveAttribute('aria-checked', 'false');
    // Wait for the write to land before closing, so the reopen reads what was saved.
    await expect.poll(async () => (await lastProjectOverrideWrite())?.[1].git?.holdPromptForInitScript).toBe(false);

    await page.keyboard.press('Escape');
    await page.getByTestId('settings-panel').waitFor({ state: 'hidden', timeout: 5000 });

    await openGitTab();
    await expect(page.getByTestId(INIT_SCRIPT_ROW_TEST_ID).locator('input')).toHaveValue(SCRIPT);
    await expect(page.getByTestId(HOLD_SWITCH_TEST_ID)).toHaveAttribute('aria-checked', 'false');
  });
});
