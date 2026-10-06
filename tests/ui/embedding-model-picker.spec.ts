/**
 * UI tests for the Knowledge Graph tab's two cards: the Knowledge Graph (one
 * switch; the local model's tiered picker and status row, then the agent), and
 * the Index (one line per source and one Rebuild). Every line state is pinned by
 * `tests/unit/index-sources.test.ts`; these check the wiring.
 */
import { test, expect, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'proj-embed-picker';

/** Seed a project and the polled model status (config for knowledgeGraph.enabled is set
 *  post-launch via the config store, which is the mechanism the store honors). */
function makePreConfig(modelState: string, progress?: number, summaries?: object, code?: object, sources?: object): string {
  const memoryStatus = {
    code,
    sources,
    indexingEnabled: true,
    semantic: modelState === 'ready' ? 'hybrid' : 'downloading',
    activeBackend: modelState === 'ready' ? 'DirectML (GPU)' : undefined,
    model: {
      id: 'bge-small',
      displayName: 'bge small',
      tier: 'light',
      approxSizeMb: 33,
      dimensions: 384,
      state: modelState,
      progress,
    },
    summaries,
  };
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Embed Picker', path: '/mock/embed-picker',
        github_url: null, default_agent: 'claude', position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push(Object.assign({}, template, { id: state.uuid(), position: index, created_at: ts }));
      });
      return {
        currentProjectId: '${PROJECT_ID}',
        memoryStatus: ${JSON.stringify(memoryStatus)},
      };
    });
  `;
}

/** Seeds a `semantic: 'error'` status (the embed worker crashed past its
 *  restart cap), with or without a `workerError` detail string. */
function makeErrorPreConfig(workerError?: string): string {
  const memoryStatus = {
    indexingEnabled: true,
    semantic: 'error',
    activeBackend: undefined,
    workerError,
    model: {
      id: 'bge-small',
      displayName: 'bge small',
      tier: 'light',
      approxSizeMb: 34,
      dimensions: 384,
      state: 'error',
    },
  };
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Embed Picker', path: '/mock/embed-picker',
        github_url: null, default_agent: 'claude', position: 0, last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push(Object.assign({}, template, { id: state.uuid(), position: index, created_at: ts }));
      });
      return {
        currentProjectId: '${PROJECT_ID}',
        memoryStatus: ${JSON.stringify(memoryStatus)},
      };
    });
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
  // Turn the Knowledge Graph on in config (the dropdown + rows are gated on it) via
  // the same config.set + store-reload path the settings UI uses.
  await page.evaluate(() =>
    window.electronAPI.config.set({ knowledgeGraph: { indexingEnabled: true, enabled: true, localModel: 'bge-small' } }),
  );
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { loadConfig: () => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().loadConfig();
  });
  return { browser, page };
}

/**
 * What is wrong with where a caution or failure row puts its warning icon, or
 * an empty list when it is right. The icon sits inline BEFORE the row's label
 * (it used to hang in a gutter beside the tile), starting on the tile's content
 * edge, which is the left edge of the card's own icon, and on the label's line.
 *
 * `row` is the tile (`CardStatusRow`) or the line (`CardSourceLine`) holding
 * the one icon. Every edge is read in one evaluate and compared to another
 * edge with a real tolerance, so font metrics and the panel's slide-in do not
 * matter.
 */
function warningPlacementProblems(row: Locator): Promise<string[]> {
  return row.evaluate((rowElement) => {
    const EDGE_TOLERANCE_PX = 1.5;
    const SAME_LINE_TOLERANCE_PX = 3;
    const icons = rowElement.querySelectorAll('svg.text-warning, svg.text-danger');
    if (icons.length !== 1) return [`expected one warning icon, found ${icons.length}`];
    const icon = icons[0];
    // The label is the span beside the icon: the icon's parent holds the icon and the label.
    const label = icon.parentElement?.querySelector(':scope > span');
    const card = rowElement.closest('section[aria-label]');
    const cardIcon = card?.children[0]?.querySelector('span[aria-hidden="true"]');
    if (!label || !cardIcon) return ['the row\'s label or its card\'s icon is missing'];

    const iconBox = icon.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    const problems: string[] = [];
    if (Math.abs(iconBox.left - cardIcon.getBoundingClientRect().left) > EDGE_TOLERANCE_PX) {
      problems.push(`the icon starts at ${iconBox.left}, not on the card icon's left edge ${cardIcon.getBoundingClientRect().left}`);
    }
    if (iconBox.right > labelBox.left + EDGE_TOLERANCE_PX) {
      problems.push(`the icon ends at ${iconBox.right}, past the label's start ${labelBox.left}`);
    }
    const centerOffset = Math.abs((iconBox.top + iconBox.bottom) / 2 - (labelBox.top + labelBox.bottom) / 2);
    if (centerOffset > SAME_LINE_TOLERANCE_PX) problems.push(`the icon and label centres are ${centerOffset}px apart`);
    return problems;
  });
}

