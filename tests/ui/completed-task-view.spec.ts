/**
 * UI tests for the completed task view (an archived task's window) and the
 * Done column's completed section.
 *
 * Covers: the header strip and its status, the Summary / Changes /
 * Conversation / Usage / Description tabs and their keyboard, a failed report
 * read, the summary states and when the last message is read, the Conversation
 * tab, the Route, Commits and Files changed cards, the Runs table (its Total
 * row, repeat columns) and its per-tool
 * popover (which fetches nothing), the Models and tokens card (ledger and
 * fallback), Background calls, the Completed Tasks dialog's Agent runtime
 * column, and the Done column's section.
 *
 * Every Total row reads `report.totals`, which main computes
 * (`assembleTaskReport`). A report seeded here carries totals written by hand,
 * so these tests pin how a total is shown (a null as a dash); the arithmetic,
 * such as a shared call counting once, is pinned in task-report-assemble.test.ts.
 *
 * "Was never called" checks wrap the bridge method with `recordBridgeCalls` and
 * read the recorded arguments; each is paired with a state that does call it.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, settleFrames, toastCountRightNow } from './helpers';
import {
  launch as launchMonitorSeed,
  openMonitor,
  sessionIdOf,
  byTestId as monitorByTestId,
} from './monitor-writes-seed';

// Each test launches its own browser, so the file fans out across UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-completed-test';
const TASK_ID = 'task-completed-1';
const SESSION_ID = 'abc12345-6789-4def-abcd-000000000001';
/** The app window's minimum width (`minWidth` in src/main/index.ts), where the strip is tightest. */
const NARROW_WINDOW_WIDTH = 900;

interface ToolRow {
  toolName: string;
  callCount: number;
  totalDurationMs: number;
  interruptedCount: number;
  waitedCount?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  resultTokens?: number;
}

/** Build a pre-configure script with an archived task and optional summary, report and last message. */
function makePreConfig(options: {
  withSummary: boolean;
  exitCode?: number | null;
  extraArchivedTasks?: number;
  compactions?: number;
  toolBreakdown?: ToolRow[];
  /** A full TaskReport to serve instead of the one the mock derives from the summary. */
  report?: object;
  /** The written task summary; omitted reads as summaries off. */
  writtenSummary?: string;
  lastMessage?: { text: string; writtenAt: string | null };
  prNumber?: number;
  /** Seeds `config.knowledgeGraph`; unset leaves the Knowledge Graph off, which reads as summaries off. */
  knowledgeGraph?: Record<string, unknown>;
  /** The task's past sessions as `transcripts.listSessions` serves them; unset reads as no history. */
  transcriptSessions?: object[];
  /** The task's conversation, as `transcripts.get` serves it for every one of `transcriptSessions`. */
  transcript?: object;
}): string {
  const exitCode = options.exitCode !== undefined ? options.exitCode : 0;
  const summaryBlock = options.withSummary
    ? `
      state.summaryCache['${TASK_ID}'] = {
        sessionId: '${SESSION_ID}',
        totalCostUsd: 0.08,
        totalInputTokens: 12500,
        totalOutputTokens: 545,
        modelDisplayName: 'Opus 4.6',
        durationMs: 17000,
        toolCallCount: 5,
        compactionCount: ${options.compactions ?? 0},
        linesAdded: 469,
        linesRemoved: 181,
        filesChanged: 18,
        taskCreatedAt: '2026-03-13T15:40:00.000Z',
        startedAt: '2026-03-13T15:44:00.000Z',
        exitedAt: '2026-03-13T15:45:00.000Z',
        exitCode: ${exitCode === null ? 'null' : exitCode},
        toolBreakdown: ${JSON.stringify(options.toolBreakdown ?? [])},
      };
    `
    : '';
  const reportBlock = options.report ? `state.taskReportCache['${TASK_ID}'] = ${JSON.stringify(options.report)};` : '';
  const lastMessageBlock = options.lastMessage ? `state.taskLastMessages['${TASK_ID}'] = ${JSON.stringify(options.lastMessage)};` : '';
  const memoryBlock = options.writtenSummary !== undefined
    ? `memoryTaskSummaries: { '${TASK_ID}': ${JSON.stringify(options.writtenSummary)} },`
    : '';
  const knowledgeGraphBlock = options.knowledgeGraph ? `state.config.knowledgeGraph = ${JSON.stringify(options.knowledgeGraph)};` : '';
  const transcriptSeeds = options.transcript
    ? Object.fromEntries((options.transcriptSessions ?? []).map((meta) => [(meta as { sessionId: string }).sessionId, options.transcript]))
    : null;
  const transcriptBlock = [
    options.transcriptSessions ? `transcriptSessionsByTask: { '${TASK_ID}': ${JSON.stringify(options.transcriptSessions)} },` : '',
    transcriptSeeds ? `transcriptSeeds: ${JSON.stringify(transcriptSeeds)},` : '',
  ].join(' ');

  let extraTasksBlock = '';
  for (let index = 0; index < (options.extraArchivedTasks ?? 0); index++) {
    const extraId = `task-extra-${index}`;
    extraTasksBlock += `
      state.archivedTasks.push({
        id: '${extraId}', title: 'Extra Task ${index + 1}', description: 'Description for extra task ${index + 1}',
        swimlane_id: doneLane.id, position: ${index + 1}, agent: null, session_id: null, worktree_path: null,
        branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: null,
        attachment_count: 0, archived_at: ts, created_at: ts, updated_at: ts,
      });
      state.summaryCache['${extraId}'] = {
        sessionId: state.uuid(), totalCostUsd: ${(0.02 * (index + 1)).toFixed(2)},
        totalInputTokens: ${1000 * (index + 1)}, totalOutputTokens: ${200 * (index + 1)},
        modelDisplayName: 'Opus 4.6', durationMs: ${5000 * (index + 1)}, toolCallCount: ${index + 1},
        compactionCount: 0, linesAdded: ${10 * (index + 1)}, linesRemoved: ${5 * (index + 1)},
        filesChanged: ${index + 1}, taskCreatedAt: '2026-03-13T14:${String(50 + index).padStart(2, '0')}:00.000Z',
        startedAt: '2026-03-13T15:00:00.000Z', exitedAt: '2026-03-13T15:${String(index + 1).padStart(2, '0')}:00.000Z',
        exitCode: 0, toolBreakdown: [],
      };
    `;
  }

  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Completed Test', path: '/mock/completed-test', github_url: null,
        default_agent: 'claude', position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push({
          id: state.uuid(), name: template.name, role: template.role, color: template.color, icon: template.icon,
          is_archived: template.is_archived, is_ghost: template.is_ghost,
          permission_strategy: template.permission_strategy ?? null, auto_spawn: template.auto_spawn ?? false,
          auto_command: template.auto_command ?? null, plan_exit_target_id: null, position: index, created_at: ts,
        });
      });
      var doneLane = state.swimlanes.find(function (lane) { return lane.role === 'done'; });
      state.archivedTasks.push({
        id: '${TASK_ID}', title: 'Completed Test Task', description: 'A task that has been completed',
        swimlane_id: doneLane.id, position: 0, agent: null, session_id: null, worktree_path: null,
        branch_name: null, pr_number: ${options.prNumber ?? 'null'},
        pr_url: ${options.prNumber ? `'https://example.com/pull/${options.prNumber}'` : 'null'},
        pr_state: ${options.prNumber ? "'merged'" : 'null'}, base_branch: null, use_worktree: null,
        attachment_count: 0, archived_at: ts, created_at: ts, updated_at: ts,
      });
      ${summaryBlock}
      ${reportBlock}
      ${lastMessageBlock}
      ${knowledgeGraphBlock}
      ${extraTasksBlock}
      return { currentProjectId: '${PROJECT_ID}', ${memoryBlock} ${transcriptBlock} };
    });
  `;
}

async function openCompletedTask(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('text=Completed Test Task').click();
  await expect(page.locator('[data-testid="completed-task-view"]')).toBeVisible({ timeout: 5000 });
}

async function openUsageTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.locator('[data-testid="completed-panel-usage"]')).toBeVisible();
}

/**
 * Wrap bridge methods (`'sessions.getTaskLastMessage'`) so each call's arguments
 * are recorded on the page while the original still runs. Install it after the
 * page loads and before the step under test: the renderer reads
 * `window.electronAPI.<namespace>.<method>` at call time, so a late wrap is seen.
 */
async function recordBridgeCalls(page: Page, qualifiedNames: string[]): Promise<void> {
  await page.evaluate((names) => {
    const scope = window as unknown as {
      electronAPI: Record<string, Record<string, (...args: unknown[]) => unknown>>;
      __recordedBridgeCalls: Record<string, unknown[][]>;
    };
    scope.__recordedBridgeCalls = {};
    for (const qualifiedName of names) {
      const [namespace, method] = qualifiedName.split('.');
      const original = scope.electronAPI[namespace][method];
      scope.electronAPI[namespace][method] = (...args: unknown[]) => {
        (scope.__recordedBridgeCalls[qualifiedName] ??= []).push(args);
        return original.apply(scope.electronAPI[namespace], args);
      };
    }
  }, qualifiedNames);
}

/** The arguments of every recorded call to one wrapped bridge method, oldest first. */
async function bridgeCalls(page: Page, qualifiedName: string): Promise<unknown[][]> {
  return page.evaluate(
    (name) => (window as unknown as { __recordedBridgeCalls: Record<string, unknown[][]> }).__recordedBridgeCalls[name] ?? [],
    qualifiedName,
  );
}

/** Forget the recorded calls, keeping the wrappers installed. */
async function resetBridgeCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __recordedBridgeCalls: Record<string, unknown[][]> }).__recordedBridgeCalls = {};
  });
}

/**
 * Two animation frames: React has committed and flushed its passive effects for
 * everything rendered so far. It is how a "was never called" check knows an
 * effect that would have called has had its chance, without a timed wait.
 */
async function flushRenderer(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

const COLUMN = (swimlaneId: string, name: string, color: string) => ({ swimlaneId, name, color, icon: null, role: null });
const PLANNING = COLUMN('lane-planning', 'Planning', '#8b5cf6');
const EXECUTING = COLUMN('lane-executing', 'Executing', '#3b82f6');
const REVIEW = COLUMN('lane-review', 'Code Review', '#f59e0b');

/** One run of a conversation. A null cost or runtime is a figure the run never recorded. */
function reportRun(
  recordId: string,
  startedAt: string,
  costUsd: number | null,
  runtimeMs: number | null,
  toolCallCount: number,
  columns: object[],
  extra: object = {},
) {
  return {
    recordId, agent: 'claude', startedAt, exitCode: null as number | null, model: 'Opus 5.5', effort: 'xhigh', permissionMode: 'plan',
    costUsd, runtimeMs, toolCallCount, compactionCount: 0, toolBreakdown: [], columns, ...extra,
  };
}

/** `fullReport`'s Total rows, as main computes them from its runs, ledger and calls. */
const FULL_REPORT_TOTALS = {
  // The three runs: 1.85 + 24.19 + 16.74, and 722,000 + 3,900,000 + 1,415,000 ms.
  runs: { runCount: 3, runtimeMs: 6_037_000, costUsd: 42.78, toolCallCount: 538, compactionCount: 1 },
  models: { turns: 248, freshInputTokens: 524, cacheWriteTokens: 1_187_000, cacheReadTokens: 78_240_000, outputTokens: 266_900 },
  // The title, call-1 once (it answered two automations), and call-2.
  backgroundCalls: { durationMs: 37_500, costUsd: 0.007, tokens: 25_900 },
};

/** A report in #797's shape: a route with a repeat column, two conversations, the ledger, and fired calls. */
function fullReport(overrides: Record<string, unknown> = {}) {
  const summary = {
    sessionId: SESSION_ID, totalCostUsd: 47.58, totalInputTokens: 93_000_000, totalOutputTokens: 282_000,
    modelDisplayName: 'Opus 5.5', durationMs: 7_020_000, toolCallCount: 630, compactionCount: 1,
    linesAdded: 789, linesRemoved: 103, filesChanged: 13, taskCreatedAt: '2026-10-13T03:00:00.000Z',
    startedAt: '2026-10-13T03:04:00.000Z', exitedAt: '2026-10-13T05:03:00.000Z', exitCode: 0,
    toolBreakdown: [{ toolName: 'Read', callCount: 82, totalDurationMs: 13_100, interruptedCount: 0 }],
  };
  const run = reportRun;
  return {
    summary,
    startedAt: '2026-10-13T03:04:00.000Z',
    endedAt: '2026-10-13T05:03:00.000Z',
    route: [
      { ...PLANNING, totalMs: 1_200_000, visits: [{ startedAt: '2026-10-13T03:04:00.000Z', durationMs: 1_200_000 }] },
      {
        ...EXECUTING, totalMs: 3_600_000, visits: [
          { startedAt: '2026-10-13T03:24:00.000Z', durationMs: 3_000_000 },
          { startedAt: '2026-10-13T04:30:00.000Z', durationMs: 600_000 },
          { startedAt: '2026-10-13T04:45:00.000Z', durationMs: 20_000 },
        ],
      },
      { ...REVIEW, totalMs: 1_440_000, visits: [{ startedAt: '2026-10-13T04:14:00.000Z', durationMs: 1_440_000 }] },
    ],
    conversations: [
      {
        conversationId: '0407afe2-1111-2222-3333-444444444444', isolatedColumn: null, runs: [
          run('leg-1', '2026-10-13T03:04:00.000Z', 1.85, 722_000, 23, [PLANNING]),
          run('leg-2', '2026-10-13T03:18:00.000Z', 24.19, 3_900_000, 241, [PLANNING, EXECUTING], {
            compactionCount: 1,
            toolBreakdown: [
              { toolName: 'Edit', callCount: 61, totalDurationMs: 8_900, interruptedCount: 0 },
              { toolName: 'Grep', callCount: 38, totalDurationMs: 9_400, interruptedCount: 0 },
            ],
          }),
        ],
      },
      {
        conversationId: '096842a0-5555-6666-7777-888888888888', isolatedColumn: REVIEW, runs: [
          run('review-1', '2026-10-13T04:14:00.000Z', 16.74, 1_415_000, 274, [REVIEW], { permissionMode: 'auto' }),
        ],
      },
    ],
    models: [
      { model: 'Opus 5.5', subagent: null, turns: 237, freshInputTokens: 498, cacheWriteTokens: 984_000, cacheReadTokens: 76_600_000, outputTokens: 233_000 },
      { model: 'Haiku 5.5', subagent: 'doc-auditor', turns: 11, freshInputTokens: 26, cacheWriteTokens: 203_000, cacheReadTokens: 1_640_000, outputTokens: 33_900 },
    ],
    modelFallback: [],
    backgroundCalls: [
      { callId: 'call-title', job: 'task_title', column: null, automationName: null, automationType: null, condition: null, outcome: null, reason: null, startedAt: '2026-10-13T03:03:00.000Z', model: 'Haiku 5.5', effort: 'low', durationMs: 2_400, costUsd: 0.001, tokens: 2_100 },
      { callId: 'call-1', job: 'condition_check', column: EXECUTING, automationName: 'Apply findings', automationType: 'send_message', condition: 'The final message lists findings.', outcome: 'ran', reason: 'The reply lists two findings.', startedAt: '2026-10-13T04:10:00.000Z', model: 'Haiku 5.5', effort: 'low', durationMs: 5_100, costUsd: 0.004, tokens: 14_800 },
      // The same check answered a second automation, not met: its call counts once in the Total.
      { callId: 'call-1', job: 'condition_check', column: EXECUTING, automationName: 'On to Code Review', automationType: 'move_to_column', condition: 'The work is finished.', outcome: 'skipped', reason: 'The reply still lists findings to apply.', startedAt: '2026-10-13T04:10:00.000Z', model: 'Haiku 5.5', effort: 'low', durationMs: 5_100, costUsd: 0.004, tokens: 14_800 },
      { callId: 'call-2', job: 'condition_check', column: REVIEW, automationName: 'On to Testing', automationType: 'move_to_column', condition: 'The verdict reads Ready.', outcome: 'error', reason: 'The Automation agent could not check the condition: timed out', startedAt: '2026-10-13T04:37:00.000Z', model: 'Haiku 5.5', effort: 'low', durationMs: 30_000, costUsd: 0.002, tokens: 9_000 },
    ],
    totals: FULL_REPORT_TOTALS,
    knowledge: {
      commits: [{ sha: 'f9a8d40aabbccdd', subject: 'fix(terminal): drop the blank bottom strip', committedAt: '2026-10-13T05:03:00.000Z' }],
      commitCount: 1,
      changedFiles: Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`),
      changedFileCount: 10,
    },
    summaryState: { kind: 'written', text: 'Fixed the blank bottom strip.' },
    ...overrides,
  };
}

