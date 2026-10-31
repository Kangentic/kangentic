/**
 * Smoke tier for the static web build of the desktop renderer.
 *
 * `npm run build:demo` writes dist/demo/; demo/boot.js documents the URL contract this spec
 * drives (view, state, theme, embed, still) and the two outcomes it stamps on <html>:
 * `data-demo-ready="1"` plus `data-demo-scene` on success, or a `[data-testid="demo-error"]`
 * card with nothing stamped when the scene cannot boot.
 *
 * The build is served by demo/static-server.mjs on an ephemeral port, started once per worker
 * in beforeAll. It is deliberately NOT a playwright.config.ts `webServer` entry: that block starts
 * for every project filter, and a dist/demo entry there would break the ui tier whenever the demo
 * build is absent. Absent here, startDemoServer throws an error naming `npm run build:demo` and
 * every test in the file fails with that message.
 *
 * Every test owns its own page (the built-in fixture), so nothing leaks between cases.
 */
import { test, expect, chromium, type Browser, type Frame, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { parsePoFile } from '@lingui/format-po';
import { startDemoServer } from '../../demo/static-server.mjs';
import { isBenignRendererError } from '../ui/helpers';
import { PLANNED_BILLING_PAGE, SCENES, playsCycle, type SceneDefinition } from '../captures/scenes';
import INVOICE_PDF_PLAN from '../captures/fixtures/demo/workflow-plans/wf-cw-invoice-pdf.json';
import DEMO_MANIFEST from '../captures/fixtures/demo/manifest.json';
import { NO_GPU_FALLBACKS, waitForSettled } from '../captures/helpers/scene-page';
import {
  DEMO_ARCHIVED_SUMMARIES, DEMO_DICTATION_RECORDING, DEMO_KNOWLEDGE_GRAPH, DEMO_LANES_BY_PROJECT, DEMO_PROJECTS, DEMO_SESSIONS, DEMO_TASKS, PROJECT_CONTOSO,
  SESSION_API_CLIENT, SESSION_CONTOSO_TERMINAL, SESSION_EMPTY_STATES, SESSION_MIDDLEWARE, SESSION_RATE_LIMIT, SESSION_VALIDATE, SESSION_WEBSOCKET,
  DEMO_SCENE_TASKS, TASK_API_ERRORS, TASK_AUTH, TASK_LOGGING, TASK_MIDDLEWARE, TASK_RATE_LIMIT, TASK_SCHEMA, TASK_VALIDATE, TASK_WEBSOCKET,
} from '../captures/helpers/demo-dataset';
import { DEMO_COMPLETED_TASK_REPORT, DEMO_COMPLETED_TASK_SUMMARY } from '../captures/helpers/demo-task-report';
import { formatCost, formatSpan } from '../../src/renderer/utils/format-session';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');

/** demo/boot.js gives itself 10s to reach the reveal; the cold module load rides on top of that. */
const READY_TIMEOUT_MS = 20_000;

/** The opening project's columns, in board order, straight from the sample install. */
const SWIMLANE_NAMES = DEMO_LANES_BY_PROJECT[PROJECT_CONTOSO].map((lane) => lane.name);

/** Every session in the sample install is a Monitor row, whichever project it belongs to. */
const MONITOR_ROW_COUNT = DEMO_SESSIONS.length;

/**
 * The stops a contoso step track draws when its route takes every column: To Do, each of
 * contoso's route columns (neither To Do nor Done, and not archived), and Done. A route read
 * across every project's columns drew about seventeen.
 */
const CONTOSO_FULL_TRACK_STOPS = DEMO_LANES_BY_PROJECT[PROJECT_CONTOSO].filter((lane) => lane.role === null && !lane.is_archived).length + 2;

/**
 * How many stops each Harden the API card's step track draws (the workflows scenes' seed).
 * Refactor API error handling starts at Executing, so its track skips Planning. Extract auth
 * middleware's route ends at Executing, so its track skips Code Review, Testing and Merge.
 */
const WORKFLOW_TRACK_STOPS: Record<string, number> = {
  [TASK_SCHEMA]: CONTOSO_FULL_TRACK_STOPS,
  [TASK_LOGGING]: CONTOSO_FULL_TRACK_STOPS,
  [TASK_MIDDLEWARE]: CONTOSO_FULL_TRACK_STOPS - 3,
  [TASK_RATE_LIMIT]: CONTOSO_FULL_TRACK_STOPS,
  [TASK_AUTH]: CONTOSO_FULL_TRACK_STOPS,
  [TASK_API_ERRORS]: CONTOSO_FULL_TRACK_STOPS - 1,
};

/** The stops each element's step track draws, keyed by the attribute that names its task. */
async function trackStopCounts(elements: Locator, keyAttribute: string): Promise<Record<string, number>> {
  return elements.evaluateAll((nodes, attribute) => Object.fromEntries(nodes.map((node) => [
    node.getAttribute(attribute) ?? '',
    node.querySelectorAll('[data-testid="workflow-step-track"] > [data-step-state]').length,
  ])), keyAttribute);
}

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;

interface DemoBootGlobal {
  __demoBoot?: {
    sceneName: string | null;
    focusRectOf(selector: string): { x: number; y: number; w: number; h: number } | null;
  };
}

let server: DemoServer;

// The site frame's size, which every terminal recording was made for (demo/README.md,
// geometry): the window geometry in the scenes and the state blobs below is fractional, so this
// is what gives a default-rect window its recorded 154 by 37 grid (a fitted floating window takes
// its recording's grid at any display scale), and it is wide enough for the Changes panel's file
// tree and split diff to lay out side by side.
test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

function demoUrl(params: Record<string, string>): string {
  const url = new URL(server.url);
  // Opened directly the page hands over to the stage host (its own case below); this tier drives
  // the frame itself, at the frame size the project's viewport pins.
  url.searchParams.set('stage', '0');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Attach console-error and pageerror collectors that drop the known-benign renderer errors.
 * Returns a getter for what remains. Attach BEFORE navigating so the whole boot is covered.
 */
function collectUnexpectedErrors(page: Page): () => string[] {
  const unexpected: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error' || isBenignRendererError(message.text())) return;
    unexpected.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    if (isBenignRendererError(error)) return;
    unexpected.push(`pageerror: ${error.message}`);
  });
  return () => unexpected.slice();
}

async function waitForDemoReady(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
}

async function gotoScene(page: Page, params: Record<string, string>): Promise<void> {
  await page.goto(demoUrl(params));
  await waitForDemoReady(page);
}

/** Every scene boots by name: a held gesture is its choreography's pose, which boot.js plays in the still. */
const BOOTABLE_SCENES = Object.values(SCENES);

/**
 * What demo/boot.js's extension sweep hid, in every frame of the page (the Browser pane's guest is
 * one). Playwright runs no extension, so anything listed here is the sweep hiding part of the app.
 */
async function sweptNodes(page: Page): Promise<string[]> {
  const swept: string[] = [];
  for (const frame of page.frames()) {
    swept.push(...await frame.evaluate(() => Array.from(document.querySelectorAll('[data-demo-foreign]')).map((element) => {
      const testId = element.getAttribute('data-testid');
      return `${element.localName}${element.id ? `#${element.id}` : ''}${testId ? `[data-testid="${testId}"]` : ''} under ${element.parentElement?.localName ?? 'nothing'}`;
    })));
  }
  return swept;
}

/**
 * Run a script the way an extension's content script runs: in an isolated world of the frame, with
 * its own globals and its own DOM prototypes, so nothing it creates goes through the page's code.
 */
async function runAsExtension(page: Page, frameUrlPart: string | null, expression: string): Promise<void> {
  const client = await page.context().newCDPSession(page);
  type FrameTreeNode = { frame: { id: string; url: string }; childFrames?: FrameTreeNode[] };
  const { frameTree } = await client.send('Page.getFrameTree') as { frameTree: FrameTreeNode };
  const all: FrameTreeNode[] = [];
  const walk = (node: FrameTreeNode): void => { all.push(node); (node.childFrames ?? []).forEach(walk); };
  walk(frameTree);
  const target = frameUrlPart === null ? frameTree : all.find((node) => node.frame.url.includes(frameUrlPart));
  expect(target, `no frame whose URL holds ${frameUrlPart}`).toBeDefined();
  const world = await client.send('Page.createIsolatedWorld', { frameId: target!.frame.id, worldName: 'demo-extension-probe' });
  const result = await client.send('Runtime.evaluate', { expression, contextId: world.executionContextId });
  expect(result.exceptionDetails, 'the content script threw').toBeUndefined();
  await client.detach();
}

/** The opt-outs demo/boot.js stamps on every text field, as attribute and value. */
const FIELD_OPT_OUTS: Array<[string, string]> = [
  ['data-gramm', 'false'],
  ['data-gramm_editor', 'false'],
  ['data-enable-grammarly', 'false'],
  ['data-lt-active', 'false'],
  ['data-1p-ignore', ''],
  ['data-bwignore', 'true'],
  ['data-form-type', 'other'],
];

/**
 * The text of every element matching `selector` that a drawn frame has shown. The Knowledge Graph's
 * labels sit at zero inline opacity until a frame of the WebGL scene places them.
 */
async function shownTexts(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => Number((element as HTMLElement).style.opacity) > 0)
    .map((element) => element.textContent?.trim() ?? ''));
}

/**
 * Deeper assertions for the scenes other tests in this file build on, beyond the `ready` selector
 * every entry carries: the element a visitor would recognize the scene by, with the counts the
 * sample install fixes. Every bootable scene is booted below whether or not it has one of these.
 */
const SCENE_MARKERS: Record<string, (page: Page) => Promise<void>> = {
  board: async (page) => {
    const swimlanes = page.locator('[data-swimlane-name]');
    await expect(swimlanes).toHaveCount(SWIMLANE_NAMES.length);
    const names = await swimlanes.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-swimlane-name')),
    );
    expect(names).toEqual(SWIMLANE_NAMES);
  },
  task: async (page) => {
    await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Extract auth middleware');
  },
  changes: async (page) => {
    const branchScope = page.locator('[data-testid="changes-scope-branch"]');
    await expect(branchScope).toBeVisible();
    await expect(branchScope).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-testid="changes-file-tree"]')).toContainText('routes.ts');
  },
  monitor: async (page) => {
    await expect(page.locator('[data-testid="monitor-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="monitor-card"]')).toHaveCount(MONITOR_ROW_COUNT);
  },
  'column-handoff': async (page) => {
    // The scene's __mockSwimlanePatches seed only takes effect if hydrateSeededSwimlanePatches
    // actually finds and patches the lanes; the `ready` selector alone (the tab having switched)
    // proves nothing about the patch landing. OverviewToggle renders the column page's own
    // read-only ToggleSwitch, so this is the same aria-checked a visitor would read.
    const row = (name: string): Locator => page.locator('[data-testid="board-manager-overview-row"]').filter({ hasText: name });
    const handoff = (name: string): Locator => row(name).getByRole('switch', { name: 'Hand off context when the agent changes' });
    // On exactly where the agent changes, as the alt says. The two off are the sibling negatives
    // that keep the switch from simply always reading on: the dataset leaves every lane off.
    for (const name of ['Code Review', 'Testing', 'Merge']) await expect(handoff(name)).toHaveAttribute('aria-checked', 'true');
    for (const name of ['Planning', 'Executing']) await expect(handoff(name)).toHaveAttribute('aria-checked', 'false');
    await expect(row('Code Review')).toContainText('Codex CLI');
    await expect(row('Merge')).toContainText('GitHub Copilot CLI');
    // A model reads the way its column's form reads it: the name Claude reports, Codex's raw id.
    await expect(row('Planning')).toContainText('Opus 5');
    await expect(row('Code Review')).toContainText('gpt-5.5');
    // Every value reads whole at the site's frame. Before DataTable's colgroup carried the widths,
    // every column was an equal tenth of the table and "Plan (Read-Only)" was cut mid-glyph. The 1px
    // allowance absorbs sub-pixel rounding between font stacks; a real clip loses whole glyphs.
    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll(
      '[data-testid="board-manager-overview-row"] [data-state="changed"] > span, [data-testid="board-manager-overview-row"] [data-state="unchanged"]',
    )).filter((label) => label.scrollWidth - label.clientWidth > 1).map((label) => label.textContent));
    expect(clipped).toEqual([]);
  },
  'edit-columns': async (page) => {
    // The Code Review form on the shared ladder: Codex CLI reviews on the model it was recorded on,
    // and there is no Effort field because Codex takes none from Kangentic. Without the dataset's
    // Codex capabilities the Model field would be missing too.
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog.locator('input[data-testid="column-agent-override"]')).toHaveValue('Codex CLI');
    await expect(dialog.locator('input[data-testid="column-model-override"]')).toHaveValue('gpt-5.5');
    await expect(dialog.locator('[data-testid="column-effort-override"]')).toHaveCount(0);
    // Automation-free on purpose: column-automation is the configured counterpart.
    await expect(dialog.locator('[data-testid="column-automation-row"]')).toHaveCount(0);
    // Codex reports a turn end through its Stop hook (its adapter, carried by
    // DEMO_AGENT_OVERRIDES), so On agent turn end offers Add automation here as on the desktop.
    const group = (trigger: string): Locator => dialog.locator(`[data-testid="column-automation-group"][data-trigger="${trigger}"]`);
    await expect(group('turn_end').locator('[data-testid="column-automation-group-blocked"]')).toHaveCount(0);
    await expect(group('turn_end').locator('[data-testid="column-automation-add"]')).toBeVisible();
    await expect(group('enter').locator('[data-testid="column-automation-add"]')).toBeVisible();
  },
  'column-automation': async (page) => {
    // The same column as edit-columns, plus the one row column-handoff counts in its On enter cell.
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog.locator('input[data-testid="column-agent-override"]')).toHaveValue('Codex CLI');
    await expect(dialog.locator('[data-testid="column-automation-row"]')).toHaveCount(1);
    await expect(dialog.locator('[data-testid="column-automation-row"]')).toContainText('Ask for a review pass');
  },
  'column-automation-turn-end': async (page) => {
    // The review loop on Testing: two Move to column rows at the turn end, in the order the runner
    // reads them, runnable because Claude reports a turn end, each with the marks
    // describeAutomationMarks gives it. One row of each Condition kind: the robot mark for the
    // Agent evaluation, the text search mark for the Text match.
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    const turnEnd = dialog.locator('[data-testid="column-automation-group"][data-trigger="turn_end"]');
    const rows = turnEnd.locator('[data-testid="column-automation-row"]');
    expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-name')))).toEqual(['Send findings back', 'On to Merge']);
    await expect(turnEnd.locator('[data-testid="column-automation-row"][data-can-run="false"]')).toHaveCount(0);
    await expect(turnEnd.locator('[data-testid="column-automation-group-blocked"]')).toHaveCount(0);
    const expected = [
      { marks: ['column-automation-condition-mark', 'column-automation-frequency-mark', 'column-automation-message-mark'], count: '3', sentence: 'Moves the task to Executing' },
      { marks: ['column-automation-text-match-mark', 'column-automation-frequency-mark'], count: '1', sentence: 'Moves the task to Merge' },
    ];
    for (const [index, row] of expected.entries()) {
      const target = rows.nth(index);
      const marks = await target.locator('[data-testid="column-automation-row-title"]').evaluate((line) =>
        Array.from(line.querySelectorAll('[data-testid$="-mark"]')).map((mark) => mark.getAttribute('data-testid')));
      expect(marks).toEqual(row.marks);
      await expect(target.locator('[data-testid="column-automation-frequency-count"]')).toHaveText(row.count);
      await expect(target.locator('[data-testid="column-automation-row-sentence"]')).toHaveText(row.sentence);
    }
    // Sibling negative: the Testing form's enter group holds none of the board's other rows.
    await expect(dialog.locator('[data-testid="column-automation-group"][data-trigger="enter"] [data-testid="column-automation-row"]')).toHaveCount(0);
  },
  'column-automation-edit': async (page) => {
    // Send findings back opened in its editor, every card holding the row's own value. The Condition
    // shows its field, not the setup notice, which is what the scene's Automation agent seed buys:
    // the sample install chooses none.
    const editor = page.locator('[data-testid="edit-automation-dialog"]');
    await expect(editor.locator('[data-testid="edit-automation-name"]')).toHaveValue('Send findings back');
    await expect(editor.locator('[data-testid="edit-automation-trigger-turn_end"]')).toHaveAttribute('aria-checked', 'true');
    await expect(editor.locator('[data-testid="edit-automation-condition-setup"]')).toHaveCount(0);
    await expect(editor.locator('[data-testid="edit-automation-condition-kind-agent"]')).toHaveAttribute('aria-checked', 'true');
    await expect(editor.locator('[data-testid="edit-automation-condition"]')).toHaveValue('The review found work the implementer can do');
    await expect(editor.locator('[data-testid="edit-automation-max-runs-value"]')).toHaveValue('3');
    await expect(editor.locator('[data-testid="automation-config-targetColumn"]')).toHaveAttribute('data-value', 'Executing');
    await expect(editor.locator('[data-testid="automation-config-message"]')).toHaveValue(/\{\{agentReply\}\}/);
    // A dialog, not a menu: no menu or popover is left open over it.
    await expect(page.locator('[aria-expanded="true"]')).toHaveCount(0);
  },
  'task-mcp': async (page) => {
    // The scene-only task's window, maximized, over a board that now carries its card in Code
    // Review. As a still, the terminal paints the session's opening moment: the first three
    // kangentic_* calls with their results, the first naming the card by the number it carries, and
    // not yet the move, which the live frame plays from there.
    const sceneTask = DEMO_SCENE_TASKS.find((task) => task.id === TASK_VALIDATE);
    await expect(page.locator('[data-testid="task-title-text"]')).toHaveText(sceneTask?.title ?? '');
    await expect(page.locator(`[data-task-id="${TASK_VALIDATE}"]`).first()).toBeAttached();
    const painted = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), SESSION_VALIDATE));
    for (const tool of ['kangentic_get_current_task', 'kangentic_list_columns', 'kangentic_list_automations']) {
      expect(painted, `the still shows ${tool}`).toContain(`${tool} (MCP)`);
    }
    expect(painted).toContain(`#${sceneTask?.display_id}`);
    expect(painted, 'the still is the opening moment, before the move').not.toContain('kangentic_move_task (MCP)');
    // The context bar names the Claude Code the recording ran on, which its header prints too.
    expect(painted).toContain('Claude Code v2.1.302');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toContainText('v2.1.302');
  },
  workflows: async (page) => {
    const view = page.locator('[data-testid="workflows-view"]');
    const cards = view.locator('[data-testid="workflow-canvas-card"]');
    await expect(cards).toHaveCount(Object.keys(WORKFLOW_TRACK_STOPS).length);
    // Nothing selected, so every link shows its own state: met where its blocker is done, open
    // where it is not. A selection would restyle the links around it and fade the rest.
    await expect(view.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveCount(0);
    await expect(view.locator('path.react-flow__edge-path[data-link-state="satisfied"]')).toHaveCount(2);
    await expect(view.locator('path.react-flow__edge-path[data-link-state="pending"]')).toHaveCount(3);
    // Each track runs over contoso's own columns: the mock reads a route on the task's own board.
    expect(await trackStopCounts(cards, 'data-workflow-task-key')).toEqual(WORKFLOW_TRACK_STOPS);
    await expect(view.locator('[data-testid="workflow-run-order-row"]')).toHaveCount(Object.keys(WORKFLOW_TRACK_STOPS).length);
    await expect(view.locator('[data-testid="workflow-agent-pane"]')).toHaveAttribute('data-collapsed', 'true');
  },
  'workflow-draft': async (page) => {
    // A plan before Start: the tasks the recorded workflow agent saved (no board task behind any),
    // the billing page selected, and its one link lit as what it waits for.
    const view = page.locator('[data-testid="workflows-view"]');
    const cards = view.locator('[data-testid="workflow-canvas-card"]');
    await expect(cards).toHaveCount(INVOICE_PDF_PLAN.tasks.length);
    await expect(view.locator('[data-testid="workflow-canvas-card"][data-selected="true"]')).toHaveAttribute('data-workflow-task-key', PLANNED_BILLING_PAGE);
    await expect(view.locator('[data-testid="workflow-inspector-title"]')).toContainText('Billing page invoice downloads');
    await expect(view.locator('[data-testid="workflow-start"]')).toBeVisible();
    await expect(view.locator('path.react-flow__edge-path[data-link-relation="blocker"]')).toHaveCount(1);
    // Planned tracks run over contoso's own columns too, every column of it on this plan.
    expect(await trackStopCounts(cards, 'data-workflow-task-key')).toEqual(
      Object.fromEntries(INVOICE_PDF_PLAN.tasks.map((task) => [task.key, CONTOSO_FULL_TRACK_STOPS])),
    );
    // The agent pane is open on the recording's end: the agent idle after the save the canvas
    // draws, which its terminal shows, the first save of one task above it.
    await expect(view.locator('[data-testid="workflow-agent-pane"]')).not.toHaveAttribute('data-collapsed', 'true');
    const agentSessionId = await page.evaluate(async () => {
      const sessions = await (window as unknown as DemoElectronWindow).electronAPI.sessions.list();
      return sessions.find((session) => session.workflowId)?.id ?? null;
    });
    expect(agentSessionId, 'the pane opened the workflow agent').not.toBeNull();
    const painted = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), agentSessionId as string));
    expect(painted).toContain('kangentic_save_workflow (MCP)');
    expect(painted).toContain(`Saved: ${INVOICE_PDF_PLAN.tasks.length} tasks, ${INVOICE_PDF_PLAN.links.length} link`);
  },
  'board-workflow': async (page) => {
    // The four members still on the board carry the strip; the two done ones are archived.
    const live = [TASK_AUTH, TASK_API_ERRORS, TASK_MIDDLEWARE, TASK_RATE_LIMIT];
    const cards = page.locator(live.map((id) => `[data-task-id="${id}"]`).join(', '));
    await expect(page.locator('[data-testid="workflow-card-strip"]')).toHaveCount(live.length);
    expect(await trackStopCounts(cards, 'data-task-id')).toEqual(Object.fromEntries(live.map((id) => [id, WORKFLOW_TRACK_STOPS[id]])));
    // One blocker is named; two are counted (boardWaiting).
    await expect(page.locator(`[data-task-id="${TASK_AUTH}"] [data-testid="workflow-status-bar"]`)).toContainText('Blocked by #4');
    await expect(page.locator(`[data-task-id="${TASK_API_ERRORS}"] [data-testid="workflow-status-bar"]`)).toContainText('Blocked by 2 tasks');
    await expect(page.locator('[data-testid="view-toggle-workflows-running"]')).toBeVisible();
  },
  'session-states': async (page) => {
    // The scene's `ready` selector (the Onboarding empty states card existing at all) resolves
    // whether or not demo/boot.js's new session.status patch actually landed: that card is in the
    // sample install either way. CardStatusBar's own testid is what a visitor reads the state from.
    const pausedCard = page.locator('[data-task-id="task-cw-empty-states"]');
    await expect(pausedCard.locator('[data-testid="status-bar"]')).toContainText('Paused');
    const queuedCard = page.locator('[data-task-id="task-cw-rate-limit"]');
    await expect(queuedCard.locator('[data-testid="status-bar"]')).toContainText('Queued');
    // Sibling negative, in the SAME boot rather than a second one: the scene's own click step
    // targets the middleware session, which the patch does not name and which stays 'running' in
    // the dataset, so its card keeps the running footer instead of picking up Paused or Queued
    // from a patch that landed on the wrong row.
    const middlewareCard = page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`);
    await expect(middlewareCard.locator('[data-testid="usage-bar"]')).toBeVisible();
    await expect(middlewareCard.locator('[data-testid="status-bar"]')).toHaveCount(0);
    // The seed folds the patches in before it builds the Monitor, so the Monitor shows the two
    // stopped as the board does. Applied to the rows afterwards, both rows still read running.
    expect((await monitorFields(page, SESSION_EMPTY_STATES))?.status).toBe('suspended');
    expect((await monitorFields(page, SESSION_RATE_LIMIT))?.status).toBe('queued');
    // A card that is not live shows its task's description (monitorSlotKind), which main's
    // snapshot always carries; without it the paused and queued cards printed agent output.
    const description = (taskId: string) => DEMO_TASKS.find((task) => task.id === taskId)?.description;
    expect((await monitorFields(page, SESSION_EMPTY_STATES))?.description).toBe(description('task-cw-empty-states'));
    expect((await monitorFields(page, SESSION_RATE_LIMIT))?.description).toBe(description('task-cw-rate-limit'));
    // A queued session has never started, so it has no usage: no model and no context.
    expect(await monitorFields(page, SESSION_RATE_LIMIT)).toMatchObject({ modelDisplayName: null, contextPercent: null });
    const queuedUsage = await page.evaluate(async (sessionId) => {
      const usage = await (window as unknown as { electronAPI: { sessions: { getUsage: () => Promise<Record<string, unknown>> } } }).electronAPI.sessions.getUsage();
      return usage[sessionId] ?? null;
    }, SESSION_RATE_LIMIT);
    expect(queuedUsage).toBeNull();
  },
  'session-resume': async (page) => {
    // The resuming card draws the spinner footer rather than a model: main has no usage for a
    // respawned agent until its status line paints, and the seed holds the session's back.
    const resumingCard = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
    await expect(resumingCard.locator('[data-testid="usage-bar"]')).toContainText('Resuming agent...');
    await expect(resumingCard.locator('[data-testid="usage-bar-model"]')).toHaveCount(0);
    // A resumed agent keeps what its previous run said (message-trail-tracker.ts reads it at once).
    await expect(resumingCard.locator('[data-testid="task-card-trail"]')).toBeVisible();
    const pausedCard = page.locator('[data-task-id="task-cw-empty-states"]');
    await expect(pausedCard.locator('[data-testid="status-bar"]')).toContainText('Paused');
    // Sibling negative: a session the scene does not patch keeps its model footer, so the held
    // usage landed on the resuming session alone.
    await expect(page.locator(`[data-task-id="${TASK_MIDDLEWARE}"] [data-testid="usage-bar-model"]`)).toBeVisible();
    // The Monitor row agrees with the card: no model and no context before the usage arrives.
    expect(await monitorFields(page, SESSION_WEBSOCKET)).toMatchObject({ status: 'running', modelDisplayName: null, contextPercent: null });
  },
  'notification-toast': async (page) => {
    // The exit push raised the app's own toast, in its titled shape.
    const toast = page.locator('[data-testid="toast"]');
    await expect(toast.getByTestId('toast-title')).toHaveText('Session ended');
    await expect(toast.getByTestId('toast-body')).toContainText('exited with code 0.');
    // A still holds the countdown line where it starts (boot.js freezes that one Web Animation),
    // so every shot draws it empty. Read twice, apart, so a line that was merely early fails.
    const fillScale = () => toast.getByTestId('toast-countdown').evaluate((line) => {
      const fill = line.firstElementChild;
      return fill ? new DOMMatrixReadOnly(getComputedStyle(fill).transform).a : null;
    });
    expect(await fillScale()).toBe(0);
    await page.waitForTimeout(600);
    expect(await fillScale()).toBe(0);
  },
  'completed-tasks': async (page) => {
    // Only the open project's archive, as the desktop's per-project DB answers, and every row
    // carries the stats its last session left, so the footer is not "$0.00 total cost".
    const contosoArchived = DEMO_TASKS.filter((task) => task.projectId === PROJECT_CONTOSO && task.archivedDaysAgo);
    const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
    await expect(dialog).toContainText(`Completed Tasks (${contosoArchived.length})`);
    await expect(dialog).toContainText(`${contosoArchived.length} tasks`);
    await expect(dialog).not.toContainText('$0.00 total cost');
    const summarized = new Set(DEMO_ARCHIVED_SUMMARIES.map((summary) => summary.taskId));
    for (const task of contosoArchived) expect(summarized.has(task.id), `${task.id} has no summary`).toBe(true);
  },
  'completed-task': async (page) => {
    // The header strip reads the Completed Tasks row's own summary, so it shows the cost and agent
    // runtime the completed-tasks scene's row shows for this task.
    const rowSummary = DEMO_COMPLETED_TASK_SUMMARY;
    const strip = page.locator('[data-testid="completed-header-strip"]');
    await expect(strip.locator('[data-testid="completed-metric-cost"]')).toContainText(formatCost(rowSummary.costUsd));
    await expect(strip.locator('[data-testid="completed-metric-agent-runtime"]')).toContainText(formatSpan(rowSummary.durationMs));
    await expect(page.locator('[data-testid="completed-panel-summary"]')).toBeVisible();
    // The seeded report, not the one the mock derives: a written summary, a route whose repeated
    // columns draw a card per visit, the commits, and the run's own changed files.
    await expect(page.locator('[data-testid="completed-task-summary-text"]')).toBeVisible();
    await expect(page.locator('[data-testid="completed-summary-state-pending"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="route-column-pill"]')).toHaveCount(DEMO_COMPLETED_TASK_REPORT.route.length);
    await expect(page.locator('[data-testid="route-visit"]')).toHaveCount(DEMO_COMPLETED_TASK_REPORT.route.reduce((sum, column) => sum + column.visits.length, 0));
    await expect(page.locator('[data-testid="completed-commits"]')).toBeVisible();
    await expect(page.locator('[data-testid="completed-changed-file"]')).toHaveCount(rowSummary.filesChanged);
  },
  'completed-task-usage': async (page) => {
    const rowSummary = DEMO_COMPLETED_TASK_SUMMARY;
    await expect(page.locator('[data-testid="completed-panel-usage"]')).toBeVisible();
    // Every run, each naming its conversation in a Session pill: two distinct pills, the main
    // conversation and Code Review's isolated one.
    await expect(page.locator('[data-testid="completed-run-row"]')).toHaveCount(DEMO_COMPLETED_TASK_REPORT.conversations.reduce((sum, conversation) => sum + conversation.runs.length, 0));
    const sessionPills = await page.locator('[data-testid="completed-copy-conversation-id"]').allTextContents();
    expect(new Set(sessionPills).size).toBe(DEMO_COMPLETED_TASK_REPORT.conversations.length);
    // The Runs Total adds back to the row's cost.
    await expect(page.locator('[data-testid="completed-runs-total"]')).toContainText(formatCost(rowSummary.costUsd));
    // The ledger card, never the derived report's fallback card.
    await expect(page.locator('[data-testid="completed-model-row"]')).toHaveCount(DEMO_COMPLETED_TASK_REPORT.models?.length ?? 0);
    await expect(page.locator('[data-testid="completed-models-fallback"]')).toHaveCount(0);
    // A condition met and a condition not met, in the order they were asked.
    const outcomes = await page.locator('[data-testid="completed-call-outcome"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-outcome')));
    expect(outcomes).toEqual(['ran', 'skipped']);
  },
  'knowledge-graph': async (page) => {
    // The map drew in a real 3D context. This tier runs on the headless shell the release's
    // poster job shoots with, so this is the proof the poster gets one, not the no-map card.
    for (const fallback of NO_GPU_FALLBACKS) await expect(page.locator(fallback)).toHaveCount(0);
    // One island per project, each labelled. An island label's inline opacity is written only by
    // a frame the WebGL scene drew (positionLabels), so `1` is a frame landing, not a mount.
    const projectIds = Object.keys(DEMO_KNOWLEDGE_GRAPH.projects);
    const islandLabels = page.locator('[data-testid="knowledge-graph-island-label"]');
    await expect(islandLabels).toHaveCount(projectIds.length);
    const islandOpacities = await islandLabels.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).style.opacity));
    expect(islandOpacities).toEqual(projectIds.map(() => '1'));
    // Named regions showing: at least one pill drawn, and every drawn pill carries a region name
    // the fixture holds, never a placeholder.
    const regionNames = new Set(Object.values(DEMO_KNOWLEDGE_GRAPH.projects).flatMap((project) => project.projection.clusterings.flatMap((clustering) => clustering.regions.map((region) => region.label))));
    const shownPills = await shownTexts(page, '[data-testid="knowledge-graph-cluster-label"]');
    expect(shownPills.length).toBeGreaterThan(0);
    for (const pill of shownPills) expect(regionNames.has(pill), `region pill "${pill}"`).toBe(true);
  },
  // One project's map alone: framed close enough that conversation titles show, each one of that
  // project's own task titles, and no island labels (a single map is not an island).
  ...Object.fromEntries(DEMO_PROJECTS.map((project) => [`knowledge-graph-${project.name}`, async (page: Page) => {
    for (const fallback of NO_GPU_FALLBACKS) await expect(page.locator(fallback)).toHaveCount(0);
    await expect(page.locator('[data-testid="knowledge-graph-island-label"]')).toHaveCount(0);
    const ownTitles = new Set(DEMO_TASKS.filter((task) => task.projectId === project.id).map((task) => task.title));
    const shownTitles = await shownTexts(page, '[data-testid="knowledge-graph-node-title"]');
    expect(shownTitles.length, `${project.name} shows no conversation title`).toBeGreaterThan(0);
    // A chip may truncate a long title with an ellipsis, so it is matched as a prefix.
    for (const shown of shownTitles) {
      const prefix = shown.replace(/…$|\.\.\.$/, '').trim();
      expect([...ownTitles].some((title) => title.startsWith(prefix)), `${project.name} shows "${shown}", not one of its own tasks`).toBe(true);
    }
  }])),
  'activity-overlay': async (page) => {
    const overlay = page.locator('[data-testid="activity-debug-overlay"]');
    // `ready` only waits for this element to mount, which happens as soon as ANY session in the
    // project is 'running' - with or without real snapshot data (ActivityDebugOverlayContent
    // renders on `projectSessionIds.length > 0` alone). If activityStatsCache never populated, or
    // activityStatsFor threw while the seed built it, the panel falls back to its own "no state"
    // diagnostic instead of failing the boot, which the ready gate would not catch.
    await expect(overlay).not.toContainText('Activity engine has no state');
    // One row per running contoso-web session, proving activityStatsCache was populated for
    // every one of them and not just enough to dodge the diagnostic above.
    const runningContosoSessionIds = DEMO_SESSIONS
      .filter((session) => session.projectId === PROJECT_CONTOSO && session.status === 'running')
      .map((session) => session.id);
    for (const sessionId of runningContosoSessionIds) {
      await expect(overlay.locator(`[data-session-id="${sessionId}"]`)).toBeVisible();
    }
    // The derived reason branches, read off one session of each activity kind: activityStatsFor's
    // three-way switch (permission / thinking-with-tool / idle) drives the pill label straight
    // from the seeded session, so a wrong branch here means the derivation broke, not the wiring
    // checked above. currentTool is the seeded session's own last event, not an invented value.
    const middlewareRow = overlay.locator(`[data-session-id="${SESSION_MIDDLEWARE}"]`);
    await expect(middlewareRow).toContainText('Thinking');
    await expect(middlewareRow).toContainText('running Bash');
    await expect(overlay.locator(`[data-session-id="${SESSION_WEBSOCKET}"]`)).toContainText('Awaiting permission');
    await expect(overlay.locator(`[data-session-id="${SESSION_RATE_LIMIT}"]`)).toContainText('Idle');
  },
};

test('every deep marker names a scene the build can boot', () => {
  // A marker for a renamed or retired scene would otherwise sit here asserting nothing.
  const bootableNames = new Set(BOOTABLE_SCENES.map((scene) => scene.name));
  for (const name of Object.keys(SCENE_MARKERS)) expect(bootableNames.has(name), `SCENE_MARKERS.${name}`).toBe(true);
});

for (const scene of BOOTABLE_SCENES) {
  test(`view=${scene.name} boots to its ready element with a clean console`, async ({ page }) => {
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await gotoScene(page, { view: scene.name, embed: '1', still: '1' });
    await expect(page.locator('html')).toHaveAttribute('data-demo-scene', scene.name);
    // boot.js waited for this before it revealed; asserting it VISIBLE is the half boot.js cannot
    // see, since it polls for existence and a mounted-but-hidden element would pass it.
    await expect(page.locator(scene.ready).first()).toBeVisible();
    // A field-focusing step swaps the boot veil from `visibility: hidden` to `opacity: 0` plus
    // `pointer-events: none` on #root (clickTarget), and unveil() then clears all three inline
    // styles on both its success and error paths. toBeVisible() above ignores opacity and
    // pointer-events entirely, so a regression that left #root at opacity: 0 (the veil never
    // lifted) would still pass it; this reads the inline styles boot.js itself sets and clears.
    const rootVeilStyles = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root ? { visibility: root.style.visibility, opacity: root.style.opacity, pointerEvents: root.style.pointerEvents } : null;
    });
    expect(rootVeilStyles, `${scene.name} has no #root`).not.toBeNull();
    expect(rootVeilStyles, `${scene.name} left the boot veil applied to #root`).toEqual({ visibility: '', opacity: '', pointerEvents: '' });
    // The rig's own wait (helpers/scene-page.ts), so a scene the posters shoot after its motion
    // settles boots to that settled frame here first, on the same headless shell CI runs.
    if (scene.settle) await waitForSettled(page, scene.settle);
    const deepMarker = SCENE_MARKERS[scene.name];
    if (deepMarker) await deepMarker(page);
    if (scene.focus) {
      // A focus the site crops to must be a real region: not a missing element (the ready
      // message would carry null), not a zero box, and not the whole frame (the Quick Find
      // scenes once named the palette's full-frame backdrop, which crops to nothing). The rect is
      // the box around every element the selector names, which is how boot.js measures it.
      const focusRect = await page.evaluate((selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) return null;
        const boxes = elements.map((element) => element.getBoundingClientRect());
        const left = Math.min(...boxes.map((box) => box.left));
        const top = Math.min(...boxes.map((box) => box.top));
        const right = Math.max(...boxes.map((box) => box.right));
        const bottom = Math.max(...boxes.map((box) => box.bottom));
        return { w: (right - left) / window.innerWidth, h: (bottom - top) / window.innerHeight, count: elements.length };
      }, scene.focus);
      expect(focusRect, `${scene.name}.focus (${scene.focus}) matches no element`).not.toBeNull();
      // Each selector in the list names exactly one element. A single selector that began matching
      // a second element would widen that figure's crop to take both in without failing anything.
      const selectorCount = scene.focus.split(',').length;
      expect(focusRect?.count, `${scene.name}.focus should name ${selectorCount} element(s)`).toBe(selectorCount);
      const focusArea = (focusRect?.w ?? 0) * (focusRect?.h ?? 0);
      expect(focusArea, `${scene.name}.focus is an empty box`).toBeGreaterThan(0);
      expect(focusArea, `${scene.name}.focus is the whole frame`).toBeLessThan(0.95);
    }
    expect(await sweptNodes(page), `${scene.name}: the extension sweep hid part of the app`).toEqual([]);
    expect(getUnexpectedErrors()).toEqual([]);
  });
}

