/**
 * Worker-scoped shared Electron fixture for the SAFE cluster of E2E specs.
 *
 * WHY: With Playwright workers=1 (locked for electron project, see commit
 * 484e58c), a shared worker-scoped fixture boots a single Electron instance
 * for the entire cluster instead of one boot per spec file. This saves
 * ~3-5s per migrated spec with no loss of isolation, because:
 *   - Each test gets a UNIQUE temp-project directory (warm-reopen guard
 *     in openProjectByPath only fires for the SAME path).
 *   - resetSharedApp() kills all sessions from the previous test's project
 *     before handing the shared page to the next test.
 *   - SESSION_LIST returns all sessions unfiltered (the SESSION_LIST handler
 *     in src/main/ipc/handlers/sessions.ts), so cross-project session leakage
 *     IS real - reset must filter to the current projectId and kill every
 *     survivor.
 *
 * WHO CAN USE THIS:
 *   Specs that use the canonical default config:
 *     claude.cliPath = mock-claude, permissionMode='default',
 *     maxConcurrentSessions=5, queueOverflow='queue', git.worktreesEnabled=false
 *   And do NOT: relaunch Electron mid-spec, pass extraEnv, need a different
 *   startup config (different maxConcurrentSessions, different agent cliPaths
 *   shape, etc.).
 *
 * NEVER-MIGRATE LIST:
 *   session-resume, session-reconciliation, session-resume-os-killed,
 *   session-queue, agent-session-id-capture, background-shell-idle,
 *   kimi-* - relaunches Electron or custom extraEnv
 *   config-changes, done-worktree-lifecycle, devtools-inspection - distinct
 *   startup config
 *   project-delete - asserts registry purge
 *   *-activity-detection - each needs its own agent cliPath
 *   agent-session-resume, bulk-delete-worktrees
 *   session-model-name - uses agent.cliPaths shape + multiple agents
 *   session-move-lifecycle - uses maxConcurrentSessions:10 vs canonical 5
 *   browser-evidence-retry - 3 separate launchApp per variant (different CLIs)
 */
import { test as base, type Page, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchApp,
  createProject,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
} from './helpers';
import type { Session } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Canonical config shared by all SAFE-cluster specs.
// ---------------------------------------------------------------------------

function buildCanonicalConfig(): Record<string, unknown> {
  return {
    claude: {
      cliPath: mockAgentPath('claude'),
      permissionMode: 'default',
      maxConcurrentSessions: 5,
      queueOverflow: 'queue',
    },
    git: { worktreesEnabled: false },
  };
}

// ---------------------------------------------------------------------------
// resetSharedApp: isolation step between tests.
//
// Kills all sessions belonging to the CURRENT project so the next test's
// waiters never see a leftover PTY from the previous test's project.
// SESSION_LIST is unfiltered (returns all projects' sessions), so we MUST
// filter by projectId. The project itself is opened fresh per test via
// freshProject, so after reset the board is blank.
// ---------------------------------------------------------------------------

/** Poll until none of one project's sessions reports status 'running'. */
async function waitForProjectSessionsStopped(page: Page, projectId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const anyRunning = await page.evaluate(async (id) => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      return sessions.some((session) => session.projectId === id && session.status === 'running');
    }, projectId);
    if (!anyRunning) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for project ${projectId}'s sessions to stop running`);
}

export async function resetSharedApp(page: Page): Promise<void> {
  // 1. Get current project id (may be null if no project is open yet).
  const currentProjectId = await page.evaluate(async () => {
    const project = await window.electronAPI.projects.getCurrent();
    return project?.id ?? null;
  });

  // 2. Kill any sessions belonging to this project.
  if (currentProjectId) {
    const sessionIds = await page.evaluate(async (projectId) => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      return sessions
        .filter((session) => session.projectId === projectId)
        .map((session) => session.id);
    }, currentProjectId);

    for (const sessionId of sessionIds) {
      await page.evaluate(async (id) => {
        await window.electronAPI.sessions.kill(id);
      }, sessionId);
    }

    // 3. Wait until no running session remains for this project. Scoped like
    //    the kill above: a session another project still runs is not this
    //    reset's to wait on, and a global wait threw on it for the rest of
    //    the worker.
    if (sessionIds.length > 0) {
      await waitForProjectSessionsStopped(page, currentProjectId, 15000);
    }
  }

  // 4. Dismiss any open dialog or toast so the next test starts clean.
  //    Use document.dispatchEvent (not page.keyboard.press) to bypass xterm
  //    capturing Escape as an ANSI sequence (anti-pattern 10).
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------
// Fixture types.
// ---------------------------------------------------------------------------

export type SharedAppFixtures = {
  /**
   * Worker-scoped: one Electron launch per worker process for the SAFE
   * cluster. Provides the live ElectronApplication and Page. Tests read
   * `page` from here - do NOT declare a separate `let page`.
   */
  sharedApp: { app: ElectronApplication; page: Page };

  /**
   * Test-scoped (auto): before each test, resets the shared app and opens a
   * UNIQUE temp project so no test sees another test's tasks or sessions.
   * The project path is always unique (timestamp + testTitle hash) to avoid
   * hitting the warm-reopen guard in openProjectByPath.
   */
  freshProject: { page: Page; tmpDir: string };
};

// ---------------------------------------------------------------------------
// Extended test object.
// ---------------------------------------------------------------------------

export const test = base.extend<SharedAppFixtures>({
  // Worker-scoped: boots once per worker, closed at worker teardown.
  // eslint-disable-next-line no-empty-pattern
  sharedApp: [async ({}, use) => {
    const dataDir = getTestDataDir('shared-app-worker');

    // Pre-write the canonical config so launchApp merges rather than
    // overwrites (launchApp already merges hasCompletedFirstRun + notifications).
    const configPath = path.join(dataDir, 'config.json');
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const canonicalConfig = buildCanonicalConfig();
      const merged = { ...existing, ...canonicalConfig };
      fs.writeFileSync(configPath, JSON.stringify(merged));
    } catch {
      fs.writeFileSync(configPath, JSON.stringify(buildCanonicalConfig()));
    }

    const result = await launchApp({ dataDir });

    await use(result);

    await result.app.close();
    cleanupTestDataDir('shared-app-worker');
  }, { scope: 'worker' }],

  // Test-scoped auto fixture: runs before every test body.
  freshProject: [async ({ sharedApp }, use) => {
    const { page } = sharedApp;

    // Reset first: kill previous test's sessions and clear any open dialogs.
    await resetSharedApp(page);

    // Open a UNIQUE project for this test. Using Date.now() + a short random
    // suffix makes collisions statistically impossible across --repeat-each runs.
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 99999)}`;
    const tmpDir = createTempProject(`shared-${uniqueSuffix}`);
    const projectName = `Shared App Test ${uniqueSuffix}`;

    await createProject(page, projectName, tmpDir);

    await use({ page, tmpDir });

    // End this test's sessions BEFORE deleting its directory. On Windows a
    // running session holds the directory as its working directory, so the
    // delete failed silently and the directory survived; the next page
    // reload's background activation (activateAllProjects, 5 s after
    // did-finish-load) then found the project still on disk and resumed its
    // killed sessions, which piled up across tests until a later test's spawn
    // sat queued behind maxConcurrentSessions. The cleanup runs even when the
    // reset throws (a crashed page, or sessions that outlive the wait), or
    // the directory would survive for exactly that reason.
    try {
      await resetSharedApp(page);
    } finally {
      cleanupTempProject(`shared-${uniqueSuffix}`);
    }
  }, { auto: true, scope: 'test' }],
});

export { expect } from '@playwright/test';
