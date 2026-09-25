import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import { NAMED_THEMES } from '../../src/shared/types';

/**
 * The Theme tab's swatch grid: one radio tile per theme, painted from that theme's
 * own tokens. These cases cover what the dropdown it replaced gave for free (a
 * radiogroup with every theme named, arrow keys, Home/End, type-ahead) and the one
 * thing it could not (a tile scoped to its own palette, whatever theme the app is in).
 *
 * Every colour assertion here is RELATIVE (the same element before and after a
 * switch), never a hex: a literal would be both pixel-exact and the hand-copied
 * palette the grid exists to avoid.
 */

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Theme Grid ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openThemeTab() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.getByTestId('theme-grid').waitFor({ state: 'visible', timeout: 3000 });
}

async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

const tile = (id: string) => page.getByTestId(`theme-tile-${id}`);

/** The theme the app is showing, read off the store's effect rather than the grid. */
async function appliedTheme(): Promise<string> {
  return page.evaluate(() => {
    const themeClass = Array.from(document.documentElement.classList).find((name) => name.startsWith('theme-'));
    return themeClass ? themeClass.slice('theme-'.length) : 'dark';
  });
}

const followSwitch = () => page.getByRole('switch', { name: 'Follow system appearance' });

test.describe('Theme swatch grid', () => {
  test.afterEach(async () => {
    // Every case leaves the app on the mock's default theme, hand-picked, with the OS
    // emulation cleared, so the next starts clean.
    await page.emulateMedia({ colorScheme: null });
    if (await page.getByTestId('theme-grid').isVisible().catch(() => false)) {
      if (await followSwitch().getAttribute('aria-checked') === 'true') await followSwitch().click();
      await tile('dark').click();
      await expect.poll(appliedTheme).toBe('dark');
      await closeSettings();
    }
  });

  test('is a radiogroup with one named radio per theme, still inside the registry row', async () => {
    await openThemeTab();

    // The SettingRow wrapper is what search, the registry, and the docs scene key on.
    await expect(page.getByTestId('setting-row-theme')).toBeVisible();

    const group = page.getByRole('radiogroup', { name: 'Theme' });
    await expect(group).toBeVisible();
    for (const theme of NAMED_THEMES) {
      await expect(group.getByRole('radio', { name: theme.label, exact: true })).toBeVisible();
    }
    await expect(group.getByRole('radio')).toHaveCount(NAMED_THEMES.length);

    // One tab stop: the selected tile is the only one reachable by Tab.
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('dark')).toHaveAttribute('tabindex', '0');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'false');
    await expect(tile('moon')).toHaveAttribute('tabindex', '-1');
  });

  test('each swatch carries its own theme class, so the palette comes from index.css', async () => {
    await openThemeTab();
    for (const theme of NAMED_THEMES) {
      // A class assertion, not a colour: the CSS block is the single source.
      await expect(tile(theme.id).locator(`.theme-${theme.id}`)).toHaveCount(1);
    }
  });

  test('clicking a tile writes the project override and re-themes the app', async () => {
    await openThemeTab();
    await tile('moon').click();

    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(appliedTheme).toBe('moon');
    // The row is project-scoped: the write lands in the project override, not global config.
    await expect.poll(() => page.evaluate(async () => {
      const overrides = await window.electronAPI.config.getProjectOverrides();
      return overrides?.theme ?? null;
    })).toBe('moon');
  });

  test('a tile keeps its own palette when the app switches to a light theme', async () => {
    await openThemeTab();
    const darkSwatch = tile('dark').locator('.theme-dark');
    const panel = page.getByTestId('settings-panel');
    const swatchBefore = await darkSwatch.evaluate((element) => getComputedStyle(element).backgroundColor);
    const panelBefore = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);

    await tile('clay').click();
    await expect.poll(appliedTheme).toBe('clay');

    // The panel repainted in the new theme; the Graphite tile did not follow it.
    await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(panelBefore);
    await expect.poll(() => darkSwatch.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(swatchBefore);
  });

  test('arrow keys, Home and End move the selection and re-theme live', async () => {
    await openThemeTab();
    await tile('dark').click();
    await expect(tile('dark')).toBeFocused();

    // Reading order: Graphite, Rust, Moon, Forest, Ocean, Ember, Paper, ...
    await page.keyboard.press('ArrowRight');
    await expect(tile('rust')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('rust')).toBeFocused();
    await expect.poll(appliedTheme).toBe('rust');

    // Down is a row of three: Rust sits above Ocean.
    await page.keyboard.press('ArrowDown');
    await expect(tile('ocean')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('ocean')).toBeFocused();

    // Down again crosses into the Light group (Ocean is above Clay).
    await page.keyboard.press('ArrowDown');
    await expect(tile('clay')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('ArrowUp');
    await expect(tile('ocean')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('End');
    await expect(tile('peach')).toHaveAttribute('aria-checked', 'true');
    // Right from the last wraps to the first.
    await page.keyboard.press('ArrowRight');
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');
    // Up on the top row stays put, on the middle columns too: a clamp to an index
    // would slide Moon to Dark, which is a different theme.
    await page.keyboard.press('ArrowUp');
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');
    await tile('moon').click();
    await page.keyboard.press('ArrowUp');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(appliedTheme).toBe('moon');
    // Down on the bottom row stays put as well (Mint would otherwise slide to Peach).
    await tile('mint').click();
    await page.keyboard.press('ArrowDown');
    await expect(tile('mint')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(appliedTheme).toBe('mint');
    await tile('dark').click();
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('ArrowLeft');
    await expect(tile('peach')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(appliedTheme).toBe('dark');
  });

  test('a letter jumps to the next theme starting with it, and an unmatched letter does nothing', async () => {
    await openThemeTab();
    await tile('dark').click();
    await expect(tile('dark')).toBeFocused();

    await page.keyboard.press('m');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('moon')).toBeFocused();
    await page.keyboard.press('m');
    await expect(tile('mint')).toHaveAttribute('aria-checked', 'true');
    // Wraps: after Mint the next M is Moon again.
    await page.keyboard.press('M');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('q');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radiogroup', { name: 'Theme' }).locator('[aria-checked="true"]')).toHaveCount(1);
  });

  test('resting the pointer on a tile previews it without committing, and leaving reverts', async () => {
    await openThemeTab();
    await tile('moon').hover();
    // The preview waits for the pointer to rest, then paints the app.
    await expect.poll(appliedTheme).toBe('moon');
    // Nothing was written: the ring stays on Dark and the override is untouched.
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(async () => {
      const overrides = await window.electronAPI.config.getProjectOverrides();
      return overrides?.theme ?? null;
    })).not.toBe('moon');

    // Leaving the grid (the row's label is outside it) reverts to the committed theme.
    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();
    await expect.poll(appliedTheme).toBe('dark');
  });

  test('committing the hovered theme never flashes the old one on the way', async () => {
    await openThemeTab();
    await tile('clay').hover();
    await expect.poll(appliedTheme).toBe('clay');

    // Record every class mutation on <html> from here: a clear-then-write commit drops
    // the class back to the old theme for one config round trip, which this catches
    // as an intermediate state without the theme.
    await page.evaluate(() => {
      // Records are DELIVERED to the callback in a microtask, after which `takeRecords()`
      // returns nothing, so the callback has to keep them.
      const seen: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) seen.push(record.oldValue ?? '');
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
      const holder = window as unknown as { __themeClassOldValues: string[]; __themeClassObserver: MutationObserver };
      holder.__themeClassOldValues = seen;
      holder.__themeClassObserver = observer;
    });
    await tile('clay').click();
    await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getProjectOverrides())?.theme ?? null)).toBe('clay');

    const states = await page.evaluate(() => {
      const holder = window as unknown as { __themeClassOldValues: string[]; __themeClassObserver: MutationObserver };
      const oldValues = [...holder.__themeClassOldValues, ...holder.__themeClassObserver.takeRecords().map((record) => record.oldValue ?? '')];
      holder.__themeClassObserver.disconnect();
      // Each oldValue is the state BEFORE that mutation; the first is the pre-click state,
      // so the states passed through are the rest plus the live value.
      return [...oldValues.slice(1), document.documentElement.className];
    });
    for (const state of states) expect(state, `html class passed through "${state}"`).toContain('theme-clay');
    await expect.poll(appliedTheme).toBe('clay');
  });

  // The rest delay (a pointer crossing a tile does not flash its theme) is deliberately
  // not asserted: it needs two pointer actions inside 120ms, which a loaded CI worker
  // cannot promise, and a timing test that fails only under load is worse than none.

  test('a keyboard move ends a hover preview instead of being masked by it', async () => {
    await openThemeTab();
    await tile('dark').click();
    await tile('ember').hover();
    await expect.poll(appliedTheme).toBe('ember');
    // The pointer still rests on Ember; the arrow commits Rust and must show it.
    await page.keyboard.press('ArrowRight');
    await expect(tile('rust')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(appliedTheme).toBe('rust');
  });

  test('closing the panel mid-preview reverts to the committed theme', async () => {
    await openThemeTab();
    await tile('sky').hover();
    await expect.poll(appliedTheme).toBe('sky');
    await closeSettings();
    await expect.poll(appliedTheme).toBe('dark');
  });

  test('Escape still closes the panel with a tile focused', async () => {
    await openThemeTab();
    await tile('dark').click();
    await expect(tile('dark')).toBeFocused();
    await closeSettings();
  });

  const overrides = () => page.evaluate(async () => {
    const saved = await window.electronAPI.config.getProjectOverrides();
    return {
      theme: saved?.theme ?? null,
      follows: saved?.themeFollowsSystem ?? null,
      light: saved?.themeLight ?? null,
      dark: saved?.themeDark ?? null,
    };
  });

  test('following the system keeps the shown theme and gives each base its own choice', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openThemeTab();
    await tile('moon').click();
    await expect.poll(appliedTheme).toBe('moon');

    await followSwitch().click();
    await expect(followSwitch()).toHaveAttribute('aria-checked', 'true');
    // Two radiogroups now, each named for when it applies, each with its own checked tile:
    // the hand-picked Moon seeded the dark slot, and the light slot holds the default.
    const darkGroup = page.getByRole('radiogroup', { name: 'Dark, when the system is dark' });
    const lightGroup = page.getByRole('radiogroup', { name: 'Light, when the system is light' });
    await expect(darkGroup.getByRole('radio')).toHaveCount(6);
    await expect(lightGroup.getByRole('radio')).toHaveCount(6);
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('light')).toHaveAttribute('aria-checked', 'true');
    // The pair stands out: every other tile is dimmed, and the visible group labels stay
    // the plain "Dark" / "Light" (the switch's description already says when each applies).
    await expect(tile('forest')).toHaveAttribute('data-muted', 'true');
    await expect(tile('sky')).toHaveAttribute('data-muted', 'true');
    await expect(tile('moon')).not.toHaveAttribute('data-muted');
    await expect(tile('light')).not.toHaveAttribute('data-muted');
    await expect(page.getByTestId('theme-grid').getByText('Dark', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('theme-grid').getByText('Dark, when the system is dark')).toHaveCount(0);
    // Nothing repainted: the OS is dark and the dark choice is still Moon. The light
    // slot was never touched (the mock seeds a project's overrides from the defaults).
    await expect.poll(appliedTheme).toBe('moon');
    await expect.poll(overrides).toMatchObject({ theme: 'moon', follows: true, dark: 'moon' });
    expect(['light', null]).toContain((await overrides()).light);

    // Arrows stay inside their group: Right from Ember wraps to Dark, never into Light.
    await tile('ember').click();
    await page.keyboard.press('ArrowRight');
    await expect(tile('dark')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('light')).toHaveAttribute('aria-checked', 'true');
  });

  test('the OS side decides which choice paints, and an OS flip repaints with no write', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openThemeTab();
    await followSwitch().click();
    await expect(followSwitch()).toHaveAttribute('aria-checked', 'true');

    // A choice for the other side is recorded but not painted once the pointer leaves.
    await tile('sky').click();
    await expect(tile('sky')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();
    await expect.poll(appliedTheme).toBe('dark');
    await expect.poll(overrides).toMatchObject({ follows: true, light: 'sky' });

    const before = await overrides();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(appliedTheme).toBe('sky');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(appliedTheme).toBe('dark');
    // The OS reading is never written to config.
    expect(await overrides()).toEqual(before);
  });

  test('turning following off keeps whichever theme is showing', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openThemeTab();
    await followSwitch().click();
    await tile('mint').click();
    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();
    await expect.poll(appliedTheme).toBe('mint');

    await followSwitch().click();
    await expect(followSwitch()).toHaveAttribute('aria-checked', 'false');
    // One radiogroup again, with the theme that was showing as the hand-picked one.
    await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio')).toHaveCount(NAMED_THEMES.length);
    await expect(tile('mint')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(appliedTheme).toBe('mint');
    await expect.poll(overrides).toMatchObject({ theme: 'mint', follows: false });
  });

  test('the FOUC key in localStorage only ever holds a committed theme, never a preview', async () => {
    await openThemeTab();
    await tile('moon').click();
    await expect.poll(appliedTheme).toBe('moon');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('kng-resolved-theme')))
      .toBe('moon');

    // Hovering a different tile previews it on <html>, but the key the next launch's
    // FOUC script reads must stay on the committed theme: a leak here would boot the
    // app into whatever was last hovered, never actually chosen.
    await tile('ember').hover();
    await expect.poll(appliedTheme).toBe('ember');
    expect(await page.evaluate(() => localStorage.getItem('kng-resolved-theme'))).toBe('moon');
    await expect(tile('moon')).toHaveAttribute('aria-checked', 'true');
    await expect(tile('ember')).toHaveAttribute('aria-checked', 'false');

    // Committing the hovered tile moves the key onto it too.
    await tile('ember').click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('kng-resolved-theme')))
      .toBe('ember');
  });

  test('toggling follow system, then committing a tile before the toggle write lands, does not strand the app on the tile preview', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openThemeTab();

    // Hold the project-override write open so BOTH clicks below enqueue before
    // either lands, deterministically reproducing an interleaving a plain
    // sequence of Playwright clicks cannot: the mock resolves the write in a
    // microtask, so two clicks in a row would not otherwise overlap it.
    await page.evaluate(() => {
      const configApi = window.electronAPI.config;
      const originalSetProjectOverridesByPath = configApi.setProjectOverridesByPath.bind(configApi);
      let releaseGate: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      const holder = window as unknown as {
        __themeWriteGateOriginal?: typeof originalSetProjectOverridesByPath;
        __releaseThemeWriteGate?: () => void;
      };
      holder.__themeWriteGateOriginal = originalSetProjectOverridesByPath;
      holder.__releaseThemeWriteGate = () => releaseGate?.();
      configApi.setProjectOverridesByPath = async (projectPath, overridesPatch) => {
        await gate;
        return originalSetProjectOverridesByPath(projectPath, overridesPatch);
      };
    });

    // Click Follow, then commit Moon before Follow's write has had any chance to
    // land: the gate above is still closed, so this is deterministic, not a timing
    // race. `updateProjectOverride`'s queue guarantees the Follow write is the one
    // that lands first (it was enqueued first); Moon's own commit, fired a moment
    // later, still reads `themeFollowsSystem` as false off the live store, because
    // the flip has not landed yet either. That is the exact interleaving the fix's
    // `superseded` check exists for: the commit's landing watch is armed against a
    // follow-state that is about to change out from under it.
    await followSwitch().click();
    await tile('moon').click();

    await page.evaluate(() => {
      (window as unknown as { __releaseThemeWriteGate?: () => void }).__releaseThemeWriteGate?.();
    });
    // Restore the real write path so the rest of this test, and every test after
    // it, hits the mock directly again. Unconditional and ahead of any assertion:
    // if an assertion below throws while the gate were still closed, afterEach's
    // own write would hang and cascade into every later test in the file.
    await page.evaluate(() => {
      const holder = window as unknown as {
        __themeWriteGateOriginal?: typeof window.electronAPI.config.setProjectOverridesByPath;
      };
      if (holder.__themeWriteGateOriginal) window.electronAPI.config.setProjectOverridesByPath = holder.__themeWriteGateOriginal;
    });

    // Both writes land: Follow is on, and Moon's own commit was not dropped by an
    // unserialized pair overwriting each other's result wholesale.
    await expect.poll(overrides).toMatchObject({ follows: true, theme: 'moon' });
    await expect(followSwitch()).toHaveAttribute('aria-checked', 'true');

    // The pointer is still resting on the Moon tile (the last click above), so the
    // parked preview is still a legitimate hover by design; move it off the grid,
    // as the other hover tests do, so the app settles on the committed config.
    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();

    // The dark slot is whatever actually landed, read back and computed rather
    // than hardcoded. Turning Follow on while Dark was showing correctly seeds
    // Dark into the dark slot (`pairPatchFor` reads the theme showing at that
    // moment); Moon's own commit, racing the same flip, lands in the legacy
    // `theme` key rather than the dark slot, so it does not end up the dark
    // choice here, and that reseeding accuracy is a separate concern from this
    // test. What this test guards is that the app paints what landed instead of
    // sticking on the Moon preview forever.
    const settled = await overrides();
    const expectedTheme = settled.dark ?? 'dark';
    await expect.poll(appliedTheme).toBe(expectedTheme);
    // Guard against a vacuous pass: the committed theme was Dark, not Moon, when
    // Follow was clicked, so the landed dark slot is guaranteed distinct from
    // Moon here. A stuck preview would keep painting Moon forever regardless.
    expect(expectedTheme).not.toBe('moon');
  });
});
