/**
 * E2E: a resume the CLI says found no conversation heals by itself (DESKTOP-2E).
 *
 * A launch 0.54.0 paused has no mark, so a resume ran `--resume` on an id the CLI
 * never wrote, the retry ran the same line, and the task stayed paused with its
 * prompt undelivered. Each step has a unit test. What only this proves is that they
 * meet: a real PTY, the shell outliving the CLI, the agent-absence sweep over a real
 * process tree, the pause, the mark once the output read lands, and the retry going
 * through the real engine to a fresh start with the first launch's prompt.
 *
 * Slow on purpose: the sweep runs on its 60 s cadence and confirms over two cycles,
 * and no hook can hurry it, since a CLI that signalled its end would have shown it ran.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  waitForTaskSession,
  waitForTaskSessionNotRunning,
  resolveMockAgentPath,
} from './helpers';

const TEST_NAME = 'resume-miss-heal';
const SWEEP_DEADLINE_MS = 240_000;
const PROMPT_MARKER = 'RESUMEMISSPROMPT';
const CONVERSATION = /MOCK_CLAUDE_SESSION:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** Terminal text with escapes and every space gone, since a long line can wrap. */
function flattened(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '');
}

test('a resume of a conversation that never existed starts fresh once, with the prompt it owed', async () => {
  test.setTimeout(SWEEP_DEADLINE_MS + 60_000);
  const projectDirectory = createTempProject(TEST_NAME);
  const dataDir = getTestDataDir(TEST_NAME);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    claude: { cliPath: resolveMockAgentPath('mock-claude'), permissionMode: 'default', maxConcurrentSessions: 5 },
    git: { worktreesEnabled: false },
  }));
  const { app, page } = await launchApp({ dataDir, extraEnv: { MOCK_CLAUDE_RESUME_MISS: '1' } });
  try {
    await createProject(page, `Resume miss ${Date.now()}`, projectDirectory);
    const title = 'Owed prompt';
    await createTask(page, title, `Fix the redirect ${PROMPT_MARKER}`);
    const { taskId, planningId } = await page.evaluate(async (taskTitle) => {
      const tasks = await window.electronAPI.tasks.list();
      const swimlanes = await window.electronAPI.swimlanes.list();
      return {
        taskId: tasks.find((task) => task.title === taskTitle)?.id as string,
        planningId: swimlanes.find((swimlane) => swimlane.name === 'Planning')?.id as string,
      };
    }, title);

    await page.evaluate(async ({ id, swimlaneId }) => {
      await window.electronAPI.tasks.move({ taskId: id, targetSwimlaneId: swimlaneId, targetPosition: 0 });
    }, { id: taskId, swimlaneId: planningId });
    const { sessionId: firstSessionId } = await waitForTaskSession(page, taskId);
    const scrollbackOf = (sessionId: string): Promise<string> => page.evaluate(
      (id) => window.electronAPI.sessions.getScrollback(id),
      sessionId,
    );

    let firstConversation = '';
    await expect.poll(async () => {
      firstConversation = CONVERSATION.exec(flattened(await scrollbackOf(firstSessionId)))?.[1] ?? '';
      return firstConversation;
    }, { message: 'waiting for the first launch to name its conversation', timeout: 30_000 }).not.toBe('');

    await page.evaluate((id) => window.electronAPI.sessions.suspend(id), taskId);
    await waitForTaskSessionNotRunning(page, taskId, 15_000);
    await page.evaluate((id) => window.electronAPI.sessions.resume(id), taskId);

    // A fresh start is the one thing that names another conversation. With no mark
    // the retry runs the same `--resume` and misses again, so this never comes.
    let healedRun = '';
    await expect.poll(async () => {
      const latest = await page.evaluate(async ({ id, firstId }) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.filter((session) => session.taskId === id && session.id !== firstId).at(-1)?.id ?? null;
      }, { id: taskId, firstId: firstSessionId });
      if (!latest) return false;
      const flat = flattened(await scrollbackOf(latest));
      const conversations = [...flat.matchAll(new RegExp(CONVERSATION, 'g'))].map((match) => match[1]);
      const healedConversation = conversations.findLast((conversation) => conversation !== firstConversation);
      if (!healedConversation) return false;
      healedRun = flat.slice(flat.lastIndexOf(healedConversation));
      return healedRun.includes(PROMPT_MARKER);
    }, { message: 'waiting for the fresh start after the miss', timeout: SWEEP_DEADLINE_MS, intervals: [1000, 2000] }).toBe(true);

    expect(healedRun).toContain('MOCK_CLAUDE_PROMPT:');
    expect(healedRun).not.toContain('MOCK_CLAUDE_RESUMED:');
  } finally {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  }
});
