/**
 * What `prReporter` sends from the real PR code: the scheduler's tick, check and
 * sweep, and the linking resolve. A defect (a TypeError out of a resolver or the
 * repository) is reported once with its `stage`; a failure the PR path throws by
 * design (a gh client's transient or unavailable error) stays out of Sentry. A
 * regression either leaves a broken PR queue silent, or floods the project with a
 * user's offline network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project, Task } from '../../src/shared/types';

const { reportHandledError } = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: <T>(_name: string, fn: () => T): T => fn(),
}));

const scheduling = vi.hoisted(() => ({
  eligible: vi.fn(),
  sweep: vi.fn(),
  link: vi.fn(),
}));

vi.mock('../../src/main/pr/pr-refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pr/pr-refresh')>();
  return { ...actual, refreshProjectPRs: scheduling.sweep, listRefreshEligibleTasks: scheduling.eligible };
});

// Real pr-linking (linkPRForTask is driven below); only the scheduler's entry
// point is replaced so a check can fail on demand.
vi.mock('../../src/main/pr/pr-linking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pr/pr-linking')>();
  return { ...actual, linkPR: scheduling.link };
});

// linkPRForTask never reads repos, but pr-linking's imports need these at load.
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => ({}) }));
vi.mock('../../src/main/diagnostics/ipc-recorder', () => ({ recordPush: vi.fn() }));
vi.mock('../../src/main/git/git-client', () => ({
  gitAt: () => ({ revparse: async () => 'HEAD', raw: async () => '0' }),
}));

const resolver = vi.hoisted(() => ({ byNumber: null as unknown }));
vi.mock('../../src/main/pr/pr-registry', async () => {
  const { PRResolverUnavailableError, PRResolverTransientError } = await import('../../src/main/pr/shared/pr-errors');
  const fromConnector = async () => {
    if (resolver.byNumber instanceof Error) throw resolver.byNumber;
    return null;
  };
  return {
    PRResolverUnavailableError,
    PRResolverTransientError,
    resolvePRByNumber: fromConnector,
    resolvePRForBranch: fromConnector,
    resolvePRByCommit: fromConnector,
    detectPR: () => null,
  };
});

import { prReporter } from '../../src/main/pr/pr-report';
import { linkPRForTask } from '../../src/main/pr/pr-linking';
import { prRefreshScheduler, PR_REFRESH_MIN_GAP_MS } from '../../src/main/pr/pr-refresh-scheduler';
import { GhTransientError } from '../../src/main/boards/adapters/github-common/gh-client';

function makeContext(): IpcContext {
  return {
    currentProjectId: 'p1',
    configManager: { getEffectiveConfig: () => ({ git: { prAutoRefresh: true } }) },
  } as unknown as IpcContext;
}

const PROJECT = { id: 'p1', path: '/mock/repo/p1', name: 'p1' } as Project;

describe('prReporter in the refresh scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reportHandledError.mockClear();
    prReporter.reset();
    scheduling.eligible.mockReset().mockReturnValue([{ id: 'a' } as Task]);
    scheduling.sweep.mockReset().mockResolvedValue(undefined);
    scheduling.link.mockReset().mockResolvedValue({ status: 'unchanged', task: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    prRefreshScheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Opens the project, lets the open sweep finish, then runs one queue tick. */
  async function runOneTick(): Promise<void> {
    prRefreshScheduler.startForProject(makeContext(), PROJECT);
    await vi.advanceTimersByTimeAsync(PR_REFRESH_MIN_GAP_MS + 1);
  }

  it('reports a tick that throws a defect once, tagged stage tick', async () => {
    scheduling.eligible.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'Fix login')");
    });
    await runOneTick();

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [copy, tags] = reportHandledError.mock.calls[0];
    expect(copy.message).toBe('Handled pr failure: TypeError');
    expect(tags).toMatchObject({ source: 'pr', stage: 'tick', error_name: 'TypeError' });
    expect(JSON.stringify(tags)).not.toContain('Fix login');
  });

  it('reports nothing for a tick that fails with an expected GhTransientError', async () => {
    scheduling.eligible.mockImplementation(() => {
      throw new GhTransientError('HTTP 503 from api.github.com');
    });
    await runOneTick();

    expect(scheduling.eligible).toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a check that throws a defect once, tagged stage check', async () => {
    scheduling.link.mockRejectedValue(new TypeError('boom'));
    await runOneTick();

    expect(scheduling.link).toHaveBeenCalledTimes(1);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'pr', stage: 'check' });
  });

  it('reports a sweep that throws a defect once, tagged stage sweep, and not an expected one', async () => {
    scheduling.sweep.mockRejectedValueOnce(new GhTransientError('HTTP 503'));
    prRefreshScheduler.startForProject(makeContext(), PROJECT);
    await vi.advanceTimersByTimeAsync(0);
    expect(reportHandledError).not.toHaveBeenCalled();

    scheduling.sweep.mockRejectedValueOnce(new TypeError('boom'));
    prRefreshScheduler.startForProject(makeContext(), PROJECT);
    await vi.advanceTimersByTimeAsync(0);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'pr', stage: 'sweep' });
  });
});

describe('prReporter in the linking resolve', () => {
  let idCounter = 0;
  function makeTask(): Task {
    idCounter += 1;
    return {
      id: `task-${idCounter}`, display_id: idCounter, title: 'T', description: '', swimlane_id: 'lane', position: 0,
      agent: null, session_id: null, worktree_path: null, branch_name: null, pr_number: 7,
      pr_url: null, pr_state: null, pr_merge_readiness: null, head_sha: null, external_id: null, external_source: null,
      external_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0,
      model_override: null, effort_override: null, agent_override: null, attachment_count: 0,
      archived_at: null, created_at: 't', updated_at: 't',
    };
  }
  function depsFor(task: Task) {
    return {
      tasks: { getById: () => task, update: vi.fn((patch: Partial<Task>) => ({ ...task, ...patch })) } as never,
      projectPath: '/repo',
      onLinked: vi.fn(),
      force: true,
    };
  }

  beforeEach(() => {
    reportHandledError.mockClear();
    prReporter.reset();
    resolver.byNumber = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports a resolver defect once, tagged stage resolve', async () => {
    resolver.byNumber = new TypeError('boom');
    const task = makeTask();
    await linkPRForTask(task.id, depsFor(task));

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [copy, tags] = reportHandledError.mock.calls[0];
    expect(copy.message).toBe('Handled pr failure: TypeError');
    expect(tags).toMatchObject({ source: 'pr', stage: 'resolve' });
  });

  it('reports nothing when the resolver fails with an expected GhTransientError', async () => {
    resolver.byNumber = new GhTransientError('HTTP 503');
    const task = makeTask();
    await linkPRForTask(task.id, depsFor(task));

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
