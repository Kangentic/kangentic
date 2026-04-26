/**
 * E2E test for Droid session-ID capture via the filesystem scanner.
 *
 * Droid does not print its session UUID in PTY output and does not have a
 * hook pipeline. The only capture path is:
 *   ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl
 *
 * mock-droid.js writes that file synchronously at startup. The
 * `captureSessionIdFromFilesystem` scanner in the main process picks it up
 * within its 500ms polling budget and writes the UUID to the DB.
 *
 * This spec verifies the full pipeline:
 *   mock-droid writes file -> scanner polls -> DB updated ->
 *   suspend -> resume uses `--resume <captured-uuid>`
 *
 * Design mirrors codex-session-id-capture.spec.ts but for the Droid adapter:
 * - No manual file planting required (mock-droid writes its own file)
 * - Resume verification done via mock-droid's MOCK_DROID_RESUMED:<uuid> marker
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

const TEST_NAME = 'droid-session-id-capture';
const runId = Date.now();
const PROJECT_NAME = `Droid Capture Test ${runId}`;

test.describe('Droid Agent -- Session ID Capture via Filesystem', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { droid: mockAgentPath('droid') },
          permissionMode: 'default',
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
    await setProjectDefaultAgent(page, 'droid');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('resume uses filesystem-captured session ID from ~/.factory/sessions/', async () => {
    const title = `Droid FS Capture ${runId}`;
    await createTask(page, title, 'Verify fromFilesystem pipeline via suspend/resume');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Droid. mock-droid.js writes
    //   ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl
    // synchronously before emitting any PTY output. The
    // captureSessionIdFromFilesystem scanner polls at 500ms intervals.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    // Wait for mock-droid to print its session marker. The UUID in this
    // marker is the same UUID mock-droid wrote to the JSONL file, so
    // it's the expected value for resume verification.
    const scrollbackAfterSpawn = await waitForScrollback(page, 'MOCK_DROID_SESSION:');

    const spawnMatch = scrollbackAfterSpawn.match(/MOCK_DROID_SESSION:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    expect(spawnMatch).toBeTruthy();
    const expectedUuid = spawnMatch![1];

    // Give the filesystem scanner enough time to poll and capture the UUID
    // into the DB. The scanner runs for up to 10s (20 * 500ms); 1500ms
    // covers 3 polling cycles which is enough once the file exists on disk.
    // This is an intentional fixed wait - the captured UUID only writes to
    // the DB and is not observable via sessions.list() (the in-memory DTO
    // does not expose agent_session_id). The resume step below is the
    // authoritative end-to-end verification that the capture succeeded.
    await page.waitForTimeout(1500);

    // Suspend: move to Done. waitForNoRunningSession blocks until the PTY
    // is gone; no extra buffer wait needed.
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);

    // Resume: unarchive back to Planning. If captureSessionIdFromFilesystem
    // wrote the UUID to the DB, the resume command will be:
    //   droid --cwd <cwd> --resume <expectedUuid>
    // and mock-droid will print MOCK_DROID_RESUMED:<expectedUuid>.
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollbackAfterResume = await waitForScrollback(page, 'MOCK_DROID_RESUMED:');

    // Confirm the resumed UUID matches what was captured from the filesystem.
    const resumedMatch = scrollbackAfterResume.match(/MOCK_DROID_RESUMED:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    expect(resumedMatch).toBeTruthy();
    expect(resumedMatch![1]).toBe(expectedUuid);
  });
});
