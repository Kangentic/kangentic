/**
 * The Notifications tab: what only a browser proves. The sound picker portals past
 * the settings body's clip, takes Escape before the panel does, and each visible
 * state of an event row. The writes and the mute rules are unit-tested.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { launchPage, createProject } from './helpers';

let browser: Browser;
let page: Page;

test.beforeEach(async () => {
  const launched = await launchPage();
  browser = launched.browser;
  page = launched.page;
  await createProject(page, `Notifications ${Date.now()}`);
  await page.locator('[data-testid="settings-button"]').click();
  await page.getByTestId('settings-tab-notifications').click();
  await expect(page.getByTestId('setting-row-notifications.onAgentIdle')).toBeVisible();
});

test.afterEach(async () => {
  await browser.close();
});

const trigger = () => page.getByTestId('notify-sound-onAgentIdle');
const menu = () => page.getByTestId('notify-sound-menu-onAgentIdle');
const savedNotifications = () => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).notifications);

test('the sound menu escapes the settings clip and lists every choice', async () => {
  await trigger().click();
  await expect(menu()).toBeVisible();

  // boundingBox ignores clipping, so the structure is the real check.
  const portaled = await menu().evaluate((element) => element.closest('[data-testid="setting-row-notifications.onAgentIdle"]') === null);
  expect(portaled).toBe(true);

  for (const sound of ['off', 'chime', 'rise', 'fall', 'tick', 'system', 'custom']) {
    await expect(page.getByTestId(`notify-sound-option-${sound}`)).toBeVisible();
  }
  // The OS picks System, so there is nothing of ours to play.
  await expect(page.getByTestId('notify-sound-play-chime')).toBeVisible();
  await expect(page.getByTestId('notify-sound-play-system')).toHaveCount(0);
});

test('choosing a sound shows it in the row and saves it', async () => {
  await trigger().click();
  await page.getByTestId('notify-sound-option-chime').click();

  await expect(menu()).toBeHidden();
  await expect(trigger()).toContainText('Chime');
  await expect.poll(async () => (await savedNotifications()).sounds.onAgentIdle).toBe('chime');
});

test('Escape closes the menu and leaves the settings panel open', async () => {
  await trigger().click();
  await expect(menu()).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(menu()).toBeHidden();
  await expect(trigger()).toBeVisible();
});

test('a click outside closes the menu, and a Play inside does not', async () => {
  await trigger().click();
  await page.getByTestId('notify-sound-play-chime').click();
  await expect(menu()).toBeVisible();

  await page.mouse.click(5, 5);
  await expect(menu()).toBeHidden();
});

test('a refused file shows why under the row, keeps the earlier choice, and clears on the next pick', async () => {
  // Chime first: the default is Off, which a wrongly saved Custom would also not read as.
  await trigger().click();
  await page.getByTestId('notify-sound-option-chime').click();
  await expect(trigger()).toContainText('Chime');

  await page.evaluate(() => {
    (window as unknown as { __mockCustomSoundPick: unknown }).__mockCustomSoundPick = {
      status: 'refused',
      reason: 'gong.wav is 8.2 MB, over the 2 MB limit',
    };
  });

  await trigger().click();
  await page.getByTestId('notify-sound-option-custom').click();

  await expect(page.getByTestId('notify-sound-refusal-onAgentIdle')).toHaveText('gong.wav is 8.2 MB, over the 2 MB limit');
  await expect(trigger()).toContainText('Chime');
  const saved = await savedNotifications();
  expect(saved.sounds.onAgentIdle).toBe('chime');
  expect(saved.customSounds).toEqual({});

  await trigger().click();
  await page.getByTestId('notify-sound-option-rise').click();
  await expect(page.getByTestId('notify-sound-refusal-onAgentIdle')).toHaveCount(0);
});

test('a cancelled file pick leaves the choice and the saved config as they were', async () => {
  await trigger().click();
  await page.getByTestId('notify-sound-option-chime').click();
  await expect(trigger()).toContainText('Chime');
  const before = await savedNotifications();

  // The mock answers `cancelled` when no pick is seeded.
  await trigger().click();
  await page.getByTestId('notify-sound-option-custom').click();

  await expect(menu()).toBeHidden();
  await expect(trigger()).toContainText('Chime');
  await expect(page.getByTestId('notify-sound-refusal-onAgentIdle')).toHaveCount(0);
  expect(await savedNotifications()).toEqual(before);
});

test('a pick that rejects shows its reason in the row and raises no unhandled rejection', async () => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.evaluate(() => {
    (window as unknown as { __mockCustomSoundPickRejects: string }).__mockCustomSoundPickRejects = 'The file dialog could not open';
  });

  await trigger().click();
  await page.getByTestId('notify-sound-option-custom').click();

  await expect(page.getByTestId('notify-sound-refusal-onAgentIdle')).toHaveText('The file dialog could not open');
  expect(pageErrors).toEqual([]);
  await expect(trigger()).toContainText('Off');
});

test('with a custom file chosen, opening the menu focuses the Custom row and the arrows move focus', async () => {
  await page.evaluate(() => {
    (window as unknown as { __mockCustomSoundPick: unknown }).__mockCustomSoundPick = { status: 'picked', fileName: 'my-gong-sound.wav' };
  });
  await trigger().click();
  await page.getByTestId('notify-sound-option-custom').click();
  await expect(trigger()).toContainText('my-gong-sound.wav');

  await trigger().click();
  const customRow = page.getByTestId('notify-sound-option-custom');
  await expect(customRow).toHaveAttribute('aria-checked', 'true');
  await expect(customRow).toBeFocused();

  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('notify-sound-option-system')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(customRow).toBeFocused();
});

test('a built-in pick previews once, and Play plays its own sound without choosing it', async () => {
  await page.evaluate(() => {
    const created: string[] = [];
    (window as unknown as { __audioCreated: string[] }).__audioCreated = created;
    (window as unknown as { Audio: unknown }).Audio = class {
      constructor(source: string) { created.push(String(source)); }
      play() { return Promise.resolve(); }
      pause() {}
      addEventListener() {}
      removeEventListener() {}
    };
  });
  const startedSounds = () => page.evaluate(() => (window as unknown as { __audioCreated: string[] }).__audioCreated
    .map((source) => /([a-z]+)\.wav/.exec(source)?.[1] ?? source));

  await trigger().click();
  await page.getByTestId('notify-sound-option-chime').click();
  await expect.poll(startedSounds).toEqual(['chime']);

  await trigger().click();
  await page.getByTestId('notify-sound-play-rise').click();
  await expect.poll(startedSounds).toEqual(['chime', 'rise']);
  await expect(trigger()).toContainText('Chime');
});

test('Mute and App icon badge flip their own settings and leave the event switches alone', async () => {
  const mute = page.getByTestId('setting-row-notifications.muted');
  const badge = page.getByTestId('setting-row-notifications.appBadge');
  const before = await savedNotifications();
  expect(before.muted).toBe(false);
  expect(before.appBadge).toBe(true);

  await mute.click();
  await expect.poll(async () => (await savedNotifications()).muted).toBe(true);
  expect((await savedNotifications()).appBadge).toBe(true);

  await badge.click();
  await expect.poll(async () => (await savedNotifications()).appBadge).toBe(false);
  expect((await savedNotifications()).muted).toBe(true);

  const after = await savedNotifications();
  expect(after.toasts).toEqual(before.toasts);
  expect(after.desktop).toEqual(before.desktop);
  expect(after.sounds).toEqual(before.sounds);
});

test('a chosen file shows its name in the row', async () => {
  await page.evaluate(() => {
    (window as unknown as { __mockCustomSoundPick: unknown }).__mockCustomSoundPick = { status: 'picked', fileName: 'my-gong-sound.wav' };
  });

  await trigger().click();
  await page.getByTestId('notify-sound-option-custom').click();

  await expect(trigger()).toContainText('my-gong-sound.wav');
  await expect.poll(async () => (await savedNotifications()).customSounds.onAgentIdle).toBe('my-gong-sound.wav');
});

test('with Toast and Desktop both off, Sound is disabled and keeps its choice', async () => {
  await trigger().click();
  await page.getByTestId('notify-sound-option-rise').click();
  await expect(trigger()).toContainText('Rise');

  await page.getByTestId('notify-channel-onAgentIdle-toast').click();
  await page.getByTestId('notify-channel-onAgentIdle-desktop').click();

  await expect(trigger()).toBeDisabled();
  await expect(trigger()).toContainText('Rise');
});

test('the Toast and Desktop switches stay under their column headings', async () => {
  const heading = (name: string) => page.getByText(name, { exact: true }).first();
  for (const [name, testId] of [['Toast', 'notify-channel-onAgentIdle-toast'], ['Desktop', 'notify-channel-onAgentIdle-desktop']] as const) {
    const headingBox = await heading(name).boundingBox();
    const switchBox = await page.getByTestId(testId).boundingBox();
    if (!headingBox || !switchBox) throw new Error(`${name} did not lay out`);
    const headingCenter = headingBox.x + headingBox.width / 2;
    const switchCenter = switchBox.x + switchBox.width / 2;
    expect(Math.abs(headingCenter - switchCenter)).toBeLessThan(4);
  }
});
