/**
 * UI tests for the embedding-model picker + status line in the Search tab
 * (the tiered semantic-search model selection). Verifies the dropdown lists the
 * tiers, the model card reflects the download state, and selecting a model
 * persists memory.embeddingModel to config.
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
function makePreConfig(modelState: string, progress?: number, digests?: object): string {
  const memoryStatus = {
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
  // Enable semantic search in config (the dropdown + card are gated on it) via
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
  // By id: the tab is labelled Search, and that word also names a settings search box.
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

      // The status line carries the concrete model name + size + readiness.
      const card = page.getByTestId('embedding-model-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Ready: bge small');
      await expect(card).toContainText('34 MB');
      await expect(page.getByTestId('embedding-model-ready')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('shows download progress while the model is downloading', async () => {
    const { browser, page } = await launchWithState(makePreConfig('downloading', 0.42));
    try {
      await openMemoryTab(page);
      const card = page.getByTestId('embedding-model-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Downloading');
      await expect(page.getByTestId('embedding-model-ready')).toHaveCount(0);
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
      await expect(page.getByTestId('embedding-model-card')).toContainText('running on DirectML (GPU)');
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

  test('Rebuild index invokes memory.rebuildIndex for the current project', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openMemoryTab(page);
      await page.getByTestId('memory-rebuild-index').click();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const calls = (window as unknown as {
              __mockRebuildIndexCalls?: Array<{ projectId: string | null }>;
            }).__mockRebuildIndexCalls;
            return calls && calls.length > 0 ? calls[calls.length - 1].projectId : null;
          }),
        )
        .toBe(PROJECT_ID);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Answering agent card', () => {
  test('stays visible with its description, tagged with its prerequisite, until it can be set up', async () => {
    // It used to be hidden until semantic search was on, which left the
    // feature invisible to anyone who had not already found it. It now shows
    // like the Semantic search card does while indexing is off: dimmed, its
    // description unchanged, a tag naming what it needs, with its rows
    // appearing once nothing is missing. The Task digests card dims with it.
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openMemoryTab(page);
      const card = page.getByTestId('answering-agent-card');
      const digestsCard = page.getByTestId('task-digests-card');
      const agentRow = page.getByTestId('memory-answer-agent');

      const description = 'Answers the questions you ask in the Knowledge Graph.';
      // Everything on: the card holds its rows and names no prerequisite. It
      // answers questions only: digests have their own card.
      await expect(agentRow).toBeVisible();
      await expect(card).toContainText('Answering agent');
      await expect(card).toContainText(description);
      await expect(card).not.toContainText('Needs ');
      await expect(card).not.toContainText('Task digests');

      // Semantic search off: the card stays, keeps its description, tags what
      // it needs, and hides its rows.
      await setMemory(page, { semanticEnabled: false });
      await expect(card).toBeVisible();
      await expect(card).toContainText(description);
      await expect(card).toContainText('Needs semantic search');
      await expect(digestsCard).toContainText('Needs semantic search');
      await expect(page.getByTestId('setting-row-memory.taskDigests')).toBeDisabled();
      await expect(agentRow).toHaveCount(0);

      // Indexing off too: each card names only its own direct prerequisite.
      await setMemory(page, { indexingEnabled: false });
      await expect(card).toContainText('Needs semantic search');
      await expect(page.locator('section[aria-label="Semantic search"]')).toContainText('Needs indexing');
      await expect(agentRow).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Task digests card', () => {
  const DIGESTS = { written: 0, finishedTasks: 412, skipped: 0, state: 'idle', retryInMs: null, writtenWith: [], choice: null, awaitingRewrite: 0 };

  test('is off by default, and switched on it waits for its own agent, showing the backfill first', async () => {
    // Opt-in: digests spend a call per ten tasks, so nothing runs until the
    // switch is on AND an agent is chosen. The answering agent is set here and
    // must not be borrowed: the digest agent row starts empty.
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, DIGESTS));
    try {
      await setMemory(page, { answerAgent: 'claude', answerModel: 'sonnet' });
      await openMemoryTab(page);
      const card = page.getByTestId('task-digests-card');
      const toggle = page.getByTestId('setting-row-memory.taskDigests');
      await expect(card).toContainText('A sentence or two per finished task, so questions find it.');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByTestId('memory-digest-agent')).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('memory-digest-agent')).toHaveValue('');
      await expect(page.getByTestId('memory-digest-model')).toHaveCount(0);
      // 412 tasks at ten a call: the size of the backfill before anything runs.
      await expect(page.getByTestId('digest-status-text')).toHaveText('Waiting for an agent: 412 tasks here, about 42 calls.');

      // An agent whose run takes a model waits for the model too.
      await setMemory(page, { digestAgent: 'claude' });
      await expect(page.getByTestId('memory-digest-model')).toBeVisible();
      await expect(page.getByTestId('digest-status-text')).toHaveText('Waiting for a model: 412 tasks here, about 42 calls.');

      await setMemory(page, { digestModel: 'haiku' });
      await expect(page.getByTestId('digest-status-text')).toHaveText('Writing: 0 of 412 finished tasks in this project.');
      // Its own choice: the answering agent's model is untouched.
      await expect(page.getByTestId('memory-answer-model')).toHaveValue(/sonnet|Sonnet/);
    } finally {
      await browser.close();
    }
  });

  test('Rewrite names what the digests were written with, and rewrites only the ones written another way', async () => {
    const sonnet = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
    const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };
    const cases = [
      {
        // Every digest matches the chosen setting: the button stays, disabled.
        digests: { ...DIGESTS, written: 674, finishedTasks: 674, choice: sonnet, writtenWith: [{ ...sonnet, count: 674 }] },
        line: /^All 674 written with .*Sonnet.* at low effort\.$/,
        enabled: false,
      },
      {
        // The model changed: the old digests stay until rewritten.
        digests: { ...DIGESTS, written: 674, finishedTasks: 674, choice: opus, writtenWith: [{ ...sonnet, count: 674 }] },
        line: /^674 written with .*Sonnet.* at low effort\.$/,
        enabled: true,
      },
    ];
    for (const { digests, line, enabled } of cases) {
      const { browser, page } = await launchWithState(makePreConfig('ready', undefined, digests));
      try {
        await setMemory(page, { taskDigests: true, digestAgent: 'claude', digestModel: digests.choice.model });
        await openMemoryTab(page);
        await expect(page.getByTestId('rewrite-digests-line')).toHaveText(line);
        const button = page.getByTestId('rewrite-digests');
        await expect(button).toHaveText('Rewrite');
        if (!enabled) {
          await expect(button).toBeDisabled();
          await expect(button).toHaveAttribute('title', 'Every digest was written with the chosen agent, model and effort.');
          continue;
        }
        await button.click();
        const confirm = page.getByTestId('rewrite-digests-confirm');
        await expect(confirm).toContainText(/Rewrite 674 digests with .*Opus.* at low effort\?/);
        await expect(confirm).toContainText('About 68 calls, three at a time, in the background.');
        await confirm.getByRole('button', { name: 'Rewrite' }).click();
        await expect(confirm).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as unknown as { __mockRewriteDigestsCalls?: Array<{ projectId: string }> }).__mockRewriteDigestsCalls ?? []))
          .toEqual([{ projectId: PROJECT_ID }]);
      } finally {
        await browser.close();
      }
    }
  });

  test('while rewriting, the status counts the new ones and the old ones stay named', async () => {
    const sonnet = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
    const opus = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };
    const digests = {
      ...DIGESTS, written: 674, finishedTasks: 674, choice: opus, awaitingRewrite: 554,
      writtenWith: [{ ...sonnet, count: 554 }, { ...opus, count: 120 }],
    };
    const { browser, page } = await launchWithState(makePreConfig('ready', undefined, digests));
    try {
      await setMemory(page, { taskDigests: true, digestAgent: 'claude', digestModel: 'claude-opus-5-5' });
      await openMemoryTab(page);
      await expect(page.getByTestId('digest-status-text')).toHaveText(/^Rewriting with .*Opus.* at low effort: 120 of 674\.$/);
      await expect(page.getByTestId('rewrite-digests-line')).toHaveText(/^554 still written with .*Sonnet.* at low effort\.$/);
      await expect(page.getByTestId('rewrite-digests')).toHaveText('Rewriting...');
      await expect(page.getByTestId('rewrite-digests')).toBeDisabled();
    } finally {
      await browser.close();
    }
  });

  test('says when it is caught up, what the agent passed over, and when a failed call is retried', async () => {
    const cases: Array<{ digests: object; text: string }> = [
      { digests: { ...DIGESTS, written: 412 }, text: 'All 412 finished tasks in this project have one.' },
      { digests: { ...DIGESTS, written: 409, skipped: 3 }, text: '409 of 412 written, 3 skipped until the next launch.' },
      { digests: { ...DIGESTS, written: 200, state: 'retrying', retryInMs: 5 * 60_000 }, text: 'A call failed. Trying again in 5 minutes.' },
    ];
    for (const { digests, text } of cases) {
      const { browser, page } = await launchWithState(makePreConfig('ready', undefined, digests));
      try {
        await setMemory(page, { taskDigests: true, digestAgent: 'claude', digestModel: 'haiku' });
        await openMemoryTab(page);
        await expect(page.getByTestId('digest-status-text')).toHaveText(text);
      } finally {
        await browser.close();
      }
    }
  });
});

test.describe('Semantic search error state', () => {
  test('shows the worker error detail when semantic search fails to start', async () => {
    const { browser, page } = await launchWithState(makeErrorPreConfig('exit 1: Cannot find module sharp'));
    try {
      await openMemoryTab(page);
      const status = page.getByTestId('semantic-status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText(
        'Semantic search failed to start - showing keyword matches. (exit 1: Cannot find module sharp)',
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
      await expect(status).toHaveText('Semantic search failed to start - showing keyword matches.');
    } finally {
      await browser.close();
    }
  });
});
