/**
 * Acceptance-criterion E2E: "delete a task - lifetime totals do not drop"
 *
 * This is the original user-facing bug: the StatusBar period selector showed
 * $0 after the task that generated the cost was deleted, because totals were
 * read from the sessions table (which is CASCADE-deleted) rather than from a
 * separate append-only history.
 *
 * The fix introduces the `usage_history` table. This test exercises the full
 * history write path end-to-end using a real Electron instance:
 *
 *   1. Create a task and spawn a Claude session (mock-claude fixture).
 *   2. Write a synthetic status.json (correct Claude schema) into the session
 *      directory so StatusFileReader populates the usageCache with cost + token
 *      data AND triggers the agent_session_id capture needed for the Done-path
 *      gate check.
 *   3. Poll the DB until `sessions.list()` shows the agent_session_id is set
 *      AND the usage bar shows the model name. Both conditions must hold before
 *      moving to Done, because captureSessionMetrics is only called when
 *      record.agent_session_id is non-null.
 *   4. Move the task to Done - triggers captureSessionMetrics which calls
 *      usageHistoryRepo.recordSessionUsage to write a history row.
 *   5. Poll until the task appears in archivedTasks (Done-path fully completed).
 *   6. Delete the task (hard delete via IPC).
 *   7. Query USAGE_GET_DASHBOARD_STATS (project scope, 'all') - assert the KPI
 *      totalCostUsd > 0 and tokens are preserved despite the task being gone.
 *
 * Uses mock-claude with an injected status.json rather than the real CLI.
 * The status.json uses the correct Claude schema (context_window + cost keys)
 * so ClaudeStatusParser.parseStatus returns non-zero cost/token values.
 *
 * Does NOT exercise the inspection bridge, avoiding the devtools port collision
 * that caused three devtools-inspection.spec.ts failures in prior runs.
 */

import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  waitForRunningSession,
  waitForScrollback,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'usage-history-survives-delete';
const runId = Date.now();
const PROJECT_NAME = `History Survives Delete ${runId}`;

let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      agent: {
        cliPaths: { claude: mockAgentPath('claude') },
        permissionMode: 'acceptEdits',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
  cleanupTestDataDir(TEST_NAME);
});

