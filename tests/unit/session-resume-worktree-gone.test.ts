/**
 * Sentry DESKTOP-2P: a Resume that could never start. The task's recorded
 * worktree folder was gone, and with worktrees switched off `ensureTaskWorktree`
 * made none and returned with the stale path still on the row. The spawn took
 * that path as the agent's folder and refused it (`AgentCwdMissingError`,
 * `worktree-missing`) on every Resume, while the card said Resume would make the
 * worktree again. Startup already turns such a task into a no-worktree task
 * (`demoteMissingWorktree`); a runtime start now does the same.
 *
 * Runs the REAL resumeTaskSession, its task lock, the REAL ensureTaskWorktree
 * and WorktreeManager on a real git repository, and a real TaskRepository. The
 * engine and `spawnAgent` stand in. They pick the folder as the engine does
 * (`agentCwdFor`) and refuse a gone one through the check every agent spawn
 * passes (`assertAgentCwdExists`).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '../../src/shared/types';

const PROJECT_ID = 'proj-1';
const PAUSED_AT = '2026-10-28T13:00:37.505Z';
const ENTERED_AFTER_PAUSE = '2026-10-28T13:05:50.486Z';
const BRANCH = 'fix-acme-billing-export';

const harness = vi.hoisted(() => ({
  tasks: null as unknown as import('../../src/main/db/repositories/task-repository').TaskRepository,
  projectPath: '',
  laneId: '',
  entry: null as { at: string; origin: string; from_swimlane_id: string | null } | null,
  startedIn: [] as string[],
  refusals: [] as Error[],
}));

/** The spawn's own folder rule, then the session the start would make. */
const startAgentFor = vi.hoisted(() => async (taskId: string): Promise<void> => {
  const { agentCwdFor } = await import('../../src/main/transition-engine/agent-cwd');
  const { assertAgentCwdExists } = await import('../../src/main/pty/spawn/agent-start-refused');
  const row = harness.tasks.getById(taskId)!;
  const cwd = agentCwdFor(row, harness.projectPath);
  assertAgentCwdExists(cwd);
  harness.startedIn.push(cwd);
  harness.tasks.update({ id: taskId, session_id: 'sess-resumed' });
});

const engine = {
  resumeSuspendedSession: vi.fn(async (task: Task): Promise<void> => startAgentFor(task.id)),
};
// The real spawnAgent reports a refusal and returns without a session.
const mockSpawnAgent = vi.fn(async (input: { task: Task }): Promise<void> => {
  try {
    await startAgentFor(input.task.id);
  } catch (error) {
    harness.refusals.push(error as Error);
  }
});

const lane = () => ({ id: harness.laneId, name: 'Code Review', role: null, permission_mode: null, auto_spawn: true, is_ghost: false });

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask() { return { status: 'suspended', suspended_at: PAUSED_AT }; }
    listForTaskNewestFirst() { return []; }
  },
}));
vi.mock('../../src/main/db/repositories/task-move-repository', () => ({
  TaskMoveRepository: class {
    currentVisit() { return harness.entry; }
  },
}));
vi.mock('../../src/main/ipc/helpers', async () => {
  const taskGit = await vi.importActual<typeof import('../../src/main/ipc/helpers/task-git')>('../../src/main/ipc/helpers/task-git');
  return {
    getProjectRepos: () => ({
      tasks: harness.tasks,
      swimlanes: { getById: () => lane(), list: () => [lane()] },
      automations: {},
      automationRuns: {},
      attachments: {},
    }),
    ensureTaskWorktree: taskGit.ensureTaskWorktree,
    createTransitionEngine: () => engine,
    resolveSpawnOverrides: () => ({ forceFresh: false }),
    spawnAgent: (input: { task: Task }) => mockSpawnAgent(input),
  };
});
vi.mock('../../src/main/ipc/helpers/project-repos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/helpers/project-repos')>()),
  resolveProjectContext: (_context: unknown, projectId: string | null | undefined) => ({ projectId: projectId ?? null, projectPath: harness.projectPath }),
}));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: (_context: unknown, _projectId: string, taskId: string) => {
    const task = harness.tasks.getById(taskId)!;
    return task.session_id === 'sess-resumed'
      ? { task, liveSession: { id: 'sess-resumed', taskId, status: 'running' } }
      : { task, liveSession: null };
  },
}));
vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: (laneRow: unknown) => laneRow,
}));
vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: () => null,
}));