test('an extension\'s nodes are hidden and every text field carries the opt-outs', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'new-task', embed: '1', still: '1' });
  await expect(page.locator('html')).toHaveAttribute('translate', 'no');
  const fields = await page.evaluate((optOuts) => Array.from(document.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"])'))
    .map((field) => ({
      field: field.getAttribute('data-testid') ?? field.getAttribute('placeholder') ?? field.localName,
      missing: optOuts.filter(([name, value]) => field.getAttribute(name) !== value).map(([name]) => name),
    })), FIELD_OPT_OUTS);
  // The dialog's title, description and labels fields at least, so the check cannot pass on none.
  expect(fields.length).toBeGreaterThanOrEqual(3);
  expect(fields.filter((entry) => entry.missing.length > 0), 'a text field without every opt-out').toEqual([]);

  // What Grammarly does: a hyphenated host element beside the field. What a floating widget does:
  // a plain element under body. Neither is the page's, and both must be hidden.
  await runAsExtension(page, null, `(() => {
    const description = document.querySelector('[data-testid="task-description"]');
    const host = document.createElement('grammarly-extension');
    host.id = 'probe-extension-host';
    host.textContent = 'G';
    description.insertAdjacentElement('afterend', host);
    const widget = document.createElement('div');
    widget.id = 'probe-extension-widget';
    widget.textContent = 'widget';
    document.body.appendChild(widget);
  })()`);
  for (const id of ['probe-extension-host', 'probe-extension-widget']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-demo-foreign', '');
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  // The page's own nodes in the same two places stay, including a hyphenated tag it never defined.
  await page.evaluate(() => {
    const own = document.createElement('x-page-own');
    own.id = 'probe-page-host';
    own.textContent = 'own';
    document.querySelector('[data-testid="task-description"]')?.insertAdjacentElement('afterend', own);
    const ownWidget = document.createElement('div');
    ownWidget.id = 'probe-page-widget';
    ownWidget.textContent = 'own';
    document.body.appendChild(ownWidget);
  });
  for (const id of ['probe-page-host', 'probe-page-widget']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator(`#${id}`)).not.toHaveAttribute('data-demo-foreign', '');
  }
  expect(getUnexpectedErrors()).toEqual([]);
});

test('an extension\'s node in the Browser pane\'s guest page is hidden', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'browser', embed: '1', still: '1' });
  const guest = page.frameLocator('[data-testid="browser-webview"] iframe');
  // The shim shields the guest when it loads, which stamps its root.
  await expect(guest.locator('html')).toHaveAttribute('translate', 'no');
  await runAsExtension(page, '/guest/', `(() => {
    const widget = document.createElement('div');
    widget.id = 'probe-guest-widget';
    widget.textContent = 'widget';
    document.body.appendChild(widget);
  })()`);
  await expect(guest.locator('#probe-guest-widget')).toHaveAttribute('data-demo-foreign', '');
  await expect(guest.locator('#probe-guest-widget')).toBeHidden();
  expect(getUnexpectedErrors()).toEqual([]);
});

test('scenes.json is served unhashed, matches the registry, and names the build version', async ({ page, request }) => {
  const response = await request.get(`${server.url}scenes.json`);
  expect(response.ok(), 'scenes.json is not served beside index.html').toBe(true);
  const manifest = await response.json() as { version: string; frame: { width: number; height: number }; scenes: Array<{ name: string; reach: string; alt: string; description: string }> };
  expect(manifest.frame).toEqual({ width: 1600, height: 1000 });
  expect(manifest.scenes.map((scene) => scene.name)).toEqual(Object.keys(SCENES));
  for (const scene of manifest.scenes) {
    expect(scene.reach, scene.name).toBe(SCENES[scene.name].reach);
    expect(scene.alt.trim(), `${scene.name}.alt`).not.toBe('');
  }
  // The version a docs page stamps on its figure is the one the frame itself reports.
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  const frameVersion = await page.evaluate(() => (window as { __demoVersion?: string }).__demoVersion);
  expect(manifest.version).toBe(frameVersion);
});

interface DemoReadyMessage { type: string; scene: string | null; version: string; focus: { x: number; y: number; w: number; h: number } | null }

/**
 * Host the frame in an iframe the way the site does and return the ready message it posts.
 * boot.js posts to its parent only when it has one, so a top-level visit observes nothing.
 */
async function readyMessageFor(page: Page, sceneName: string): Promise<DemoReadyMessage> {
  const src = demoUrl({ view: sceneName, embed: '1', still: '1' });
  await page.setContent(
    '<script>window.__demoMessages = []; window.addEventListener("message", (event) => { window.__demoMessages.push(event.data); });</script>'
    + `<iframe id="demo" width="1600" height="1000" style="border:0" src="${src}"></iframe>`,
  );
  await expect(page.frameLocator('#demo').locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
  const readMessages = () => page.evaluate(() => (window as { __demoMessages?: DemoReadyMessage[] }).__demoMessages ?? []);
  await expect.poll(async () => (await readMessages()).some((message) => message.type === 'kangentic-demo-ready')).toBe(true);
  const message = (await readMessages()).find((candidate) => candidate.type === 'kangentic-demo-ready');
  if (!message) throw new Error('no ready message');
  return message;
}

test('the ready message carries the focus rect of a dialog scene, and null for a scene without one', async ({ page }) => {
  // A dialog, not a popover: the New Task dialog is a large centred box, so a rect that is not
  // its box (a null, a zero, the whole frame) is unmistakable.
  const focusScene = SCENES['new-task'];
  expect(focusScene.focus, 'the new-task scene stopped naming a focus element').toBeDefined();

  const focused = await readyMessageFor(page, focusScene.name);
  expect(focused.scene).toBe(focusScene.name);
  expect(focused.focus).not.toBeNull();
  for (const value of Object.values(focused.focus ?? {})) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }
  const area = (focused.focus?.w ?? 0) * (focused.focus?.h ?? 0);
  expect(area, 'the dialog covers a real region of the frame').toBeGreaterThan(0.1);
  expect(area, 'the dialog is not the whole frame').toBeLessThan(0.9);

  // The capture rig measures each poster's focus through this same function, so the rect in the
  // poster manifest and the rect a live frame posts are one measure (demo/posters.mjs).
  const frame = await demoContentFrame(page);
  const rigRect = await frame.evaluate((selector) => (window as DemoBootGlobal).__demoBoot?.focusRectOf(selector) ?? null, focusScene.focus ?? '');
  expect(rigRect).toEqual(focused.focus);

  const plain = await readyMessageFor(page, 'board');
  expect(plain.scene).toBe('board');
  expect(plain.focus).toBeNull();
});

interface HostFrameOptions {
  /** The frame's parameters beside `view` and `embed`. Given, they replace the default `still=1`. */
  params?: Record<string, string>;
  /**
   * Put the frame in a page taller than the viewport, scrolled so half the frame is on screen
   * before it loads (its top half, or its bottom half), and record in `window.__hostMoves` every
   * position the page takes after that.
   */
  halfOnScreen?: HostHalf;
}

/** Which half of a frame hosted half on screen the viewport shows. */
type HostHalf = 'top' | 'bottom';

/** Page above and below a frame hosted half on screen. */
const HOST_MARGIN_PX = 1500;

/** How much of the 1000 px frame sits on the other side of the viewport's edge, in the host. */
const HOST_OFFSCREEN_PX = 500;

/** Where the host page is scrolled before the frame loads: the frame's top half or bottom half in view. */
function hostStartY(half: HostHalf): number {
  return half === 'top' ? HOST_MARGIN_PX - HOST_OFFSCREEN_PX : HOST_MARGIN_PX + HOST_OFFSCREEN_PX;
}

/** Where the demo server serves the page that hosts a frame half on screen. */
const HALF_ON_SCREEN_HOST_PATH = '/host-half-on-screen.html';

/**
 * Scrolls the host before the frame loads: Chromium paints no frames for a cross-origin frame
 * that is off screen, so one hosted below the fold never boots. The recorder samples every
 * animation frame as well as each scroll event, so a scroll that a later one puts back still shows.
 */
function hostScrollRecorder(half: HostHalf): string {
  return `<script>
  window.scrollTo(0, ${hostStartY(half)});
  var start = { x: window.scrollX, y: window.scrollY };
  window.__hostStart = start;
  window.__hostMoves = [];
  function recordHostMove() {
    if (window.scrollX !== start.x || window.scrollY !== start.y) window.__hostMoves.push(window.scrollX + ',' + window.scrollY);
  }
  window.addEventListener('scroll', recordHostMove);
  (function sample() { recordHostMove(); window.requestAnimationFrame(sample); })();
</script>`;
}

/** Host the frame in an iframe the site's way and hand back the frame plus a message reader. */
async function hostFrame(page: Page, sceneName: string, options: HostFrameOptions = {}): Promise<() => Promise<DemoReadyMessage[]>> {
  const src = demoUrl({ view: sceneName, embed: '1', ...(options.params ?? { still: '1' }) });
  const messageRecorder = '<script>window.__demoMessages = []; window.addEventListener("message", (event) => { window.__demoMessages.push(event.data); });</script>';
  const iframe = `<iframe id="demo" width="1600" height="1000" style="border:0" src="${src}"></iframe>`;
  if (options.halfOnScreen) {
    const spacer = `<div style="height:${HOST_MARGIN_PX}px"></div>`;
    const body = `${messageRecorder}<style>body { margin: 0 } iframe { display: block }</style>${spacer}${iframe}${spacer}${hostScrollRecorder(options.halfOnScreen)}`;
    // Served, not set as content: an about:blank host is not a secure context, so neither is the
    // frame, and crypto.randomUUID and the microphone are missing. kangentic.com is https; localhost
    // is a secure context too, and a different site from the server's 127.0.0.1.
    // The icon link keeps a full browser from asking the server for a favicon it 404s.
    server.routes[HALF_ON_SCREEN_HOST_PATH] = { body: `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${body}</body></html>` };
    await page.goto(`http://localhost:${server.port}${HALF_ON_SCREEN_HOST_PATH}`);
  } else {
    await page.setContent(messageRecorder + iframe);
  }
  await expect(page.frameLocator('#demo').locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
  return () => page.evaluate(() => (window as { __demoMessages?: DemoReadyMessage[] }).__demoMessages ?? []);
}

/** The frame inside the page's `#demo` iframe, to evaluate in. */
async function demoContentFrame(page: Page): Promise<Frame> {
  const frame = await (await page.locator('#demo').elementHandle())?.contentFrame();
  if (!frame) throw new Error('the demo iframe has no content frame');
  return frame;
}

const hasEscape = (messages: DemoReadyMessage[]) => messages.some((message) => message.type === 'kangentic-demo-escape');

/**
 * Focus an element inside the cross-origin `#demo` iframe and wait for the TOP-LEVEL browsing
 * context's focus to actually land there before returning.
 *
 * `Locator.focus()` calls the element's `focus()` inside the iframe's own renderer, which
 * updates that document's `activeElement` immediately. But `page.keyboard.press()` at the top
 * level dispatches through whichever frame the BROWSER PROCESS currently believes is focused,
 * and for a cross-origin iframe that hand-off is a separate, asynchronous step (an IPC round
 * trip between renderer processes on Chromium). Pressing Escape right after `.focus()` can race
 * that hand-off: the key lands on the top-level document (which has no listener) instead of the
 * iframe, so the dialog never sees it and stays open until Playwright's retry. `document.hasFocus()`,
 * read from INSIDE the iframe, reflects the browser process's actual routing rather than just the
 * iframe's local `activeElement`, so polling it (instead of a fixed pad) makes the wait real.
 */
async function focusAcrossFrame(locator: Locator): Promise<void> {
  await locator.focus();
  await expect
    .poll(() => locator.evaluate((element) => document.hasFocus() && document.activeElement === element))
    .toBe(true);
}

test('Escape posts an escape message when the app has nothing of its own to close', async ({ page }) => {
  // The case a host cannot handle itself: keyboard focus is inside the cross-origin frame, on the
  // terminal's textarea, where the renderer's arrival-focus arbiter puts it, so every key goes
  // there and no listener on the parent page ever sees one.
  const readMessages = await hostFrame(page, 'board');
  const textarea = page.frameLocator('#demo').locator('.xterm-helper-textarea').first();
  await textarea.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
  await textarea.focus();
  // The keyboard, not `locator('#demo').press()`: that form focuses the iframe ELEMENT first, so
  // the keystroke reaches the textarea only by Chromium restoring the frame's previously focused
  // descendant. That is the one thing this test is proving, so it must not also be the mechanism.
  await page.keyboard.press('Escape');

  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
  const escape = (await readMessages()).find((message) => message.type === 'kangentic-demo-escape');
  expect(escape?.scene).toBe('board');
});

test('Escape posts nothing while a plain text field is focused, with no dialog or window involved', async ({ page }) => {
  // The BASE rule the xterm-helper-textarea case above carves its one exemption out of: a focused
  // INPUT/TEXTAREA/contenteditable blocks the post on its own, with no dialog and no restored
  // window anywhere in the DOM. The board scene's search field is always mounted (no click needed
  // to reveal it), which is what keeps this rung 1 rather than accidentally exercising rung 2
  // ([data-dismissable-layer]) or rung 3 ([data-testid^="window-frame-"]).
  const readMessages = await hostFrame(page, 'board');
  const frame = page.frameLocator('#demo');
  // Pin the isolation: nothing in the DOM could make this pass on rung 2 or 3 instead of rung 1.
  await expect(frame.locator('[data-dismissable-layer]')).toHaveCount(0);
  await expect(frame.locator('[data-testid^="window-frame-"]')).toHaveCount(0);

  const searchInput = frame.locator('[data-testid="board-search"]');
  await searchInput.focus();
  await page.keyboard.press('Escape');
  // Fixed wait, not a poll: this is a negative assertion (nothing posted). Polling "is it still
  // false" would pass the instant it is called, whether or not the guard is even wired up.
  await page.waitForTimeout(500);
  expect(hasEscape(await readMessages()), 'a focused text field owns Escape before xterm is ever asked').toBe(false);

  // Positive control, same frame: focusing the terminal's helper textarea (the one exemption)
  // does post, so the absence above is the base rule firing rather than dead plumbing.
  const textarea = frame.locator('.xterm-helper-textarea').first();
  await textarea.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
  await textarea.focus();
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
});

test('Escape posts nothing while the app owns it, and the app closes its own surface', async ({ page }) => {
  // Each case settles on the app's OWN visible answer (the surface closing), never on a timer:
  // that is both the proof the keystroke was processed and the behaviour being asserted. A
  // second Escape, which this does not press, is what would then reach the host.
  //
  // Both cases focus a BUTTON inside the frame and press through the frame's own keyboard, for two
  // separate reasons. `page.locator('#demo').press()` focuses the iframe ELEMENT, so the key
  // reaches the frame's content only if Chromium restores the frame's previously focused
  // descendant: it does on Windows and does NOT on the headless Linux runner, where this read
  // green locally and red on every CI push. And a button rather than a text field keeps each case
  // on the rung it is named for, since a focused input would satisfy rung 1 first and the assertion
  // would hold for the wrong reason (rung 1 has its own test above).
  const readDialogMessages = await hostFrame(page, 'new-task');
  const dialog = page.frameLocator('#demo').locator('[data-testid="new-task-dialog"]');
  await expect(dialog).toBeVisible();
  await focusAcrossFrame(dialog.getByRole('button', { name: 'Cancel' }));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(hasEscape(await readDialogMessages()), 'a dialog owns the first Escape').toBe(false);

  // A restored task window owns it the same way, through the [data-testid^="window-frame-"] rung.
  const readWindowMessages = await hostFrame(page, 'task');
  const frame = page.frameLocator('#demo');
  const detail = frame.locator('[data-testid="task-detail-titlebar"]');
  await expect(detail).toBeVisible();
  // Pin the isolation the way the rung-1 test does: no dialog is open, so this can only be rung 3.
  await expect(frame.locator('[data-dismissable-layer]')).toHaveCount(0);
  // A script's focus opens no tip (only Tab does), so the first Escape is the window's.
  await focusAcrossFrame(frame.locator('[data-testid="task-detail-close"]'));
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  expect(hasEscape(await readWindowMessages()), 'a task window owns the first Escape').toBe(false);
});

test('Escape in a task window terminal under the pointer closes the window, then the next one posts', async ({ page }) => {
  // The reported case. A task window's terminal keeps Escape for the agent while the pointer is
  // over it (terminal-clipboard.ts, `releaseEscapeWhenPointerOutside`), and a card click leaves
  // the pointer exactly there once the window opens. The web build's terminals replay a recording
  // with no agent to interrupt, so the key did nothing: the window stayed open and nothing posted.
  const readMessages = await hostFrame(page, 'task');
  const frame = page.frameLocator('#demo');
  const detail = frame.locator('[data-testid="task-detail-titlebar"]');
  await expect(detail).toBeVisible();
  const terminal = frame.locator('[data-testid^="window-frame-"] .xterm').first();
  // Page coordinates: `setContent` gives body a margin, so the iframe is not at 0,0.
  const box = await terminal.boundingBox();
  expect(box, 'the task window terminal has a box to hover').not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The predicate the terminal itself reads, so a pointer that missed cannot pass this vacuously.
  await expect.poll(() => terminal.evaluate((element) => element.parentElement?.matches(':hover') ?? false)).toBe(true);
  await focusAcrossFrame(frame.locator('[data-testid^="window-frame-"] .xterm-helper-textarea').first());

  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  expect(hasEscape(await readMessages()), 'the window takes the first Escape').toBe(false);

  // The focused textarea left with its window. A visitor presses again without clicking, so the
  // second key must still route into the frame. Read that from inside it rather than assume it.
  await expect.poll(() => frame.locator('html').evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
});

test('Escape in a Command Terminal posts, since the desktop never closes that window on Escape', async ({ page }) => {
  // A Command Terminal renders through WindowFrame like a task window, but its layer hides on the
  // panel-close combo, the toggle, or a backdrop click, never on Escape. An open frame alone is
  // therefore no sign the app will use the key, and without this the frame never posted at all.
  const readMessages = await hostFrame(page, 'command-terminal');
  const frame = page.frameLocator('#demo');
  const commandWindow = frame.locator('[data-testid="command-terminal-window"]');
  await expect(commandWindow).toBeVisible();
  await focusAcrossFrame(commandWindow.locator('.xterm-helper-textarea').first());
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
  await expect(commandWindow, 'the app keeps the window open, as the desktop does').toBeVisible();
});

test('Escape in a Command Terminal still posts when a header control holds focus, not the terminal', async ({ page }) => {
  // The test above focuses the terminal's own textarea. For that focus, `terminalKeepsKey` in
  // isEscapeTheAppOwns skips the frame loop, so the Command Terminal frame skip never runs there.
  // A control in the window's chrome sends the key through the frame loop, which must pass over
  // this frame as it does an inert one. The kebab button opens nothing until it is pressed, and it
  // is a protected header control, so it renders at every window width.
  const readMessages = await hostFrame(page, 'command-terminal');
  const frame = page.frameLocator('#demo');
  const commandWindow = frame.locator('[data-testid="command-terminal-window"]');
  await expect(commandWindow).toBeVisible();
  // Pin the isolation the way the rung-1 and rung-3 tests do, so this can only be decided by the
  // frame loop.
  await expect(frame.locator('[data-dismissable-layer]')).toHaveCount(0);
  // The window's terminal takes keyboard focus once, when its replay arrives (the arrival-focus
  // arbiter). Focusing the header control before that let the arrival take focus back, so the
  // wait below timed out on CI and passed only on retry. Wait for the arrival first; it is
  // discharged once, so nothing moves focus after it and the key reaches the frame loop.
  const textarea = commandWindow.locator('.xterm-helper-textarea').first();
  await expect
    .poll(() => textarea.evaluate((element) => document.activeElement === element), { timeout: READY_TIMEOUT_MS })
    .toBe(true);
  await focusAcrossFrame(commandWindow.locator('button[aria-label="Actions"]'));
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
  await expect(commandWindow, 'the app keeps the window open, as the desktop does').toBeVisible();
});

test('Escape in a Command Terminal under the pointer still posts and leaves the window open', async ({ page }) => {
  // The other hovered case is a task window's terminal. A Command Terminal frame has no
  // `task-detail-close`, so `taskWindowOf` returns null and closeHoveredTerminalWindow must decline
  // rather than call `.querySelector` on it. Neither Command Terminal test above moves the pointer,
  // so both stop at the hover check and a missing guard would still read as covered.
  const readMessages = await hostFrame(page, 'command-terminal');
  const frame = page.frameLocator('#demo');
  const commandWindow = frame.locator('[data-testid="command-terminal-window"]');
  await expect(commandWindow).toBeVisible();
  const terminal = commandWindow.locator('.xterm').first();
  const box = await terminal.boundingBox();
  expect(box, 'the Command Terminal terminal has a box to hover').not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The predicate the terminal itself reads, so a pointer that missed cannot pass this vacuously.
  await expect.poll(() => terminal.evaluate((element) => element.parentElement?.matches(':hover') ?? false)).toBe(true);
  await focusAcrossFrame(commandWindow.locator('.xterm-helper-textarea').first());
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
  await expect(commandWindow, 'the app keeps the window open, as the desktop does').toBeVisible();
});

test('Escape in the bottom panel terminal posts even with a task window open', async ({ page }) => {
  // xterm stops propagation of every key it handles, so an Escape in a terminal outside the task
  // window never reaches the document listener the window closes on. A visitor gets here by
  // clicking into the panel's terminal, which light dismiss deliberately leaves the window open
  // for. The open window alone used to read as "the app owns this", so nothing ever posted.
  const readMessages = await hostFrame(page, 'task');
  const frame = page.frameLocator('#demo');
  const detail = frame.locator('[data-testid="task-detail-titlebar"]');
  await expect(detail).toBeVisible();
  await focusAcrossFrame(frame.locator('[data-testid="terminal-session-pane"] .xterm-helper-textarea').first());
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
  await expect(detail, 'the app keeps the window open, as the desktop does').toBeVisible();
});

test('an open tip takes the first Escape, in a task window and in the bare app, and the next one goes on', async ({ page }) => {
  // A Tooltip closes on the first Escape through a window capture listener it adds when it opens,
  // which is AFTER boot.js added its own. boot.js therefore reads the key first, with the tip
  // still in the DOM, and has to treat it as the app's (isOverlayOpen counts `[data-tooltip]`).
  const readMessages = await hostFrame(page, 'task');
  const frame = page.frameLocator('#demo');
  const detail = frame.locator('[data-testid="task-detail-titlebar"]');
  const tip = frame.locator('[data-tooltip]');
  await expect(detail).toBeVisible();
  // The window's terminal takes keyboard focus once, when its replay arrives (the arrival-focus
  // arbiter). Wait for that first, so nothing moves focus back after the focus change below.
  const windowTextarea = frame.locator('[data-testid^="window-frame-"] .xterm-helper-textarea').first();
  await expect
    .poll(() => windowTextarea.evaluate((element) => document.activeElement === element), { timeout: READY_TIMEOUT_MS })
    .toBe(true);

  // In the task window. Focus sits on a control with no tip of its own, not in the terminal: a
  // focused terminal keeps Escape for the agent, so the tip would close and the window would too.
  const maximize = frame.locator('[data-testid="task-detail-maximize"]');
  await focusAcrossFrame(maximize);
  await frame.locator('[data-testid="changes-toggle"]').hover();
  await expect(tip).toBeVisible();
  expect(await maximize.evaluate((element) => document.activeElement === element), 'focus is still off the terminal').toBe(true);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  await expect(detail, 'the tip took the first Escape, not the window').toBeVisible();
  expect(hasEscape(await readMessages()), 'the app owned that Escape').toBe(false);
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  expect(hasEscape(await readMessages()), 'the window took the second Escape').toBe(false);

  // With no window open. This is the half boot.js's `[data-tooltip]` check decides: nothing else
  // in the frame claims the key, and a focused terminal outside every window keeps no Escape of
  // its own, so without the check the first press would post to the host as well as closing the tip.
  const panelTextarea = frame.locator('[data-testid="terminal-session-pane"] .xterm-helper-textarea').first();
  await focusAcrossFrame(panelTextarea);
  await frame.locator('[data-testid="status-bar-version-pill"]').hover();
  await expect(tip).toBeVisible();
  expect(await panelTextarea.evaluate((element) => document.activeElement === element), 'focus is in the panel terminal').toBe(true);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  expect(hasEscape(await readMessages()), 'an open tip owns the first Escape').toBe(false);

  // The same press with the tip gone is the host's.
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
});

test('a parked task window does not hold Escape once it is closed', async ({ page }) => {
  // Closing a task window whose Browser pane has a live guest PARKS it: the frame stays mounted,
  // invisible and inert, so the guest survives a reopen. A parked frame has nothing left to close,
  // so the next Escape must reach the host rather than being held by a window nobody can see.
  const readMessages = await hostFrame(page, 'browser');
  const frame = page.frameLocator('#demo');
  const windowFrame = frame.locator('[data-testid^="window-frame-"]').first();
  await expect(windowFrame).toBeVisible();
  await focusAcrossFrame(windowFrame.locator('.xterm-helper-textarea').first());
  await page.keyboard.press('Escape');
  // Parked, not unmounted: without this the case would pass on a window that simply went away.
  await expect(windowFrame).toHaveAttribute('inert', '');
  expect(hasEscape(await readMessages()), 'the window takes the first Escape').toBe(false);

  await expect.poll(() => frame.locator('html').evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
});

test('embed=1 hides the OS window controls; without it they render', async ({ page }) => {
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await expect(page.locator('[data-testid="window-controls"]')).toBeHidden();

  await gotoScene(page, { view: 'board', still: '1' });
  await expect(page.locator('[data-testid="window-controls"]')).toBeVisible();
});

test('theme=sand adds theme-sand to <html>; theme=night leaves no theme- class', async ({ page }) => {
  await gotoScene(page, { view: 'board', theme: 'sand', embed: '1', still: '1' });
  await expect(page.locator('html')).toHaveClass(/(^|\s)theme-sand(\s|$)/);

  await gotoScene(page, { view: 'board', theme: 'night', embed: '1', still: '1' });
  const themeClasses = await page.evaluate(() =>
    Array.from(document.documentElement.classList).filter((className) => className.startsWith('theme-')),
  );
  expect(themeClasses).toEqual([]);
});

test('both product ids resolve, and every spelling the site may have written still lands', async ({ page }) => {
  // The site embeds this frame by URL, so these spellings are its contract: the ids, the bare
  // `kangentic` alias, and the pair's short-lived earlier ids. Nothing ties demo/boot.js's
  // APP_THEMES to ThemeMode in src/shared/types.ts, which makes this the only mechanical guard
  // that a theme added to the type is reachable from the web build at all.
  for (const [requested, expected] of [
    ['clay', 'theme-clay'],
    ['rust', 'theme-rust'],
    ['kangentic', 'theme-clay'],
    ['kangentic-light', 'theme-clay'],
    ['kangentic-dark', 'theme-rust'],
  ]) {
    await gotoScene(page, { view: 'board', theme: requested, embed: '1', still: '1' });
    const themeClasses = await page.evaluate(() =>
      Array.from(document.documentElement.classList).filter((className) => className.startsWith('theme-')),
    );
    expect(themeClasses, `?theme=${requested}`).toEqual([expected]);
  }
});

test('a scene the site embeds under its earlier name lands on the renamed one', async ({ page }) => {
  // The site's docs embed the Knowledge Graph tab as settings-memory, its name until the tab id
  // became knowledgeGraph. Without the alias that page shows the unknown-scene card.
  await gotoScene(page, { view: 'settings-memory', embed: '1', still: '1' });
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'settings-knowledgeGraph');
  await expect(page.locator('[data-testid="demo-error"]')).toHaveCount(0);
});

// ---- the display language switch ---------------------------------------------------------------
// A page cannot restart, so Restart now on a display language switches the frame in place
// (demo/README.md, Display language). Lingui re-renders its subscribers and everything they render;
// a component outside that re-render would keep its English, which the scan below catches.

const GERMAN_CATALOG_DIR = path.resolve(__dirname, '..', '..', 'src', 'locales', 'de');

/**
 * The German renderer catalogs (main's src-main.po never loads in a window), as English message to
 * German text, for the messages with no context that German renders differently.
 */
function readGermanCatalog(): Map<string, string> {
  const catalog = new Map<string, string>();
  for (const file of readdirSync(GERMAN_CATALOG_DIR)) {
    if (!file.endsWith('.po') || file === 'src-main.po') continue;
    for (const item of parsePoFile(readFileSync(path.join(GERMAN_CATALOG_DIR, file), 'utf8')).items) {
      const translation = item.msgstr[0] ?? '';
      if (item.obsolete || item.msgctxt !== null || translation === '' || translation === item.msgid) continue;
      if (!catalog.has(item.msgid)) catalog.set(item.msgid, translation);
    }
  }
  return catalog;
}

/**
 * Visible text in the frame that is still an English message German translates: a component the
 * switch did not re-render. Only a message that renders as written is looked for, so none with a
 * placeholder, a tag, or an ICU quote. Agent text and persisted names stay English by design
 * (docs/architecture/i18n.md, What stays English), so terminals, cards and the board's column
 * names are skipped.
 */
async function textStillInEnglish(page: Page, englishMessages: string[]): Promise<string[]> {
  return page.evaluate((messages) => {
    const english = new Set(messages.filter((message) => !/[{}<>']/.test(message)));
    const columnNames = new Set(Array.from(document.querySelectorAll('[data-swimlane-name]')).map((lane) => lane.getAttribute('data-swimlane-name')));
    const where = (element: Element): string => element.closest('[data-testid]')?.getAttribute('data-testid') ?? element.tagName.toLowerCase();
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      const parent = node.parentElement;
      if (!parent || !english.has(text) || columnNames.has(text) || parent.closest('.xterm, [data-task-id]')) continue;
      if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      found.push(`"${text}" in ${where(parent)}`);
    }
    for (const field of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]'))) {
      if (english.has(field.placeholder) && field.checkVisibility()) found.push(`placeholder "${field.placeholder}" of ${where(field)}`);
    }
    return found;
  }, englishMessages);
}

interface LanguageRequestsWindow { __mockLanguageRestartRequests?: string[] }

const readLanguageRequests = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as LanguageRequestsWindow).__mockLanguageRestartRequests ?? []);

test('settings-language: a still holds the Switch to Deutsch? prompt and switches nothing', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'settings-language', embed: '1', still: '1' });
  await expect(page.locator('[data-testid="language-restart-confirm"] h3')).toHaveText('Switch to Deutsch?');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await readLanguageRequests(page)).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('settings-language: Restart now switches the whole frame to German in place, and back to English', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const germanCatalog = readGermanCatalog();
  const germanLanguageLabel = germanCatalog.get('Language');
  expect(germanLanguageLabel, 'the German settings catalog translates the Language tab').toBeTruthy();
  await gotoScene(page, { view: 'settings-language', embed: '1' });
  const html = page.locator('html');
  const languageTab = page.locator('[data-testid="settings-tab-language"]');
  const prompt = page.locator('[data-testid="language-restart-confirm"]');
  const restartNow = page.locator('[data-testid="language-restart-confirm-confirm"]');
  // The live frame boots to the pose: Deutsch picked, its prompt up, nothing switched yet.
  await expect(prompt).toBeVisible();
  await expect(languageTab).toContainText('Language');
  // In English the scan finds the frame's own labels, so an empty answer after the switch means
  // they changed rather than that the scan read nothing.
  expect((await textStillInEnglish(page, [...germanCatalog.keys()])).length).toBeGreaterThan(20);

  await restartNow.click();
  await expect(html).toHaveAttribute('lang', 'de');
  await expect(prompt).toHaveCount(0);
  await expect(languageTab).toContainText(germanLanguageLabel ?? '');
  await expect.poll(() => textStillInEnglish(page, [...germanCatalog.keys()]), { timeout: 5000 }).toEqual([]);

  await page.locator('[data-testid="display-language-toggle"]').click();
  await page.locator('[data-testid="display-language-option-en"]').click();
  await restartNow.click();
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(prompt).toHaveCount(0);
  await expect(languageTab).toContainText('Language');
  // The mock's own call ran under the switch both times: it saved each language as main would.
  expect(await readLanguageRequests(page)).toEqual(['de', 'en']);
  expect(getUnexpectedErrors()).toEqual([]);
});

