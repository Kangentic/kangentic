/**
 * UI tests for the Command Terminal rail's Earlier list: the behavior that
 * `tests/ui/command-terminal.spec.ts` leaves out.
 *
 *  - A row whose name field is open stays mounted when it scrolls out of the
 *    virtualized window (`rangeExtractor`, `editingKey`).
 *  - The failure paths of Rename and Remove (`commitName`, `confirmRemove`),
 *    driven by the mock's `__mockCommandTerminalHistoryRefusal` knob.
 *  - The search hook's guards (`useEarlierSearch`): a slow answer for an older
 *    query never replaces a newer one, a query that does not extend the answered
 *    one drops its text rows, and a project switch empties the field.
 *
 * Every test owns its browser, so the file fans out across the UI workers.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const VIEWPORT = { width: 2560, height: 1440 };

const PROJECT_ID = 'proj-earlier-extra';
const OTHER_PROJECT_ID = 'proj-earlier-other';

interface SeededEntry {
  agentSessionId: string;
  label: string | null;
  firstPrompt: string | null;
  agentName: string;
  endedAt: string;
}

interface EarlierHost {
  __mockRenameCommandTerminalHistoryCalls?: Array<{ projectId: string; agentSessionId: string; name: string }>;
  __mockRemoveCommandTerminalHistoryCalls?: Array<{ projectId: string; agentSessionId: string }>;
  __mockHeldCommandTerminalHistorySearches?: Record<string, () => void>;
}

/** Rows named `Conversation N`, newest first, as the existing Earlier cases seed them. */
function namedEntries(count: number, prefix = 'Conversation', idPrefix = 'conversation'): SeededEntry[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    agentSessionId: `${idPrefix}-${index + 1}`,
    label: `${prefix} ${index + 1}`,
    firstPrompt: null,
    agentName: 'claude',
    endedAt: new Date(now - (index + 1) * 60 * 60 * 1000).toISOString(),
  }));
}

/** The mock keeps one swimlane set for every project, so only the first project seeds lanes. */
function projectBlock(id: string, name: string, projectPath: string, laneKey: string | null): string {
  const lanes = laneKey === null ? '' : `
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'lane-${laneKey}-' + i, position: i, created_at: ts }));
    });`;
  return `
    state.projects.push({
      id: '${id}',
      name: '${name}',
      path: '${projectPath}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });${lanes}
  `;
}

