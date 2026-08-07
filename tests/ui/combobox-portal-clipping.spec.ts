/**
 * UI tests for the portaled combobox menus (ModelCombobox / Combobox /
 * FontCombobox in src/renderer/components/dialogs/).
 *
 * The menus used to render as an in-flow `absolute top-full` div. `z-index` does
 * not escape an ancestor's overflow clip, so inside the task-detail window (three
 * `overflow-hidden` ancestors above one `overflow-y-auto` edit scroller) the list
 * was cut off at the form's bottom edge: opening Model showed only the first two
 * options until the user scrolled the form. They now portal to document.body via
 * OverlayPopover + usePopoverPosition({ strategy: 'fixed' }), the same pattern
 * LabelInput uses (see label-input.spec.ts, which covers the Labels field of this
 * same form).
 *
 * Portaling moves the options out of the combobox's own DOM subtree, which breaks
 * two mechanisms unless they are repointed, so this spec covers those too:
 *   - outside-click was checked against containerRef only, so a click on an option
 *     read as "outside" and the capture-phase mousedown unmounted the button
 *     before its click fired (selection silently no-opped).
 *   - keyboard nav queried containerRef for options, which returns nothing once
 *     they live in the portal, leaving arrow keys dead after a blur().
 *
 * Each test launches its own page (mode: 'parallel'), per the no-cross-test-state
 * convention used across this suite.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const CLIP_PROJECT_ID = 'proj-combobox-clip';
const CLIP_TASK_ID = 'task-combobox-clip';

const MODEL_MENU = '[data-testid="task-model-override-menu"]';
const MODEL_INPUT = 'input[data-testid="task-model-override"]';

/**
 * A short viewport is the whole point: the run-mode cards are the LAST child of
 * the edit form and Model sits in their second-to-last row, so at 700px tall the
 * field lands within the menu's own 192px (max-h-48) of the scroller's bottom.
 * That is exactly the geometry the bug reproduced at.
 */