import { resumeTaskSession } from '../../src/main/ipc/handlers/session-resume';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { DEFAULT_CONFIG, type AppConfig, type Session } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

vi.setConfig({ testTimeout: 60_000 });

let workspace: string;
let branchTip: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

beforeAll(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-resume-gone-')));
  harness.projectPath = path.join(workspace, 'project');
  fs.mkdirSync(harness.projectPath);
  run(harness.projectPath, ['init', '-b', 'main']);
  run(harness.projectPath, ['config', 'user.email', 'dev@example.com']);
  run(harness.projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(harness.projectPath, '.gitignore'), '.kangentic/\n');
  run(harness.projectPath, ['add', '-A']);
  run(harness.projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  // The branch outlives the folder, as it does when a worktree is deleted by hand.
  run(harness.projectPath, ['branch', BRANCH]);
  branchTip = run(harness.projectPath, ['rev-parse', BRANCH]).trim();
});

afterAll(async () => {
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const worktreesOff: AppConfig = { ...DEFAULT_CONFIG, git: { ...DEFAULT_CONFIG.git, worktreesEnabled: false } };

function fakeContext(): IpcContext {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: harness.projectPath,
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    configManager: { getEffectiveConfig: () => worktreesOff },
    boardConfigManager: { getDefaultBaseBranchForPath: () => undefined },
    projectRepo: {
      getById: () => ({ id: PROJECT_ID, path: harness.projectPath }),
      list: () => [],
    },
    sessionManager: {
      getSession: (id: string) => (id === 'sess-resumed' ? ({ id, status: 'running' } as Session) : undefined),
      findLiveSessionByTaskId: () => undefined,
      listSessions: () => [],
    },
  } as unknown as IpcContext;
}

describe('a Resume of a task whose recorded worktree folder is gone, with worktrees switched off', () => {
  let database: ReturnType<typeof openTestDatabase>;
  let taskId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    harness.tasks = new TaskRepository(database);
    harness.laneId = new SwimlaneRepository(database).list().filter((row) => row.role === null)[0].id;
    harness.startedIn = [];
    harness.refusals = [];
    engine.resumeSuspendedSession.mockClear();
    mockSpawnAgent.mockClear();

    const created = harness.tasks.create({ title: 'Fix Acme billing export', description: '', swimlane_id: harness.laneId });
    taskId = created.id;
    const gonePath = path.join(harness.projectPath, '.kangentic', 'worktrees', String(created.display_id));
    harness.tasks.update({ id: taskId, worktree_path: gonePath, branch_name: BRANCH });
    expect(fs.existsSync(gonePath)).toBe(false);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  function expectDemoted(): void {
    const row = harness.tasks.getById(taskId)!;
    expect(row.worktree_path).toBeNull();
    expect(row.branch_name).toBeNull();
    expect(row.worktree_skip_reason).toBe('worktree-missing');
    // The work is not lost with the folder: its commit is kept for the PR link.
    expect(row.head_sha).toBe(branchTip);
  }

  it('starts the column\'s agent in the project folder after an entry while paused (the DESKTOP-2P path)', async () => {
    harness.entry = { at: ENTERED_AFTER_PAUSE, origin: 'user', from_swimlane_id: null };

    const session = await resumeTaskSession(fakeContext(), taskId, { projectId: PROJECT_ID });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(harness.refusals).toEqual([]);
    expect(harness.startedIn).toEqual([harness.projectPath]);
    expect(session?.id).toBe('sess-resumed');
    expectDemoted();
  });

  it('resumes the paused conversation in the project folder when the task has not changed column', async () => {
    harness.entry = null;

    const session = await resumeTaskSession(fakeContext(), taskId, { projectId: PROJECT_ID });

    expect(engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(harness.startedIn).toEqual([harness.projectPath]);
    expect(session?.id).toBe('sess-resumed');
    expectDemoted();
  });
});
