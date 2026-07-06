/**
 * UI tests for the ContextBar model and effort popovers.
 *
 * The pills become clickable buttons whenever the agent's
 * `discoverCapabilities` reports a non-empty options array. Clicking opens a
 * `ContextBarPopover`, picking an option fires
 * `window.electronAPI.tasks.setRuntimeOverride`, and the pill updates
 * optimistically.
 *
 * The mock at `tests/ui/mock-electron-api.js` exposes:
 *   - `window.__mockSetRuntimeOverrideCalls`: every IPC input recorded
 *   - `window.__mockSetRuntimeOverrideResult`: optional override that lets a
 *     spec inject a custom response (e.g. `{ ok: false, reason: ... }`).
 *   - `window.__mockAgentListOverrides`: per-agent capability overrides; we
 *     use this in the gating test to clear `models` and `effortLevels`.
 *
 * Browser reuse: the main `describe` block launches one Chromium browser in
 * `beforeAll`, then resets Zustand store state between tests via snapshot +
 * partial setState (preserves store methods because `replace=false`). The
 * gating test that needs `__mockAgentListOverrides` injected before app boot
 * lives in its own describe with its own per-test launch.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';
import type {
  ActivityState,
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

const PROJECT_ID = 'proj-ctx-bar-popover';
const TASK_ID = 'task-ctx-bar-popover';
const SESSION_ID = 'sess-ctx-bar-popover';
const SWIMLANE_ID = 'lane-ctx-bar-popover';

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

const CLAUDE_RUNNING_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Popover ContextBar Test',
      path: '/mock/ctx-bar-popover',
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
      cwd: '/mock/ctx-bar-popover',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Popover Task',
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

async function applyClaudeUsage(page: Page, sessionId: string, model: string, displayName: string, effort: string | undefined): Promise<void> {
  await page.evaluate(
    ({ sessionId: id, model: modelId, displayName: name, effort: effortLevel }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
        };
      }).__zustandStores;
      stores?.session.getState().updateUsage(id, {
        model: { id: modelId, displayName: name, effort: effortLevel },
        contextWindow: {
          usedPercentage: 0,
          usedTokens: 0,
          cacheTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          contextWindowSize: 1_000_000,
        },
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      });
    },
    { sessionId, model, displayName, effort },
  );
}

// ---------------------------------------------------------------------------
// Shared toast helper (mirrors the pattern in delete-task-optimistic.spec.ts).
// ---------------------------------------------------------------------------

async function waitForToast(
  page: Page,
  textPattern: RegExp | string,
  timeoutMs = 5000,
): Promise<void> {
  await expect(
    page.locator('[data-testid="toast"]').filter({ hasText: textPattern }),
  ).toBeVisible({ timeout: timeoutMs });
}

interface ResetSnapshot {
  tasks: Task[];
  swimlanes: Swimlane[];
  sessionUsage: Record<string, SessionUsage>;
  sessionActivity: Record<string, ActivityState>;
  sessionFirstOutput: Record<string, boolean>;
  sessionEvents: Record<string, SessionEvent[]>;
  seenIdleSessions: Record<string, boolean>;
}

test.describe('ContextBar model/effort popover', () => {
  let browser: Browser;
  let page: Page;
  let baseline: ResetSnapshot;

  test.beforeAll(async () => {
    const launched = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    browser = launched.browser;
    page = launched.page;

    // Wait for the board to render so the Zustand stores have settled into
    // their post-mount steady state before we snapshot the baseline.
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
      // Deep-clone the data slices we may mutate. Methods stay live on the
      // store; we never overwrite them because beforeEach uses replace=false.
      // JSON-clone is sufficient because every snapshotted slice is plain
      // JSON. Do NOT add Map/Date/RegExp/undefined fields here -- they would
      // silently round-trip to {} and the per-test reset would no-op for that
      // slice. _sessionByTaskId (a Map) is intentionally excluded for this
      // reason; tests do not mutate `sessions`, so it stays valid.
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
    // ORDER MATTERS. The popover's open state lives in ContextBar's local
    // React state (`openPopover`); resetting `sessionUsage` first would make
    // ContextBar early-return its spinner branch, unmounting the popover and
    // its document-level Escape listener. Subsequent tests would re-render
    // with the leaked open state and the trigger click would toggle CLOSED.
    //
    // So: first close any open popover via the live listener, then restore
    // stores. We dispatch Escape on document directly because both popovers
    // attach capture-phase keydown listeners there, and synthetic dispatch
    // does not depend on focus state (which page.keyboard.press does).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="context-bar-effort-popover"]')).toHaveCount(0);

    // Now restore the data fields tests mutate. Pass replace=false explicitly
    // (also the Zustand 4 default) so store methods like updateUsage/setState
    // are preserved. Also clear mock IPC capture arrays and override hooks.
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
      const w = window as unknown as {
        __mockSetRuntimeOverrideCalls?: unknown[];
        __mockSetRuntimeOverrideResult?: unknown;
      };
      if (w.__mockSetRuntimeOverrideCalls) w.__mockSetRuntimeOverrideCalls.length = 0;
      delete w.__mockSetRuntimeOverrideResult;
    }, baseline);
  });

  test('clicking model pill opens popover with discovered options and current value checked', async () => {
    const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
    await expect(usageBar).toBeVisible({ timeout: 10000 });

    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
    await expect(modelTrigger).toBeVisible({ timeout: 5000 });
    await modelTrigger.click();

    const popover = page.locator('[data-testid="context-bar-model-popover"]');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('opus');
    await expect(popover).toContainText('sonnet');
    await expect(popover).toContainText('haiku');
    // "Use column default" intentionally hidden when the swimlane has no
    // model_override (the default fixture). Covered separately by the
    // 'hides "Use column default" row when the column has no override'
    // test.
  });

  test('picking a different model fires IPC and updates pill optimistically', async () => {
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
    await expect(modelTrigger).toBeVisible({ timeout: 5000 });
    await modelTrigger.click();

    await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

    // Popover closes, IPC fired with the picked value
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
    const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
    expect(calls).toEqual([{ taskId: TASK_ID, model: 'sonnet' }]);

    // Optimistic store update propagates to the task row
    const taskOverride = await page.evaluate((taskId) => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
      }).__zustandStores;
      const t = stores?.board.getState().tasks.find((row) => row.id === taskId);
      return t?.model_override ?? null;
    }, TASK_ID);
    expect(taskOverride).toBe('sonnet');
  });

  test('picking an effort level fires IPC with the effort field', async () => {
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    const effortTrigger = page.locator('[data-testid="context-bar-effort-trigger"]');
    await expect(effortTrigger).toBeVisible({ timeout: 5000 });
    await effortTrigger.click();

    const popover = page.locator('[data-testid="context-bar-effort-popover"]');
    await expect(popover).toBeVisible();
    await page.locator('[data-testid="context-bar-effort-popover-option-medium"]').click();

    await expect(popover).toHaveCount(0);
    const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
    expect(calls).toEqual([{ taskId: TASK_ID, effort: 'medium' }]);
  });

  test('"Use column default" sends null to clear the per-task override (only when the column has a default)', async () => {
    await applyClaudeUsage(page, SESSION_ID, 'sonnet', 'Sonnet', 'high');

    // Pretend the task already had an override AND the column has a model
    // override of its own (otherwise the "Use column default" row is
    // intentionally hidden - clicking it on an Auto column would silently
    // persist null without any visible effect, which is confusing UX).
    await page.evaluate((taskId) => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { setState: (fn: (s: unknown) => unknown) => void } };
      }).__zustandStores;
      stores?.board.setState((s) => {
        const state = s as {
          tasks: Array<{ id: string; model_override: string | null; swimlane_id: string }>;
          swimlanes: Array<{ id: string; model_override: string | null }>;
        };
        return {
          tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, model_override: 'sonnet' } : t)),
          swimlanes: state.swimlanes.map((lane) =>
            lane.id === state.tasks.find((t) => t.id === taskId)?.swimlane_id
              ? { ...lane, model_override: 'opus' }
              : lane,
          ),
        };
      });
    }, TASK_ID);

    await page.locator('[data-testid="context-bar-model-trigger"]').click();
    await page.locator('[data-testid="context-bar-model-popover-option-clear"]').click();

    const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
    expect(calls).toEqual([{ taskId: TASK_ID, model: null }]);
  });

  test('hides "Use column default" row when the column has no override (Auto)', async () => {
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    // Default fixture: swimlane has no model_override (Auto). Open the
    // popover and assert the clear row is not rendered. The user can still
    // pick any concrete option to "revert" - we just don't show a row that
    // would silently no-op.
    await page.locator('[data-testid="context-bar-model-trigger"]').click();
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toBeVisible();
    await expect(page.locator('[data-testid="context-bar-model-popover-option-clear"]')).toHaveCount(0);
  });

  test('Escape closes the popover', async () => {
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    await page.locator('[data-testid="context-bar-model-trigger"]').click();
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
  });

  test('clicking outside closes the popover', async () => {
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    await page.locator('[data-testid="context-bar-model-trigger"]').click();
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toBeVisible();
    // Click an empty area of the page (board surface). The capture-phase
    // listener on document.mousedown closes the popover.
    await page.mouse.click(10, 10);
    await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
  });

  test('pre-persist failure rolls back optimistic update and shows a "Could not apply" toast', async () => {
    // The handler returns ok:false with a reason that does NOT start with
    // 'suspend failed', 'respawn failed', or 'respawn aborted' — meaning the DB
    // write never happened. The store must roll back the optimistic update so
    // the visible pill stays in sync with the DB.
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    // Snapshot the task's model_override before any click — should be null.
    const overrideBefore = await page.evaluate((taskId) => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
      }).__zustandStores;
      return stores?.board.getState().tasks.find((row) => row.id === taskId)?.model_override ?? null;
    }, TASK_ID);
    expect(overrideBefore).toBeNull();

    // Install the failure hook before clicking so the IPC mock returns the error.
    await page.evaluate(() => {
      (window as unknown as { __mockSetRuntimeOverrideResult?: (input: unknown) => unknown }).__mockSetRuntimeOverrideResult =
        (_input: unknown) => ({ ok: false as const, reason: 'task not found' });
    });

    const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
    await expect(modelTrigger).toBeVisible({ timeout: 5000 });
    await modelTrigger.click();

    const popover = page.locator('[data-testid="context-bar-model-popover"]');
    await expect(popover).toBeVisible();
    await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

    // Popover closes after the pick.
    await expect(popover).toHaveCount(0);

    // Error toast must appear with "Could not apply" prefix (pre-persist path).
    await waitForToast(page, 'Could not apply model/effort: task not found');

    // Optimistic update must be rolled back: model_override returns to null.
    await expect.poll(async () => {
      return page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
        }).__zustandStores;
        return stores?.board.getState().tasks.find((row) => row.id === taskId)?.model_override ?? null;
      }, TASK_ID);
    }, { timeout: 3000 }).toBeNull();
  });

  test('post-persist failure keeps optimistic update and shows a "Saved, but..." toast', async () => {
    // The handler returns ok:false with a reason starting with 'suspend failed:'
    // — meaning the DB write DID happen, but applying the change to the live
    // session failed. The store must KEEP the optimistic update (so the pill
    // stays in sync with what the DB now has) and show the recovery toast.
    await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

    // Install the failure hook: simulates a post-persist PTY suspend failure.
    await page.evaluate(() => {
      (window as unknown as { __mockSetRuntimeOverrideResult?: (input: unknown) => unknown }).__mockSetRuntimeOverrideResult =
        (_input: unknown) => ({ ok: false as const, reason: 'suspend failed: PTY already exited' });
    });

    const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
    await expect(modelTrigger).toBeVisible({ timeout: 5000 });
    await modelTrigger.click();

    const popover = page.locator('[data-testid="context-bar-model-popover"]');
    await expect(popover).toBeVisible();
    await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

    // Popover closes after the pick.
    await expect(popover).toHaveCount(0);

    // Recovery toast must appear with "Saved, but..." prefix (post-persist path).
    await waitForToast(page, /Saved, but couldn't apply to the live session/);

    // Optimistic update must be KEPT: model_override is now 'sonnet' (in DB).
    await expect.poll(async () => {
      return page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; model_override: string | null }> } } };
        }).__zustandStores;
        return stores?.board.getState().tasks.find((row) => row.id === taskId)?.model_override ?? null;
      }, TASK_ID);
    }, { timeout: 3000 }).toBe('sonnet');
  });
});

// Default-agent task: `task.agent` is null (the project default was never
// written to the task row). The picker must still be interactive because the
// ContextBar caller passes agentFallback = project default_agent. Regression
// guard for the reported "can't change model/effort on default-agent tasks".
const NULL_AGENT_PRECONFIG = CLAUDE_RUNNING_PRECONFIG.replace(
  "agent: 'claude',\n      session_id:",
  "agent: null,\n      session_id:",
);

test.describe('ContextBar model/effort popover - default-agent task', () => {
  test('picker is interactive for a task whose agent is null (resolves via agentFallback)', async () => {
    const { browser, page } = await launchWithState(NULL_AGENT_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.8 (1M context)', 'xhigh');

      // Both triggers must mount as interactive buttons even though the task's
      // own agent column is null - the project default agent ('claude') backs
      // the capability lookup.
      const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
      const effortTrigger = page.locator('[data-testid="context-bar-effort-trigger"]');
      await expect(modelTrigger).toBeVisible({ timeout: 5000 });
      await expect(effortTrigger).toBeVisible({ timeout: 5000 });

      // Picking a model still routes through the task-keyed override path.
      await modelTrigger.click();
      await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();
      const calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([{ taskId: TASK_ID, model: 'sonnet' }]);
    } finally {
      await browser.close();
    }
  });
});

// The capabilities-empty test injects `__mockAgentListOverrides` BEFORE the
// app boots so the renderer's initial agents.list IPC call sees the cleared
// arrays. That requires its own page setup; sharing the post-mount page from
// the main describe would not affect already-cached capability lists.
test.describe('ContextBar model/effort popover - capability gating', () => {
  test('hides triggers when adapter capabilities have no models or effort levels', async () => {
    const preconfig = `
      window.__mockAgentListOverrides = {
        claude: {
          capabilities: { effortLevels: [], supportsModelOverride: false, models: [] },
        },
      };
      ${CLAUDE_RUNNING_PRECONFIG}
    `;
    const { browser, page } = await launchWithState(preconfig);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'opus', 'Opus 4.7 (1M context)', 'xhigh');

      // The static "Opus 4.7" pill still renders (model name from live status)
      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect.poll(async () => usageBar.textContent(), { timeout: 5000 }).toMatch(/Opus 4\.7/);

      // But neither trigger button mounts when capabilities are empty.
      await expect(page.locator('[data-testid="context-bar-model-trigger"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="context-bar-effort-trigger"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

// Grouped model list: when discovery surfaces duplicate spellings of the same
// base model (bare alias, [1m] context-window variant, dated pinned build)
// PLUS a superseded generation (an older Opus/Sonnet/Haiku version whose
// family has a newer one), the popover shows one humanized row per
// current-generation base model with a 1M chip and tucks the superseded
// generation + dated builds behind a collapsed "Older versions" disclosure.
// Every selection still sends the exact discovered string (the spawn value).
test.describe('ContextBar model popover - grouped suffixed models', () => {
  test('groups variants onto one humanized row, demotes the superseded generation and the dated pin, and selections send exact suffixed strings', async () => {
    const preconfig = `
      window.__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            models: [
              'claude-haiku-4-5',
              'claude-haiku-4-5-20251001',
              'claude-opus-4-7',
              'claude-opus-4-8',
              'claude-opus-4-8[1m]',
            ],
            // Mirrors what the Claude adapter's discoverCapabilities()
            // populates via humanizeClaudeModelId(): the headless mock does
            // not run real main-process discovery, so this must be supplied
            // explicitly or every row falls back to its raw id.
            modelDisplayNames: {
              'claude-haiku-4-5': 'Haiku 4.5',
              'claude-haiku-4-5-20251001': 'Haiku 4.5',
              'claude-opus-4-7': 'Opus 4.7',
              'claude-opus-4-8': 'Opus 4.8',
              'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
            },
          },
        },
      };
      ${CLAUDE_RUNNING_PRECONFIG}
    `;
    const { browser, page } = await launchWithState(preconfig);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await applyClaudeUsage(page, SESSION_ID, 'claude-opus-4-8[1m]', 'Opus 4.8 (1M context)', 'xhigh');

      const modelTrigger = page.locator('[data-testid="context-bar-model-trigger"]');
      await expect(modelTrigger).toBeVisible({ timeout: 5000 });
      await modelTrigger.click();

      const popover = page.locator('[data-testid="context-bar-model-popover"]');
      await expect(popover).toBeVisible();

      // One primary row per current-generation base model, humanized; no
      // separate row for the [1m] spelling, and the superseded Opus 4.7
      // generation is not present at the top level while collapsed.
      const haikuRow = page.locator('[data-testid="context-bar-model-popover-option-claude-haiku-4-5"]');
      await expect(haikuRow).toBeVisible();
      await expect(haikuRow).toHaveText('Haiku 4.5');
      const opusRow = page.locator('[data-testid="context-bar-model-popover-option-claude-opus-4-8"]');
      await expect(opusRow).toBeVisible();
      await expect(opusRow).toContainText('Opus 4.8');
      await expect(page.locator('[data-testid="context-bar-model-popover-option-claude-opus-4-8[1m]"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="context-bar-model-popover-option-claude-opus-4-7"]')).toHaveCount(0);

      // The superseded generation and the dated build hide behind the
      // collapsed "Older versions" disclosure (the live [1m] value is not
      // demoted, so the section starts closed).
      const olderToggle = page.locator('[data-testid="context-bar-model-popover-pinned-toggle"]');
      await expect(olderToggle).toHaveText(/Older versions \(2\)/);
      await expect(page.locator('[data-testid="context-bar-model-popover-option-claude-haiku-4-5-20251001"]')).toHaveCount(0);

      // Expanding reveals both demoted rows, humanized (the dated pin keeps
      // its date appended since the humanizer drops it).
      await olderToggle.click();
      const olderOpusRow = page.locator('[data-testid="context-bar-model-popover-option-claude-opus-4-7"]');
      await expect(olderOpusRow).toBeVisible();
      await expect(olderOpusRow).toHaveText('Opus 4.7');
      const datedPinRow = page.locator('[data-testid="context-bar-model-popover-option-claude-haiku-4-5-20251001"]');
      await expect(datedPinRow).toHaveText('Haiku 4.5 · 2025-10-01');

      // Picking the dated build sends the exact dated string.
      await datedPinRow.click();
      await expect(popover).toHaveCount(0);
      let calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([{ taskId: TASK_ID, model: 'claude-haiku-4-5-20251001' }]);

      // Reopen and click the always-visible 1M chip on the opus row: the
      // exact [1m] string is sent, not the base alias.
      await modelTrigger.click();
      await page.locator('[data-testid="context-bar-model-popover-option-1m-claude-opus-4-8[1m]"]').click();
      await expect(page.locator('[data-testid="context-bar-model-popover"]')).toHaveCount(0);
      calls = await page.evaluate(() => (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls);
      expect(calls).toEqual([
        { taskId: TASK_ID, model: 'claude-haiku-4-5-20251001' },
        { taskId: TASK_ID, model: 'claude-opus-4-8[1m]' },
      ]);

      // When the live model IS a demoted (dated pin) build, the disclosure
      // auto-expands so the active value's checkmark is never hidden.
      await applyClaudeUsage(page, SESSION_ID, 'claude-haiku-4-5-20251001', 'Haiku 4.5', 'high');
      await modelTrigger.click();
      await expect(page.locator('[data-testid="context-bar-model-popover-option-claude-haiku-4-5-20251001"]')).toBeVisible();

      // Close before reopening: the trigger toggles, so leaving the popover
      // open here would make the next click close it instead of reopening.
      await modelTrigger.click();
      await expect(popover).toHaveCount(0);

      // When the live model IS a superseded generation, the disclosure
      // auto-expands too.
      await applyClaudeUsage(page, SESSION_ID, 'claude-opus-4-7', 'Opus 4.7', 'high');
      await modelTrigger.click();
      await expect(page.locator('[data-testid="context-bar-model-popover-option-claude-opus-4-7"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
