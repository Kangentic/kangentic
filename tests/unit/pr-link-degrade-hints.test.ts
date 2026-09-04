import { describe, it, expect, vi } from 'vitest';
import type { Task } from '../../src/shared/types';

/**
 * Unit test for `resolverUnavailableHintsShown`'s REASON-KEYED behavior (the
 * bounded set in pr-linking.ts that gates the "PR auto-linking is degraded"
 * console.warn to at most once per distinct reason). Before this file, no
 * test anywhere spied on console.warn for this path.
 *
 * Pins: two degrades carrying DIFFERENT error.message values must BOTH warn,
 * and a repeat of the same message must NOT warn again. Reverting to a
 * single boolean latch (warn once ever, regardless of reason) makes the
 * third assertion below red.
 *
 * `resolverUnavailableHintsShown` is module-level state that persists across
 * every test that shares one import of pr-linking.ts. This file owns its own
 * process/module registry (each Vitest test file gets an isolated module
 * graph), so it does not need to coordinate with the eviction test in
 * `pr-link-degrade-hint-eviction.test.ts` - deliberately kept in a separate
 * file rather than sharing this one, so neither test's fill count can leak
 * into the other's cap-boundary math.
 */

const conn = vi.hoisted(() => ({
  byNumber: null as unknown,
  byBranch: null as unknown,
  byCommit: null as unknown,
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async () => 'HEAD',
    raw: async () => '0',
  }),
}));

// linkPRForTask never calls getProjectRepos itself, but pr-linking.ts's
// top-level imports pull in modules (send-to-renderer -> ipc-recorder) that
// need electron at module scope - mocked here for the same reason
// pr-link-ladder.test.ts mocks them.
const repos = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => repos.value }));

const recordPushSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/diagnostics/ipc-recorder', () => ({ recordPush: recordPushSpy }));

vi.mock('../../src/main/pr/pr-registry', async () => {
  const { PRResolverUnavailableError, PRResolverTransientError } = await import(
    '../../src/main/pr/shared/pr-errors'
  );
  const make = (key: 'byNumber' | 'byBranch' | 'byCommit') => async () => {
    const value = conn[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return {
    PRResolverUnavailableError,
    PRResolverTransientError,
    resolvePRByNumber: make('byNumber'),
    resolvePRForBranch: make('byBranch'),
    resolvePRByCommit: make('byCommit'),
    detectPR: () => null,
  };
});

import { linkPRForTask } from '../../src/main/pr/pr-linking';
import { PRResolverUnavailableError } from '../../src/main/pr/pr-registry';

let idCounter = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  idCounter += 1;
  return {
    id: `task-${idCounter}`, display_id: idCounter, title: 'T', description: '', swimlane_id: 'lane', position: 0,
    agent: null, session_id: null, worktree_path: null, branch_name: null, pr_number: null,
    pr_url: null, pr_state: null, head_sha: null, external_id: null, external_source: null,
    external_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0,
    model_override: null, effort_override: null, agent_override: null, attachment_count: 0,
    archived_at: null, created_at: 't', updated_at: 't', ...overrides,
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

describe('pr-linking: resolverUnavailableHintsShown is reason-keyed', () => {
  it('warns once per distinct reason, and never repeats an already-warned reason', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const taskOne = makeTask({ pr_number: 1 });
      conn.byNumber = new PRResolverUnavailableError('reason-one');
      const resultOne = await linkPRForTask(taskOne.id, depsFor(taskOne));
      expect(resultOne.status).toBe('resolver-unavailable');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Same reason again (a different task) must NOT warn a second time.
      const taskOneRepeat = makeTask({ pr_number: 1 });
      conn.byNumber = new PRResolverUnavailableError('reason-one');
      await linkPRForTask(taskOneRepeat.id, depsFor(taskOneRepeat));
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // A DIFFERENT reason must warn again. This is the load-bearing
      // assertion for reason-keying: a single boolean latch (warn once ever)
      // would leave this at 1, since it would already have tripped on
      // "reason-one".
      const taskTwo = makeTask({ pr_number: 2 });
      conn.byNumber = new PRResolverUnavailableError('reason-two');
      await linkPRForTask(taskTwo.id, depsFor(taskTwo));
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
