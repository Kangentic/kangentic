/**
 * UI tests for the Knowledge Graph tab's two cards: the Knowledge Graph (one
 * switch; the local model's tiered picker and status row, then the agent), and
 * the Index (one line per source and one Rebuild). Every line state is pinned by
 * `tests/unit/index-sources.test.ts`; these check the wiring.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'proj-embed-picker';

/** Seed a project and the polled model status (config for semanticEnabled is set
 *  post-launch via the config store, which is the mechanism the store honors). */
function makePreConfig(modelState: string, progress?: number, digests?: object, code?: object, sources?: object): string {
  const memoryStatus = {
    code,
    sources,
    indexingEnabled: true,
    semantic: modelState === 'ready' ? 'hybrid' : 'downloading',
    activeBackend: modelState === 'ready' ? 'DirectML (GPU)' : undefined,
    model: {
      id: 'bge-small',
      displayName: 'bge small',
      tier: 'balanced',
      approxSizeMb: 34,
      dimensions: 384,
      state: modelState,
      progress,
    },
    digests,
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
      tier: 'balanced',
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
    window.electronAPI.config.set({ memory: { indexingEnabled: true, semanticEnabled: true, embeddingModel: 'bge-small' } }),
  );
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { loadConfig: () => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().loadConfig();
  });
  return { browser, page };
}

async function openMemoryTab(page: Page) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  // By id: the id is what deep links and saved last-tab state address.
  await page.getByTestId('settings-tab-memory').click();
}

