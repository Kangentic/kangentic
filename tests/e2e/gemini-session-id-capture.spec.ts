/**
 * E2E test for Gemini session-ID capture via the hook pipeline.
 *
 * REGRESSION: StatusFileReader gated the events-file watcher on the
 * Claude-only `statusFileHook`, making `captureHookSessionIds` dead
 * code for Gemini. Now the watcher installs for all adapters with an
 * `eventsOutputPath`, and Gemini's adapter declares a `statusFile`
 * hook for event parsing.
 *
 * This spec uses `MOCK_GEMINI_NO_HEADER=1` to suppress mock-gemini's
 * fake `Session ID:` header, then injects a synthetic `session_start`
 * event with a known `session_id` into the events.jsonl file. After
 * capture, suspend + resume proves the full pipeline delivered the ID:
 *   events.jsonl -> StatusFileReader -> captureHookSessionIds
 *   -> fromHook (gemini-adapter) -> notifyAgentSessionId
 *   -> recoverStaleSessionId -> DB -> resume with --resume <captured-id>
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
import type { GeminiHookEntry } from '../../src/main/agent/adapters/gemini/hook-manager';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'gemini-session-id-capture';
const runId = Date.now();
const PROJECT_NAME = `Gemini Capture Test ${runId}`;
const KNOWN_GEMINI_UUID = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';

interface GeminiSettingsFile {
  hooks?: Record<string, GeminiHookEntry[]>;
}

function findEventsOutputPath(projectDir: string): string | null {
  const settingsPath = path.join(projectDir, '.gemini', 'settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as GeminiSettingsFile;
  if (!settings?.hooks) return null;
  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        const match = hook.command.match(/["']([^"']+events\.jsonl)["']/);
        if (match) return match[1].replace(/\//g, path.sep);
      }
    }
  }
  return null;
}

test.describe('Gemini Agent -- Session ID Capture via Hook Pipeline', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    process.env.MOCK_GEMINI_NO_HEADER = '1';
    // Suppress mock-gemini's session file so fromFilesystem doesn't race
    // ahead of the hook injection. This test isolates the hook pipeline.
    process.env.MOCK_GEMINI_NO_SESSION_FILE = '1';
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { gemini: mockAgentPath('gemini') },
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
    await setProjectDefaultAgent(page, 'gemini');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_GEMINI_NO_HEADER;
    delete process.env.MOCK_GEMINI_NO_SESSION_FILE;
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('resume uses hook-captured session ID when PTY header is suppressed', async () => {
    const title = `Gemini Hook Capture ${runId}`;
    await createTask(page, title, 'Verify fromHook pipeline via suspend/resume');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Gemini (no Session ID header due to MOCK_GEMINI_NO_HEADER=1).
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_GEMINI_SESSION:');

    // Find the events.jsonl path from the merged .gemini/settings.json.
    const eventsPath = findEventsOutputPath(tmpDir);
    expect(eventsPath).toBeTruthy();

    // Inject a synthetic SessionStart event with our known session_id.
    // This simulates what Gemini's real SessionStart hook delivers
    // through event-bridge.js (shape verified empirically from
    // tests/fixtures/agent-pty/gemini-real-auth-events.jsonl).
    fs.mkdirSync(path.dirname(eventsPath!), { recursive: true });
    fs.appendFileSync(eventsPath!, JSON.stringify({
      ts: Date.now(),
      type: 'session_start',
      hookContext: JSON.stringify({ session_id: KNOWN_GEMINI_UUID }),
    }) + '\n');

    // Give the StatusFileReader watcher time to detect the new data,
    // dispatch through captureHookSessionIds, and update the DB.
    await page.waitForTimeout(2000);

    // Suspend: move to Done.
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
    await page.waitForTimeout(2000);

    // Resume: unarchive back to Planning. If the pipeline captured our
    // UUID, the resume command will be `gemini --resume bbbb2222-...`
    // and mock-gemini will print `MOCK_GEMINI_RESUMED:bbbb2222-...`.
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback = await waitForScrollback(page, 'MOCK_GEMINI_RESUMED:');

    const resumedMatch = scrollback.match(/MOCK_GEMINI_RESUMED:([a-f0-9-]+)/);
    expect(resumedMatch).toBeTruthy();
    expect(resumedMatch![1]).toBe(KNOWN_GEMINI_UUID);
  });
});
