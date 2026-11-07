/**
 * Removing an SSH host while its project is the open one (#913). A project's theme is its own, and the
 * app-wide theme (Graphite) is only for when no project is open. The open board used to be dropped with
 * nothing opened in its place, so the whole UI jumped to Graphite. The most recently opened project that is
 * left now opens instead, and the old project stays current until it does, so no frame paints the default.
 *
 * With no project left the app goes to its empty state, and the settings panel lists only the system tabs
 * (it must not keep pointing at the project that went, even when the project list reloads before the
 * current-project answer arrives).
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, createProject, dismissOnboardingChecklist } from './helpers';

test.describe.configure({ mode: 'serial' });

let browser: Browser;
let page: Page;

test.afterEach(async () => {
  await browser?.close();
});

const tile = (id: string) => page.getByTestId(`theme-tile-${id}`);

async function appliedTheme(): Promise<string> {
  return page.evaluate(() => {
    const themeClass = Array.from(document.documentElement.classList).find((name) => name.startsWith('theme-'));
    return themeClass ? themeClass.slice('theme-'.length) : 'dark';
  });
}

async function pickTheme(theme: string) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await tile(theme).click();
  await expect.poll(appliedTheme).toBe(theme);
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

async function addHost() {
  await page.evaluate(async () => {
    await window.electronAPI.ssh.addHost({
      name: 'Build server',
      destination: 'dev@host.example.test',
      signIn: { method: 'config' },
      expectedFingerprint: 'SHA256:x',
    });
  });
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.ssh.listHosts()).length)).toBeGreaterThan(0);
}

async function addRemoteProject(opener: 'sidebar-new-project-button' | 'welcome-open-project', folder: string) {
  await page.locator(`[data-testid="${opener}"]`).click();
  await page.locator('[data-testid="add-project-host"]').click();
  const form = page.locator('[data-testid="add-remote-project"]');
  await form.locator('[data-testid="add-remote-project-folder"]').fill(folder);
  await form.locator('[data-testid="add-remote-project-submit"]').click();
  await expect(form).toHaveCount(0);
}

async function removeHostFromSettings() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('[data-testid="settings-tab-ssh"]').click();
  await page.locator('[data-testid="ssh-host-remove"]').click();
  const confirmDialog = page.locator('h3:has-text("Remove host")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
  await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);
}

test('opens the next project, with its own theme, and never paints the app-wide default on the way', async () => {
  ({ browser, page } = await launchPage());
  const localName = `Local ${Date.now()}`;
  await createProject(page, localName);
  await pickTheme('mint');

  await addHost();
  await addRemoteProject('sidebar-new-project-button', `/srv/theme-${Date.now()}`);
  await pickTheme('moon');

  // The class <html> shows in every frame from here, until the removal is done. The default theme is no
  // class at all. The store drops the old class and adds the new one in one synchronous step, so only a
  // frame that is really painted can be the default, which is why this samples frames and not mutations.
  await page.evaluate(() => {
    const holder = window as unknown as { __frames: string[]; __sampling: boolean };
    holder.__frames = [];
    holder.__sampling = true;
    const sample = () => {
      if (!holder.__sampling) return;
      holder.__frames.push(document.documentElement.className);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await removeHostFromSettings();
  await expect.poll(appliedTheme).toBe('mint');
  // A few frames past the switch, so a late repaint to the default would be seen too.
  await page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const wait = () => (frames++ < 10 ? requestAnimationFrame(wait) : resolve());
    requestAnimationFrame(wait);
  }));

  expect((await page.evaluate(async () => (await window.electronAPI.projects.getCurrent())?.name ?? null))).toBe(localName);
  // The project tabs are the next project's: the Theme tab is still there.
  await expect(page.locator('[data-testid="settings-tab-theme"]')).toBeVisible();

  const frames = await page.evaluate(() => {
    const holder = window as unknown as { __frames: string[]; __sampling: boolean };
    holder.__sampling = false;
    return holder.__frames;
  });
  expect(frames.length).toBeGreaterThan(5);
  for (const frame of frames) {
    expect(frame, `a frame painted with html class "${frame}"`).toMatch(/theme-(moon|mint)/);
  }
});

test('goes to the empty state when no project is left, and the panel does not keep pointing at the removed one', async () => {
  ({ browser, page } = await launchPage());
  await addHost();
  await addRemoteProject('welcome-open-project', `/srv/only-${Date.now()}`);
  // The first project on a fresh install opens the onboarding checklist over the board.
  await dismissOnboardingChecklist(page);

  // The project list reloads before the current-project answer arrives, as it can against the real main.
  await page.evaluate(() => {
    const projects = window.electronAPI.projects;
    const getCurrent = projects.getCurrent.bind(projects);
    projects.getCurrent = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const current = await getCurrent();
      (window as unknown as Record<string, unknown>).__currentReloadLanded = true;
      return current;
    };
  });

  await removeHostFromSettings();

  await expect(page.locator('[data-testid="settings-tab-ssh"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-tab-theme"]')).toHaveCount(0);
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__currentReloadLanded === true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('[data-testid="settings-tab-theme"]')).toHaveCount(0);
});
