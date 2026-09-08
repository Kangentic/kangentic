/**
 * E2E: a renderer reload must not orphan a live Command Terminal PTY.
 *
 * The (project, slot) pairing that ties a Command Terminal window to its PTY is
 * renderer-only memory. A full reload destroys it while main keeps every
 * transient PTY running, so the terminal used to come back as a fresh, empty
 * boot with the original conversation still alive and unreachable.
 *
 * This lives at the E2E tier because it is the only one that can do the thing
 * the bug needs: a REAL `page.reload()` against a REAL PTY. The UI tier fakes
 * the reload structurally (it seeds surviving sessions into a mock while the
 * renderer's map starts empty) because its mock reinstalls through
 * `addInitScript` and its state resets on navigation, so a genuine reload there
 * would take the "surviving" PTYs with it.
 *
 * Deliberately store-free. `__zustandStores` is not reliably present in the E2E
 * context (see the note on `dismissOnboardingChecklist`), and main's own session
 * list is the stronger assertion anyway: the regression is a SECOND PTY being
 * spawned while the first is stranded, and that is visible as a count.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  dismissOnboardingChecklist,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'command-terminal-reload-recovery';
const runId = Date.now();
const PROJECT_NAME = `Reload Recovery ${runId}`;

/** Resolve the platform-appropriate mock Claude path. */
function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

/** Pre-write config with the mock CLI under the key the transient spawn reads
 *  (`agent.cliPaths`, not the legacy `claude.cliPath`) and worktrees off. */
function writeTestConfig(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      hasCompletedFirstRun: true,
      agent: { cliPaths: { claude: mockClaudePath() } },
      git: { worktreesEnabled: false },
    }),
  );
}

interface TransientRow {
  id: string;
  startedAt: string;
}

/** Every running Command Terminal PTY main currently owns, as main reports it. */
async function liveTerminals(page: Page): Promise<TransientRow[]> {
  return page.evaluate(async () => {
    const sessions = await window.electronAPI.sessions.list();
    return sessions
      .filter((session) => session.transient && session.status === 'running')
      .map((session) => ({ id: session.id, startedAt: session.startedAt }));
  });
}

/** The live terminals in spawn order, which is also slot order. */
async function orderedByStart(page: Page): Promise<TransientRow[]> {
  const rows = await liveTerminals(page);
  return rows.sort(
    (first, second) => first.startedAt.localeCompare(second.startedAt) || first.id.localeCompare(second.id),
  );
}

/** Open the Command Terminal layer and wait for a window to be on screen. */
async function openCommandTerminalLayer(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await page.locator('[data-testid="command-terminal-window"]').first()
    .waitFor({ state: 'visible', timeout: 20000 });
}

test.describe('Command Terminal reload recovery', () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let projectPath: string;

  test.beforeAll(async () => {
    cleanupTestDataDir(TEST_NAME);
    const dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);
    projectPath = createTempProject(TEST_NAME);

    const launched = await launchApp({ dataDir });
    app = launched.app;
    page = launched.page;
    // No waitForBoard first: a fresh dataDir opens on the welcome screen, which
    // has no swimlanes. createProject reloads and waits for the board itself.
    await createProject(page, PROJECT_NAME, projectPath);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('a real page reload reattaches the survivor under its own terminal number', async () => {
    // Two terminals, then stop the FIRST. That leaves exactly one survivor, and
    // it is the one on slot-2 - which is what makes this deterministic rather
    // than a coin flip. Recovery used to deal survivors `slot-1, slot-2, ...`
    // over an id-sorted list, so a lone survivor always landed on slot-1 no
    // matter which terminal it actually was. With one terminal that guess is
    // accidentally right, which is why the test needs two.
    await openCommandTerminalLayer(page);
    await expect
      .poll(async () => (await liveTerminals(page)).length, { timeout: 30000, intervals: [250, 500, 1000] })
      .toBe(1);

    await page.locator('[data-testid="quick-session-new-terminal"]').click();
    await expect
      .poll(async () => (await liveTerminals(page)).length, { timeout: 30000, intervals: [250, 500, 1000] })
      .toBe(2);

    // Spawn order is slot order, so the older row is the slot-1 terminal. Derived
    // from startedAt rather than from `commandTerminalSlot`, deliberately: this
    // test asserts observable behavior, so it must not identify its subject using
    // the very field the fix added.
    const [firstTerminal, secondTerminal] = await orderedByStart(page);

    await page.evaluate((id) => window.electronAPI.sessions.killTransient(id), firstTerminal.id);
    await expect
      .poll(async () => (await liveTerminals(page)).map((row) => row.id), { timeout: 15000, intervals: [250, 500] })
      .toEqual([secondTerminal.id]);

    await page.reload();
    await dismissOnboardingChecklist(page);
    await waitForBoard(page);

    // The survivor outlived the renderer, which is the premise: main never killed it.
    await expect
      .poll(async () => (await liveTerminals(page)).map((row) => row.id), { timeout: 15000, intervals: [250, 500] })
      .toEqual([secondTerminal.id]);

    await openCommandTerminalLayer(page);

    // It comes back as Command Terminal 2, the number it has always had. Under
    // the positional guess it returned as "Command Terminal 1", so the window
    // named a terminal that was not the one it was showing.
    await expect(page.getByText('Command Terminal 2', { exact: true }).first())
      .toBeVisible({ timeout: 15000 });

    // Still exactly one PTY, still the same one, and the window is bound to it
    // rather than merely coexisting with it. A fresh spawn would satisfy the
    // window count just as well.
    const after = await liveTerminals(page);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(secondTerminal.id);
    await expect(page.locator(`[data-session-id="${secondTerminal.id}"]`).first())
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="command-terminal-window"]')).toHaveCount(1);
  });
});