interface DemoLanguageLoaderWindow { __demoLoadLanguage?: unknown }

test('settings-language: a switch that cannot load surfaces the restart failure toast and leaves the frame in English', async ({ page }) => {
  // boot.js wraps the mock's setLanguageAndRestart. The mock runs first, then the switch loads. A
  // build without the loader (demo/language-entry.ts) must throw, so the renderer's own failure
  // path runs. A wrapper that swallowed the error, or resolved before the switch landed, would
  // close the prompt in silence on a frame that is still English.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'settings-language', embed: '1' });
  const html = page.locator('html');
  const prompt = page.locator('[data-testid="language-restart-confirm"]');
  await expect(prompt).toBeVisible();
  await expect(html).toHaveAttribute('lang', 'en');

  await page.evaluate(() => { delete (window as unknown as DemoLanguageLoaderWindow).__demoLoadLanguage; });
  await page.locator('[data-testid="language-restart-confirm-confirm"]').click();

  const failureToast = page.locator('[data-testid="toast"][data-variant="error"]');
  await expect(failureToast.locator('[data-testid="toast-title"]')).toHaveText("Couldn't restart");
  await expect(prompt).toHaveCount(0);
  await expect(html).toHaveAttribute('lang', 'en');
  // The mock ran first: it recorded the request before the missing loader failed the switch.
  expect(await readLanguageRequests(page)).toEqual(['de']);

  // The toast alone does not pin the wrapper's own throw: a bare return in its place would reject
  // later, on the missing module, and raise the same toast. The renderer logs the rejection it
  // received, so that line names the wrapper's message. It is the one console error allowed here.
  const isRestartFailureLog = (entry: string): boolean => entry.startsWith('console.error: Display language restart failed:');
  await expect.poll(() => getUnexpectedErrors().filter(isRestartFailureLog)).toHaveLength(1);
  const errors = getUnexpectedErrors();
  expect(errors.find(isRestartFailureLog)).toContain('this build carries no language switch');
  expect(errors.filter((entry) => !isRestartFailureLog(entry))).toEqual([]);
});

test('a frame draws no focus outline for its own clicks, and a visitor\'s first key brings it back', async ({ page }) => {
  // The language scene's pose opens the restart prompt with synthesized clicks, and BaseDialog's
  // focus trap focuses its close button. Chromium counts only trusted input, so it matches
  // :focus-visible there, where a desktop mouse pick does not (demo/README.md, Focus rings).
  await gotoScene(page, { view: 'settings-language', embed: '1', still: '1' });
  const readFocus = () => page.evaluate(() => {
    const active = document.activeElement;
    return {
      inPrompt: Boolean(active?.closest('[data-testid="language-restart-confirm"]')),
      focusVisible: Boolean(active?.matches(':focus-visible')),
      outline: active ? getComputedStyle(active).outlineStyle : '',
    };
  });
  expect(await readFocus()).toEqual({ inPrompt: true, focusVisible: true, outline: 'none' });
  // A text field keeps its outline, since Chromium draws one after a mouse click too: a field and
  // a button styled alike, each focused by script, before and after the visitor's key.
  const probeOutlines = () => page.evaluate(() => {
    if (!document.getElementById('outline-probe-field')) {
      const style = document.createElement('style');
      style.textContent = '#outline-probe-field:focus-visible, #outline-probe-button:focus-visible { outline: 2px solid rgb(255, 0, 0); }';
      document.head.appendChild(style);
      const field = document.createElement('input');
      field.id = 'outline-probe-field';
      const button = document.createElement('button');
      button.id = 'outline-probe-button';
      button.textContent = 'probe';
      document.body.append(field, button);
    }
    const outlineOf = (id: string): string => {
      const element = document.getElementById(id) as HTMLElement;
      element.focus({ preventScroll: true });
      return getComputedStyle(element).outlineStyle;
    };
    return { field: outlineOf('outline-probe-field'), button: outlineOf('outline-probe-button') };
  });
  expect(await probeOutlines()).toEqual({ field: 'solid', button: 'none' });
  await page.keyboard.press('Shift');
  await expect.poll(probeOutlines).toEqual({ field: 'solid', button: 'solid' });
});

test('a synthesized pointer or key does not lift the focus outline suppression, a real mouse press does', async ({ page }) => {
  // The mark comes off on the first TRUSTED pointerdown or keydown (demo/boot.js, Focus rings).
  // The key half is the test above; this holds the pointer half and the isTrusted guard that keeps
  // a scene's own synthesized events (its boot click, a choreography) from lifting it. It reads the
  // mark itself rather than an outline, because after a mouse input Chromium stops matching :focus-visible
  // for a script focus, so an outline read would pass with or without the suppression.
  await gotoScene(page, { view: 'settings-language', embed: '1', still: '1' });
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-demo-untouched', '');

  // The listeners are synchronous, so the read in the same evaluate is the answer.
  const untouchedAfterSynthesizedInput = await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true, composed: true }));
    return document.documentElement.hasAttribute('data-demo-untouched');
  });
  expect(untouchedAfterSynthesizedInput).toBe(true);

  // A press on the prompt's heading does nothing: it is neither a control nor the backdrop.
  const heading = await page.locator('[data-testid="language-restart-confirm"] h3').boundingBox();
  if (!heading) throw new Error('the restart prompt has no heading to press');
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(html).not.toHaveAttribute('data-demo-untouched');
});

test('view=nope renders the error card, logs the unknown scene, and never marks ready', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(demoUrl({ view: 'nope', embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('Unknown scene "nope"');
  await expect.poll(() => consoleErrors.some((text) => text.includes('Unknown scene'))).toBe(true);

  // The app behind the card still boots (empty, by design). Once it has painted, the ready
  // flag must still be absent: nothing seeded means nothing to caption.
  await expect(page.locator('#root > *').first()).toBeAttached();
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-scene');
});

test('state= alone opens the task window with no registry scene involved', async ({ page }) => {
  const stateBlob = Buffer.from(JSON.stringify({ config: SCENES.task.config })).toString('base64url');
  const getUnexpectedErrors = collectUnexpectedErrors(page);

  await gotoScene(page, { state: stateBlob, embed: '1', still: '1' });
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'state');
  // boot.js leaves sceneName null when only state= is given: no registry lookup happened.
  const resolvedSceneName = await page.evaluate(() => {
    const boot = (window as DemoBootGlobal).__demoBoot;
    return boot === undefined ? 'boot-missing' : boot.sceneName;
  });
  expect(resolvedSceneName).toBeNull();
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Extract auth middleware');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the build carries production semantics: no dev badge, no dev-only store exposure', async ({ page }) => {
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  // The "(dev)" wordmark suffix is built out by __KANGENTIC_DEV__; the store exposure is behind
  // import.meta.env.DEV. An ambient NODE_ENV=development at build time would bring both back.
  await expect(page.locator('[data-testid="titlebar-dev-badge"]')).toHaveCount(0);
  const hasDevStores = await page.evaluate(() => '__zustandStores' in window);
  expect(hasDevStores).toBe(false);
});

test('the classic scripts every frame loads before first paint ship minified', async ({ page, request }) => {
  // Vite never sees the five scripts demo/vite.config.mts injects ahead of the bundle, so nothing
  // minified them, and boot.js and the mock went out mostly as comments (minifyClassicScript).
  // Minifying a shipped script again must gain next to nothing. A line-based look for comments
  // cannot tell: the seed carries diffs and terminal frames as strings, with their own indentation.
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  const classicScripts = await page.evaluate(() => Array.from(document.querySelectorAll('head script[src]:not([type="module"])')).map((script) => (script as HTMLScriptElement).src));
  expect(classicScripts.length, 'the five classic scripts').toBe(5);
  for (const url of classicScripts) {
    const source = await (await request.get(url)).text();
    const again = transformSync(source, { loader: 'js', minify: true, legalComments: 'none' }).code;
    expect(again.length / source.length, `${url.split('/').pop()} ships unminified`).toBeGreaterThan(0.98);
  }
});

test('the emitted config-shape guard omits a block with no populated default', async ({ page }) => {
  // nestedConfigShape() (demo/vite.config.mts) is what lets boot.js refuse a state= blob naming
  // only part of a nested config block ("a state= blob naming only part of a nested config block
  // is refused", above); nothing asserted its SKIP branches actually leave a block out rather than
  // emitting it empty. Read off the real built asset rather than re-implemented here: the function
  // is private to the Vite config, and reaching it would need either exporting it (a production
  // change with no other motivation) or importing dist/demo from the unit tier, which breaks tier
  // isolation (web-demo-parity.md) - so this lives in the tier that already boots the real build.
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  const shape = await page.evaluate(() => (window as { __demoConfigShape?: Record<string, string[]> }).__demoConfigShape ?? {});
  // A populated object block is kept, with every field named.
  expect(Object.keys(shape)).toContain('monitor');
  expect(shape.monitor).toContain('layout');
  // A zero-key object default (a project-keyed map with nothing in DEFAULT_CONFIG) is skipped.
  expect(Object.keys(shape)).not.toContain('workspaceByProject');
  // A primitive default is skipped.
  expect(Object.keys(shape)).not.toContain('theme');
  // A null default is skipped.
  expect(Object.keys(shape)).not.toContain('commandTerminalWorkspace');
});

test('the board scene makes no request off the serving origin', async ({ page }) => {
  const requestUrls: string[] = [];
  page.on('request', (request) => {
    requestUrls.push(request.url());
  });

  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);

  expect(requestUrls.length).toBeGreaterThan(0);
  const offOrigin = requestUrls.filter((url) => !url.startsWith(`${server.origin}/`));
  expect(offOrigin).toEqual([]);
});

/**
 * Let go of push-to-talk the way a visitor's mouse does: a pointerup on the button the pose's
 * hotkeyDown pressed (Mouse:Back is button 3, src/shared/keybindings.ts), dispatched on `document`
 * as boot.js dispatches its pointerdown, which useDictation's capture-phase `window` listener
 * matches through matchesMouseRelease(event, 'Mouse:Back').
 */
async function releasePushToTalk(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerup', {
      button: 3, buttons: 0, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  });
}

test('a still holds push-to-talk over the empty Settings search box, and a release there lands no text', async ({ page }) => {
  // A still arms no timer, so the held key hears none of the recorded utterance: the poster is the
  // press itself. Letting go then commits what was heard, which is nothing.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'dictation-field', embed: '1', still: '1' });
  const searchInput = page.locator('[data-testid="settings-search"]');
  await expect(searchInput).toHaveValue('');
  await releasePushToTalk(page);
  // LiveDictationChip renders null once the dictation store is back to 'idle', which
  // finalizeOnRelease reaches only after stop() has resolved and the input sink's submit() has
  // run - the observable end of the release, not a fixed wait for it.
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toHaveCount(0, { timeout: 5000 });
  await expect(searchInput).toHaveValue('');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the held key types the recorded utterance into the Settings search, and the release lands its refined final', async ({ page }) => {
  // The live frame replays DEMO_DICTATION_RECORDING from the press: each partial the live model
  // streamed is typed into the focused box on the recording's clock, and the release commits the
  // refinement's text. The Settings search narrows to the rows the words name. Auto-submit is on
  // (the default), so the release also presses Enter on the box, which submits nothing there: the
  // panel stays open with the text in place.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'dictation-field', embed: '1' });
  const searchInput = page.locator('[data-testid="settings-search"]');
  const lastPartial = DEMO_DICTATION_RECORDING.partials[DEMO_DICTATION_RECORDING.partials.length - 1].text;
  await expect(searchInput).toHaveValue(lastPartial, { timeout: 10_000 });
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toBeVisible();
  await releasePushToTalk(page);
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toHaveCount(0, { timeout: 5000 });
  await expect(searchInput).toHaveValue(DEMO_DICTATION_RECORDING.final.text);
  // "Push to talk." names the Dictation card's push-to-talk rows, so its Release buffer stays and
  // the Transcription card goes. A final whose closing period broke the match would hide both.
  await expect(page.locator('[data-testid="dictation-release-buffer"]')).toBeVisible();
  await expect(page.locator('[data-testid="dictation-model-lines"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  expect(getUnexpectedErrors()).toEqual([]);
});

interface DictationTap {
  partials: Array<{ at: number; text: string }>;
  finals: Array<{ at: number; text: string }>;
  /** Every value the Settings search box took, from its input events. */
  values: string[];
}

interface DictationTapWindow {
  __dictationTap: DictationTap;
  electronAPI: { dictation: { __cancelCalls: string[] } };
}

/**
 * Slow the recorded utterance's clock to `rate` and tap what the seed pushes, before any script runs.
 *
 * The box alone cannot tell a replay that was ended from one that kept running: useDictation drops
 * its onPartial and onFinal subscriptions on a release or a cancel, so a timer the seed failed to
 * clear would emit to nobody and the box would never change. The tap sits in the mock's own listener
 * lists, which the mock appends its subscribers to rather than replacing (the idiom of
 * __mockDataListeners), so it hears every push whoever is subscribed.
 */
async function tapDictation(page: Page, rate: number): Promise<void> {
  await page.addInitScript((divisor) => {
    const holder = window as unknown as {
      __demoChoreographyRate: number;
      __dictationTap: DictationTap;
      __mockDictationPartialListeners: Array<(dictationSessionId: string, text: string) => void>;
      __mockDictationFinalListeners: Array<(dictationSessionId: string, text: string) => void>;
    };
    holder.__demoChoreographyRate = divisor;
    const tap: DictationTap = { partials: [], finals: [], values: [] };
    holder.__dictationTap = tap;
    holder.__mockDictationPartialListeners = [(_dictationSessionId, text) => { tap.partials.push({ at: performance.now(), text }); }];
    holder.__mockDictationFinalListeners = [(_dictationSessionId, text) => { tap.finals.push({ at: performance.now(), text }); }];
    document.addEventListener('input', (event) => {
      const field = event.target;
      if (field instanceof HTMLInputElement && field.getAttribute('data-testid') === 'settings-search') tap.values.push(field.value);
    }, true);
  }, rate);
}

const readDictationTap = (page: Page): Promise<DictationTap> => page.evaluate(() => (window as unknown as DictationTapWindow).__dictationTap);

/**
 * Wait until the page's clock is `afterMs` past `since` (a `performance.now()` reading). This is
 * the fixed window a "never happens" check needs, since nothing can be polled for non-occurrence,
 * but read off the page's own clock so a slow runner cannot cut it short.
 */
function pageClockPast(page: Page, since: number, afterMs: number): Promise<unknown> {
  return page.waitForFunction((deadline) => performance.now() >= deadline, since + afterMs, { polling: 100 });
}

test('letting go after the first partial commits what the live model had heard, never the refined final', async ({ page }) => {
  // stop() answers the partial heard so far when the key goes up before the last one, and the
  // refinement only after it. The gap between the two partials is 560 ms at the recording's pace
  // and 2.24 s at a quarter of it, which clears the 250 ms release buffer (stop() runs that long
  // after the release, with the clock still live) and the poll's latency.
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const rate = 0.25;
  const [heard, notYetHeard] = DEMO_DICTATION_RECORDING.partials;
  await tapDictation(page, rate);
  await gotoScene(page, { view: 'dictation-field', embed: '1' });
  const searchInput = page.locator('[data-testid="settings-search"]');
  // 50 ms steps, not toHaveValue's backoff, which is at one second by the time the first partial
  // lands and would spend the gap before the key went up.
  await expect.poll(() => searchInput.inputValue(), { intervals: [50], timeout: 20_000 }).toBe(heard.text);
  await releasePushToTalk(page);
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toHaveCount(0, { timeout: 5000 });
  await expect(searchInput).toHaveValue(heard.text);
  // Past the moment the second partial would have been heard, and a margin on top.
  const afterFirst = (await readDictationTap(page)).partials[0];
  expect(afterFirst, 'the first partial was pushed').toBeDefined();
  await pageClockPast(page, afterFirst.at, (notYetHeard.t - heard.t) / rate + 500);
  const tap = await readDictationTap(page);
  expect(tap.partials.map((partial) => partial.text), 'the replay ended with the key: no partial after the release').toEqual([heard.text]);
  expect(tap.finals.map((final) => final.text), 'main commits the partial heard so far, not the refinement').toEqual([heard.text]);
  expect(tap.values, 'the box never took a later partial or the final').not.toContain(notYetHeard.text);
  expect(tap.values).not.toContain(DEMO_DICTATION_RECORDING.final.text);
  await expect(searchInput).toHaveValue(heard.text);
  await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  expect(getUnexpectedErrors()).toEqual([]);
});

test('letting go before the first partial commits nothing, and the replay ends with the key', async ({ page }) => {
  // The first partial is 2.4 s after the frame reveals at half the recording's pace, which the
  // release beats by a wide margin; the poll then runs past the last partial's time.
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const rate = 0.5;
  const partials = DEMO_DICTATION_RECORDING.partials;
  const lastPartial = partials[partials.length - 1];
  await tapDictation(page, rate);
  await gotoScene(page, { view: 'dictation-field', embed: '1' });
  const searchInput = page.locator('[data-testid="settings-search"]');
  const releasedAt = await page.evaluate(() => performance.now());
  await expect(searchInput).toHaveValue('');
  await releasePushToTalk(page);
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toHaveCount(0, { timeout: 5000 });
  // The clock started at the reveal, which was no later than the release.
  await pageClockPast(page, releasedAt, lastPartial.t / rate + 500);
  const tap = await readDictationTap(page);
  expect(tap.partials, 'nothing is heard once the key is up').toEqual([]);
  expect(tap.finals.map((final) => final.text), 'a release before any partial commits nothing').toEqual(['']);
  expect(tap.values.filter((value) => value !== ''), 'the box took no text').toEqual([]);
  await expect(searchInput).toHaveValue('');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('Clear on the live chip cancels the dictation: the typed text goes and the replay ends', async ({ page }) => {
  // The chip's Clear control is the one visitor path to dictation.cancel (useDictation's
  // clearDictation erases the live text, then cancels). The replay must end with it: a later
  // partial emitted to nobody is the only trace a still-running clock leaves.
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const rate = 0.25;
  const [heard, notYetHeard] = DEMO_DICTATION_RECORDING.partials;
  await tapDictation(page, rate);
  await gotoScene(page, { view: 'dictation-field', embed: '1' });
  const searchInput = page.locator('[data-testid="settings-search"]');
  await expect.poll(() => searchInput.inputValue(), { intervals: [50], timeout: 20_000 }).toBe(heard.text);
  await page.locator('[data-testid="dictation-live-clear"]').click();
  await expect(page.locator('[data-testid="dictation-live-chip"]')).toHaveCount(0, { timeout: 5000 });
  await expect(searchInput).toHaveValue('');
  await expect.poll(() => page.evaluate(() => (window as unknown as DictationTapWindow).electronAPI.dictation.__cancelCalls.length)).toBe(1);
  const afterFirst = (await readDictationTap(page)).partials[0];
  expect(afterFirst, 'the first partial was pushed').toBeDefined();
  await pageClockPast(page, afterFirst.at, (notYetHeard.t - heard.t) / rate + 500);
  const tap = await readDictationTap(page);
  expect(tap.partials.map((partial) => partial.text), 'the replay ended with the cancel: no partial after it').toEqual([heard.text]);
  // The seed answers stop() with a final push, so none means Clear aborted the utterance rather than finishing it.
  expect(tap.finals, 'a cancel commits nothing').toEqual([]);
  expect(tap.values, 'the box never took a later partial or the final').not.toContain(notYetHeard.text);
  expect(tap.values).not.toContain(DEMO_DICTATION_RECORDING.final.text);
  await expect(searchInput).toHaveValue('');
  await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  expect(getUnexpectedErrors()).toEqual([]);
});

// ---- live replay and what a visitor can start ----------------------------------------------
// A still frame paints each terminal's final state from the inline seed and never fetches a
// recording; the live frame replays each recording's timed stream, fetched from the same origin
// when a terminal mounts, and a drag into an auto-spawn column or a new Command Terminal starts
// the boot recorded for it, the way the desktop starts the agent.

interface DemoSessionRow { id: string; taskId: string | null; projectId: string; status: string; transient?: boolean; workflowId?: string | null }
interface DemoTaskRow { id: string; title: string; session_id: string | null }
interface DemoRecordingsWindow {
  __demoRecordings: { base: string; sessions: Record<string, { file: string; cols: number; rows: number }> };
  __demoScrollback: Record<string, string>;
}
interface DemoElectronWindow {
  electronAPI: {
    sessions: {
      list: () => Promise<DemoSessionRow[]>;
      getActivity: () => Promise<Record<string, string>>;
      onData: (callback: (sessionId: string, data: string) => void) => () => void;
      getScrollback: (sessionId: string) => Promise<string>;
      __resizeCalls?: Array<{ sessionId: string; cols: number; rows: number }>;
    };
    tasks: { list: () => Promise<DemoTaskRow[]> };
  };
}

interface DemoMonitorWindow {
  __mockMonitorRows?: Array<{
    sessionId: string; activity: string; outputPeek?: string[]; columnName?: string;
    status?: string; modelDisplayName?: string | null; contextPercent?: number | null; description?: string | null;
  }>;
}

interface MonitorFields { status?: string; modelDisplayName?: string | null; contextPercent?: number | null; description?: string | null }

/** The Monitor snapshot fields a row carries beyond its activity: the status, model, context, and description. */
function monitorFields(page: Page, sessionId: string): Promise<MonitorFields | null> {
  return page.evaluate((id) => {
    const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
    return row ? { status: row.status, modelDisplayName: row.modelDisplayName, contextPercent: row.contextPercent, description: row.description } : null;
  }, sessionId);
}

/** The Monitor row state the mock publishes: what a card shows without opening a terminal. */
function monitorRow(page: Page, sessionId: string): Promise<{ activity: string; peek: string; columnName: string | null } | null> {
  return page.evaluate((id) => {
    const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
    return row ? { activity: row.activity, peek: (row.outputPeek ?? []).join(' | '), columnName: row.columnName ?? null } : null;
  }, sessionId);
}

/** How many DISTINCT output peeks a session's Monitor row shows over the given span. */
async function countPeekChanges(page: Page, sessionId: string, spanMs: number): Promise<number> {
  return page.evaluate(({ id, span }) => new Promise<number>((resolve) => {
    let previous: string | null = null;
    let changes = 0;
    const timer = setInterval(() => {
      const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
      const peek = (row?.outputPeek ?? []).join(' | ');
      if (previous !== null && peek !== previous) changes += 1;
      previous = peek;
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(changes); }, span);
  }), { id: sessionId, span: spanMs });
}

/** The message trail a session's Monitor card is rendering right now, empty when it draws none. */
function readTrail(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => {
    // Scoped to the card: a terminal tab in the board's bottom panel carries the same id.
    const card = document.querySelector(`[data-testid="monitor-card"][data-session-id="${id}"]`);
    return card?.querySelector('[data-testid="monitor-card-trail"]')?.textContent ?? '';
  }, sessionId);
}

/**
 * How many DISTINCT message trails a session's Monitor CARD renders over the given span.
 *
 * The rendered text, not the mock's state: the point of the trail is what a visitor reads on the
 * card, and the peek counterpart above deliberately measures the row instead.
 */
async function countTrailChanges(page: Page, sessionId: string, spanMs: number): Promise<number> {
  return page.evaluate(({ id, span }) => new Promise<number>((resolve) => {
    let previous: string | null = null;
    let changes = 0;
    const read = (): string => {
      // Scoped to the card: a terminal tab in the board's bottom panel carries the same id.
      const card = document.querySelector(`[data-testid="monitor-card"][data-session-id="${id}"]`);
      return card?.querySelector('[data-testid="monitor-card-trail"]')?.textContent ?? '';
    };
    const timer = setInterval(() => {
      const text = read();
      if (previous !== null && text !== previous) changes += 1;
      previous = text;
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(changes); }, span);
  }), { id: sessionId, span: spanMs });
}

interface WindowGeometry { x: number; y: number; w: number; h: number }

/** The window manager's DEFAULT rect (defaultWindowGeometry: 0.58 of the frame, centred). */
const DEFAULT_WINDOW_GEOMETRY: WindowGeometry = { x: 0.21, y: 0.15, w: 0.58, h: 0.7 };

/**
 * One floating task-detail window, by default at the window manager's default rect: the window a
 * visitor's own click opens and the one each task session was recorded at. Unlike the fitted
 * `task` scene it is a fixed fraction, so its grid moves with the display, which is what the hold
 * cases below need.
 */
function floatingWindowState(taskId: string, title: string, geometry: WindowGeometry = DEFAULT_WINDOW_GEOMETRY) {
  return {
    config: {
      workspaceByProject: {
        'proj-contoso-web': {
          version: 1,
          windows: [{
            taskId,
            kind: 'task-detail',
            title,
            geometry,
            restoreGeometry: null,
            state: 'floating',
          }],
          tileTree: null,
          tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
          focusedTaskId: taskId,
        },
      },
    },
  };
}

/**
 * A task-detail window on "Add rate limiting", whose session the board seeds IDLE, at the default
 * rect, so the window mounts its terminal on the grid the recording fits and takes the live path
 * rather than the frame fallback.
 */
const RATE_LIMIT_WINDOW_STATE = floatingWindowState('task-cw-rate-limit', 'Add rate limiting');

/** The middleware task at the default rect, where a display at another scale fits another grid. */
const MIDDLEWARE_DEFAULT_WINDOW_STATE = floatingWindowState(TASK_MIDDLEWARE, 'Extract auth middleware');

function encodeState(state: unknown): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/** Total bytes the mock delivers for one session over the given span, through its own data path. */
function streamedBytes(page: Page, sessionId: string, spanMs: number): Promise<number> {
  return page.evaluate(({ id, span }) => new Promise<number>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    let total = 0;
    const unsubscribe = api.sessions.onData((candidate, data) => {
      if (candidate === id) total += data.length;
    });
    setTimeout(() => { unsubscribe(); resolve(total); }, span);
  }), { id: sessionId, span: spanMs });
}

function recordingRequests(page: Page): () => string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/recordings/')) urls.push(request.url());
  });
  return () => urls.slice();
}