async function launchWithClipScenario(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const page = await context.newPage();

  // Injected BEFORE the mock script so the mock picks it up when defining
  // `agents.list()`. This list is shaped to produce both a latest section and a
  // demoted "Older versions" section (claude-opus-4-7 is superseded by 4.8;
  // claude-haiku-4-5-20251001 is a dated pin), so the pinned toggle that takes
  // part in arrow-key navigation is present.
  await page.addInitScript(() => {
    (window as Record<string, unknown>).__mockAgentListOverrides = {
      claude: {
        capabilities: {
          effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsModelOverride: true,
          models: [
            'claude-haiku-4-5',
            'claude-haiku-4-5-20251001',
            'claude-opus-4-7',
            'claude-opus-4-8',
            'claude-opus-4-8[1m]',
          ],
          modelDisplayNames: {
            'claude-haiku-4-5': 'Haiku 4.5',
            'claude-haiku-4-5-20251001': 'Haiku 4.5',
            'claude-opus-4-7': 'Opus 4.7',
            'claude-opus-4-8': 'Opus 4.8',
            'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
          },
        },
      },
    };
  });

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${CLIP_PROJECT_ID}',
        name: 'Combobox Clip Test',
        path: '/mock/combobox-clip',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-cbclip-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
      });

      // No session_id -> TaskCard opens this directly into the edit form on click.
      state.tasks.push({
        id: '${CLIP_TASK_ID}',
        title: 'Model Dropdown Clip Task',
        description: 'Task used to reproduce the clipped model suggestion dropdown.',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        pr_state: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${CLIP_PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Open the task's edit form and select the Agent Override branch, which is what
 *  reveals the Model picker. */
async function openModelPicker(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').locator('text=Model Dropdown Clip Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

  // 'task-advanced-toggle' is the Agent Override run-mode card.
  await page.locator('[data-testid="task-advanced-toggle"]').click();
  await page.locator(MODEL_INPUT).waitFor({ state: 'visible', timeout: 5000 });
}

test('model dropdown escapes the task-detail edit form and stays within the viewport', async () => {
  const { browser, page } = await launchWithClipScenario();
  try {
    await openModelPicker(page);
    await page.locator(MODEL_INPUT).click();

    const menu = page.locator(MODEL_MENU);
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Portal proof: the menu must not be a descendant of the task-detail
    // window's clipping ancestor (data-testid="task-detail-dialog", which wraps
    // the overflow-y-auto edit form in an overflow-hidden window frame). This is
    // the actual invariant, and unlike a geometry read it cannot flake.
    const escapedClippingAncestor = await page.evaluate((menuSelector) => {
      const dialog = document.querySelector('[data-testid="task-detail-dialog"]');
      const menuElement = document.querySelector(menuSelector);
      return !!dialog && !!menuElement && !dialog.contains(menuElement);
    }, MODEL_MENU);
    expect(escapedClippingAncestor).toBe(true);

    // The portaled + flip-aware menu must stay fully within the viewport.
    // Coarse containment bound, not a pixel-exact assertion, per the
    // cross-platform-parity convention (font metrics differ across OSes).
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);

    // The reported symptom was the LAST rows being cut off while the first two
    // stayed visible, so assert on a row that was previously below the fold
    // rather than on the menu box alone.
    const lastLatestOption = page.locator('[data-model-option][title="claude-opus-4-8"]');
    await expect(lastLatestOption).toBeVisible();
    const optionBox = await lastLatestOption.boundingBox();
    expect(optionBox).not.toBeNull();
    expect(optionBox!.y + optionBox!.height).toBeLessThanOrEqual(viewport!.height + 1);
  } finally {
    await browser.close();
  }
});

test('portaled model menu matches the trigger width', async () => {
  const { browser, page } = await launchWithClipScenario();
  try {
    await openModelPicker(page);
    const modelInput = page.locator(MODEL_INPUT);
    await modelInput.click();

    const menu = page.locator(MODEL_MENU);
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Width-match proof: the fixed-strategy popover lost the old `left-0 right-0`
    // in-flow stretch, so ModelCombobox measures the container via
    // useLayoutEffect and applies it as an explicit `width`. Model renders in a
    // half-width column, so a missing width would be plainly visible.
    // The bordered shell is the input's direct parent. Addressed structurally
    // rather than by a border-color class: this assertion is about GEOMETRY, and
    // keying it to a color token made a purely visual retheme (edge-input ->
    // edge on the dark control family) look like a layout regression.
    const container = modelInput.locator('xpath=..');
    await expect(container).toHaveCount(1);
    const containerBox = await container.boundingBox();
    expect(containerBox).not.toBeNull();
    expect(containerBox!.width).toBeGreaterThan(0);

    // OverlayPopover plays a scale-from-trigger entrance animation, so a
    // boundingBox taken right after toBeVisible() can land mid-animation and
    // read a visually-shrunk transformed rect even though the underlying layout
    // width is already correct. Poll past the transform settle instead of a
    // fixed wait.
    await expect
      .poll(
        async () => {
          const currentBox = await menu.boundingBox();
          return currentBox ? Math.abs(currentBox.width - containerBox!.width) : null;
        },
        { timeout: 3000 },
      )
      .toBeLessThanOrEqual(2);
  } finally {
    await browser.close();
  }
});

test('a click inside the portaled menu counts as inside: the Older versions toggle expands without dismissing', async () => {
  const { browser, page } = await launchWithClipScenario();
  try {
    await openModelPicker(page);
    await page.locator(MODEL_INPUT).click();

    const menu = page.locator(MODEL_MENU);
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Regression guard for the outside-click repoint, and the assertion that
    // actually discriminates. The handler is a capture-phase mousedown checked
    // against containerRef; once the menu is portaled OUT of that subtree, every
    // click inside it reads as "outside" unless menuRef is checked too.
    //
    // A plain option click is NOT a good guard here: OverlayPopover keeps the
    // node mounted through its exit animation, so even a wrongly-dismissing
    // menu still delivers that option's click and commits. The pinned toggle is
    // the honest test, because it is an in-menu control whose whole job is to
    // expand the list IN PLACE and leave the menu open.
    const pinnedToggle = page.locator('[data-model-pinned-toggle]');
    await expect(pinnedToggle).toBeVisible();
    await pinnedToggle.click();

    // Intentional fixed wait: this asserts a NON-occurrence (the menu must not
    // dismiss), which cannot be expressed as a poll condition. It is also
    // required for the assertion to discriminate at all - OverlayPopover keeps
    // the node mounted for the ~100ms exit animation, so an immediate
    // toBeVisible() passes even against a menu that is on its way out. 400ms
    // clears --popover-exit-duration (100ms) with margin.
    await page.waitForTimeout(400);
    await expect(menu).toBeVisible();
    await expect(page.locator('[data-model-pinned-option]').first()).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('clicking a portaled option commits the model and closes the menu', async () => {
  const { browser, page } = await launchWithClipScenario();
  try {
    await openModelPicker(page);
    const modelInput = page.locator(MODEL_INPUT);
    await modelInput.click();
    await expect(page.locator(MODEL_MENU)).toBeVisible({ timeout: 3000 });

    await page.locator('[data-model-option][title="claude-opus-4-8"]').click();

    await expect(modelInput).toHaveValue('Opus 4.8');
    await expect(page.locator(MODEL_MENU)).not.toBeVisible({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

/**
 * BranchPicker's `variant="input"` was the one path still rendering in flow: its
 * comment argued it had to stay `absolute` "because it stretches to its
 * container's full width", the same reasoning that kept the comboboxes clipped.
 * Its only mount site is Settings > Git, whose panel body is an overflow-y-auto
 * scroller. The chip / kebab variants were already portaled and are covered by
 * new-task-dialog.spec.ts; this variant had no coverage at all.
 */
test('Git tab branch picker portals out of the settings scroller and keeps the trigger width', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `BranchPickerPortal ${Date.now()}`);

    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByRole('button', { name: 'Git', exact: true }).click();

    const trigger = page.locator('[data-testid="branch-picker-input"]');
    await expect(trigger).toBeVisible({ timeout: 3000 });
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox!.width).toBeGreaterThan(0);

    await trigger.click();
    const dropdown = page.locator('[data-testid="branch-picker-dropdown"]');
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    // Portal proof against the settings panel, this variant's clipping ancestor.
    const escapedSettingsPanel = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      const menu = document.querySelector('[data-testid="branch-picker-dropdown"]');
      return !!panel && !!menu && !panel.contains(menu);
    });
    expect(escapedSettingsPanel).toBe(true);

    // The `left-0 right-0` stretch is gone with the fixed strategy, so the
    // measured width and the trigger-aligned left edge are what replace it.
    // Poll past OverlayPopover's scale entrance before reading the box.
    await expect
      .poll(
        async () => {
          const box = await dropdown.boundingBox();
          return box ? Math.abs(box.width - triggerBox!.width) : null;
        },
        { timeout: 3000 },
      )
      .toBeLessThanOrEqual(2);

    const dropdownBox = await dropdown.boundingBox();
    expect(dropdownBox).not.toBeNull();
    expect(Math.abs(dropdownBox!.x - triggerBox!.x)).toBeLessThanOrEqual(2);
  } finally {
    await browser.close();
  }
});

test('arrow keys reach the portaled options and the Older versions toggle', async () => {
  const { browser, page } = await launchWithClipScenario();
  try {
    await openModelPicker(page);
    await page.locator(MODEL_INPUT).click();
    await expect(page.locator(MODEL_MENU)).toBeVisible({ timeout: 3000 });

    // Regression guard for the keyboard repoint. ArrowDown blurs the input and
    // focuses the first navigable element; when that query still ran against
    // containerRef it returned nothing once the options were portaled, so focus
    // landed on <body> and every subsequent arrow key was dead.
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.getAttribute('data-model-option')), { timeout: 3000 })
      .not.toBeNull();

    // Step down through the latest rows to the "Older versions" toggle, which is
    // part of the vertical order (NAVIGABLE_SELECTOR includes it) and lives
    // inside the same portal.
    await expect
      .poll(
        async () => {
          await page.keyboard.press('ArrowDown');
          return page.evaluate(() => document.activeElement?.hasAttribute('data-model-pinned-toggle') ?? false);
        },
        { timeout: 3000 },
      )
      .toBe(true);

    // Enter on the toggle expands the demoted section in place, and those rows
    // join the same navigable list.
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-model-pinned-option]').first()).toBeVisible({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});
