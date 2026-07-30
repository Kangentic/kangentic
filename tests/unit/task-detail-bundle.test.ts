import { describe, it, expect, vi, beforeEach } from 'vitest';

// The bundle is the ONE cross-project read behind a task detail hosted outside
// its own board. Its contract is easy to get subtly wrong in a way no type
// catches: reading the ACTIVE project's config instead of the target's would
// typecheck perfectly and only misbehave when the two differ - which is never
// true on the board, and always true in the Agent Monitor. These tests pin that
// every value is resolved for the REQUESTED project.

const getProjectReposMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: getProjectReposMock,
}));

import { buildTaskDetailBundle } from '../../src/main/monitor/task-detail-bundle';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task, Swimlane } from '../../src/shared/types';

const TARGET_PROJECT = { id: 'proj-target', name: 'Target', path: '/mock/target', default_agent: 'codex' };
const OPEN_PROJECT_PATH = '/mock/currently-open';

const TASK = { id: 'task-1', title: 'Fix the thing' } as Task;
const SWIMLANES = [{ id: 'lane-1', name: 'Doing' }] as Swimlane[];

/**
 * A context whose config managers answer DIFFERENTLY for the target project than
 * for the open one, so a read against the wrong path is visible in the result
 * rather than silently identical.
 */
function makeContext(): IpcContext {
  return {
    projectRepo: {
      getById: (id: string) => (id === TARGET_PROJECT.id ? TARGET_PROJECT : null),
    },
    configManager: {
      getEffectiveConfig: (projectPath: string) => ({
        backlog: { labelColors: projectPath === TARGET_PROJECT.path ? { bug: '#f00' } : { wrong: '#000' } },
        git: {
          defaultBaseBranch: projectPath === TARGET_PROJECT.path ? 'develop' : 'wrong-branch',
          worktreesEnabled: projectPath === TARGET_PROJECT.path,
        },
        browser: { enabled: false },
      }),
    },
    boardConfigManager: {
      // The active-project reads. If the bundle called either of these it would
      // return the OPEN project's values, which is the bug being guarded.
      getShortcuts: () => [{ id: 'wrong', command: 'echo open', source: 'team' }],
      getDefaultBaseBranch: () => 'wrong-branch',
      getShortcutsForPath: (projectPath: string) =>
        (projectPath === TARGET_PROJECT.path
          ? [{ id: 'right', command: 'echo target', source: 'team' }]
          : []),
      getDefaultBaseBranchForPath: (projectPath: string) =>
        (projectPath === TARGET_PROJECT.path ? 'team-branch' : 'wrong-branch'),
    },
    currentProjectPath: OPEN_PROJECT_PATH,
  } as unknown as IpcContext;
}

describe('buildTaskDetailBundle', () => {
  beforeEach(() => {
    getProjectReposMock.mockReset();
    getProjectReposMock.mockImplementation((_context: unknown, projectId: string) => ({
      tasks: { getById: (id: string) => (projectId === TARGET_PROJECT.id && id === TASK.id ? TASK : null) },
      swimlanes: { list: () => SWIMLANES },
    }));
  });

  it('resolves every value against the REQUESTED project, not the open one', () => {
    const bundle = buildTaskDetailBundle(makeContext(), TARGET_PROJECT.id, TASK.id);

    expect(bundle).not.toBeNull();
    expect(bundle!.projectId).toBe(TARGET_PROJECT.id);
    expect(bundle!.projectPath).toBe(TARGET_PROJECT.path);
    expect(bundle!.defaultAgent).toBe('codex');
    expect(bundle!.task).toBe(TASK);
    expect(bundle!.swimlanes).toEqual(SWIMLANES);
    expect(bundle!.shortcuts).toEqual([{ id: 'right', command: 'echo target', source: 'team' }]);
    expect(bundle!.config.labelColors).toEqual({ bug: '#f00' });
    expect(bundle!.config.worktreesEnabled).toBe(true);
  });

  it('overlays the team-shared base branch over the effective config, like CONFIG_GET does', () => {
    // kangentic.json's defaultBaseBranch is team-shared and wins over the config
    // file's value. Same precedence the CONFIG_GET handler applies for the board.
    const bundle = buildTaskDetailBundle(makeContext(), TARGET_PROJECT.id, TASK.id);
    expect(bundle!.config.defaultBaseBranch).toBe('team-branch');
  });

  it('falls back to the config value when the board config declares no base branch', () => {
    const context = makeContext();
    (context.boardConfigManager as unknown as {
      getDefaultBaseBranchForPath: () => string | undefined;
    }).getDefaultBaseBranchForPath = () => undefined;

    const bundle = buildTaskDetailBundle(context, TARGET_PROJECT.id, TASK.id);
    expect(bundle!.config.defaultBaseBranch).toBe('develop');
  });

  it('treats an explicitly disabled browser as disabled', () => {
    const bundle = buildTaskDetailBundle(makeContext(), TARGET_PROJECT.id, TASK.id);
    expect(bundle!.config.browserEnabled).toBe(false);
  });

  it('returns null for an unknown project or task rather than a half-built bundle', () => {
    // The caller closes the window on null; a husk with an undefined task would
    // crash the surface instead.
    expect(buildTaskDetailBundle(makeContext(), 'no-such-project', TASK.id)).toBeNull();
    expect(buildTaskDetailBundle(makeContext(), TARGET_PROJECT.id, 'no-such-task')).toBeNull();
  });
});
