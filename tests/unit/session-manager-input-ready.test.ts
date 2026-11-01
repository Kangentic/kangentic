/**
 * `SessionManager.awaitInputReady` for an agent marked as drawing its input box
 * in the alternate screen (`SpawnSessionInput.inputInAlternateScreen`).
 *
 * A background paste waits there until the TUI enters the alternate screen, so
 * it never lands in a screen the agent shows first (an MCP server approval).
 * A launch judged fullscreen can still draw classic: a renderer variable set
 * only in the user's shell profile reaches the agent but not Kangentic, and
 * that agent never enters the alternate screen. Its hook reporting a prompt
 * puts it past every boot screen, so the paste goes on instead of waiting out
 * the hour-long turn budget and failing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';

const TASK_ID = 'task-input-ready';
const PROJECT_ID = 'project-input-ready';
const SESSION_ID = 'sess-classic-misjudged';

describe('SessionManager.awaitInputReady: a prompt the agent took ends the wait', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function seedRunningRow(id: string): void {
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(id, {
      id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      pty: { sealUserInput: vi.fn() } as unknown as ManagedSession['pty'],
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);
  }

  function markInputInAlternateScreen(id: string): void {
    (manager as unknown as { inputInAlternateScreen: Set<string> }).inputInAlternateScreen.add(id);
  }

  function reportPrompt(id: string): void {
    const telemetry = (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
    telemetry.ingestEvents(id, [{ ts: Date.now(), type: EventType.Prompt }]);
  }

  it('holds a paste for an agent that has neither entered the alternate screen nor taken a prompt', async () => {
    seedRunningRow(SESSION_ID);
    markInputInAlternateScreen(SESSION_ID);

    await expect(manager.awaitInputReady(SESSION_ID, 0)).resolves.toBe(false);
  });

  it('lets the paste go once the agent has taken a prompt, though it never entered the alternate screen', async () => {
    seedRunningRow(SESSION_ID);
    markInputInAlternateScreen(SESSION_ID);

    reportPrompt(SESSION_ID);

    // Red: without the prompt signal this waited for an alternate screen that
    // a classic renderer never enters, and answered false.
    await expect(manager.awaitInputReady(SESSION_ID, 0)).resolves.toBe(true);
  });

  it('ends a wait already in progress when the prompt arrives', async () => {
    seedRunningRow(SESSION_ID);
    markInputInAlternateScreen(SESSION_ID);

    const waiting = manager.awaitInputReady(SESSION_ID, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    reportPrompt(SESSION_ID);

    await expect(waiting).resolves.toBe(true);
  });

  it('a prompt from another session does not end the wait', async () => {
    seedRunningRow(SESSION_ID);
    seedRunningRow('sess-other');
    markInputInAlternateScreen(SESSION_ID);

    reportPrompt('sess-other');

    await expect(manager.awaitInputReady(SESSION_ID, 0)).resolves.toBe(false);
  });

  it('forgets the prompt with the session, so a reused id waits again', async () => {
    seedRunningRow(SESSION_ID);
    markInputInAlternateScreen(SESSION_ID);
    reportPrompt(SESSION_ID);

    manager.remove(SESSION_ID);
    seedRunningRow(SESSION_ID);
    markInputInAlternateScreen(SESSION_ID);

    await expect(manager.awaitInputReady(SESSION_ID, 0)).resolves.toBe(false);
  });
});