/**
 * A terminal frame as plain text. A frame spells runs of spaces as cursor-forward moves, so those
 * become a space before the rest of the escapes go.
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[\d*C/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/ +/g, ' ');
}

/** The ids of every session row the mock lists for one task. */
function sessionIdsForTask(page: Page, taskId: string): Promise<string[]> {
  return page.evaluate(async (wantedTaskId) => {
    const sessions = await (window as unknown as DemoElectronWindow).electronAPI.sessions.list();
    return sessions.filter((session) => session.taskId === wantedTaskId).map((session) => session.id);
  }, taskId);
}

/**
 * Clicks a task window's session toggle while it offers Resume, and waits for the resume to
 * settle. Not on the accessible name: it reads Pause once the session row is active, which can
 * land while the resume is still in flight. The state attribute reads active only once the toggle
 * has settled.
 */
async function resumeAndSettle(toggle: Locator): Promise<void> {
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-session-state', 'active');
}

/**
 * Resolves with the first session id the mock's onData listeners deliver bytes for. `only` scopes
 * it to one session, which every caller wants: the sample install's pre-seeded working sessions
 * now play frames into whatever terminal is mounted, so an unscoped listener resolves on whoever
 * happens to repaint first rather than on the session the test started.
 */
function firstStreamedSession(page: Page, timeoutMs: number, only?: string): Promise<string | null> {
  return page.evaluate(({ timeout, wanted }) => new Promise<string | null>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    // Whatever the sample install already has running: those play their recordings' frames into
    // whichever terminal is mounted, so without this the listener resolves on whoever repaints
    // first rather than on the session the test started. A spawn's id is minted at spawn time,
    // so it cannot be named up front; not being one of these is what identifies it.
    const seeded = new Set(((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).map((row) => row.sessionId));
    const timer = setTimeout(() => resolve(null), timeout);
    const unsubscribe = api.sessions.onData((sessionId, data) => {
      if (!data) return;
      if (wanted === null ? seeded.has(sessionId) : sessionId !== wanted) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(sessionId);
    });
  }), { timeout: timeoutMs, wanted: only ?? null });
}

interface Grid { cols: number; rows: number }

/** The grid the session's terminal mounted with: the last resize the renderer sent the mock for it. */
function mountedGrid(page: Page, sessionId: string): Promise<Grid | null> {
  return page.evaluate((id) => {
    const calls = (window as unknown as DemoElectronWindow).electronAPI.sessions.__resizeCalls ?? [];
    const last = calls.filter((call) => call.sessionId === id).pop();
    return last ? { cols: last.cols, rows: last.rows } : null;
  }, sessionId);
}

/**
 * Every grid the renderer has sent the mock for the session. A terminal main HOLDS at a grid sends
 * that grid once it has conformed (its own xterm resize reports it), and keeps probing with its
 * natural grid afterwards, so the LAST call is not the grid it shows; the held grid appearing in
 * the list is what says the terminal conformed (see the hold in demo-dataset.ts's resize wrapper).
 */
function sentGrids(page: Page, sessionId: string): Promise<Grid[]> {
  return page.evaluate((id) => {
    const calls = (window as unknown as DemoElectronWindow).electronAPI.sessions.__resizeCalls ?? [];
    return calls.filter((call) => call.sessionId === id).map((call) => ({ cols: call.cols, rows: call.rows }));
  }, sessionId);
}

/** The grid the middleware session was recorded at (tests/captures/fixtures/demo/manifest.json, a Claude task window). */
const MIDDLEWARE_RECORDED_GRID: Grid = { cols: 154, rows: 37 };

/** The same session's tiled recording (manifest geometry taskWindowTiled, measured at the rig's 2x launch). */
const MIDDLEWARE_TILED_GRID: Grid = { cols: 115, rows: 37 };

/**
 * The most a terminal may leave empty around its screen, beside it and below it: the leftover of
 * whole cells a fit always has, twice over, since a held pane is taken at the least its natural
 * grid allows and then filled at a smaller cell (displayFor in demo-dataset.ts). A letterboxed
 * recording left 56px beside and 23px below every card window at 125 percent, and 314px below the
 * Browser scene's terminal at 100; a pane the seed fills stays inside these on every display.
 *
 * The pixels are those cells at the app's 12px type. A terminal at larger type (task-mcp, the one
 * scene above native type) leaves larger whole cells, so each band may also be two of that
 * terminal's own cells, whichever is more.
 */
const MAX_EMPTY_BESIDE_PX = 16;
const MAX_EMPTY_BELOW_PX = 30;

interface PaneBands { right: number; below: number; cellWidth: number; cellHeight: number }

/**
 * The empty band beside and below the screen of every terminal on the page, as the fit addon
 * measures its box, and the terminal's cell, which xterm writes onto its helper textarea's size.
 */
function paneBands(page: Page): Promise<PaneBands[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.xterm')).flatMap((xterm) => {
    const parent = xterm.parentElement;
    const viewport = xterm.querySelector<HTMLElement>('.xterm-viewport');
    const screen = xterm.querySelector<HTMLElement>('.xterm-screen');
    if (!parent || !viewport || !screen) return [];
    const parentBox = parent.getBoundingClientRect();
    if (parentBox.width === 0 || parentBox.height === 0) return [];
    const style = getComputedStyle(xterm);
    const screenBox = screen.getBoundingClientRect();
    // The terminal's own inset (index.css pads .xterm) is margin the app draws on purpose, not
    // a band the fit left, so both bands are measured inside it, as the fit addon measures.
    const paddingHorizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingVertical = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const textarea = xterm.querySelector<HTMLElement>('.xterm-helper-textarea');
    return [{
      right: Math.round(parentBox.width - paddingHorizontal - (viewport.offsetWidth - viewport.clientWidth) - screenBox.width),
      below: Math.round(parentBox.height - paddingVertical - screenBox.height),
      cellWidth: parseFloat(textarea?.style.width ?? '') || 0,
      cellHeight: parseFloat(textarea?.style.height ?? '') || 0,
    }];
  }));
}

/**
 * Every terminal on the page fills its pane. Polled, because a held terminal conforms a resize
 * debounce after it mounts, and a window's layout lands a frame after its first report.
 */
async function expectPanesFilled(page: Page, label: string): Promise<void> {
  await expect.poll(async () => {
    const bands = await paneBands(page);
    if (bands.length === 0) return ['no terminal on the page'];
    return bands.filter((band) => band.right > Math.max(MAX_EMPTY_BESIDE_PX, 2 * band.cellWidth)
      || band.below > Math.max(MAX_EMPTY_BELOW_PX, 2 * band.cellHeight));
  }, { timeout: 15_000, message: `${label}: a terminal left its pane empty around it` }).toEqual([]);
}

interface ReplayState { mode: 'bytes' | 'frames' | null; held: Grid | null }

/** How the seed is feeding a session's terminal (window.__demoReplayMode) and the grid it holds it at, if any (window.__demoHeldGrid). */
function replayState(page: Page, sessionId: string): Promise<ReplayState> {
  return page.evaluate((id) => {
    const demo = window as unknown as { __demoReplayMode?: Record<string, 'bytes' | 'frames'>; __demoHeldGrid?: Record<string, Grid | null> };
    return { mode: demo.__demoReplayMode?.[id] ?? null, held: demo.__demoHeldGrid?.[id] ?? null };
  }, sessionId);
}

/** The grids a session was recorded at: its single recording's, and its tiled sibling's when it has one. */
function recordingGridsOf(page: Page, sessionId: string): Promise<Grid[]> {
  return page.evaluate((id) => {
    interface Indexed { cols: number; rows: number; tiled?: Indexed }
    const sessions = (window as unknown as { __demoRecordings?: { sessions: Record<string, Indexed> } }).__demoRecordings?.sessions ?? {};
    const indexed = sessions[id];
    if (!indexed) return [];
    return [indexed, ...(indexed.tiled ? [indexed.tiled] : [])].map((entry) => ({ cols: entry.cols, rows: entry.rows }));
  }, sessionId);
}

/**
 * The replay invariant: bytes reach a terminal only on its recording's grid, and every other grid
 * plays frames from the page's emulator. A session the seed holds at a smaller type has to see
 * the terminal report the held grid back, which is the conform landing: a hold with no report back
 * is the decline that wrapped every padded row into a blank one and put Copilot's scrollbar in
 * column zero. Which path a pane takes rides on the platform's font metrics, so this asserts
 * whichever one the seed took rather than predicting it.
 */
async function expectFaithfulReplay(page: Page, sessionId: string): Promise<ReplayState> {
  await expect.poll(async () => (await replayState(page, sessionId)).mode, { timeout: 15_000, message: `${sessionId} was never fed` }).not.toBeNull();
  const state = await replayState(page, sessionId);
  if (state.held) {
    await expect.poll(() => sentGrids(page, sessionId), { timeout: 10_000, message: `${sessionId} was held at ${state.held.cols}x${state.held.rows} and never conformed` }).toContainEqual(state.held);
  }
  if (state.mode === 'bytes') {
    const recorded = await recordingGridsOf(page, sessionId);
    const terminalGrid = state.held ?? await naturalGrid(page, sessionId);
    if (recorded.length > 0) expect(recorded, `${sessionId} was handed bytes on a grid none of its recordings has`).toContainEqual(terminalGrid);
  }
  return state;
}

/** The natural grid the seed last recorded for a session (window.__demoNaturalGeometry): what its window fits, before any hold. */
function naturalGrid(page: Page, sessionId: string): Promise<Grid | null> {
  return page.evaluate((id) => {
    const natural = (window as unknown as { __demoNaturalGeometry?: Record<string, Grid> }).__demoNaturalGeometry ?? {};
    return natural[id] ?? null;
  }, sessionId);
}

/**
 * The floating terminal scenes, each with the session its window is fitted to
 * (FITTED_FLOATING_GEOMETRY in scenes.ts) and that session's single recording, whose grid the
 * window must take: 154 columns and 37 rows, both Claude sessions recorded at the task window.
 */
const FITTED_WINDOW_SCENES = [
  { view: 'task', sessionId: SESSION_MIDDLEWARE, fileStem: 'contoso-web-claude-middleware' },
  { view: 'command-terminal', sessionId: SESSION_CONTOSO_TERMINAL, fileStem: 'contoso-web-claude-terminal' },
] as const;

/**
 * Opens a fitted scene and asserts its window's terminal took exactly the recording's columns,
 * rows to spare, and the SINGLE recording's bytes. Polls for the columns because a terminal
 * reports once at a transitional size before its window's layout lands (demo/measure.mjs); a
 * window that never lands on the recording's width fails the poll.
 */
async function expectFittedToRecording(page: Page, scene: typeof FITTED_WINDOW_SCENES[number], label: string): Promise<void> {
  const getRecordingRequests = recordingRequests(page);
  await page.goto(demoUrl({ view: scene.view, embed: '1' }));
  await waitForDemoReady(page);
  await expect.poll(async () => (await naturalGrid(page, scene.sessionId))?.cols, { timeout: 10_000, message: `${label}: the window's terminal columns` })
    .toBe(MIDDLEWARE_RECORDED_GRID.cols);
  expect((await naturalGrid(page, scene.sessionId))?.rows ?? 0, `${label}: the window's terminal rows`).toBeGreaterThanOrEqual(MIDDLEWARE_RECORDED_GRID.rows);
  await expect.poll(() => getRecordingRequests().some((url) => url.includes(`/recordings/${scene.fileStem}-`) && !url.includes('-tiled-')), { timeout: 15_000 }).toBe(true);
  await expectFaithfulReplay(page, scene.sessionId);
}

/**
 * The same, for the Copilot rate-limit session. Claude's context bar wraps to two rows and every
 * other agent's does not, so a non-Claude session records two rows taller (manifest geometry,
 * rowsByAgent).
 */
const RATE_LIMIT_RECORDED_GRID: Grid = { cols: 154, rows: 39 };

/**
 * Every frame the mock paints into a terminal on the frames path, parsed: the rows between the
 * autowrap-off and autowrap-on brackets, each measured in cells (code points plus cursor-forward
 * gaps; the sample install's frames carry no wide glyph). A full paint joins its rows with line
 * breaks; a repaint that builds on the last one redraws each screen row in place behind a cursor
 * move to its first column. What the bottom-panel case asserts on.
 */
function paintedFrameRowWidths(page: Page, sessionId: string, spanMs: number): Promise<number[][]> {
  return page.evaluate(({ id, span }) => new Promise<number[][]>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const frames: number[][] = [];
    const unsubscribe = api.sessions.onData((candidate, data) => {
      if (candidate !== id) return;
      const start = data.indexOf('\x1b[?7l');
      const end = data.lastIndexOf('\x1b[?7h');
      if (start === -1 || end === -1 || end < start) return;
      frames.push(data.slice(start + 5, end).split(/\r\n|\x1b\[\d+;1H/).filter((row, index) => index > 0 || row !== '').map((row) => {
        const text = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const gaps = (row.match(/\x1b\[(\d*)C/g) ?? []).reduce((sum, move) => sum + Number(move.replace(/\D/g, '') || '1'), 0);
        return Array.from(text).length + gaps;
      }));
    });
    setTimeout(() => { unsubscribe(); resolve(frames); }, span);
  }), { id: sessionId, span: spanMs });
}

/**
 * A spawn's boot has to ARRIVE, whichever path carries it. Bytes replay only into a terminal whose
 * grid equals the recording's; any other grid plays the recording's frames instead. Both reach the
 * page through the mock's onData path, which is what the bottom-panel case below proves at a grid
 * no font size can ever reconcile, so one listener observes either path and the grid does not have
 * to be classified first.
 *
 * `streamed` is armed by the caller BEFORE the spawn, and that timing is the whole point: a boot
 * recording is short and plays out in seconds, so a listener attached after the fact hears an
 * already-finished session and reports silence. An earlier version classified the grid first and
 * only then attached a listener on the non-fitting branch. That branch is unreachable on a machine
 * whose fonts fit the recorded grid, so it went green on Windows and failed on CI's Linux runner,
 * where it spent its whole budget waiting for a fit that never comes and then heard nothing.
 */
async function expectStreamedOrStill(page: Page, sessionId: string, streamed: Promise<string | null>): Promise<void> {
  expect(await streamed).toBe(sessionId);
}

