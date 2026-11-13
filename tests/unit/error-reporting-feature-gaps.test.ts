/**
 * The feature failures the chokepoints missed, each now reported once and with
 * no user text. A drag's worktree failure and a recovery pass are driven here.
 * Every other feature site is driven with a throwing dependency in its own file:
 * error-reporting-task-lifecycle-behavior.test.ts (task move, resume, the
 * project open passes), error-reporting-main-features-behavior.test.ts (held
 * messages, the idle pause, metrics, artifacts, accounts),
 * error-reporting-worktree-session-crash-behavior.test.ts (worktree removal, the
 * session id miss, crash capture), error-reporting-renderer-sites-behavior.test.ts,
 * db-open-failure-notifier.test.ts, dictation-failure-report.test.ts,
 * retrieval-client.test.ts, embed-client.test.ts, pop-out-window-manager.test.ts,
 * and, in real Electron, tests/e2e/push-callback-guard.spec.ts.
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

describe('the DB open notifier is registered at startup', () => {
  // src/main/index.ts cannot be imported (it boots the app), so this is the one
  // site pinned by its text. The notifier itself runs in db-open-failure-notifier.test.ts.
  it('registers the notifier in index.ts', () => {
    expect(source('src/main/index.ts')).toContain('setDbOpenFailureNotifier((error, failure) => {');
  });
});
