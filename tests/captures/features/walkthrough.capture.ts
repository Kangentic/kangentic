/**
 * Full product walkthrough video capture.
 *
 * Drives a linear narrative from welcome screen → project open → task creation
 * → agent spawning → multi-agent orchestration → task completion.
 *
 * Produces a single WebM video at 1920×1080 plus chapter screenshots.
 */
import { test } from '@playwright/test';
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { getOutputDir } from '../helpers/output-dir';

const OUTPUT_DIR = getOutputDir('walkthrough');
const MOCK_SCRIPT = path.join(__dirname, '..', '..', 'ui', 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// --- Helpers ---

async function waitForViteReady(url: string = VITE_URL, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Vite not ready after ${timeoutMs}ms`);
}

async function beat(page: Page, ms = 1000) {
  await page.waitForTimeout(ms);
}

async function chapter(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`), fullPage: false });
}

/** Clear any stray text selection or focus artifacts */
async function clearSelection(page: Page) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  // Click a neutral area (the board background)
  await page.mouse.click(960, 400);
  await page.waitForTimeout(100);
}

/**
 * Drag a task card to a target column using @dnd-kit PointerSensor pattern.
 */
async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col) => {
    const el = document.querySelector(`[data-swimlane-name="${col}"]`);
    if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await page.waitForTimeout(100);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error(`Cannot get bounding boxes: ${taskTitle} → ${targetColumn}`);

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 }); // activate PointerSensor
  await page.waitForTimeout(50);
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/**
 * Inject a running agent session for a task after dragging it to a column.
 * The drag triggers spawn via the overridden mock, then we set activity + usage.
 */
async function injectAgentState(
  page: Page,
  taskTitle: string,
  activity: 'thinking' | 'running' | 'idle',
  modelName: string,
  contextPct: number,
) {
  await page.evaluate(async ({ taskTitle, activity, modelName, contextPct }) => {
    await (window as any).__injectAgentState(taskTitle, activity, modelName, contextPct);
    await (window as any).__notifySessionCreated(taskTitle);
  }, { taskTitle, activity, modelName, contextPct });

  // Let React render the updated state
  await page.waitForTimeout(2000);
}

// --- Walkthrough ---