async function dragCardToColumn(page: Page, title: string, column: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
  const target = page.locator(`[data-swimlane-name="${column}"]`);
  await expect(card).toBeVisible();
  await expect(target).toBeVisible();
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error(`no geometry for "${title}" or "${column}"`);
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 10, cardBox.y + cardBox.height / 2, { steps: 3 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.mouse.up();
}

test('still=1 paints every terminal from the seed and fetches no recording', async ({ page }) => {
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1', still: '1' });
  await SCENE_MARKERS.task(page);
  expect(getRecordingRequests()).toEqual([]);
});

test('the Knowledge Graph\'s maps are fetched once, by a frame that opens the graph, and never by a board', async ({ page }) => {
  // The maps were most of the seed's weight while no board frame drew them, so the build emits them
  // as their own file and the seed fetches it on the graph's first ask (demo-dataset.ts,
  // seededKnowledgeGraph). Every project's snapshot and the Projects picker share that one read.
  const graphRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/graph/')) graphRequests.push(request.url()); });
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  expect(graphRequests).toEqual([]);

  await gotoScene(page, { view: 'knowledge-graph', embed: '1', still: '1' });
  await expect(page.locator(SCENES['knowledge-graph'].ready).first()).toBeVisible();
  expect(graphRequests).toHaveLength(1);
  expect(graphRequests[0]).toMatch(/\/graph\/knowledge-graph-[0-9a-f]{8}\.json$/);
});

test('a scene-only row\'s recorded sessions are loaded once, by a frame that names the row, and never by a board', async ({ page }) => {
  // The row's frames, diff, peeks and trail are its own script, not the eager seed: demo/boot.js
  // writes it into the page ahead of the seed only when the scene's rows name it (demo-dataset.ts,
  // buildDemoSceneRowScripts).
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const rowRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/scene-rows/')) rowRequests.push(request.url()); });
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  expect(rowRequests).toEqual([]);

  await gotoScene(page, { view: 'task-mcp', embed: '1', still: '1' });
  await SCENE_MARKERS['task-mcp'](page);
  expect(rowRequests).toHaveLength(1);
  expect(rowRequests[0]).toMatch(new RegExp(`/scene-rows/${TASK_VALIDATE}-[0-9a-f]{8}\\.js$`));
  expect(getUnexpectedErrors()).toEqual([]);
});

test('lucide\'s whole icon map is a lazy chunk that no board or MCP frame fetches, and the icon picker does', async ({ page }) => {
  // The map loads only when the icon picker opens or a column names an icon outside the core set
  // (src/renderer/utils/icon-registry.ts). Eager, it was 2.3 MB of a page's first frame and 0.8 MB of
  // each frame after it. The sample install names only core icons, so no scene but a picker needs it.
  const catalogChunks = readdirSync(path.join(DIST_DIR, 'assets')).filter((name) => /^icon-catalog-[\w-]+\.js$/.test(name));
  expect(catalogChunks, 'the build emits the icon map as one chunk of its own').toHaveLength(1);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const catalogRequests: string[] = [];
  page.on('request', (request) => { if (/\/icon-catalog-[^/]*\.js$/.test(new URL(request.url()).pathname)) catalogRequests.push(request.url()); });
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  await gotoScene(page, { view: 'board', embed: '1', loop: '1' });
  await SCENE_MARKERS.board(page);
  await gotoScene(page, { view: 'task-mcp', embed: '1', still: '1' });
  await SCENE_MARKERS['task-mcp'](page);
  expect(catalogRequests).toEqual([]);

  // The positive half, so the match above cannot pass by never matching: the picker fetches it once.
  await gotoScene(page, { view: 'edit-columns', embed: '1', still: '1' });
  await page.locator('[data-testid="board-manager-icon"]').click();
  await expect(page.getByRole('button', { name: 'Ferris Wheel' })).toBeVisible();
  expect(catalogRequests).toHaveLength(1);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a scene-only row whose script does not load refuses the frame by name rather than booting without it', async ({ page }) => {
  await page.route('**/scene-rows/*', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' }));
  await page.goto(demoUrl({ view: 'task-mcp', embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText(`The recorded sessions of the scene-only task "${TASK_VALIDATE}" did not load.`);
  // Nothing was seeded, as for every other refusal: applyScene returns before __demoApplyFixture.
  await expect(page.locator('[data-swimlane-name]')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');
});

test('a recorded Send\'s rest frame loads once, on the frame whose scene shows its session finished, and never on a board', async ({ page }) => {
  // The frame is the size of a whole conversation, so it rides in its own script rather than the
  // seed every frame loads (demo-dataset.ts, buildDemoSendFrameScripts).
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const frameRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/send-frames/')) frameRequests.push(request.url()); });
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  expect(frameRequests).toEqual([]);

  await gotoScene(page, { view: 'browser', embed: '1', still: '1' });
  expect(frameRequests).toHaveLength(1);
  expect(frameRequests[0]).toMatch(new RegExp(`/send-frames/${SESSION_MIDDLEWARE}-[0-9a-f]{8}\\.js$`));
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a recorded Send whose rest frame does not load refuses the frame by name rather than booting without it', async ({ page }) => {
  await page.route('**/send-frames/*', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' }));
  await page.goto(demoUrl({ view: 'browser', embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText(`The frame the session "${SESSION_MIDDLEWARE}" rests on before its recorded Send did not load.`);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');
});

// ---- what the seed answers the Knowledge Graph with ------------------------------------------
// The test above proves WHEN the maps are read. These prove what each answer is, which ids are left
// to the mock, and what a failed read leaves behind (demo-dataset.ts, seededKnowledgeGraph).

interface DemoKnowledgeGraphRow { id: string; name: string; conversations: number; taskRecords: number; lastActivityMs: number | null }
interface DemoKnowledgeGraphSnapshot { projectId: string; projection: { nodes: Array<{ sessionId: string }> } }
interface DemoKnowledgeGraphWindow {
  electronAPI: {
    knowledgeGraph: {
      graphSnapshot: (projectId: string | null) => Promise<DemoKnowledgeGraphSnapshot | null>;
      graphProjects: () => Promise<DemoKnowledgeGraphRow[]>;
    };
  };
  /** The mock's own recorders: bumped only when the mock's original answers, never by the seed's override. */
  __mockGraphSnapshotCalls?: Array<{ projectId: string | null }>;
  __mockGraphProjectsCalls?: number;
}

/** An id the sample install does not have, so the seed leaves it to the mock. */
const UNKNOWN_PROJECT_ID = 'proj-not-in-the-sample-install';

function knowledgeGraphFixtureOf(projectId: string): (typeof DEMO_KNOWLEDGE_GRAPH.projects)[string] {
  const fixture = DEMO_KNOWLEDGE_GRAPH.projects[projectId];
  if (!fixture) throw new Error(`the Knowledge Graph fixture has no project ${projectId}`);
  return fixture;
}

/** What the fixture's index counts for one corpus of one project: the figure the picker row must show. */
function indexedDocumentCount(projectId: string, corpus: 'conversation' | 'task'): number {
  const entry = knowledgeGraphFixtureOf(projectId).index.corpora.find((candidate) => candidate.corpus === corpus);
  if (!entry) throw new Error(`the fixture's index for ${projectId} has no ${corpus} corpus`);
  return entry.documents;
}

/**
 * Count every request for the Knowledge Graph's maps, and answer the first `failFirstRequests` of them
 * with a 500. A route rather than a request listener, because Playwright keeps the HTTP cache off
 * while one is installed: a second read the browser could have served from cache is still counted.
 * Install it BEFORE navigating.
 */
async function routeKnowledgeGraphFile(page: Page, failFirstRequests = 0): Promise<() => string[]> {
  const requestedUrls: string[] = [];
  await page.route('**/graph/knowledge-graph-*.json', (route) => {
    requestedUrls.push(route.request().url());
    if (requestedUrls.length <= failFirstRequests) return route.fulfill({ status: 500, contentType: 'text/plain', body: 'unavailable' });
    return route.continue();
  });
  return () => requestedUrls.slice();
}

test('an id the sample install does not have is left to the mock and reads no map', async ({ page }) => {
  const getGraphRequests = await routeKnowledgeGraphFile(page);
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  const snapshotCallsBefore = await page.evaluate(() => (window as unknown as DemoKnowledgeGraphWindow).__mockGraphSnapshotCalls?.length ?? 0);

  const answers = await page.evaluate(async (unknownProjectId) => {
    const api = (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph;
    return { none: await api.graphSnapshot(null), unknown: await api.graphSnapshot(unknownProjectId) };
  }, UNKNOWN_PROJECT_ID);
  expect(answers).toEqual({ none: null, unknown: null });
  expect(getGraphRequests(), 'a snapshot of no project, or of one that is not here, must not read the maps').toEqual([]);

  // The mock's own recorder heard both asks, so each went to the mock's original rather than being
  // answered by the override with a null of its own.
  const handedToMock = await page.evaluate((from) => (window as unknown as DemoKnowledgeGraphWindow).__mockGraphSnapshotCalls?.slice(from) ?? [], snapshotCallsBefore);
  expect(handedToMock).toEqual([{ projectId: null }, { projectId: UNKNOWN_PROJECT_ID }]);

  // Positive control, same page: a project the install has DOES read them, so the silence above
  // is the guard working and not a counter that never counts.
  const known = await page.evaluate((projectId) => (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph.graphSnapshot(projectId), PROJECT_CONTOSO);
  expect(known?.projectId).toBe(PROJECT_CONTOSO);
  expect(getGraphRequests()).toHaveLength(1);
});

test('a project of the sample install is answered with its own map, and every ask gets its own copy', async ({ page }) => {
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  const projectIds = DEMO_PROJECTS.map((project) => project.id);

  const answers = await page.evaluate(async (ids) => {
    const api = (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph;
    const collected = [];
    for (const projectId of ids) {
      const first = await api.graphSnapshot(projectId);
      const second = await api.graphSnapshot(projectId);
      const sameObject = first === second;
      const sameContent = JSON.stringify(first) === JSON.stringify(second);
      // A reader that edits what it was handed edits nothing the next ask reads.
      if (first) first.projection.nodes.length = 0;
      const third = await api.graphSnapshot(projectId);
      collected.push({
        projectId,
        answeredProjectId: first?.projectId ?? null,
        nodeSessionIds: second?.projection.nodes.map((node) => node.sessionId) ?? null,
        sameObject,
        sameContent,
        nodesAfterAnEdit: third?.projection.nodes.length ?? null,
      });
    }
    return collected;
  }, projectIds);

  expect(answers).toHaveLength(projectIds.length);
  for (const answer of answers) {
    const expectedSessionIds = knowledgeGraphFixtureOf(answer.projectId).projection.nodes.map((node) => node.sessionId);
    expect(expectedSessionIds.length, `${answer.projectId}'s fixture draws no conversation`).toBeGreaterThan(0);
    expect(answer.answeredProjectId, `${answer.projectId} was answered with another project's snapshot`).toBe(answer.projectId);
    expect(answer.nodeSessionIds, `${answer.projectId}'s nodes are not its fixture's`).toEqual(expectedSessionIds);
    expect(answer.sameContent, `${answer.projectId}'s two asks differ`).toBe(true);
    expect(answer.sameObject, `${answer.projectId}'s two asks share one object`).toBe(false);
    expect(answer.nodesAfterAnEdit, `an edit to ${answer.projectId}'s answer leaked into the next ask`).toBe(expectedSessionIds.length);
  }
});

test('a failed read of the maps rejects with its status, and the next ask reads them again', async ({ page }) => {
  const getGraphRequests = await routeKnowledgeGraphFile(page, 1);
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);

  const outcomes = await page.evaluate(async (projectId) => {
    const api = (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph;
    const settle = (ask: Promise<DemoKnowledgeGraphSnapshot | null>) => ask.then(
      (snapshot) => ({ rejection: null, projectId: snapshot?.projectId ?? null }),
      (error: Error) => ({ rejection: error.message, projectId: null }),
    );
    const first = await settle(api.graphSnapshot(projectId));
    const second = await settle(api.graphSnapshot(projectId));
    return { first, second };
  }, PROJECT_CONTOSO);

  expect(outcomes.first.rejection, 'the first ask should name the failing status').toContain('returned 500');
  expect(outcomes.second, 'the failure was kept, so the next ask never tried again').toEqual({ rejection: null, projectId: PROJECT_CONTOSO });
  expect(getGraphRequests()).toHaveLength(2);
});

test('the snapshot and the picker asked together share one read of the maps', async ({ page }) => {
  const getGraphRequests = await routeKnowledgeGraphFile(page);
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);
  expect(getGraphRequests()).toEqual([]);

  const answers = await page.evaluate(async (projectId) => {
    const api = (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph;
    const [snapshot, projects] = await Promise.all([api.graphSnapshot(projectId), api.graphProjects()]);
    return { snapshotProjectId: snapshot?.projectId ?? null, rowIds: projects.map((row) => row.id) };
  }, PROJECT_CONTOSO);

  expect(answers.snapshotProjectId).toBe(PROJECT_CONTOSO);
  expect(answers.rowIds).toHaveLength(DEMO_PROJECTS.length);
  expect(getGraphRequests(), 'two asks in flight at once must not each fetch the maps').toHaveLength(1);
});

test('the Projects picker lists one row per project of the sample install, counted from the fixture', async ({ page }) => {
  await gotoScene(page, { view: 'board', embed: '1', still: '1' });
  await SCENE_MARKERS.board(page);

  const { rows, rowsAfterAnEdit } = await page.evaluate(async () => {
    const api = (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph;
    const asked = await api.graphProjects();
    const snapshotOfAsked = JSON.stringify(asked);
    // A reader that edits what it was handed edits nothing the next ask reads.
    asked[0].name = 'edited';
    asked.length = 0;
    return { rows: JSON.parse(snapshotOfAsked) as DemoKnowledgeGraphRow[], rowsAfterAnEdit: await api.graphProjects() };
  });

  expect(rows.map((row) => row.id).sort()).toEqual(DEMO_PROJECTS.map((project) => project.id).sort());
  for (const project of DEMO_PROJECTS) {
    const row = rows.find((candidate) => candidate.id === project.id);
    if (!row) throw new Error(`no picker row for ${project.id}`);
    expect(row.name).toBe(project.name);
    expect(row.conversations, `${project.name} conversations`).toBe(indexedDocumentCount(project.id, 'conversation'));
    expect(row.taskRecords, `${project.name} task records`).toBe(indexedDocumentCount(project.id, 'task'));
    expect(row.conversations, `${project.name} has no conversation to count`).toBeGreaterThan(0);
    expect(typeof row.lastActivityMs, `${project.name} shows no last activity`).toBe('number');
  }
  expect(rowsAfterAnEdit, 'an edit to the picker rows leaked into the next ask').toEqual(rows);
});

test('an empty install keeps the mock\'s empty Knowledge Graph answers and reads no map', async ({ page }) => {
  const getGraphRequests = await routeKnowledgeGraphFile(page);
  await gotoScene(page, { view: 'welcome', embed: '1', still: '1' });
  await expect(page.locator(SCENES.welcome.ready)).toBeVisible();
  const countsBefore = await page.evaluate(() => {
    const demoWindow = window as unknown as DemoKnowledgeGraphWindow;
    return { snapshots: demoWindow.__mockGraphSnapshotCalls?.length ?? 0, projects: demoWindow.__mockGraphProjectsCalls ?? 0 };
  });

  const answers = await page.evaluate(async (projectId) => {
    const api = (window as unknown as DemoKnowledgeGraphWindow).electronAPI.knowledgeGraph;
    // A project the sample install has: with nothing seeded here it must not draw.
    return { projects: await api.graphProjects(), snapshot: await api.graphSnapshot(projectId) };
  }, PROJECT_CONTOSO);
  expect(answers).toEqual({ projects: [], snapshot: null });
  expect(getGraphRequests()).toEqual([]);

  // Both reached the mock's own methods: its recorders moved, which the seed's override never does.
  const countsAfter = await page.evaluate(() => {
    const demoWindow = window as unknown as DemoKnowledgeGraphWindow;
    return { snapshots: demoWindow.__mockGraphSnapshotCalls?.length ?? 0, projects: demoWindow.__mockGraphProjectsCalls ?? 0 };
  });
  expect(countsAfter).toEqual({ snapshots: countsBefore.snapshots + 1, projects: countsBefore.projects + 1 });
});

/** Each row of a painted frame in cells: the text between the autowrap brackets, plus its cursor-forward gaps. */
function frameRowWidths(frame: string): number[] {
  const start = frame.indexOf('\x1b[?7l');
  const end = frame.lastIndexOf('\x1b[?7h');
  if (start === -1 || end === -1 || end < start) return [];
  return frame.slice(start + 5, end).split('\r\n').map((row) => {
    const text = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const gaps = (row.match(/\x1b\[(\d*)C/g) ?? []).reduce((sum, move) => sum + Number(move.replace(/\D/g, '') || '1'), 0);
    return Array.from(text).length + gaps;
  });
}

test('a still terminal narrower than its recording and not held paints the open frame cut to its grid', async ({ page }) => {
  // The probe that found the gap: the changes scene with the divider at a quarter of the width
  // leaves the terminal well below the hold floor, so the still paints its recording's opening
  // frame into a grid the frame's rows are wider than. Raw, every row wrapped mid-word; fitted,
  // each is cut at the edge the way the live frame's applier cuts it.
  const getRecordingRequests = recordingRequests(page);
  const narrow = { tasks: [{ id: 'task-cw-middleware', detail_view_state: JSON.stringify({ changesOpen: true, changesViewMode: 'split', changesSelectedFile: 'server/routes.ts', changesScope: 'branch', dividerRatio: 0.25 }) }] };
  await gotoScene(page, { view: 'changes', embed: '1', still: '1', state: encodeState(narrow) });
  await SCENE_MARKERS.changes(page);
  const grid = await mountedGrid(page, 'sess-cw-middleware');
  expect(grid).not.toBeNull();
  // Narrower than either layout's recording and past the hold floor, so the terminal kept its own grid.
  expect((grid as Grid).cols).toBeLessThan(MIDDLEWARE_TILED_GRID.cols * 0.6);
  const painted = await page.evaluate(() => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback('sess-cw-middleware'));
  const widths = frameRowWidths(painted);
  expect(widths.length, 'the still was handed over without the autowrap bracket').toBeGreaterThan(0);
  expect(Math.max(...widths)).toBe((grid as Grid).cols);
  expect(getRecordingRequests()).toEqual([]);
});

test('the conversation scene shows the transcript recorded beside the middleware session', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  const transcriptRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/transcripts/')) transcriptRequests.push(request.url()); });
  await gotoScene(page, { view: 'conversation', embed: '1', still: '1' });
  await expect(page.locator('[data-testid="conversation-window"]')).toBeVisible();
  await expect(page.locator('[data-testid="conversation-title"]')).toContainText('Extract auth middleware');
  // Rendered from the transcript, not the mock's empty default. The viewer follows a running
  // session to its newest turn, so what is on screen is the agent's closing message: the same
  // line the recording's trail ends on (tests/unit/demo-transcript-seeded.test.ts ties the two).
  await expect(page.locator('[data-testid="conversation-row-assistant"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="conversation-view"]')).toContainText('Typecheck is clean and the suite passes');
  await expect(page.locator('[data-testid="conversation-empty"]')).toHaveCount(0);
  // The transcript is its own lazy asset: one fetch for the viewer, none of the recordings.
  expect(transcriptRequests).toHaveLength(1);
  const transcript = await (await page.request.get(transcriptRequests[0])).json() as { entries?: unknown[] };
  expect(Array.isArray(transcript.entries) && transcript.entries.length > 10).toBe(true);
  expect(getRecordingRequests()).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the tiled task windows take each session\'s tiled recording, fill their panes, on the session\'s own clock', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'windows-tiled', embed: '1' });
  const tiledSessions = [['sess-cw-middleware', 'contoso-web-claude-middleware'], ['sess-cw-api-client', 'contoso-web-claude-api-client']] as const;
  // A variant is a second run with its own length, played from the moment the SESSION's clock
  // began, and the clock stays the single recording's. A tiled window therefore opens partway
  // into the variant (or after it ended, as api-client's does) and the session goes on working
  // for the stretch its single recording has left. Re-basing the clock on the variant used to
  // finish the session the moment its window opened, which CI's Linux runner caught (its fonts
  // put the 125 percent display on the tiled layout too). Both are read as the windows mount,
  // before any replay check: api-client's own stretch is 25 s, so it finishes on its clock soon after.
  for (const [sessionId] of tiledSessions) {
    expect((await monitorRow(page, sessionId))?.activity, `${sessionId} finished when its tiled window opened`).toBe('thinking');
  }
  for (const [sessionId, fileStem] of tiledSessions) {
    await expect.poll(() => sentGrids(page, sessionId), { timeout: 10_000 }).not.toHaveLength(0);
    // A tiled pane is within about eight columns either side of the tiled recording's 115 on every
    // platform (123 at 100 percent on Windows, 107 on this runner's Liberation Mono), and the tiled
    // recording shows it at a larger type than the single one could (layoutFor).
    await expectFaithfulReplay(page, sessionId);
    await expect.poll(() => getRecordingRequests().some((url) => url.includes(`/recordings/${fileStem}-tiled-`)), { timeout: 15_000 }).toBe(true);
    expect(getRecordingRequests().some((url) => url.includes(`/recordings/${fileStem}-`) && !url.includes('-tiled-'))).toBe(false);
  }
  await expectPanesFilled(page, 'windows-tiled');
  expect(getUnexpectedErrors()).toEqual([]);
});

// The floating terminal scenes size their window to the recording at the visitor's own cell
// (FITTED_FLOATING_GEOMETRY in scenes.ts, fitLayoutBlob in demo-dataset.ts), so the terminal takes
// exactly the recording's columns and fills its pane at native type on every display. At a fixed
// 0.64 of the frame it did not: at 100 percent the 6.0 px Consolas cell fitted 170 columns and left
// about 100px empty on the right, and at a 7.0 px cell (Liberation Mono on this runner, where the
// release posters are shot) the window fitted 146, took the 115-column tiled recording, and left a
// fifth of the pane empty. Each scale here rounds the cell to device pixels differently (6.0, 6.4,
// 6.5 CSS px for Consolas), which is what a fixed fraction cannot follow.
for (const deviceScaleFactor of [1, 1.25, 2]) {
  test(`a floating terminal window fits its recording's columns at device scale ${deviceScaleFactor}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor });
    try {
      for (const scene of FITTED_WINDOW_SCENES) {
        const page = await context.newPage();
        const getUnexpectedErrors = collectUnexpectedErrors(page);
        await expectFittedToRecording(page, scene, `${scene.view} at scale ${deviceScaleFactor}`);
        await expectPanesFilled(page, `${scene.view} at scale ${deviceScaleFactor}`);
        expect(getUnexpectedErrors()).toEqual([]);
        await page.close();
      }
    } finally {
      await context.close();
    }
  });
}

// Every scene with a terminal in it, at the display scales a visitor has: the terminal fills its
// pane, wider or narrower than its recording, taller or shorter. Before the fill, the Browser
// scene's terminal left 314px below it at 100 percent, the tiled windows 52px beside them, and
// the Changes scene 300px below at 125. A still fills too, since the posters are stills, shot at
// twice scale; this runner's Liberation Mono is the face whose heights round unevenly, the case
// the renderer's conform used to stop short on.
const TERMINAL_SCENES = ['task', 'windows-tiled', 'browser', 'changes', 'command-terminal', 'command-terminal-tiled', 'board', 'task-mcp'] as const;
for (const [deviceScaleFactor, still] of [[1, false], [1.25, false], [2, false], [2, true]] as const) {
  test(`every terminal scene fills its panes at device scale ${deviceScaleFactor}${still ? ', as a still' : ''}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor });
    try {
      for (const view of TERMINAL_SCENES) {
        const page = await context.newPage();
        const getUnexpectedErrors = collectUnexpectedErrors(page);
        await gotoScene(page, { view, embed: '1', ...(still ? { still: '1' } : {}) });
        await expectPanesFilled(page, `${view} at scale ${deviceScaleFactor}${still ? ' (still)' : ''}`);
        expect(getUnexpectedErrors()).toEqual([]);
        await page.close();
      }
    } finally {
      await context.close();
    }
  });
}

test('a card opened on a desktop browser at 100 percent replays its terminal on the grid the terminal has', async () => {
  // A desktop browser reserves the app's 8px scrollbar gutter, which leaves the default task
  // window a column short of a 154-column recording on Consolas. The seed used to hold that pane
  // anyway; the conform declined (four quarter-pixel font steps cannot move a 6px cell to 5), the
  // terminal kept its own 153 columns, and the bytes it was sent addressed 154: every padded row
  // wrapped into a blank one and Copilot's right-edge scrollbar landed in column zero. A near
  // miss now plays frames at the pane's grid, and anything held has to land. Copilot and Claude,
  // the two renderers the report showed, opened the way a visitor opens them: a click on the card.
  test.setTimeout(120_000);
  const browserWithScrollbars = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const context = await browserWithScrollbars.newContext({ viewport: { width: 1600, height: 1000 } });
    for (const [taskId, sessionId] of [['task-cw-rate-limit', SESSION_RATE_LIMIT], [TASK_MIDDLEWARE, SESSION_MIDDLEWARE]] as const) {
      const page = await context.newPage();
      const getUnexpectedErrors = collectUnexpectedErrors(page);
      await gotoScene(page, { view: 'board', embed: '1' });
      await page.locator(`[data-task-id="${taskId}"]`).first().click();
      await expect(page.locator('[data-testid^="window-frame-"] .xterm-screen')).toBeVisible({ timeout: 15_000 });
      await expectFaithfulReplay(page, sessionId);
      await expectPanesFilled(page, `${taskId} at 100 percent`);
      expect(getUnexpectedErrors()).toEqual([]);
      await page.close();
    }
  } finally {
    await browserWithScrollbars.close();
  }
});

test('a window one column short of its recording plays frames at its own grid rather than holding', async ({ browser }) => {
  // The case above reaches one column short only on Windows' Consolas; this runner's Liberation
  // Mono floors to a wider cell, the default window fits far fewer columns, and the pane holds.
  // So this builds the near miss on any font: the fitted window, one cell narrower. The fit leaves
  // half a cell of slack, so that floors to exactly one column under the recording. Smaller type
  // is not worth a column (NEAR_MISS_COLUMNS in demo-dataset.ts), so the seed plays frames at the
  // pane's grid at the configured type, with nothing held.
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    const fittedPage = await context.newPage();
    await expectFittedToRecording(fittedPage, FITTED_WINDOW_SCENES[0], 'the fitted task window');
    const fitted = await fittedPage.evaluate(async (taskId) => {
      // The stored workspace, which the seed rewrote with the fitted rect on the renderer's first read.
      const api = (window as unknown as { electronAPI: { config: { getGlobal: () => Promise<{
        workspaceByProject: Record<string, { windows: Array<{ taskId: string; geometry: WindowGeometry }> }>;
      }> } } }).electronAPI;
      const config = await api.config.getGlobal();
      const managedWindow = config.workspaceByProject['proj-contoso-web'].windows.find((candidate) => candidate.taskId === taskId);
      const screen = document.querySelector<HTMLElement>('[data-testid="task-detail-dialog"] .xterm-screen');
      return { geometry: managedWindow?.geometry ?? null, screenWidth: screen ? screen.getBoundingClientRect().width : null };
    }, TASK_MIDDLEWARE);
    await fittedPage.close();
    expect(fitted.geometry, 'the fitted window geometry').not.toBeNull();
    expect(fitted.screenWidth, 'the fitted terminal screen').not.toBeNull();
    const cellWidth = (fitted.screenWidth ?? 0) / MIDDLEWARE_RECORDED_GRID.cols;
    const fittedGeometry = fitted.geometry as WindowGeometry;
    const width = fittedGeometry.w - cellWidth / 1600;
    const shortGeometry: WindowGeometry = { x: (1 - width) / 2, y: fittedGeometry.y, w: width, h: fittedGeometry.h };

    const page = await context.newPage();
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await gotoScene(page, { view: 'task', embed: '1', state: encodeState(floatingWindowState(TASK_MIDDLEWARE, 'Extract auth middleware', shortGeometry)) });
    // Not vacuous: the pane really is one column short, with the recording's rows to spare.
    await expect.poll(async () => (await naturalGrid(page, SESSION_MIDDLEWARE))?.cols, { timeout: 10_000, message: 'the narrowed window\'s terminal columns' })
      .toBe(MIDDLEWARE_RECORDED_GRID.cols - 1);
    expect((await naturalGrid(page, SESSION_MIDDLEWARE))?.rows ?? 0).toBeGreaterThanOrEqual(MIDDLEWARE_RECORDED_GRID.rows);
    await expect.poll(() => replayState(page, SESSION_MIDDLEWARE), { timeout: 15_000, message: 'a near miss was held rather than left on frames' })
      .toEqual({ mode: 'frames', held: null });
    expect(getUnexpectedErrors()).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a floating terminal window fits its recording with the scrollbar gutter a desktop browser reserves', async () => {
  // Headless Chromium hides scrollbars, so every other case here measures a zero gutter. A browser
  // on Windows reserves the app's 8px (index.css), and the fitted width has to carry it or the
  // window lands a column short. The seed measures the gutter the way fit-addon.ts does; this is
  // the one launch that exercises that measurement with a gutter to measure.
  test.setTimeout(120_000);
  const browserWithScrollbars = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const context = await browserWithScrollbars.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    const scene = FITTED_WINDOW_SCENES[0];
    await expectFittedToRecording(page, scene, 'task with visible scrollbars');
    // Not vacuous: the gutter this case exists for is really there.
    const gutter = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="task-detail-dialog"] .xterm-viewport');
      return viewport ? viewport.offsetWidth - viewport.clientWidth : null;
    });
    expect(gutter).toBeGreaterThan(0);
    expect(getUnexpectedErrors()).toEqual([]);
  } finally {
    await browserWithScrollbars.close();
  }
});

test('a still paints a working session at the moment the live frame opens it', async ({ page }) => {
  // The auth-middleware recording ran until Claude finished. The live frame opens it 90 seconds
  // before that end and streams the rest; a still paints that same moment (the open frame the
  // capture script kept beside the end), so both read working and neither shows the finished
  // answer at first. The flaky-test recording was cut mid-work, shorter than the tail, so its
  // still is its end and it reads working too.
  const readFrames = () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const demo = window as unknown as DemoRecordingsWindow;
    const endFrameOf = async (id: string) => ((await (await fetch(demo.__demoRecordings.base + demo.__demoRecordings.sessions[id].file)).json()) as { serialized: string }).serialized;
    return {
      activity: await api.sessions.getActivity(),
      middlewareSeeded: demo.__demoScrollback['sess-cw-middleware'].length,
      middlewareIsEnd: demo.__demoScrollback['sess-cw-middleware'] === await endFrameOf('sess-cw-middleware'),
      flakyIsEnd: demo.__demoScrollback['sess-pc-flaky-tests'] === await endFrameOf('sess-pc-flaky-tests'),
    };
  });
  await gotoScene(page, { view: 'board', still: '1' });
  await SCENE_MARKERS.board(page);
  const still = await readFrames();
  expect(still.activity['sess-cw-middleware']).toBe('thinking');
  expect(still.activity['sess-pc-flaky-tests']).toBe('thinking');
  expect(still.middlewareSeeded).toBeGreaterThan(0);
  expect(still.middlewareIsEnd).toBe(false);
  expect(still.flakyIsEnd).toBe(true);
  await gotoScene(page, { view: 'board' });
  await SCENE_MARKERS.board(page);
  const live = await readFrames();
  expect(live.activity['sess-cw-middleware']).toBe('thinking');
  expect(live.activity['sess-pc-flaky-tests']).toBe('thinking');
});

test('a live Monitor changes its output peeks as the recordings play, and a still does not', async ({ page }) => {
  // A Monitor row carries the last lines its session's terminal is displaying, and on the desktop
  // those change as the agent works. The frame schedules the recording's own changes on the same
  // clock it replays the bytes on, so the row moves without a terminal being open anywhere. A
  // still has no clock, so its rows must sit exactly where the seed put them: a capture that
  // shot a moving target would give the hero figures a different Monitor every run.
  //
  // This reads the ROW STATE the mock publishes, not the rendered card. Since the Card Preview
  // default is agent-latest-message, a card whose session has a message trail draws the trail and
  // never the peek (MonitorBody drops it from the wanted set); only a session with no trail draws
  // a peek. The card side of both is asserted in the message-trail test below.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'monitor', embed: '1' });
  await SCENE_MARKERS.monitor(page);
  expect(await countPeekChanges(page, 'sess-cw-api-client', 12_000)).toBeGreaterThan(1);

  await gotoScene(page, { view: 'monitor', embed: '1', still: '1' });
  await SCENE_MARKERS.monitor(page);
  expect(await countPeekChanges(page, 'sess-cw-api-client', 6_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('cards show the agent message trail the recordings carry, and it moves on the session clock', async ({ page }) => {
  // The Card Preview default is agent-latest-message, so a default install prints the agent's
  // newest message where the description used to be. The demo seeds that from each recording's own
  // transcript, on the recording's own clock, so a visitor sees what an install does. Before the
  // trails were seeded every card here fell back to its description and the demo silently showed
  // behaviour no install produces.
  //
  // Three scene loads plus a 60s poll, so the worst case is around 85s. 90s left barely ten
  // seconds of margin, and CI's runner boots the bundle slower than this machine does.
  test.setTimeout(120_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board' });
  await SCENE_MARKERS.board(page);

  // A board card with a trail draws it INSTEAD of the description, which is the whole change.
  const middlewareCard = page.locator('[data-task-id="task-cw-middleware"]').first();
  await expect(middlewareCard.getByTestId('task-card-trail')).toBeVisible();
  await expect(middlewareCard.getByTestId('task-card-description')).toHaveCount(0);
  const seededLine = (await middlewareCard.getByTestId('task-card-trail').innerText()).trim();
  expect(seededLine.length).toBeGreaterThan(0);

  // The snapshot backs the seed, which is what makes it durable: syncSessions reconciles the store
  // against getMessageTrails(), so a trail only pushed would be dropped on the next re-sync.
  const snapshotSessions = await page.evaluate(async () => {
    const api = (window as unknown as { electronAPI: { sessions: { getMessageTrails?: () => Promise<Record<string, unknown[]>> } } }).electronAPI;
    const trails = (await api.sessions.getMessageTrails?.()) ?? {};
    return Object.entries(trails).filter(([, entries]) => entries.length > 0).map(([id]) => id);
  });
  expect(snapshotSessions).toContain('sess-cw-middleware');

  // On the Monitor, the same session draws the trail and NOT the output peek, because MonitorBody
  // stops asking for a peek once a row has one. A session whose agent has no transcript at all
  // (Copilot here) still draws its peek, which is what the desktop does.
  await gotoScene(page, { view: 'monitor', embed: '1' });
  await SCENE_MARKERS.monitor(page);
  // Scoped to the card: a session's id is also on its terminal tab in the board's bottom panel,
  // which sits earlier in the document, so an unscoped data-session-id lands on the tab.
  const trailCard = page.locator('[data-testid="monitor-card"][data-session-id="sess-cw-api-client"]');
  await expect(trailCard.getByTestId('monitor-card-trail')).toBeVisible();
  await expect(trailCard.getByTestId('monitor-card-peek')).toHaveCount(0);
  const peekCard = page.locator('[data-testid="monitor-card"][data-session-id="sess-ob-currency-a11y"]');
  await expect(peekCard.getByTestId('monitor-card-peek')).toBeVisible();
  await expect(peekCard.getByTestId('monitor-card-trail')).toHaveCount(0);

  // The api-client recording carries one more line after the moment its live frame opens (its
  // "Done." summary, about 24 s in), so the card changes while the visitor watches, on the same
  // clock the terminal replays on. Polled for
  // the change rather than counted over a fixed span: the clock's offsets are the recording's, but
  // when it starts relative to the page rides on how long the bundle takes to boot.
  const openingLine = await readTrail(page, 'sess-cw-api-client');
  expect(openingLine.length).toBeGreaterThan(0);
  await expect.poll(() => readTrail(page, 'sess-cw-api-client'), { timeout: 60_000 }).not.toBe(openingLine);

  // A still arms no timer, so it holds the line the seed put there.
  await gotoScene(page, { view: 'monitor', embed: '1', still: '1' });
  await SCENE_MARKERS.monitor(page);
  expect(await countTrailChanges(page, 'sess-cw-api-client', 6_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('loop=1 starts a finished session over, and without it the session stays finished', async ({ page }) => {
  // The currency-a11y recording runs 20 seconds and ends with Copilot idle, so it is the one
  // session that completes a whole cycle inside a test. Under loop=1 it goes back to working
  // after a beat; without it, needs-you is where it stays.
  test.setTimeout(120_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const session = 'sess-ob-currency-a11y';

  await gotoScene(page, { view: 'monitor', embed: '1', loop: '1' });
  await SCENE_MARKERS.monitor(page);
  expect((await monitorRow(page, session))?.activity).toBe('thinking');
  await expect.poll(async () => (await monitorRow(page, session))?.activity, { timeout: 45_000 }).toBe('idle');
  await expect.poll(async () => (await monitorRow(page, session))?.activity, { timeout: 30_000 }).toBe('thinking');

  await gotoScene(page, { view: 'monitor', embed: '1' });
  await SCENE_MARKERS.monitor(page);
  await expect.poll(async () => (await monitorRow(page, session))?.activity, { timeout: 45_000 }).toBe('idle');
  // Well past the loop's pause: a frame that was not asked to loop must stay put.
  await page.waitForTimeout(12_000);
  expect((await monitorRow(page, session))?.activity).toBe('idle');
  expect(getUnexpectedErrors()).toEqual([]);
});

/** The column a board card sits in, by its name, or null when the board does not draw it. */
function laneOfCard(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const card = document.querySelector(`[data-swimlane-name] [data-task-id="${id}"]`);
    return card?.closest('[data-swimlane-name]')?.getAttribute('data-swimlane-name') ?? null;
  }, taskId);
}

test('task-mcp plays its kangentic_* calls through to the move, and loop=1 opens them again', async ({ page }) => {
  // The still paints the moment the first three calls have printed (the scene marker holds that);
  // live, the session's clock runs on from there to kangentic_move_task, about eleven seconds, and
  // loop=1 starts the same stretch over after its pause. The Monitor peek follows the replay
  // whether or not the window's terminal shows it, so it is what this reads. The move is read by
  // its printed result, which holds from the recording's end until the loop restarts: the peek
  // naming kangentic_move_task itself lasts about a second, which a poll on a loaded runner can miss.
  test.setTimeout(120_000);
  const moveResult = 'Moving "Validate request bodies" (#68) to Testing';
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const peekOf = (): Promise<string> => page.evaluate((id) => {
    const row = ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
    return (row?.outputPeek ?? []).join(' | ');
  }, SESSION_VALIDATE);
  // The scene's timeline: when the move's result lands, the card moves as main moves it, and the
  // Monitor row's column follows; the loop's restart puts both back with the terminal.
  const validateLane = (): Promise<string | null> => laneOfCard(page, TASK_VALIDATE);
  await gotoScene(page, { view: 'task-mcp', embed: '1', loop: '1' });
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Validate request bodies');
  const opening = await peekOf();
  expect(opening, 'the session opens on the third call\'s result').toContain('Merge: no automations.');
  expect(opening, 'the session opens before the move').not.toContain(moveResult);
  expect(await validateLane(), 'the card opens in Code Review').toBe('Code Review');
  await expect.poll(peekOf, { timeout: 30_000, message: 'the replay reaches the move' }).toContain(moveResult);
  await expect.poll(validateLane, { timeout: 5_000, message: 'the move\'s result moves the card' }).toBe('Testing');
  await expect.poll(async () => (await monitorRow(page, SESSION_VALIDATE))?.columnName, { timeout: 5_000 }).toBe('Testing');
  await expect.poll(peekOf, { timeout: 40_000, message: 'loop=1 opens the calls again' }).toContain('Merge: no automations.');
  await expect.poll(validateLane, { timeout: 5_000, message: 'the restart puts the card back' }).toBe('Code Review');
  expect((await monitorRow(page, SESSION_VALIDATE))?.columnName).toBe('Code Review');
  expect((await monitorRow(page, SESSION_VALIDATE))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('without loop=1 the timeline still moves the card once, and nothing puts it back', async ({ page }) => {
  // The timeline rides the session's clock, which runs in every live frame; only the restart is
  // loop=1's. A still arms no clock, so its card stays in Code Review (the BOOTABLE loop's marker).
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'task-mcp', embed: '1' });
  // Every push main would send for an agent's move, counted from here on.
  await page.evaluate(() => {
    const target = window as unknown as { __mockFireTaskUpdatedByAgent?: (...args: unknown[]) => void; __agentMovePushes: number };
    const original = target.__mockFireTaskUpdatedByAgent;
    target.__agentMovePushes = 0;
    target.__mockFireTaskUpdatedByAgent = (...args: unknown[]) => {
      target.__agentMovePushes += 1;
      original?.(...args);
    };
  });
  const agentMovePushes = (): Promise<number> => page.evaluate(() => (window as unknown as { __agentMovePushes: number }).__agentMovePushes);
  const validateLane = (): Promise<string | null> => laneOfCard(page, TASK_VALIDATE);
  await expect.poll(validateLane, { timeout: 30_000 }).toBe('Testing');
  await expect.poll(agentMovePushes).toBe(1);
  // A terminal that mounts after the session's end asks for its scrollback, which schedules the
  // session's clock again, and the end lands at once. The move is main's, made once, so two more
  // mounts move nothing.
  for (let mount = 0; mount < 2; mount += 1) {
    await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), SESSION_VALIDATE);
  }
  await page.waitForTimeout(1_500);
  expect(await agentMovePushes()).toBe(1);
  expect(await validateLane()).toBe('Testing');
  expect(getUnexpectedErrors()).toEqual([]);
});

interface ActivitySnapshotWindow {
  electronAPI: {
    sessions: {
      getActivityStats: (sessionId: string) => Promise<{
        activity: string;
        msSinceLastSignal: number | null;
        recentTransitions: Array<{ to: string; trigger: string }>;
      } | null>;
    };
  };
}

test('the activity overlay\'s snapshot follows the session clock live, and a still keeps the seeded one', async ({ page }) => {
  // Main takes the snapshot when it is asked, so the time since a session's last signal counts up
  // between the overlay's polls, and a session whose recording ends is idle with the engine's
  // event:idle step logged. A still keeps what the seed built, so it is the same frame every time.
  test.setTimeout(90_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const snapshot = (): ReturnType<ActivitySnapshotWindow['electronAPI']['sessions']['getActivityStats']> => page.evaluate(
    (sessionId) => (window as unknown as ActivitySnapshotWindow).electronAPI.sessions.getActivityStats(sessionId),
    SESSION_API_CLIENT,
  );
  await page.clock.install();
  await gotoScene(page, { view: 'activity-overlay', embed: '1' });
  await expect(page.locator('[data-testid="activity-debug-overlay"]')).toBeVisible();
  const opening = await snapshot();
  expect(opening?.activity).toBe('thinking');
  await page.clock.fastForward(5_000);
  const later = await snapshot();
  expect((later?.msSinceLastSignal ?? 0) - (opening?.msSinceLastSignal ?? 0)).toBeGreaterThanOrEqual(4_000);
  // api-client's 25 s stretch ends and its turn with it.
  await page.clock.fastForward(22_000);
  await expect.poll(async () => (await snapshot())?.activity).toBe('idle');
  const finished = await snapshot();
  expect(finished?.recentTransitions.at(-1)).toMatchObject({ to: 'idle', trigger: 'event:idle' });

  await gotoScene(page, { view: 'activity-overlay', embed: '1', still: '1' });
  await expect(page.locator('[data-testid="activity-debug-overlay"]')).toBeVisible();
  const stillOpening = await snapshot();
  await page.clock.fastForward(5_000);
  expect((await snapshot())?.msSinceLastSignal).toBe(stillOpening?.msSinceLastSignal);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('workflows: the middleware step finishes its route, the engine starts Add user auth flow, and loop=1 undoes both', async ({ page }) => {
  // The step lands when the middleware session's recorded turn ends, 90 s after the frame opens,
  // so the test moves page time rather than waiting for it: Playwright's clock fires the session
  // clock's timers in their order, as real time would. Reduced motion holds the choreography at
  // rest, so no drag is in flight when time jumps.
  test.setTimeout(120_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await gotoScene(page, { view: 'workflows', embed: '1', loop: '1' });
  await SCENE_MARKERS.workflows(page);
  const view = page.locator('[data-testid="workflows-view"]');
  const currentStep = (taskId: string) => view.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${taskId}"] [data-step-state="current"]`);
  const links = (state: string) => view.locator(`path.react-flow__edge-path[data-link-state="${state}"]`);
  await expect(currentStep(TASK_MIDDLEWARE)).toHaveAttribute('aria-label', 'Executing: now');
  await expect(currentStep(TASK_AUTH)).toHaveAttribute('aria-label', 'To Do: now');

  await page.clock.fastForward(91_000);
  // Middleware is done (its route ended at Executing), which meets its two links; auth's only
  // blocker is done, so it starts in Planning. Refactor API error handling still waits on rate limiting.
  await expect(currentStep(TASK_MIDDLEWARE)).toHaveAttribute('aria-label', 'Done: now');
  await expect(links('satisfied')).toHaveCount(4);
  await expect(links('pending')).toHaveCount(1);
  await expect(currentStep(TASK_AUTH)).toHaveAttribute('aria-label', 'Planning: now');
  await expect.poll(() => page.evaluate(async (taskId) => {
    const sessions = await (window as unknown as DemoElectronWindow).electronAPI.sessions.list();
    return sessions.some((session) => session.taskId === taskId && session.status === 'running');
  }, TASK_AUTH), { message: 'the start runs auth\'s agent, from its recorded plan-mode boot' }).toBe(true);
  // A terminal that mounts after the end asks for its scrollback, which schedules the session's
  // clock again and lands its end at once. Main moved the cards once: a second run would move an
  // archived card that is no longer on the board, and stack a second undo for the restart.
  for (let mount = 0; mount < 2; mount += 1) {
    await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), SESSION_MIDDLEWARE);
  }
  await page.clock.fastForward(500);
  expect(getUnexpectedErrors(), 'a mount after the end runs no move again').toEqual([]);
  await expect(currentStep(TASK_AUTH)).toHaveAttribute('aria-label', 'Planning: now');

  // The restart pause, then the session starts its stretch over and the workflow is back where it opened.
  await page.clock.fastForward(7_000);
  await expect(currentStep(TASK_MIDDLEWARE)).toHaveAttribute('aria-label', 'Executing: now');
  await expect(currentStep(TASK_AUTH)).toHaveAttribute('aria-label', 'To Do: now');
  await expect(links('satisfied')).toHaveCount(2);
  await expect(links('pending')).toHaveCount(3);
  expect(getUnexpectedErrors()).toEqual([]);
});

// ---- choreography ------------------------------------------------------------------------------
// A scene's pointer steps, which the frame plays by itself under loop=1 (demo/choreography.ts).
// The tests divide its pacing (never its waitFor, which is the app's own timing) so a cycle fits.

/** The pacing divisor the choreography reads; set before any script runs. */
const CHOREOGRAPHY_TEST_RATE = 8;

/** The scenes that carry a choreography, and whether each plays a cycle (steps after its pose, or no pose). */
const CHOREOGRAPHED_SCENES = Object.values(SCENES)
  .filter((scene) => (scene.choreography ?? []).length > 0)
  .map((scene) => ({ scene, cycles: playsCycle(scene.choreography) }));

/** Set the choreography's pacing divisor before any of the page's scripts run. */
async function setChoreographyRate(page: Page, rate: number): Promise<void> {
  await page.addInitScript((divisor) => { (window as { __demoChoreographyRate?: number }).__demoChoreographyRate = divisor; }, rate);
}

test('the registry carries choreographies to play', () => {
  // Vacuity guard: the loop below would pass on an empty list. Every pose scene now plays on past
  // its pose, so the hold branch below waits for a scene that ends on one.
  expect(CHOREOGRAPHED_SCENES.filter((entry) => entry.cycles).length).toBeGreaterThan(0);
  expect(CHOREOGRAPHED_SCENES.some((entry) => (entry.scene.choreography ?? []).some((step) => 'pose' in step))).toBe(true);
});

/**
 * Whether a scene's cycle ends on a held drag (card-drag, window-dock): the pose follows a held
 * drag, and the cycle runs the steps after the pose and then the ones before it, so the last
 * thing it does is carry the drag to the pose and keep the button down.
 */
function endsOnHeldDrag(scene: (typeof CHOREOGRAPHED_SCENES)[number]['scene']): boolean {
  const steps = scene.choreography ?? [];
  const poseIndex = steps.findIndex((step) => 'pose' in step);
  const last = poseIndex > 0 ? steps[poseIndex - 1] : undefined;
  return last !== undefined && 'drag' in last && last.drag.hold === true;
}

for (const { scene, cycles } of CHOREOGRAPHED_SCENES) {
  test(`view=${scene.name} under loop=1 ${cycles ? 'plays a cycle back to rest' : 'holds its pose'} with a clean console`, async ({ page }) => {
    test.setTimeout(90_000);
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await setChoreographyRate(page, CHOREOGRAPHY_TEST_RATE);
    const readAtCycleEnd = cycles && endsOnHeldDrag(scene);
    if (readAtCycleEnd) {
      // A cycle that ends on a held drag goes straight on to its drop with no rest between, and the
      // drop hides what `ready` names (the snap preview is display:none a few milliseconds later,
      // and shows again only when the next cycle carries the drag back to the edge). So `ready` is
      // read where the cycle ends: the observer's callback runs in the task that flips the root to
      // rest with one cycle done, before the drop's timer. Read after the test's own round trips it
      // raced that drop, and passed only by catching the next cycle's re-arm inside the timeout.
      await page.addInitScript((readySelector) => {
        const holder = window as unknown as { __readyAtCycleEnd?: boolean };
        // Observed on the document, not its root: an init script runs before the root element exists.
        new MutationObserver(() => {
          const root = document.documentElement;
          if (holder.__readyAtCycleEnd !== undefined) return;
          if (root.getAttribute('data-demo-choreography') !== 'rest' || root.getAttribute('data-demo-cycles') !== '1') return;
          const element = document.querySelector(readySelector);
          const rect = element?.getBoundingClientRect();
          holder.__readyAtCycleEnd = element !== null && element !== undefined && rect !== undefined
            && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-demo-choreography'] });
      }, scene.ready);
    }
    await gotoScene(page, { view: scene.name, embed: '1', loop: '1' });
    const root = page.locator('html');
    if (cycles) {
      // A cycle that ends anywhere but rest logs an error and stops, which the console check catches.
      await expect(root).toHaveAttribute('data-demo-choreography', 'playing', { timeout: 15_000 });
      await expect(root).toHaveAttribute('data-demo-cycles', '1', { timeout: 60_000 });
      await expect(root).not.toHaveAttribute('data-demo-choreography', 'stopped');
    } else {
      await expect(root).toHaveAttribute('data-demo-choreography', 'rest', { timeout: 15_000 });
      await expect(page.locator('[data-demo-cursor]'), 'a held pose draws no pointer').toHaveCount(0);
    }
    if (readAtCycleEnd) {
      const readyAtCycleEnd = await page.evaluate(() => (window as unknown as { __readyAtCycleEnd?: boolean }).__readyAtCycleEnd);
      expect(readyAtCycleEnd, `${scene.ready} is showing where the first cycle ends`).toBe(true);
    } else {
      await expect(page.locator(scene.ready).first()).toBeVisible();
    }
    expect(await sweptNodes(page), `${scene.name}: the extension sweep hid part of the app during a cycle`).toEqual([]);
    expect(getUnexpectedErrors()).toEqual([]);
  });
}

type HostScrollProof = 'a scroll in the frame' | 'the canvas focused';

/** What a cycle did inside a frame hosted half on screen, counted by an init script in the frame. */
interface FrameActivity { scrolls: number; canvasFocused: boolean }

/** The globals the half-on-screen host page and its frame's init script set. */
interface HostScrollGlobal {
  __hostStart?: { x: number; y: number };
  __hostMoves?: string[];
  __frameActivity?: FrameActivity;
}

/**
 * The cycles that once scrolled the page embedding the frame, each with what proves the cycle did
 * its part, so a pass is never a cycle that did nothing. A `scroll` step ran `scrollIntoView`,
 * which scrolls every box above the element and, in an embedded frame, carries on into the
 * embedding page: kangentic.com's landing page moved under its reader with no input. The Knowledge
 * Graph's canvas focused itself on a press without `preventScroll`, which jumped the page 464 px;
 * the graph's project scenes play the same orbit, so one of them stands for the rest.
 */
const HOST_SCROLL_CASES: Array<{ scene: (typeof CHOREOGRAPHED_SCENES)[number]['scene']; proof: HostScrollProof }> = [
  ...CHOREOGRAPHED_SCENES
    .filter((entry) => entry.cycles && (entry.scene.choreography ?? []).some((step) => 'scroll' in step))
    .map((entry) => ({ scene: entry.scene, proof: 'a scroll in the frame' as const })),
  { scene: SCENES['knowledge-graph'], proof: 'the canvas focused' },
];

test('the registry carries the cycles that once scrolled the host page', () => {
  // Vacuity guard: the loop below would pass on a list with no scroll step in it.
  expect(HOST_SCROLL_CASES.some((entry) => entry.proof === 'a scroll in the frame')).toBe(true);
  expect(playsCycle(SCENES['knowledge-graph'].choreography), 'the Knowledge Graph scene stopped playing a cycle').toBe(true);
});

test.describe('a frame hosted half on screen in a taller page', () => {
  // Playwright's bundled Chromium in new headless mode, not the tier's headless shell. Measured on
  // 2026-10-20: the shell (153 and 147) stops a scroll at a `position: fixed` box, while new
  // headless 153, Electron 44 and Firefox carry it on into the embedding page. The Board Manager,
  // the settings panel and the graph are fixed boxes, so on the shell their cases passed against
  // the bug. Launched here because `test.use` refuses a channel inside a describe.
  let fullChromium: Browser;
  test.beforeAll(async () => {
    fullChromium = await chromium.launch({ channel: 'chromium', headless: true });
  });
  test.afterAll(async () => {
    await fullChromium?.close();
  });

  for (const { scene, proof } of HOST_SCROLL_CASES) {
    test(`view=${scene.name} under loop=1 never scrolls the page that embeds it`, async () => {
      test.setTimeout(90_000);
      const context = await fullChromium.newContext({ viewport: { width: 1600, height: 1000 } });
      try {
        await expectHostNeverScrolls(await context.newPage(), scene.name, proof);
      } finally {
        await context.close();
      }
    });
  }

  test('a boot click on a text field the viewport hides leaves the embedding page where it was', async () => {
    const context = await fullChromium.newContext({ viewport: { width: 1600, height: 1000 } });
    try {
      await expectBootFocusLeavesHostAlone(await context.newPage(), SCENES['dictation-field']);
    } finally {
      await context.close();
    }
  });
});

/** The text field dictation-field's last boot click lands on: the Settings search box. */
const BOOT_CLICKED_FIELD = '[data-testid="settings-search"]';

/** What the frame's init script saw the boot's click do to the field: how many times it took focus. */
interface FieldFocusActivity { focusins: number }

/** The global the frame's init script sets for the boot click's field. */
interface FieldFocusGlobal {
  __fieldFocus?: FieldFocusActivity;
}

/**
 * Boot a still of a scene whose boot clicks a text field, hosted with the half of the frame that
 * does NOT hold the field on screen, and fail on any position the host page takes. The boot's
 * click focuses the field the way a visitor's pointer would, and `focus()` alone scrolls the field
 * into view through every box above it and on into the embedding page; the cycles above all
 * start with the field's half on screen, where that scroll has nowhere to go. A still runs the
 * boot clicks and holds the scene's pose without a timer or a recording, so nothing after the
 * reveal can move the host: whatever moved it is the boot.
 */
async function expectBootFocusLeavesHostAlone(page: Page, scene: SceneDefinition): Promise<void> {
  // Vacuity guard: the test means nothing for a scene that stopped clicking the field.
  expect(
    (scene.steps ?? []).some((step) => 'click' in step && step.click === BOOT_CLICKED_FIELD),
    `${scene.name} no longer clicks ${BOOT_CLICKED_FIELD} at boot`,
  ).toBe(true);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  // Init scripts run in the host page too, whose own focus is not the frame's.
  await page.addInitScript((fieldSelector) => {
    if (window.top === window) return;
    const activity: FieldFocusActivity = { focusins: 0 };
    (window as FieldFocusGlobal).__fieldFocus = activity;
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && event.target.matches(fieldSelector)) activity.focusins += 1;
    });
  }, BOOT_CLICKED_FIELD);
  await hostFrame(page, scene.name, { halfOnScreen: 'bottom' });
  const start = await page.evaluate(() => (window as HostScrollGlobal).__hostStart ?? null);
  expect(start?.y, 'the host page opened scrolled to the bottom half of the frame').toBe(hostStartY('bottom'));
  // Only calls that never scroll the host while it records: a locator action would.
  const hostMoves = await page.evaluate(() => (window as HostScrollGlobal).__hostMoves ?? null);
  expect(hostMoves?.slice(0, 5), `${scene.name} scrolled the page that embeds it`).toEqual([]);
  // The field must sit wholly above the viewport's top edge, or the click had nothing to scroll to.
  const frame = await demoContentFrame(page);
  const fieldBottomInFrame = await frame.evaluate((fieldSelector) => document.querySelector(fieldSelector)?.getBoundingClientRect().bottom ?? null, BOOT_CLICKED_FIELD);
  const frameTopInHost = await page.evaluate(() => document.getElementById('demo')?.offsetTop ?? null);
  if (fieldBottomInFrame === null || frameTopInHost === null) throw new Error(`${BOOT_CLICKED_FIELD} or the host's #demo iframe is missing`);
  expect(frameTopInHost + fieldBottomInFrame, 'the clicked field is off screen in the host').toBeLessThan(hostStartY('bottom'));
  // The boot did its part: the field holds focus, and took it as an event.
  const focus = await frame.evaluate((fieldSelector) => ({
    activeIsField: document.activeElement?.matches(fieldSelector) ?? false,
    activity: (window as FieldFocusGlobal).__fieldFocus ?? null,
  }), BOOT_CLICKED_FIELD);
  if (!focus.activity) throw new Error('the frame never ran its init script');
  expect(focus.activeIsField, 'the boot click left focus on the field').toBe(true);
  expect(focus.activity.focusins, 'the field never took focus').toBeGreaterThan(0);
  expect(getUnexpectedErrors()).toEqual([]);
}

/** Play one cycle of a scene hosted half on screen, and fail on any position the host page takes. */
async function expectHostNeverScrolls(page: Page, sceneName: string, proof: HostScrollProof): Promise<void> {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await setChoreographyRate(page, CHOREOGRAPHY_TEST_RATE);
  // Init scripts run in the host page too, whose own scroll and focus are not the frame's.
  await page.addInitScript(() => {
    if (window.top === window) return;
    const activity: FrameActivity = { scrolls: 0, canvasFocused: false };
    (window as HostScrollGlobal).__frameActivity = activity;
    // A terminal's viewport scrolls as its replay plays, whatever the cycle does.
    document.addEventListener('scroll', (event) => {
      if (event.target instanceof Element && !event.target.closest('.xterm')) activity.scrolls += 1;
    }, true);
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && event.target.matches('[data-testid="knowledge-graph-canvas"] canvas')) activity.canvasFocused = true;
    });
  });
  await hostFrame(page, sceneName, { params: { loop: '1' }, halfOnScreen: 'top' });
  const start = await page.evaluate(() => (window as HostScrollGlobal).__hostStart ?? null);
  expect(start?.y, 'the host page opened scrolled to the frame').toBe(hostStartY('top'));
  // Only calls that never scroll the host while it records: a locator action would.
  const root = page.frameLocator('#demo').locator('html');
  await expect(root).toHaveAttribute('data-demo-cycles', '1', { timeout: 60_000 });
  await expect(root).not.toHaveAttribute('data-demo-choreography', 'stopped');
  const hostMoves = await page.evaluate(() => (window as HostScrollGlobal).__hostMoves ?? null);
  expect(hostMoves?.slice(0, 5), `${sceneName} scrolled the page that embeds it`).toEqual([]);
  const activity = await (await demoContentFrame(page)).evaluate(() => (window as HostScrollGlobal).__frameActivity ?? null);
  if (!activity) throw new Error('the frame never ran its init script');
  if (proof === 'a scroll in the frame') expect(activity.scrolls, 'the cycle scrolled nothing in the frame').toBeGreaterThan(0);
  else expect(activity.canvasFocused, 'the cycle never pressed the canvas').toBe(true);
  expect(getUnexpectedErrors()).toEqual([]);
}

test('a cut fades the frame out, puts the edit back behind the veil, and fades in at rest', async ({ page }) => {
  // new-task types its story in view and ends on a cut; the steps after it erase the form. Every
  // keystroke into the title is logged with what covered the frame when it landed.
  test.setTimeout(90_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.addInitScript((rate) => {
    (window as { __demoChoreographyRate?: number }).__demoChoreographyRate = rate;
    const edits: Array<{ inputType: string; veil: string; cursor: string }> = [];
    (window as unknown as { __titleEdits: typeof edits }).__titleEdits = edits;
    document.addEventListener('input', (event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement) || field.placeholder !== 'Task title') return;
      const veil = document.querySelector('[data-demo-veil]');
      const cursor = document.querySelector<HTMLElement>('[data-demo-cursor]');
      edits.push({
        inputType: (event as InputEvent).inputType,
        veil: veil ? getComputedStyle(veil).opacity : 'none',
        cursor: cursor ? cursor.style.opacity : 'none',
      });
    }, true);
  }, CHOREOGRAPHY_TEST_RATE);
  await gotoScene(page, { view: 'new-task', embed: '1', loop: '1' });
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-demo-cycles', '1', { timeout: 60_000 });
  const edits = await page.evaluate(() => (window as unknown as { __titleEdits: Array<{ inputType: string; veil: string; cursor: string }> }).__titleEdits);
  const typed = edits.filter((edit) => edit.inputType === 'insertText');
  const erased = edits.filter((edit) => edit.inputType === 'deleteContentBackward');
  expect(typed.length, 'the story types a title').toBeGreaterThan(0);
  expect(erased.length, 'the reset erases it').toBeGreaterThan(0);
  expect(typed.filter((edit) => edit.veil !== 'none' && edit.veil !== '0'), 'the title is typed in view').toEqual([]);
  expect(erased.filter((edit) => edit.veil !== '1' || edit.cursor !== '0'), 'the title is erased behind a veil that has landed, with no pointer drawn').toEqual([]);
  await expect(page.locator('[data-demo-veil]')).toHaveCSS('opacity', '0');
  await expect(page.locator('[data-testid="new-task-dialog"] input[placeholder="Task title"]')).toHaveValue('');
  await expect(root).not.toHaveAttribute('data-demo-choreography', 'stopped');
  expect(getUnexpectedErrors()).toEqual([]);
});

/** A change a visitor could see, logged with the cut's phase and what covered the frame when it landed. */
type CutChange = { what: string; phase: string; veil: string; cursor: string; mark?: true };

/** The scenes whose choreography ends its story on a cut. */
const CUT_SCENES = Object.values(SCENES).filter((scene) => (scene.choreography ?? []).some((step) => 'cut' in step));

test('the registry carries cuts to check', () => {
  // Vacuity guard for the loop below.
  expect(CUT_SCENES.length).toBeGreaterThan(1);
});

for (const scene of CUT_SCENES) {
  test(`view=${scene.name} puts its edit back only behind an opaque veil, and fades in on a settled frame`, async ({ page }) => {
    // Every state change a visitor could see (a field's value, a switch, a pressed or selected
    // control, a card or a dialog coming or going) is logged with the cut's phase and what covered
    // the frame when it landed. The reset's changes belong under the landed veil with no pointer
    // drawn, and nothing changes while the frame fades back in.
    test.setTimeout(90_000);
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await page.addInitScript((rate) => {
      (window as { __demoChoreographyRate?: number }).__demoChoreographyRate = rate;
      const changes: CutChange[] = [];
      const phases: CutChange[] = [];
      Object.assign(window, { __cutChanges: changes, __cutPhases: phases });
      const covering = (what: string): CutChange => {
        const veil = document.querySelector('[data-demo-veil]');
        const cursor = document.querySelector<HTMLElement>('[data-demo-cursor]');
        return {
          what,
          phase: document.documentElement.getAttribute('data-demo-cut') ?? 'none',
          veil: veil ? getComputedStyle(veil).opacity : 'none',
          cursor: cursor ? cursor.style.opacity : 'none',
        };
      };
      const ours = (node: Node): boolean => node instanceof Element && (node.closest('[data-demo-veil], [data-demo-cursor], .xterm') !== null);
      const SHOWN = '[data-task-id], [role="dialog"], [data-dismissable-layer]';
      // A dragged card, which plays its drop animation after the release; dnd-kit unmounts the
      // wrapper around it, so the overlay is looked for inside what came and went too.
      const OVERLAY = '.drag-overlay';
      const shown = (node: Node): node is Element => node instanceof Element && (node.matches(SHOWN) || node.matches(OVERLAY) || node.querySelector(OVERLAY) !== null);
      // A task window's rect is its frame's inline style: a window docked and floated again
      // changes nothing else a visitor would see.
      const WINDOW = '[data-testid^="window-frame-"]';
      for (const type of ['input', 'change']) {
        document.addEventListener(type, (event) => {
          if (event.target instanceof Node && !ours(event.target)) changes.push(covering(`${type} ${(event.target as Element).getAttribute?.('data-testid') ?? ''}`));
        }, true);
      }
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.target === document.documentElement && record.attributeName === 'data-demo-cut') {
            phases.push(covering(document.querySelector(OVERLAY) ? 'phase, a dragged card still landing' : 'phase'));
            continue;
          }
          if (ours(record.target)) continue;
          if (record.attributeName === 'style' && !(record.target as Element).matches(WINDOW)) continue;
          // An activity mark changing is a session changing (ActivityMark's data-mark), which is
          // what a recorded Send's reset puts back. Logged apart, because a session's own clock can
          // flip a mark at any moment, the fade-in included; the Send test holds the browser
          // scene's mark to the reset itself.
          if (record.attributeName === 'data-mark') {
            changes.push({ ...covering(`data-mark ${(record.target as Element).getAttribute('data-mark') ?? ''}`), mark: true });
            continue;
          }
          if (record.type === 'attributes') {
            changes.push(covering(`${record.attributeName} ${(record.target as Element).getAttribute('data-testid') ?? (record.target as Element).tagName}`));
            continue;
          }
          for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
            if (shown(node)) changes.push(covering(`${record.addedNodes.length > 0 ? 'added' : 'removed'} ${node.getAttribute('data-testid') ?? node.getAttribute('data-task-id') ?? (node.matches(OVERLAY) || node.querySelector(OVERLAY) ? 'drag overlay' : node.tagName)}`));
          }
        }
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-demo-cut', 'aria-checked', 'aria-pressed', 'aria-selected', 'aria-expanded', 'checked', 'disabled', 'data-selected', 'style', 'data-mark'],
      });
    }, CHOREOGRAPHY_TEST_RATE);
    await gotoScene(page, { view: scene.name, embed: '1', loop: '1' });
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-demo-cycles', '1', { timeout: 60_000 });
    const { changes, phases } = await page.evaluate(() => ({
      changes: (window as unknown as { __cutChanges: CutChange[] }).__cutChanges,
      phases: (window as unknown as { __cutPhases: CutChange[] }).__cutPhases,
    }));
    expect(phases.map((entry) => entry.phase).slice(0, 4), 'the cut fades out, resets, fades in, and ends').toEqual(['out', 'reset', 'in', 'none']);
    const reset = phases.find((entry) => entry.phase === 'reset');
    expect(reset && { veil: reset.veil, cursor: reset.cursor }, 'the reset starts under a landed veil with no pointer').toEqual({ veil: '1', cursor: '0' });
    const behind = changes.filter((change) => change.phase === 'reset');
    expect(behind.length, 'the reset puts something back').toBeGreaterThan(0);
    expect(behind.filter((change) => change.veil !== '1' || change.cursor !== '0'), 'the reset changes nothing in view').toEqual([]);
    expect(phases.find((entry) => entry.phase === 'in')?.what, 'a drag the reset dropped has landed before the frame fades back in').toBe('phase');
    expect(changes.filter((change) => change.phase === 'in' && !change.mark), 'nothing changes while the frame fades back in').toEqual([]);
    await expect(page.locator('[data-demo-veil]')).toHaveCSS('opacity', '0');
    await expect(root).not.toHaveAttribute('data-demo-choreography', 'stopped');
    expect(getUnexpectedErrors()).toEqual([]);
  });
}

/** A frame's text with its escape sequences dropped; frames move the cursor for spaces, so read single words. */
function withoutEscapes(bytes: string): string {
  return bytes.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]/g, '');
}

