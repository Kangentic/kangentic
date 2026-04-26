/**
 * E2E test for OpenCode session-ID capture via PTY output.
 *
 * OpenCode prints its session ID in startup output (e.g. "session id: ses_...").
 * The adapter's `fromOutput` regex captures this from the PTY stream and stores
 * it in the DB as `agent_session_id`. On resume, `--session <id>` is passed
 * to the CLI so the existing session is continued.
 *
 * This spec drives the full pipeline end-to-end:
 *   fromOutput -> notifyAgentSessionId -> DB update -> resume command
 *
 * Verification strategy: we do NOT read `agent_session_id` from the DB
 * directly (it's not exposed via `sessions.list()`). Instead we confirm the
 * full pipeline by driving a suspend/resume cycle. If `--session <id>` is
 * passed correctly on resume, mock-opencode prints:
 *   MOCK_OPENCODE_RESUMED:ses_2349b5c91ffeKd6qajuUTR4clq
 * which is the definitive proof that capture -> DB write -> resume worked.
 *
 * Note: `fromFilesystem` (SQLite DB scan) is not exercised here because it
 * requires a real OpenCode install with a populated `opencode.db`. The PTY
 * capture path covers the common case and can be tested in isolation with the
 * mock fixture.
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

const TEST_NAME = 'opencode-session-id-capture';
const runId = Date.now();
const PROJECT_NAME = `OpenCode Capture Test ${runId}`;

// This is the fixed session ID emitted by mock-opencode.js
// (see tests/fixtures/mock-opencode.js MOCK_SESSION_ID constant).
const MOCK_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';

test.describe('OpenCode Agent - Session ID Capture via PTY Output', () => {
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
          cliPaths: { opencode: mockAgentPath('opencode') },
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
    await setProjectDefaultAgent(page, 'opencode');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('captures session ID from PTY output and uses it on resume', async () => {
    const title = `OpenCode ID Capture ${runId}`;
    await createTask(page, title, 'Verify session ID capture and resume pipeline');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn OpenCode. The mock prints "session id: ses_..." on startup.
    // The adapter's fromOutput regex captures this and writes it to the DB.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    // Wait for the session ID header line to appear in scrollback, which
    // confirms fromOutput had a chance to fire and capture the ID.
    const startScrollback = await waitForScrollback(page, 'session id: ' + MOCK_SESSION_ID);
    expect(startScrollback).toContain('MOCK_OPENCODE_SESSION:' + MOCK_SESSION_ID);

    // Suspend: move to Done. waitForNoRunningSession blocks until the
    // PTY process is gone and the session is no longer in 'running' state.
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);

    // Resume: unarchive back to Planning. If the pipeline captured our session
    // ID correctly, the resume command will be:
    //   opencode --session ses_2349b5c91ffeKd6qajuUTR4clq
    // and mock-opencode will print:
    //   MOCK_OPENCODE_RESUMED:ses_2349b5c91ffeKd6qajuUTR4clq
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const resumeScrollback = await waitForScrollback(page, 'MOCK_OPENCODE_RESUMED:');

    // Extract and verify the resumed session ID from the marker.
    const resumedMatch = resumeScrollback.match(/MOCK_OPENCODE_RESUMED:(ses_[A-Za-z0-9_-]+)/);
    expect(resumedMatch).toBeTruthy();
    expect(resumedMatch![1]).toBe(MOCK_SESSION_ID);
  });
});
