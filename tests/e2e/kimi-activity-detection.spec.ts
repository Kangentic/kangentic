/**
 * E2E tests for Kimi Code's typed first prompt and its wire.jsonl pipeline.
 *
 * Real wiring a mock bridge cannot stand in for: a PTY, the transition engine
 * typing a fresh session's prompt in (`freshPromptDelivery: 'typed'`), and the
 * session history reader tailing a file that exists only once that prompt has
 * landed. mock-kimi.js creates no session until its first typed message, so
 * MOCK_KIMI_SESSION in scrollback proves the prompt arrived. The parsing itself
 * is covered by tests/unit/kimi-wire-parser.test.ts. This spec verifies that:
 *  - The task's prompt is typed into a fresh session, which then runs
 *  - The session settles to 'idle' once the wire's `turn.ended` lands
 *  - An approved plan exit reaches the engine as ExitPlanMode's tool end
 *  - `subagent.*` records reach the events cache as subagent events
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
import type { ActivityState, SessionEvent } from '../../src/shared/types';

// Each describe block launches its own Electron app against its own isolated
// KANGENTIC_DATA_DIR and tmpDir (unique TEST_NAME per block). Running them in
// parallel cuts the file wall-clock from the sequential sum (~3 x 30-50s) to
// the slowest single describe block (~30-50s), which is the dominant gain on
// shard 5/10 (previously 154s). The MOCK_KIMI_PLAN_EXIT and
// MOCK_KIMI_SUBAGENT env vars are set inside each describe's beforeAll via
// process.env and then deleted in afterAll; because mode:'parallel' dispatches
// each describe to a separate worker process, the mutations are fully isolated.
test.describe.configure({ mode: 'parallel' });

const runId = Date.now();

test.describe('Kimi Agent - Activity Detection', () => {
  const TEST_NAME = 'kimi-activity-detection';
  const PROJECT_NAME = `Kimi Activity Test ${runId}`;

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
          cliPaths: { kimi: mockAgentPath('kimi') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
        },
        git: { worktreesEnabled: false },
      }),
    );

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('spawned Kimi session reports activity and settles to idle', async () => {
    const title = `Kimi Activity ${runId}`;
    await createTask(page, title, 'Verify wire.jsonl driven activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    // The session exists only because the task's prompt was typed in.
    const scrollback = await waitForScrollback(page, 'MOCK_KIMI_PROMPT:');
    expect(scrollback).toContain('MOCK_KIMI_SESSION:session_');
    expect(scrollback).toContain(title);

    // The wire.jsonl ends with `turn.ended`, so the session settles.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });

});

test.describe('Kimi Agent - an approved plan exit (MOCK_KIMI_PLAN_EXIT=1)', () => {
  const TEST_NAME = 'kimi-plan-exit';
  const PROJECT_NAME = `Kimi Plan Exit Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // Set the knob before launching Electron so every PTY session spawned by
    // this Electron instance inherits it. mock-kimi.js then writes an approved
    // ExitPlanMode into wire.jsonl.
    process.env.MOCK_KIMI_PLAN_EXIT = '1';

    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { kimi: mockAgentPath('kimi') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
        },
        git: { worktreesEnabled: false },
      }),
    );

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_KIMI_PLAN_EXIT;
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('an approved ExitPlanMode result reaches the events cache as the plan exit', async () => {
    // 30s internal poll + setup exceeds 30s default.
    test.slow();
    const title = `Kimi Plan Exit ${runId}`;
    await createTask(page, title, 'Verify the plan exit round-trip through wire.jsonl events-cache IPC');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    await expect.poll(async () => {
      const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
      const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
      return allEvents.some((event) => event.type === 'tool_end' && event.tool === 'ExitPlanMode');
    }, { timeout: 30000, message: 'Expected the ExitPlanMode tool end from the wire record' }).toBe(true);
  });
});

test.describe('Kimi Agent - subagent lifecycle (MOCK_KIMI_SUBAGENT=1)', () => {
  const TEST_NAME = 'kimi-subagent-detection';
  const PROJECT_NAME = `Kimi Subagent Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // Set the subagent knob before launching Electron so every PTY session
    // spawned by this Electron instance inherits the env var. mock-kimi.js
    // reads it at runtime to write `subagent.spawned` and `subagent.completed`
    // into wire.jsonl, exercising the disk-to-IPC pipeline end-to-end.
    process.env.MOCK_KIMI_SUBAGENT = '1';

    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { kimi: mockAgentPath('kimi') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
        },
        git: { worktreesEnabled: false },
      }),
    );

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_KIMI_SUBAGENT;
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('subagent records from wire.jsonl appear as subagent_start and subagent_stop in the events cache', async () => {
    // 30s internal poll + setup exceeds 30s default.
    test.slow();
    const title = `Kimi Subagent ${runId}`;
    await createTask(page, title, 'Verify subagent decoding through the wire.jsonl pipeline');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    // The mock writes the two records before `turn.ended`. The
    // SessionHistoryReader tails wire.jsonl and pushes events via IPC. Poll
    // until both subagent_start and subagent_stop appear in the cache.
    await expect.poll(async () => {
      const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
      const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
      const hasSubagentStart = allEvents.some((event) => event.type === 'subagent_start');
      const hasSubagentStop = allEvents.some((event) => event.type === 'subagent_stop');
      return hasSubagentStart && hasSubagentStop;
    }, { timeout: 30000, message: 'Expected subagent_start and subagent_stop events from the wire records' }).toBe(true);

    const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
    const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();

    const subagentStartEvents = allEvents.filter((event) => event.type === 'subagent_start');
    const subagentStopEvents = allEvents.filter((event) => event.type === 'subagent_stop');

    expect(subagentStartEvents.length).toBeGreaterThan(0);
    expect(subagentStopEvents.length).toBeGreaterThan(0);

    // The spawn names the subagent; its stop pairs with it by id.
    expect(subagentStartEvents[0].detail).toBe('explore');
    expect(subagentStopEvents[0].subagentId).toBe(subagentStartEvents[0].subagentId);
  });
});