test('view=browser sends its recorded note: the payload reaches the agent, it goes to work, and the cut takes it back', async ({ page }) => {
  // The loop's Send plays the matrix's recording of exactly that note going into this conversation
  // (send-sess-cw-middleware.json): the bytes reach the session's terminal through the mock's data
  // path, the pause button turns to working when the agent takes the Enter, and the cut's reset
  // repaints the frame the session rested on and sets it back to needs-you, all under the veil.
  test.setTimeout(90_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.addInitScript(({ rate, sessionId }) => {
    (window as { __demoChoreographyRate?: number }).__demoChoreographyRate = rate;
    const phase = (): string => document.documentElement.getAttribute('data-demo-cut') ?? 'none';
    const bytes: Array<{ phase: string; bytes: string }> = [];
    const marks: Array<{ phase: string; mark: string }> = [];
    Object.assign(window, { __sendBytes: bytes, __sendMarks: marks });
    // The mock adds its listeners to this list rather than replacing it (mock-electron-api.js).
    (window as unknown as { __mockDataListeners: Array<(id: string, data: string) => void> }).__mockDataListeners = [
      (id, data) => { if (id === sessionId) bytes.push({ phase: phase(), bytes: data }); },
    ];
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as Element;
        if (target.closest('button[aria-label="Pause session"]')) marks.push({ phase: phase(), mark: target.getAttribute('data-mark') ?? '' });
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-mark'] });
  }, { rate: CHOREOGRAPHY_TEST_RATE, sessionId: SESSION_MIDDLEWARE });
  await gotoScene(page, { view: 'browser', embed: '1', loop: '1' });
  await expect(page.locator('html')).toHaveAttribute('data-demo-cycles', '1', { timeout: 60_000 });
  const { bytes, marks } = await page.evaluate(() => ({
    bytes: (window as unknown as { __sendBytes: Array<{ phase: string; bytes: string }> }).__sendBytes,
    marks: (window as unknown as { __sendMarks: Array<{ phase: string; mark: string }> }).__sendMarks,
  }));
  const sent = withoutEscapes(bytes.filter((entry) => entry.phase === 'none').map((entry) => entry.bytes).join(''));
  expect(sent, 'the payload the pane sent, echoed in the agent\'s terminal').toContain('<browser_context>');
  expect(sent, 'the screenshot the payload names').toMatch(/captures[\\/]capture-\d+\.png/);
  // The first cycle's two flips; the next cycle may already be typing.
  expect(marks.slice(0, 2).map((entry) => `${entry.mark} during ${entry.phase}`), 'working once the agent takes the Enter, needs-you again only under the veil').toEqual([
    'control-pause-working during none',
    'control-pause-idle during reset',
  ]);
  const rewound = bytes.filter((entry) => entry.phase === 'reset');
  expect(rewound.length, 'the reset repaints the terminal').toBeGreaterThan(0);
  expect(withoutEscapes(rewound.map((entry) => entry.bytes).join('')), 'onto the frame from before the note').not.toContain('browser_context');
  expect(bytes.filter((entry) => entry.phase === 'in'), 'nothing reaches the terminal while the frame fades back in').toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a still of view=browser paints the frame its Send starts from, and fetches nothing for it', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const fetched: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/recordings/')) fetched.push(request.url()); });
  await gotoScene(page, { view: 'browser', embed: '1', still: '1' });
  const painted = () => page.evaluate((sessionId) => (window as unknown as { __demoPainted?: Record<string, { frame: string }> }).__demoPainted?.[sessionId]?.frame ?? '', SESSION_MIDDLEWARE);
  // The conversation's last answer, as the resumed agent reprinted it before the note went in.
  await expect.poll(async () => withoutEscapes(await painted()), { timeout: 15_000 }).toContain('rate-limit.ts');
  expect(withoutEscapes(await painted())).not.toContain('browser_context');
  expect(fetched).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the browser scene\'s guest page is the size its recorded Send was captured at', async ({ page }) => {
  // The capture rig screenshots the guest page at the manifest's guestSize
  // (scripts/capture-demo-sessions.mjs) and the agent reads that screenshot, so the recording is
  // only the Send a visitor would make if that is the size the pane gives its guest at the spec's
  // 1600 by 1000 frame. The iframe is 877.9 px wide there, so clientWidth rounds to the same 878
  // on any platform's layout; Linux CI is the real check of that.
  const send = DEMO_MANIFEST.browserSends.find((entry) => entry.sessionId === SESSION_MIDDLEWARE);
  if (!send) throw new Error(`the manifest lists no browser send for ${SESSION_MIDDLEWARE}`);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'browser', embed: '1', still: '1' });
  const guest = page.locator('[data-testid="browser-webview"] iframe');
  await expect.poll(
    () => guest.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight })),
    { message: `the Browser pane's guest is not the ${send.guestSize.width} by ${send.guestSize.height} the Send was captured at` },
  ).toEqual(send.guestSize);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a visitor\'s own click stops the choreography and takes the pointer away', async ({ page }) => {
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await setChoreographyRate(page, CHOREOGRAPHY_TEST_RATE);
  await gotoScene(page, { view: 'column-automation-edit', embed: '1', loop: '1' });
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-demo-choreography', 'playing', { timeout: 15_000 });
  await expect(page.locator('[data-demo-cursor]')).toHaveCount(1);
  // The dialog's own title: a real click there changes nothing in the form.
  await page.locator('[data-testid="edit-automation-dialog"] h3').first().click();
  await expect(root).toHaveAttribute('data-demo-choreography', 'stopped');
  await expect(page.locator('[data-demo-cursor]')).toHaveCount(0);
  await expect(page.locator('[data-demo-hover]'), 'no element is left marked as hovered').toHaveCount(0);
  const cycles = await root.getAttribute('data-demo-cycles');
  // Well past a cycle at this pacing: nothing plays again.
  await page.waitForTimeout(4_000);
  await expect(root).toHaveAttribute('data-demo-cycles', cycles ?? '0');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a visitor\'s click after the frame is ready but before the player has loaded stops the loop before it starts', async ({ page }) => {
  // boot.js marks the frame ready and only then fetches the choreography chunk, which is what
  // listens for a visitor. Input in that gap used to be missed: the loop started anyway, on the
  // state the visitor had just changed. The chunk is held at the network so the gap is as wide
  // as the test needs, and the click lands inside it.
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await setChoreographyRate(page, CHOREOGRAPHY_TEST_RATE);
  const heldRequests: string[] = [];
  let releasePlayer: () => void = () => undefined;
  const playerReleased = new Promise<void>((resolve) => { releasePlayer = resolve; });
  await page.route(/\/assets\/choreography-[^/?]+\.js(\?.*)?$/, async (route) => {
    heldRequests.push(route.request().url());
    await playerReleased;
    await route.continue();
  });
  try {
    await gotoScene(page, { view: 'column-automation-edit', embed: '1', loop: '1' });
    const root = page.locator('html');
    // The vacuity guard: without these two the click would meet a player that is already
    // listening, which stops the loop by its own path and passes the assertions below untested.
    await expect.poll(() => heldRequests.length, { message: 'the player chunk was requested and is being held' }).toBeGreaterThan(0);
    await expect(root, 'no player exists yet, so nothing is listening for a visitor').not.toHaveAttribute('data-demo-choreography');
    // The dialog's own title: a real click there changes nothing in the form.
    const title = await page.locator('[data-testid="edit-automation-dialog"] h3').first().boundingBox();
    expect(title).not.toBeNull();
    await page.mouse.click((title?.x ?? 0) + 8, (title?.y ?? 0) + 4);
    await expect(root, 'the held chunk is still not loaded after the click').not.toHaveAttribute('data-demo-choreography');
    releasePlayer();
    await expect(root).toHaveAttribute('data-demo-choreography', 'stopped');
    await expect(root).toHaveAttribute('data-demo-cycles', '0');
    await expect(page.locator('[data-demo-cursor]')).toHaveCount(0);
    // Intentional fixed wait: nothing can be polled for "never starts". Well past the opening
    // rest at this pacing (2.5 s over 8), where a loop that had started would be drawing its pointer.
    await page.waitForTimeout(3_000);
    await expect(root).toHaveAttribute('data-demo-choreography', 'stopped');
    await expect(root).toHaveAttribute('data-demo-cycles', '0');
    await expect(page.locator('[data-demo-cursor]')).toHaveCount(0);
    expect(getUnexpectedErrors()).toEqual([]);
  } finally {
    releasePlayer();
  }
});

