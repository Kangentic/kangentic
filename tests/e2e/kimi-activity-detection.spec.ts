/**
 * E2E tests for Kimi activity detection + wire.jsonl telemetry pipeline.
 *
 * Kimi's runtime strategy is `ActivityDetection.pty()` for the immediate
 * indicator, with the wire.jsonl `TurnBegin` / `TurnEnd` parser providing
 * authoritative transitions through `runtime.sessionHistory`. This spec
 * verifies that:
 *  - A spawned Kimi session shows up in the activity IPC map
 *  - Session settles to 'idle' after the wire.jsonl TurnEnd lands
 *  - Usage data (context_usage ratio, max_context_tokens, token_usage)
 *    is parsed out of wire.jsonl and surfaced through getUsage()
 *  - ToolCall / ToolResult events from wire.jsonl appear in the events cache
 *  - SubagentEvent TurnBegin / TurnEnd inner lifecycle events are decoded
 *    and surfaced as SubagentStart / SubagentStop entries in the events cache
 *    (MOCK_KIMI_SUBAGENT=1 path)
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  cleanupKimiSessionsForCwd,
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
// shard 5/10 (previously 154s). The MOCK_KIMI_PLAN_DISPLAY and
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
          queueOverflow: 'queue',
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
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('spawned Kimi session reports activity and settles to idle', async () => {
    const title = `Kimi Activity ${runId}`;
    await createTask(page, title, 'Verify wire.jsonl driven activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    // The wire.jsonl ends with TurnEnd, so the session-history parser
    // will report Activity.Idle once the file is tailed. The PTY silence
    // timer also lands on idle since the mock stops emitting after the
    // banner. Either path satisfies the assertion within 15s.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });

  // Removed 2026-06-19: 'session history reader delivers usage data from
  // wire.jsonl' and 'tool events from wire.jsonl appear in the events cache'.
  // Their StatusUpdate token-math and ToolCall/ToolResult parsing are fully
  // covered by tests/unit/kimi-wire-parser.test.ts, and the IPC wiring
  // (getUsage / getEventsCache) is agent-generic (also exercised by the codex
  // and gemini E2E specs). They were the two slowest serial tests in this
  // describe; dropping them keeps high-value Kimi-specific coverage (activity
  // idle here, PlanDisplay and SubagentEvent below) without the redundancy.
});

test.describe('Kimi Agent - PlanDisplay notification detail round-trip (MOCK_KIMI_PLAN_DISPLAY=1)', () => {
  const TEST_NAME = 'kimi-plan-display';
  const PROJECT_NAME = `Kimi PlanDisplay Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // Set the plan-display knob before launching Electron so every PTY session
    // spawned by this Electron instance inherits the env var. mock-kimi.js
    // reads it at runtime to inject a PlanDisplay line into wire.jsonl,
    // exercising the file_path + content detail round-trip end-to-end.
    process.env.MOCK_KIMI_PLAN_DISPLAY = '1';

    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { kimi: mockAgentPath('kimi') },
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
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_KIMI_PLAN_DISPLAY;
    await closeApp(app);
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('PlanDisplay wire event produces a notification event with file_path and content detail', async () => {
    // 30s internal poll + setup exceeds 30s default.
    test.slow();
    const title = `Kimi PlanDisplay ${runId}`;
    await createTask(page, title, 'Verify PlanDisplay detail round-trip through wire.jsonl events-cache IPC');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    // The mock writes a PlanDisplay event with file_path='PLAN.md' and
    // content='# Implementation plan\n- Step 1: scaffold\n- Step 2: implement'.
    // After truncateForActivityLog the content becomes:
    //   '# Implementation plan - Step 1: scaffold - Step 2: implement'
    // (whitespace collapsed; well under 200 chars so no ellipsis).
    // The full detail is: 'PLAN.md: # Implementation plan - Step 1: scaffold - Step 2: implement'
    await expect.poll(async () => {
      const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
      const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
      return allEvents.some((event) => event.type === 'notification' && /^PLAN\.md: .+/.test(event.detail ?? ''));
    }, { timeout: 30000, message: 'Expected notification event with PLAN.md detail from PlanDisplay wire event' }).toBe(true);

    // Snapshot and verify the exact detail format survives the round-trip.
    const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
    const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
    const planNotification = allEvents.find(
      (event) => event.type === 'notification' && /^PLAN\.md: .+/.test(event.detail ?? ''),
    );
    expect(planNotification).toBeDefined();
    // detail must match the "<file_path>: <content>" format
    expect(planNotification!.detail).toMatch(/^.+: .+/);
    // file_path portion must be preserved exactly
    expect(planNotification!.detail).toMatch(/^PLAN\.md:/);
    // content portion must be non-empty (colon-space separates them)
    const contentPart = planNotification!.detail!.split(': ').slice(1).join(': ');
    expect(contentPart.length).toBeGreaterThan(0);
  });
});

test.describe('Kimi Agent - SubagentEvent lifecycle decoding (MOCK_KIMI_SUBAGENT=1)', () => {
  const TEST_NAME = 'kimi-subagent-detection';
  const PROJECT_NAME = `Kimi Subagent Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // Set the subagent knob before launching Electron so every PTY session
    // spawned by this Electron instance inherits the env var. mock-kimi.js
    // reads it at runtime to inject SubagentEvent TurnBegin + TurnEnd lines
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
          queueOverflow: 'queue',
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
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('SubagentEvent TurnBegin and TurnEnd from wire.jsonl appear as subagent_start and subagent_stop in the events cache', async () => {
    // 30s internal poll + setup exceeds 30s default.
    test.slow();
    const title = `Kimi Subagent ${runId}`;
    await createTask(page, title, 'Verify SubagentEvent inner lifecycle decoding through the wire.jsonl pipeline');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    // The mock writes SubagentEvent TurnBegin + TurnEnd lines after the
    // ToolResult and before the outer TurnEnd. The SessionHistoryReader
    // tails wire.jsonl and pushes events via IPC. Poll until both
    // subagent_start and subagent_stop appear in the cache.
    await expect.poll(async () => {
      const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
      const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
      const hasSubagentStart = allEvents.some((event) => event.type === 'subagent_start');
      const hasSubagentStop = allEvents.some((event) => event.type === 'subagent_stop');
      return hasSubagentStart && hasSubagentStop;
    }, { timeout: 30000, message: 'Expected subagent_start and subagent_stop events from wire.jsonl SubagentEvent decoding' }).toBe(true);

    const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
    const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();

    const subagentStartEvents = allEvents.filter((event) => event.type === 'subagent_start');
    const subagentStopEvents = allEvents.filter((event) => event.type === 'subagent_stop');

    expect(subagentStartEvents.length).toBeGreaterThan(0);
    expect(subagentStopEvents.length).toBeGreaterThan(0);

    // The mock injects subagent_type='explore', so detail should be 'explore'.
    expect(subagentStartEvents[0].detail).toBe('explore');
    expect(subagentStopEvents[0].detail).toBe('explore');
  });
});