/** One project, open, with the given history. */
function earlierPreConfig(entries: SeededEntry[]): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      ${projectBlock(PROJECT_ID, 'Earlier Extra', '/mock/earlier-extra', 'earlier-extra')}
      return { currentProjectId: '${PROJECT_ID}' };
    });
    window.__mockCommandTerminalHistory = { '${PROJECT_ID}': ${JSON.stringify(entries)} };
  `;
}

/** Two projects, each with its own history, the first open. */
function twoProjectPreConfig(first: SeededEntry[], second: SeededEntry[]): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      ${projectBlock(PROJECT_ID, 'Earlier Extra', '/mock/earlier-extra', 'earlier-extra')}
      ${projectBlock(OTHER_PROJECT_ID, 'Earlier Other', '/mock/earlier-other', null)}
      return { currentProjectId: '${PROJECT_ID}' };
    });
    window.__mockCommandTerminalHistory = {
      '${PROJECT_ID}': ${JSON.stringify(first)},
      '${OTHER_PROJECT_ID}': ${JSON.stringify(second)},
    };
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/** Open the panel, which starts its one terminal, and wait for the rail's Earlier list. */
async function openPanel(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
  await expect(page.getByTestId('command-terminal-earlier')).toBeVisible();
}

function earlierRow(page: Page, agentSessionId: string) {
  return page.locator(`[data-testid="command-terminal-earlier-row"][data-agent-session-id="${agentSessionId}"]`);
}

/** A row's menu, opened by a right-click on the row itself. */
async function openRowMenu(page: Page, agentSessionId: string): Promise<void> {
  await earlierRow(page, agentSessionId).click({ button: 'right' });
  await expect(page.getByTestId('command-terminal-earlier-menu')).toBeVisible();
}

async function startRename(page: Page, agentSessionId: string) {
  await openRowMenu(page, agentSessionId);
  await page.getByTestId('command-terminal-earlier-menu-rename').click();
  const field = page.getByTestId('command-terminal-earlier-name-field');
  await expect(field).toBeFocused();
  return field;
}

async function seedWindow(page: Page, values: Record<string, unknown>): Promise<void> {
  await page.evaluate((seed) => { Object.assign(window, seed); }, values);
}

function toastNamed(page: Page, title: string) {
  return page.getByTestId('toast').filter({ hasText: title });
}

test.describe('Earlier list: an open name field', () => {
  test('stays mounted with its typed value when its row scrolls out of the window, and saves from there', async () => {
    const count = 300;
    const { browser, page } = await launchWithState(earlierPreConfig(namedEntries(count)));
    try {
      await openPanel(page);
      const list = page.getByTestId('command-terminal-earlier');
      await expect(earlierRow(page, 'conversation-1')).toBeVisible();

      const field = await startRename(page, 'conversation-1');
      await field.fill('Typed name');

      // Far enough that the top rows leave the virtualized window.
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(earlierRow(page, `conversation-${count}`)).toBeVisible();
      // The window really moved: a neighbor of the editing row is gone from the DOM.
      await expect(earlierRow(page, 'conversation-2')).toHaveCount(0);

      // The row being edited is still there, field and typed text intact, though off screen.
      await expect(page.getByTestId('command-terminal-earlier-name-field')).toHaveCount(1);
      await expect(page.getByTestId('command-terminal-earlier-name-field')).toHaveValue('Typed name');
      // Nothing was saved by the row leaving the window.
      expect(await page.evaluate(() => (window as unknown as EarlierHost).__mockRenameCommandTerminalHistoryCalls)).toBeUndefined();

      await list.evaluate((element) => { element.scrollTop = 0; });
      await expect(earlierRow(page, 'conversation-2')).toBeVisible();
      await expect(page.getByTestId('command-terminal-earlier-name-field')).toHaveValue('Typed name');
      await page.getByTestId('command-terminal-earlier-name-field').press('Enter');

      await expect(earlierRow(page, 'conversation-1')).toContainText('Typed name');
      await expect(page.getByTestId('command-terminal-earlier-name-field')).toHaveCount(0);
      const calls = await page.evaluate(() => (window as unknown as EarlierHost).__mockRenameCommandTerminalHistoryCalls);
      expect(calls).toEqual([{ projectId: PROJECT_ID, agentSessionId: 'conversation-1', name: 'Typed name' }]);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Earlier list: Rename and Remove that fail', () => {
  test('a rename main refuses drops the pending name and the row shows what it held', async () => {
    const { browser, page } = await launchWithState(earlierPreConfig(namedEntries(3)));
    try {
      await openPanel(page);
      await seedWindow(page, { __mockCommandTerminalHistoryRefusal: { rename: 'refuse' } });

      const field = await startRename(page, 'conversation-1');
      await field.fill('Refused name');
      await field.press('Enter');

      // The call went out, so the early return for an unchanged name is not what kept the old one.
      await expect.poll(() => page.evaluate(() => (window as unknown as EarlierHost).__mockRenameCommandTerminalHistoryCalls?.length ?? 0)).toBe(1);
      await expect(earlierRow(page, 'conversation-1')).toContainText('Conversation 1');
      await expect(earlierRow(page, 'conversation-1')).not.toContainText('Refused name');
      await expect(page.getByTestId('command-terminal-earlier-name-field')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a rename that rejects toasts why and the row shows what it held', async () => {
    const { browser, page } = await launchWithState(earlierPreConfig(namedEntries(3)));
    try {
      await openPanel(page);
      await seedWindow(page, {
        __mockCommandTerminalHistoryRefusal: {
          rename: 'reject',
          message: "Error invoking remote method 'commandTerminalHistory:rename': Error: disk is full",
        },
      });

      const field = await startRename(page, 'conversation-1');
      await field.fill('Lost name');
      await field.press('Enter');

      const toast = toastNamed(page, "Couldn't rename conversation");
      await expect(toast).toBeVisible();
      // Electron's channel and class decoration is stripped, and the reason reads as a sentence.
      await expect(toast.getByTestId('toast-body')).toHaveText('Disk is full.');
      await expect(earlierRow(page, 'conversation-1')).toContainText('Conversation 1');
      await expect(earlierRow(page, 'conversation-1')).not.toContainText('Lost name');
    } finally {
      await browser.close();
    }
  });

  test('a remove main refuses toasts that a terminal has the conversation open, and the row stays', async () => {
    const { browser, page } = await launchWithState(earlierPreConfig(namedEntries(3)));
    try {
      await openPanel(page);
      await seedWindow(page, { __mockCommandTerminalHistoryRefusal: { remove: 'refuse' } });

      await openRowMenu(page, 'conversation-1');
      await page.getByTestId('command-terminal-earlier-menu-remove').click();
      await page.getByTestId('command-terminal-earlier-remove-confirm').click();

      const toast = toastNamed(page, "Couldn't remove conversation");
      await expect(toast).toBeVisible();
      await expect(toast.getByTestId('toast-body')).toHaveText('A terminal has this conversation open.');
      // The call went out and the list was not changed.
      expect(await page.evaluate(() => (window as unknown as EarlierHost).__mockRemoveCommandTerminalHistoryCalls)).toEqual([
        { projectId: PROJECT_ID, agentSessionId: 'conversation-1' },
      ]);
      await expect(earlierRow(page, 'conversation-1')).toBeVisible();
      await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(3);
    } finally {
      await browser.close();
    }
  });

  test('a remove that rejects toasts the reason, and the row stays', async () => {
    const { browser, page } = await launchWithState(earlierPreConfig(namedEntries(3)));
    try {
      await openPanel(page);
      await seedWindow(page, {
        __mockCommandTerminalHistoryRefusal: {
          remove: 'reject',
          message: "Error invoking remote method 'commandTerminalHistory:remove': Error: the store is locked",
        },
      });

      await openRowMenu(page, 'conversation-2');
      await page.getByTestId('command-terminal-earlier-menu-remove').click();
      await page.getByTestId('command-terminal-earlier-remove-confirm').click();

      const toast = toastNamed(page, "Couldn't remove conversation");
      await expect(toast).toBeVisible();
      await expect(toast.getByTestId('toast-body')).toHaveText('The store is locked.');
      expect(await page.evaluate(() => (window as unknown as EarlierHost).__mockRemoveCommandTerminalHistoryCalls)).toEqual([
        { projectId: PROJECT_ID, agentSessionId: 'conversation-2' },
      ]);
      await expect(earlierRow(page, 'conversation-2')).toBeVisible();
      await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(3);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Earlier list: search answers', () => {
  const searchEntries: SeededEntry[] = [
    { agentSessionId: 'by-apple', agentName: 'claude', label: 'Alpha notes', firstPrompt: null, endedAt: new Date().toISOString() },
    { agentSessionId: 'by-banana', agentName: 'claude', label: 'Beta notes', firstPrompt: null, endedAt: new Date().toISOString() },
    { agentSessionId: 'by-none', agentName: 'claude', label: 'Gamma notes', firstPrompt: null, endedAt: new Date().toISOString() },
  ];
  const searchText = { 'by-apple': 'an apple a day', 'by-banana': 'one banana split' };

  /** Wait until main holds the answer for `query`, then hand back control. */
  async function waitUntilHeld(page: Page, query: string): Promise<void> {
    await page.waitForFunction(
      (held) => typeof (window as unknown as EarlierHost).__mockHeldCommandTerminalHistorySearches?.[held] === 'function',
      query,
    );
  }

  async function release(page: Page, query: string): Promise<void> {
    await page.evaluate((held) => (window as unknown as EarlierHost).__mockHeldCommandTerminalHistorySearches?.[held]?.(), query);
  }

  test('a slow answer for an older query landing after the newer one does not replace it', async () => {
    const { browser, page } = await launchWithState(earlierPreConfig(searchEntries));
    try {
      await openPanel(page);
      await seedWindow(page, {
        __mockHoldCommandTerminalHistorySearchPerQuery: true,
        __mockCommandTerminalHistoryText: searchText,
      });
      const field = page.getByTestId('command-terminal-earlier-search');

      // The first query is asked and its answer is slow.
      await field.fill('apple');
      await waitUntilHeld(page, 'apple');
      // A query that does not extend it is asked after, and answered first.
      await field.fill('banana');
      await waitUntilHeld(page, 'banana');
      await release(page, 'banana');
      await expect(earlierRow(page, 'by-banana')).toBeVisible();
      await expect(page.getByTestId('command-terminal-earlier-searching')).toHaveCount(0);

      // The older answer lands now. Two frames is more than the promise chain it needs.
      await release(page, 'apple');
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      // The newer answer still stands: its row is shown, and the stale one's is not.
      await expect(earlierRow(page, 'by-banana')).toBeVisible();
      await expect(earlierRow(page, 'by-apple')).toHaveCount(0);
      await expect(page.getByTestId('command-terminal-earlier-searching')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a shorter query does not extend the answered one, so its text rows drop and main is asked again', async () => {
    const { browser, page } = await launchWithState(earlierPreConfig(searchEntries));
    try {
      await openPanel(page);
      await seedWindow(page, { __mockCommandTerminalHistoryText: searchText });
      const field = page.getByTestId('command-terminal-earlier-search');

      await field.fill('apple');
      await expect(page.locator('[data-agent-session-id="by-apple"] mark')).toHaveText('apple');

      // The new answer is held, so the stale one is the only text answer there is.
      await seedWindow(page, { __mockHoldCommandTerminalHistorySearch: true });
      await field.fill('appl');
      await expect(earlierRow(page, 'by-apple')).toHaveCount(0);
      await expect(page.getByTestId('command-terminal-earlier-searching')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('Earlier list: project switch', () => {
  test('a project switch starts the list with an empty search field', async () => {
    const first = namedEntries(2, 'Alpha', 'alpha');
    const second = namedEntries(2, 'Beta', 'beta');
    const { browser, page } = await launchWithState(twoProjectPreConfig(first, second));
    try {
      await openPanel(page);
      const field = page.getByTestId('command-terminal-earlier-search');
      await field.fill('Alpha');
      await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(2);
      await expect(field).toHaveValue('Alpha');

      // The panel normally closes on a project switch and the list unmounts with it. Hold it
      // open through the switch (as a pending open does), so only the list's key can reset it.
      await page.evaluate(async (otherProjectId) => {
        const stores = (window as unknown as {
          __zustandStores: {
            session: {
              getState: () => { commandBarVisible: boolean };
              setState: (partial: { commandBarVisible: boolean }) => void;
              subscribe: (listener: (state: { commandBarVisible: boolean }) => void) => () => void;
            };
            project: { getState: () => { openProject: (id: string) => Promise<void> } };
          };
        }).__zustandStores;
        stores.session.subscribe((state) => {
          if (!state.commandBarVisible) stores.session.setState({ commandBarVisible: true });
        });
        await stores.project.getState().openProject(otherProjectId);
      }, OTHER_PROJECT_ID);

      // The other project's own conversations, none of them filtered by the old query.
      await expect(earlierRow(page, 'beta-1')).toBeVisible();
      await expect(earlierRow(page, 'beta-2')).toBeVisible();
      await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(2);
      await expect(page.getByTestId('command-terminal-earlier-search')).toHaveValue('');
    } finally {
      await browser.close();
    }
  });
});