test('a visitor\'s press mid-travel ends the step in flight: the choreography presses nothing after it', async ({ page }) => {
  // At a quarter of the pacing a travel lasts over two seconds, so a press as the cycle starts
  // lands while the pointer is still on its way to its first target. That step used to go on to
  // its click once the travel gave up, onto whatever the pointer had reached.
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.addInitScript(() => {
    (window as { __demoChoreographyRate?: number }).__demoChoreographyRate = 0.25;
    const seen: Array<{ type: string; trusted: boolean }> = [];
    (window as unknown as { __pointerLog: typeof seen }).__pointerLog = seen;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'click']) {
      window.addEventListener(type, (event) => seen.push({ type, trusted: event.isTrusted }), { capture: true });
    }
  });
  await gotoScene(page, { view: 'column-automation-edit', embed: '1', loop: '1' });
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-demo-choreography', 'playing', { timeout: 30_000 });
  // The dialog's own title: a real press there changes nothing in the form.
  const title = await page.locator('[data-testid="edit-automation-dialog"] h3').first().boundingBox();
  expect(title).not.toBeNull();
  await page.mouse.click((title?.x ?? 0) + 8, (title?.y ?? 0) + 4);
  await expect(root).toHaveAttribute('data-demo-choreography', 'stopped');
  // Long enough for the press and the 360 ms hold this pacing gives it to have gone out.
  await page.waitForTimeout(1_500);
  const log = await page.evaluate(() => (window as unknown as { __pointerLog: Array<{ type: string; trusted: boolean }> }).__pointerLog);
  const visitorPress = log.findIndex((entry) => entry.trusted && entry.type === 'pointerdown');
  expect(visitorPress, 'the visitor\'s press was seen').toBeGreaterThan(-1);
  // Letting go of a press the choreography was holding is a release (pointerup, click), which a
  // takeover sends on purpose; a new press is the step going on without it.
  const syntheticPresses = log.slice(visitorPress).filter((entry) => !entry.trusted && (entry.type === 'pointerdown' || entry.type === 'mousedown'));
  expect(syntheticPresses, 'no synthetic press after the visitor took over').toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a visitor who prefers reduced motion gets the rest, held, and no pointer', async ({ page }) => {
  // WCAG 2.2.2: motion that starts by itself needs a way to stop it, and the system setting is the
  // one a frame can read before anything moves.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setChoreographyRate(page, CHOREOGRAPHY_TEST_RATE);
  await gotoScene(page, { view: 'column-automation-edit', embed: '1', loop: '1' });
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-demo-choreography', 'rest', { timeout: 15_000 });
  // Well past the opening rest at this pacing, where a cycle would have started.
  await page.waitForTimeout(3_000);
  await expect(root).toHaveAttribute('data-demo-choreography', 'rest');
  await expect(root).toHaveAttribute('data-demo-cycles', '0');
  await expect(page.locator('[data-demo-cursor]')).toHaveCount(0);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a visitor\'s own click lets go of a held pose', async ({ page }) => {
  // card-drag holds its card over Executing; a real press ends the gesture where it stands, as a
  // released mouse would, so the frame is the visitor's from then on.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'card-drag', embed: '1', loop: '1' });
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-demo-choreography', 'rest', { timeout: 15_000 });
  await expect(page.locator('.drag-overlay')).toBeVisible();
  // Empty lane space below To Do's cards, where a press does nothing of its own.
  const lane = await page.locator('[data-swimlane-name="To Do"]').boundingBox();
  if (!lane) throw new Error('To Do has no box');
  await page.mouse.click(lane.x + lane.width / 2, lane.y + lane.height - 24);
  await expect(root).toHaveAttribute('data-demo-choreography', 'stopped');
  await expect(page.locator('.drag-overlay')).toHaveCount(0);
  expect(getUnexpectedErrors()).toEqual([]);
});

// A held pose in a frame that does not loop (the site's take-control dialog never passes loop=1,
// and a reader who prefers reduced motion gets still=1) must still let go on a real press, or the
// visitor is left with a card stuck mid-drag or a window stuck over the dock edge.
const HELD_POSES = [
  { scene: 'card-drag', held: '.drag-overlay' },
  { scene: 'window-dock', held: '[data-testid="snap-preview"]' },
];
for (const { scene, held } of HELD_POSES) {
  for (const mode of [{}, { still: '1' }] as Array<Record<string, string>>) {
    test(`view=${scene} ${mode.still ? 'as a still' : 'live without loop=1'} lets go of its pose on a visitor's own click`, async ({ page }) => {
      const getUnexpectedErrors = collectUnexpectedErrors(page);
      await gotoScene(page, { view: scene, embed: '1', ...mode });
      await expect(page.locator(held)).toBeVisible();
      // The title bar's app name: a real press there does nothing of its own.
      await page.mouse.click(60, 20);
      await expect(page.locator('html')).toHaveAttribute('data-demo-choreography', 'stopped');
      // Hidden, not gone: the drag overlay unmounts, and the dock preview stays mounted with
      // `display: none` (snap-preview-controller.ts).
      await expect(page.locator(held)).toBeHidden();
      await expect(page.locator('[data-demo-hover]'), 'no element is left marked as hovered').toHaveCount(0);
      expect(getUnexpectedErrors()).toEqual([]);
    });
  }
}

/** One flip of `data-demo-choreography` to `rest` or `playing`, with what the page showed at that moment. */
interface StateFlip { state: string; cycles: string; cursor: string; overlay: boolean; at: number }

/** The scenes that end a cycle holding a drag, and one that ends it at rest with the button up. */
const CYCLE_END_SCENES = [
  { scene: 'card-drag', holding: true },
  { scene: 'window-dock', holding: true },
  { scene: 'column-automation-edit', holding: false },
];
for (const { scene, holding } of CYCLE_END_SCENES) {
  test(`view=${scene} ${holding ? 'ends a cycle with the pointer still drawn and goes straight to its drop' : 'ends a cycle with the pointer gone and rests before the next'}`, async ({ page }) => {
    // A cycle that ends on a held drag is a hand mid-gesture: the pointer stays on the page and the
    // drop follows a beat later, where a cycle at rest takes the pointer away for the long pause.
    // At the test pacing that pause is 3.5 s over 8.
    test.setTimeout(90_000);
    const restBetweenCyclesMs = 3500 / CHOREOGRAPHY_TEST_RATE;
    const getUnexpectedErrors = collectUnexpectedErrors(page);
    await page.addInitScript((rate) => {
      (window as { __demoChoreographyRate?: number }).__demoChoreographyRate = rate;
      const flips: StateFlip[] = [];
      (window as unknown as { __stateFlips: StateFlip[] }).__stateFlips = flips;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName !== 'data-demo-choreography') continue;
          const root = document.documentElement;
          const cursor = document.querySelector<HTMLElement>('[data-demo-cursor]');
          flips.push({
            state: root.getAttribute('data-demo-choreography') ?? '',
            cycles: root.getAttribute('data-demo-cycles') ?? '',
            cursor: cursor ? cursor.style.opacity : 'none',
            overlay: document.querySelector('.drag-overlay, [data-testid="snap-preview"]:not([style*="display: none"])') !== null,
            at: performance.now(),
          });
        }
      // Observed on the document, not its root: an init script runs before the root element exists.
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-demo-choreography'] });
    }, CHOREOGRAPHY_TEST_RATE);
    await gotoScene(page, { view: scene, embed: '1', loop: '1' });
    const readFlips = (): Promise<StateFlip[]> => page.evaluate(() => (window as unknown as { __stateFlips: StateFlip[] }).__stateFlips);
    // The first cycle's rest, and the play that follows it.
    await expect.poll(async () => {
      const flips = await readFlips();
      const restIndex = flips.findIndex((flip) => flip.state === 'rest' && flip.cycles === '1');
      return restIndex >= 0 && flips.slice(restIndex + 1).some((flip) => flip.state === 'playing');
    }, { timeout: 60_000, message: 'a cycle ended and the next one began' }).toBe(true);
    const flips = await readFlips();
    const restIndex = flips.findIndex((flip) => flip.state === 'rest' && flip.cycles === '1');
    const rest = flips[restIndex];
    const next = flips.slice(restIndex + 1).find((flip) => flip.state === 'playing');
    if (!next) throw new Error('no play followed the first cycle');
    const gap = next.at - rest.at;
    if (holding) {
      expect(rest.cursor, 'the hand holding the drag keeps its pointer').toBe('1');
      expect(rest.overlay, 'the drag is still held at the end of the cycle').toBe(true);
      expect(gap, 'a held drag goes straight on to its drop, with no rest between').toBeLessThan(restBetweenCyclesMs / 2);
    } else {
      expect(rest.cursor, 'a cycle at rest takes the pointer away').toBe('0');
      // A timer never fires early, so the full pause (less a frame's rounding) has passed.
      expect(gap, 'a cycle at rest waits out the pause before the next').toBeGreaterThan(restBetweenCyclesMs * 0.8);
    }
    await expect(page.locator('html')).not.toHaveAttribute('data-demo-choreography', 'stopped');
    expect(getUnexpectedErrors()).toEqual([]);
  });
}

test('a usage still has its bars drawn at ready, since Animations off holds the chart tweens too', async ({ page }) => {
  // A still turns the Animations setting off, and the poster rig shoots at ready. The charts' tweens
  // are the chart library's own script, which the setting's `.no-motion` class never reached, so a
  // poster shot at ready caught every bar at its first frame, a pixel tall, and the axes over an
  // empty plot.
  await gotoScene(page, { view: 'usage', embed: '1', still: '1' });
  const tallestBar = await page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll('.recharts-bar-rectangle path'))
    .map((bar) => bar.getBoundingClientRect().height)));
  expect(tallestBar, 'the tallest cost bar, in CSS pixels, the moment the frame is ready').toBeGreaterThan(20);
});

// ---- usage dashboard fixture ---------------------------------------------------------------------
// The sample install answers the dashboard from one seeded ninety-day history that every period
// reads a slice of, with the running sessions sitting in it once (tests/captures/helpers/demo-dataset.ts).
// These tests call that fixture directly and hold it against itself, so they hold on any weekday
// and at any hour: no total is a number written here.

type UsagePeriodName = 'today' | 'week' | 'month' | 'all';
const USAGE_PERIODS: UsagePeriodName[] = ['today', 'week', 'month', 'all'];

interface UsageScope { kind: 'all' | 'project'; projectId?: string }

/** The scopes the dashboard offers: every project, and one. The project scope is the branch that filters the running sessions. */
const USAGE_SCOPES: Array<[label: string, scope: UsageScope]> = [
  ['all projects', { kind: 'all' }],
  ['one project', { kind: 'project', projectId: PROJECT_CONTOSO }],
];

/** One bar of the cost chart: a local hour (Today) or a local day. */
interface UsageBar { bucketStartMs: number; costUsd: number; inputTokens: number; outputTokens: number; sessionCount: number }

/** The part of a dashboard payload these tests read. */
interface UsagePayload {
  rangeStartMs: number;
  rangeEndMs: number;
  kpis: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; sessionCount: number };
  costSeries: UsageBar[];
  liveLedgerBaseline: { costUsd: number };
}

/** A running session the Cost tile's live overlay layers on: when it started and the cost it reads. */
interface LiveReading { startMs: number; costUsd: number }

interface UsageRead { periods: Record<UsagePeriodName, UsagePayload>; live: LiveReading[] }

interface DemoUsageWindow {
  electronAPI: {
    usage: {
      __dashboardStatsFixture: (scope: UsageScope, period: UsagePeriodName, drill: null, customWindow: null) => UsagePayload;
    };
    sessions: {
      list: () => Promise<Array<{ id: string; projectId: string; status: string; transient?: boolean; workflowId?: string | null; startedAt: string }>>;
      getUsage: () => Promise<Record<string, { cost: { totalCostUsd: number } }>>;
    };
  };
}

/**
 * The fixture's answer for each period in one scope, with the running sessions the overlay would
 * layer on. That set is the renderer's own rule (selectLiveSessionIds in useStatsData.ts), built
 * from the bridge and not from the fixture: a live status, not a Command Terminal, in the viewed
 * project, each with the cost its usage reading carries.
 */
async function readUsage(page: Page, scope: UsageScope): Promise<UsageRead> {
  return page.evaluate(async ({ requested, periods }) => {
    const api = (window as unknown as DemoUsageWindow).electronAPI;
    const [sessions, readings] = await Promise.all([api.sessions.list(), api.sessions.getUsage()]);
    const live: LiveReading[] = [];
    for (const session of sessions) {
      const isLive = session.status === 'running' || session.status === 'queued';
      const isCommandTerminal = !!session.transient && !session.workflowId;
      const inScope = requested.kind === 'all' || session.projectId === requested.projectId;
      if (isLive && !isCommandTerminal && inScope && readings[session.id]) {
        live.push({ startMs: Date.parse(session.startedAt), costUsd: readings[session.id].cost.totalCostUsd });
      }
    }
    const read: Partial<Record<UsagePeriodName, UsagePayload>> = {};
    for (const period of periods) {
      const payload = api.usage.__dashboardStatsFixture(requested, period, null, null);
      read[period] = {
        rangeStartMs: payload.rangeStartMs,
        rangeEndMs: payload.rangeEndMs,
        kpis: {
          totalCostUsd: payload.kpis.totalCostUsd,
          totalInputTokens: payload.kpis.totalInputTokens,
          totalOutputTokens: payload.kpis.totalOutputTokens,
          sessionCount: payload.kpis.sessionCount,
        },
        costSeries: payload.costSeries.map((bar) => ({
          bucketStartMs: bar.bucketStartMs, costUsd: bar.costUsd, inputTokens: bar.inputTokens, outputTokens: bar.outputTokens, sessionCount: bar.sessionCount,
        })),
        liveLedgerBaseline: { costUsd: payload.liveLedgerBaseline.costUsd },
      };
    }
    return { periods: read as Record<UsagePeriodName, UsagePayload>, live };
  }, { requested: scope, periods: USAGE_PERIODS });
}

const sumOf = (values: number[]): number => values.reduce((total, value) => total + value, 0);