test('full product walkthrough', async () => {
  test.setTimeout(300_000);

  await waitForViteReady();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();

  await page.addInitScript(`
    window.__mockConfigOverrides = {
      hasCompletedFirstRun: false,
      terminal: {
        shell: null,
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 10,
        showPreview: false,
        panelHeight: 280,
        cursorStyle: 'block',
        colors: {},
        backspaceSendsCtrlH: false,
      },
    };
  `);

  await page.addInitScript({ path: MOCK_SCRIPT });

  // Enable session spawn in the mock (normally throws in UI tests).
  // Uses __mockPreConfigure to capture internal state references,
  // then overrides spawn to actually create sessions.
  await page.addInitScript(`
    // We can't save state references from __mockPreConfigure because the
    // mock reassigns its closure variables on project open. Instead, we'll
    // inject sessions by overriding the spawn function and tasks.move.

    // Override spawn to use the mock's resume function (which actually works
    // and properly mutates internal state via closure variables).
    window.electronAPI.sessions.spawn = async function (taskId) {
      return window.electronAPI.sessions.resume(taskId, '');
    };

    // Helper to set activity and usage for a session by task title.
    // Uses API calls instead of direct state access.
    window.__injectAgentState = async function (taskTitle, activity, modelName, contextPct) {
      var tasks = await window.electronAPI.tasks.list();
      var task = tasks.find(function (t) { return t.title === taskTitle; });
      if (!task || !task.session_id) return;
      var sid = task.session_id;

      // Store activity override
      if (!window.__activityOverrides) window.__activityOverrides = {};
      window.__activityOverrides[sid] = activity;

      // Store usage data
      if (!window.__usageOverrides) window.__usageOverrides = {};
      var tokens = Math.round(contextPct * 2000);
      window.__usageOverrides[sid] = {
        model: { id: 'claude-opus-4-6', displayName: modelName },
        contextWindow: {
          usedPercentage: contextPct,
          usedTokens: tokens,
          cacheTokens: Math.round(tokens * 0.4),
          totalInputTokens: Math.round(tokens * 0.7),
          totalOutputTokens: Math.round(tokens * 0.3),
          contextWindowSize: 200000,
        },
        cost: { totalCostUsd: +(contextPct * 0.05).toFixed(2), totalDurationMs: contextPct * 3000 },
      };

      // Push activity to React
      (window.__onActivityListeners || []).forEach(function (cb) {
        cb(sid, activity, '');
      });

      // Push usage to React via onUsage callback
      var usageData = window.__usageOverrides[sid];
      if (usageData) {
        (window.__onUsageListeners || []).forEach(function (cb) {
          cb(sid, usageData, '');
        });
      }
    };

    // Override getUsage to include injected data
    var origGetUsage = window.electronAPI.sessions.getUsage;
    window.electronAPI.sessions.getUsage = async function () {
      var base = await origGetUsage();
      return Object.assign(base, window.__usageOverrides || {});
    };

    // Override getActivity to include injected data
    var origGetActivity = window.electronAPI.sessions.getActivity;
    window.electronAPI.sessions.getActivity = async function () {
      var base = await origGetActivity();
      return Object.assign(base, window.__activityOverrides || {});
    };

    // Capture onStatus listeners so we can notify React about new sessions
    window.__onStatusListeners = [];
    var origOnStatus = window.electronAPI.sessions.onStatus;
    window.electronAPI.sessions.onStatus = function (callback) {
      window.__onStatusListeners.push(callback);
      return function () {
        window.__onStatusListeners = window.__onStatusListeners.filter(function (l) { return l !== callback; });
      };
    };

    // Capture onActivity listeners
    window.__onActivityListeners = [];
    var origOnActivity = window.electronAPI.sessions.onActivity;
    window.electronAPI.sessions.onActivity = function (callback) {
      window.__onActivityListeners.push(callback);
      return function () {
        window.__onActivityListeners = window.__onActivityListeners.filter(function (l) { return l !== callback; });
      };
    };

    // Capture onData listeners for terminal content injection.
    // When pending content exists, fire it immediately on listener registration
    // AND repeatedly after a delay (to bypass scrollbackPending guard).
    window.__onDataListeners = [];
    window.__pendingTerminalContent = {}; // sessionId -> content string
    window.electronAPI.sessions.onData = function (callback) {
      window.__onDataListeners.push(callback);
      // Fire any pending content immediately + with delays
      var pending = window.__pendingTerminalContent || {};
      Object.keys(pending).forEach(function (sid) {
        // Fire immediately
        callback(sid, pending[sid]);
        // Fire again after scrollbackPending clears
        setTimeout(function () { callback(sid, pending[sid]); }, 500);
        setTimeout(function () { callback(sid, pending[sid]); }, 1200);
      });
      return function () {
        window.__onDataListeners = window.__onDataListeners.filter(function (l) { return l !== callback; });
      };
    };

    // Capture onUsage listeners so we can push usage data to React
    window.__onUsageListeners = [];
    var origOnUsage = window.electronAPI.sessions.onUsage;
    window.electronAPI.sessions.onUsage = function (callback) {
      window.__onUsageListeners.push(callback);
      return function () {
        window.__onUsageListeners = window.__onUsageListeners.filter(function (l) { return l !== callback; });
      };
    };

    // Override tasks.move to auto-spawn when target column has auto_spawn.
    // Uses resume() which properly mutates the mock's closure variables.
    var origMove = window.electronAPI.tasks.move;
    window.electronAPI.tasks.move = async function (input) {
      var result = await origMove(input);
      // Check if target has auto_spawn by looking up swimlanes from the API
      var swimlanes = await window.electronAPI.swimlanes.list();
      var targetLane = swimlanes.find(function (s) { return s.id === input.targetSwimlaneId; });
      if (targetLane && targetLane.auto_spawn) {
        // Check if task already has a session
        var tasks = await window.electronAPI.tasks.list();
        var task = tasks.find(function (t) { return t.id === input.taskId; });
        if (task && !task.session_id) {
          // Spawn via resume (which works in the mock)
          var session = await window.electronAPI.sessions.resume(input.taskId, '');
          // Notify React
          setTimeout(function () {
            (window.__onStatusListeners || []).forEach(function (cb) { cb(session.id, session); });
          }, 50);
        }
      }
      return result;
    };

    // Notify React about a session (call after state injection)
    window.__notifySessionCreated = async function (taskTitle) {
      var tasks = await window.electronAPI.tasks.list();
      var task = tasks.find(function (t) { return t.title === taskTitle; });
      if (!task || !task.session_id) return;
      var allSessions = await window.electronAPI.sessions.list();
      var session = allSessions.find(function (s) { return s.id === task.session_id; });
      if (!session) return;

      // Fire onStatus
      (window.__onStatusListeners || []).forEach(function (cb) { cb(session.id, session); });

      // Fire onActivity
      var activity = (window.__activityOverrides || {})[session.id] || 'idle';
      (window.__onActivityListeners || []).forEach(function (cb) {
        cb(session.id, activity, session.projectId || '');
      });
    };
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  // ═══════════════════════════════════════════════════════════
  // START SCREENCAST (after app loads, no white flash)
  // ═══════════════════════════════════════════════════════════

  await page.waitForSelector('[data-testid="welcome-open-project"]', { timeout: 5000 });

  // Start recording AFTER the app is rendered
  await page.screencast.start({
    path: path.join(OUTPUT_DIR, 'walkthrough.webm'),
    size: { width: 2560, height: 1440 },
    quality: 100,
  });

  // ═══════════════════════════════════════════════════════════
  // ACT 1: WELCOME SCREEN
  // ═══════════════════════════════════════════════════════════

  await beat(page, 2500);
  await chapter(page, '01-welcome-screen');

  // Open project
  await page.evaluate(() => {
    (window as any).__mockFolderPath = '/home/dev/projects/acme-saas';
  });
  // Picking a folder lands straight on the board: no confirmation dialog, git set up
  // silently, and the onboarding checklist waiting there.
  await page.locator('[data-testid="welcome-open-project"]').click();

  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 5000 });

  // Onboarding checklist (a modal centered on the board; replaces the docked board column,
  // which itself replaced the old auto-dismissing welcome overlay).
  const onboardingChecklist = page.locator('[data-testid="onboarding-checklist"]');
  if (await onboardingChecklist.isVisible().catch(() => false)) {
    await beat(page, 3000);
    await chapter(page, '03-onboarding-checklist');
    await beat(page, 800);
    // Dismiss it so the rest of the walkthrough films an unobstructed board.
    await page.locator('[data-testid="onboarding-skip"]').click();
    await onboardingChecklist.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  await chapter(page, '04-empty-board');

  // ═══════════════════════════════════════════════════════════
  // ACT 2: CREATE TASKS
  // ═══════════════════════════════════════════════════════════

  const addButton = page.locator('[data-swimlane-name="To Do"]').locator('text=Add task');
  const titleInput = page.locator('input[placeholder="Task title"]');

  // First task with dialog visible
  await addButton.click();
  await titleInput.waitFor({ state: 'visible', timeout: 3000 });
  await beat(page, 500);
  await titleInput.pressSequentially('Add user authentication', { delay: 40 });
  await beat(page, 500);
  await chapter(page, '04-new-task-dialog');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await titleInput.waitFor({ state: 'hidden', timeout: 3000 });
  await beat(page, 600);

  // More tasks
  for (const t of [
    'Fix WebSocket reconnection',
    'Generate API client types',
    'Add rate limiting',
    'Integration test coverage',
  ]) {
    await addButton.click();
    await titleInput.waitFor({ state: 'visible', timeout: 3000 });
    await titleInput.fill(t);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await titleInput.waitFor({ state: 'hidden', timeout: 3000 });
    await beat(page, 300);
  }

  await clearSelection(page);
  await beat(page, 1000);
  await chapter(page, '05-tasks-in-todo');

  // ═══════════════════════════════════════════════════════════
  // ACT 3: DRAG TASKS & SPAWN AGENTS
  // ═══════════════════════════════════════════════════════════

  // Drag to Planning + inject thinking agent
  await dragTaskToColumn(page, 'Add user authentication', 'Planning');
  await injectAgentState(page, 'Add user authentication', 'thinking', 'Opus 4.6 (1M)', 12);
  await clearSelection(page);
  await beat(page, 600);
  await chapter(page, '06-drag-to-planning');

  // Drag to Executing + inject running agents
  await dragTaskToColumn(page, 'Fix WebSocket reconnection', 'Executing');
  await injectAgentState(page, 'Fix WebSocket reconnection', 'running', 'Sonnet 4.6', 38);
  await clearSelection(page);
  await beat(page, 500);

  await dragTaskToColumn(page, 'Generate API client types', 'Executing');
  await injectAgentState(page, 'Generate API client types', 'idle', 'Sonnet 4.6', 65);
  await clearSelection(page);
  await beat(page, 500);

  // Drag to Code Review + inject idle agent
  await dragTaskToColumn(page, 'Add rate limiting', 'Code Review');
  await injectAgentState(page, 'Add rate limiting', 'idle', 'Opus 4.6 (1M)', 51);
  await clearSelection(page);
  await beat(page, 500);

  // Debug: check if sessions were created
  const debugState = await page.evaluate(async () => {
    const sessions = await window.electronAPI.sessions.list();
    const tasks = await window.electronAPI.tasks.list();
    return {
      sessions: sessions.length,
      tasksWithSession: tasks.filter((t: any) => t.session_id).length,
      taskTitlesWithSession: tasks.filter((t: any) => t.session_id).map((t: any) => t.title),
      activityOverrides: Object.keys((window as any).__activityOverrides || {}),
    };
  });
  console.log('DEBUG agent state:', JSON.stringify(debugState));

  await chapter(page, '07-agents-running');
  await beat(page, 2000);

  // ═══════════════════════════════════════════════════════════
  // ACT 4: TASK DETAIL
  // ═══════════════════════════════════════════════════════════

  const planningCard = page.locator('[data-swimlane-name="Planning"]').locator('text=Add user authentication');
  if (await planningCard.isVisible().catch(() => false)) {
    // Pre-stage terminal content BEFORE clicking so it fires instantly on mount
    await page.evaluate(async () => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t: any) => t.title === 'Add user authentication');
      if (!task?.session_id) return;
      const sid = task.session_id;

      // Claude Code TUI content matching real color scheme
      const G = '\x1b[38;2;107;114;128m'; // gray border
      const B = '\x1b[1m\x1b[38;2;91;141;239m'; // bold blue tool name
      const R = '\x1b[0m'; // reset
      const RED = '\x1b[38;2;239;68;68m'; // diff removed
      const GRN = '\x1b[38;2;16;185;129m'; // diff added
      const SEP = '\x1b[38;2;136;136;136m'; // separator
      const PROMPT = '\x1b[38;2;177;185;249m'; // prompt chevron
      const DIM = '\x1b[38;2;153;153;153m'; // muted text

      const content = [
        `${SEP}${'─'.repeat(95)}${R}`,
        `${PROMPT}❯${R} Add user authentication`,
        '',
        ` ${GRN}Read 3 files${R} ${DIM}(ctrl+o to expand)${R}`,
        `  ${DIM}⎿${R}  src/routes/api.ts, src/middleware/auth.ts, src/lib/jwt.ts`,
        '',
        "I'll extract the authentication logic into a reusable middleware.",
        'The current code duplicates JWT verification across 4 route files.',
        '',
        `${G}╭${'─'.repeat(93)}╮${R}`,
        `${G}│${R} ${B}Edit${R} src/middleware/auth.ts${' '.repeat(68)}${G}│${R}`,
        `${G}│${R}${' '.repeat(93)}${G}│${R}`,
        `${G}│${R}  ${RED}- export function authenticate(req, res, next) {${R}${' '.repeat(42)}${G}│${R}`,
        `${G}│${R}  ${RED}-   const token = req.headers.authorization;${R}${' '.repeat(47)}${G}│${R}`,
        `${G}│${R}  ${RED}-   if (!token) return res.status(401).json({ error: 'Unauthorized' });${R}${' '.repeat(20)}${G}│${R}`,
        `${G}│${R}  ${GRN}+ export const authMiddleware = createMiddleware({${R}${' '.repeat(41)}${G}│${R}`,
        `${G}│${R}  ${GRN}+   verify: validateJwt,${R}${' '.repeat(68)}${G}│${R}`,
        `${G}│${R}  ${GRN}+   onError: handleAuthError,${R}${' '.repeat(63)}${G}│${R}`,
        `${G}│${R}  ${GRN}+ });${R}${' '.repeat(85)}${G}│${R}`,
        `${G}╰${'─'.repeat(93)}╯${R}`,
        '',
        `${G}╭${'─'.repeat(93)}╮${R}`,
        `${G}│${R} ${B}Bash${R} npm run typecheck${' '.repeat(69)}${G}│${R}`,
        `${G}│${R}  ${GRN}✓${R} TypeScript compilation successful (2.1s)${' '.repeat(49)}${G}│${R}`,
        `${G}╰${'─'.repeat(93)}╯${R}`,
        '',
        'Extracted the authentication logic into a reusable middleware.',
        `The new \x1b[1mauthMiddleware${R} validates JWTs and handles errors`,
        'consistently across all routes. Typecheck passes.',
      ].join('\r\n');

      // Store as pending content — will auto-fire when terminal's onData listener registers
      (window as any).__pendingTerminalContent[sid] = content;

      // Also fire to any already-registered listeners
      ((window as any).__onDataListeners || []).forEach((cb: any) => cb(sid, content));
    });

    // Now click to open task detail — terminal will get content instantly
    await planningCard.click();
    await beat(page, 2500);
    await chapter(page, '08-task-detail');

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await beat(page, 500);
  }

  // ═══════════════════════════════════════════════════════════
  // ACT 5: DRAG TO DONE
  // ═══════════════════════════════════════════════════════════

  await dragTaskToColumn(page, 'Integration test coverage', 'Done');
  await clearSelection(page);
  await beat(page, 1500);
  await chapter(page, '09-task-completed');

  // ═══════════════════════════════════════════════════════════
  // FINAL: BOARD OVERVIEW
  // ═══════════════════════════════════════════════════════════

  await clearSelection(page);
  await beat(page, 2000);
  await chapter(page, '10-final-board');

  // --- Stop screencast and close ---
  await page.screencast.stop();
  await context.close();
  await browser.close();

  console.log(`Walkthrough saved to: ${OUTPUT_DIR}`);
});
