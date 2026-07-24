/**
 * UI tests for the ContextBar version pill resolving from the TASK's own
 * agent, not a global Claude-only version number (GitHub issue #199 follow-up).
 *
 * Before the fix, the pill's name came from the task's agent
 * (`agentDisplayName(taskAgent)`) but its version number came from a global,
 * Claude-only `agentVersionNumber` field on the config store. A non-Claude
 * task's pill could show that task's agent name paired with Claude's version
 * number. The fix resolves BOTH the display name and the version from the
 * same `agentList` entry keyed by the task's own agent
 * (`s.agentList.find((a) => a.name === taskAgent)`), so they can never
 * disagree - mirroring the same-entry-for-both-fields fix pattern used for
 * the footer warning in `tests/ui/status-bar-agent-not-found.spec.ts`.
 *
 * Pattern-matched off `tests/ui/cursor-context-bar.spec.ts`: a task+session
 * pre-seeded via `__mockPreConfigure`, with usage pushed through
 * `session-store.updateUsage` (the same store update the real `usage` IPC
 * event triggers) so the ContextBar renders past its "Starting agent..."
 * spinner. `__mockAgentListOverrides` (see `tests/ui/agent-auth-warning.spec.ts`)
 * seeds distinct claude/codex versions so a version mix-up is observable.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-context-bar-version';
const TASK_ID = 'task-context-bar-version';
const SESSION_ID = 'sess-context-bar-version';
const SWIMLANE_ID = 'lane-context-bar-version-todo';

// Distinct, easily-distinguishable version strings for claude vs codex so a
// pill that accidentally showed the wrong agent's version is unmistakable.
const CLAUDE_VERSION = '2.1.72';
const CODEX_VERSION = '9.9.9';

async function launchWithCodexTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // __mockAgentListOverrides must be set before the mock script installs
  // window.electronAPI, so agents.list() returns distinct claude/codex
  // versions from the very first bootstrap call.
  await page.addInitScript((overrides) => {
    (window as unknown as { __mockAgentListOverrides?: unknown }).__mockAgentListOverrides = overrides;
  }, {
    claude: { found: true, path: '/usr/bin/claude', version: CLAUDE_VERSION },
    codex: { found: true, path: '/usr/bin/codex', version: CODEX_VERSION },
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Context Bar Version Test',
        path: '/mock/context-bar-version',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: s.name,
          role: s.role,
          color: s.color,
          icon: s.icon,
          is_archived: s.is_archived,
          permission_strategy: s.permission_strategy ?? null,
          auto_spawn: s.auto_spawn ?? false,
          position: i,
          created_at: ts,
        });
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/context-bar-version',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      // The task's own agent is codex, distinct from the project default
      // (claude), so a pill that fell back to a global Claude-only version
      // would show the wrong number.
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Codex Version Pill Task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'codex',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('ContextBar version pill resolves from the task\'s own agent', () => {
  test('a codex task shows codex\'s own version, never claude\'s global version', async () => {
    const { browser, page } = await launchWithCodexTask();
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Bottom-panel ContextBar (disambiguated via `.min-h-8`, same pattern as
      // tests/ui/cursor-context-bar.spec.ts and tests/ui/context-bar-popover.spec.ts).
      const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(contextBar).toBeVisible({ timeout: 10000 });
      await expect(contextBar).toContainText('Starting agent...');

      // Push usage so the ContextBar renders past its spinner. Mirrors the
      // real applyUsage -> usageTracker -> IPC 'usage' -> session-store.updateUsage
      // path (see cursor-context-bar.spec.ts for the full rationale).
      await page.evaluate(
        (sessionId: string) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
            };
          }).__zustandStores;
          stores?.session.getState().updateUsage(sessionId, {
            model: { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
            contextWindow: {
              usedPercentage: 5,
              usedTokens: 200,
              cacheTokens: 0,
              totalInputTokens: 150,
              totalOutputTokens: 50,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
          });
        },
        SESSION_ID,
      );

      await expect.poll(async () => contextBar.textContent(), { timeout: 5000 }).toMatch(/GPT-5 Codex/);

      // The version pill must show codex's own version and name, never
      // claude's. This is the regression: before the fix, the version number
      // came from a global Claude-only field regardless of the task's agent.
      await expect(contextBar).toContainText(`v${CODEX_VERSION}`);
      await expect(contextBar).toContainText('Codex CLI');
      await expect(contextBar).not.toContainText(`v${CLAUDE_VERSION}`);
    } finally {
      await browser.close();
    }
  });
});
