/**
 * UI tests for the ContextBar tool-call breakdown popover
 * (ToolBreakdownPopover.tsx).
 *
 * The trigger is `[data-testid="context-bar-tool-calls-trigger"]` which renders
 * when `config.contextBar.showToolCalls` is true (default) and the session's
 * usage has been resolved (i.e. the spinner branch has exited).
 *
 * Clicking the trigger mounts `[data-testid="context-bar-tool-breakdown-popover"]`.
 * The popover renders either the shared `ByToolTable`
 * (`[data-testid="session-summary-by-tool"]`) when rows exist, or an empty
 * state "No tool calls yet" when the mock returns an empty array.
 *
 * Dismissal: Escape and outside-click both close the popover. The Escape
 * handler uses capture-phase document dispatch (not page.keyboard.press)
 * because the ContextBar sits in a scrollable area and xterm may receive the
 * key first; the ToolBreakdownPopover attaches its own capture-phase listener
 * so document dispatch always reaches it.
 *
 * Mock setup:
 *   - `tests/ui/mock-electron-api.js` stubs `sessions.getToolBreakdown`
 *     to return `[]`. Tests that exercise the populated state override the
 *     stub per-test via `window.electronAPI.sessions.getToolBreakdown = ...`.
 *   - Usage is seeded via `__zustandStores.session.getState().updateUsage`
 *     (same helper used in context-bar-popover.spec.ts).
 *
 * Browser reuse: one Chromium launch shared across the main describe block
 * via `beforeAll`. State is reset between tests via the same snapshot +
 * setState pattern used in context-bar-popover.spec.ts.
 */

import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';
import type {
  ActivityState,
  PerToolStat,
  SessionEvent,
  SessionUsage,
  Swimlane,
  Task,
} from '../../src/shared/types';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-tool-breakdown';
const TASK_ID = 'task-tool-breakdown';
const SESSION_ID = 'sess-tool-breakdown';
const SWIMLANE_ID = 'lane-tool-breakdown';

// ---------------------------------------------------------------------------
// Launch helper (mirrors context-bar-popover.spec.ts)
// ---------------------------------------------------------------------------

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

// ---------------------------------------------------------------------------
// Pre-config: seed a running Claude session with a task in the To Do lane
// (mirrors the CLAUDE_RUNNING_PRECONFIG pattern in context-bar-popover.spec.ts)
// ---------------------------------------------------------------------------

const CLAUDE_RUNNING_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Tool Breakdown Test',
      path: '/mock/tool-breakdown',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
      state.swimlanes.push({
        id: id,
        name: s.name,
        role: s.role,
        color: s.color,
        icon: s.icon,
        is_archived: s.is_archived,
        permission_strategy: s.permission_strategy ?? null,
        auto_spawn: s.auto_spawn ?? false,
        position: i,
        created_at: ts,
      });
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/tool-breakdown',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Tool Breakdown Task',
      description: '',
      swimlane_id: '${SWIMLANE_ID}',
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      labels: [],
      priority: 0,
      model_override: null,
      effort_override: null,
      attachment_count: 0,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

// ---------------------------------------------------------------------------
// Helper: seed a running session with usage so the ContextBar resolves past
// the spinner branch (requires a non-null model.displayName).
// Mirrors applyClaudeUsage from context-bar-popover.spec.ts.
// ---------------------------------------------------------------------------

async function seedUsage(page: Page): Promise<void> {
  await page.evaluate((sessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
      };
    }).__zustandStores;
    stores?.session.getState().updateUsage(sessionId, {
      toolCallCount: 42,
      model: { id: 'sonnet', displayName: 'Claude Sonnet' },
      contextWindow: {
        usedPercentage: 20,
        usedTokens: 40_000,
        cacheTokens: 5_000,
        totalInputTokens: 50_000,
        totalOutputTokens: 10_000,
        contextWindowSize: 200_000,
      },
      cost: { totalCostUsd: 0.05, totalDurationMs: 3_000 },
    });
  }, SESSION_ID);
}

// ---------------------------------------------------------------------------
// Reset snapshot type (mirrors context-bar-popover.spec.ts)
// ---------------------------------------------------------------------------

