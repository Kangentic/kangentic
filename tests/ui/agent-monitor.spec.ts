/**
 * UI tests for the cross-project Agent Monitor: the full-surface overlay opened
 * from the title-bar activity button (Mod+Shift+M).
 *
 * The point of the feature is that it shows sessions from EVERY registered
 * project while only one board is open, so the fixture seeds two projects and
 * asserts rows from both are present at once.
 *
 * Layout is asserted through the container's `data-layout` / `data-columns`
 * attributes rather than geometry: CI runs headless Linux, where font metrics and
 * scrollbar widths differ, and pixel-exact layout assertions are banned.
 *
 * Each test launches its own browser (no cross-test state).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A = 'proj-monitor-a';
const PROJECT_B = 'proj-monitor-b';

/**
 * Two projects, each with one live session, plus one paused and one finished so
 * every bucket and the hide-inactive filter have something to act on. Only
 * project A is open, which is exactly the condition the monitor exists for.
 */
function monitorPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      [
        { id: '${PROJECT_A}', name: 'Monitor Alpha', path: '/mock/monitor-a' },
        { id: '${PROJECT_B}', name: 'Monitor Beta', path: '/mock/monitor-b' },
      ].forEach(function (proj) {
        state.projects.push({
          id: proj.id,
          name: proj.name,
          path: proj.path,
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
      });

      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        state.swimlanes.push({
          id: 'lane-monitor-' + index,
          name: lane.name,
          role: lane.role,
          color: lane.color,
          icon: lane.icon,
          is_archived: lane.is_archived,
          permission_strategy: lane.permission_strategy || null,
          auto_spawn: lane.auto_spawn || false,
          position: index,
          created_at: ts,
        });
      });

      // Real board tasks behind the monitor rows below. The rows themselves are
      // seeded synthetically (they come from main's aggregator, not the board),
      // but opening one mounts the REAL task detail, which resolves the task from
      // the board store - so a row with no task behind it can be listed and never
      // opened. Ids match the rows' taskId.
      [
        { id: 'task-a', title: 'Fix PTY capture race', display_id: 142 },
        { id: 'task-b', title: 'Landing copy pass', display_id: 7 },
        { id: 'task-c', title: 'Paused work', display_id: 9 },
      ].forEach(function (seed, index) {
        state.tasks.push({
          id: seed.id,
          title: seed.title,
          description: '',
          display_id: seed.display_id,
          swimlane_id: 'lane-monitor-0',
          position: index,
          labels: [],
          priority: 0,
          run_mode: 'agent',
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      });

      // Live sessions behind the two openable rows. Without these the detail
      // mounts its no-session description branch, and the terminal-ownership
      // assertions below would pass vacuously.
      [
        { id: 'sess-working', taskId: 'task-a', projectId: '${PROJECT_A}', cwd: '/mock/monitor-a' },
        { id: 'sess-other-project', taskId: 'task-b', projectId: '${PROJECT_B}', cwd: '/mock/monitor-b' },
      ].forEach(function (seed, index) {
        state.sessions.push({
          id: seed.id,
          taskId: seed.taskId,
          projectId: seed.projectId,
          pid: 4200 + index,
          status: 'running',
          shell: 'bash',
          cwd: seed.cwd,
          startedAt: ts,
          exitCode: null,
        });
      });

      return { currentProjectId: '${PROJECT_A}' };
    });

    window.__mockMonitorRows = [
      {
        // The one labelled row in the fixture. Every other row here has
        // labels: [], which meant only PEEK_ROWS_WITHOUT_LABELS (the 4-row
        // well) and the unconditional label block ever rendered - the
        // narrower 2-row well and the now-conditional LabelPills block
        // (row.labels.length > 0 && ...) went unexercised. Put on
        // sess-working rather than a new row: a new row would shift every
        // count-based assertion in this file (cards/tableRows/liveOnly
        // counts), while adding a label to an existing row changes nothing
        // any other test checks.
        sessionId: 'sess-working', projectId: '${PROJECT_A}', projectName: 'Monitor Alpha',
        taskId: 'task-a', taskTitle: 'Fix PTY capture race', outputPeek: ['npm run typecheck', 'no errors'], displayId: 142,
        columnName: 'Tests', commandTerminalBranch: null, labels: ['bug'], prUrl: null, prNumber: null, prState: null,
        agentName: 'claude', modelDisplayName: 'Opus 5', effort: 'xhigh', permissionMode: 'plan',
        startedAt: '2026-01-01T00:00:00.000Z', exitedAt: null,
        status: 'running', activity: 'thinking', activityReason: null,
        lastEvent: null, contextPercent: 62, isolated: false, isCommandTerminal: false
      },
      {
        sessionId: 'sess-other-project', projectId: '${PROJECT_B}', projectName: 'Monitor Beta',
        taskId: 'task-b', taskTitle: 'Landing copy pass', outputPeek: [], displayId: 7,
        columnName: 'Doing', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
        agentName: 'claude', modelDisplayName: 'Sonnet 5', effort: 'medium', permissionMode: 'auto',
        startedAt: '2026-01-01T00:02:00.000Z', exitedAt: null,
        status: 'running', activity: 'thinking', activityReason: null,
        lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false
      },
      {
        sessionId: 'sess-paused', projectId: '${PROJECT_A}', projectName: 'Monitor Alpha',
        taskId: 'task-c', taskTitle: 'Paused work', outputPeek: [], displayId: 9,
        columnName: 'To Do', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
        agentName: 'claude', modelDisplayName: null, effort: null, permissionMode: null,
        startedAt: '2026-01-01T00:03:00.000Z', exitedAt: null,
        status: 'suspended', activity: null, activityReason: null,
        lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false
      },
      {
        // A Command Terminal: no task, so no ticket / column / labels, and its
        // title is the slot-numbered name main assigns. The monitor is the only
        // surface that can show these at all.
        sessionId: 'sess-command-terminal', projectId: '${PROJECT_B}', projectName: 'Monitor Beta',
        taskId: 'transient-1', taskTitle: 'Command Terminal 2',
        outputPeek: ['git status', 'nothing to commit'], displayId: null,
        columnName: '', commandTerminalBranch: 'main', labels: [], prUrl: null, prNumber: null, prState: null,
        agentName: 'claude', modelDisplayName: 'Opus 5', effort: null, permissionMode: null,
        startedAt: '2026-01-01T00:04:00.000Z', exitedAt: null,
        status: 'running', activity: 'thinking', activityReason: null,
        lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: true
      }
    ];
  `;
}

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

async function openMonitor(page: Page): Promise<void> {
  await page.locator('[data-testid="agent-monitor-button"]').click();
  await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'visible', timeout: 10000 });
  // The body is lazy; wait for real content rather than the skeleton.
  await page.locator('[data-testid="monitor-grid"]').waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('agent monitor', () => {
  test('lists sessions from every project while only one board is open', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const cards = page.locator('[data-testid="monitor-card"]');
      await expect(cards).toHaveCount(4);

      // The whole point: a session owned by the project that is NOT open. Its
      // project is named by the SECTION (grouping defaults to project), and the
      // card's own eyebrow drops it rather than repeating its header - so the
      // card shows only the column.
      await expect(page.locator('[data-session-id="sess-other-project"]')).toBeVisible();
      await expect(page.locator('[data-testid="monitor-group-header"]', { hasText: 'Monitor Beta' }))
        .toBeVisible();
      await expect(
        page.locator('[data-session-id="sess-other-project"] [data-testid="monitor-card-origin"]'),
      ).toContainText('Doing');

      // Command Terminals appear here and ONLY here: they have no task, so no
      // board card, and the Command Terminal layer only shows the open project.
      // The title carries its slot number so two terminals are tellable apart.
      await expect(
        page.locator('[data-session-id="sess-command-terminal"] [data-testid="monitor-card-title"]'),
      ).toHaveText('Command Terminal 2');
    } finally {
      await browser.close();
    }
  });

  test('every card shows live terminal output, and a terminal reads as a terminal', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      // The peek replaced the static task-description excerpt, and it applies to
      // BOTH row kinds - that uniformity is the point. A task agent shows it...
      await expect(
        page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-peek"]'),
      ).toContainText('npm run typecheck');
      // ...and so does a Command Terminal, whose card was previously empty
      // because a terminal has no description to show.
      await expect(
        page.locator('[data-session-id="sess-command-terminal"] [data-testid="monitor-card-peek"]'),
      ).toContainText('nothing to commit');

      // With both kinds showing terminal text, the state glyph is what separates
      // them. `data-mark` is the branding mark's own test contract.
      await expect(
        page.locator('[data-session-id="sess-working"] svg[data-mark]'),
      ).toHaveAttribute('data-mark', 'agent-working');
      await expect(
        page.locator('[data-session-id="sess-command-terminal"] svg[data-mark]'),
      ).toHaveAttribute('data-mark', 'terminal-working');
    } finally {
      await browser.close();
    }
  });

  test('a Command Terminal names its branch where a task names its column', async () => {
    // The eyebrow answers one question on both card kinds: where is this session
    // working. Leaving it blank for a terminal put the title under an empty row,
    // which reads as a rendering fault beside a task card that fills it.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const terminalOrigin = page.locator('[data-session-id="sess-command-terminal"] [data-testid="monitor-card-origin"]');
      await expect(terminalOrigin.locator('[data-testid="monitor-card-branch"]')).toHaveText('main');

      // A task agent keeps its column and grows no branch, so the slot never
      // shows two different things on one card.
      const taskOrigin = page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-origin"]');
      await expect(taskOrigin).toContainText('Tests');
      await expect(taskOrigin.locator('[data-testid="monitor-card-branch"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a live peek push patches one card without refetching the snapshot', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      // Asserts the STATE (currently subscribed), not the call sequence:
      // StrictMode double-invokes the mount effect, so the log legitimately
      // reads [true, false, true] and pinning that would test React, not us.
      const lastSubscribeCall = () => page.evaluate(() => {
        const calls = (window.electronAPI.monitor as unknown as { __peekSubscribeCalls: boolean[] })
          .__peekSubscribeCalls;
        return calls.length === 0 ? null : calls[calls.length - 1];
      });
      await expect.poll(lastSubscribeCall).toBe(true);

      await page.evaluate(() => window.__mockFireMonitorPeek({
        'sess-working': ['npm test', '42 passed'],
      }));

      await expect(
        page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-peek"]'),
      ).toContainText('42 passed');
      // Untouched sessions keep what they had; a batch names only what changed.
      await expect(
        page.locator('[data-session-id="sess-command-terminal"] [data-testid="monitor-card-peek"]'),
      ).toContainText('nothing to commit');

      // The cost gate: closing the monitor must unsubscribe, or main keeps a PTY
      // output listener and a sampling timer running for nobody.
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'hidden', timeout: 10000 });
      await expect.poll(lastSubscribeCall).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('the peek keeps a fixed height as output arrives, so cards never resize', async () => {
    // The defect this guards: the well used to size to its content, so every
    // message that landed grew or shrank the card and a grid of streaming
    // sessions visibly jittered. Height must not depend on what the terminal
    // happens to be saying.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const peek = page.locator('[data-session-id="sess-command-terminal"] [data-testid="monitor-card-peek"]');
      const card = page.locator('[data-session-id="sess-command-terminal"]');
      await expect(peek).toBeVisible();
      const before = await peek.boundingBox();
      const cardBefore = await card.boundingBox();

      // One line, then three: the extremes of what a session can report.
      await page.evaluate(() => window.__mockFireMonitorPeek({ 'sess-command-terminal': ['one line only'] }));
      await expect(peek).toContainText('one line only');
      const afterShrink = await peek.boundingBox();

      await page.evaluate(() => window.__mockFireMonitorPeek({
        'sess-command-terminal': ['alpha', 'bravo', 'charlie'],
      }));
      await expect(peek).toContainText('charlie');
      const afterGrow = await peek.boundingBox();
      const cardAfter = await card.boundingBox();

      // A tolerance rather than exact equality: font metrics and sub-pixel
      // rounding differ between local Windows and CI's headless Linux.
      expect(Math.abs((afterShrink?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((afterGrow?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((cardAfter?.height ?? 0) - (cardBefore?.height ?? 0))).toBeLessThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });

  test('a peek longer than the card shows keeps the NEWEST lines', async () => {
    // The well is top-aligned, so it cannot rely on clipping to drop the excess:
    // clipping a top-aligned box removes the bottom, which is the newest output.
    // The card trims with `slice(-rows)` instead, dropping the oldest.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const peek = page.locator('[data-session-id="sess-command-terminal"] [data-testid="monitor-card-peek"]');
      await page.evaluate(() => window.__mockFireMonitorPeek({
        'sess-command-terminal': ['oldest line', 'middle line', 'newest line'],
      }));

      await expect(peek).toContainText('newest line');
      // No labels on this row, so it gets the wider form and all three fit.
      await expect(peek).toHaveAttribute('data-rows', '4');
      await expect(peek).toContainText('oldest line');
    } finally {
      await browser.close();
    }
  });

  test('a labelled row gets the narrower two-row peek, and its labels still render beside it', async () => {
    // sess-working is the fixture's one labelled row (see the comment on its
    // seed). Everything else here has labels: [], so PEEK_ROWS_WITH_LABELS
    // and the conditional LabelPills block (`row.labels.length > 0 && ...`)
    // never ran before this test - a revert of either would go unnoticed.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const card = page.locator('[data-session-id="sess-working"]');
      await expect(card.locator('[data-testid="monitor-card-peek"]')).toHaveAttribute('data-rows', '2');
      await expect(card.getByText('bug', { exact: true })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a session with no captured output renders no peek well at all', async () => {
    // `OutputPeek` returns null when `lines.length === 0`. sess-paused and
    // sess-other-project both seed outputPeek: [] and exercise that early
    // return on every run, but nothing asserted its effect - a regression to
    // an empty, visible well would have gone unnoticed.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      await expect(page.locator('[data-session-id="sess-paused"] [data-testid="monitor-card-peek"]')).toHaveCount(0);
      await expect(
        page.locator('[data-session-id="sess-other-project"] [data-testid="monitor-card-peek"]'),
      ).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the monitor card footer draws no rule above it, unlike the board card default', async () => {
    // ContextUsageFooter's `divider` prop defaults to true (the board card's
    // rule); MonitorCard passes divider={false} because its peek well already
    // closes the content region above the footer. Nothing asserted that
    // before this - reverting the prop passed silently. The board-card
    // default (divider omitted, so `border-t` present) is proven by
    // tests/ui/task-card-context-window.spec.ts's usageBar locator, which
    // already renders that exact footer; adding the complementary assertion
    // there is out of scope for this file.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const footer = page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-usage"]');
      await expect(footer).toBeVisible();
      await expect(footer).not.toHaveClass(/border-t/);
    } finally {
      await browser.close();
    }
  });

  test('an unknown context window reads "-", never a fabricated 0%', async () => {
    // sess-other-project, sess-paused, and sess-command-terminal all carry
    // contextPercent: null (no status.json has arrived for them yet). Before
    // this fix MonitorCard passed `percent={row.contextPercent ?? 0}` straight
    // through, so ContextUsageFooter printed a confident "0%" for a value it
    // never actually had - indistinguishable from a session that is genuinely
    // empty. sess-working's known, nonzero window (62%) proves the known path
    // is untouched.
    //
    // Scoped to the percent span (`monitor-card-usage-percent`), not the whole
    // footer: the model-name span can independently render "-" (sess-paused
    // has no modelDisplayName), so an assertion against the footer as a whole
    // is satisfied by either half and does not actually pin the percent label.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const unknownIds = ['sess-other-project', 'sess-paused', 'sess-command-terminal'];
      for (const id of unknownIds) {
        const footer = page.locator(`[data-session-id="${id}"] [data-testid="monitor-card-usage"]`);
        const percentLabel = footer.locator('[data-testid="monitor-card-usage-percent"]');
        await expect(percentLabel).toHaveText('-');
        await expect(footer).toHaveAttribute('data-context-window', 'unknown');
      }

      const knownFooter = page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-usage"]');
      await expect(knownFooter.locator('[data-testid="monitor-card-usage-percent"]')).toHaveText('62%');
      await expect(knownFooter).not.toHaveAttribute('data-context-window', 'unknown');
    } finally {
      await browser.close();
    }
  });

  test('the footer model name falls back to a bare "-", never a derived agent display name', async () => {
    // Guard against `modelName={row.modelDisplayName ?? agentDisplayName(row.agentName)}`
    // returning: sess-paused has modelDisplayName: null and agentName: 'claude', so that
    // older fallback rendered "Claude Code" (agent-display-name.ts) instead of the flat "-"
    // MonitorCard now passes for an unresolved model. sess-working's known model name
    // ("Opus 5") is asserted alongside it so the test cannot pass vacuously against an
    // always-"-" implementation.
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      const pausedModel = page.locator(
        '[data-session-id="sess-paused"] [data-testid="monitor-card-usage-model"]',
      );
      await expect(pausedModel).toHaveText('-');
      await expect(pausedModel).not.toHaveText('Claude Code');

      const workingModel = page.locator(
        '[data-session-id="sess-working"] [data-testid="monitor-card-usage-model"]',
      );
      await expect(workingModel).toHaveText('Opus 5');
    } finally {
      await browser.close();
    }
  });

  test('opens from the keybinding and closes via X and Escape', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      const overlay = page.locator('[data-testid="monitor-page"]');

      const subscriptionCounts = () =>
        page.evaluate(() => {
          const monitorMock = (window as unknown as {
            electronAPI: { monitor: { __subscribeCalls: number; __unsubscribeCalls: number } };
          }).electronAPI.monitor;
          return { subscribes: monitorMock.__subscribeCalls, unsubscribes: monitorMock.__unsubscribeCalls };
        });

      await page.keyboard.press('Control+Shift+M');
      await overlay.waitFor({ state: 'visible', timeout: 10000 });
      // Opening registers the renderer as a live monitor consumer; main only
      // builds and pushes snapshots while some renderer is subscribed.
      await expect.poll(async () => (await subscriptionCounts()).subscribes).toBe(1);

      await page.locator('[data-testid="monitor-close"]').click();
      await overlay.waitFor({ state: 'hidden', timeout: 10000 });
      await expect.poll(async () => (await subscriptionCounts()).unsubscribes).toBe(1);

      await page.locator('[data-testid="agent-monitor-button"]').click();
      await overlay.waitFor({ state: 'visible', timeout: 10000 });
      await expect.poll(async () => (await subscriptionCounts()).subscribes).toBe(2);
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'hidden', timeout: 10000 });
      await expect.poll(async () => (await subscriptionCounts()).unsubscribes).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('a state change re-buckets a card under a labelled separator', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      // This is about STATE bucketing, so switch to it: the shipped default is
      // grouping by project. The separators are what make the movement legible,
      // and section labels use the app's own activity vocabulary (Idle / Active),
      // not invented synonyms.
      await page.locator('[data-testid="monitor-toolbar"] button', { hasText: 'Status' }).click();
      const headers = page.locator('[data-testid="monitor-group-header"]');
      await expect(headers.first()).toContainText('Active');

      // Drive the unbuffered SESSION_ACTIVITY path: this is what must re-bucket a
      // row WITHOUT a snapshot refetch.
      await page.evaluate(() => {
        (window as unknown as {
          __mockFireActivity: (
            id: string, state: string, reason: unknown, projectId: string, taskId: string,
          ) => void;
        }).__mockFireActivity(
          'sess-working', 'permission', { kind: 'permission', since: Date.now() - 60000 },
          'proj-monitor-a', 'task-a',
        );
      });

      // Permission counts as needing the user, so the row moves under the "Idle"
      // separator and the summary count picks it up. This is the honesty check:
      // an earlier build froze positions through a bucket change, which left an
      // active agent sitting above one that needed the user.
      await expect(headers.first()).toContainText('Idle');
      await expect(page.locator('[data-testid="monitor-summary-needs-you-value"]')).toHaveText('1');
      await expect(page.locator('[data-testid="monitor-card"]').first())
        .toHaveAttribute('data-session-id', 'sess-working');
    } finally {
      await browser.close();
    }
  });

  test('live only removes paused sessions, and the text filter narrows by title', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      const cards = page.locator('[data-testid="monitor-card"]');
      await expect(cards).toHaveCount(4);

      // A toggle pill (aria-pressed), matching the usage dashboard's control
      // vocabulary rather than a bare checkbox.
      const liveOnly = page.locator('[data-testid="monitor-live-only"]');
      await liveOnly.click();
      await expect(liveOnly).toHaveAttribute('aria-pressed', 'true');
      await expect(cards).toHaveCount(3);
      await expect(page.locator('[data-session-id="sess-paused"]')).toHaveCount(0);

      await liveOnly.click();
      await expect(liveOnly).toHaveAttribute('aria-pressed', 'false');
      await expect(cards).toHaveCount(4);

      await page.locator('[data-testid="monitor-text-filter"]').fill('Landing');
      await expect(cards).toHaveCount(1);
      await expect(page.locator('[data-session-id="sess-other-project"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  /**
   * Asserts each layout actually RENDERS differently, not merely that the
   * `data-layout` attribute flipped. An earlier version of this spec checked only
   * the attribute, and passed while the table and list layouts were inert -
   * the toolbar switched a value that nothing downstream read.
   */
  test('each layout renders its own presentation, not just a changed attribute', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      const cards = page.locator('[data-testid="monitor-card"]');
      const tableRows = page.locator('[data-testid="monitor-table-row"]');

      // Cards: roomy cards, no table.
      await expect(cards).toHaveCount(4);
      await expect(tableRows).toHaveCount(0);
      await expect(cards.first()).not.toHaveAttribute('data-dense', 'true');

      // Table: real table rows, no cards. Grouping still applies - a <table>
      // cannot interleave section headers, so each group gets its own table
      // rather than grouping being silently disabled here.
      await page.locator('[data-testid="monitor-layout-table"]').click();
      await expect(tableRows).toHaveCount(4);
      await expect(cards).toHaveCount(0);
      // Two buckets in the fixture (Active, Paused) => two headers AND two
      // tables. The duplicated column headers are the tell that each group got
      // its own table rather than everything collapsing into one.
      await expect(page.locator('[data-testid="monitor-group-header"]')).toHaveCount(2);
      await expect(page.locator('table')).toHaveCount(2);
      // Effort and permission mode are surfaced as their own sortable columns.
      await expect(page.locator('th', { hasText: 'Effort' }).first()).toBeVisible();
      await expect(page.locator('th', { hasText: 'Permission' }).first()).toBeVisible();

      // List: cards again, but dense and forced to a single column.
      await page.locator('[data-testid="monitor-layout-list"]').click();
      await expect(tableRows).toHaveCount(0);
      await expect(cards.first()).toHaveAttribute('data-dense', 'true');
      await expect(page.locator('[data-testid="monitor-grid"]')).toHaveAttribute('data-columns', '1');

      // Back to cards: the column count must RECOVER. Switching layout does not
      // resize the container, so a resize-observer-only implementation stays
      // stuck at the list layout's single column on a wide screen.
      await page.locator('[data-testid="monitor-layout-cards"]').click();
      await expect(cards.first()).not.toHaveAttribute('data-dense', 'true');
      await expect.poll(
        async () => Number(await page.locator('[data-testid="monitor-grid"]').getAttribute('data-columns')),
        { timeout: 10000 },
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test('the chosen view survives closing and reopening the monitor', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);

      await page.locator('[data-testid="monitor-layout-table"]').click();
      await expect(page.locator('[data-testid="monitor-table-row"]')).toHaveCount(4);
      await expect(page.locator('[data-testid="monitor-grid"]')).toHaveAttribute('data-layout', 'table');

      await page.locator('[data-testid="monitor-close"]').click();
      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'hidden', timeout: 10000 });

      await openMonitor(page);
      await expect(page.locator('[data-testid="monitor-grid"]')).toHaveAttribute('data-layout', 'table');
      await expect(page.locator('[data-testid="monitor-table-row"]')).toHaveCount(4);
    } finally {
      await browser.close();
    }
  });

  /**
   * A row click no longer decides WHERE the detail opens - it asks main, which
   * owns the never-open-twice rule and the board-vs-pop-out placement. The spec
   * asserts the request is made and the monitor steps aside; where main routes it
   * is covered by tests/unit/detail-owner-registry.test.ts, which can exercise
   * the multi-renderer cases a single-page UI test cannot.
   */
  /** Ownership as the mock records it, mirroring main's registry. */
  async function ownerHosts(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const owners = (window as unknown as {
        electronAPI: { taskDetailOwnership: { __owners: Record<string, { host: string }> } };
      }).electronAPI.taskDetailOwnership.__owners;
      return Object.fromEntries(Object.entries(owners).map(([key, value]) => [key, value.host]));
    });
  }

  // ── the persisted layout (AppConfig.monitorWorkspace) ──
  //
  // The monitor's window store is a module singleton, so an in-app close/reopen brings
  // its windows back on its own. The BLOB is what carries a detail across the renderer
  // boundary to and from the pop-out, which a UI test cannot open - so these drive the
  // blob directly, which is the half that has no other coverage.

  /** The saved monitor layout, as the renderer has persisted it. */
  const savedMonitorAnchors = (page: Page) => page.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI: { config: { get: () => Promise<{ monitorWorkspace?: { windows: Array<{ taskId: string }> } | null }> } };
    }).electronAPI;
    const config = await api.config.get();
    return (config.monitorWorkspace?.windows ?? []).map((entry) => entry.taskId);
  });

  test('a detail opened in the monitor is persisted to the shared layout blob', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'monitor');

      // This is what the pop-out (a separate renderer with its own empty store) reads
      // to take the window over. Debounced, so poll.
      await expect.poll(() => savedMonitorAnchors(page), { timeout: 10000 })
        .toEqual([`${PROJECT_A}:task-a`]);
    } finally {
      await browser.close();
    }
  });

  test('closing every detail saves an empty layout, so nothing comes back', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(() => savedMonitorAnchors(page), { timeout: 10000 })
        .toEqual([`${PROJECT_A}:task-a`]);

      // A deliberate close must not be undone by the next restore.
      await page.locator('#monitor-detail-layer-root [data-testid="task-detail-close"]').click();
      await expect.poll(() => savedMonitorAnchors(page), { timeout: 10000 }).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a saved layout restores its detail when the monitor opens with nothing open', async () => {
    // Seeded as if another host (the pop-out) had saved it: this renderer's monitor
    // store starts empty, so the window can only come from the blob.
    const withSavedLayout = `${monitorPreConfig()}
      window.__mockPreConfigure(function (state) {
        state.config.monitorWorkspace = {
          version: 1,
          windows: [{
            taskId: '${PROJECT_A}:task-a',
            kind: 'task-detail',
            title: 'Fix PTY capture race',
            geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.6 },
            restoreGeometry: null,
            state: 'floating',
          }],
          tileTree: null,
          tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
          focusedTaskId: null,
        };
        return {};
      });
    `;
    const { browser, page } = await launchWithState(withSavedLayout);
    try {
      await openMonitor(page);

      const monitorWindows = page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
      await expect.poll(() => monitorWindows.count(), { timeout: 10000 }).toBe(1);
      // Restored windows must be OWNED, or the task could be opened a second time
      // elsewhere - the derived reporter is what announces them.
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'monitor');
    } finally {
      await browser.close();
    }
  });

  test('the restore does NOT steal a task the board already has open', async () => {
    const withSavedLayout = `${monitorPreConfig()}
      window.__mockPreConfigure(function (state) {
        state.config.monitorWorkspace = {
          version: 1,
          windows: [{
            taskId: '${PROJECT_A}:task-a',
            kind: 'task-detail',
            title: 'Fix PTY capture race',
            geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.6 },
            restoreGeometry: null,
            state: 'floating',
          }],
          tileTree: null,
          tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
          focusedTaskId: null,
        };
        return {};
      });
    `;
    const { browser, page } = await launchWithState(withSavedLayout);
    try {
      // Open it on the board FIRST, then open the monitor. Restoring the saved layout
      // would report ownership main has to resolve by displacing the board - so simply
      // opening the monitor would yank the window the user is working in.
      await page.locator('[data-task-id="task-a"]').click();
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'board');

      await openMonitor(page);
      const monitorWindows = page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
      // Give the restore effect room to have run and been wrong.
      await page.waitForTimeout(600);
      expect(await monitorWindows.count()).toBe(0);
      expect(await ownerHosts(page)).toHaveProperty(`${PROJECT_A}:task-a`, 'board');
    } finally {
      await browser.close();
    }
  });

  test('clicking a row opens the detail IN the monitor, which stays open behind it', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-other-project"] [data-testid="monitor-card-title"]').click();

      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_B}:task-b`, 'monitor');
      // The monitor is the surface you are operating from, so it does not step
      // aside the way it used to when it handed the task to the board.
      await expect(page.locator('[data-testid="monitor-page"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the same task cannot be open twice, and the board takes it back', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'monitor');

      // Clicking the same row again focuses rather than mounting a second.
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(async () => page.evaluate(
        () => document.querySelectorAll('[data-testid="task-detail-dialog"]').length,
      ), { timeout: 10000 }).toBe(1);

      // Opening it on the board takes it back - the one exception to "a monitor
      // click keeps it here". Driven the way a user would: close the monitor,
      // click the task's card.
      await page.locator('[data-testid="monitor-close"]').click();
      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'hidden', timeout: 10000 });
      await page.locator('[data-task-id="task-a"]').click();

      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'board');
      await expect.poll(async () => page.evaluate(
        () => document.querySelectorAll('[data-testid="task-detail-dialog"]').length,
      ), { timeout: 10000 }).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('a monitor-hosted detail claims its session, so only one xterm owns the PTY', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'monitor');

      // `dialogSessionIds` is the renderer-GLOBAL "a detail window owns this
      // session" set that the bottom terminal panel reads to decide whether to
      // render its own xterm. It used to be reconciled from the BOARD's windows
      // alone, which made the reconciler authoritative over claims it could not
      // see: it erased the monitor's claim a frame after the monitor made it, the
      // panel re-mounted an xterm for the same PTY, and the two fitters resized
      // one terminal to two different widths - a terminal that looks frozen and
      // overflows until you resize the window by hand.
      //
      // Asserted as programmatic state rather than by counting xterms: the UI
      // tier's mock has no real PTY, so the claim IS the observable behaviour.
      await expect.poll(
        () => page.evaluate(() => window.__zustandStores?.session?.getState().dialogSessionIds ?? []),
        { timeout: 10000 },
      ).toEqual(['sess-working']);

      // Closing the window releases the claim, so the panel can take it back.
      await page.locator('[data-testid="monitor-scroll"]').click({ position: { x: 8, y: 8 } });
      await expect.poll(
        () => page.evaluate(() => window.__zustandStores?.session?.getState().dialogSessionIds ?? []),
        { timeout: 10000 },
      ).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  /**
   * `MonitorTaskDetailHost` refetches its bundle on `snapshotGeneration`, not on
   * the store's `rows` identity - `applyActivity` replaces `rows` on EVERY
   * cross-project activity tick, so keying the effect on `rows` fired a
   * `getTaskDetail` round trip per tick for as long as a detail stayed open.
   * `sess-other-project` is chosen deliberately: it is a session the seeded
   * snapshot already tracks (so `applyActivity` actually replaces `rows`,
   * proving the tick applied), and it belongs to a DIFFERENT task than the one
   * whose detail is open, so this is a genuinely unrelated tick.
   */
  test('a monitor task detail does not refetch its bundle per activity tick', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'monitor');
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10000 });

      const getTaskDetailCalls = () => page.evaluate(() => (window as unknown as {
        electronAPI: { monitor: { __getTaskDetailCalls: number } };
      }).electronAPI.monitor.__getTaskDetailCalls);

      // StrictMode double-invokes the mount effect in dev, so the initial fetch
      // can still be settling right after the dialog appears. Poll for the call
      // count to stop growing before recording the baseline (mirrors the
      // scrollback-stability pattern for a settling async count).
      let lastCount = -1;
      await expect.poll(async () => {
        const current = await getTaskDetailCalls();
        const stable = current === lastCount && current > 0;
        lastCount = current;
        return stable;
      }, { timeout: 5000, intervals: [200, 200, 200, 200, 200] }).toBe(true);
      const initialCalls = lastCount;

      // Fire several activity pushes for a DIFFERENT session that IS present in
      // the seeded snapshot. `applyActivity` drops an unknown session id without
      // touching `rows` at all, so a tick for an untracked session would pass
      // vacuously even against the buggy `rows`-keyed effect - `sess-other-project`
      // avoids that.
      for (let tick = 0; tick < 5; tick += 1) {
        await page.evaluate(() => {
          (window as unknown as {
            __mockFireActivity: (
              id: string, state: string, reason: unknown, projectId: string, taskId: string,
            ) => void;
          }).__mockFireActivity(
            'sess-other-project', 'permission', { kind: 'permission', since: Date.now() },
            'proj-monitor-b', 'task-b',
          );
        });
      }

      // Confirm the ticks actually applied (rows array replaced) before trusting
      // the non-occurrence assertion below: sess-other-project moves into the
      // needs-you bucket, which the summary tile counts across every project.
      await expect(page.locator('[data-testid="monitor-summary-needs-you-value"]')).toHaveText('1');

      expect(await getTaskDetailCalls()).toBe(initialCalls);
    } finally {
      await browser.close();
    }
  });

  test('closing the monitor with a detail open releases the claim (no starved panel)', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(
        () => page.evaluate(() => window.__zustandStores?.session?.getState().dialogSessionIds ?? []),
        { timeout: 10000 },
      ).toEqual(['sess-working']);

      // The monitor's layer lives INSIDE MonitorPage, so closing the monitor
      // unmounts it - but the window-manager stores are module singletons that
      // deliberately outlive their subtree, so the window record survives. The
      // claim must not: an unmounted layer has no xterm, so holding the claim
      // would permanently stop the bottom panel from taking the terminal back,
      // with no window anywhere to explain why.
      await page.locator('[data-testid="monitor-close"]').click();
      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'hidden', timeout: 10000 });

      await expect.poll(
        () => page.evaluate(() => window.__zustandStores?.session?.getState().dialogSessionIds ?? []),
        { timeout: 10000 },
      ).toEqual([]);

      // Reopening re-mounts the layer, which still has the window, so the claim
      // comes back. The window survives the toggle; only the claim is transient.
      await openMonitor(page);
      await expect.poll(
        () => page.evaluate(() => window.__zustandStores?.session?.getState().dialogSessionIds ?? []),
        { timeout: 10000 },
      ).toEqual(['sess-working']);
    } finally {
      await browser.close();
    }
  });

  test('a dismissed detail can be reopened, even after the monitor was closed in between', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    const monitorWindows = () => page.evaluate(
      () => document.querySelectorAll('#monitor-detail-layer-root [data-testid^="window-frame-"]').length,
    );
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(monitorWindows, { timeout: 10000 }).toBe(1);

      // Close and reopen the MONITOR with the detail still open. This unmounts the
      // detail layer (it lives inside MonitorPage) while main's ownership record
      // survives - the exact gap that made the claim un-releasable.
      await page.locator('[data-testid="monitor-close"]').click();
      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'hidden', timeout: 10000 });
      await openMonitor(page);
      await expect.poll(monitorWindows, { timeout: 10000 }).toBe(1);

      // Now dismiss the window. The release must still happen, even though the
      // bridge that opened it is long gone.
      await page.locator('[data-testid="monitor-scroll"]').click({ position: { x: 8, y: 8 } });
      await expect.poll(monitorWindows, { timeout: 10000 }).toBe(0);

      // The load-bearing assertion: the task opens again. Before the claim was
      // reconciled from the store, main still answered `focused-existing` here and
      // the click did nothing at all - no window, no error, no way back.
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(monitorWindows, { timeout: 10000 }).toBe(1);
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'monitor');
    } finally {
      await browser.close();
    }
  });

  test('the bottom panel yields its terminal to a detail hosted in another renderer', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    const panelPane = page.locator('[data-testid="terminal-session-pane"]');
    const panelTab = page.locator('[data-testid="terminal-session-tab"][data-session-id="sess-working"]');
    try {
      // The board's panel auto-selects the live session for the open project and
      // mounts its terminal. Nothing else owns it yet.
      await panelPane.waitFor({ state: 'visible', timeout: 10000 });
      await panelTab.waitFor({ state: 'visible', timeout: 10000 });

      // Now the DETACHED monitor takes that task's detail. Main pushes the claim to
      // this renderer (already filtered to "not yours"). Before this existed the
      // push did not exist at all: ownership was renderer-local, so the panel kept
      // its xterm and a second one lived in the pop-out - two fitters on one PTY,
      // each resizing it to a different width, which is why the board's panel went
      // blank or mis-wrapped while the pop-out drove the agent fine.
      await page.evaluate(
        ({ projectId, taskId }) => {
          const setOwners = (window as unknown as {
            __mockSetRemoteDetailOwners?: (owners: Array<{ projectId: string; taskId: string }>) => void;
          }).__mockSetRemoteDetailOwners;
          if (!setOwners) throw new Error('__mockSetRemoteDetailOwners not exposed');
          setOwners([{ projectId, taskId }]);
        },
        { projectId: PROJECT_A, taskId: 'task-a' },
      );

      await panelPane.waitFor({ state: 'hidden', timeout: 10000 });

      // ...and the TAB goes with it. A tab left behind would select a pane that
      // renders nothing: the terminal detached to the surface the user opened it
      // on, which is the same thing that happens for a board task-detail window.
      await panelTab.waitFor({ state: 'hidden', timeout: 10000 });

      // Handing it back (the pop-out closed) returns the terminal to the panel.
      await page.evaluate(() => {
        const setOwners = (window as unknown as {
          __mockSetRemoteDetailOwners?: (owners: Array<{ projectId: string; taskId: string }>) => void;
        }).__mockSetRemoteDetailOwners;
        setOwners?.([]);
      });
      await panelTab.waitFor({ state: 'visible', timeout: 10000 });
      await panelPane.waitFor({ state: 'visible', timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('a click on the monitor dismisses ITS window and leaves the board\'s alone', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      // A board window first, then the monitor stacked over it.
      await page.locator('[data-task-id="task-a"]').click();
      await expect.poll(() => ownerHosts(page), { timeout: 10000 })
        .toHaveProperty(`${PROJECT_A}:task-a`, 'board');

      await openMonitor(page);
      const boardWindows = () => page.evaluate(
        () => document.querySelectorAll('#window-layer-root [data-testid^="window-frame-"]').length,
      );
      const monitorWindows = () => page.evaluate(
        () => document.querySelectorAll('#monitor-detail-layer-root [data-testid^="window-frame-"]').length,
      );
      expect(await boardWindows()).toBe(1);

      // Open a SECOND task in the monitor, so both layers hold one window.
      await page.locator('[data-session-id="sess-other-project"] [data-testid="monitor-card-title"]').click();
      await expect.poll(monitorWindows, { timeout: 10000 }).toBe(1);

      // A click on the monitor's dead space is not a click on the board: the
      // monitor overlay COVERS the board. Before the dismiss surfaces were scoped
      // per layer, this reached straight through and closed the board's window.
      await page.locator('[data-testid="monitor-scroll"]').click({ position: { x: 8, y: 8 } });

      await expect.poll(monitorWindows, { timeout: 10000 }).toBe(0);
      expect(await boardWindows()).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('right-clicking a row offers Open on board as the explicit override', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      await page.locator('[data-session-id="sess-other-project"]').click({ button: 'right' });

      const menu = page.locator('[data-testid="monitor-row-menu"]');
      await expect(menu).toBeVisible();

      // Full parity with the board's card menu: this IS TaskContextMenu, with
      // "Open on board" added at the top. A thinner lookalike would drift the
      // first time an item is added to the board's.
      await expect(page.locator('[data-testid="monitor-menu-open-on-board"]')).toBeVisible();
      await expect(page.locator('[data-testid="context-copy-task-id"]')).toBeVisible();
      await expect(page.locator('[data-testid="context-edit-task"]')).toBeVisible();
      await expect(menu.getByText('Move to', { exact: false })).toBeVisible();
      await expect(menu.getByText('Archive', { exact: true })).toBeVisible();
      await expect(menu.getByText('Delete', { exact: true })).toBeVisible();

      await page.locator('[data-testid="monitor-menu-open-on-board"]').click();

      await page.locator('[data-testid="monitor-page"]').waitFor({ state: 'hidden', timeout: 10000 });
      // This route deliberately bypasses the arbiter's placement and deep-links
      // to the board, switching project on the way.
      await expect.poll(async () => page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { projects: { getCurrent: () => Promise<{ id: string } | null> } };
        }).electronAPI;
        return api.projects.getCurrent().then((project) => project?.id ?? null);
      }), { timeout: 10000 }).toBe(PROJECT_B);
    } finally {
      await browser.close();
    }
  });

  /**
   * The Command Terminal layer sits ABOVE the monitor in the z-ladder (45 vs 42).
   * Opening the monitor with a terminal up therefore put the whole surface behind
   * the terminal and its backdrop - present, but covered and unclickable, which
   * reads as the Command Terminal refusing to go away. The two full-surface layers
   * are mutually exclusive instead. This test fails by TIMING OUT on the row click
   * (the backdrop swallows it), which is exactly the user-visible symptom.
   */
  test('opening the monitor hides the Command Terminal layer rather than opening behind it', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await page.getByTestId('quick-session-button').click();
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      await openMonitor(page);
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });

      // And the monitor is genuinely interactive, not merely painted on top: a
      // row click now opens the detail IN the monitor, so the proof is that the
      // click reached a row at all.
      await page.locator('[data-session-id="sess-working"] [data-testid="monitor-card-title"]').click();
      await expect.poll(async () => page.evaluate(() => {
        const owners = (window as unknown as {
          electronAPI: { taskDetailOwnership: { __owners: Record<string, unknown> } };
        }).electronAPI.taskDetailOwnership.__owners;
        return Object.keys(owners).length;
      }), { timeout: 10000 }).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('the card grid actually adds columns at a wide width and collapses when narrow', async () => {
    const { browser, page } = await launchWithState(monitorPreConfig());
    try {
      await openMonitor(page);
      const grid = page.locator('[data-testid="monitor-grid"]');

      // The whole point of the full-screen layout: a wide window must add
      // COLUMNS, not just stretch one. Asserted via the measured attribute rather
      // than geometry, since CI is headless Linux (no pixel-exact assertions).
      await expect.poll(
        async () => Number(await grid.getAttribute('data-columns')),
        { timeout: 10000 },
      ).toBeGreaterThanOrEqual(2);

      // Narrow past the smallest step (850px on the grid container): it must fall
      // back to a single column rather than overflowing. 900px of viewport leaves
      // the container under that once the surface's own padding is taken out.
      await page.setViewportSize({ width: 700, height: 900 });
      await expect.poll(
        async () => Number(await grid.getAttribute('data-columns')),
        { timeout: 10000 },
      ).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('shows a zero-state when no agents are running anywhere', async () => {
    const { browser, page } = await launchWithState(`
      ${monitorPreConfig()}
      window.__mockMonitorRows = [];
    `);
    try {
      await openMonitor(page);
      await expect(page.locator('[data-testid="monitor-empty"]')).toBeVisible();
      await expect(page.locator('[data-testid="monitor-card"]')).toHaveCount(0);
      // The summary tiles go too. Four tiles reading 0 above a zero-state that
      // already says "no agents running" is the same fact stated five times.
      await expect(page.locator('[data-testid="monitor-summary"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