/**
 * `fullReport`'s conversation, one turn in each stay of its route (Planning
 * 03:04, Executing 03:24, Code Review 04:14, Executing again 04:30), served for
 * either of the task's two sessions.
 */
function routeConversation() {
  const meta = (sessionId: string, startedAt: string) => ({ sessionId, agentName: 'Claude Code', startedAt, exitedAt: startedAt, isolatedSwimlaneId: null, status: 'exited' });
  const timestampAt = (time: string) => Date.parse(`2026-10-13T${time}:00.000Z`);
  const say = (uuid: string, time: string, text: string) => ({ kind: 'assistant', uuid, ts: timestampAt(time), model: 'claude-opus-5-5', blocks: [{ type: 'text', text }] });
  const transcriptSessions = [meta('sess-older', '2026-10-13T03:04:00.000Z'), meta('sess-newest', '2026-10-13T04:14:00.000Z')];
  return {
    transcriptSessions,
    transcript: {
      sessionId: 'sess-newest', taskId: TASK_ID, taskTitle: 'Completed Test Task', agentName: 'Claude Code',
      startedAt: '2026-10-13T03:04:00.000Z', sessionStatus: 'exited', source: 'live', sourcePath: '/mock/completed.jsonl',
      entries: [
        { kind: 'user', uuid: 'turn-planning', ts: timestampAt('03:05'), text: 'PLANNING_TURN' },
        say('turn-executing-first', '03:30', 'EXECUTING_FIRST'),
        say('turn-review', '04:20', 'REVIEW_TURN'),
        say('turn-executing-second', '04:35', 'EXECUTING_SECOND'),
      ],
      degraded: false,
      sessions: transcriptSessions,
    },
  };
}