interface ResetSnapshot {
  tasks: Task[];
  swimlanes: Swimlane[];
  sessionUsage: Record<string, SessionUsage>;
  sessionActivity: Record<string, ActivityState>;
  sessionFirstOutput: Record<string, boolean>;
  sessionEvents: Record<string, SessionEvent[]>;
  seenIdleSessions: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

test.describe('ContextBar tool-call breakdown popover', () => {
  let browser: Browser;
  let page: Page;
  let baseline: ResetSnapshot;

  test.beforeAll(async () => {
    const launched = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    browser = launched.browser;
    page = launched.page;

    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

    baseline = await page.evaluate<ResetSnapshot>(() => {
      const stores = (window as unknown as {
        __zustandStores: {
          board: { getState: () => Record<string, unknown> };
          session: { getState: () => Record<string, unknown> };
        };
      }).__zustandStores;
      const board = stores.board.getState();
      const session = stores.session.getState();
      const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
      return {
        tasks: clone(board.tasks),
        swimlanes: clone(board.swimlanes),
        sessionUsage: clone(session.sessionUsage),
        sessionActivity: clone(session.sessionActivity),
        sessionFirstOutput: clone(session.sessionFirstOutput),
        sessionEvents: clone(session.sessionEvents),
        seenIdleSessions: clone(session.seenIdleSessions),
      };
    });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    // Close any open popover first via the capture-phase listener, then
    // restore Zustand data. Order matches context-bar-popover.spec.ts.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(page.locator('[data-testid="context-bar-tool-breakdown-popover"]')).toHaveCount(0);

    await page.evaluate((snapshot: ResetSnapshot) => {
      const stores = (window as unknown as {
        __zustandStores: {
          board: { setState: (partial: Record<string, unknown>, replace?: boolean) => void };
          session: { setState: (partial: Record<string, unknown>, replace?: boolean) => void };
        };
      }).__zustandStores;
      stores.board.setState({
        tasks: snapshot.tasks,
        swimlanes: snapshot.swimlanes,
      }, false);
      stores.session.setState({
        sessionUsage: snapshot.sessionUsage,
        sessionActivity: snapshot.sessionActivity,
        sessionFirstOutput: snapshot.sessionFirstOutput,
        sessionEvents: snapshot.sessionEvents,
        seenIdleSessions: snapshot.seenIdleSessions,
      }, false);

      // Reset the getToolBreakdown mock back to the default empty-array stub
      // so tests that override it don't bleed into subsequent tests.
      (window as unknown as {
        electronAPI: { sessions: { getToolBreakdown: (_sessionId: string) => Promise<PerToolStat[]> } };
      }).electronAPI.sessions.getToolBreakdown = async (_sessionId: string) => [];
    }, baseline);
  });

  // -------------------------------------------------------------------------

  test('clicking the tool-calls trigger mounts the popover', async () => {
    await seedUsage(page);

    const trigger = page.locator('[data-testid="context-bar-tool-calls-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const popover = page.locator('[data-testid="context-bar-tool-breakdown-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 3000 });
    await expect(popover).toBeVisible();
  });

  test('empty state: mock returns [] and popover shows "No tool calls yet"', async () => {
    // Default mock stub returns []. The popover empty-state branch renders
    // "No tool calls yet" and the ByToolTable is NOT rendered.
    await seedUsage(page);

    const trigger = page.locator('[data-testid="context-bar-tool-calls-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const popover = page.locator('[data-testid="context-bar-tool-breakdown-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 3000 });
    await expect(popover).toContainText('No tool calls yet');
    await expect(page.locator('[data-testid="session-summary-by-tool"]')).toHaveCount(0);
  });

  test('populated state: overridden mock returns rows and ByToolTable renders them', async () => {
    // Override the getToolBreakdown stub to return fixture rows that mirror
    // the PerToolStat shape (toolName, callCount, totalDurationMs, interruptedCount).
    const fixtureRows: PerToolStat[] = [
      { toolName: 'Bash', callCount: 12, totalDurationMs: 6000, interruptedCount: 1 },
      { toolName: 'Read', callCount: 8, totalDurationMs: 800, interruptedCount: 0 },
      { toolName: 'Edit', callCount: 5, totalDurationMs: 1200, interruptedCount: 0 },
    ];

    await page.evaluate((rows: PerToolStat[]) => {
      (window as unknown as {
        electronAPI: { sessions: { getToolBreakdown: (_sessionId: string) => Promise<PerToolStat[]> } };
      }).electronAPI.sessions.getToolBreakdown = async (_sessionId: string) => rows;
    }, fixtureRows);

    await seedUsage(page);

    const trigger = page.locator('[data-testid="context-bar-tool-calls-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const popover = page.locator('[data-testid="context-bar-tool-breakdown-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 3000 });

    // ByToolTable renders with data-testid="session-summary-by-tool".
    const table = page.locator('[data-testid="session-summary-by-tool"]');
    await expect(table).toBeVisible({ timeout: 3000 });

    // Assert at least one tool name and its call count appear in the table.
    await expect(table).toContainText('Bash');
    await expect(table).toContainText('12'); // callCount for Bash

    // Empty-state text must NOT appear when rows are present.
    await expect(popover).not.toContainText('No tool calls yet');
  });

  test('Escape closes the popover', async () => {
    await seedUsage(page);

    const trigger = page.locator('[data-testid="context-bar-tool-calls-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const popover = page.locator('[data-testid="context-bar-tool-breakdown-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 3000 });

    // Dispatch at document level via capture-phase (bypasses any xterm focus
    // interception). Mirrors the anti-flake pattern from the agent file.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await expect(popover).toHaveCount(0, { timeout: 3000 });
  });

  test('clicking outside closes the popover', async () => {
    await seedUsage(page);

    const trigger = page.locator('[data-testid="context-bar-tool-calls-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const popover = page.locator('[data-testid="context-bar-tool-breakdown-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 3000 });

    // Click an empty area of the board surface. The capture-phase mousedown
    // listener on document closes the popover.
    await page.mouse.click(10, 10);

    await expect(popover).toHaveCount(0, { timeout: 3000 });
  });

  test('second click on the trigger (while open) toggles the popover closed', async () => {
    await seedUsage(page);

    const trigger = page.locator('[data-testid="context-bar-tool-calls-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // First click: open.
    await trigger.click();
    const popover = page.locator('[data-testid="context-bar-tool-breakdown-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 3000 });

    // Second click on the trigger: toggle closed (the trigger is inside
    // the capture-phase outside-click exclusion zone, so the toggle
    // onClick handler is what fires).
    await trigger.click();
    await expect(popover).toHaveCount(0, { timeout: 3000 });
  });

  test('getToolBreakdown is not called when popover is closed', async () => {
    // The popover fetches via useEffect only when mounted. While closed,
    // no IPC call should be in flight. Assert by counting calls.
    let callCount = 0;
    await page.evaluate(() => {
      const original = (window as unknown as {
        electronAPI: { sessions: { getToolBreakdown: (_sessionId: string) => Promise<PerToolStat[]> } };
      }).electronAPI.sessions.getToolBreakdown;
      (window as unknown as {
        electronAPI: {
          sessions: {
            getToolBreakdown: (_sessionId: string) => Promise<PerToolStat[]>;
            __toolBreakdownCallCount?: number;
          };
        };
      }).electronAPI.sessions.__toolBreakdownCallCount = 0;
      (window as unknown as {
        electronAPI: { sessions: { getToolBreakdown: (_sessionId: string) => Promise<PerToolStat[]> } };
      }).electronAPI.sessions.getToolBreakdown = async (sessionId: string) => {
        (window as unknown as {
          electronAPI: { sessions: { __toolBreakdownCallCount?: number } };
        }).electronAPI.sessions.__toolBreakdownCallCount =
          ((window as unknown as {
            electronAPI: { sessions: { __toolBreakdownCallCount?: number } };
          }).electronAPI.sessions.__toolBreakdownCallCount ?? 0) + 1;
        return original(sessionId);
      };
    });

    // Confirm no calls happened just by navigating (popover is closed).
    // intentional fixed wait - we cannot poll for non-occurrence
    await page.waitForTimeout(300);

    callCount = await page.evaluate(() =>
      (window as unknown as {
        electronAPI: { sessions: { __toolBreakdownCallCount?: number } };
      }).electronAPI.sessions.__toolBreakdownCallCount ?? 0,
    );
    expect(callCount).toBe(0);
  });
});
