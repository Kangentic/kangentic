/**
 * E2E: a second renderer types and reads on its own port to the pty host.
 *
 * Each renderer holds its own port to the pty host (task #900): keystrokes go
 * to the host on it, and the host sends a session's output only to the ports
 * of the renderers that show that session. The unit tier drives one fake port
 * at a time, so this is the check that a real second webContents (the
 * detached Agent Monitor, a separate BrowserWindow with its own preload) gets
 * its own port, that typing in a terminal it hosts echoes back to it, and that
 * closing it forgets only its port: the main window's terminal still echoes
 * afterwards.
 *
 * `mock-claude-scroll.js` echoes each typed character on its input row, so a
 * keystroke's echo is observable as output. Output is collected through each
 * window's own `sessions.onData`, which the preload serves off that window's
 * port.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  getTaskIdByTitle,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'terminal-input-second-renderer';
const runId = Date.now();
const PROJECT_NAME = `Second Renderer ${runId}`;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

function mockScrollAgentPath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') return path.join(fixturesDir, 'mock-claude-scroll.cmd');
  const jsPath = path.join(fixturesDir, 'mock-claude-scroll.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

async function getSwimlaneByName(target: Page, name: string): Promise<string> {
  const swimlaneId = await target.evaluate(async (laneName) => {
    const swimlanes: Array<{ id: string; name: string }> = await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === laneName)?.id ?? null;
  }, name);
  if (!swimlaneId) throw new Error(`Swimlane "${name}" not found`);
  return swimlaneId;
}

/** The task's session once its agent is on screen, else null. */
async function readySessionIdForTask(target: Page, taskId: string): Promise<string | null> {
  return target.evaluate(async (tid) => {
    const sessions: Array<{ id: string; taskId: string; status: string }> = await window.electronAPI.sessions.list();
    const session = sessions.find((entry) => entry.taskId === tid && entry.status === 'running');
    if (!session) return null;
    const firstOutput = await window.electronAPI.sessions.getFirstOutput();
    return firstOutput[session.id] ? session.id : null;
  }, taskId);
}

/** Start collecting one session's output in a window, through its own preload. */
async function collectOutput(target: Page, sessionId: string): Promise<void> {
  await target.evaluate((sid) => {
    const holder = window as unknown as { __collectedOutput: string };
    holder.__collectedOutput = '';
    window.electronAPI.sessions.onData((receivedSessionId, data) => {
      if (receivedSessionId === sid) holder.__collectedOutput += data;
    });
  }, sessionId);
}

async function collectedOutput(target: Page): Promise<string> {
  return target.evaluate(() => (window as unknown as { __collectedOutput?: string }).__collectedOutput ?? '');
}

/** Click the terminal inside the open task window and type into it. */
async function typeIntoTaskTerminal(target: Page, text: string): Promise<void> {
  const terminal = target.locator('[data-testid="task-detail-dialog"] .xterm').first();
  await terminal.waitFor({ state: 'visible', timeout: 10000 });
  await terminal.click();
  await target.keyboard.type(text, { delay: 30 });
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: { cliPath: mockScrollAgentPath(), permissionMode: 'default', maxConcurrentSessions: 5 },
      git: { worktreesEnabled: false },
    }),
  );
  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
  cleanupTestDataDir(TEST_NAME);
});

test('a detached Agent Monitor types and reads on its own port, and closing it leaves the main window\'s port working', async () => {
  test.slow();

  const taskTitle = `Two Renderers ${runId}`;
  await createTask(page, taskTitle, 'Typed into from two windows');
  const taskId = await getTaskIdByTitle(page, taskTitle);
  await moveTaskIpc(page, taskId, await getSwimlaneByName(page, 'Executing'));

  let sessionId: string | null = null;
  await expect
    .poll(async () => {
      sessionId = await readySessionIdForTask(page, taskId);
      return sessionId;
    }, { timeout: 30000, message: 'Expected the mock agent to come up on screen' })
    .not.toBeNull();
  const readySessionId = sessionId as unknown as string;

  // The second renderer: the Agent Monitor in its own window.
  const [monitorWindow] = await Promise.all([
    app.waitForEvent('window'),
    page.evaluate(() => window.electronAPI.popOut.open('monitor', {})),
  ]);
  await monitorWindow.waitForLoadState('domcontentloaded');
  const monitorCard = monitorWindow.locator(`[data-testid="monitor-card"][data-session-id="${readySessionId}"]`).first();
  await monitorCard.waitFor({ state: 'visible', timeout: 15000 });
  await monitorCard.click();

  await collectOutput(monitorWindow, readySessionId);
  await typeIntoTaskTerminal(monitorWindow, 'kq7');
  await expect
    .poll(() => collectedOutput(monitorWindow), { timeout: 10000, message: 'Expected the echo on the monitor window\'s own port' })
    .toContain('kq7');

  // Closing the monitor forgets its port and only its port.
  await page.evaluate(() => window.electronAPI.popOut.close('monitor', {}));
  await expect.poll(() => monitorWindow.isClosed(), { timeout: 10000 }).toBe(true);

  await collectOutput(page, readySessionId);
  await page.locator(`[data-task-id="${taskId}"]`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await typeIntoTaskTerminal(page, 'mz3');
  await expect
    .poll(() => collectedOutput(page), { timeout: 10000, message: 'Expected the echo on the main window\'s port after the monitor closed' })
    .toContain('mz3');
});
