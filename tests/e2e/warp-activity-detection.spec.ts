/**
 * E2E test for Warp activity detection.
 *
 * Warp's runtime strategy is `ActivityDetection.pty()` with a detectIdle
 * callback matching the `> ` prompt. This spec verifies that:
 *  - The mock Warp CLI receives the correct `oz agent run` command shape
 *  - A spawned Warp session shows up in the activity IPC map
 *  - The session settles to 'idle' once the mock stops emitting output
 *  - The --prompt, -C, and --name flags are correctly passed through
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
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState } from '../../src/shared/types';

const runId = Date.now();

test.describe('Warp Agent - Activity Detection', () => {
  const TEST_NAME = 'warp-activity-detection';
  const PROJECT_NAME = `Warp Activity Test ${runId}`;

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
          cliPaths: { warp: mockAgentPath('warp') },
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
    await setProjectDefaultAgent(page, 'warp');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('spawned Warp session reports activity and settles to idle', async () => {
    const title = `Warp Activity ${runId}`;
    await createTask(page, title, 'Verify pty-only activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_WARP_SESSION:');

    // PTY-only strategy: with no further mock output after the idle prompt,
    // the silence-based detector should land us on 'idle' within a few seconds.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });

  test('mock receives correct command shape with --prompt and -C', async () => {
    const title = `Warp Command Shape ${runId}`;
    const description = 'Verify oz agent run flags';
    await createTask(page, title, description);

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // Wait on MOCK_WARP_NAME:<taskId> instead of the prompt text. The PTY
    // running under PowerShell echoes the full command line (including the
    // --prompt argument) BEFORE the mock has actually run, so any
    // assertion targeting prompt content can match the PowerShell echo
    // first - producing a false positive that races the actual mock
    // output. MOCK_WARP_NAME:<taskId> only appears in the mock's own
    // stdout after it has parsed args.
    const scrollback = await waitForScrollback(page, `MOCK_WARP_NAME:${taskId}`);

    // The mock echoes back the -C (cwd) it received - should be the project dir
    expect(scrollback).toContain(`MOCK_WARP_CWD:${tmpDir}`);

    // The prompt envelope is XML-wrapped and spans multiple lines, with
    // <description> opening and closing on their own lines for readability.
    // The title tag lands on its own line below the MOCK_WARP_PROMPT: prefix.
    // Assert both markers appear in scrollback rather than on the same
    // physical line.
    expect(scrollback).toContain('MOCK_WARP_PROMPT:');
    expect(scrollback).toContain(`<title>${title}</title>`);
  });
});

// "Active Output Then Idle" coverage moved to
// agent-activity-special-modes.spec.ts so it can share an Electron launch
// with the codex/cursor/copilot/warp special-mode regression guards.
