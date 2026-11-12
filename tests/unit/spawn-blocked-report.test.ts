/**
 * What a blocked start tells Sentry. Git writes branch names into its errors, and
 * a branch is named after a task, so the event says which step failed and nothing
 * git said. A dirty tree or a branch in use is the user's to resolve and stays
 * out, or one repository's state would fill the issue stream. Without this a
 * worktree failure on any of the eleven `notifySpawnBlocked` paths is a toast and
 * nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportHandledError = vi.hoisted(() => vi.fn());
const shuttingDown = vi.hoisted(() => ({ value: false }));

vi.mock('electron', () => ({ app: { getPath: () => '/mock', isPackaged: false } }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: () => shuttingDown.value }));

import { BranchCheckoutBlockedError, notifySpawnBlocked } from '../../src/main/ipc/helpers/task-git';
import {
  GitUserStateError,
  StaleWorktreeDirectoryError,
  isRepositoryStateRefusal,
} from '../../src/main/git/worktree-errors';
import { reportPreflightFailure, resetLaunchReports } from '../../src/main/pty/agent-launch-report';
import { AgentCwdMissingError } from '../../src/main/pty/spawn/pty-spawn';
import { AgentCommandTooLongError } from '../../src/main/pty/spawn/agent-start-refused';
import { isUserConfigurationError } from '../../src/shared/user-configuration-error';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';

const BRANCH_TEXT = "fatal: cannot lock ref 'refs/heads/fix-acme-billing-export'";

function makeContext(destroyed = false): { context: IpcContext; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const context = {
    mainWindow: { isDestroyed: () => destroyed, webContents: { send } },
    currentProjectId: 'project-1',
  } as unknown as IpcContext;
  return { context, send };
}

const task = { id: 'task-1', title: 'Fix Acme billing', agent: 'claude', agent_override: null } as unknown as Task;

describe('notifySpawnBlocked', () => {
  beforeEach(() => {
    reportHandledError.mockClear();
    shuttingDown.value = false;
    resetLaunchReports();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a git failure under its step, with none of what git said', () => {
    const { context, send } = makeContext();
    notifySpawnBlocked(context, task, 'worktree', new Error(BRANCH_TEXT), 'project-1');

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('AgentLaunchPreflightError');
    expect(tags).toMatchObject({ stage: 'preflight', cause: 'worktree_ref_lock', agent: 'claude', start_path: 'board' });
    const sent = JSON.stringify([(error as Error).message, tags]);
    expect(sent).not.toContain('acme');
    expect(sent).not.toContain('Acme');
    expect(sent).not.toContain('refs/heads');
    // The user still sees it.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('names the start path it was given', () => {
    const { context } = makeContext();
    notifySpawnBlocked(context, task, 'checkout', new Error(BRANCH_TEXT), 'project-1', 'phone');
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ cause: 'checkout', start_path: 'phone' });
  });

  it('gives a folder that would not clear its own issue, since it can be our own leak', () => {
    const { context } = makeContext();
    notifySpawnBlocked(context, task, 'worktree', new StaleWorktreeDirectoryError('Cannot create worktree: stale'), 'project-1');
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ cause: 'stale_directory', error_type: 'StaleWorktreeDirectoryError' });
  });

  it.each([
    ['a dirty tree', new GitUserStateError("Cannot switch to branch 'x': you have uncommitted changes.")],
    ['a branch in use', new GitUserStateError("fatal: 'x' is already checked out at '/mock/other'")],
    ['a blocked checkout', new BranchCheckoutBlockedError('/mock/project', 'task-2', 'Other task')],
  ])('hands %s to the filter as its own type, and tells the user', (_label, error) => {
    const { context, send } = makeContext();
    notifySpawnBlocked(context, task, 'checkout', error, 'project-1');
    // The filter itself runs for real in launch-user-setup-exclusion.test.ts.
    expect(isUserConfigurationError(reportHandledError.mock.calls[0][0])).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('leaves the agent step to the catch that reported it', () => {
    const { context } = makeContext();
    notifySpawnBlocked(context, task, 'agent', new Error('spawn failed'), 'project-1');
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a failure with no window to tell', () => {
    const { context, send } = makeContext(true);
    notifySpawnBlocked(context, task, 'worktree', new Error(BRANCH_TEXT), 'project-1');
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing during a quit, whose git failures are the quit itself', () => {
    shuttingDown.value = true;
    const { context } = makeContext();
    notifySpawnBlocked(context, task, 'worktree', new Error(BRANCH_TEXT), 'project-1');
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('does not count an abort as a failure', () => {
    const { context } = makeContext();
    notifySpawnBlocked(context, task, 'worktree', new DOMException('aborted', 'AbortError'), 'project-1');
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('a refused agent start', () => {
  beforeEach(() => {
    reportHandledError.mockClear();
    resetLaunchReports();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Sentry DESKTOP-2P: the path is redacted, so without this tag a gone
  // worktree and a gone project folder sent the same event.
  it.each([
    ['a gone worktree', '/Users/dev/acme/.kangentic/worktrees/1003', 'worktree-missing'],
    ['a gone project folder', '/Users/dev/acme', 'folder-missing'],
    ['a gone worktree on a Windows path', 'C:\\Users\\dev\\acme\\.kangentic\\worktrees\\1003', 'worktree-missing'],
  ])('names %s by its fixed reason, and no path', (_label, cwd, reason) => {
    reportPreflightFailure({ cause: 'agent_start', error: new AgentCwdMissingError(cwd), agent: 'claude', startPath: 'board', keepMessage: true });

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags] = reportHandledError.mock.calls[0];
    expect(tags).toMatchObject({ cause: 'agent_start', error_type: 'AgentCwdMissingError', start_refused_reason: reason });
    const sent = JSON.stringify([(error as Error).message, tags]);
    expect(sent).not.toContain('acme');
    // Neither home-directory spelling, with either separator (JSON doubles a backslash).
    expect(sent).not.toContain('/Users/dev');
    expect(sent).not.toContain('Users\\\\dev');
    expect(sent).not.toContain('Users\\dev');
  });

  it('names a prompt too long for the agent by its fixed reason', () => {
    reportPreflightFailure({ cause: 'agent_start', error: new AgentCommandTooLongError(), agent: 'claude', startPath: 'board', keepMessage: true });

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({
      cause: 'agent_start',
      error_type: 'AgentCommandTooLongError',
      start_refused_reason: 'prompt-too-long',
    });
  });

  it('sends no reason for an error that is not a refusal', () => {
    reportPreflightFailure({ cause: 'agent_start', error: new Error('spawn failed'), agent: 'claude', startPath: 'board', keepMessage: true });
    expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty('start_refused_reason');
  });
});

describe('worktree errors', () => {
  it('types the repository state as the user\'s, and a stuck folder as ours to see', () => {
    expect(isUserConfigurationError(new GitUserStateError('x'))).toBe(true);
    expect(isUserConfigurationError(new StaleWorktreeDirectoryError('x'))).toBe(false);
  });

  it('keeps the message and the cause', () => {
    const cause = new Error('git said so');
    const error = new GitUserStateError('Cannot create worktree', { cause });
    expect(error.message).toBe('Cannot create worktree');
    expect(error.cause).toBe(cause);
  });

  it.each([
    ["fatal: 'feature/x' is already checked out at '/mock/other'", true],
    ["fatal: 'feature/x' is already used by worktree at '/mock/other'", true],
    // Ours: the folder is Kangentic's, and we checked the branch was not there.
    ["fatal: a branch named 'feature/x' already exists", false],
    ["fatal: '/mock/worktrees/1' already exists", false],
    ['fatal: unable to access remote', false],
    ['error: could not lock config file', false],
  ])('reads %j as %s', (message, expected) => {
    expect(isRepositoryStateRefusal(message)).toBe(expected);
  });
});
