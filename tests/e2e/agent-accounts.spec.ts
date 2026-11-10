/**
 * E2E: a second Claude account is added, switched to, and a task session runs on it (task #1057).
 *
 * Every piece has a unit test (the service, the folder links, the identity parse, the login
 * runner). What only a running app proves is that they meet:
 *   - `accounts.startLogin` runs the CLI's own `auth login` in a real PTY in the pty host with
 *     `CLAUDE_CONFIG_DIR` set to a new account folder, and `auth status` read back from a real
 *     child process turns the row into a signed-in `folder` account;
 *   - `accounts.switchTo` puts it first, and the next real agent spawn (move to a column that
 *     runs an agent) resolves it, so the session record carries its `accountId` AND the agent
 *     process really receives `CLAUDE_CONFIG_DIR=<account folder>`;
 *   - what that agent writes under the account folder's `projects` lands in the default home's
 *     `projects`, through the real directory link (a junction on Windows, a symlink elsewhere).
 * A mock bridge cannot stand in for any of these: the env, the PTY and the link are the point.
 *
 * The default home is a temp folder given to the app as CLAUDE_CONFIG_DIR, so the run never
 * touches the real `~/.claude` (the account layer refuses a real home under test as well).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  mockAgentPath,
  getTaskIdByTitle,
  moveTaskIpc,
  waitForTaskSession,
} from './helpers';

const TEST_NAME = 'agent-accounts';
const DEFAULT_HOME_EMAIL = 'default@example.com';
const PROBE_FOLDER = 'mock-account-probe';

interface ProbeRecord {
  configDir: string;
  sessionId: string;
}

/** A path as the file system names it, so a short Windows temp name and its long form compare equal. */
function canonical(target: string): string {
  return fs.realpathSync.native(target);
}

test('a second Claude account signs in, takes the next session, and shares the default home', async () => {
  const projectDirectory = createTempProject(TEST_NAME);
  const dataDir = getTestDataDir(TEST_NAME);
  const defaultHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-accounts-home-'));
  // The default home reads as signed in, as the agent's own login does.
  fs.writeFileSync(path.join(defaultHome, '.mock-auth.json'), JSON.stringify({ email: DEFAULT_HOME_EMAIL }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    claude: { cliPath: mockAgentPath('claude'), permissionMode: 'default', maxConcurrentSessions: 5 },
    git: { worktreesEnabled: false },
  }));

  const { app, page } = await launchApp({
    dataDir,
    extraEnv: { CLAUDE_CONFIG_DIR: defaultHome, MOCK_CLAUDE_ACCOUNT_PROBE: '1' },
  });
  try {
    await createProject(page, `Accounts ${Date.now()}`, projectDirectory);

    // 1. Add a second account through the real IPC path and wait for its sign-in to end.
    const login = await page.evaluate(async () => {
      const ended: Array<{ account: { id: string } | null; duplicateOf: unknown; cancelled: boolean }> = [];
      (window as unknown as { __accountLoginEnded: typeof ended }).__accountLoginEnded = ended;
      window.electronAPI.accounts.onLoginEnded((event) => ended.push(event));
      return window.electronAPI.accounts.startLogin({ agent: 'claude' });
    });
    expect(login.ok).toBe(true);

    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __accountLoginEnded: unknown[] }).__accountLoginEnded.length),
      { message: 'waiting for the sign-in terminal to end', timeout: 30_000, intervals: [200, 500] },
    ).toBe(1);

    const listAccounts = (): Promise<Array<{ id: string; kind: string; status: string; email: string | null; folderPath: string | null }>> =>
      page.evaluate(async () => {
        const cards = await window.electronAPI.accounts.list();
        return cards.find((card) => card.agent === 'claude')?.accounts ?? [];
      });

    await expect.poll(
      async () => (await listAccounts()).find((account) => account.kind === 'folder')?.status,
      { message: 'the new account reads as signed in', timeout: 15_000, intervals: [200, 500] },
    ).toBe('ok');

    const accounts = await listAccounts();
    const folderAccount = accounts.find((account) => account.kind === 'folder');
    expect(folderAccount).toBeTruthy();
    expect(folderAccount!.email).toMatch(/@example\.com$/);
    expect(folderAccount!.email).not.toBe(DEFAULT_HOME_EMAIL);
    expect(accounts.some((account) => account.kind === 'default')).toBe(true);
    const accountFolder = folderAccount!.folderPath!;
    expect(accountFolder).toBeTruthy();

    // The account's conversation folder is a link into the default home, not a folder of its own.
    expect(fs.lstatSync(path.join(accountFolder, 'projects')).isSymbolicLink()).toBe(true);

    // 2. Switch to it, then spawn a task's agent: the session runs on that account.
    // No session is running yet, so the switch moves none and answers at once.
    expect(await page.evaluate((id) => window.electronAPI.accounts.switchTo(id), folderAccount!.id))
      .toMatchObject({ ok: true, agent: 'claude', moved: 0, failed: 0 });

    const title = `Account session ${Date.now()}`;
    await createTask(page, title, 'Runs on the second account');
    const taskId = await getTaskIdByTitle(page, title);
    const planningId = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      return swimlanes.find((swimlane) => swimlane.name === 'Planning')?.id ?? null;
    });
    expect(planningId).toBeTruthy();
    await moveTaskIpc(page, taskId, planningId!);
    const { sessionId } = await waitForTaskSession(page, taskId);

    await expect.poll(
      () => page.evaluate(async (id) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.find((session) => session.id === id)?.accountId ?? null;
      }, sessionId),
      { message: 'the session record names the new account', timeout: 10_000, intervals: [200, 500] },
    ).toBe(folderAccount!.id);

    // 3. The agent process received CLAUDE_CONFIG_DIR, and what it wrote under the account
    //    folder's projects is in the default home's projects.
    const probeDirectory = path.join(defaultHome, 'projects', PROBE_FOLDER);
    let probe: ProbeRecord | null = null;
    await expect.poll(() => {
      try {
        const files = fs.readdirSync(probeDirectory).filter((name) => name.endsWith('.json'));
        if (files.length === 0) return null;
        probe = JSON.parse(fs.readFileSync(path.join(probeDirectory, files[0]), 'utf8')) as ProbeRecord;
        return probe.configDir;
      } catch {
        return null;
      }
    }, { message: 'the agent wrote its probe file into the default home', timeout: 15_000, intervals: [200, 500] }).not.toBeNull();

    expect(canonical(probe!.configDir)).toBe(canonical(accountFolder));
    expect(canonical(probe!.configDir)).not.toBe(canonical(defaultHome));
    // Reached through the link as well: the same file is readable under the account folder.
    expect(fs.existsSync(path.join(accountFolder, 'projects', PROBE_FOLDER, `${probe!.sessionId}.json`))).toBe(true);
  } finally {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
    fs.rmSync(defaultHome, { recursive: true, force: true });
  }
});
