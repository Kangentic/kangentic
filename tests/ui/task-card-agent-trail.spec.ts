/**
 * UI tests for the board card's agent message trail (the `cardPreview` setting).
 *
 * Intent: with Card Preview at its default (`agent-latest-message`), a card whose
 * session is RUNNING and has a trail prints the agent's newest message in the
 * description slot (`data-testid="task-card-trail"`), inside `OutputPeek`'s
 * terminal well, wrapped to three lines at default density, five at comfortable
 * and one at compact. `agent-messages` prints one truncated line per message,
 * newest LAST, in those same lines. Flipping the setting to `description` swaps
 * the slot on every card with no reload.
 *
 * RUNNING is load-bearing and has its own two cases below. A trail outlives its
 * session, so a paused or exited card holds one in the store and must still show
 * its description (`data-testid="task-card-description"`) rather than print agent
 * prose with no activity mark to say so. Same for a task with no session at all,
 * or one whose agent has not spoken yet.
 *
 * The trail arrives the way main pushes it, through `sessions.onMessageTrail`
 * (fired here via `window.__mockFireMessageTrail`); a card never fetches a
 * transcript. The setting is written through the real config write path
 * (`__zustandStores.config`), the same one the Task tab's select uses.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-agent-trail';
const RUNNING_TASK_ID = 'task-agent-trail-running';
const RUNNING_SESSION_ID = 'session-agent-trail-running';
const RUNNING_DESCRIPTION = 'Spike: measure whether a static demo build of the landing page is viable.';
const IDLE_TASK_ID = 'task-agent-trail-no-session';
const IDLE_DESCRIPTION = 'Board Manager has no UI for transition actions, so a team edits JSON by hand.';
/** Archived, so DoneSwimlane renders it through the compact={true} branch. */
const COMPACT_TASK_ID = 'task-agent-trail-compact';
const COMPACT_SESSION_ID = 'session-agent-trail-compact';
const COMPACT_LINE = 'Merged PR #641 and fast-forwarded main.';
/** A paused session that still holds a trail: the case the live gate exists for. */
const PAUSED_TASK_ID = 'task-agent-trail-paused';
const PAUSED_SESSION_ID = 'session-agent-trail-paused';
const PAUSED_DESCRIPTION = 'Memory graph: an Obsidian-like node view over the conversation-memory index.';
const PAUSED_TRAIL_LINE = 'Parking this until the retrieval index lands.';

interface TrailEntry { uuid: string; ts: number; text: string }

