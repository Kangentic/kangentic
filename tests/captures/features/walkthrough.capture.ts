/**
 * Full product walkthrough video capture.
 *
 * Drives a linear narrative from welcome screen → project open → task creation
 * → agent spawning → multi-agent orchestration → task completion.
 *
 * Produces a single WebM video at 1920×1080 plus chapter screenshots.
 * Output goes to captures/walkthrough/<timestamp>/ for historical comparison.
 */
import { test } from '@playwright/test';
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const MOCK_SCRIPT = path.join(__dirname, '..', '..', 'ui', 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Timestamped output directory
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'captures', 'walkthrough', timestamp);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Helpers ---

async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Vite not ready after ${timeoutMs}ms`);
}

async function beat(page: Page, ms = 1000) {
  await page.waitForTimeout(ms);
}

async function chapter(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`), fullPage: false });
}

/**
 * Drag a task card to a target column using @dnd-kit's PointerSensor pattern.
 * Requires initial 10px move to activate, then smooth steps to target.
 */
async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  // Scroll target into view
  await page.evaluate((col) => {
    const el = document.querySelector(`[data-swimlane-name="${col}"]`);
    if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await page.waitForTimeout(100);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error(`Cannot get bounding boxes for drag: ${taskTitle} → ${targetColumn}`);

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  // Move to card center
  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Activate PointerSensor (>= 5px)
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.waitForTimeout(100);

  // Smooth move to target
  await page.mouse.move(endX, endY, { steps: 25 });
  await page.waitForTimeout(200);

  // Drop
  await page.mouse.up();
  await page.waitForTimeout(500);
}

// --- Walkthrough ---

test('full product walkthrough', async () => {
  test.setTimeout(300_000); // 5 minutes

  await waitForViteReady();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: path.join(OUTPUT_DIR, '_raw'),
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();

  // First-run mode: welcome overlay visible, terminal font size 10
  await page.addInitScript(`
    window.__mockConfigOverrides = {
      hasCompletedFirstRun: false,
      terminal: {
        shell: null,
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 10,
        showPreview: false,
        panelHeight: 280,
        scrollbackLines: 5000,
        cursorStyle: 'block',
      },
    };
  `);

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  // ═══════════════════════════════════════════════════════════
  // ACT 1: WELCOME SCREEN (0:00 - 0:08)
  // ═══════════════════════════════════════════════════════════

  await page.waitForSelector('[data-testid="welcome-open-project"]', { timeout: 5000 });
  await beat(page, 2500);
  await chapter(page, '01-welcome-screen');

  // Click "Open a Project"
  await page.evaluate(() => {
    (window as any).__mockFolderPath = '/home/dev/projects/acme-saas';
  });
  await page.locator('[data-testid="welcome-open-project"]').click();

  // Wait for board
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });

  // Welcome overlay
  const overlay = page.locator('[data-testid="welcome-overlay"]');
  if (await overlay.isVisible().catch(() => false)) {
    await beat(page, 3000);
    await chapter(page, '02-welcome-overlay');

    const dismiss = page.locator('[data-testid="welcome-overlay-dismiss"]');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click();
    }
    await beat(page, 800);
  }

  await chapter(page, '03-empty-board');

  // ═══════════════════════════════════════════════════════════
  // ACT 2: CREATE TASKS (0:08 - 0:25)
  // ═══════════════════════════════════════════════════════════

  const addButton = page.locator('[data-swimlane-name="To Do"]').locator('text=Add task');

  // First task — show the dialog
  await addButton.click();
  const titleInput = page.locator('input[placeholder="Task title"]');
  await titleInput.waitFor({ state: 'visible', timeout: 3000 });
  await beat(page, 500);

  await titleInput.fill('Add user authentication');
  await beat(page, 500);

  await chapter(page, '04-new-task-dialog');

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await titleInput.waitFor({ state: 'hidden', timeout: 3000 });
  await beat(page, 600);

  // More tasks (faster)
  const tasks = [
    'Fix WebSocket reconnection',
    'Generate API client types',
    'Add rate limiting',
    'Integration test coverage',
  ];

  for (const taskTitle of tasks) {
    await addButton.click();
    await titleInput.waitFor({ state: 'visible', timeout: 3000 });
    await titleInput.fill(taskTitle);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await titleInput.waitFor({ state: 'hidden', timeout: 3000 });
    await beat(page, 300);
  }

  await beat(page, 1000);
  await chapter(page, '05-tasks-in-todo');

  // ═══════════════════════════════════════════════════════════
  // ACT 3: DRAG TASKS TO START AGENTS (0:25 - 0:45)
  // ═══════════════════════════════════════════════════════════

  // Drag first task to Planning
  await dragTaskToColumn(page, 'Add user authentication', 'Planning');
  await beat(page, 1200);
  await chapter(page, '06-first-drag-planning');

  // Drag more to Executing
  await dragTaskToColumn(page, 'Fix WebSocket reconnection', 'Executing');
  await beat(page, 800);

  await dragTaskToColumn(page, 'Generate API client types', 'Executing');
  await beat(page, 800);

  // Drag one to Code Review
  await dragTaskToColumn(page, 'Add rate limiting', 'Code Review');
  await beat(page, 800);

  await chapter(page, '07-tasks-distributed');
  await beat(page, 1500);

  // ═══════════════════════════════════════════════════════════
  // ACT 4: TASK DETAIL VIEW (0:45 - 0:55)
  // ═══════════════════════════════════════════════════════════

  // Click a task to open detail
  const planningCard = page.locator('[data-swimlane-name="Planning"]').locator('text=Add user authentication');
  if (await planningCard.isVisible().catch(() => false)) {
    await planningCard.click();
    await beat(page, 3000);
    await chapter(page, '08-task-detail');

    // Close via Escape at document level (bypasses xterm capture)
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await beat(page, 500);
  }

  // ═══════════════════════════════════════════════════════════
  // ACT 5: DRAG TO DONE (0:55 - 1:05)
  // ═══════════════════════════════════════════════════════════

  // Move a task to Done
  await dragTaskToColumn(page, 'Integration test coverage', 'Done');
  await beat(page, 1500);
  await chapter(page, '09-task-completed');

  // ═══════════════════════════════════════════════════════════
  // ACT 6: FINAL BOARD STATE (1:05 - 1:10)
  // ═══════════════════════════════════════════════════════════

  await beat(page, 2000);
  await chapter(page, '10-final-board');

  // --- Finalize video ---
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  if (videoPath && fs.existsSync(videoPath)) {
    fs.copyFileSync(videoPath, path.join(OUTPUT_DIR, 'walkthrough.webm'));
  }

  console.log(`Walkthrough saved to: ${OUTPUT_DIR}`);
});
