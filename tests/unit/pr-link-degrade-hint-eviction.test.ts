import { describe, it, expect, vi } from 'vitest';
import type { Task } from '../../src/shared/types';

/**
 * Unit test for `resolverUnavailableHintsShown`'s bounded-eviction behavior
 * (the Set in pr-linking.ts capped at MAX_RESOLVER_HINTS = 32). Before this
 * file, no test anywhere spied on console.warn for this path.
 *
 * THE FIX under test: on overflow the set used to call `.clear()`, wiping
 * every already-warned reason so the next distinct reason re-warned all of
 * them. It now evicts only the OLDEST entry (`Set` preserves insertion
 * order). Pins: after filling the cap with 32 distinct reasons, one more
 * distinct reason evicts the FIRST one (so it warns again) while a RECENT
 * one - still cached - stays suppressed. Reverting the eviction to `.clear()`
 * makes the final assertion below red (a wholesale clear would let the
 * recent reason warn again too).
 *
 * Kept in its own file (rather than alongside the reason-keyed test in
 * pr-link-degrade-hints.test.ts) so the fill-to-32 math never has to account
 * for entries another test already pushed into the module-level Set. Each
 * Vitest test file gets an isolated module graph, so this file's very first
 * import of pr-linking.ts starts with an empty set.
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

describe('pr-linking: resolverUnavailableHintsShown evicts oldest on overflow', () => {
  it('evicts the OLDEST reason on overflow rather than clearing the whole set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Fill the set to exactly MAX_RESOLVER_HINTS (32) distinct reasons.
      for (let index = 0; index < 32; index += 1) {
        conn.byNumber = new PRResolverUnavailableError(`fill-reason-${index}`);
        const task = makeTask({ pr_number: 100 + index });
        // Sequential fill (not Promise.all): each iteration must observe the
        // set state left by the previous one.
        const result = await linkPRForTask(task.id, depsFor(task));
        expect(result.status).toBe('resolver-unavailable');
      }
      expect(warnSpy).toHaveBeenCalledTimes(32);

      // A 33rd DISTINCT reason overflows the cap -> evicts the oldest entry
      // ("fill-reason-0"), never the whole set.
      const overflowTask = makeTask({ pr_number: 200 });
      conn.byNumber = new PRResolverUnavailableError('fill-reason-32');
      await linkPRForTask(overflowTask.id, depsFor(overflowTask));
      expect(warnSpy).toHaveBeenCalledTimes(33);

      // The evicted (oldest) reason is no longer suppressed - it warns again.
      // (This half alone would also pass under the old `.clear()` behavior;
      // the next assertion is the one that discriminates between them.)
      const repeatEvicted = makeTask({ pr_number: 201 });
      conn.byNumber = new PRResolverUnavailableError('fill-reason-0');
      await linkPRForTask(repeatEvicted.id, depsFor(repeatEvicted));
      expect(warnSpy).toHaveBeenCalledTimes(34);

      // A RECENT reason (still cached, never evicted) stays suppressed.
      // Under the old `.clear()`-on-overflow behavior, the overflow add above
      // would have wiped every entry at once, so this would ALSO warn again
      // here - this is the assertion that actually distinguishes "evict
      // oldest" from "clear everything".
      const repeatRecent = makeTask({ pr_number: 202 });
      conn.byNumber = new PRResolverUnavailableError('fill-reason-31');
      await linkPRForTask(repeatRecent.id, depsFor(repeatRecent));
      expect(warnSpy).toHaveBeenCalledTimes(34);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