test.describe('Completed task view', () => {
  test('the header strip reads the task and its status, and the Summary tab is selected', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, prNumber: 550 }));
    try {
      await openCompletedTask(page);
      const strip = page.locator('[data-testid="completed-header-strip"]');
      await expect(strip.locator('[data-testid="completed-metric-started"]')).toContainText('Started');
      await expect(strip.locator('[data-testid="completed-metric-ended"]')).toContainText('Ended');
      await expect(strip.locator('[data-testid="completed-metric-elapsed"]')).toContainText('1m');
      await expect(strip.locator('[data-testid="completed-metric-agent-runtime"]')).toContainText('17s');
      await expect(strip.locator('[data-testid="completed-metric-changes"]')).toContainText('+469');
      await expect(strip.locator('[data-testid="completed-metric-changes"]')).toContainText('-181');
      await expect(strip.locator('[data-testid="completed-metric-changes"]')).toContainText('18 files');
      await expect(strip.locator('[data-testid="completed-metric-pull-request"]')).toContainText('#550');
      await expect(strip.locator('[data-testid="completed-metric-pull-request"]')).toContainText('merged');
      await expect(strip.locator('[data-testid="completed-metric-cost"]')).toContainText('$0.08');
      await expect(page.locator('[data-testid="completed-status"]')).toHaveAttribute('aria-label', 'Completed');
      await expect(page.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await browser.close();
    }
  });

  /**
   * Open the completed task at full width (a narrow board folds the Done
   * column's list away), then narrow the page and wait for the strip to take the
   * new width. The window gives up the room the page lost, so a bound the strip
   * already met at full width would let a check run before the container query
   * has reacted to anything.
   */
  async function narrowStrip(page: Page): Promise<Locator> {
    await openCompletedTask(page);
    const strip = page.locator('[data-testid="completed-header-strip"]');
    const stripWidth = () => strip.evaluate((element) => element.getBoundingClientRect().width);
    const widthBefore = await stripWidth();
    await page.setViewportSize({ width: NARROW_WINDOW_WIDTH, height: 700 });
    await expect.poll(stripWidth).toBeLessThan(Math.min(widthBefore, NARROW_WINDOW_WIDTH));
    return strip;
  }

  test('at a narrow window the strip keeps every figure and leaves the moments to Elapsed', async () => {
    // The guard for the overflow test below: it sets up the same narrow strip and
    // fails loudly if the fixture, the shrink, or the metrics are not what that
    // test assumes. Under 640px the strip drops Started and Ended and keeps the
    // span in Elapsed's tooltip.
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, prNumber: 550 }));
    try {
      const strip = await narrowStrip(page);
      await expect(strip.locator('[data-testid^="completed-metric-"]')).toHaveCount(7);
      for (const key of ['elapsed', 'agent-runtime', 'changes', 'pull-request', 'cost']) {
        await expect(strip.locator(`[data-testid="completed-metric-${key}"]`)).toBeVisible();
      }
      await expect(strip.locator('[data-testid="completed-metric-started"]')).toBeHidden();
      await expect(strip.locator('[data-testid="completed-metric-ended"]')).toBeHidden();
      await expect(strip.locator('[data-testid="completed-metric-elapsed"]')).toHaveAccessibleDescription(/ to /);
      await expect(page.locator('[data-testid="completed-status"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('at a narrow window the last metric and the status stay inside the strip', async () => {
    // At a 900px page the task window scales to about 520px. Seven metrics and
    // the status need about 720px, so before the strip dropped Started and Ended
    // at that width, Cost and the status ended past its right edge and
    // `overflow-hidden` clipped them.
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, prNumber: 550 }));
    try {
      const strip = await narrowStrip(page);
      // A row that cannot wrap and clips (`overflow-hidden`) keeps every metric
      // on one line at any width, so line position proves nothing. What shows a
      // metric or the status pushed past the edge is its right edge against the
      // strip's own, which the clip leaves unchanged. A pixel of tolerance
      // absorbs sub-pixel rounding between platforms.
      const overflowOf = (selector: string) => strip.evaluate((stripElement, targetSelector) => {
        const targets = Array.from(stripElement.querySelectorAll(targetSelector));
        const lastTarget = targets[targets.length - 1];
        return lastTarget
          ? lastTarget.getBoundingClientRect().right - stripElement.getBoundingClientRect().right
          : Number.NaN;
      }, selector);
      await expect.poll(() => overflowOf('[data-testid^="completed-metric-"]')).toBeLessThanOrEqual(1);
      await expect.poll(() => overflowOf('[data-testid="completed-status"]')).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });

  test('at a narrow window all five tabs fit their row', async () => {
    // The task window scales to about 520px at the 900px floor; the five tab
    // names never shrink (`flex-shrink-0`), so the last one is what overflows
    // first. A pixel of tolerance absorbs sub-pixel rounding.
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, prNumber: 550 }));
    try {
      await narrowStrip(page);
      const row = page.locator('[data-testid="completed-task-tabs"]');
      await expect(row.getByRole('tab')).toHaveCount(5);
      const overflow = await row.evaluate((rowElement) => {
        const tabs = Array.from(rowElement.querySelectorAll('[role="tab"]'));
        return tabs[tabs.length - 1].getBoundingClientRect().right - rowElement.getBoundingClientRect().right;
      });
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });

  // One app launch per test. These were a single test that launched two browsers
  // inside one 15s budget, which a starved CI runner overran (passed on retry,
  // so --fail-on-flaky-tests failed the shard).
  test('a non-zero exit reads Exited with its code', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, exitCode: 1 }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-status"]')).toHaveAttribute('aria-label', 'Exited (1)');
    } finally {
      await browser.close();
    }
  });

  test('a null exit reads Completed', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, exitCode: null }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-status"]')).toHaveAttribute('aria-label', 'Completed');
    } finally {
      await browser.close();
    }
  });

  test('the arrow keys, Home and End move between tabs and select them', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      await openCompletedTask(page);
      const summaryTab = page.getByRole('tab', { name: 'Summary' });
      await expect(page.getByRole('tab')).toHaveText(['Summary', 'Changes', 'Conversation', 'Usage', 'Description']);
      await summaryTab.focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'Changes' })).toBeFocused();
      await expect(page.locator('[data-testid="completed-panel-changes"]')).toBeVisible();
      await page.keyboard.press('End');
      await expect(page.getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-testid="completed-panel-description"]')).toContainText('A task that has been completed');
      await page.keyboard.press('ArrowRight');
      await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('tabindex', '-1');
    } finally {
      await browser.close();
    }
  });

  test('with summaries off, the summary card says so, offers Settings, and shows the last message', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      lastMessage: { text: 'PR #552 is **merged** into main.', writtenAt: null },
    }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-summary-state-off"]')).toContainText('Task summaries are off');
      await expect(page.locator('[data-testid="completed-summary-open-settings"]')).toBeVisible();
      await expect(page.locator('[data-testid="completed-last-message"]')).toContainText('PR #552 is merged into main.');
    } finally {
      await browser.close();
    }
  });

  test('with summaries on and no agent chosen, the summary card names what is missing', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, knowledgeGraph: { enabled: true } }));
    try {
      await openCompletedTask(page);
      const line = page.locator('[data-testid="completed-summary-state-pending"]');
      await expect(line).toContainText(/Needs (an agent|a supported agent|a model)/);
      await expect(line).not.toContainText('Summary pending');
      await expect(page.locator('[data-testid="completed-summary-open-settings"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a written summary is shown, and the last message is never read', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      writtenSummary: 'Fixed the blank strip under the board.',
      lastMessage: { text: 'Should not show', writtenAt: null },
    }));
    try {
      await recordBridgeCalls(page, ['sessions.getTaskLastMessage']);
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-task-summary-text"]')).toHaveText('Fixed the blank strip under the board.');
      await expect(page.locator('[data-testid="completed-last-message"]')).toHaveCount(0);
      // A transcript is parsed only for a view that shows its last message, so
      // a written summary reads none. The count is checked once the card has
      // rendered and its effects have run, so an absent call is not just an early look.
      await flushRenderer(page);
      expect(await bridgeCalls(page, 'sessions.getTaskLastMessage')).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a pending summary reads the last message for this task and project', async () => {
    // The converse of the written case, and the control that shows the counter
    // counts: the same recorder sees a call here.
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      knowledgeGraph: { enabled: true },
      lastMessage: { text: 'PR #552 is **merged** into main.', writtenAt: null },
    }));
    try {
      await recordBridgeCalls(page, ['sessions.getTaskLastMessage']);
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-last-message"]')).toContainText('PR #552 is merged into main.');
      // At least one read, never none; the dev renderer runs under StrictMode, which
      // mounts an effect twice, so the exact count is not the contract.
      const calls = await bridgeCalls(page, 'sessions.getTaskLastMessage');
      expect(calls.length).toBeGreaterThan(0);
      for (const callArguments of calls) expect(callArguments).toEqual([PROJECT_ID, TASK_ID]);
    } finally {
      await browser.close();
    }
  });

  test('a summary state with no last message on record shows the state and no Last message block', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      await recordBridgeCalls(page, ['sessions.getTaskLastMessage']);
      await openCompletedTask(page);
      // The state line proves the card rendered and asked: the Last message
      // block carries a skeleton while the read is out, so the count of 0
      // below only holds once the read has answered null.
      await expect(page.locator('[data-testid="completed-summary-state-off"]')).toContainText('Task summaries are off');
      await expect(page.locator('[data-testid="completed-last-message"]')).toHaveCount(0);
      expect((await bridgeCalls(page, 'sessions.getTaskLastMessage')).length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  test('with Knowledge Graph indexing off, the summary card says so and offers Settings', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      knowledgeGraph: { enabled: true, indexingEnabled: false },
    }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-summary-state-indexing-off"]')).toContainText('Knowledge Graph indexing is off');
      await expect(page.locator('[data-testid="completed-summary-open-settings"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a summary that is pending with nothing missing reads Summary pending and offers no Settings', async () => {
    // The Knowledge Graph on, with an installed agent that can answer and the
    // model it takes: no requirement left, so the card says only that it waits.
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      knowledgeGraph: { enabled: true, agent: 'claude', model: 'opus' },
    }));
    try {
      await openCompletedTask(page);
      const line = page.locator('[data-testid="completed-summary-state-pending"]');
      await expect(line).toContainText('Summary pending');
      await expect(line).not.toContainText('Needs');
      await expect(page.locator('[data-testid="completed-summary-open-settings"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // The local model has no Intel macOS build, so a summary there is never written. The card reads
  // Unavailable, never "Summary pending" or a prerequisite no click can meet, even with the config
  // carrying everything a supported machine would need (copied from another one).
  test('on an Intel Mac a pending summary reads Unavailable, over a config that would otherwise be ready', async () => {
    const intelMac = "window.__mockPlatform = 'darwin'; window.__mockArch = 'x64';";
    const { browser, page } = await launchWithState(`${intelMac}\n${makePreConfig({
      withSummary: true,
      knowledgeGraph: { enabled: true, agent: 'claude', model: 'opus' },
    })}`);
    try {
      await openCompletedTask(page);
      const line = page.locator('[data-testid="completed-summary-state-pending"]');
      await expect(line).toContainText('Unavailable');
      await expect(line).not.toContainText('Summary pending');
    } finally {
      await browser.close();
    }
  });

  test('a failed report read says the record could not be read and shows no header strip', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      await page.evaluate(() => {
        (window as unknown as {
          electronAPI: { sessions: { getTaskReport: () => Promise<never> } };
        }).electronAPI.sessions.getTaskReport = () => Promise.reject(new Error('mock report read failure'));
      });
      await openCompletedTask(page);
      // The message first: the strip is also absent while the read is out, so
      // its absence only means a failure once the failure has been shown.
      await expect(page.locator('[data-testid="completed-panel-summary"]')).toContainText('Could not read this task\'s record');
      await expect(page.locator('[data-testid="completed-report-loading"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="completed-header-strip"]')).toHaveCount(0);
      // The description is the task's own and needs no report.
      await page.getByRole('tab', { name: 'Description' }).click();
      await expect(page.locator('[data-testid="completed-panel-description"]')).toContainText('A task that has been completed');
    } finally {
      await browser.close();
    }
  });

  test('the Conversation tab reads the newest session of this task with the host project, in the view itself', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport(), ...routeConversation() }));
    try {
      await recordBridgeCalls(page, ['transcripts.listSessions', 'transcripts.get']);
      await openCompletedTask(page);
      // The header asks once on mount whether there is any history; only the tab's calls count.
      await resetBridgeCalls(page);
      await page.getByRole('tab', { name: 'Conversation' }).click();
      const panel = page.locator('[data-testid="completed-panel-conversation"]');
      await expect(panel.getByText('REVIEW_TURN')).toBeVisible({ timeout: 5000 });
      // The tab is the conversation viewer's body; no window opens for it.
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);
      const listCalls = await bridgeCalls(page, 'transcripts.listSessions');
      expect(listCalls.length).toBeGreaterThan(0);
      for (const callArguments of listCalls) expect(callArguments).toEqual([TASK_ID, PROJECT_ID]);
      // Anchored on the newest of the task's sessions, as the window's opener
      // picks one when none is live.
      const getCalls = await bridgeCalls(page, 'transcripts.get');
      expect(getCalls.length).toBeGreaterThan(0);
      for (const [request] of getCalls) expect(request).toMatchObject({ sessionId: 'sess-newest', projectId: PROJECT_ID });
    } finally {
      await browser.close();
    }
  });

  test('the Conversation tab on a task with no session history says so in one line and opens nothing', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      await openCompletedTask(page);
      await page.getByRole('tab', { name: 'Conversation' }).click();
      await expect(page.locator('[data-testid="completed-conversation-empty"]')).toHaveText('This task has no conversation history');
      expect(await toastCountRightNow(page)).toBe(0);
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the Route lists each column, with visit cards only under a column with two real stays', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await openCompletedTask(page);
      const route = page.locator('[data-testid="completed-route"]');
      await expect(route.locator('[data-testid="route-column-pill"]')).toHaveCount(3);
      await expect(route.locator('[data-testid="route-column-pill"][data-swimlane-name="Executing"]')).toContainText('1h');
      // Executing's 20s pass is not a stay, so it has two cards, and the single-visit columns none.
      await expect(route.locator('[data-testid="route-visit"]')).toHaveCount(2);
      await expect(page.locator('[data-testid="completed-commits"]')).toContainText('f9a8d40');
      // Git has none of this task's commits (the mock's default), so the Files
      // card falls back to the index's names: every one of them, in a box that
      // scrolls past about eight rows, with no Show all.
      await expect(page.locator('[data-testid="completed-changed-file"]')).toHaveCount(10);
      await expect(page.locator('[data-testid="completed-files-toggle"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Commits says how many of the total it lists only when some are left out', async () => {
    const commit = { sha: 'f9a8d40aabbccdd', subject: 'fix(terminal): drop the blank bottom strip', committedAt: '2026-10-13T05:03:00.000Z' };
    const changedFiles = ['src/file-0.ts'];
    const truncated = await launchWithState(makePreConfig({
      withSummary: true,
      report: fullReport({ knowledge: { commits: [commit], commitCount: 5, changedFiles, changedFileCount: 1 } }),
    }));
    try {
      await openCompletedTask(truncated.page);
      await expect(truncated.page.locator('[data-testid="completed-commits"]')).toContainText('1 of 5');
    } finally {
      await truncated.browser.close();
    }
    const whole = await launchWithState(makePreConfig({
      withSummary: true,
      report: fullReport({ knowledge: { commits: [commit], commitCount: 1, changedFiles, changedFileCount: 1 } }),
    }));
    try {
      await openCompletedTask(whole.page);
      const commits = whole.page.locator('[data-testid="completed-commits"]');
      await expect(commits).toContainText('f9a8d40');
      await expect(commits).not.toContainText(/\d+ of \d+/);
    } finally {
      await whole.browser.close();
    }
  });

  test('a Route whose move log begins after the task started gets no note of its own', async () => {
    // The earlier turns are in the conversation's All tab; nothing special is drawn here.
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport({ startedAt: '2026-09-26T22:49:00.000Z' }) }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="route-column-pill"]')).toHaveCount(3);
      await expect(page.locator('[data-testid="completed-route"]')).not.toContainText('Moves logged');
    } finally {
      await browser.close();
    }
  });

  test('a Route pill opens the Conversation tab on its column, and a second pill switches the column', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport(), ...routeConversation() }));
    try {
      await openCompletedTask(page);
      await page.locator('[data-testid="route-column-pill"][data-swimlane-name="Code Review"]').click();
      const panel = page.locator('[data-testid="completed-panel-conversation"]');
      await expect(page.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');
      await expect(panel.getByTestId('conversation-route-tabs-lane-review')).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
      await expect(panel.getByText('REVIEW_TURN')).toBeVisible();
      await expect(panel.getByText('EXECUTING_FIRST')).toHaveCount(0);
      // Back to the Route, and a second pill switches the tab's column.
      await page.getByRole('tab', { name: 'Summary' }).click();
      await page.locator('[data-testid="route-column-pill"][data-swimlane-name="Executing"]').click();
      await expect(panel.getByTestId('conversation-route-tabs-lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a stay row opens its column\'s tab at that stay\'s first turn', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport(), ...routeConversation() }));
    try {
      await openCompletedTask(page);
      // Executing's second stay, at 04:30.
      await page.locator('[data-testid="route-visit"]').nth(1).click();
      await expect(page.getByTestId('conversation-route-tabs-lane-executing')).toHaveAttribute('aria-selected', 'true');
      await expect
        .poll(async () => page.locator('[data-turn-uuid="turn-executing-second"] [data-highlighted="true"]').count(), { timeout: 5000 })
        .toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('a pill opens the tab beside a conversation window open for the task, and leaves that window as it was', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport(), ...routeConversation() }));
    try {
      await openCompletedTask(page);
      // A search hit or an earlier open anchored a window on the older session.
      await page.evaluate(() => (window as unknown as {
        __zustandStores: { session: { getState: () => { setConversationSessionId: (id: string) => void } } };
      }).__zustandStores.session.getState().setConversationSessionId('sess-older'));
      const conversationWindow = page.getByTestId('conversation-window');
      await expect(conversationWindow).toBeVisible({ timeout: 5000 });
      // The window may sit over the card now, so click the pill as its own
      // handler would be reached, not by pointer position.
      await page.locator('[data-testid="route-column-pill"][data-swimlane-name="Code Review"]').dispatchEvent('click');
      const panel = page.locator('[data-testid="completed-panel-conversation"]');
      await expect(panel.getByTestId('conversation-route-tabs-lane-review')).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
      // Two bodies at once: each keeps its own tab ids, and the window keeps
      // its own column and anchor.
      await expect(conversationWindow).toHaveCount(1);
      await expect(conversationWindow.getByTestId('conversation-route-tabs-lane-review')).not.toHaveAttribute('aria-selected', 'true');
      const conversationSessionId = await page.evaluate(() => (window as unknown as {
        __zustandStores: { session: { getState: () => { conversationSessionId: string | null } } };
      }).__zustandStores.session.getState().conversationSessionId);
      expect(conversationSessionId).toBe('sess-older');
    } finally {
      await browser.close();
    }
  });

  test('Background calls show a total no call reported as a dash, not a zero', async () => {
    const unrecorded = (name: string) => ({
      callId: null, job: 'condition_check', column: EXECUTING, automationName: name, automationType: 'move_to_column', condition: null,
      outcome: 'ran', reason: null,
      startedAt: '2026-10-13T04:10:00.000Z', model: null, effort: null, durationMs: null, costUsd: null, tokens: null,
    });
    // Calls recorded before the call ledger carry no figures, so main totals each to null.
    const report = fullReport({
      backgroundCalls: [unrecorded('Apply findings'), unrecorded('On to Code Review')],
      totals: { ...FULL_REPORT_TOTALS, backgroundCalls: { durationMs: null, costUsd: null, tokens: null } },
    });
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const total = page.locator('[data-testid="completed-background-calls-total"] td');
      await expect(total).toHaveText(['Total', '-', '-', '-']);
    } finally {
      await browser.close();
    }
  });

  test('a task with no column history shows no Route and no Column column', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-route"]')).toHaveCount(0);
      await openUsageTab(page);
      const runs = page.locator('[data-testid="completed-runs"]');
      await expect(runs.locator('thead')).not.toContainText('Column');
      await expect(runs.locator('thead')).not.toContainText('Compactions');
      await expect(runs.locator('[data-testid="completed-run-row"]')).toHaveCount(1);
      // With no Column column, the Session pill leads the row.
      await expect(runs.locator('thead th').first()).toHaveText('Session');
      await expect(runs.locator('[data-testid="completed-copy-conversation-id"]')).toHaveText('abc12345');
      await expect(runs.locator('[data-testid="completed-runs-total"]')).toContainText('17s');
      await expect(runs.locator('[data-testid="completed-runs-total"]')).toContainText('$0.08');
      // No ledger behind the mock's derived report: the session totals stand in.
      await expect(page.locator('[data-testid="completed-models-fallback"]')).toContainText('From session totals');
      await expect(page.locator('[data-testid="completed-models-fallback"]')).toContainText('12.5k');
    } finally {
      await browser.close();
    }
  });

  test('Runs lists every run oldest first, each naming its conversation with a Session pill', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const runs = page.locator('[data-testid="completed-runs"]');
      await expect(runs.locator('thead th')).toContainText(['Column', 'Session', 'Started']);
      await expect(runs.locator('thead')).toContainText('Compactions');
      // No heading row per conversation: the pill says which conversation a run continues.
      const rows = runs.locator('[data-testid="completed-run-row"]');
      await expect(rows).toHaveCount(3);
      await expect(rows.locator('[data-testid="completed-copy-conversation-id"]')).toHaveText(['0407afe2', '0407afe2', '096842a0']);
      // Code Review's own conversation is isolated: its pill leads with the Split icon, and its tip says so.
      const pills = rows.locator('[data-testid="completed-copy-conversation-id"]');
      await expect(pills.nth(2).getByTestId('isolated-icon')).toHaveCount(1);
      await expect(pills.nth(0).getByTestId('isolated-icon')).toHaveCount(0);
      await expect(pills.nth(1).getByTestId('isolated-icon')).toHaveCount(0);
      await expect(pills.nth(2)).toHaveAccessibleDescription(/^Copy isolated conversation ID/);
      await expect(pills.nth(0)).toHaveAccessibleDescription(/^Copy conversation ID/);
      await expect(rows.nth(1).locator('[data-testid="report-column-label"]')).toHaveText(['Planning', 'Executing']);
      await expect(rows.nth(0)).toContainText('Plan');
      await expect(rows.nth(2)).toContainText('Auto');
      await expect(runs.locator('[data-testid="completed-runs-total"]')).toContainText('$42.78');

      // The pill copies the full id.
      await page.evaluate(() => {
        const scope = window as unknown as { __copiedText: string[] };
        scope.__copiedText = [];
        navigator.clipboard.writeText = async (text: string) => { scope.__copiedText.push(text); };
      });
      await rows.nth(2).locator('[data-testid="completed-copy-conversation-id"]').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText: string[] }).__copiedText))
        .toEqual(['096842a0-5555-6666-7777-888888888888']);
    } finally {
      await browser.close();
    }
  });

  test('a Usage header sorts its table: highest first, then flipped, then back to the table\'s own order', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const runs = page.locator('[data-testid="completed-runs"]');
      const costs = runs.locator('[data-testid="completed-run-row"] td:nth-last-child(2)');
      const costHeader = runs.locator('th', { has: page.getByTestId('completed-runs-sort-cost') });
      await expect(costs).toHaveText(['$1.85', '$24.19', '$16.74']);

      await page.getByTestId('completed-runs-sort-cost').click();
      await expect(costs).toHaveText(['$24.19', '$16.74', '$1.85']);
      await expect(costHeader).toHaveAttribute('aria-sort', 'descending');

      await page.getByTestId('completed-runs-sort-cost').click();
      await expect(costs).toHaveText(['$1.85', '$16.74', '$24.19']);
      await expect(costHeader).toHaveAttribute('aria-sort', 'ascending');

      await page.getByTestId('completed-runs-sort-cost').click();
      await expect(costs).toHaveText(['$1.85', '$24.19', '$16.74']);
      await expect(costHeader).not.toHaveAttribute('aria-sort', /.+/);
      // Total never moves.
      await expect(runs.locator('tbody tr').last()).toHaveAttribute('data-testid', 'completed-runs-total');

      // Models: Turns starts highest first, and a second click puts the fewest on top.
      const models = page.locator('[data-testid="completed-models"]');
      await page.getByTestId('completed-models-sort-turns').click();
      await expect(models.locator('[data-testid="completed-model-row"]').first()).toContainText('Opus 5.5');
      await page.getByTestId('completed-models-sort-turns').click();
      await expect(models.locator('[data-testid="completed-model-row"]').first()).toContainText('Haiku 5.5');
      await expect(models.locator('tbody tr').last()).toHaveAttribute('data-testid', 'completed-models-total');
    } finally {
      await browser.close();
    }
  });

  test('a run that returns to a column lists it each time, in order', async () => {
    // A, B, A: the third label is the first column again, and it still gets its own label.
    const report = fullReport({
      conversations: [{
        conversationId: '0407afe2-1111-2222-3333-444444444444', isolatedColumn: null, runs: [
          reportRun('leg-1', '2026-10-13T03:04:00.000Z', 1.85, 722_000, 23, [PLANNING, EXECUTING, PLANNING]),
        ],
      }],
      totals: { ...FULL_REPORT_TOTALS, runs: { runCount: 1, runtimeMs: 722_000, costUsd: 1.85, toolCallCount: 23, compactionCount: 0 } },
    });
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const row = page.locator('[data-testid="completed-run-row"]').nth(0);
      await expect(row.locator('[data-testid="report-column-label"]')).toHaveCount(3);
      await expect(row.locator('[data-testid="report-column-label"]')).toHaveText(['Planning', 'Executing', 'Planning']);
    } finally {
      await browser.close();
    }
  });

  // Two tests, not one that launches two pages: each launch costs several seconds on a loaded
  // runner, and a pair of them inside one 15s budget timed out on CI.
  test('the Runs Total shows a total no run reported as a dash', async () => {
    const onlyUnrecorded = fullReport({
      conversations: [{
        conversationId: '0407afe2-1111-2222-3333-444444444444', isolatedColumn: null, runs: [
          reportRun('leg-1', '2026-10-13T03:04:00.000Z', null, null, 23, [PLANNING]),
          reportRun('leg-2', '2026-10-13T03:18:00.000Z', null, null, 241, [PLANNING]),
        ],
      }],
      totals: { ...FULL_REPORT_TOTALS, runs: { runCount: 2, runtimeMs: null, costUsd: null, toolCallCount: 264, compactionCount: 0 } },
    });
    const unrecorded = await launchWithState(makePreConfig({ withSummary: true, report: onlyUnrecorded }));
    try {
      await openCompletedTask(unrecorded.page);
      await openUsageTab(unrecorded.page);
      const runs = unrecorded.page.locator('[data-testid="completed-runs"]');
      await expect(runs.locator('[data-testid="completed-run-row"]')).toHaveCount(2);
      // No run has a compaction, so the Total row is: label, Runtime, Cost, Tool calls.
      await expect(runs.locator('thead')).not.toContainText('Compactions');
      const totalCells = runs.locator('[data-testid="completed-runs-total"] td');
      await expect(totalCells).toHaveCount(4);
      await expect(totalCells.nth(1)).toHaveText('-');
      await expect(totalCells.nth(2)).toHaveText('-');
    } finally {
      await unrecorded.browser.close();
    }
  });

  test('the Runs Total shows the one reported runtime and cost formatted, never zeroed by an unreported run', async () => {
    const onePartial = fullReport({
      conversations: [{
        conversationId: '0407afe2-1111-2222-3333-444444444444', isolatedColumn: null, runs: [
          reportRun('leg-1', '2026-10-13T03:04:00.000Z', 1.85, 722_000, 23, [PLANNING]),
          reportRun('leg-2', '2026-10-13T03:18:00.000Z', null, null, 241, [PLANNING]),
        ],
      }],
      // Main's total for these runs: the one reported runtime and cost, never zeroed by the other.
      totals: { ...FULL_REPORT_TOTALS, runs: { runCount: 2, runtimeMs: 722_000, costUsd: 1.85, toolCallCount: 264, compactionCount: 0 } },
    });
    const partial = await launchWithState(makePreConfig({ withSummary: true, report: onePartial }));
    try {
      await openCompletedTask(partial.page);
      await openUsageTab(partial.page);
      const totalCells = partial.page.locator('[data-testid="completed-runs"] [data-testid="completed-runs-total"] td');
      await expect(totalCells).toHaveCount(4);
      await expect(totalCells.nth(1)).toHaveText('12m 2s');
      await expect(totalCells.nth(2)).toHaveText('$1.85');
    } finally {
      await partial.browser.close();
    }
  });

  test('a run that crashed is marked in Runs while the task, whose last run ended cleanly, reads Completed', async () => {
    const report = fullReport();
    report.conversations[0].runs[0] = { ...report.conversations[0].runs[0], exitCode: 1073807364 };
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await expect(page.locator('[data-testid="completed-status"]')).toHaveAttribute('aria-label', 'Completed');
      await openUsageTab(page);
      const marks = page.locator('[data-testid="completed-run-exited"]');
      await expect(marks).toHaveCount(1);
      await expect(marks).toHaveAttribute('aria-label', 'Exited (1073807364)');
      await expect(page.locator('[data-testid="completed-run-row"]').nth(0).locator('[data-testid="completed-run-exited"]')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a run\'s tool pill opens its own per-tool table below it', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      // The first run has no per-tool rows on record, so its count is plain text.
      const rows = page.locator('[data-testid="completed-run-row"]');
      await expect(rows.nth(0).locator('[data-testid="completed-run-tool-calls"]')).toHaveCount(0);
      const pill = rows.nth(1).locator('[data-testid="completed-run-tool-calls"]');
      await pill.click();
      const popover = page.locator('[data-testid="completed-tool-breakdown-popover"]');
      await expect(popover).toBeVisible();
      await expect(popover.locator('tbody tr td:first-child')).toHaveText(['Edit', 'Grep']);
      const pillBox = await pill.boundingBox();
      const popoverBox = await popover.boundingBox();
      expect(pillBox && popoverBox && popoverBox.y >= pillBox.y + pillBox.height - 1).toBe(true);
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(page.locator('[data-testid="completed-task-view"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a run\'s tool pill shows the rows it was given and fetches nothing', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await recordBridgeCalls(page, ['sessions.getToolBreakdown', 'sessions.getToolResultTokens']);
      await openCompletedTask(page);
      await openUsageTab(page);
      await resetBridgeCalls(page);
      await page.locator('[data-testid="completed-run-row"]').nth(1).locator('[data-testid="completed-run-tool-calls"]').click();
      const popover = page.locator('[data-testid="completed-tool-breakdown-popover"]');
      await expect(popover.locator('tbody tr td:first-child')).toHaveText(['Edit', 'Grep']);
      // The popover's mount effects have run once its rows show and a frame has passed.
      await flushRenderer(page);
      expect(await bridgeCalls(page, 'sessions.getToolBreakdown')).toEqual([]);
      expect(await bridgeCalls(page, 'sessions.getToolResultTokens')).toEqual([]);
      // Closing it is a second chance for a fetch that waited for the refresh signal.
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await flushRenderer(page);
      expect(await bridgeCalls(page, 'sessions.getToolBreakdown')).toEqual([]);
      expect(await bridgeCalls(page, 'sessions.getToolResultTokens')).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('Models and tokens reads the ledger, names a subagent, and totals two or more rows', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const models = page.locator('[data-testid="completed-models"]');
      await expect(models.locator('[data-testid="completed-model-row"]')).toHaveCount(2);
      await expect(models).toContainText('doc-auditor subagent');
      await expect(models).toContainText('76.6M');
      await expect(models.locator('[data-testid="completed-models-total"]')).toContainText('248');
    } finally {
      await browser.close();
    }
  });

  test('the Usage Total rows show report.totals, not a sum of the rows above them', async () => {
    // These totals are deliberately NOT the sum of the rows `fullReport` seeds (the rows sum to
    // $42.78 and 6,037,000 ms of runtime, 248 turns, and 40.7k background tokens in 42.6s), so
    // the test proves the cards read `report.totals`. A card that summed its rows would show those.
    const report = fullReport({
      totals: {
        runs: { runCount: 3, runtimeMs: 3_600_000, costUsd: 99.5, toolCallCount: 538, compactionCount: 1 },
        models: { turns: 999, freshInputTokens: 524, cacheWriteTokens: 1_187_000, cacheReadTokens: 78_240_000, outputTokens: 266_900 },
        backgroundCalls: { durationMs: 61_000, costUsd: 0.5, tokens: 77_000 },
      },
    });
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      // Runs Total cells: label, Compactions (one run has some), Runtime, Cost, Tool calls.
      const runsTotal = page.locator('[data-testid="completed-runs"] [data-testid="completed-runs-total"] td');
      await expect(runsTotal.nth(2)).toHaveText('1h');
      await expect(runsTotal.nth(3)).toHaveText('$99.50');
      // Models Total cells: label, Turns, then the four token kinds.
      const modelsTotal = page.locator('[data-testid="completed-models"] [data-testid="completed-models-total"] td');
      await expect(modelsTotal.nth(1)).toHaveText('999');
      await expect(page.locator('[data-testid="completed-background-calls-total"] td')).toHaveText(['Total', '1m 1s', '$0.50', '77k']);
    } finally {
      await browser.close();
    }
  });

  test('Background calls lists every check with its outcome and reason, and shows the report\'s total', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report: fullReport() }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const card = page.locator('[data-testid="completed-background-calls"]');
      await expect(card.locator('thead')).toContainText('Outcome');
      const rows = card.locator('[data-testid="completed-background-call-row"]');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toContainText('Generate title');
      // A title call has no automation, so its Outcome cell is a dash and carries no pill.
      await expect(rows.nth(0).locator('[data-testid="completed-call-outcome"]')).toHaveCount(0);
      await expect(rows.nth(1)).toContainText('Apply findings');
      await expect(rows.nth(1).locator('[data-testid="completed-call-label"]')).toHaveAccessibleDescription('Condition: The final message lists findings.');
      const outcomes = card.locator('[data-testid="completed-call-outcome"]');
      await expect(outcomes).toHaveCount(3);
      await expect(outcomes.nth(0)).toHaveText('Ran');
      await expect(outcomes.nth(0)).toHaveAttribute('data-outcome', 'ran');
      await expect(outcomes.nth(0)).toHaveAccessibleDescription('Ran: The reply lists two findings.');
      await expect(outcomes.nth(1)).toHaveText('Skipped');
      await expect(outcomes.nth(1)).toHaveAttribute('data-outcome', 'skipped');
      await expect(outcomes.nth(1)).toHaveAccessibleDescription('Skipped: The reply still lists findings to apply.');
      await expect(outcomes.nth(2)).toHaveText('Error');
      await expect(outcomes.nth(2)).toHaveAttribute('data-outcome', 'error');
      await expect(outcomes.nth(2)).toHaveAccessibleDescription('Error: The Automation agent could not check the condition: timed out');
      // The report's total, 25,900 tokens: 2.1k + 14.8k + 9k, the shared call once.
      await expect(card.locator('[data-testid="completed-background-calls-total"]')).toContainText('25.9k');
      await expect(card.locator('[data-testid="completed-background-calls-toggle"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Background calls shows ten rows, then Show all', async () => {
    const call = (index: number) => ({
      callId: `call-${index}`, job: 'condition_check', column: null, automationName: `Automation ${index}`,
      automationType: 'notify', condition: null, outcome: 'skipped', reason: null, startedAt: `2026-10-13T04:${String(10 + index).padStart(2, '0')}:00.000Z`,
      model: 'Haiku 5.5', effort: 'low', durationMs: 4_000, costUsd: 0.003, tokens: 13_000,
    });
    const report = fullReport({
      backgroundCalls: Array.from({ length: 12 }, (_, index) => call(index)),
      // Twelve distinct calls of 4,000 ms, $0.003 and 13,000 tokens each.
      totals: { ...FULL_REPORT_TOTALS, backgroundCalls: { durationMs: 48_000, costUsd: 0.036, tokens: 156_000 } },
    });
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const rows = page.locator('[data-testid="completed-background-call-row"]');
      await expect(rows).toHaveCount(10);
      // A pill with no reason names its outcome alone, with no trailing colon. That
      // tip only repeats the pill's own text, so it adds no description.
      await expect(rows.nth(0).locator('[data-testid="completed-call-outcome"]')).toHaveAccessibleDescription('');
      await page.locator('[data-testid="completed-background-calls-toggle"]').click();
      await expect(rows).toHaveCount(12);
    } finally {
      await browser.close();
    }
  });

  test('Background calls sorts every call before the cut, so the dearest leads while Show all is collapsed and keeps leading', async () => {
    const call = (index: number) => ({
      callId: `call-${index}`, job: 'condition_check', column: null, automationName: `Automation ${index}`,
      automationType: 'notify', condition: null, outcome: 'skipped', reason: null,
      startedAt: `2026-10-13T04:${String(10 + index).padStart(2, '0')}:00.000Z`,
      model: 'Haiku 5.5', effort: 'low', durationMs: 4_000,
      // The last call is by far the dearest; the others rise a little with their number.
      costUsd: index === 11 ? 0.5 : 0.001 * (index + 1), tokens: 13_000,
    });
    const report = fullReport({
      backgroundCalls: Array.from({ length: 12 }, (_, index) => call(index)),
      totals: { ...FULL_REPORT_TOTALS, backgroundCalls: { durationMs: 48_000, costUsd: 0.566, tokens: 156_000 } },
    });
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const card = page.locator('[data-testid="completed-background-calls"]');
      const rows = card.locator('[data-testid="completed-background-call-row"]');
      const names = card.locator('[data-testid="completed-background-call-row"] [data-testid="completed-call-label"]');
      const toggle = card.locator('[data-testid="completed-background-calls-toggle"]');
      const callNames = (indexes: number[]) => indexes.map((index) => `Automation ${index}`);

      // Collapsed and unsorted: the first ten, so the dearest call (the twelfth) is cut.
      await expect(rows).toHaveCount(10);
      await expect(names).toHaveText(callNames([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
      await expect(toggle).toHaveText('Show all 12');

      // Sorted by cost, still collapsed: the cut falls after the sort, so the
      // call that was cut leads and the two cheapest are the ones left out.
      await card.locator('[data-testid="completed-background-calls-sort-cost"]').click();
      await expect(rows).toHaveCount(10);
      await expect(names).toHaveText(callNames([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]));
      await expect(toggle).toHaveText('Show all 12');

      // Expanding and collapsing keep the sort.
      await toggle.click();
      await expect(rows).toHaveCount(12);
      await expect(names).toHaveText(callNames([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]));
      await toggle.click();
      await expect(rows).toHaveCount(10);
      await expect(names).toHaveText(callNames([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]));
    } finally {
      await browser.close();
    }
  });

  test('Runs lists runs oldest first when the report hands its conversations over in another order', async () => {
    // Conversation A runs at 03:04 and again at 04:30; conversation B runs at
    // 04:14 between them, and the report lists B first. Oldest first reads A, B, A.
    const runsOfA = [
      reportRun('leg-1', '2026-10-13T03:04:00.000Z', 1.85, 722_000, 23, [PLANNING]),
      reportRun('leg-3', '2026-10-13T04:30:00.000Z', 3.1, 600_000, 40, [EXECUTING]),
    ];
    const runsOfB = [reportRun('review-1', '2026-10-13T04:14:00.000Z', 16.74, 1_415_000, 274, [REVIEW])];
    const report = fullReport({
      conversations: [
        { conversationId: '096842a0-5555-6666-7777-888888888888', isolatedColumn: REVIEW, runs: runsOfB },
        { conversationId: '0407afe2-1111-2222-3333-444444444444', isolatedColumn: null, runs: runsOfA },
      ],
      totals: { ...FULL_REPORT_TOTALS, runs: { runCount: 3, runtimeMs: 2_737_000, costUsd: 21.69, toolCallCount: 337, compactionCount: 0 } },
    });
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      const rows = page.locator('[data-testid="completed-runs"] [data-testid="completed-run-row"]');
      await expect(rows).toHaveCount(3);
      await expect(rows.locator('[data-testid="completed-copy-conversation-id"]')).toHaveText(['0407afe2', '096842a0', '0407afe2']);
      await expect(rows.locator('td:nth-last-child(2)')).toHaveText(['$1.85', '$16.74', '$3.10']);
    } finally {
      await browser.close();
    }
  });

  test('the Usage tables share one column grid, so Runs and Background calls line up by name', async () => {
    const report = fullReport();
    // A Compactions column gives Runs an eighth data column, which cannot line up with Background calls' seven.
    for (const conversation of report.conversations) for (const run of conversation.runs) run.compactionCount = 0;
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, report }));
    try {
      await openCompletedTask(page);
      await page.getByRole('button', { name: 'Maximize dialog' }).click();
      await openUsageTab(page);
      // Each pair is a Runs header and the Background calls header that shares its edge.
      const pairs: Array<[string, string]> = [
        ['Started', 'Started'], ['Model', 'Model'], ['Effort', 'Effort'], ['Permissions', 'Outcome'],
        ['Runtime', 'Runtime'], ['Cost', 'Cost'], ['Tool calls', 'Tokens'],
      ];
      // Polled, so the measurement waits out the maximize transition.
      await expect.poll(() => page.evaluate((headerPairs) => {
        const leftEdges = (testId: string) => new Map(
          [...document.querySelectorAll(`[data-testid="${testId}"] thead th`)].map((header) => [header.textContent, header.getBoundingClientRect().left]),
        );
        const runs = leftEdges('completed-runs');
        const models = leftEdges('completed-models');
        const background = leftEdges('completed-background-calls');
        const offsets = headerPairs.map(([runsHeader, backgroundHeader]) => Math.abs((runs.get(runsHeader) ?? 0) - (background.get(backgroundHeader) ?? Infinity)));
        // Every card's first data column starts on the same line.
        offsets.push(Math.abs((models.get('Turns') ?? 0) - (runs.get('Started') ?? Infinity)));
        return Math.max(...offsets);
      }, pairs)).toBeLessThan(2);
    } finally {
      await browser.close();
    }
  });

  test('a task with no runs on record says so on the Usage tab', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: false }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      await expect(page.locator('[data-testid="completed-no-runs"]')).toBeVisible();
      // The conversation is one tab away, on every completed task.
      await expect(page.getByRole('tab', { name: 'Conversation' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('Per-tool table on a completed task', () => {
  async function openTotalBreakdown(page: Page): Promise<void> {
    await openCompletedTask(page);
    await openUsageTab(page);
    await page.locator('[data-testid="completed-total-tool-calls"]').click();
    await expect(page.locator('[data-testid="session-summary-by-tool"]')).toBeVisible();
  }

  test('the Total has no pill when no per-tool rows are on record', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      await openCompletedTask(page);
      await openUsageTab(page);
      await expect(page.locator('[data-testid="completed-runs-total"]')).toContainText('5');
      await expect(page.locator('[data-testid="completed-total-tool-calls"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Cost / token / interrupted columns are conditional on row data', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [{ toolName: 'Bash', callCount: 3, totalDurationMs: 4_200, interruptedCount: 0 }],
    }));
    try {
      await openTotalBreakdown(page);
      const headerRow = page.locator('[data-testid="session-summary-by-tool"] table thead tr');
      await expect(headerRow).not.toContainText('Cost');
      await expect(headerRow).not.toContainText('In');
      await expect(headerRow).not.toContainText('Out');
      await expect(headerRow).not.toContainText('Failed');
    } finally {
      await browser.close();
    }
  });

  test('Cost and Failed columns appear when at least one row has them', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Bash', callCount: 5, totalDurationMs: 12_000, interruptedCount: 1, costUsd: 0.04 },
        { toolName: 'Read', callCount: 20, totalDurationMs: 1_500, interruptedCount: 0 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const headerRow = page.locator('[data-testid="session-summary-by-tool"] table thead tr');
      await expect(headerRow).toContainText('Cost');
      await expect(headerRow).toContainText('Failed');
      const readRow = page.locator('[data-testid="session-summary-by-tool"] table tbody tr', { hasText: 'Read' });
      await expect(readRow).toContainText('-');
    } finally {
      await browser.close();
    }
  });

  test('rows default to Calls, most first, and a header click re-sorts and then reverses', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Bash', callCount: 3, totalDurationMs: 4_200, interruptedCount: 0 },
        { toolName: 'Read', callCount: 12, totalDurationMs: 850, interruptedCount: 0 },
        { toolName: 'Edit', callCount: 7, totalDurationMs: 9_000, interruptedCount: 0 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const table = page.locator('[data-testid="session-summary-by-tool"]');
      const toolCells = table.locator('tbody tr td:first-child');
      await expect(toolCells).toHaveText(['Read', 'Edit', 'Bash']);
      await expect(table.locator('th', { has: page.locator('[data-testid="by-tool-sort-calls"]') }))
        .toHaveAttribute('aria-sort', 'descending');

      await page.locator('[data-testid="by-tool-sort-time"]').click();
      await expect(toolCells).toHaveText(['Edit', 'Bash', 'Read']);
      await page.locator('[data-testid="by-tool-sort-time"]').click();
      await expect(toolCells).toHaveText(['Read', 'Bash', 'Edit']);
      await expect(table.locator('th', { has: page.locator('[data-testid="by-tool-sort-time"]') }))
        .toHaveAttribute('aria-sort', 'ascending');
    } finally {
      await browser.close();
    }
  });

  test('the Tool header sorts A to Z on the first click and Z to A on the second', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Read', callCount: 3, totalDurationMs: 850, interruptedCount: 0 },
        { toolName: 'Edit', callCount: 12, totalDurationMs: 9_000, interruptedCount: 0 },
        { toolName: 'Bash', callCount: 7, totalDurationMs: 4_200, interruptedCount: 0 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const table = page.locator('[data-testid="session-summary-by-tool"]');
      const toolCells = table.locator('tbody tr td:first-child');
      const toolHeader = table.locator('th', { has: page.locator('[data-testid="by-tool-sort-tool"]') });
      const callsHeader = table.locator('th', { has: page.locator('[data-testid="by-tool-sort-calls"]') });
      await expect(toolCells).toHaveText(['Edit', 'Bash', 'Read']);
      await expect(toolHeader).not.toHaveAttribute('aria-sort');

      await page.locator('[data-testid="by-tool-sort-tool"]').click();
      await expect(toolCells).toHaveText(['Bash', 'Edit', 'Read']);
      await expect(toolHeader).toHaveAttribute('aria-sort', 'ascending');
      await expect(callsHeader).not.toHaveAttribute('aria-sort');

      await page.locator('[data-testid="by-tool-sort-tool"]').click();
      await expect(toolCells).toHaveText(['Read', 'Edit', 'Bash']);
      await expect(toolHeader).toHaveAttribute('aria-sort', 'descending');
    } finally {
      await browser.close();
    }
  });

  test('a row with no result tokens sorts last under the Tokens header in both directions', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Edit', callCount: 20, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'Read', callCount: 9, totalDurationMs: 0, interruptedCount: 0, resultTokens: 41_000 },
        { toolName: 'Bash', callCount: 4, totalDurationMs: 0, interruptedCount: 0, resultTokens: 2_300 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const table = page.locator('[data-testid="session-summary-by-tool"]');
      const toolCells = table.locator('tbody tr td:first-child');
      await expect(toolCells).toHaveText(['Edit', 'Read', 'Bash']);

      await page.locator('[data-testid="by-tool-sort-tokens"]').click();
      await expect(toolCells).toHaveText(['Read', 'Bash', 'Edit']);
      await page.locator('[data-testid="by-tool-sort-tokens"]').click();
      await expect(toolCells).toHaveText(['Bash', 'Read', 'Edit']);
    } finally {
      await browser.close();
    }
  });

  test('calls that waited on the user are left out of Time and Avg, and the header says how many', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Bash', callCount: 3, totalDurationMs: 4_200, interruptedCount: 0, waitedCount: 1 },
        { toolName: 'Read', callCount: 12, totalDurationMs: 850, interruptedCount: 0 },
        { toolName: 'AskUserQuestion', callCount: 2, totalDurationMs: 0, interruptedCount: 0, waitedCount: 2 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const table = page.locator('[data-testid="session-summary-by-tool"]');
      await expect(page.locator('[data-testid="by-tool-sort-time"]')).toHaveAccessibleDescription(
        'How long each tool ran. Leaves out the 3 calls that waited for your answer or approval.',
      );
      const askRow = table.locator('tbody tr', { hasText: 'AskUserQuestion' });
      await expect(askRow.locator('td').nth(2)).toHaveText('-');
      await expect(askRow.locator('td').nth(3)).toHaveText('-');
      const bashRow = table.locator('tbody tr', { hasText: 'Bash' });
      await expect(bashRow.locator('td').nth(2)).toHaveText('4.2s');
      await expect(bashRow.locator('td').nth(3)).toHaveText('2.1s');
    } finally {
      await browser.close();
    }
  });

  test('the Time, Avg and Tokens headers explain themselves, and a header with nothing to add has no description', async () => {
    // Every column present at once: durations (Time, Avg), result tokens and cost.
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Bash', callCount: 4, totalDurationMs: 4_200, interruptedCount: 0, resultTokens: 2_300, costUsd: 0.04 },
        { toolName: 'Read', callCount: 9, totalDurationMs: 850, interruptedCount: 0, resultTokens: 41_000, costUsd: 0.01 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const sortButton = (columnKey: string) => page.locator(`[data-testid="by-tool-sort-${columnKey}"]`);

      // Nothing waited on the user, so Time names no left-out calls.
      await expect(sortButton('time')).toHaveAccessibleDescription('How long each tool ran.');
      await expect(sortButton('avg')).toHaveAccessibleDescription('Average run time of the calls Time counts.');
      await expect(sortButton('tokens')).toHaveAccessibleDescription(
        'Estimated tokens this tool\'s output added to the main conversation. Not billed tokens; subagent calls are not counted.',
      );
      // The description is extra: the header keeps its own name.
      await expect(sortButton('tokens')).toHaveAccessibleName('Tokens');

      // Cost, Calls and Tool have nothing to add to their names, so they carry no description.
      await expect(sortButton('cost')).toHaveAccessibleName('Cost');
      await expect(sortButton('cost')).toHaveAccessibleDescription('');
      await expect(sortButton('calls')).toHaveAccessibleDescription('');
      await expect(sortButton('tool')).toHaveAccessibleDescription('');
    } finally {
      await browser.close();
    }
  });

  test('count-only rows hide Time and Avg and still show estimated result tokens', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      withSummary: true,
      toolBreakdown: [
        { toolName: 'Bash', callCount: 4, totalDurationMs: 0, interruptedCount: 0, resultTokens: 2_300 },
        { toolName: 'Read', callCount: 9, totalDurationMs: 0, interruptedCount: 0, resultTokens: 41_000 },
      ],
    }));
    try {
      await openTotalBreakdown(page);
      const table = page.locator('[data-testid="session-summary-by-tool"]');
      const headerRow = table.locator('thead tr');
      await expect(headerRow).toContainText('Tokens');
      await expect(headerRow).not.toContainText('Time');
      await expect(headerRow).not.toContainText('Avg');
      await expect(table.locator('tbody tr', { hasText: 'Read' })).toContainText('41k');
    } finally {
      await browser.close();
    }
  });
});

