/**
 * UI tests for the shared label autocomplete (src/renderer/components/LabelInput.tsx),
 * covering two bugs fixed together:
 *
 * 1. Clicking a suggestion committed the raw typed text instead of the clicked
 *    suggestion, because the input's onBlur fired (and closed the dropdown) before
 *    the suggestion button's onClick could land. Fixed with onMouseDown
 *    preventDefault on each suggestion button.
 * 2. The suggestion dropdown was position:absolute inside the task-detail window's
 *    overflow-y-auto edit form / overflow-hidden window frame, so it was clipped.
 *    Fixed by portaling it to document.body via OverlayPopover + usePopoverPosition
 *    (the same pattern KebabMenu uses).
 *
 * Each test launches its own page (mode: 'parallel'), per the no-cross-test-state
 * convention used across this suite (see pr-url.spec.ts, label-promotion.spec.ts).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** The slice of the dev-only window.__zustandStores surface this spec drives. */
type ConfigStoreHandle = {
  config: {
    getState: () => {
      updateConfig: (partial: Record<string, unknown>) => Promise<void>;
    };
  };
};

/** Seed label suggestions via the real config-store action (mirrors LabelsPopover's own call). */
async function seedLabelColors(page: Page, labelColors: Record<string, string>): Promise<void> {
  await page.evaluate(async (colors) => {
    const stores = (window as unknown as { __zustandStores?: ConfigStoreHandle }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    await stores.config.getState().updateConfig({ backlog: { labelColors: colors } });
  }, labelColors);
}

test('clicking a label suggestion commits the clicked label, not the typed text', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `LabelAutocompleteClick ${Date.now()}`);
    await seedLabelColors(page, {
      research: '#3b82f6',
      'agent-adapter': '#8b5cf6',
      'agent-context': '#06b6d4',
    });

    const todoColumn = page.locator('[data-swimlane-name="To Do"]');
    await todoColumn.locator('text=Add task').click();

    const newTaskDialog = page.locator('.fixed.inset-0');
    await newTaskDialog.locator('input[placeholder="Task title"]').fill('Autocomplete commit test');

    const labelInput = newTaskDialog.locator('[data-testid="task-labels"]');
    await labelInput.click();
    await labelInput.fill('res');

    const suggestion = page.locator('[data-testid="label-suggestion"]', { hasText: 'research' });
    await expect(suggestion).toBeVisible({ timeout: 3000 });
    await suggestion.click();

    // Dropdown closes once the suggestion commits.
    await expect(page.locator('[data-testid="label-suggestions"]')).not.toBeVisible({ timeout: 3000 });

    const createButton = newTaskDialog.locator('button[type="submit"]:has-text("Create")');
    await createButton.click();
    await newTaskDialog.waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Autocomplete commit test');
    expect(task).toBeDefined();
    // Exact-array equality: pre-fix this would be ['res'] (the blur-committed
    // partial text), not the clicked suggestion.
    expect(task!.labels).toEqual(['research']);
  } finally {
    await browser.close();
  }
});

const CLIP_PROJECT_ID = 'proj-label-input-clip';
const CLIP_TASK_ID = 'task-label-input-clip';

async function launchWithClipScenario(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${CLIP_PROJECT_ID}',
        name: 'Label Input Clip Test',
        path: '/mock/label-input-clip',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Pre-merged into the effective config (config.get() deep-merges this
      // in), so the Labels field has suggestions the moment the edit form mounts.
      state.projectConfigs['/mock/label-input-clip'] = {
        backlog: {
          labelColors: {
            research: '#3b82f6',
            'agent-adapter': '#8b5cf6',
            'agent-context': '#06b6d4',
          },
        },
      };

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-clip-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
      });

      // No session_id -> TaskCard opens this directly into the edit form on click.
      state.tasks.push({
        id: '${CLIP_TASK_ID}',
        title: 'Label Dropdown Clip Task',
        description: 'Task used to reproduce the clipped label suggestion dropdown.',
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

test('label suggestion dropdown escapes the task-detail edit form and stays within the viewport', async () => {
  const { browser, page } = await launchWithClipScenario();
  try {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Label Dropdown Clip Task').first().click();

    // Task has no session, so it opens directly into the edit form.
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible', timeout: 5000 });

    const labelInput = page.locator('[data-testid="task-labels"]');
    await labelInput.click();

    const dropdown = page.locator('[data-testid="label-suggestions"]');
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    // Portal proof: the dropdown must not be a descendant of the task-detail
    // window's clipping ancestor (data-testid="task-detail-dialog", which wraps
    // the overflow-y-auto edit form in an overflow-hidden window frame).
    const escapedClippingAncestor = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="task-detail-dialog"]');
      const dropdownEl = document.querySelector('[data-testid="label-suggestions"]');
      return !!dialog && !!dropdownEl && !dialog.contains(dropdownEl);
    });
    expect(escapedClippingAncestor).toBe(true);

    // The portaled + flip-aware dropdown must stay fully within the viewport.
    // Coarse containment bound, not a pixel-exact assertion, per the
    // cross-platform-parity convention (font metrics differ across OSes).
    const box = await dropdown.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);

    // Width-match proof: the fixed-strategy popover lost the old `left-0
    // right-0` in-flow stretch, so LabelInput measures the bordered input
    // container (containerRef) via useLayoutEffect and applies it as an
    // explicit `width` style on the portaled popover. Assert the two widths
    // line up (both box-border, small tolerance per cross-platform-parity).
    const container = labelInput.locator('xpath=ancestor::div[contains(@class,"border-edge-input")][1]');
    await expect(container).toHaveCount(1);
    const containerBox = await container.boundingBox();
    expect(containerBox).not.toBeNull();
    expect(containerBox!.width).toBeGreaterThan(0);
    // OverlayPopover plays a scale-from-trigger entrance animation, so a
    // boundingBox taken right after toBeVisible() can land mid-animation and
    // read a visually-shrunk transformed rect even though the underlying
    // layout width is already correct. Poll past the transform settle
    // instead of a fixed wait (see anti-pattern 1 in the test-builder guide).
    await expect
      .poll(
        async () => {
          const currentBox = await dropdown.boundingBox();
          return currentBox ? Math.abs(currentBox.width - containerBox!.width) : null;
        },
        { timeout: 2000, intervals: [100, 200, 300] },
      )
      .toBeLessThan(2);
  } finally {
    await browser.close();
  }
});