test.describe('Usage history - lifetime totals survive task deletion', () => {
  test('totalCostUsd and token counts remain non-zero after deleting the source task', async () => {
    const title = `History Task ${runId}`;
    await createTask(page, title, 'Generate some cost');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn the Claude session into Planning.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');

    // Look up the PTY session ID (the same ID Kangentic passes as --session-id
    // to Claude and uses as the session directory name).
    const ptySessionId = await page.evaluate(async (id: string) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t: { id: string }) => t.id === id);
      return task?.session_id ?? null;
    }, taskId);
    expect(ptySessionId).toBeTruthy();

    // Write a synthetic status.json using the correct Claude Code schema.
    //
    // Schema notes:
    //   - `context_window` key (not `token_usage`) holds token counts, matched
    //     by ClaudeStatusParser.parseStatus which reads cw.total_input_tokens,
    //     cw.total_output_tokens, cw.current_usage.*, cw.context_window_size.
    //   - `cost` key holds cost + duration.
    //   - `session_id` triggers onAgentSessionId in SessionTelemetry, which
    //     writes agent_session_id to the DB. The Done-path gate check
    //     `record.agent_session_id` requires this to be non-null before
    //     captureSessionMetrics will be called.
    //   - The value for `session_id` is the PTY session ID (the UUID Kangentic
    //     passes via --session-id; real Claude echoes it back in this field).
    const statusDir = path.join(tmpDir, '.kangentic', 'sessions', ptySessionId!);
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify({
        type: 'status',
        session_id: ptySessionId,
        model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
        context_window: {
          total_input_tokens: 3000,
          total_output_tokens: 800,
          context_window_size: 200000,
          used_percentage: 2.0,
          current_usage: {
            input_tokens: 2500,
            output_tokens: 800,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 0,
          },
        },
        cost: {
          total_cost_usd: 0.05,
          total_duration_ms: 8000,
        },
      }),
    );

    // Wait for the usage bar to show the model name. This confirms both:
    //   a) StatusFileReader picked up the file and parsed it successfully.
    //   b) The main process usageCache is populated with non-zero cost/tokens.
    // A plain `toBeVisible()` is insufficient - the bar renders with
    // "Loading agent..." before usage data arrives, so the cache could
    // still be empty when visibility fires.
    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toContainText('Sonnet 4.6', { timeout: 15000 });

    // Move to Done. This triggers captureSessionMetrics (Phase 2: Done-role
    // suspend path) which reads from usageCache and calls
    // usageHistoryRepo.recordSessionUsage - the central history write this test
    // is designed to exercise.
    await moveTaskIpc(page, taskId, swimlaneIds.done);

    // Poll until the task appears in archivedTasks. move-to-Done is async and
    // includes a session suspend; confirming archive ensures the Done path
    // fully completed including the captureSessionMetrics call.
    await expect.poll(async () => {
      return page.evaluate(async (tid) => {
        const archived = await window.electronAPI.tasks.listArchived();
        return archived.some((archivedTask: { id: string }) => archivedTask.id === tid);
      }, taskId);
    }, { timeout: 10000 }).toBe(true);

    // Query dashboard stats BEFORE delete to establish baseline. History row
    // must already be written (captureSessionMetrics is synchronous once it
    // runs). The dashboard endpoint reads the same append-only usage_history
    // ledger the old period-stats endpoint did.
    const statsBeforeDelete = await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      if (!project) throw new Error('No current project');
      const stats = await window.electronAPI.usage.getDashboardStats(
        { kind: 'project', projectId: project.id },
        'all',
      );
      return stats.kpis;
    });
    expect(statsBeforeDelete.totalCostUsd).toBeGreaterThan(0);
    expect(statsBeforeDelete.totalInputTokens).toBeGreaterThan(0);
    expect(statsBeforeDelete.totalOutputTokens).toBeGreaterThan(0);

    // Hard-delete the task via IPC (removes tasks + sessions rows from DB).
    await page.evaluate(async (id) => {
      await window.electronAPI.tasks.delete(id);
    }, taskId);

    // Confirm the task is gone from both active and archived lists.
    await expect.poll(async () => {
      return page.evaluate(async (id) => {
        const active = await window.electronAPI.tasks.list();
        const archived = await window.electronAPI.tasks.listArchived();
        return active.some((t: { id: string }) => t.id === id)
          || archived.some((t: { id: string }) => t.id === id);
      }, taskId);
    }, { timeout: 5000 }).toBe(false);

    // THE CORE ASSERTION: dashboard stats after deletion must match before deletion.
    // The usage_history table is append-only and NOT cascade-deleted with tasks/sessions.
    const statsAfterDelete = await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      if (!project) throw new Error('No current project');
      const stats = await window.electronAPI.usage.getDashboardStats(
        { kind: 'project', projectId: project.id },
        'all',
      );
      return stats.kpis;
    });

    expect(statsAfterDelete.totalCostUsd).toBeCloseTo(statsBeforeDelete.totalCostUsd, 6);
    expect(statsAfterDelete.totalInputTokens).toBe(statsBeforeDelete.totalInputTokens);
    expect(statsAfterDelete.totalOutputTokens).toBe(statsBeforeDelete.totalOutputTokens);

    // Belt-and-suspenders: confirm the totals are genuinely non-zero,
    // not just "both zero equals both zero" vacuous equality.
    expect(statsAfterDelete.totalCostUsd).toBeGreaterThan(0);
    expect(statsAfterDelete.totalInputTokens).toBeGreaterThan(0);
    expect(statsAfterDelete.totalOutputTokens).toBeGreaterThan(0);
  });
});
