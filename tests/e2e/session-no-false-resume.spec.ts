/**
 * E2E test for the session recovery re-entrancy guard.
 *
 * Verifies that:
 *  1. A brand-new task moved to Planning gets a fresh session (--session-id),
 *     NOT a --resume attempt
 *  2. Re-opening the same project (simulating a Vite hot-reload) does NOT
 *     orphan or try to resume active sessions
 *  3. After a duplicate PROJECT_OPEN, the original session is still running
 *
 * Bug context: Vite hot-reload triggers did-finish-load, which re-opens the
 * project and runs session recovery. markAllRunningAsOrphaned() was corrupting
 * records for sessions that were JUST created, causing --resume on sessions
 * with no JSONL file → "No conversation found" error.
 *
 * Uses mock-claude so tests work without a real Claude installation.
 *
 * Migrated to shared-app fixture (2026-06-08): boots once per worker instead
 * of once per spec file, saving ~3-5s of Electron launch overhead.
 */
import { test, expect } from './shared-app';
import { createTask } from './helpers';

const runId = Date.now();

test.describe('Claude Agent -- No False Resume on New Tasks', () => {
  test('new task moved to Planning gets fresh session, not resume', async ({ freshProject }) => {
    const { page } = freshProject;
    // Create a task in To Do and move it to Planning via IPC
    const title = `Fresh Session ${runId}`;
    await createTask(page, title, 'Should use --session-id, not --resume');

    const { taskId, planningSwimlaneId } = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: { title: string }) => tk.title === t);
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: { name: string }) => s.name === 'Planning');
      return { taskId: task?.id, planningSwimlaneId: planning?.id };
    }, title);
    expect(taskId).toBeTruthy();
    expect(planningSwimlaneId).toBeTruthy();

    // Move to Planning → should spawn a fresh session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: planningSwimlaneId! });

    // Wait for a running session. expect.poll, because an async predicate in
    // page.waitForFunction resolves on its first evaluation and never waits.
    await expect.poll(() => page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.some((s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running');
    }, taskId!), { timeout: 15000 }).toBe(true);

    // Wait for mock Claude to output a marker
    const start = Date.now();
    let scrollback = '';
    while (Date.now() - start < 15000) {
      scrollback = await page.evaluate(async (tid) => {
        const sessions = await window.electronAPI.sessions.list();
        const s = sessions.find((s: { taskId: string }) => s.taskId === tid);
        if (!s) return '';
        return window.electronAPI.sessions.getScrollback(s.id);
      }, taskId!);
      if (scrollback.includes('MOCK_CLAUDE_SESSION:') || scrollback.includes('MOCK_CLAUDE_RESUMED:')) {
        break;
      }
      await page.waitForTimeout(500);
    }

    // Must be a fresh SESSION, NOT a RESUMED marker
    expect(scrollback).toContain('MOCK_CLAUDE_SESSION:');
    expect(scrollback).not.toContain('MOCK_CLAUDE_RESUMED:');
  });

  test('duplicate PROJECT_OPEN does not orphan active sessions', async ({ freshProject }) => {
    const { page } = freshProject;
    const title = `Reopen Guard ${runId}`;
    await createTask(page, title, 'Session should survive re-open');

    const { taskId, planningSwimlaneId } = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: { title: string }) => tk.title === t);
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: { name: string }) => s.name === 'Planning');
      return { taskId: task?.id, planningSwimlaneId: planning?.id };
    }, title);
    expect(taskId).toBeTruthy();

    // Move to Planning → spawns session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: planningSwimlaneId! });

    // Wait for a running session and record its id. expect.poll, not
    // page.waitForFunction: an async predicate there resolves on its first
    // evaluation, so it never waited, and under load the spawn had not landed
    // by the next read.
    const readRunningSessionId = () => page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running');
      return s?.id ?? null;
    }, taskId!);
    await expect.poll(readRunningSessionId, { timeout: 15000 }).not.toBeNull();
    const sessionBefore = await readRunningSessionId();
    expect(sessionBefore).toBeTruthy();

    // Simulate what Vite hot-reload does: call PROJECT_OPEN again for the
    // same project. This should be a no-op for recovery.
    await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      if (project) {
        await window.electronAPI.projects.open(project.id);
      }
    });

    // Brief pause for any recovery to settle.
    // Intentional fixed wait: proving non-occurrence of orphaning requires a
    // bounded budget; no observable condition to poll for "nothing happened".
    await page.waitForTimeout(1000);

    // The session should STILL be running with the same ID
    const sessionAfter = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running');
      return s?.id ?? null;
    }, taskId!);

    expect(sessionAfter).toBe(sessionBefore);

    // Verify the session is actually alive (mock Claude is still producing output)
    const scrollback = await page.evaluate(async (sid) => {
      return window.electronAPI.sessions.getScrollback(sid);
    }, sessionBefore!);
    expect(scrollback.length).toBeGreaterThan(0);
  });
});
