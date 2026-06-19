/**
 * E2E: OS-killed agent session recovery on startup.
 *
 * Reproduces the 2026-06-06 incident end-to-end through the REAL main process:
 * a hard shutdown (OS restart / power loss / SIGKILL) kills the PTY before the
 * clean-quit path can mark the record 'suspended', so it lands as 'exited' with
 * an abnormal exit code (Windows 1073807364). The OLD startup recovery gathered
 * only 'suspended' + 'orphaned', so it abandoned the conversation and spawned a
 * fresh empty session.
 *
 * Deterministic simulation of the hard kill: after a real session spawns, close
 * the app, then directly edit the project DB (node:sqlite, app closed) into the
 * exact post-kill state (status='exited', exit_code=1073807364) - overriding
 * what the clean shutdown wrote. Relaunch and assert recovery resumes via
 * `--resume <original-agent-session-id>` (MOCK_CLAUDE_RESUMED marker), not a
 * fresh `--session-id`.
 *
 * Red-green: with the fix reverted (getInterruptedExited not gathered), the
 * exited record is invisible, autoSpawnTasks spawns fresh, and only a
 * MOCK_CLAUDE_SESSION marker with a NEW id appears -> this test fails.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  moveTaskIpc,
  waitForRunningSession,
  waitForScrollback,
  getTaskIdByTitle,
  getSwimlaneIds,
  closeApp,
} from './helpers';
import type { Session } from '../../src/shared/types';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TEST_NAME = 'session-resume-os-killed';
const runId = Date.now();

// Windows hard-kill code from the incident (0x40010004). The fix is
// cross-platform (any non-zero code), but using the real incident code keeps
// this an empirical reproduction.
const HARD_KILL_EXIT_CODE = 1073807364;

function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      agent: {
        cliPaths: { claude: mockAgentPath('claude') },
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );
}

function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const match = scrollback.match(new RegExp(`MOCK_CLAUDE_${marker}:([a-f0-9-]+)`));
  return match ? match[1] : null;
}

test.describe('Claude Agent -- OS-killed session recovery on startup', () => {
  const dataDir = getTestDataDir(TEST_NAME);
  let tmpDir: string;

  test.beforeAll(() => {
    tmpDir = createTempProject(TEST_NAME);
    writeTestConfig(dataDir);
  });

  test.afterAll(() => {
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('exited+abnormal-code session resumes via --resume, not a fresh session', async () => {
    // Two launches + DB surgery + cold-start scrollback waits exceed the default.
    test.setTimeout(120_000);
    const title = `OSKill Resume ${runId}`;

    // === Phase 1: spawn a real session, capture its original agent_session_id ===
    let launched = await launchApp({ dataDir });
    let app = launched.app;
    let page = launched.page;

    await createProject(page, 'OSKill', tmpDir);
    await createTask(page, title, 'OS-kill recovery test');

    const { planning } = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, planning);
    await page.reload();
    await waitForBoard(page);
    await waitForRunningSession(page);

    const scrollback1 = await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');
    const originalAgentSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalAgentSessionId).toBeTruthy();

    const projectId = await page.evaluate(async () => {
      const current = await window.electronAPI.projects.getCurrent();
      return current?.id ?? null;
    });
    expect(projectId).toBeTruthy();

    await closeApp(app);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // === Phase 2: simulate the hard kill via DB surgery (app closed) ===
    // The clean close marked the record 'suspended'; force the exact OS-killed
    // state the old recovery could not see: exited + abnormal code.
    const dbPath = path.join(dataDir, 'projects', `${projectId}.db`);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE sessions SET status = 'exited', exit_code = ?, suspended_at = NULL, suspended_by = NULL WHERE task_id = ?`,
    ).run(HARD_KILL_EXIT_CODE, taskId);
    db.prepare(`UPDATE tasks SET session_id = NULL WHERE id = ?`).run(taskId);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const afterRow = db.prepare(
      `SELECT status, exit_code, agent_session_id FROM sessions WHERE task_id = ?`,
    ).get(taskId) as { status: string; exit_code: number; agent_session_id: string };
    db.close();

    // Confirm we recreated the incident state exactly.
    expect(afterRow.status).toBe('exited');
    expect(afterRow.exit_code).toBe(HARD_KILL_EXIT_CODE);
    expect(afterRow.agent_session_id).toBe(originalAgentSessionId);

    // Re-write config (app close may have merged/rewritten it).
    writeTestConfig(dataDir);

    // === Phase 3: relaunch -> startup recovery must RESUME the conversation ===
    launched = await launchApp({ dataDir });
    app = launched.app;
    page = launched.page;

    await page.evaluate((projectPath) => window.electronAPI.projects.openByPath(projectPath), tmpDir);
    await page.reload();
    await waitForBoard(page);

    // The conversation resumes with the ORIGINAL id -> proves `--resume <id>`,
    // not a fresh `--session-id`. If the fix were absent, only a
    // MOCK_CLAUDE_SESSION marker with a NEW id would ever appear.
    const expectedMarker = `MOCK_CLAUDE_RESUMED:${originalAgentSessionId}`;
    const scrollback2 = await waitForScrollback(page, expectedMarker, 40_000);
    expect(scrollback2).toContain(expectedMarker);

    // And the task is wired to a live running session again.
    await page.waitForFunction(
      async (expectedTaskId) => {
        const sessions: Session[] = await window.electronAPI.sessions.list();
        return sessions.some((session) => session.taskId === expectedTaskId && session.status === 'running');
      },
      taskId,
      { timeout: 20_000 },
    );

    await closeApp(app);
  });
});
