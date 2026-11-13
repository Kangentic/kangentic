/**
 * The feature failures the chokepoints missed, each now reported once and with
 * no user text. A drag's worktree failure and a resume's are the two a user hits
 * most; the rest are pinned at the call that reports, so a refactor that drops
 * one fails here instead of going quiet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (text: string) => text }));

const { reportMoveSpawnFailure, spawnFailureOf } = await import('../../src/main/ipc/helpers/spawn-failure');
const { wrapWorktreeSetupError } = await import('../../src/main/ipc/helpers/worktree-setup-error');
const { isReported } = await import('../../src/main/analytics/handled-report');
const { resetLaunchReports } = await import('../../src/main/pty/agent-launch-report');
const { reportRecoveryPassFailure, resetRecoveryPassReports } = await import('../../src/main/ipc/helpers/recovery-report');
const { GitUserStateError } = await import('../../src/main/git/worktree-errors');

const task = { id: 'task-1', title: 'Fix Acme billing', agent: 'claude', agent_override: null } as never;
const repoRoot = path.join(__dirname, '../..');
const source = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('a move that failed on its worktree (reportMoveSpawnFailure)', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetLaunchReports();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('reports what git threw, under a fixed cause, and marks it so the rethrow is not sent again', () => {
    const gitFailure = new Error("fatal: cannot lock ref 'refs/heads/fix-acme-billing'");
    const wrapped = wrapWorktreeSetupError(gitFailure);
    reportMoveSpawnFailure(task, wrapped);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(sent.message).toBe('Agent launch failed: preflight (worktree_ref_lock)');
    expect(tags).toMatchObject({ stage: 'preflight', cause: 'worktree_ref_lock' });
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toMatch(/acme/i);
    // The IPC wrap sees the wrapper, and finds its cause marked.
    expect(isReported(wrapped)).toBe(true);
  });

  it('hands a dirty tree to the filter as its own type, and sends nothing for the agent step', async () => {
    const { isUserConfigurationError } = await import('../../src/shared/user-configuration-error');
    reportMoveSpawnFailure(task, wrapWorktreeSetupError(new GitUserStateError('uncommitted changes')));
    // The real reportHandledError drops a user-configuration error by its type.
    expect(isUserConfigurationError(reportHandledError.mock.calls[0][0])).toBe(true);
    reportHandledError.mockReset();
    reportMoveSpawnFailure(task, new TypeError('spawn broke'));
    expect(reportHandledError).not.toHaveBeenCalled();
    expect(spawnFailureOf(new TypeError('x')).step).toBe('agent');
  });

  it('is called from handleTaskMove\'s outer catch, ahead of the rethrow', () => {
    const moveSource = source('src/main/ipc/handlers/task-move.ts');
    expect(moveSource).toMatch(/reportMoveSpawnFailure\(task, error\);\s*throw error;/);
    expect(moveSource).toContain("taskMoveReporter.report(rollbackError, { tags: { stage: 'rollback' } });");
  });
});

describe('a whole recovery pass that threw', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetRecoveryPassReports();
  });

  it('reports once, tagged by its pass, with no board name', () => {
    // One throw site, so both errors carry the same frames, as a pass that fails twice does.
    const sameSite = (): TypeError => new TypeError("Cannot read properties of undefined (reading 'swimlane_id')");
    reportRecoveryPassFailure('session_recovery', sameSite());
    reportRecoveryPassFailure('session_recovery', sameSite());
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'project_recovery', pass: 'session_recovery' });
  });
});

describe('every other gap reports at the site that only logged', () => {
  it.each([
    ['src/main/ipc/handlers/session-resume.ts', "cause: step === 'worktree' ? worktreeFailureCause(error) : 'resume',"],
    ['src/main/ipc/handlers/projects.ts', "reportRecoveryPassFailure('cold_open', error);"],
    ['src/main/ipc/handlers/projects.ts', "reportRecoveryPassFailure('pty_host_loss', error);"],
    ['src/main/ipc/register-all.ts', "reportRecoveryPassFailure('remote_projects', error);"],
    ['src/main/db/database.ts', "notifyOpenFailure(error, { database: 'global', stage });"],
    ['src/main/db/database.ts', "notifyOpenFailure(error, { database: 'project', stage });"],
    ['src/main/index.ts', 'setDbOpenFailureNotifier((error, failure) => {'],
    ['src/main/pty/lifecycle/session-id-manager.ts', 'this.callbacks.onSessionIdNotCaptured?.(sessionId);'],
    ['src/main/retrieval/retrieval-client.ts', 'reportRetrievalWorkerFailure(record);'],
    ['src/main/retrieval/embedder/embed-client.ts', 'reportEmbedInitFailure();'],
    ['src/main/transcription/transcription-service.ts', 'reportDictationFailure(error, context.remote);'],
    ['src/main/held-messages/held-messages.ts', "heldMessagesReporter.report(error, { tags: { stage: 'read' } });"],
    ['src/main/ipc/handlers/sessions.ts', "sessionHandlersReporter.report(error, { tags: { stage: 'idle_pause' } });"],
    ['src/main/git/worktree-manager.ts', 'reportWorktreeRemovalFailure({ profile, timedOut, holders: holders.length > 0, attempt: lastAttempt });'],
    ['src/main/diagnostics/crash-capture.ts', "if (isOwnWindow(webContents)) preloadReporter.report(error, { tags: { kind: 'preload_error' } });"],
    ['src/main/pop-out/pop-out-window-manager.ts', 'popOutLoadReporter.report(failed, { tags: { kind, error_code: String(errorCode) } });'],
    ['src/main/accounts/account-continuation.ts', "accountsReporter.report(error, { tags: { stage: 'continuation' } });"],
    ['src/main/ipc/handlers/metrics-snapshot-timer.ts', "metricsSnapshotReporter.report(error, { tags: { stage: 'batch' } });"],
    ['src/main/artifacts/artifact-detection.ts', "artifactDetectionReporter.report(error, { tags: { stage: 'detect' } });"],
    ['src/renderer/stores/board-store/board-hydration-slice.ts', "reportRendererFailure('board', 'load', error);"],
    ['src/renderer/window-manager/bridge/useTaskDetailWindowBridge.ts', "reportRendererFailure('task_detail', 'open', error);"],
    ['src/renderer/hooks/useTerminal.ts', "reportRendererFailure('terminal', 'replay', error, { replay: { trigger: 'mount' } });"],
    ['src/renderer/utils/terminal-webgl.ts', "reportRendererFailure('terminal', 'webgl_fallback', fallback,"],
  ])('%s: %s', (file, call) => {
    expect(source(file)).toContain(call);
  });
});
