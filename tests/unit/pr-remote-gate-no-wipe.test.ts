import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';

/**
 * End-to-end guard across the registry / linker seam, with the REAL
 * `pr-registry` and the REAL `pr-linking` (the other PR unit tests mock one or
 * the other, which is what makes the gate invisible to them).
 *
 * A clean `not-found` is destructive: `pr-linking.ts` reads it as "confidently
 * no PR" and CLEARS `pr_url` / `pr_number` / `pr_state`. So a manually pasted
 * Azure DevOps PR link must survive a sweep on a machine where the Azure CLI is
 * not installed, and must survive a repo no connector claims at all.
 *
 * Under a naive catch-and-continue registry this file goes red: the owning
 * connector's throw is swallowed, no connector answers, `next` is null with no
 * `degradeStatus`, and the pasted link is wiped on the next non-force sweep
 * (`pr-refresh.ts` passes neither `force` nor `preserveLinkOnNotFound`).
 */

const remotes = vi.hoisted(() => ({
  urls: ['git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE'] as readonly string[] | null,
}));
vi.mock('../../src/main/git/git-remotes', () => ({
  readRemoteUrls: async () => remotes.urls,
  invalidateRemoteUrlsCache: () => {},
}));

// No CLI on this machine: both `gh` and `az` detection fail.
vi.mock('which', () => ({
  default: async () => {
    throw new Error('not found');
  },
}));

// Tier 3's commits-ahead-of-base probe; '1' keeps the tier open.
vi.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async () => 'sha-current',
    raw: async () => '1',
  }),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => ({}) }));
vi.mock('../../src/main/diagnostics/ipc-recorder', () => ({ recordPush: vi.fn() }));

const { linkPRForTask } = await import('../../src/main/pr/pr-linking');

const LINKED_URL = 'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343';

let taskCounter = 0;

function makeTask(overrides: Partial<Task> = {}): Task {
  taskCounter += 1;
  return {
    id: `task-${taskCounter}`,
    title: 'Rework Dev database connections for managed identity',
    swimlane_id: 'lane-1',
    position: 0,
    branch_name: 'rework-dev-database-011d9fab',
    base_branch: 'develop',
    head_sha: 'f7d613cc5a74b784bb258da4dae0d1032c7d484f',
    worktree_path: null,
    pr_url: LINKED_URL,
    pr_number: 1343,
    pr_state: 'merged',
    ...overrides,
  } as Task;
}

function depsFor(task: Task, updateSpy = vi.fn()) {
  return {
    tasks: {
      getById: (id: string) => (id === task.id ? task : undefined),
      update: updateSpy,
    },
    projectPath: '/repo',
    onLinked: vi.fn(),
    force: true,
  } as unknown as Parameters<typeof linkPRForTask>[1];
}

beforeEach(() => {
  remotes.urls = ['git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE'];
});

describe('the remote gate never lets a degraded resolve clear a link', () => {
  it('keeps a pasted Azure PR link when the Azure CLI is missing', async () => {
    const updateSpy = vi.fn();
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task, updateSpy));

    expect(result.status).toBe('resolver-unavailable');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_url).toBe(LINKED_URL);
    expect(result.task?.pr_number).toBe(1343);
  });

  it('reports the real reason rather than gh wording', async () => {
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.message).toBeTruthy();
    // The connector that actually owns this remote is the one that spoke.
    expect(result.message).not.toMatch(/gh auth login/i);
  });

  it('keeps the link when NO connector owns the remote', async () => {
    remotes.urls = ['https://gitlab.com/group/project.git'];
    const updateSpy = vi.fn();
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task, updateSpy));

    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/No PR connector matches the remote/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('keeps the link when the remotes cannot be read at all', async () => {
    remotes.urls = null;
    const updateSpy = vi.fn();
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task, updateSpy));

    expect(result.status).toBe('resolver-unavailable');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('keeps the link for a repo with no remotes configured', async () => {
    remotes.urls = [];
    const updateSpy = vi.fn();
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task, updateSpy));

    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/No git remote is configured/);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