async function openKnowledgeGraphTab(page: Page) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  // By id: the id is what deep links and saved last-tab state address.
  await page.getByTestId('settings-tab-knowledgeGraph').click();
}

/** Write Knowledge Graph settings through the path the settings UI uses, then reload the store. */
async function setKnowledgeGraph(page: Page, knowledgeGraph: Record<string, unknown>) {
  await page.evaluate((partial) => window.electronAPI.config.set({ knowledgeGraph: partial }), knowledgeGraph);
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { loadConfig: () => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().loadConfig();
  });
}

test.describe('Embedding model picker', () => {
  test('lists the tiers and shows the Ready card when the model is cached', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openKnowledgeGraphTab(page);

      const choice = page.getByTestId('embedding-model-choice');
      await expect(choice).toBeVisible();
      // Two tiers, best-first, in the words dictation's Mode uses - the concrete
      // model name is NOT in the label.
      await expect(choice.getByRole('radio')).toHaveText(['Best', 'Light']);
      await expect(page.getByTestId('embedding-model-bge-small')).toHaveAttribute('aria-checked', 'true');
      // The selected model's license, as a link under its status.
      await expect(page.getByTestId('embedding-model-license-link')).toHaveText('MIT');

      // The status row carries the concrete model name, its size and where it runs.
      // "Local model", never "Model": the agent's Model row sits below it.
      await expect(page.getByTestId('embedding-model-card-label')).toHaveText('Local model');
      await expect(page.getByTestId('embedding-model-ready')).toHaveText('bge small, 33 MB, DirectML (GPU)');
      await expect(page.getByTestId('embedding-model-card').getByRole('progressbar')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('shows download progress while the model is downloading', async () => {
    const { browser, page } = await launchWithState(makePreConfig('downloading', 0.42));
    try {
      await openKnowledgeGraphTab(page);
      const card = page.getByTestId('embedding-model-card');
      await expect(page.getByTestId('embedding-model-card-label')).toHaveText('Downloading');
      await expect(page.getByTestId('embedding-model-card-text')).toHaveText('42%, bge small');
      await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
      await expect(page.getByTestId('embedding-model-ready')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a model not on disk yet reads as Downloading at 0%, never as waiting', async () => {
    const { browser, page } = await launchWithState(makePreConfig('absent'));
    try {
      await openKnowledgeGraphTab(page);
      await expect(page.getByTestId('embedding-model-card-label')).toHaveText('Downloading');
      await expect(page.getByTestId('embedding-model-card-text')).toHaveText('0%, bge small');
    } finally {
      await browser.close();
    }
  });

  test('a failed download tints the label, puts the warning before it, and keeps the model name neutral', async () => {
    const { browser, page } = await launchWithState(makePreConfig('error'));
    try {
      await openKnowledgeGraphTab(page);
      const label = page.getByTestId('embedding-model-card-label');
      await expect(label).toHaveText('Download failed');
      await expect(label).toHaveClass(/text-danger/);
      await expect(page.getByTestId('embedding-model-card-text')).toHaveText('bge small');
      await expect(page.getByTestId('embedding-model-card-text')).not.toHaveClass(/text-danger/);
      // Polled: the panel slides in, and the edges are read once it settles.
      await expect.poll(() => warningPlacementProblems(page.getByTestId('embedding-model-card')), { timeout: 5000 }).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('selecting a different model persists knowledgeGraph.localModel', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openKnowledgeGraphTab(page);
      await page.getByTestId('embedding-model-granite-r2').click();

      // The change flows through updateConfig -> config.set -> refetch, so the
      // config store reflects the new selection.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { config: { getState: () => { config: { knowledgeGraph?: { localModel?: string } } } } };
            }).__zustandStores;
            return stores?.config.getState().config.knowledgeGraph?.localModel;
          }),
        )
        .toBe('granite-r2');
    } finally {
      await browser.close();
    }
  });

  // bge-base and bge-large left the registry. A config still holding either id
  // runs the default model in main (`resolveEmbeddingModel`), so the picker has
  // to show that model as selected and the License line has to name ITS license.
  // The selected segment alone cannot tell a resolved id from the raw one: the
  // SegmentedControl falls back to its first option (Granite) for an unknown value.
  for (const retiredModelId of ['bge-base', 'bge-large']) {
    test(`a stored retired model (${retiredModelId}) reads as the default: Granite selected, with its license`, async () => {
      const { browser, page } = await launchWithState(makePreConfig('ready'));
      try {
        await setKnowledgeGraph(page, { localModel: retiredModelId });
        // The config really holds the retired id, so the picker is resolving it.
        expect(await page.evaluate(async () => (await window.electronAPI.config.get()).knowledgeGraph?.localModel))
          .toBe(retiredModelId);
        await openKnowledgeGraphTab(page);

        await expect(page.getByTestId('embedding-model-choice')).toBeVisible();
        await expect(page.getByTestId('embedding-model-granite-r2')).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('embedding-model-bge-small')).toHaveAttribute('aria-checked', 'false');
        // Granite R2 ships under Apache-2.0 (bge small is MIT).
        await expect(page.getByTestId('embedding-model-license-link')).toHaveText('Apache-2.0');
      } finally {
        await browser.close();
      }
    });
  }

  test('lists the acceleration options, defaults to Auto, and names the active backend', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openKnowledgeGraphTab(page);
      const choice = page.getByTestId('knowledge-graph-acceleration-choice');
      await expect(choice).toBeVisible();
      await expect(choice.getByRole('radio')).toHaveText(['Auto', 'GPU', 'CPU']);
      await expect(page.getByTestId('knowledge-graph-acceleration-auto')).toHaveAttribute('aria-checked', 'true');
      // The status line names the execution provider the worker actually initialized on.
      await expect(page.getByTestId('embedding-model-ready')).toContainText('DirectML (GPU)');
    } finally {
      await browser.close();
    }
  });

  test('selecting a different acceleration persists knowledgeGraph.acceleration', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openKnowledgeGraphTab(page);
      await page.getByTestId('knowledge-graph-acceleration-cpu').click();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { config: { getState: () => { config: { knowledgeGraph?: { acceleration?: string } } } } };
            }).__zustandStores;
            return stores?.config.getState().config.knowledgeGraph?.acceleration;
          }),
        )
        .toBe('cpu');
    } finally {
      await browser.close();
    }
  });

});

