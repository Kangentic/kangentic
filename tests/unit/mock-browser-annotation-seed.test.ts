/**
 * The web demo serves a Browser pane's seeded annotation draft from the UI mock
 * (`window.__mockBrowserAnnotationDrafts`, { taskId: draft }). The seed is read once per task, and
 * a Clear (discard) or a Send-side save is the task's own state, so the seed must never come back
 * after either. Without these pins a visitor who clears the demo's draft would see it reappear on
 * the next pane mount. The mock is evaluated in a `node:vm` context, the way
 * `mock-electron-api-parity.test.ts` loads it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const MOCK_ELECTRON_API_PATH = path.resolve(__dirname, '../ui/mock-electron-api.js');

interface MockBrowser {
  loadAnnotations(taskId: string): Promise<unknown>;
  saveAnnotations(taskId: string, draft: unknown): Promise<void>;
  discardAnnotations(taskId: string): Promise<void>;
}

interface LoadedMock {
  browser: MockBrowser;
  resetBrowser(): void;
}

const SEEDED_TASK = 'task-seeded';
const SEED = { annotations: [{ id: 'a1', note: 'seeded note' }], marker: 'seed' };

function loadMock(): LoadedMock {
  const source = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');
  const windowObject: Record<string, unknown> = {};
  windowObject.window = windowObject;
  windowObject.__mockBrowserAnnotationDrafts = { [SEEDED_TASK]: SEED };
  vm.runInNewContext(
    source,
    { window: windowObject, document: undefined, crypto: webcrypto, setTimeout, clearTimeout, console },
    { filename: MOCK_ELECTRON_API_PATH, timeout: 5000 },
  );
  const electronApi = windowObject.electronAPI as { browser: MockBrowser };
  const hook = windowObject.__mockBrowser as { reset(): void };
  return { browser: electronApi.browser, resetBrowser: () => hook.reset() };
}

/** Cross-realm values compare by shape, not prototype, once round-tripped through JSON. */
function plain(value: unknown): unknown {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

describe('mock browser.loadAnnotations seed', () => {
  let mock: LoadedMock;

  beforeEach(() => {
    mock = loadMock();
  });

  it('serves a deep copy of the seed on the first load', async () => {
    const first = (await mock.browser.loadAnnotations(SEEDED_TASK)) as typeof SEED;
    expect(plain(first)).toEqual(SEED);
    first.annotations.push({ id: 'mutated', note: 'changed by the caller' });
    first.marker = 'mutated';
    expect(plain(await mock.browser.loadAnnotations(SEEDED_TASK))).toEqual(SEED);
  });

  it('does not bring the seed back after a discard', async () => {
    await mock.browser.loadAnnotations(SEEDED_TASK);
    await mock.browser.discardAnnotations(SEEDED_TASK);
    expect(await mock.browser.loadAnnotations(SEEDED_TASK)).toBeNull();
  });

  it('leaves the next load null when the discard comes before the first load', async () => {
    await mock.browser.discardAnnotations(SEEDED_TASK);
    expect(await mock.browser.loadAnnotations(SEEDED_TASK)).toBeNull();
  });

  it('lets a save before the first load win over the seed', async () => {
    const own = { annotations: [], marker: 'own draft' };
    await mock.browser.saveAnnotations(SEEDED_TASK, own);
    expect(plain(await mock.browser.loadAnnotations(SEEDED_TASK))).toEqual(own);
  });

  it('loads null for a task with no seed', async () => {
    expect(await mock.browser.loadAnnotations('task-unseeded')).toBeNull();
  });

  it('serves the seed again after the mock reset hook runs', async () => {
    await mock.browser.discardAnnotations(SEEDED_TASK);
    expect(await mock.browser.loadAnnotations(SEEDED_TASK)).toBeNull();
    mock.resetBrowser();
    expect(plain(await mock.browser.loadAnnotations(SEEDED_TASK))).toEqual(SEED);
  });
});
