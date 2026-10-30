/**
 * `restartSessionForSettingsChange` (src/main/ipc/handlers/session-reconcile.ts)
 * and the prompt a resume could not carry on its command line.
 *
 * The engine's `resumeSuspendedSession` hands back a `SpawnOutcome`. When its
 * `unsentPrompt` is a string, the resume left the `resumePrompt` it was given
 * off the CLI's command line (a launch that would flatten it, one over the
 * cap), so the caller has to type it in. See the `SpawnOutcome.unsentPrompt`
 * docblock in src/main/transition-engine/transition-engine.ts.
 *
 * The delivery must reach the RESUMED session, which has a different id from
 * the one that was suspended, so the post-respawn read of the task is what
 * names the target. `restart-session-for-settings-change.test.ts` covers the
 * rest of this function and leaves the engine's outcome as `undefined`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  deliverAgentMessageInBackground: vi.fn(),
  resolveInjectionVerifier: vi.fn(),
  verifier: { name: 'resolved-verifier' },
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    // No own-record row, so applySuspendDbWrites falls back to getLatestForTask.
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = vi.fn(() => ({
      id: 'rec-1',
      task_id: 'task-unsent-1',
      agent_session_id: 'agent-X',
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      session_type: 'claude_agent',
      permission_mode: 'plan',
      isolated_swimlane_id: null,
    }));
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordSuspended: vi.fn(),
  markRecordExited: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/pty/session-registry', () => ({
  decideSuspendDbAction: vi.fn(() => 'suspend'),
  isLiveSession: vi.fn(() => true),
}));

const mockCreateTransitionEngine = vi.fn();
const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: (...args: unknown[]) => hoisted.resolveInjectionVerifier(...args),
}));

vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({
  deliverAgentMessageInBackground: (...args: unknown[]) => hoisted.deliverAgentMessageInBackground(...args),
}));

// Import under test AFTER all mocks are registered.
import { restartSessionForSettingsChange } from '../../src/main/ipc/handlers/session-reconcile';

const TASK_ID = 'task-unsent-1';
const SESSION_ID = 'live-session-abc';
// The id the CLI resumes onto. Distinct from SESSION_ID so an assertion on it
// proves the delivery was aimed at the resumed session, not the suspended one.
const RESUMED_SESSION_ID = 'resumed-session-def';
const PROJECT_ID = 'proj-unsent';
const PROJECT_PATH = '/mock/unsent-project';
const UNSENT_PROMPT = 'Run the review again.\nFocus on the migration.';

function makeTask(sessionId: string | null) {
  return {
    id: TASK_ID,
    session_id: sessionId,
    swimlane_id: 'lane-executing',
    agent: 'claude',
    model_override: null,
    effort_override: null,
  };
}

function makeContext() {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: PROJECT_PATH,
    sessionManager: {
      suspend: vi.fn(async () => {}),
      getSession: vi.fn(() => null),
      markIdleAuthoritative: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'acceptEdits' },
        git: { defaultBaseBranch: 'main' },
      })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
      getBoardProfiles: vi.fn(() => []),
    },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, default_agent: 'claude', default_model: null, default_effort: null })) },
  };
}

/**
 * Arrange a restart whose engine reports `outcome`, then run it with the
 * `resumePrompt` the auto_command escalation hands in (the only caller that can
 * get a prompt back unsent). The task reads line up as: initial,
 * applySuspendDbWrites, re-read after the suspend, the post-respawn read
 * (`resumedSessionId`), and every read after that (the verifier's agent lookup).
 */
async function runRestart(outcome: { unsentPrompt: string | null } | undefined, resumedSessionId: string | null) {
  const liveTask = makeTask(SESSION_ID);
  const updatedTask = makeTask(null);
  const resumedTask = makeTask(resumedSessionId);
  const taskRepo = {
    getById: vi.fn()
      .mockReturnValueOnce(liveTask)
      .mockReturnValueOnce(liveTask)
      .mockReturnValueOnce(updatedTask)
      .mockReturnValue(resumedTask),
    update: vi.fn(),
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: { getById: vi.fn(() => ({ id: 'lane-executing', permission_mode: 'auto', model_override: null, effort_override: null })) },
    automations: {},
    automationRuns: {},
    attachments: {},
  });
  mockCreateTransitionEngine.mockReturnValue({
    resumeSuspendedSession: vi.fn(async () => outcome),
  });
  const context = makeContext();

  const result = await restartSessionForSettingsChange(
    context as never,
    PROJECT_ID,
    PROJECT_PATH,
    TASK_ID,
    { phase: 'switching-model', resumePrompt: UNSENT_PROMPT },
  );
  return { result, context };
}

describe('restartSessionForSettingsChange: a resume prompt the CLI did not take', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveInjectionVerifier.mockReturnValue(hoisted.verifier);
  });

  it('types the unsent prompt into the resumed session, at once, as a fresh spawn', async () => {
    const { result, context } = await runRestart({ unsentPrompt: UNSENT_PROMPT }, RESUMED_SESSION_ID);

    expect(result).toEqual({ ok: true });
    expect(hoisted.deliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverAgentMessageInBackground).toHaveBeenCalledWith(context, expect.objectContaining({
      taskId: TASK_ID,
      // The resumed session, never the id that was suspended a moment ago.
      sessionId: RESUMED_SESSION_ID,
      message: UNSENT_PROMPT,
      mode: 'immediate',
      freshlySpawned: true,
      verifier: hoisted.verifier,
    }));
    expect(hoisted.resolveInjectionVerifier).toHaveBeenCalledWith('claude', expect.anything(), TASK_ID);
  });

  it('delivers nothing when the resume carried the whole prompt itself', async () => {
    const { result } = await runRestart({ unsentPrompt: null }, RESUMED_SESSION_ID);

    expect(result).toEqual({ ok: true });
    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  it('delivers nothing when the engine reports no outcome at all', async () => {
    const { result } = await runRestart(undefined, RESUMED_SESSION_ID);

    expect(result).toEqual({ ok: true });
    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  it('delivers nothing when no session was left to type into, and still succeeds', async () => {
    const { result } = await runRestart({ unsentPrompt: UNSENT_PROMPT }, null);

    expect(result).toEqual({ ok: true });
    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  it('warns with the reason when the typed-in prompt was not delivered, and stays quiet otherwise', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runRestart({ unsentPrompt: UNSENT_PROMPT }, RESUMED_SESSION_ID);
      // Only what the callback logs counts, not anything the restart itself warned.
      warnSpy.mockClear();
      const input =hoisted.deliverAgentMessageInBackground.mock.calls[0][1] as {
        onOutcome: (report: { outcome: string; reason?: string }) => void;
      };

      input.onOutcome({ outcome: 'confirmed' });
      input.onOutcome({ outcome: 'unconfirmed' });
      expect(warnSpy).not.toHaveBeenCalled();

      input.onOutcome({ outcome: 'failed', reason: 'the terminal closed' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('the terminal closed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