test.describe('Knowledge Graph card', () => {
  test('one switch holds the local model and the agent, and stays visible with its prerequisite', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openKnowledgeGraphTab(page);
      const card = page.getByTestId('knowledge-graph-card');
      const agentRow = page.getByTestId('knowledge-graph-answer-agent');
      const qualityRow = page.getByTestId('embedding-model-choice');

      const description = 'Finds your work by meaning and answers questions.';
      // On: the local model's rows, then the agent's, in setup order. One agent
      // answers and writes the summaries: no second set of rows.
      await expect(card).toContainText('Knowledge Graph');
      await expect(card).toContainText(description);
      await expect(card).not.toContainText('Needs ');
      await expect(qualityRow).toBeVisible();
      await expect(agentRow).toBeVisible();
      const qualityBox = await qualityRow.boundingBox();
      const agentBox = await agentRow.boundingBox();
      expect(qualityBox && agentBox && qualityBox.y < agentBox.y).toBe(true);
      await expect(page.getByTestId('knowledge-graph-answer-agent')).toHaveCount(1);
      // The first card on the tab: the feature, then the index it reads.
      const indexBox = await page.getByTestId('index-card').boundingBox();
      const cardBox = await card.boundingBox();
      expect(cardBox && indexBox && cardBox.y < indexBox.y).toBe(true);

      // Off: the card stays, keeps its description, and hides both models' rows.
      await setKnowledgeGraph(page, { enabled: false });
      await expect(card).toBeVisible();
      await expect(card).toContainText(description);
      await expect(page.getByRole('switch', { name: 'Knowledge Graph' })).toHaveAttribute('aria-checked', 'false');
      await expect(agentRow).toHaveCount(0);
      await expect(qualityRow).toHaveCount(0);

      // Indexing off: it names its own prerequisite.
      await setKnowledgeGraph(page, { indexingEnabled: false });
      await expect(card).toContainText('Needs indexing');

      // Still switchable, never a dead end: it reads off while the index is
      // off, and turning it on turns the index on in the same write.
      const graphSwitch = page.getByRole('switch', { name: 'Knowledge Graph' });
      await setKnowledgeGraph(page, { enabled: true });
      await expect(graphSwitch).toHaveAttribute('aria-checked', 'false');
      await expect(graphSwitch).toBeEnabled();
      await graphSwitch.click();
      await expect.poll(() => page.evaluate(async () => {
        const config = (await window.electronAPI.config.get()).knowledgeGraph;
        return { enabled: config?.enabled, indexingEnabled: config?.indexingEnabled };
      })).toEqual({ enabled: true, indexingEnabled: true });
      await expect(card).not.toContainText('Needs indexing');
      await expect(graphSwitch).toHaveAttribute('aria-checked', 'true');
      await expect(qualityRow).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('Index card', () => {
  const SOURCES = {
    conversations: { count: 1002, percent: null, minutesLeft: null },
    tasks: { count: 684, percent: null, minutesLeft: null },
    commits: { count: 2419, percent: null, minutesLeft: null },
  };
  const SUMMARIES = { written: 0, finishedTasks: 674, skipped: 0, state: 'idle', retryInMs: null, minutesLeft: null, writtenWith: [], choice: null, awaitingRewrite: 0 };
  const CODE = { state: 'estimate', files: 1488, passages: 12186, embedded: 0, minutesLeft: 28 };
  const AGENT = { agent: 'claude', model: 'sonnet' };

  const valueOf = (page: Page, source: string) => page.getByTestId(`index-source-${source}-value`);

  test('lists every source on one line: the counts with a check, and the switchable two on by default', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, SUMMARIES, CODE, SOURCES));
    try {
      await setKnowledgeGraph(page, AGENT);
      await openKnowledgeGraphTab(page);
      const card = page.getByTestId('index-card');
      await expect(card).toContainText('Index');
      await expect(card).toContainText('What Quick Find and the Knowledge Graph search.');
      // Session changes only feed the summaries, so they are not a line.
      await expect(page.getByTestId('index-sources')).not.toContainText('Session changes');

      // Always on: the count and a check, on a locked switch.
      for (const [source, count] of [['conversations', '1,002'], ['tasks', '684'], ['commits', '2,419']]) {
        await expect(valueOf(page, source)).toHaveText(count);
        await expect(valueOf(page, source).locator('svg')).toHaveCount(1);
        const locked = page.getByTestId(`index-source-${source}-locked`);
        await expect(locked).toHaveAttribute('aria-checked', 'true');
        await expect(locked).toBeDisabled();
      }

      // On by default: nothing is spent until an agent is chosen.
      await expect(page.getByTestId('setting-row-knowledgeGraph.taskSummaries')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('setting-row-knowledgeGraph.sourceCode')).toHaveAttribute('aria-checked', 'true');

      // Switched off: only what they would cover, muted, with no call count or time.
      await setKnowledgeGraph(page, { taskSummaries: false, sourceCode: false });
      await expect(page.getByTestId('setting-row-knowledgeGraph.taskSummaries')).toHaveAttribute('aria-checked', 'false');
      await expect(valueOf(page, 'summaries')).toHaveText('674 tasks');
      await expect(valueOf(page, 'code')).toHaveText('1,488 files');
      await expect(valueOf(page, 'code')).toHaveClass(/text-fg-muted/);

      await page.getByTestId('setting-row-knowledgeGraph.sourceCode').click();
      await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.get()).knowledgeGraph?.sourceCode)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('the switchable two wait on the Knowledge Graph, then an agent, and can be switched off while they wait', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, SUMMARIES, CODE, SOURCES));
    try {
      await openKnowledgeGraphTab(page);
      // No agent chosen: the agent writes the summaries, and only its answers
      // read the code index, so both wait. The always-on three do not.
      for (const source of ['summaries', 'code']) {
        await expect(page.getByTestId(`index-source-${source}`)).toContainText('Needs an agent');
      }
      await expect(valueOf(page, 'conversations')).toHaveText('1,002');
      // On by default, so waiting they stay switchable: turned off here, the
      // agent chosen next never starts them.
      const summariesSwitch = page.getByTestId('setting-row-knowledgeGraph.taskSummaries');
      await expect(summariesSwitch).toBeEnabled();
      await expect(summariesSwitch).toHaveAttribute('aria-checked', 'true');
      await summariesSwitch.click();
      await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.get()).knowledgeGraph?.taskSummaries)).toBe(false);
      await expect(page.getByTestId('setting-row-knowledgeGraph.sourceCode')).toBeEnabled();
      await setKnowledgeGraph(page, { taskSummaries: true });

      // An agent whose run takes a model: the summaries wait for the model too.
      await setKnowledgeGraph(page, { agent: 'claude' });
      await expect(page.getByTestId('index-source-summaries')).toContainText('Needs a model');
      await expect(page.getByTestId('setting-row-knowledgeGraph.sourceCode')).toBeEnabled();

      // The Knowledge Graph off: both are found by meaning.
      await setKnowledgeGraph(page, { ...AGENT, enabled: false });
      for (const source of ['summaries', 'code']) {
        await expect(page.getByTestId(`index-source-${source}`)).toContainText('Needs the Knowledge Graph');
      }
    } finally {
      await browser.close();
    }
  });

  test('a running source keeps its line, with the share, the time left and a track', async () => {
    const running = {
      ...SOURCES,
      conversations: { count: 1002, percent: 40, minutesLeft: 5 },
    };
    const summaries = { ...SUMMARIES, written: 148, state: 'writing', minutesLeft: 3 };
    const code = { ...CODE, state: 'indexing', embedded: 4210, minutesLeft: 150 };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, summaries, code, running));
    try {
      await setKnowledgeGraph(page, { ...AGENT, taskSummaries: true, sourceCode: true });
      await openKnowledgeGraphTab(page);
      await expect(valueOf(page, 'conversations')).toHaveText('40%, 5 min left');
      await expect(page.getByRole('progressbar', { name: 'Conversations embedded' })).toHaveAttribute('aria-valuenow', '40');
      // 148 of 674 is 21.9%, and 4,210 of 12,186 is 34.5%: rounded down.
      await expect(valueOf(page, 'summaries')).toHaveText('21%, 3 min left');
      await expect(valueOf(page, 'code')).toHaveText('34%, 2.5 hr left');
      await expect(page.getByRole('progressbar', { name: 'Source code embedded' })).toHaveAttribute('aria-valuenow', '34');
      // No verb: the line's name says what runs.
      await expect(page.getByTestId('index-sources')).not.toContainText(/Writing|Indexing/);
    } finally {
      await browser.close();
    }
  });

  test('a failed call tints its state word and puts the warning before its name; the rest stays neutral', async () => {
    const summaries = { ...SUMMARIES, written: 200, state: 'retrying', retryInMs: 5 * 60_000 };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, summaries, CODE, SOURCES));
    try {
      await setKnowledgeGraph(page, { ...AGENT, taskSummaries: true });
      await openKnowledgeGraphTab(page);
      const value = valueOf(page, 'summaries');
      await expect(value).toHaveText('A call failed, retrying in 5 min');
      await expect(value.locator('.text-warning')).toHaveText('A call failed');
      await expect(page.getByTestId('index-source-summaries').locator('svg.text-warning')).toHaveCount(1);
      // Polled: the panel slides in, and the edges are read once it settles.
      await expect.poll(() => warningPlacementProblems(page.getByTestId('index-source-summaries')), { timeout: 5000 }).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('Rebuild runs at once when it would spend nothing', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, SUMMARIES, CODE, SOURCES));
    try {
      await openKnowledgeGraphTab(page);
      await expect(page.getByTestId('knowledge-graph-rebuild-row')).toContainText('Reads every source again, in every project.');
      await page.getByTestId('knowledge-graph-rebuild-index').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0))
        .toBe(1);
      await expect(page.getByTestId('rebuild-confirm')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a second click while the plan is still being read starts no second rebuild', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, SUMMARIES, CODE, SOURCES));
    try {
      await openKnowledgeGraphTab(page);
      // The mock answers the plan at once, so the read is held open here: the
      // first plan call waits for `__releaseRebuildPlan`, and any later call
      // (the mock's own `rebuildIndex` asks for a plan too) gets the mock's answer.
      await page.evaluate(() => {
        const scope = window as unknown as {
          electronAPI: { knowledgeGraph: { rebuildPlan: () => Promise<{ summariesToRewrite: number }> } };
          __rebuildPlanCalls: number;
          __releaseRebuildPlan: () => void;
        };
        const knowledgeGraph = scope.electronAPI.knowledgeGraph;
        const mockPlan = knowledgeGraph.rebuildPlan;
        scope.__rebuildPlanCalls = 0;
        knowledgeGraph.rebuildPlan = () => {
          scope.__rebuildPlanCalls += 1;
          if (scope.__rebuildPlanCalls > 1) return mockPlan.call(knowledgeGraph);
          return new Promise((resolve) => {
            scope.__releaseRebuildPlan = () => resolve({ summariesToRewrite: 0 });
          });
        };
      });
      const rebuildCalls = () => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0);
      const planCalls = () => page.evaluate(() => (window as unknown as { __rebuildPlanCalls: number }).__rebuildPlanCalls);
      const rebuildButton = page.getByTestId('knowledge-graph-rebuild-index');

      await rebuildButton.click();
      // The button is committed from the click, not only once the rebuild starts.
      await expect(rebuildButton).toBeDisabled();
      // A click on the disabled button: forced, since a user's press does not
      // wait for the control to be enabled. A disabled native button dispatches
      // no click, so the disabled state asserted above is the guard this pins;
      // the counts below confirm the second press started nothing.
      await rebuildButton.click({ force: true });

      // The click handler is synchronous, so both counts are already final:
      // one plan asked for, and no rebuild started while it is pending.
      expect(await planCalls()).toBe(1);
      expect(await rebuildCalls()).toBe(0);

      await page.evaluate(() => (window as unknown as { __releaseRebuildPlan: () => void }).__releaseRebuildPlan());
      await expect.poll(rebuildCalls).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('Rebuild asks first when summaries were written with another model, naming none', async () => {
    const sonnet = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
    const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };
    const summaries = { ...SUMMARIES, written: 674, choice: opus, writtenWith: [{ ...sonnet, count: 674 }] };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, summaries, CODE, SOURCES));
    try {
      await setKnowledgeGraph(page, { agent: 'claude', model: 'claude-opus-5-5', taskSummaries: true });
      await openKnowledgeGraphTab(page);
      // Written with another model: the count, and no check until rewritten.
      await expect(valueOf(page, 'summaries')).toHaveText('674');
      await expect(valueOf(page, 'summaries').locator('svg')).toHaveCount(0);

      await page.getByTestId('knowledge-graph-rebuild-index').click();
      const confirm = page.getByTestId('rebuild-confirm');
      await expect(confirm).toContainText('Rebuild everything?');
      await expect(confirm).toContainText('Conversations, tasks, commits, summaries and source code are all rebuilt, in every project.');
      await expect(confirm).toContainText('The 674 summaries written with an earlier model are rewritten, about 68 calls in the background.');
      await expect(confirm).not.toContainText(/Sonnet|Opus/);
      // A rebuild that skipped the confirm would have gone out on the click
      // itself, so with the dialog showing, one read is the whole check. A poll
      // for zero passes on its first sample and only looks like a wait.
      expect(await page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0))
        .toBe(0);

      await confirm.getByRole('button', { name: 'Rebuild' }).click();
      await expect(confirm).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0))
        .toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('Cancel on the Rebuild confirm closes it and rebuilds nothing', async () => {
    const sonnet = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
    const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };
    const summaries = { ...SUMMARIES, written: 674, choice: opus, writtenWith: [{ ...sonnet, count: 674 }] };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, summaries, CODE, SOURCES));
    const rebuildCalls = () => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0);
    try {
      await setKnowledgeGraph(page, { agent: 'claude', model: 'claude-opus-5-5', taskSummaries: true });
      await openKnowledgeGraphTab(page);
      const rebuildButton = page.getByTestId('knowledge-graph-rebuild-index');
      const confirm = page.getByTestId('rebuild-confirm');

      await rebuildButton.click();
      await expect(confirm).toContainText('Rebuild everything?');
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);

      // The rebuild request goes out synchronously from the confirm's own click
      // handler, so once the dialog is gone the count is final: no poll needed.
      expect(await rebuildCalls()).toBe(0);
      // Nothing is left running: the button is back to its idle label and enabled.
      await expect(rebuildButton).toHaveText('Rebuild');
      await expect(rebuildButton).toBeEnabled();

      // Cancelling forgot nothing and locked nothing: asking again asks again,
      // and confirming that one is the only rebuild there is.
      await rebuildButton.click();
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Rebuild' }).click();
      await expect(confirm).toHaveCount(0);
      expect(await rebuildCalls()).toBe(1);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Local model error state', () => {
  test('shows the worker error detail when the local model fails to start', async () => {
    const { browser, page } = await launchWithState(makeErrorPreConfig('exit 1: Cannot find module sharp'));
    try {
      await openKnowledgeGraphTab(page);
      const status = page.getByTestId('semantic-status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText(
        'The local model stopped - showing keyword matches. (exit 1: Cannot find module sharp)',
      );
    } finally {
      await browser.close();
    }
  });

  test('falls back to the generic message when no worker error detail is available', async () => {
    const { browser, page } = await launchWithState(makeErrorPreConfig());
    try {
      await openKnowledgeGraphTab(page);
      const status = page.getByTestId('semantic-status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText('The local model failed to start - showing keyword matches.');
    } finally {
      await browser.close();
    }
  });
});
