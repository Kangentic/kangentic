/**
 * E2E test for Codex activity detection.
 *
 * Codex's runtime strategy is `ActivityDetection.pty()` - the Rust CLI
 * does not honor `.codex/hooks.json` so activity is derived purely from
 * PTY silence. This spec verifies that:
 *  - A spawned Codex session shows up in the activity IPC map
 *  - The session settles to 'idle' once the mock stops emitting output
 *  - The session history reader pipeline delivers usage data (model name,
 *    context window size, token counts, progress percentage)
 *  - Tool events from the rollout JSONL appear in the events cache
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
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState, SessionUsage, SessionEvent } from '../../src/shared/types';

const TEST_NAME = 'codex-activity-detection';
const runId = Date.now();
const PROJECT_NAME = `Codex Activity Test ${runId}`;

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
  await app?.close();
  cleanupTempProject(TEST_NAME);
  cleanupTestDataDir(TEST_NAME);
});

test.describe('Codex Agent - Activity Detection', () => {
  test('spawned Codex session reports activity and settles to idle', async () => {
    const title = `Codex Activity ${runId}`;
    await createTask(page, title, 'Verify pty-only activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_CODEX_SESSION:');

    // PTY-only strategy: with no further mock output, the silence-based
    // detector should land us on 'idle' within a few seconds.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });

  test('session history reader delivers usage data from rollout JSONL', async () => {
    const title = `Codex Usage ${runId}`;
    await createTask(page, title, 'Verify session history pipeline delivers usage');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_CODEX_SESSION:');

    // The mock-codex.js writes a rollout JSONL file containing task_started
    // (context window), turn_context (model), token_count (tokens), and
    // task_complete. The session history reader pipeline should:
    //   1. captureSessionIdFromFilesystem -> find the rollout file
    //   2. locate -> resolve the file path
    //   3. parse -> extract usage + events
    //   4. dispatch -> update UsageTracker -> emit to renderer

    // Poll until usage data arrives with a non-zero context window.
    // The filesystem scan polls at 500ms intervals, so this may take
    // a few seconds to propagate.
    await expect.poll(async () => {
      const usageMap = await page.evaluate(() =>
        window.electronAPI.sessions.getUsage(),
      );
      const usages = Object.values(usageMap as Record<string, SessionUsage>);
      // Find a usage entry with a populated context window
      return usages.some(
        (usage) => usage.contextWindow.contextWindowSize > 0,
      );
    }, { timeout: 30000, message: 'Expected usage with contextWindowSize > 0' }).toBe(true);

    // Verify specific usage values from the mock rollout JSONL
    const usageMap = await page.evaluate(() =>
      window.electronAPI.sessions.getUsage(),
    );
    const usages = Object.values(usageMap as Record<string, SessionUsage>);
    const codexUsage = usages.find(
      (usage) => usage.contextWindow.contextWindowSize > 0,
    );
    expect(codexUsage).toBeDefined();
    expect(codexUsage!.model.id).toBe('mock-codex-model');
    expect(codexUsage!.contextWindow.contextWindowSize).toBe(258400);
    expect(codexUsage!.contextWindow.totalInputTokens).toBe(11214);
    expect(codexUsage!.contextWindow.usedPercentage).toBeGreaterThan(0);

    // Verify tool events from the rollout JSONL's response_item entries
    // appear in the events cache.
    const eventsMap = await page.evaluate(() =>
      window.electronAPI.sessions.getEventsCache(),
    );
    const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
    const toolEvents = allEvents.filter(
      (event) => event.type === 'tool_start',
    );
    expect(toolEvents.length).toBeGreaterThan(0);
  });
});