/** Write memory settings through the path the settings UI uses, then reload the store. */
async function setMemory(page: Page, memory: Record<string, unknown>) {
  await page.evaluate((partial) => window.electronAPI.config.set({ memory: partial }), memory);
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
      await openMemoryTab(page);

      const select = page.getByTestId('embedding-model-select');
      await expect(select).toBeVisible();
      // Three curated tiers, all bge-*-en-v1.5 (best-first) - the concrete
      // model name is NOT in the label.
      await expect(select.locator('option')).toHaveText(['Best accuracy', 'Accurate', 'Balanced']);

      // The status row carries the concrete model name, its size and where it runs.
      // "Local model", never "Model": the agent's Model row sits below it.
      await expect(page.getByTestId('embedding-model-card-label')).toHaveText('Local model');
      await expect(page.getByTestId('embedding-model-ready')).toHaveText('bge small, 34 MB, DirectML (GPU)');
      await expect(page.getByTestId('embedding-model-card').getByRole('progressbar')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('shows download progress while the model is downloading', async () => {
    const { browser, page } = await launchWithState(makePreConfig('downloading', 0.42));
    try {
      await openMemoryTab(page);
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
      await openMemoryTab(page);
      await expect(page.getByTestId('embedding-model-card-label')).toHaveText('Downloading');
      await expect(page.getByTestId('embedding-model-card-text')).toHaveText('0%, bge small');
    } finally {
      await browser.close();
    }
  });

  test('a failed download tints the label and keeps the model name neutral', async () => {
    const { browser, page } = await launchWithState(makePreConfig('error'));
    try {
      await openMemoryTab(page);
      const label = page.getByTestId('embedding-model-card-label');
      await expect(label).toHaveText('Download failed');
      await expect(label).toHaveClass(/text-danger/);
      await expect(page.getByTestId('embedding-model-card-text')).toHaveText('bge small');
      await expect(page.getByTestId('embedding-model-card-text')).not.toHaveClass(/text-danger/);
    } finally {
      await browser.close();
    }
  });

  test('selecting a different model persists memory.embeddingModel', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openMemoryTab(page);
      await page.getByTestId('embedding-model-select').selectOption('bge-base');

      // The change flows through updateConfig -> config.set -> refetch, so the
      // config store reflects the new selection.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { config: { getState: () => { config: { memory?: { embeddingModel?: string } } } } };
            }).__zustandStores;
            return stores?.config.getState().config.memory?.embeddingModel;
          }),
        )
        .toBe('bge-base');
    } finally {
      await browser.close();
    }
  });

  test('lists the acceleration options, defaults to Auto, and names the active backend', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openMemoryTab(page);
      const choice = page.getByTestId('memory-acceleration-choice');
      await expect(choice).toBeVisible();
      await expect(choice.getByRole('radio')).toHaveText(['Auto', 'GPU', 'CPU']);
      await expect(page.getByTestId('memory-acceleration-auto')).toHaveAttribute('aria-checked', 'true');
      // The status line names the execution provider the worker actually initialized on.
      await expect(page.getByTestId('embedding-model-ready')).toContainText('DirectML (GPU)');
    } finally {
      await browser.close();
    }
  });

  test('selecting a different acceleration persists memory.acceleration', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openMemoryTab(page);
      await page.getByTestId('memory-acceleration-cpu').click();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { config: { getState: () => { config: { memory?: { acceleration?: string } } } } };
            }).__zustandStores;
            return stores?.config.getState().config.memory?.acceleration;
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
      await openMemoryTab(page);
      const card = page.getByTestId('knowledge-graph-card');
      const agentRow = page.getByTestId('memory-answer-agent');
      const qualityRow = page.getByTestId('embedding-model-select');

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
      await expect(page.getByTestId('memory-digest-agent')).toHaveCount(0);
      // The first card on the tab: the feature, then the index it reads.
      const indexBox = await page.getByTestId('index-card').boundingBox();
      const cardBox = await card.boundingBox();
      expect(cardBox && indexBox && cardBox.y < indexBox.y).toBe(true);

      // Off: the card stays, keeps its description, and hides both models' rows.
      await setMemory(page, { semanticEnabled: false });
      await expect(card).toBeVisible();
      await expect(card).toContainText(description);
      await expect(page.getByRole('switch', { name: 'Knowledge Graph' })).toHaveAttribute('aria-checked', 'false');
      await expect(agentRow).toHaveCount(0);
      await expect(qualityRow).toHaveCount(0);

      // Indexing off: it names its own prerequisite.
      await setMemory(page, { indexingEnabled: false });
      await expect(card).toContainText('Needs indexing');
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
  const DIGESTS = { written: 0, finishedTasks: 674, skipped: 0, state: 'idle', retryInMs: null, minutesLeft: null, writtenWith: [], choice: null, awaitingRewrite: 0 };
  const CODE = { state: 'estimate', branch: 'origin/main', files: 1488, passages: 12186, embedded: 0, minutesLeft: 28 };
  const AGENT = { answerAgent: 'claude', answerModel: 'sonnet' };

  const valueOf = (page: Page, source: string) => page.getByTestId(`index-source-${source}-value`);

  test('lists every source on one line: the counts with a check, and the opt-in two on by default', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, DIGESTS, CODE, SOURCES));
    try {
      await setMemory(page, AGENT);
      await openMemoryTab(page);
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
      await expect(page.getByTestId('setting-row-memory.taskDigests')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('setting-row-memory.codeIndex')).toHaveAttribute('aria-checked', 'true');

      // Switched off: only what they would cover, muted, with no call count or time.
      await setMemory(page, { taskDigests: false, codeIndex: false });
      await expect(page.getByTestId('setting-row-memory.taskDigests')).toHaveAttribute('aria-checked', 'false');
      await expect(valueOf(page, 'summaries')).toHaveText('674 tasks');
      await expect(valueOf(page, 'code')).toHaveText('1,488 files');
      await expect(valueOf(page, 'code')).toHaveClass(/text-fg-muted/);

      await page.getByTestId('setting-row-memory.codeIndex').click();
      await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.get()).memory?.codeIndex)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('the opt-in two wait on the Knowledge Graph, then an agent, and can be switched off while they wait', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, DIGESTS, CODE, SOURCES));
    try {
      await openMemoryTab(page);
      // No agent chosen: the agent writes the summaries, and only its answers
      // read the code index, so both wait. The always-on three do not.
      for (const source of ['summaries', 'code']) {
        await expect(page.getByTestId(`index-source-${source}`)).toContainText('Needs an agent');
      }
      await expect(valueOf(page, 'conversations')).toHaveText('1,002');
      // On by default, so waiting they stay switchable: turned off here, the
      // agent chosen next never starts them.
      const summariesSwitch = page.getByTestId('setting-row-memory.taskDigests');
      await expect(summariesSwitch).toBeEnabled();
      await expect(summariesSwitch).toHaveAttribute('aria-checked', 'true');
      await summariesSwitch.click();
      await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.get()).memory?.taskDigests)).toBe(false);
      await expect(page.getByTestId('setting-row-memory.codeIndex')).toBeEnabled();
      await setMemory(page, { taskDigests: true });

      // An agent whose run takes a model: the summaries wait for the model too.
      await setMemory(page, { answerAgent: 'claude' });
      await expect(page.getByTestId('index-source-summaries')).toContainText('Needs a model');
      await expect(page.getByTestId('setting-row-memory.codeIndex')).toBeEnabled();

      // The Knowledge Graph off: both are found by meaning.
      await setMemory(page, { ...AGENT, semanticEnabled: false });
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
    const digests = { ...DIGESTS, written: 148, state: 'writing', minutesLeft: 3 };
    const code = { ...CODE, state: 'indexing', embedded: 4210, minutesLeft: 150 };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, digests, code, running));
    try {
      await setMemory(page, { ...AGENT, taskDigests: true, codeIndex: true });
      await openMemoryTab(page);
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

  test('a failed call tints its state word and puts the warning in the gutter; the rest stays neutral', async () => {
    const digests = { ...DIGESTS, written: 200, state: 'retrying', retryInMs: 5 * 60_000 };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, digests, CODE, SOURCES));
    try {
      await setMemory(page, { ...AGENT, taskDigests: true });
      await openMemoryTab(page);
      const value = valueOf(page, 'summaries');
      await expect(value).toHaveText('A call failed, retrying in 5 min');
      await expect(value.locator('.text-warning')).toHaveText('A call failed');
      await expect(page.getByTestId('index-source-summaries').locator('svg.text-warning')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('Rebuild runs at once when it would spend nothing', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, DIGESTS, CODE, SOURCES));
    try {
      await openMemoryTab(page);
      await expect(page.getByTestId('memory-rebuild-row')).toContainText('Reads every source again, in every project.');
      await page.getByTestId('memory-rebuild-index').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0))
        .toBe(1);
      await expect(page.getByTestId('rebuild-confirm')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Rebuild asks first when summaries were written with another model, naming none', async () => {
    const sonnet = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
    const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };
    const digests = { ...DIGESTS, written: 674, choice: opus, writtenWith: [{ ...sonnet, count: 674 }] };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, digests, CODE, SOURCES));
    try {
      await setMemory(page, { answerAgent: 'claude', answerModel: 'claude-opus-5-5', taskDigests: true });
      await openMemoryTab(page);
      // Written with another model: the count, and no check until rewritten.
      await expect(valueOf(page, 'summaries')).toHaveText('674');
      await expect(valueOf(page, 'summaries').locator('svg')).toHaveCount(0);

      await page.getByTestId('memory-rebuild-index').click();
      const confirm = page.getByTestId('rebuild-confirm');
      await expect(confirm).toContainText('Rebuild everything?');
      await expect(confirm).toContainText('Conversations, tasks, commits, summaries and source code are all rebuilt, in every project.');
      await expect(confirm).toContainText('The 674 summaries written with an earlier model are rewritten, about 68 calls in the background.');
      await expect(confirm).not.toContainText(/Sonnet|Opus/);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0))
        .toBe(0);

      await confirm.getByRole('button', { name: 'Rebuild' }).click();
      await expect(confirm).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRebuildIndexCalls?: number[] }).__mockRebuildIndexCalls?.length ?? 0))
        .toBe(1);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Local model error state', () => {
  test('shows the worker error detail when the local model fails to start', async () => {
    const { browser, page } = await launchWithState(makeErrorPreConfig('exit 1: Cannot find module sharp'));
    try {
      await openMemoryTab(page);
      const status = page.getByTestId('semantic-status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText(
        'The local model failed to start - showing keyword matches. (exit 1: Cannot find module sharp)',
      );
    } finally {
      await browser.close();
    }
  });

  test('falls back to the generic message when no worker error detail is available', async () => {
    const { browser, page } = await launchWithState(makeErrorPreConfig());
    try {
      await openMemoryTab(page);
      const status = page.getByTestId('semantic-status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText('The local model failed to start - showing keyword matches.');
    } finally {
      await browser.close();
    }
  });
});
