import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The retrieval worker's indexing methods (`worker/index-methods.ts`): which
 * sweeps one `index.sweep` runs and in what order, a `job.cancel` stopping a
 * job between its steps, the source code plan, and the remote servers main's
 * adapters learned reaching the worker's adapters before a conversation read.
 * The indexers themselves are stubs; their own suites cover what they write.
 */

const order = vi.hoisted(() => [] as string[]);
const gates = vi.hoisted(() => ({ taskSweep: null as Promise<void> | null }));

vi.mock('../../src/main/retrieval/conversation/conversation-indexer', () => ({
  ConversationIndexer: class {
    purgeDeletedSessions = vi.fn(async (_projectId: string, _shouldContinue: () => boolean, options: { fromChunks?: boolean }) => {
      order.push(options.fromChunks ? 'purge:chunks' : 'purge:state');
      return 2;
    });
    sweepProject = vi.fn(async () => { order.push('conversations'); });
    indexSession = vi.fn(async () => { order.push('session'); return 'indexed'; });
    indexSubagentUsage = vi.fn(async () => { order.push('subagents'); return 'indexed'; });
  },
}));
vi.mock('../../src/main/retrieval/task/task-indexer', () => ({
  sweepTaskRecords: vi.fn(async () => {
    order.push('tasks');
    if (gates.taskSweep) await gates.taskSweep;
    return { indexed: 1, removed: 0 };
  }),
}));
vi.mock('../../src/main/retrieval/change/change-indexer', () => ({
  sweepChangeRecords: vi.fn(async () => { order.push('changes'); return { indexed: 3 }; }),
}));
vi.mock('../../src/main/retrieval/commit/commit-indexer', () => ({
  sweepCommitRecords: vi.fn(async () => { order.push('commits'); return { indexed: 0, removed: 0, relinked: 0, deferred: true }; }),
}));
vi.mock('../../src/main/retrieval/code/code-indexer', () => ({
  sweepCodeRecords: vi.fn(async () => { order.push('code'); return { indexed: 4, removed: 0, deferred: false }; }),
  purgeCodeRecords: vi.fn(() => { order.push('code:clear'); return true; }),
}));
const adopted = vi.hoisted(() => [] as unknown[]);
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => ['remote-agent'],
    get: () => ({ remoteExecution: { adoptTargets: (targets: unknown) => adopted.push(targets) } }),
  },
}));

import { indexHandlers } from '../../src/main/retrieval/worker/index-methods';
import { sweepCommitRecords } from '../../src/main/retrieval/commit/commit-indexer';
import { sweepChangeRecords } from '../../src/main/retrieval/change/change-indexer';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';

const context: WorkerContext = {
  getDb: () => { throw new Error('no database in this test'); },
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
};
const TARGET = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' }, workingDirectory: null };

describe('retrieval worker index methods', () => {
  beforeEach(() => {
    order.length = 0;
    adopted.length = 0;
    gates.taskSweep = null;
    vi.clearAllMocks();
  });

  it('runs a project open\'s sweeps in order, with what main sent, and returns their counts', async () => {
    const result = await indexHandlers['index.sweep']({
      projectId: 'project-1',
      remoteTargets: [{ adapter: 'remote-agent', targets: [['/mock/worktree', TARGET as never]] }],
      purge: 'chunks',
      conversations: true,
      tasks: true,
      changes: { projectPath: '/mock/project' },
      commits: { projectPath: '/mock/project', baseBranch: 'main', allowFullRead: false },
      code: { plan: 'index', projectPath: '/mock/project', baseBranch: 'main', allowFullRead: false },
    }, context);

    expect(order).toEqual(['purge:chunks', 'conversations', 'tasks', 'changes', 'commits', 'code']);
    expect(sweepCommitRecords).toHaveBeenCalledWith('project-1', '/mock/project', 'main', expect.objectContaining({ allowFullRead: false }));
    expect(result).toEqual({
      purged: 2,
      tasks: { indexed: 1, removed: 0 },
      changes: { indexed: 3 },
      commits: { indexed: 0, removed: 0, relinked: 0, deferred: true },
      code: { indexed: 4, removed: 0, deferred: false },
    });
    // The worker's adapter read the remote session's transcript from the
    // server main's adapter learned at spawn.
    expect(adopted).toEqual([[['/mock/worktree', TARGET]]]);
  });

  it('runs only the steps asked for', async () => {
    const result = await indexHandlers['index.sweep']({ projectId: 'project-1', remoteTargets: [], changes: { projectPath: null } }, context);
    expect(order).toEqual(['changes']);
    expect(result.tasks).toBeNull();
    expect(result.purged).toBe(0);
  });

  it('clears the code index when source code is switched off, and leaves it while it waits', async () => {
    const cleared = await indexHandlers['index.sweep']({
      projectId: 'project-1', remoteTargets: [], code: { plan: 'clear', projectPath: '/mock/project', baseBranch: 'main', allowFullRead: true },
    }, context);
    expect(order).toEqual(['code:clear']);
    expect(cleared.code).toEqual({ indexed: 0, removed: 1, deferred: false });
    order.length = 0;
    const kept = await indexHandlers['index.sweep']({
      projectId: 'project-1', remoteTargets: [], code: { plan: 'keep', projectPath: '/mock/project', baseBranch: 'main', allowFullRead: true },
    }, context);
    expect(order).toEqual([]);
    expect(kept.code).toEqual({ indexed: 0, removed: 0, deferred: false });
  });

  it('stops a job between steps when main cancels it, and ignores a cancel for a job that is not running', async () => {
    let releaseTasks: () => void = () => undefined;
    gates.taskSweep = new Promise((resolve) => { releaseTasks = resolve; });
    const job = indexHandlers['index.sweep']({
      projectId: 'project-1', jobId: 'open-1', remoteTargets: [], tasks: true, changes: { projectPath: null },
    }, context);
    await vi.waitFor(() => expect(order).toEqual(['tasks']));
    await indexHandlers['job.cancel']({ jobId: 'open-1' }, context);
    releaseTasks();
    const result = await job;
    expect(order).toEqual(['tasks']);
    expect(sweepChangeRecords).not.toHaveBeenCalled();
    expect(result.changes).toBeNull();

    // A cancel that arrives after its job finished leaves the next job with
    // that id alone.
    await indexHandlers['job.cancel']({ jobId: 'open-2' }, context);
    order.length = 0;
    await indexHandlers['index.sweep']({ projectId: 'project-1', jobId: 'open-2', remoteTargets: [], changes: { projectPath: null } }, context);
    expect(order).toEqual(['changes']);
  });

  it('re-reads a finished session with its subagents and the files it changed, and a live one alone', async () => {
    const finished = await indexHandlers['index.session']({
      projectId: 'project-1', sessionId: 'session-1', subagents: true, changes: { projectPath: '/mock/project' }, remoteTargets: [],
    }, context);
    expect(order).toEqual(['session', 'subagents', 'changes']);
    expect(finished).toEqual({ outcome: 'indexed', changesIndexed: 3 });
    order.length = 0;
    const live = await indexHandlers['index.session']({
      projectId: 'project-1', sessionId: 'session-1', subagents: false, changes: null, remoteTargets: [],
    }, context);
    expect(order).toEqual(['session']);
    expect(live).toEqual({ outcome: 'indexed', changesIndexed: 0 });
  });
});
