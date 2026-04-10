/**
 * E2E test for Codex session-ID capture via the filesystem scanner.
 *
 * REGRESSION: Codex 0.118 does not print `session id:` in PTY output
 * and does not fire `.codex/hooks.json`. The only working capture
 * path is scanning `~/.codex/sessions/<today>/rollout-<ts>-<uuid>.jsonl`
 * for a file whose `session_meta.payload.cwd` matches the spawn cwd.
 *
 * This spec uses `MOCK_CODEX_NO_HEADER=1` to suppress the fake header,
 * then plants a synthetic rollout file with a KNOWN UUID and matching
 * cwd. After capture, the test suspends and resumes the session -
 * if `codex resume <KNOWN_UUID>` fires, the full pipeline worked:
 *   fromFilesystem -> notifyAgentSessionId -> DB update -> resume
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
  mockAgentPath,
  setProjectDefaultAgent,
  waitForScrollback,
  waitForRunningSession,
  waitForNoRunningSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TEST_NAME = 'codex-session-id-capture';
const runId = Date.now();
const PROJECT_NAME = `Codex Capture Test ${runId}`;
const KNOWN_CODEX_UUID = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';

function codexSessionsDirForToday(): string {
  const iso = new Date().toISOString();
  return path.join(os.homedir(), '.codex', 'sessions', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
}

function writeRolloutFile(cwd: string): string {
  const directory = codexSessionsDirForToday();
  fs.mkdirSync(directory, { recursive: true });
  const isoTimestamp = new Date().toISOString();
  const fileName = `rollout-${isoTimestamp.replace(/[:.]/g, '-').replace('Z', '')}-${KNOWN_CODEX_UUID}.jsonl`;
  const filepath = path.join(directory, fileName);
  fs.writeFileSync(filepath, JSON.stringify({
    timestamp: isoTimestamp,
    type: 'session_meta',
    payload: { id: KNOWN_CODEX_UUID, cli_version: '0.118.0', cwd, timestamp: isoTimestamp },
  }) + '\n');
  return filepath;
}

test.describe('Codex Agent -- Session ID Capture via Filesystem', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;
  let rolloutFilePath: string | null = null;

  test.beforeAll(async () => {
    process.env.MOCK_CODEX_NO_HEADER = '1';
    // Suppress the mock's own rollout JSONL so the test can plant its
    // own file with a known UUID for deterministic resume verification.
    process.env.MOCK_CODEX_NO_ROLLOUT = '1';
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { codex: mockAgentPath('codex') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );
    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'codex');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_CODEX_NO_HEADER;
    delete process.env.MOCK_CODEX_NO_ROLLOUT;
    if (rolloutFilePath) {
      try { fs.unlinkSync(rolloutFilePath); } catch { /* ignore */ }
    }
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('resume uses filesystem-captured session ID when PTY header is suppressed', async () => {
    const title = `Codex FS Capture ${runId}`;
    await createTask(page, title, 'Verify fromFilesystem pipeline via suspend/resume');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Codex (no session-id header due to MOCK_CODEX_NO_HEADER=1).
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CODEX_SESSION:');

    // Plant the rollout file with our known UUID and matching cwd.
    // The scanner polls at 500ms intervals - it should find this promptly.
    rolloutFilePath = writeRolloutFile(tmpDir);

    // Give the capture pipeline time to scan, find the file, and update the DB.
    await page.waitForTimeout(3000);

    // Suspend: move to Done.
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
    await page.waitForTimeout(2000);

    // Resume: unarchive back to Planning. If the pipeline captured our UUID,
    // the resume command will be `codex resume aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee -C <cwd>`
    // and mock-codex will print `MOCK_CODEX_RESUMED:aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee`.
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback = await waitForScrollback(page, 'MOCK_CODEX_RESUMED:');

    // Extract the resumed session ID from mock-codex's marker.
    const resumedMatch = scrollback.match(/MOCK_CODEX_RESUMED:([a-f0-9-]+)/);
    expect(resumedMatch).toBeTruthy();
    expect(resumedMatch![1]).toBe(KNOWN_CODEX_UUID);
  });
});