test('the usage fixture reads every period from one history: Today is the last bar of the longer periods', async ({ page }) => {
  // The fixture used to draw each period from a generator of its own, so Today's tiles and This
  // Week's last bar were two different days. They are one day now, and each longer period is a
  // slice of the same ninety.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'usage', embed: '1', still: '1' });
  for (const [label, scope] of USAGE_SCOPES) {
    const { periods } = await readUsage(page, scope);
    const today = periods.today;
    // Cost only: in the first minutes after local midnight Today's hour can round to no sessions.
    expect(today.kpis.totalCostUsd, `${label}: Today has spend, or the comparisons below prove nothing`).toBeGreaterThan(0);
    for (const period of ['week', 'month', 'all'] as const) {
      const bars = periods[period].costSeries;
      const lastBar = bars[bars.length - 1];
      expect(lastBar, `${label}: ${period} has a last bar`).toBeDefined();
      expect(lastBar.bucketStartMs, `${label}: ${period} ends on the day Today starts`).toBe(today.rangeStartMs);
      expect(lastBar.costUsd, `${label}: ${period}'s last bar costs what Today's tile reads`).toBeCloseTo(today.kpis.totalCostUsd, 6);
      expect(lastBar.inputTokens, `${label}: ${period}'s last bar input tokens`).toBe(today.kpis.totalInputTokens);
      expect(lastBar.outputTokens, `${label}: ${period}'s last bar output tokens`).toBe(today.kpis.totalOutputTokens);
      expect(lastBar.sessionCount, `${label}: ${period}'s last bar sessions`).toBe(today.kpis.sessionCount);
    }
    for (const period of USAGE_PERIODS) {
      const { costSeries, kpis } = periods[period];
      expect(sumOf(costSeries.map((bar) => bar.costUsd)), `${label}: ${period}'s bars add up to its cost tile`).toBeCloseTo(kpis.totalCostUsd, 6);
      expect(sumOf(costSeries.map((bar) => bar.sessionCount)), `${label}: ${period}'s bars add up to its session tile`).toBe(kpis.sessionCount);
    }
    // A period holds what the ones inside it hold. This Week is not compared with This Month: on
    // the first days of a month, that week's Monday falls in the month before.
    const nested: Array<[inner: UsagePeriodName, outer: UsagePeriodName]> = [['today', 'week'], ['today', 'month'], ['today', 'all'], ['week', 'all'], ['month', 'all']];
    for (const [inner, outer] of nested) {
      expect(periods[inner].kpis.totalCostUsd, `${label}: ${inner} costs no more than ${outer}`).toBeLessThanOrEqual(periods[outer].kpis.totalCostUsd + 1e-9);
      expect(periods[inner].kpis.sessionCount, `${label}: ${inner} has no more sessions than ${outer}`).toBeLessThanOrEqual(periods[outer].kpis.sessionCount);
    }
    expect(periods.all.kpis.totalCostUsd, `${label}: all time holds more than a week`).toBeGreaterThan(periods.week.kpis.totalCostUsd);
  }
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the usage fixture counts each running session once: the baseline is what the ledger holds of them', async ({ page }) => {
  // The Cost tile is the ledger total, minus liveLedgerBaseline, plus each running session's
  // cumulative reading (resolveDisplayCost). The fixture once held the running sessions out of
  // its history and sent a baseline of 0, so every period but Live added the overlay on top of
  // bars that never showed it, and Today's tile read three times its bars. Now the sessions sit
  // in the history under the hour or day they started, and the baseline is exactly the ones
  // that started inside the window.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'usage', embed: '1', still: '1' });
  for (const [scopeLabel, scope] of USAGE_SCOPES) {
    const { periods, live } = await readUsage(page, scope);
    expect(live.length, `${scopeLabel}: the sample install has running sessions to count`).toBeGreaterThan(0);
    const overlayCostUsd = sumOf(live.map((reading) => reading.costUsd));
    for (const period of USAGE_PERIODS) {
      const label = `${scopeLabel}, ${period}`;
      const payload = periods[period];
      const inside = live.filter((reading) => reading.startMs >= payload.rangeStartMs && reading.startMs < payload.rangeEndMs);
      const insideCostUsd = sumOf(inside.map((reading) => reading.costUsd));
      const barsCostUsd = sumOf(payload.costSeries.map((bar) => bar.costUsd));
      const baselineCostUsd = payload.liveLedgerBaseline.costUsd;
      expect(baselineCostUsd, `${label}: the baseline is the cost of the running sessions that started inside the window`).toBeCloseTo(insideCostUsd, 6);
      // Each running session sits in the history under the hour or day it started, so that bar
      // holds at least its cost and one session. The baseline alone would pass with the sessions
      // missing from the bars, which is the other half of the fix.
      payload.costSeries.forEach((bar, index) => {
        const bucketEndMs = index + 1 < payload.costSeries.length ? payload.costSeries[index + 1].bucketStartMs : payload.rangeEndMs;
        const started = live.filter((reading) => reading.startMs >= bar.bucketStartMs && reading.startMs < bucketEndMs);
        const barLabel = `${label}, the bar at ${new Date(bar.bucketStartMs).toISOString()}`;
        expect(bar.costUsd, `${barLabel}: holds the cost of the running sessions that started in it`).toBeGreaterThanOrEqual(sumOf(started.map((reading) => reading.costUsd)) - 1e-9);
        expect(bar.sessionCount, `${barLabel}: counts the running sessions that started in it`).toBeGreaterThanOrEqual(started.length);
      });
      expect(payload.kpis.totalCostUsd, `${label}: the ledger holds at least what the baseline takes off`).toBeGreaterThanOrEqual(baselineCostUsd - 1e-9);
      expect(payload.kpis.sessionCount, `${label}: the session tile counts each of them`).toBeGreaterThanOrEqual(inside.length);
      // What the tile shows, against the bars drawn from the same ledger: they differ only by a
      // session that started before the window, whose cost the ledger holds under an earlier day.
      const tileCostUsd = payload.kpis.totalCostUsd - baselineCostUsd + overlayCostUsd;
      expect(tileCostUsd, `${label}: the tile reads its bars plus the sessions that started before the window`).toBeCloseTo(barsCostUsd + (overlayCostUsd - insideCostUsd), 6);
    }
    // Every running session started inside the ninety days, so All Time's tile IS its bars.
    const all = periods.all;
    const allTileCostUsd = all.kpis.totalCostUsd - all.liveLedgerBaseline.costUsd + overlayCostUsd;
    expect(allTileCostUsd, `${scopeLabel}: All Time's tile reads its bars, each running session once`).toBeCloseTo(sumOf(all.costSeries.map((bar) => bar.costUsd)), 6);
  }
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a still with a pose plays it without the choreography\'s pointer, and a still without one fetches no player', async ({ page }) => {
  const playerRequests: string[] = [];
  page.on('request', (request) => { if (/\/choreography-[^/]*\.js$/.test(new URL(request.url()).pathname)) playerRequests.push(request.url()); });
  await gotoScene(page, { view: 'card-drag', embed: '1', still: '1' });
  await expect(page.locator('.drag-overlay')).toBeVisible();
  await expect(page.locator('[data-demo-cursor]')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-choreography');
  expect(playerRequests.length, 'the pose loads the player').toBe(1);
  playerRequests.length = 0;
  await gotoScene(page, { view: 'column-automation-edit', embed: '1', still: '1' });
  expect(playerRequests, 'a still with no pose has nothing to play').toEqual([]);
});

test('an Escape a script dispatches never reaches the host', async ({ page }) => {
  // A choreography's key, or a boot step's press, is the app's to act on. Only a visitor's own
  // Escape may close the dialog the host shows the frame in. The positive control is the same key
  // pressed for real, which posts (the first Escape test above).
  const readMessages = await hostFrame(page, 'board');
  const textarea = page.frameLocator('#demo').locator('.xterm-helper-textarea').first();
  await textarea.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
  await textarea.focus();
  await textarea.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await page.waitForTimeout(500);
  expect(hasEscape(await readMessages())).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => hasEscape(await readMessages())).toBe(true);
});

test('loop=1 leaves a session that was never working alone', async ({ page }) => {
  // Every session with a recording gets a replay entry, but only one the board seeds as WORKING
  // carries a tail: the rest are already at their recording's end, so their clock lands the
  // moment a terminal mounts. Looping those would flip an idle session to working and blank its
  // terminal, having no opening frame to repaint from and no chunk left to schedule. The
  // reachable case is a visitor opening a task window on such a session, which is a task-window
  // mount on the grid its recording fits, so the frame-fallback guard never sees it.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'task', embed: '1', loop: '1', state: encodeState(RATE_LIMIT_WINDOW_STATE) });
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add rate limiting');
  expect((await monitorRow(page, 'sess-cw-rate-limit'))?.activity).toBe('idle');
  // Its recording is already at its end, so nothing should reach the terminal at all. A wrongly
  // armed cycle announces itself here first: it clears the screen and repaints an opening frame
  // this session does not have, which is a blank terminal. Twice the loop's six-second pause.
  expect(await streamedBytes(page, 'sess-cw-rate-limit', 15_000)).toBe(0);
  expect((await monitorRow(page, 'sess-cw-rate-limit'))?.activity).toBe('idle');
  expect(getUnexpectedErrors()).toEqual([]);
});

/**
 * The rate-limit window in the 1233px frame, wide enough that the seed HOLDS it on either runner
 * font: 139 columns in Consolas's 6px cell and 119 in Liberation Mono's 7px one, inside the bands
 * displayFor holds a 154-column recording at (102 to 151 columns and 109 to 151). The default
 * rect fits 101 in Liberation Mono there, below its band, so nothing would be held on CI.
 */
const RATE_LIMIT_HELD_WINDOW_STATE = floatingWindowState('task-cw-rate-limit', 'Add rate limiting', { x: 0.16, y: 0.15, w: 0.68, h: 0.7 });

test('a held terminal reporting its conformed grid is not a resize, so a finished session stays silent', async ({ browser }) => {
  // The case above runs at the frame size, where the default-rect window fits the recording's
  // columns or a near miss of them and the hold never engages. Narrow the frame and it does: the
  // terminal takes the held grid and its own xterm resize reports that grid straight back. That
  // report is the conform landing, not the window moving, and reading it as a resize repaints a
  // session whose replay is at its end, which is a whole frame arriving in a terminal that should
  // get nothing. It reached CI as one retried run out of many, because whether the hold engages
  // at all rides on the runner's font metrics; the window is sized to be held on both faces
  // (RATE_LIMIT_HELD_WINDOW_STATE).
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1233, height: 771 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1', loop: '1', state: encodeState(RATE_LIMIT_HELD_WINDOW_STATE) }));
  await waitForDemoReady(page);
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add rate limiting');
  const state = await expectFaithfulReplay(page, 'sess-cw-rate-limit');
  expect(state.held, 'the narrowed window was not held').not.toBeNull();
  expect((await sentGrids(page, 'sess-cw-rate-limit'))[0].cols).toBeLessThan(RATE_LIMIT_RECORDED_GRID.cols);
  await expectPanesFilled(page, 'the narrowed window');
  expect(await streamedBytes(page, 'sess-cw-rate-limit', 15_000)).toBe(0);
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('a display that fits another grid replays the task window on the grid it shows, and the session keeps streaming', async ({ browser }) => {
  // A display at 125 percent scaling fits fewer columns in the default-rect window than the
  // recorded 154 by 37 (143 on Windows, 128 on CI's Linux fonts), and no more rows: the context
  // bar is one row, so the window holds all 37 where a two-row bar left 36. A recording's bytes
  // address rows for their own grid. The pane is held at a smaller type, at the
  // grid the WHOLE pane takes there, and the page's emulator plays the recording into it, so the
  // terminal fills the window where the recording held at its own grid left 56px beside it and
  // 23px below. The window is the default rect rather than the `task` scene's, which is fitted to
  // the recording at every scale. Which recording plays follows the grid the page measured (the
  // seed's layoutFor), from the moment the session's clock began, and the session goes on working
  // through it on its own clock, as an agent does on the desktop when its window is resized.
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1', loop: '1', state: encodeState(MIDDLEWARE_DEFAULT_WINDOW_STATE) }));
  await waitForDemoReady(page);
  await SCENE_MARKERS.task(page);
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toHaveLength(0);
  const natural = (await sentGrids(page, 'sess-cw-middleware'))[0];
  expect(natural.cols).toBeLessThan(MIDDLEWARE_RECORDED_GRID.cols);
  expect(natural.rows).toBeLessThanOrEqual(MIDDLEWARE_RECORDED_GRID.rows);
  await expectFaithfulReplay(page, 'sess-cw-middleware');
  await expectPanesFilled(page, 'the default window at 125 percent');
  expect(await firstStreamedSession(page, 10_000, 'sess-cw-middleware')).toBe('sess-cw-middleware');
  const peekChanges = countPeekChanges(page, 'sess-cw-middleware', 30_000);
  expect(await streamedBytes(page, 'sess-cw-middleware', 30_000)).toBeGreaterThan(0);
  expect(await peekChanges).toBeGreaterThan(0);
  expect((await monitorRow(page, 'sess-cw-middleware'))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('loop=1 and still=1 together are refused rather than silently reconciled', async ({ page }) => {
  await page.goto(demoUrl({ view: 'monitor', embed: '1', still: '1', loop: '1' }));
  const card = page.locator('[data-testid="demo-error"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('a still frame has no replay to loop');
});

test('a state= blob carrying a pointer gesture as a step is refused', async ({ page }) => {
  // boot.js's validateState checks a step's SHAPE (one of click/type/press) before it ever
  // checks the per-key allowlist, so a bare `{ hover: ... }` step is refused for missing a
  // discriminant key rather than for naming a gesture key. To reach the allowlist branch and
  // pin its message, the step needs a valid `click` alongside the stray `hover` key. The click
  // target is a real swimlane, which the mutation below depends on: it is a column container
  // with no click handler, so clicking it is a no-op rather than something that opens a dialog.
  const hoverStepBlob = encodeState({
    steps: [{ click: '[data-swimlane-name="Executing"]', hover: '[data-swimlane-name="Executing"]' }],
  });
  await page.goto(demoUrl({ state: hoverStepBlob, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('"hover" is not a boot step');
  // Nothing was seeded: the seed script's afterSeed() call (applyScene) returns before it
  // patches rows or calls __demoApplyFixture whenever validateState already recorded an error,
  // so the board never mounts a single swimlane. Checked only after the card is visible, so this
  // is not a race against a boot that was never going to happen.
  await expect(page.locator('[data-swimlane-name]')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');

  // Positive control, in the same test: a press step carries only one discriminant key (press),
  // so the same state= plumbing validates it and the sample install boots normally.
  const pressStepBlob = encodeState({ steps: [{ press: 'Mouse:Back' }] });
  await gotoScene(page, { state: pressStepBlob, embed: '1', still: '1' });
  await expect(page.locator('[data-testid="demo-error"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'state');
});

test('a state= blob naming only part of a nested config block is refused', async ({ page }) => {
  // The merge is a shallow Object.assign twice over (boot.js into __mockConfigOverrides, then the
  // mock into its defaults), so a nested block REPLACES the default. A partial block used to boot
  // fine with its unnamed siblings undefined, which is a figure that is quietly wrong rather than
  // one that fails. The registry test catches this for SCENES; this is the same guard for the
  // hand-written state= URL the README points developers at.
  const partialBlock = encodeState({ config: { monitor: { layout: 'table' } } });
  await page.goto(demoUrl({ state: partialBlock, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('must name every field');
  // Named, so the fix is mechanical rather than a hunt through AppConfig.
  await expect(errorCard).toContainText('groupBy');
  await expect(page.locator('html')).not.toHaveAttribute('data-demo-ready');

  // Positive control: the same block spelled whole boots, and so does a flat key on its own.
  const wholeBlock = encodeState({
    config: {
      monitor: {
        layout: 'table', groupBy: 'project', sort: 'longest-running', liveOnly: false,
        projectFilter: [], stateFilter: [], textFilter: '',
      },
    },
  });
  await gotoScene(page, { state: wholeBlock, embed: '1', still: '1' });
  await expect(page.locator('[data-testid="demo-error"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-demo-scene', 'state');
});

test('a state= blob that resumes a stopped session is refused', async ({ page }) => {
  // Main marks only a live respawn as resuming, so a resume on a paused session is a state the
  // desktop never draws. validateState refuses it before anything is seeded.
  const stoppedResumeBlob = encodeState({ sessions: { [SESSION_WEBSOCKET]: { resuming: true, status: 'suspended' } } });
  await page.goto(demoUrl({ state: stoppedResumeBlob, embed: '1', still: '1' }));
  const errorCard = page.locator('[data-testid="demo-error"]');
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText('a resuming session is running');
  await expect(page.locator('[data-swimlane-name]')).toHaveCount(0);

  // Positive control, same plumbing: a resume alone boots, and the card reads it.
  await gotoScene(page, { state: encodeState({ sessions: { [SESSION_WEBSOCKET]: { resuming: true } } }), embed: '1', still: '1' });
  await expect(page.locator(`[data-task-id="${TASK_WEBSOCKET}"] [data-testid="usage-bar"]`)).toContainText('Resuming agent...');
});

test('a resuming card comes back in the live frame the way a Resume click does', async ({ page }) => {
  // A still holds the moment (the per-scene boot above). Live, the seed plays what main sends:
  // first output a beat after page open, then the status line's usage, so the card ends on its
  // model and the Monitor row gains its model and context with it.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'session-resume', embed: '1' });
  const card = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
  // The resume starts when the frame reveals, as auto-resume starts once the desktop's window is
  // up, so a live visitor sees the moment the scene is named for. Started at page open, it had
  // already resolved by the reveal.
  expect(await card.locator('[data-testid="usage-bar"]').textContent()).toContain('Resuming agent...');
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });
  // Its first output is timed off the recorded resume boot, so the frame fetched it.
  expect(getRecordingRequests().some((url) => url.includes('/recordings/resume-sess-cw-websocket-'))).toBe(true);
  await expect(card.locator('[data-testid="usage-bar"]')).not.toContainText('Resuming agent...');
  const websocket = DEMO_SESSIONS.find((session) => session.id === SESSION_WEBSOCKET);
  await expect.poll(() => monitorFields(page, SESSION_WEBSOCKET)).toMatchObject({
    modelDisplayName: websocket?.model?.displayName, contextPercent: websocket?.contextPercent,
  });
  // The paused card stays paused: a session paused on purpose does not come back on relaunch.
  await expect(page.locator('[data-task-id="task-cw-empty-states"] [data-testid="status-bar"]')).toContainText('Paused');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('resuming a paused card keeps what its agent last said, and the card never reads Starting agent', async ({ page }) => {
  // A resume continues the paused session's transcript, and main's trail tracker reads its tail on
  // the new session's first read, so the card shows the previous run's last line at once rather
  // than falling back to the task description. The resume goes through the bridge method the
  // task window's Resume control calls.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'session-resume', embed: '1', still: '1' });
  const pausedCard = page.locator('[data-task-id="task-cw-empty-states"]');
  await expect(pausedCard.locator('[data-testid="task-card-trail"]')).toHaveCount(0);
  const footerLabels: string[] = [];
  await page.exposeFunction('__recordFooter', (label: string) => { footerLabels.push(label); });
  await page.evaluate(() => {
    const read = () => document.querySelector('[data-task-id="task-cw-empty-states"] [data-testid="usage-bar"]')?.textContent ?? '';
    new MutationObserver(() => { (window as unknown as { __recordFooter: (label: string) => void }).__recordFooter(read()); })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.evaluate(() => (window as unknown as { electronAPI: { sessions: { resume: (taskId: string) => Promise<unknown> } } })
    .electronAPI.sessions.resume('task-cw-empty-states'));
  await expect(pausedCard.locator('[data-testid="task-card-trail"]')).toBeVisible({ timeout: 10_000 });
  await expect(pausedCard.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });
  // Between the resume and the model, the spinner says Resuming the whole way through.
  expect(footerLabels.some((label) => label.includes('Resuming agent...'))).toBe(true);
  expect(footerLabels.some((label) => label.includes('Starting agent...'))).toBe(false);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('pausing and resuming a working agent brings back the same session and view, not a fresh boot', async ({ page }) => {
  // Main clears the task's session pointer on a pause and finds the paused record again on
  // Resume, and the respawn carries the paused terminal's scrollback over. The demo once read
  // only the pointer, so a Pause then Resume started the task's recorded boot from scratch.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1' });
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');
  await expect(toggle).toHaveAccessibleName('Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_MIDDLEWARE))?.status).toBe('suspended');
  // A paused agent stops: its Monitor peek, which changes every 2.5 to 6 seconds while the
  // recording plays, holds still for longer than the longest gap.
  expect(await countPeekChanges(page, SESSION_MIDDLEWARE, 7000)).toBe(0);

  // Pausing closed the window; the card reopens it on the Resume prompt.
  await page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`).click();
  await expect(toggle).toHaveAccessibleName('Resume session');
  await resumeAndSettle(toggle);

  const readRows = () => page.evaluate(async (taskId) => {
    const sessions = await (window as unknown as { electronAPI: { sessions: { list: () => Promise<Array<{ id: string; taskId: string; status: string; resuming: boolean }>> } } }).electronAPI.sessions.list();
    return sessions.filter((session) => session.taskId === taskId).map((session) => ({ id: session.id, status: session.status, resuming: session.resuming }));
  }, TASK_MIDDLEWARE);
  // The task's only row is the resume: main deletes the paused row when it respawns.
  const rows = await readRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'running', resuming: true });
  expect(rows[0].id).toContain('-resumed-');

  // The terminal opens on the conversation the paused one showed, not on a fresh CLI's prompt.
  const handed = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), rows[0].id));
  expect(handed).toContain('routes file');
  expect(handed).not.toContain('Try "');
  // And it stays there: a resumed agent waits for the user, so nothing streams on.
  const handedAgain = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), rows[0].id));
  expect(handedAgain).toBe(handed);
  // The usage carries over once the resumed agent's status line lands.
  await expect.poll(() => monitorFields(page, rows[0].id), { timeout: 10_000 }).toMatchObject({ status: 'running', contextPercent: DEMO_SESSIONS.find((session) => session.id === SESSION_MIDDLEWARE)?.contextPercent });
  // Paused mid-recording, so the recorded resume boot, which reprints the WHOLE conversation,
  // would show what the frame had not reached: it is never fetched.
  expect(getRecordingRequests().filter((url) => url.includes('/recordings/resume-'))).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('resuming a session paused at its recording\'s end replays the recorded resume boot', async ({ page }) => {
  // The WebSocket session waits on the user at its recording's end, so the conversation a real
  // resume reprints is exactly the one the frame showed: Resume plays the boot the capture matrix
  // recorded (claude --resume, resume-<sessionId>.json) rather than freezing the paused frame.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'board', embed: '1' });
  const card = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');
  await card.click();
  await expect(toggle).toHaveAccessibleName('Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_WEBSOCKET))?.status).toBe('suspended');
  await card.click();
  await expect(toggle).toHaveAccessibleName('Resume session');
  await resumeAndSettle(toggle);

  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/resume-sess-cw-websocket-')), { timeout: 10_000 }).toBe(true);
  const resumedId = await sessionIdsForTask(page, TASK_WEBSOCKET);
  expect(resumedId).toHaveLength(1);
  // The card goes from Resuming to its model once the boot's first output and usage land.
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });
  // The terminal was handed the resumed CLI reprinting the session's own conversation.
  const handed = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), resumedId[0]));
  expect(handed).toContain('exponential');
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a second Pause then Resume on that same session replays the recorded resume boot again', async ({ page }) => {
  // The sibling test above resumes a session paused at its own recording's end, and that resume
  // boot itself counts as "at its end" the moment it starts (resumeBootEntry's endMs: 0), so a
  // SECOND Pause then Resume must replay the same recorded resume boot again rather than freezing
  // whatever frame the resumed terminal happened to show. The lookup for which resume-*.json to
  // fetch has to walk back through recordedIdBySession to the ORIGINAL dataset session
  // (sess-cw-websocket): the first resumed session's own id has no resume-*.json recording of its
  // own, since only an original seeded session was ever captured pausing at a recording's end.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'board', embed: '1' });
  const card = page.locator(`[data-task-id="${TASK_WEBSOCKET}"]`);
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');

  // First cycle: identical to the sibling test above.
  await card.click();
  await expect(toggle).toHaveAccessibleName('Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_WEBSOCKET))?.status).toBe('suspended');
  await card.click();
  await expect(toggle).toHaveAccessibleName('Resume session');
  await resumeAndSettle(toggle);
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/resume-sess-cw-websocket-')), { timeout: 10_000 }).toBe(true);
  const firstResumedIds = await sessionIdsForTask(page, TASK_WEBSOCKET);
  expect(firstResumedIds).toHaveLength(1);
  const firstResumed = firstResumedIds[0];
  expect(firstResumed).toContain('-resumed-');
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });

  // Second cycle, on the resumed session. The window stays open across a resume (only a pause
  // closes it), so there is no card click to reopen it before pausing again here.
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, firstResumed))?.status).toBe('suspended');
  await card.click();
  await expect(toggle).toHaveAccessibleName('Resume session');
  // Listen for streamed bytes BEFORE the click that starts the second resume: the resume-boot
  // path streams the recording live through onData, while a frozen fallback emits nothing at all,
  // so which one (if either) streams for the new session id is the direct signal that the second
  // resume took the boot-replay branch rather than silently falling back to a frozen frame.
  const pendingStreamedSessionId = firstStreamedSession(page, 8000);
  await resumeAndSettle(toggle);

  const secondResumedIds = await sessionIdsForTask(page, TASK_WEBSOCKET);
  expect(secondResumedIds).toHaveLength(1);
  const secondResumed = secondResumedIds[0];
  expect(secondResumed).not.toBe(firstResumed);
  expect(secondResumed).toContain('-resumed-');

  expect(await pendingStreamedSessionId).toBe(secondResumed);
  await expect(card.locator('[data-testid="usage-bar-model"]')).toBeVisible({ timeout: 10_000 });

  const handedSecond = stripAnsi(await page.evaluate((sessionId) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(sessionId), secondResumed));
  expect(handedSecond).toContain('exponential');

  const description = DEMO_TASKS.find((task) => task.id === TASK_WEBSOCKET)?.description;
  expect((await monitorFields(page, secondResumed))?.description).toBe(description);

  expect(getUnexpectedErrors()).toEqual([]);
});

test('a second Pause then Resume on a working agent frozen mid-recording opens on the same frame, not a later one', async ({ page }) => {
  // The middleware session pauses mid-recording (the sibling test above), so its resume takes the
  // frozen-frame path rather than replaying a recorded resume boot. A session resumed that way is
  // itself pausable and resumable again, and on a SECOND cycle the seed must carry the ORIGINAL
  // freeze forward rather than re-deriving a later one from a fresh wall-clock elapsed time: "a
  // session already frozen by an earlier resume stays on its frame". So the second resumed
  // terminal must open on exactly the frame the first one did, not one further into the recording.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1' });
  const toggle = page.locator('[data-testid="header-toggle-session-btn"]');
  const readScrollback = async (sessionId: string): Promise<string> => {
    // Read only once the renderer has resized this session's own terminal: getScrollback fits its
    // frozen frame to the LAST grid it was told about (mountedGeometry), which is unset until that
    // resize call lands. A read before it returns the raw frame and a read after returns the
    // grid-fitted one, a difference the fitter introduces on its own and not the bug this guards.
    await expect.poll(() => mountedGrid(page, sessionId), { timeout: 10_000 }).not.toBeNull();
    return stripAnsi(await page.evaluate((id) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(id), sessionId));
  };

  // First cycle.
  await expect(toggle).toHaveAccessibleName('Pause session');
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, SESSION_MIDDLEWARE))?.status).toBe('suspended');
  await page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`).click();
  await expect(toggle).toHaveAccessibleName('Resume session');
  await resumeAndSettle(toggle);

  const firstResumedIds = await sessionIdsForTask(page, TASK_MIDDLEWARE);
  expect(firstResumedIds).toHaveLength(1);
  const firstResumed = firstResumedIds[0];
  const firstView = await readScrollback(firstResumed);
  expect(firstView).toContain('routes file');

  // A fixed wait, not a poll: the divergence a wrong re-derivation would introduce grows with REAL
  // wall-clock time since the ORIGINAL session's own start, so the gap between cycles has to be an
  // actual span of elapsed time, not a condition to poll for.
  await page.waitForTimeout(4000);

  // Second cycle, on the resumed session.
  await toggle.click();
  await expect.poll(async () => (await monitorFields(page, firstResumed))?.status).toBe('suspended');
  await page.locator(`[data-task-id="${TASK_MIDDLEWARE}"]`).click();
  await expect(toggle).toHaveAccessibleName('Resume session');
  await resumeAndSettle(toggle);

  const secondResumedIds = await sessionIdsForTask(page, TASK_MIDDLEWARE);
  expect(secondResumedIds).toHaveLength(1);
  const secondResumed = secondResumedIds[0];
  expect(secondResumed).not.toBe(firstResumed);
  const secondView = await readScrollback(secondResumed);
  expect(secondView).toBe(firstView);

  // No recorded resume boot was fetched at either cycle: the session paused before its recording
  // reached its own end, so both resumes carried the frozen frame over instead.
  expect(getRecordingRequests().filter((url) => url.includes('/recordings/resume-'))).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a state= blob patching a session the sample install does not seed throws rather than silently no-op-ing', async ({ page }) => {
  // Unlike the refusals above, this is NOT a validateState() check: `sessions` is validated up
  // front for its shape and its fields, not its ids, so a bad id sails through that gate with
  // nothing pushed to `errors`. The "is this id one the sample install seeds" check
  // happens later, inside applyScene()'s __mockPreConfigure callback, called from the generated
  // seed script's bare top-level `window.__demoBoot.afterSeed();` (demo/vite.config.mts) with no
  // try/catch anywhere above it. So the throw is an UNCAUGHT exception, not a caught error: it
  // never reaches the [data-testid="demo-error"] card path at all, and surfaces only as a
  // Playwright pageerror.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); });

  const unknownSessionBlob = encodeState({ sessions: { 'sess-does-not-exist': { status: 'queued' } } });
  await page.goto(demoUrl({ state: unknownSessionBlob, embed: '1', still: '1' }));
  await expect
    .poll(() => pageErrors.some((message) => message.includes('Scene patches session "sess-does-not-exist", which the sample install does not contain')))
    .toBe(true);

  // Positive control, same plumbing: patching a session id the sample install DOES seed throws
  // nothing and boots clean.
  pageErrors.length = 0;
  const knownSessionBlob = encodeState({ sessions: { [DEMO_SESSIONS[0].id]: { status: 'queued' } } });
  await gotoScene(page, { state: knownSessionBlob, embed: '1', still: '1' });
  expect(pageErrors).toEqual([]);
});

test('the live task scene fetches its session recording from the serving origin', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'task', embed: '1' });
  await SCENE_MARKERS.task(page);
  await expect.poll(() => getRecordingRequests().length, { timeout: 10_000 }).toBeGreaterThan(0);
  const offOrigin = getRecordingRequests().filter((url) => !url.startsWith(`${server.origin}/`));
  expect(offOrigin).toEqual([]);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('dragging a To Do card into Executing starts its agent from the recorded boot', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board' });
  // The boot recording is fetched at spawn time (its first window's arrival time is what fires
  // the session's first output), so the request listener attaches before the drag.
  const getRecordingRequests = recordingRequests(page);
  const streamed = firstStreamedSession(page, 20_000);
  await dragCardToColumn(page, 'Add user auth flow', 'Executing');

  // The card now carries a running session, as it would after main's transition engine ran.
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const tasks = await api.tasks.list();
    const sessions = await api.sessions.list();
    const task = tasks.find((row) => row.title === 'Add user auth flow');
    const session = task?.session_id ? sessions.find((row) => row.id === task.session_id) : undefined;
    return session?.status ?? null;
  }), { timeout: 10_000 }).toBe('running');

  // Opening the card mounts its terminal once the session's first output is reported; the boot
  // recorded for this task in the lane's permission mode replays into it, and the bytes after
  // the mount arrive through the mock's onData path.
  await page.locator('[data-testid="swimlane"]').locator('text=Add user auth flow').first().click();
  await expect(page.locator('[data-testid="task-title-text"]')).toHaveText('Add user auth flow');
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/spawn-task-cw-auth-acceptEdits-')), { timeout: 15_000 }).toBe(true);
  const recordingUrl = getRecordingRequests().find((url) => url.includes('/recordings/spawn-task-cw-auth-acceptEdits-')) as string;
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    return (await api.tasks.list()).find((row) => row.title === 'Add user auth flow')?.session_id ?? null;
  });
  expect(sessionId).not.toBeNull();
  await expectStreamedOrStill(page, sessionId as string, streamed);
  // The context bar's spinner gives way to the pills once the session's usage is pushed, a beat
  // after its first output, as main's status-line push does on the desktop.
  await expect(page.getByText('Starting agent...')).toHaveCount(0, { timeout: 15_000 });
  // The recording ships its own last displayed lines beside the stream: the Monitor row's output
  // peek once the boot has played out (too long for this tier to wait on, so the contract is checked).
  const recording = await (await page.request.get(recordingUrl)).json() as { peek?: unknown };
  expect(Array.isArray(recording.peek) && recording.peek.length > 0).toBe(true);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a new Command Terminal boots the project default agent from the recorded boot', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  const getRecordingRequests = recordingRequests(page);
  await gotoScene(page, { view: 'board' });
  // The toggle reattaches the project's existing Command Terminal (its own recording); "New
  // terminal" is what spawns another, and that one boots the project's default agent.
  await page.locator('[data-testid="quick-session-button"]').click();
  await expect(page.locator('[data-testid="command-terminal-new"]')).toBeVisible();
  const streamed = firstStreamedSession(page, 20_000);
  await page.locator('[data-testid="command-terminal-new"]').click();
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running').length;
  }), { timeout: 10_000 }).toBeGreaterThan(1);
  // The project already has a running Command Terminal, so the new window opens tiled beside
  // it and boots the recording made at that size, not the single-window one.
  await expect.poll(() => getRecordingRequests().some((url) => url.includes('/recordings/terminal-proj-contoso-web-tiled-')), { timeout: 15_000 }).toBe(true);
  const sessionId = await page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running' && row.id !== 'sess-cw-terminal-1').map((row) => row.id)[0] ?? null;
  });
  expect(sessionId).not.toBeNull();
  await expectStreamedOrStill(page, sessionId as string, streamed);
  await expect(page.getByText('Starting agent...')).toHaveCount(0, { timeout: 15_000 });
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a still of the tiled Command Terminals paints the first window from its tiled recording', async ({ page }) => {
  // The scene's pose opens the first window, which paints at its single width, and then docks the
  // second beside it. A still has no clock to repaint from, so the seed repaints it for the tiled
  // layout (repaintStill). Without that it kept the single recording's frame cut to the narrower
  // pane, with its closing rows wrapped: the poster the site crops showed the wrong run. The two
  // recordings are separate runs of one prompt: the tiled one's turn ends "Cogitated for 36s", the
  // single one's "Churned for 9s". Single words, since a frame moves the cursor over a space.
  await gotoScene(page, { view: 'command-terminal-tiled', embed: '1', still: '1' });
  const paintedFrame = () => page.evaluate((sessionId) => (window as unknown as { __demoPainted?: Record<string, { frame: string }> }).__demoPainted?.[sessionId]?.frame ?? '', SESSION_CONTOSO_TERMINAL);
  await expect.poll(paintedFrame, { timeout: 10_000 }).toContain('Cogitated');
  expect(await paintedFrame()).not.toContain('Churned');
});

test('a finished Command Terminal that tiles beside a new one rests on its tiled run\'s end and plays none of it on', async ({ page }) => {
  // The tiled recording is a second, longer run of the prompt (70 s against the single's 46 s),
  // and the session's clock is the single's, which the idle session has already reached. So the
  // tiled run ends with it (playedEndMs): the window repaints once, to the tiled run's final frame,
  // and then receives nothing. It used to replay the 24 s the tiled run outlasted the single, a
  // working agent repainted every 110 ms under a card that read finished. Read off the data path,
  // so it holds whether the pane takes bytes or the emulator's frames.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.addInitScript((sessionId) => {
    const received: string[] = [];
    (window as unknown as { __tiledTerminalData: string[] }).__tiledTerminalData = received;
    (window as unknown as { __mockDataListeners: Array<(id: string, data: string) => void> }).__mockDataListeners = [
      (id, data) => { if (id === sessionId) received.push(data); },
    ];
  }, SESSION_CONTOSO_TERMINAL);
  await gotoScene(page, { view: 'command-terminal-tiled', embed: '1' });
  const received = () => page.evaluate(() => (window as unknown as { __tiledTerminalData: string[] }).__tiledTerminalData.slice());
  await expect.poll(async () => (await received()).some((data) => data.includes('Cogitated')), { timeout: 10_000 }).toBe(true);
  const settled = (await received()).length;
  // A run still playing repaints every REPAINT_INTERVAL_MS, so two seconds of nothing is many of them.
  await page.waitForTimeout(2000);
  expect((await received()).length, 'a finished session receives nothing once it has repainted').toBe(settled);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('Stop on the tiled scene\'s second Command Terminal takes its Monitor row and its replay with it', async ({ page }) => {
  // killTransient is main's endCommandTerminal: the terminal's row goes, and with it the Monitor's
  // row, since main's snapshot reads the live sessions. The seed also forgets the session's replay,
  // so a stopped terminal has nothing left to read back. What the replay's clock would emit is the
  // next test's: by the time this scene reaches its pose the second window's boot is over, so
  // watching its data path here would assert nothing.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'command-terminal-tiled', embed: '1' });
  const secondWindow = page.locator('[data-command-slot="slot-2"]');
  const sessionId = await secondWindow.locator('[data-testid="command-bar-terminal-pane"]').getAttribute('data-session-id');
  if (!sessionId) throw new Error('the scene docked no second terminal');
  const monitorHas = () => page.evaluate((id) => ((window as unknown as DemoMonitorWindow).__mockMonitorRows ?? []).some((row) => row.sessionId === id), sessionId);
  const registryHas = () => page.evaluate(async (id) => (await (window as unknown as DemoElectronWindow).electronAPI.sessions.list()).some((row) => row.id === id), sessionId);
  const scrollback = () => page.evaluate((id) => (window as unknown as DemoElectronWindow).electronAPI.sessions.getScrollback(id), sessionId);
  await expect.poll(monitorHas, { message: 'a running Command Terminal is a Monitor row' }).toBe(true);
  expect(await registryHas(), 'and a live session').toBe(true);
  expect((await scrollback()).length, 'its replay has a screen to read back').toBeGreaterThan(0);

  await secondWindow.locator('[data-testid="command-bar-terminate-button"]').click();
  await expect(secondWindow).toHaveCount(0);
  await expect.poll(monitorHas, { message: 'Stop takes the terminal\'s Monitor row' }).toBe(false);
  expect(await registryHas(), 'and the session').toBe(false);
  expect(await scrollback(), 'a stopped terminal has no replay left to read back').toBe('');
  expect(getUnexpectedErrors()).toEqual([]);
});

interface StopTap {
  /** Chunks delivered through the mock's data path, per session. */
  chunks: Record<string, number>;
  /** The session the tap stopped on its first chunk, and whether its Monitor row still existed when it did. */
  stopped: { sessionId: string; rowExisted: boolean } | null;
  /** Each session's chunk count at the moment its killTransient resolved. */
  killedAt: Record<string, number>;
  arm: () => void;
}

test('Stop on a Command Terminal ends its recorded boot: no chunk reaches it once Stop returns', async ({ page }) => {
  // The seed ends the replay of a stopped terminal, or its clock would go on emitting into nothing,
  // one more each time a visitor starts and stops one. A project with no Command Terminal yet boots
  // its first alone, on the recording's own grid, so its chunks go out as bytes through the mock's
  // data path; a terminal on any other grid is fed by the emulator, whose repaints already stop
  // when the pane unmounts, so it would show nothing here. The stop is made in the page, from the
  // tap, at the boot's FIRST chunk, because a Playwright round trip (a hundred milliseconds or
  // more) can land after the next one and would leave nothing to suppress.
  test.setTimeout(60_000);
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.addInitScript(() => {
    const WINDOW = '[data-testid="command-terminal-window"]';
    const chunks: Record<string, number> = {};
    let armed = false;
    const tap: StopTap = { chunks, stopped: null, killedAt: {}, arm: () => { armed = true; } };
    (window as unknown as { __stopTap: StopTap }).__stopTap = tap;
    // The mock adds its listeners to this list rather than replacing it (mock-electron-api.js).
    (window as unknown as { __mockDataListeners: Array<(sessionId: string, data: string) => void> }).__mockDataListeners = [
      (sessionId) => {
        chunks[sessionId] = (chunks[sessionId] ?? 0) + 1;
        if (!armed) return;
        const pane = document.querySelector(`${WINDOW} [data-testid="command-bar-terminal-pane"]`);
        if (pane?.getAttribute('data-session-id') !== sessionId) return;
        armed = false;
        const rows = (window as unknown as { __mockMonitorRows?: Array<{ sessionId: string }> }).__mockMonitorRows ?? [];
        tap.stopped = { sessionId, rowExisted: rows.some((row) => row.sessionId === sessionId) };
        setTimeout(() => document.querySelector<HTMLElement>(`${WINDOW} [data-testid="command-bar-terminate-button"]`)?.click(), 0);
      },
    ];
  });
  await gotoScene(page, { view: 'board' });
  // spring-petclinic has no Command Terminal yet, so opening the layer boots one alone.
  await page.locator('[data-testid="sidebar-project-list"]').getByText('spring-pet', { exact: false }).first().click();
  // Chunks are counted at the moment killTransient resolves, in the page: that is after the seed
  // has ended the replay and taken the row, so a chunk between the click and then is legitimate,
  // and a poll from here would read the count too late to tell (the whole boot is over within
  // about a second).
  await page.evaluate(() => {
    const tap = (window as unknown as { __stopTap: StopTap }).__stopTap;
    const sessions = (window as unknown as { electronAPI: { sessions: { killTransient: (sessionId: string) => Promise<unknown> } } }).electronAPI.sessions;
    const seeded = sessions.killTransient;
    sessions.killTransient = (sessionId) => seeded.call(sessions, sessionId).then((result) => {
      tap.killedAt[sessionId] = tap.chunks[sessionId] ?? 0;
      return result;
    });
    tap.arm();
  });
  await page.locator('[data-testid="quick-session-button"]').click();
  const readTap = () => page.evaluate(() => {
    const { chunks, stopped, killedAt } = (window as unknown as { __stopTap: StopTap }).__stopTap;
    return { chunks: { ...chunks }, stopped, killedAt: { ...killedAt } };
  });
  await expect.poll(async () => (await readTap()).stopped, { timeout: 15_000, message: 'the terminal streamed and was stopped on its first chunk' }).not.toBeNull();
  const stopped = (await readTap()).stopped;
  if (!stopped) throw new Error('the tap never stopped a terminal');
  expect(stopped.rowExisted, 'the Monitor knew the terminal before it was stopped').toBe(true);
  // A fresh spawn. Had the project switch not landed before the toggle click, the layer would reattach
  // the sample install's own terminal, whose repaints the unmount guard silences and which proves nothing.
  expect(DEMO_SESSIONS.map((session) => session.id), 'a new session, not a seeded one reattached').not.toContain(stopped.sessionId);
  await expect.poll(async () => (await readTap()).killedAt[stopped.sessionId], { message: 'killTransient resolved' }).toBeGreaterThan(0);
  const chunksAtKill = (await readTap()).killedAt[stopped.sessionId];
  // Whether this run fed the terminal bytes (where the check has teeth) or the emulator's frames.
  const replayMode = await page.evaluate((id) => (window as unknown as { __demoReplayMode?: Record<string, string> }).__demoReplayMode?.[id] ?? 'none', stopped.sessionId);
  test.info().annotations.push({ type: 'replay mode', description: replayMode });
  // A fixed window, since nothing can be polled for "never": the rest of the boot is a few hundred
  // milliseconds apart and over within about a second of its first chunk, so two seconds has room
  // to catch a clock left running.
  await page.waitForTimeout(2_000);
  expect((await readTap()).chunks[stopped.sessionId], 'no chunk reaches a stopped terminal').toBe(chunksAtKill);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('a Command Terminal that tiles beside a new one repaints from the boot recorded at the tiled width', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  // The panel opens maximized, as in the tiled scene: in the 1600px frame only a maximized panel
  // holds two terminals at the 650px floor, and at its default place the second would open
  // expanded over the first instead of tiling beside it.
  const maximizedPanel = { config: { commandTerminalPanel: { x: 0.18, y: 0.15, w: 0.64, h: 0.7, maximized: true } } };
  await gotoScene(page, { view: 'board', state: encodeState(maximizedPanel) });
  // spring-petclinic has no Command Terminal yet, so opening the layer boots one alone, at the
  // single-window width.
  await page.locator('[data-testid="sidebar-project-list"]').getByText('spring-pet', { exact: false }).first().click();
  await page.locator('[data-testid="quick-session-button"]').click();
  await expect(page.locator('[data-testid="command-terminal-new"]')).toBeVisible();
  const transientIds = () => page.evaluate(async () => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const sessions = await api.sessions.list();
    return sessions.filter((row) => row.transient && row.status === 'running' && row.projectId === 'proj-spring-petclinic').map((row) => row.id);
  });
  await expect.poll(transientIds, { timeout: 10_000 }).toHaveLength(1);
  const [firstId] = await transientIds();
  // Let that terminal mount alone first: the repaint under test is what its resize triggers.
  await expect.poll(() => mountedGrid(page, firstId), { timeout: 10_000 }).not.toBeNull();
  // The desktop's PTY resize makes the CLI repaint at the tiled width; the frame does the same
  // from the tiled recording, starting with a cleared screen (after leaving the alternate
  // screen, so the clear lands on the buffer the boot is written into).
  const repainted = page.evaluate(({ sessionId, timeout }) => new Promise<boolean>((resolve) => {
    const api = (window as unknown as DemoElectronWindow).electronAPI;
    const timer = setTimeout(() => resolve(false), timeout);
    const unsubscribe = api.sessions.onData((id, data) => {
      if (id !== sessionId || !data.replace(/^\x1b\[\?1049l/, '').startsWith('\x1b[2J\x1b[3J')) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  }), { sessionId: firstId, timeout: 15_000 });
  await page.locator('[data-testid="command-terminal-new"]').click();
  await expect.poll(transientIds, { timeout: 10_000 }).toHaveLength(2);
  expect(await repainted).toBe(true);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('opened directly, the page hosts the frame at the site size and scales it to the window', async ({ page }) => {
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${server.url}?view=board`);
  // Without embed=1 or stage=0 the page hands over to the host, which keeps the frame at 1600
  // by 1000 (the size every recording was made for) and scales it down to the window.
  await expect(page).toHaveURL(/stage\.html\?view=board$/);
  const frame = page.locator('iframe#stage');
  await expect(frame).toHaveAttribute('src', /[?&]stage=0/);
  await expect(page.frameLocator('iframe#stage').locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: 20_000 });
  const geometry = await page.evaluate(() => {
    const element = document.getElementById('stage') as HTMLIFrameElement;
    return { width: element.offsetWidth, height: element.offsetHeight, scale: Number(document.documentElement.getAttribute('data-stage-scale')) };
  });
  expect(geometry.width).toBe(1600);
  expect(geometry.height).toBe(1000);
  expect(geometry.scale).toBeCloseTo(Math.min(1280 / 1600, 720 / 1000), 2);
  expect(getUnexpectedErrors()).toEqual([]);
});

test('the site\'s take-control dialog at a 1440 by 900 display fills the task window', async ({ browser }) => {
  // kangentic.com gives the dialog's frame a 1233 by 771 box there, where the task window fits
  // well under the recording's columns and 26 rows: the case in which every wrapped row used to
  // spill (task #673). The scene's window is fitted against the 1600px frame the recordings were
  // measured at, so in this smaller frame it keeps the stage's proportions, about 118 columns on
  // Windows. The session's tiled recording is laid out for 115, so the pane shows it at the
  // configured type (layoutFor), widened to the pane, where the single recording held at its own
  // grid left the width beside it empty. A face that measures the pane narrower than 113 holds
  // the tiled recording at a smaller type instead; either way the terminal fills the pane and the
  // emulator plays the recording into it from the moment the session's clock began, which keeps
  // the session working.
  const context = await browser.newContext({ viewport: { width: 1233, height: 771 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await page.goto(demoUrl({ view: 'task', embed: '1' }));
  await waitForDemoReady(page);
  await SCENE_MARKERS.task(page);
  await expect.poll(() => sentGrids(page, 'sess-cw-middleware'), { timeout: 10_000 }).not.toHaveLength(0);
  const natural = (await sentGrids(page, 'sess-cw-middleware'))[0];
  expect(natural.cols).toBeLessThan(MIDDLEWARE_RECORDED_GRID.cols * 0.9);
  const state = await expectFaithfulReplay(page, 'sess-cw-middleware');
  expect(state.mode).toBe('frames');
  await expectPanesFilled(page, 'the take-control dialog');
  expect(await firstStreamedSession(page, 10_000, 'sess-cw-middleware')).toBe('sess-cw-middleware');
  expect((await monitorRow(page, 'sess-cw-middleware'))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
  await context.close();
});

test('the board\'s bottom panel is live, where no grid could ever fit a recording', async ({ page }) => {
  // The panel is about 14 rows and a session recording is 37, which no font size reconciles: the
  // hold would need type under 40 percent of the configured size, below its floor, so at every display
  // scale this is the frame path. It is also the default layout, so it is the one a visitor
  // meets the product through. Every frame it paints is physical rows fitted to the panel: no
  // row wider than the grid, so nothing can wrap or spill, and the hold never engages.
  const getUnexpectedErrors = collectUnexpectedErrors(page);
  await gotoScene(page, { view: 'board', embed: '1' });
  await SCENE_MARKERS.board(page);
  const grid = await mountedGrid(page, 'sess-cw-middleware');
  // The row count rides on the font's cell height, so this pins what the test is about rather
  // than one platform's count: a pane too short for the hold's floor (HOLD_MIN_SCALE, 0.6).
  expect(grid?.rows ?? 0).toBeGreaterThan(0);
  expect((grid?.rows ?? 0) / MIDDLEWARE_RECORDED_GRID.rows).toBeLessThan(0.6);
  expect(await sentGrids(page, 'sess-cw-middleware')).not.toContainEqual(MIDDLEWARE_RECORDED_GRID);
  const frames = await paintedFrameRowWidths(page, 'sess-cw-middleware', 8_000);
  expect(frames.length).toBeGreaterThan(0);
  for (const rows of frames) {
    expect(rows.length).toBeGreaterThan(0);
    for (const width of rows) expect(width).toBeLessThanOrEqual(grid?.cols ?? 0);
  }
  expect((await monitorRow(page, 'sess-cw-middleware'))?.activity).toBe('thinking');
  expect(getUnexpectedErrors()).toEqual([]);
});
