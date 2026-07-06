/**
 * UI tests for the embedding-model picker + status card in the Memory tab
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
function makePreConfig(modelState: string, progress?: number): string {
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
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
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

      // The card carries the concrete model name + size + readiness.
      const card = page.getByTestId('embedding-model-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Model: bge small');
      await expect(card).toContainText('~34 MB');
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
      const select = page.getByTestId('memory-acceleration-select');
      await expect(select).toBeVisible();
      await expect(select.locator('option')).toHaveText(['Auto', 'GPU', 'CPU']);
      await expect(select).toHaveValue('auto');
      // The status card names the execution provider the worker actually initialized on.
      await expect(page.getByTestId('embedding-model-card')).toContainText('Running on DirectML (GPU)');
    } finally {
      await browser.close();
    }
  });

  test('selecting a different acceleration persists memory.acceleration', async () => {
    const { browser, page } = await launchWithState(makePreConfig('ready'));
    try {
      await openMemoryTab(page);
      await page.getByTestId('memory-acceleration-select').selectOption('cpu');
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