test.describe('Done Column', () => {
  test('completed section is always visible with header', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });
      await expect(doneColumn).toContainText('Completed (1)');
      await expect(doneColumn.locator('text=Completed Test Task')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('shows completed tasks and "View all" button', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, extraArchivedTasks: 6 }));
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });
      await expect(doneColumn).toContainText('Completed (7)');
      await expect(doneColumn.locator('[data-testid="compact-title"]')).toHaveCount(7);
      await expect(doneColumn.locator('[data-testid="view-all-completed"]')).toBeVisible();
      await expect(doneColumn.locator('[data-testid="view-all-completed"]')).toContainText('View all');
      await expect(doneColumn.locator('[data-testid="view-all-completed"] [data-testid="view-all-completed-count"]')).toHaveText('7');
    } finally {
      await browser.close();
    }
  });

  test('completed dialog opens from "View all" and reads Agent runtime', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, extraArchivedTasks: 6 }));
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });
      await doneColumn.locator('[data-testid="view-all-completed"]').click();
      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText('Completed Tasks (7)');
      await expect(dialog).toContainText('Agent runtime');
      await expect(dialog).not.toContainText('Duration');
    } finally {
      await browser.close();
    }
  });

  test('empty state shows when no completed tasks exist', async () => {
    const preConfig = `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();
        state.projects.push({
          id: '${PROJECT_ID}', name: 'Empty Done Test', path: '/mock/empty-done', github_url: null,
          default_agent: 'claude', position: 0, last_opened: ts, created_at: ts,
        });
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          state.swimlanes.push({
            id: state.uuid(), name: template.name, role: template.role, color: template.color, icon: template.icon,
            is_archived: template.is_archived, is_ghost: template.is_ghost,
            permission_strategy: template.permission_strategy ?? null, auto_spawn: template.auto_spawn ?? false,
            auto_command: template.auto_command ?? null, plan_exit_target_id: null, position: index, created_at: ts,
          });
        });
        return { currentProjectId: '${PROJECT_ID}' };
      });
    `;
    const { browser, page } = await launchWithState(preConfig);
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });
      await expect(doneColumn).toContainText('Completed (0)');
      await expect(doneColumn).toContainText('No completed tasks yet');
    } finally {
      await browser.close();
    }
  });
});