const FOUR_LINES: TrailEntry[] = [
  { uuid: 'a1', ts: 1, text: 'Read task #76 on the website board.' },
  { uuid: 'a2', ts: 2, text: 'Measured the landing slot: the hero box is 1120 by 700.' },
  { uuid: 'a3', ts: 3, text: 'Building the static frame from the marketing fixture.' },
  { uuid: 'a4', ts: 4, text: 'Running the capture now.' },
];
const FIFTH_LINE: TrailEntry = { uuid: 'a5', ts: 5, text: 'The first PNG is 4.1 MB, so I am trimming the font subset.' };

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Agent Trail Test',
      path: '/mock/agent-trail-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: timestamp,
      created_at: timestamp,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-trail-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });

    state.sessions.push({
      id: '${RUNNING_SESSION_ID}',
      taskId: '${RUNNING_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/agent-trail-test',
      startedAt: timestamp,
      exitCode: null,
      resuming: false,
      agentSessionId: 'agent-trail-running',
    });
    state.activityCache['${RUNNING_SESSION_ID}'] = 'thinking';

    state.tasks.push({
      id: '${RUNNING_TASK_ID}',
      display_id: 626,
      title: 'Spike: static demo build of the landing page',
      description: '${RUNNING_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${RUNNING_SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    state.tasks.push({
      id: '${IDLE_TASK_ID}',
      display_id: 631,
      title: 'Board Manager UI for transition actions',
      description: '${IDLE_DESCRIPTION}',
      swimlane_id: laneIds['To Do'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    // A suspended session that still holds a trail. Main retains a trail past a
    // pause ("a paused or exited card keeps what its agent last said"), so this
    // is the card that used to print agent prose with no activity mark and no
    // progress bar to say who wrote it.
    state.sessions.push({
      id: '${PAUSED_SESSION_ID}',
      taskId: '${PAUSED_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: null,
      status: 'suspended',
      shell: 'bash',
      cwd: '/mock/agent-trail-test',
      startedAt: timestamp,
      exitCode: null,
      resuming: false,
      agentSessionId: 'agent-trail-paused',
    });
    state.messageTrailCache['${PAUSED_SESSION_ID}'] = [
      { uuid: 'p1', ts: 1, text: 'Pulled the edge list out of the index.' },
      { uuid: 'p2', ts: 2, text: '${PAUSED_TRAIL_LINE}' },
    ];
    state.tasks.push({
      id: '${PAUSED_TASK_ID}',
      display_id: 529,
      title: 'Memory graph: a visual node view',
      description: '${PAUSED_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 1,
      agent: 'claude',
      session_id: '${PAUSED_SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    // An archived task whose exited session still holds a trail: same retention,
    // and the Done list's compact card must fall back the same way.
    state.sessions.push({
      id: '${COMPACT_SESSION_ID}',
      taskId: '${COMPACT_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: null,
      status: 'exited',
      shell: 'bash',
      cwd: '/mock/agent-trail-test',
      startedAt: timestamp,
      exitCode: 0,
      resuming: false,
      agentSessionId: 'agent-trail-compact',
    });
    state.messageTrailCache['${COMPACT_SESSION_ID}'] = [
      { uuid: 'c1', ts: 1, text: 'Reading the Changes panel base badge code.' },
      { uuid: 'c2', ts: 2, text: '${COMPACT_LINE}' },
    ];
    state.archivedTasks.push({
      id: '${COMPACT_TASK_ID}',
      display_id: 612,
      title: 'Changes panel: stale base badge after a fetch',
      description: 'The base badge does not re-measure after a fetch.',
      swimlane_id: laneIds['Done'],
      position: 0,
      agent: 'claude',
      session_id: '${COMPACT_SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

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

/**
 * The trail's text lines.
 *
 * Two levels down, not one: the trail root is now `OutputPeek`'s well and its
 * only child is the fixed-height box the well wraps, so the lines themselves sit
 * inside that. Asserting on `> div` would silently assert on the box.
 */
function trailLines(trail: ReturnType<Page['locator']>): ReturnType<Page['locator']> {
  return trail.locator('> div > div');
}

/** Push a session's whole trail the way main does on `session:messageTrail`. */
async function fireTrail(page: Page, sessionId: string, entries: TrailEntry[]): Promise<void> {
  await page.evaluate(({ sessionId: id, entries: lines }) => {
    (window as unknown as {
      __mockFireMessageTrail: (sessionId: string, entries: TrailEntry[], projectId?: string) => void;
    }).__mockFireMessageTrail(id, lines);
  }, { sessionId, entries });
}

/** Write a global config field through the real path the Task tab's controls use. */
async function updateConfig(page: Page, partial: Record<string, string>): Promise<void> {
  await page.evaluate((value) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { updateConfig: (partial: Record<string, string>) => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().updateConfig(value);
  }, partial);
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('cardPreview: agent message trail on the board card', () => {
  test('a running task with no trail yet prints its description', async () => {
    const card = page.locator(`[data-task-id="${RUNNING_TASK_ID}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('task-card-description')).toHaveText(RUNNING_DESCRIPTION);
    await expect(card.getByTestId('task-card-trail')).toHaveCount(0);
  });

  test('a pushed trail takes the slot with the newest message wrapped to three lines, and updates live', async () => {
    const card = page.locator(`[data-task-id="${RUNNING_TASK_ID}"]`);
    await fireTrail(page, RUNNING_SESSION_ID, FOUR_LINES);

    const trail = card.getByTestId('task-card-trail');
    await expect(trail).toBeVisible({ timeout: 5000 });
    await expect(trail).toHaveAttribute('data-mode', 'latest');
    await expect(trail).toHaveAttribute('data-lines', '3');
    await expect(trailLines(trail)).toHaveText([FOUR_LINES[3].text]);
    await expect(trailLines(trail)).toHaveClass(/line-clamp-3/);
    await expect(card.getByTestId('task-card-description')).toHaveCount(0);

    // A new message arrives: the slot swaps to it with no click and no reload.
    await fireTrail(page, RUNNING_SESSION_ID, [...FOUR_LINES, FIFTH_LINE]);
    await expect(trailLines(trail)).toHaveText([FIFTH_LINE.text]);
  });

  test('the recent-messages option lists the newest lines, newest last, at every density', async () => {
    const card = page.locator(`[data-task-id="${RUNNING_TASK_ID}"]`);
    await updateConfig(page, { cardPreview: 'agent-messages' });

    const trail = card.getByTestId('task-card-trail');
    await expect(trail).toHaveAttribute('data-mode', 'lines');
    await expect(trail).toHaveAttribute('data-lines', '3');
    await expect(trailLines(trail)).toHaveText([...FOUR_LINES.slice(-2), FIFTH_LINE].map((entry) => entry.text));

    await updateConfig(page, { cardDensity: 'comfortable' });
    await expect(trail).toHaveAttribute('data-lines', '5');
    await expect(trailLines(trail)).toHaveCount(5);
    await updateConfig(page, { cardDensity: 'compact' });
    await expect(trail).toHaveAttribute('data-lines', '1');
    await expect(trailLines(trail)).toHaveText([FIFTH_LINE.text]);

    // The 'agent-messages' fallback is mode-agnostic too: a task with no
    // session still prints its description under this mode as well. Asserted
    // here, while cardPreview is still 'agent-messages', because by the time
    // the standalone no-session case below runs, this test has already reset
    // cardPreview to 'agent-latest-message' and would never exercise this
    // combination. The mode check pins that precondition: the idle card's
    // description also renders correctly under 'agent-latest-message', so
    // without it this case would pass even if the mode were not actually
    // 'agent-messages' at this point.
    await expect(trail).toHaveAttribute('data-mode', 'lines');
    const idleCard = page.locator(`[data-task-id="${IDLE_TASK_ID}"]`);
    await expect(idleCard.getByTestId('task-card-description')).toHaveText(IDLE_DESCRIPTION);
    await expect(idleCard.getByTestId('task-card-trail')).toHaveCount(0);

    await updateConfig(page, { cardDensity: 'default' });
    await updateConfig(page, { cardPreview: 'agent-latest-message' });
    await expect(trail).toHaveAttribute('data-mode', 'latest');
  });

  test('a task with no session keeps its description', async () => {
    const card = page.locator(`[data-task-id="${IDLE_TASK_ID}"]`);
    await expect(card.getByTestId('task-card-description')).toHaveText(IDLE_DESCRIPTION);
    await expect(card.getByTestId('task-card-trail')).toHaveCount(0);
  });

  test('flipping Card Preview to the description swaps the slot with no reload, and back', async () => {
    const card = page.locator(`[data-task-id="${RUNNING_TASK_ID}"]`);
    await expect(card.getByTestId('task-card-trail')).toBeVisible();

    await updateConfig(page, { cardPreview: 'description' });
    await expect(card.getByTestId('task-card-description')).toHaveText(RUNNING_DESCRIPTION);
    await expect(card.getByTestId('task-card-trail')).toHaveCount(0);

    await updateConfig(page, { cardPreview: 'agent-latest-message' });
    await expect(card.getByTestId('task-card-trail')).toBeVisible();
    await expect(card.getByTestId('task-card-description')).toHaveCount(0);
  });

  test('compact density shows exactly one line, trail or description, where it showed none before', async () => {
    await updateConfig(page, { cardDensity: 'compact' });

    const runningCard = page.locator(`[data-task-id="${RUNNING_TASK_ID}"]`);
    const trail = runningCard.getByTestId('task-card-trail');
    await expect(trail).toHaveAttribute('data-lines', '1');
    await expect(trailLines(trail)).toHaveText([FIFTH_LINE.text]);
    await expect(trailLines(trail)).toHaveClass(/truncate/);

    const idleCard = page.locator(`[data-task-id="${IDLE_TASK_ID}"]`);
    await expect(idleCard.getByTestId('task-card-description')).toHaveText(IDLE_DESCRIPTION);
    await expect(idleCard.getByTestId('task-card-description')).toHaveClass(/truncate/);

    await updateConfig(page, { cardDensity: 'comfortable' });
    await expect(trail).toHaveAttribute('data-lines', '5');
    await expect(trailLines(trail)).toHaveClass(/line-clamp-5/);

    await updateConfig(page, { cardDensity: 'default' });
    await expect(trail).toHaveAttribute('data-lines', '3');
    await expect(trailLines(trail)).toHaveClass(/line-clamp-3/);
  });

  test('a paused session keeps its trail in the store but the card falls back to its description', async () => {
    // The whole reason the live gate exists. The trail IS there (main retains it
    // past a pause), and the store has it, so this is not a "no trail" case
    // wearing a disguise: assert the store holds it, then assert the card does
    // not print it. Without the gate this card showed PAUSED_TRAIL_LINE with no
    // activity mark and no progress bar to say an agent wrote it.
    const held = await page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { sessionMessageTrails: Record<string, { text: string }[]> } };
        };
      }).__zustandStores;
      return stores?.session.getState().sessionMessageTrails[sessionId]?.map((entry) => entry.text) ?? [];
    }, PAUSED_SESSION_ID);
    expect(held).toContain(PAUSED_TRAIL_LINE);

    const card = page.locator(`[data-task-id="${PAUSED_TASK_ID}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('task-card-trail')).toHaveCount(0);
    await expect(card.getByTestId('task-card-description')).toHaveText(PAUSED_DESCRIPTION);
  });

  test('the compact Done card falls back too, since its session has exited', async () => {
    const doneSwimlane = page.locator('[data-swimlane-name="Done"]');
    await expect(doneSwimlane).toBeVisible({ timeout: 10000 });

    const compactCard = page.locator(`[data-task-id="${COMPACT_TASK_ID}"]`);
    // compact-title is rendered only by the `if (compact)` branch.
    await expect(compactCard.getByTestId('compact-title')).toBeVisible({ timeout: 5000 });
    await expect(compactCard.getByTestId('task-card-trail')).toHaveCount(0);
    await expect(compactCard.getByTestId('task-card-description')).toBeVisible();
    // The trail it would have printed, so this cannot pass by the trail simply
    // being absent from the store.
    await expect(compactCard).not.toContainText(COMPACT_LINE);
  });

  test('a live trail renders in the terminal well, and the description never does', async () => {
    const card = page.locator(`[data-task-id="${RUNNING_TASK_ID}"]`);
    const trail = card.getByTestId('task-card-trail');
    await expect(trail).toBeVisible();

    // The container is what separates the agent's words from the task's, so it
    // is asserted rather than left to a screenshot: the well is
    // `TRAIL_WELL_CLASS`, the same box `OutputPeek` draws on the Agent Monitor.
    await expect(trail).toHaveAttribute('data-terminal', 'true');
    await expect(trail).toHaveClass(/font-mono/);
    await expect(trail).toHaveClass(/bg-surface-hover\/50/);
    await expect(trail).toHaveCSS('font-family', /mono/i);

    const idleCard = page.locator(`[data-task-id="${IDLE_TASK_ID}"]`);
    const description = idleCard.getByTestId('task-card-description');
    await expect(description).not.toHaveClass(/font-mono/);
    await expect(description).not.toHaveClass(/bg-surface-hover/);
  });
});
