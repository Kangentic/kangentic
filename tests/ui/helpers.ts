import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Single source of truth for known-benign renderer errors, shared with the
// renderer's runtime suppressor (the monaco error-funnel wrapper in
// src/renderer/monacoConfig.ts, which reassigns errorHandler.unexpectedErrorHandler).
// monacoConfig.ts swallows these before they reach the page, so collectPageErrors
// rarely sees them, but the filter stays as a belt-and-suspenders for any path
// that reaches window despite the funnel wrapper.
import { BENIGN_RENDERER_ERRORS, isBenignRendererError } from '../../src/shared/benign-renderer-errors';
export { BENIGN_RENDERER_ERRORS, isBenignRendererError };

/**
 * Attach a `pageerror` collector that drops messages matching
 * BENIGN_RENDERER_ERRORS. Returns a getter yielding the remaining, unexpected
 * error messages so a spec can assert a clean console without tripping on
 * quirks the app cannot control. Attach before the interaction under test so
 * the error window is fully covered.
 */
export function collectPageErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (isBenignRendererError(error)) return;
    errors.push(error.message);
  });
  return () => errors.slice();
}

/**
 * Poll the Vite dev server until it responds with HTTP 200.
 * Prevents thundering-herd timeouts when multiple workers launch simultaneously
 * before Vite finishes its initial compilation.
 */
export async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Vite dev server at ${url} not ready after ${timeoutMs}ms`);
}

/**
 * Launch a headless Chromium page with the electronAPI mock injected.
 * The Vite dev server must be running (started by playwright webServer config).
 */
export async function launchPage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // Inject the mock before any page scripts run
  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  // Wait for React to render the app shell
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// Wait for the board to load (swimlanes visible)
export async function waitForBoard(page: Page): Promise<void> {
  await page
    .locator('[data-swimlane-name="To Do"]')
    .waitFor({ state: 'visible', timeout: 15000 });
  await page
    .locator('[data-swimlane-name="Planning"]')
    .waitFor({ state: 'visible', timeout: 5000 });
}

// Create a project via the UI (folder picker flow).
// The project name is derived from the folder path's basename,
// so we construct a mock path whose last segment matches the desired name.
export async function createProject(
  page: Page,
  name: string,
  _projectPath?: string,
): Promise<void> {
  // Set the mock folder selection so basename = project name
  await page.evaluate((n: string) => {
    (window as any).__mockFolderPath = '/mock/projects/' + n;
  }, name);

  // When no projects exist the sidebar is hidden and the welcome screen
  // provides the "Open a Project" button. Otherwise use the sidebar button.
  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');

  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }

  // There is no confirmation dialog: picking a folder creates the project and lands on
  // the board directly (git is set up silently, the name is the folder basename, and the
  // default agent is the walkthrough's first step). The onboarding checklist is the only
  // thing between here and the board.
  await dismissOnboardingChecklist(page);
  await waitForBoard(page);
}

/**
 * Dismiss the onboarding checklist if it is open.
 *
 * A brand-new project auto-opens it, and it is a focus-trapping modal over the board whose
 * backdrop intercepts pointer events - so any spec that creates a project and then touches
 * the board must get past it first. "Skip for now" persists the dismissal, so it cannot
 * reappear later in the same test.
 *
 * Call this after ANY project-creation flow, not just `createProject`: several specs drive
 * the folder picker and Add project dialog inline.
 */
export async function dismissOnboardingChecklist(page: Page): Promise<void> {
  const checklist = page.locator('[data-testid="onboarding-checklist"]');
  // Short on purpose: this wait is also the not-coming path (a project already marked
  // onboarded), and a long timeout there is paid silently by every such spec.
  await checklist.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  if (await checklist.isVisible().catch(() => false)) {
    await page.locator('[data-testid="onboarding-skip"]').click();
    await checklist.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

// Create a task via the UI in the To Do column (the only column with an "Add task" button).
// To place a task in a different column, create it in To Do first, then drag it.
export async function createTask(
  page: Page,
  title: string,
  description: string = '',
): Promise<void> {
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  const addButton = backlog.locator('text=Add task');
  await addButton.click();

  // Scope to the New Task BaseDialog (fixed inset-0 backdrop) to avoid ambiguity
  // with the task-detail window, which renders its own Task title input inside the
  // WindowLayer overlay (fixed top-10 bottom-9 - does NOT have class inset-0).
  const newTaskDialog = page.locator('.fixed.inset-0');
  const titleInput = newTaskDialog.locator('input[placeholder="Task title"]');
  await titleInput.fill(title);

  if (description) {
    const descInput = newTaskDialog.locator('textarea').first();
    await descInput.fill(description);
  }

  // Use type="submit" to distinguish the New Task dialog's Create button from the
  // dev-only TestHarness buttons ("Create Task" / "Create Project", type="button").
  const createButton = newTaskDialog.locator('button[type="submit"]:has-text("Create")');
  await createButton.click();
  // Wait for the new task dialog to unmount (the modal backdrop disappears).
  await newTaskDialog.waitFor({ state: 'hidden', timeout: 3000 });
}