/**
 * A task detail hosted in the Agent Monitor cannot show the conversation viewer
 * WINDOW (its host sets `canOpenConversation: false`: the viewer opens on the
 * board's layer, under the monitor overlay), so every window opener is left out
 * rather than left to do nothing. A completed task's own Conversation tab is
 * not a window, so it works in any host, and its Route opens it here too. The
 * board host keeps the window openers, which the tests above and
 * conversation-pill-disabled-state.spec.ts cover.
 */
test.describe('Task detail hosted in the Agent Monitor', () => {
  const monitorDetailFrame = (page: Page): Locator => page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');

  /** Open the detail for a row by its title; the monitor hosts it in its own layer. */
  async function openMonitorDetail(page: Page, taskId: string): Promise<Locator> {
    await monitorByTestId(page, 'monitor-page')
      .locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`)
      .click();
    const detail = monitorDetailFrame(page);
    await expect(detail).toHaveCount(1);
    return detail;
  }

  /** Open the header's Actions menu and return once it is showing, proven by an item every task has. */
  async function openActionsMenu(page: Page, detail: Locator): Promise<void> {
    await detail.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menu').getByRole('button', { name: 'Edit' })).toBeVisible();
  }

  // Red: `MonitorTaskDetailHost` sets `canOpenConversation: true`, and the
  // Actions menu lists View conversation.
  test('a completed task detail in the monitor opens its conversation in its own tab, never a window', async () => {
    const taskId = 'task-monitor-completed';
    const { browser, page } = await launchMonitorSeed(
      { tasks: [{ id: taskId, displayId: 90, title: 'Completed in the monitor', lane: 'Done', session: true, sessionStatus: 'suspended', archived: true }] },
      `window.__mockPreConfigure(function (state) { state.taskReportCache['${taskId}'] = ${JSON.stringify(fullReport())}; return {}; });`,
    );
    try {
      await openMonitor(page);
      const detail = await openMonitorDetail(page, taskId);

      // The completed view and its Route are showing, so what is missing below is missing.
      await expect(detail.locator('[data-testid="completed-task-view"]')).toBeVisible();
      await expect(detail.locator('[data-testid="completed-task-tabs"]')).toBeVisible();
      const pills = detail.locator('[data-testid="route-column-pill"]');
      const stays = detail.locator('[data-testid="route-visit"]');
      await expect(pills).toHaveCount(3);
      await expect(stays).toHaveCount(2);

      // The Route's pills and stay rows open the detail's own Conversation tab.
      expect(await pills.evaluateAll((elements) => elements.map((element) => element.tagName))).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
      await pills.nth(2).click();
      await expect(detail.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');
      await expect(detail.locator('[data-testid="completed-panel-conversation"]')).toBeVisible();
      await settleFrames(page);
      await expect(page.getByTestId('conversation-window')).toHaveCount(0);
      const conversationSessionId = await page.evaluate(() => (window as unknown as {
        __zustandStores: { session: { getState: () => { conversationSessionId: string | null } } };
      }).__zustandStores.session.getState().conversationSessionId);
      expect(conversationSessionId).toBeNull();

      await openActionsMenu(page, detail);
      await expect(page.getByTestId('view-conversation-btn')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  // Red: the same flag. The header gains the conversation pill and the Actions
  // menu gains View conversation.
  test('a running task detail in the monitor shows no conversation pill and no View conversation item', async () => {
    const taskId = 'task-monitor-running';
    const { browser, page } = await launchMonitorSeed({
      tasks: [{ id: taskId, displayId: 91, title: 'Running in the monitor', lane: 'Executing', session: true }],
    });
    try {
      await openMonitor(page);
      const detail = await openMonitorDetail(page, taskId);

      // The header's pills are showing (the folder pill is one), so a missing
      // conversation pill is not a header that never drew them.
      await expect(detail.locator('[data-pill-id="folder"]')).toBeVisible();
      await expect(detail.locator('[data-testid="conversation-pill"]')).toHaveCount(0);

      await openActionsMenu(page, detail);
      await expect(page.getByTestId('view-conversation-btn')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
