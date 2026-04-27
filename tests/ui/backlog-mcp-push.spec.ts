import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { BacklogTask } from '../../src/shared/types';

/**
 * Regression coverage for the agent-broadcast push contract on the backlog.
 *
 * Wire-up under test:
 *   main:    src/main/agent/mcp-project-context.ts onBacklogChanged
 *            -> webContents.send(IPC.BACKLOG_CHANGED_BY_AGENT, projectId)
 *   preload: src/preload/preload.ts backlog.onChangedByAgent
 *   render:  src/renderer/App.tsx scheduleBacklogReload (250ms debounce)
 *            -> useBacklogStore.loadBacklog()
 *
 * The bug: when the running main process predates this wiring, MCP-driven
 * backlog mutations land in the DB but the UI never refreshes until restart.
 * These tests lock in the contract by simulating the broadcast through the
 * mock-electron-api hook window.__mockFireBacklogChangedByAgent.
 */

declare global {
  interface Window {
    __mockFireBacklogChangedByAgent?: (projectId: string) => void;
    __mockBacklogChangedListeners?: Array<(projectId?: string) => void>;
  }
}

function makeBacklogItem(title: string, position: number): BacklogTask {
  const now = new Date().toISOString();
  return {
    id: `backlog-pushed-${position}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    description: '',
    priority: 0,
    labels: [],
    position,
    assignee: null,
    due_date: null,
    item_type: null,
    external_id: null,
    external_source: null,
    external_url: null,
    sync_status: null,
    external_metadata: null,
    attachment_count: 0,
    created_at: now,
    updated_at: now,
  };
}

test.describe('Backlog: MCP push event refreshes UI', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('firing onChangedByAgent for the active project reloads the list', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-push-active');

    // Switch to Backlog tab. List starts empty.
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('text=Backlog is empty')).toBeVisible();

    const activeProjectId = await page.evaluate(() => {
      const stores = (window as unknown as { __zustandStores?: { project: { getState: () => { currentProject: { id: string } | null } } } }).__zustandStores;
      return stores?.project.getState().currentProject?.id ?? null;
    });
    expect(activeProjectId).not.toBeNull();

    // Seed an item directly into the mock's backlogTasks array, simulating
    // an external (MCP) write that bypassed the renderer store.
    await page.evaluate((seed: BacklogTask) => {
      window.__mockPreConfigure((state: { backlogTasks: BacklogTask[] }) => {
        state.backlogTasks.push(seed);
        return undefined;
      });
    }, makeBacklogItem('Pushed by MCP', 0));

    // Assert the item is NOT visible yet. The renderer store has not been
    // told to reload, so the UI mirrors the pre-push snapshot.
    await expect(page.locator('text=Pushed by MCP')).not.toBeVisible();

    // Fire the broadcast for the active project.
    await page.evaluate((projectId: string) => {
      window.__mockFireBacklogChangedByAgent?.(projectId);
    }, activeProjectId as string);

    // Within 1s (covers the 250ms debounce + IPC roundtrip + render) the
    // pushed item must appear and the count badge must show 1.
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(1, { timeout: 2000 });
    await expect(page.locator('text=Pushed by MCP')).toBeVisible();
    await expect(page.locator('[data-testid="view-toggle-backlog"]')).toContainText('1');

    await browser.close();
  });

  test('events for non-active projects are ignored', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-push-other-project');

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('text=Backlog is empty')).toBeVisible();

    // Seed an item, but fire the broadcast with a foreign project id.
    await page.evaluate((seed: BacklogTask) => {
      window.__mockPreConfigure((state: { backlogTasks: BacklogTask[] }) => {
        state.backlogTasks.push(seed);
        return undefined;
      });
    }, makeBacklogItem('Pushed for other project', 0));

    await page.evaluate(() => {
      window.__mockFireBacklogChangedByAgent?.('00000000-0000-0000-0000-000000000000');
    });

    // Give the 250ms debounce a chance to fire.
    await page.waitForTimeout(600);

    // The item must NOT appear. The listener early-returns at App.tsx:531
    // when changedProjectId !== activeProjectId.
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(0);
    await expect(page.locator('text=Backlog is empty')).toBeVisible();

    await browser.close();
  });
});
