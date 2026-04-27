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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState, SessionUsage, SessionEvent } from '../../src/shared/types';

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
    await app?.close();
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

  test('session history reader delivers usage data from wire.jsonl', async () => {
    const title = `Kimi Usage ${runId}`;
    await createTask(page, title, 'Verify wire.jsonl pipeline delivers token + context telemetry');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    // The mock writes a wire.jsonl containing a StatusUpdate with
    // context_usage=0.12, max_context_tokens=200000, and a token_usage
    // payload (input_other=800, output=150, cache_read=1024,
    // cache_creation=256). After the file watcher catches up, getUsage()
    // should expose the parsed snapshot.
    await expect.poll(async () => {
      const usageMap = await page.evaluate(() => window.electronAPI.sessions.getUsage());
      const usages = Object.values(usageMap as Record<string, SessionUsage>);
      return usages.some((usage) => usage.contextWindow.contextWindowSize > 0);
    }, { timeout: 30000, message: 'Expected wire.jsonl-derived usage with contextWindowSize > 0' }).toBe(true);

    const usageMap = await page.evaluate(() => window.electronAPI.sessions.getUsage());
    const usages = Object.values(usageMap as Record<string, SessionUsage>);
    const kimiUsage = usages.find((usage) => usage.contextWindow.contextWindowSize > 0);
    expect(kimiUsage).toBeDefined();
    expect(kimiUsage!.contextWindow.contextWindowSize).toBe(200000);
    // input_other(800) + cache_read(1024) + cache_creation(256) = 2080
    expect(kimiUsage!.contextWindow.totalInputTokens).toBe(2080);
    expect(kimiUsage!.contextWindow.totalOutputTokens).toBe(150);
    expect(kimiUsage!.contextWindow.usedPercentage).toBeGreaterThan(0);
  });

  test('tool events from wire.jsonl appear in the events cache', async () => {
    const title = `Kimi Tools ${runId}`;
    await createTask(page, title, 'Verify ToolCall/ToolResult parsing into events cache');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    await expect.poll(async () => {
      const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
      const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
      return allEvents.filter((event) => event.type === 'tool_start').length > 0;
    }, { timeout: 30000, message: 'Expected tool_start event from wire.jsonl ToolCall' }).toBe(true);

    const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
    const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
    const toolStarts = allEvents.filter((event) => event.type === 'tool_start');
    const toolEnds = allEvents.filter((event) => event.type === 'tool_end');
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolEnds.length).toBeGreaterThan(0);
    expect(toolStarts[0].detail).toBe('Shell');
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
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('SubagentEvent TurnBegin and TurnEnd from wire.jsonl appear as subagent_start and subagent_stop in the events cache', async () => {
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
