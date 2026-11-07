/**
 * Startup recovery and an agent a quit left running on a host (#913), against a real database.
 *
 * A quit leaves a remote agent running, so at the next launch its session record is still `running`. The
 * recovery used to read every `running` record as a crash's leftover, orphan it and resume the
 * conversation, which beside an agent still on the host runs two in one worktree.
 *
 * What a user loses if it breaks: two agents editing one worktree at once, or an agent that kept working
 * overnight and is then abandoned as a crashed one.
 *
 * Real SQLite, because the question is which rows `getRunningRemote` and `markRunningAsOrphanedExcluding`
 * touch, and a mock that matches SQL text would only say a statement was issued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const holder = vi.hoisted(() => ({ database: null as unknown }));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => holder.database }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { serializeCliTarget } from '../../src/main/agent/shared/cli-target';
import { setRemoteLaunchResolver } from '../../src/main/remote/remote-launch';
import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
import { autoSpawnTasks } from '../../src/main/transition-engine/session-startup/auto-spawn';
import type { SessionRecord } from '../../src/shared/types';

let database: Database.Database;
let sessionRepo: SessionRepository;
let taskId: string;
let sessionType: string;

const SSH_TARGET = serializeCliTarget({
  kind: 'ssh',
  hostId: 'host-1',
  home: '/home/dev',
  shellName: 'zsh',
  roots: [{ local: '/shell', host: '/home/dev/api' }],
} as never);

function insertRecord(id: string, overrides: Partial<SessionRecord> & { cli_target?: string | null } = {}): void {
  sessionRepo.insert({
    id,
    task_id: taskId,
    session_type: sessionType,
    session_type_extra: undefined,
    isolated_swimlane_id: null,
    agent_session_id: `agent-${id}`,
    command: 'claude',
    cwd: '/shell',
    permission_mode: 'default',
    prompt: null,
    status: 'running',
    exit_code: null,
    started_at: '2026-11-07T10:00:00.000Z',
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
    launch_failed_at: null,
    ...overrides,
  } as never);
}

const statusOf = (id: string): string | undefined => sessionRepo.findByAnyId(id)?.status;

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    hasSessionForTask: vi.fn(() => false),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(async () => ({ id: 'spawned', status: 'running' })),
    adoptRemoteSession: vi.fn(async (input: { id: string }) => ({ id: input.id, status: 'running' })),
    getShell: vi.fn(async () => '/bin/sh'),
    findLiveSessionByTaskId: vi.fn((): { id: string } | undefined => undefined),
  };
}

const configManager = {
  load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: true } })),
  getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: {} } })),
} as never;

async function recover(sessionManager: ReturnType<typeof makeSessionManager>, snapshot?: (hostId: string) => Promise<{ sessions: Array<{ sessionId: string; alive: boolean }> }>): Promise<void> {
  await resumeSuspendedSessions(
    'proj-1', '/shell', sessionManager as never, configManager, null, null, null, null, [],
    snapshot ? { rejoinRemote: { snapshot: snapshot as never } } : {},
  );
}

beforeEach(() => {
  database = new Database(':memory:');
  runProjectMigrations(database);
  holder.database = database;
  sessionRepo = new SessionRepository(database);
  const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.auto_spawn && candidate.role === null)
    ?? new SwimlaneRepository(database).list().find((candidate) => candidate.auto_spawn)!;
  taskId = new TaskRepository(database).create({ title: 'Fix the build on the host', description: '', swimlane_id: lane.id }).id;
  sessionType = agentRegistry.get('claude')!.sessionType;
  setRemoteLaunchResolver({
    resolve: async () => ({
      place: { kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'zsh', localHome: '/mirror', roots: [{ local: '/shell', host: '/home/dev/api' }], linuxCliPath: 'claude' },
      remote: { hostId: 'host-1', cwd: '/home/dev/api', shellName: 'zsh' },
    }),
  } as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setRemoteLaunchResolver(null);
  database.close();
  vi.restoreAllMocks();
});

describe('a record that is running on a host at launch', () => {
  it('is taken back when the host still holds its agent, and is neither orphaned nor resumed', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();

    await recover(sessionManager, async () => ({ sessions: [{ sessionId: 'rec-1', alive: true }] }));

    expect(sessionManager.adoptRemoteSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rec-1',
      taskId,
      command: '',
      remote: { hostId: 'host-1', cwd: '/home/dev/api', shellName: 'zsh' },
    }));
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(statusOf('rec-1')).toBe('running');
  });

  it('is left running, and nothing starts for its task, when the host cannot be asked', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();

    await recover(sessionManager, async () => { throw new Error('the host is not connected'); });

    expect(sessionManager.adoptRemoteSession).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(statusOf('rec-1')).toBe('running');
  });

  it('is left running when the host holds the agent but taking it back failed', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();
    sessionManager.adoptRemoteSession.mockRejectedValue(new Error('the link dropped'));

    await recover(sessionManager, async () => ({ sessions: [{ sessionId: 'rec-1', alive: true }] }));

    expect(statusOf('rec-1')).toBe('running');
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('falls through to the ordinary crash recovery only when the host says the agent is gone', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();

    await recover(sessionManager, async () => ({ sessions: [{ sessionId: 'rec-1', alive: false }] }));

    expect(sessionManager.adoptRemoteSession).not.toHaveBeenCalled();
    expect(statusOf('rec-1')).not.toBe('running');
  });

  it('falls through when the host has no such terminal at all', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });

    await recover(makeSessionManager(), async () => ({ sessions: [] }));

    expect(statusOf('rec-1')).not.toBe('running');
  });
});

describe('a running record whose task no longer wants its agent', () => {
  const alive = async () => ({ sessions: [{ sessionId: 'rec-1', alive: true }] });

  it('is not taken back when the task was moved to Done while its host was out of reach', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const doneLane = new SwimlaneRepository(database).list().find((lane) => lane.role === 'done')!;
    new TaskRepository(database).update({ id: taskId, swimlane_id: doneLane.id });
    const sessionManager = makeSessionManager();

    await recover(sessionManager, alive);

    expect(sessionManager.adoptRemoteSession).not.toHaveBeenCalled();
    expect(statusOf('rec-1')).not.toBe('running');
  });

  it('is not taken back when the task was moved to To Do', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const todoLane = new SwimlaneRepository(database).list().find((lane) => lane.role === 'todo')!;
    new TaskRepository(database).update({ id: taskId, swimlane_id: todoLane.id });
    const sessionManager = makeSessionManager();

    await recover(sessionManager, alive);

    expect(sessionManager.adoptRemoteSession).not.toHaveBeenCalled();
    expect(statusOf('rec-1')).not.toBe('running');
  });

  it('is not taken back when the task was deleted', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();
    database.pragma('foreign_keys = OFF');
    new TaskRepository(database).delete(taskId);

    await recover(sessionManager, alive);

    expect(sessionManager.adoptRemoteSession).not.toHaveBeenCalled();
    expect(statusOf('rec-1')).not.toBe('running');
  });

  it('is taken back when the task is still in a column that runs agents', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();

    await recover(sessionManager, alive);

    expect(sessionManager.adoptRemoteSession).toHaveBeenCalledTimes(1);
  });
});

describe('a record that is running on this computer at launch', () => {
  it('is orphaned as before, and the host is never asked', async () => {
    insertRecord('rec-local', { cli_target: null });
    const snapshot = vi.fn(async () => ({ sessions: [] }));

    await recover(makeSessionManager(), snapshot);

    expect(statusOf('rec-local')).not.toBe('running');
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('is orphaned beside a remote one that is kept', async () => {
    insertRecord('rec-local', { cli_target: null });
    insertRecord('rec-remote', { cli_target: SSH_TARGET });

    await recover(makeSessionManager(), async () => ({ sessions: [{ sessionId: 'rec-remote', alive: true }] }));

    expect(statusOf('rec-remote')).toBe('running');
    expect(statusOf('rec-local')).not.toBe('running');
  });
});

describe('without a way to ask a host', () => {
  it('orphans a remote record like any other, as every launch did before an agent could be left running', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });

    await recover(makeSessionManager());

    expect(statusOf('rec-1')).not.toBe('running');
  });
});

describe('auto-spawn beside a record still running on a host', () => {
  it('starts no fresh agent for its task', async () => {
    insertRecord('rec-1', { cli_target: SSH_TARGET });
    const sessionManager = makeSessionManager();
    const startFirstAgent = vi.fn(async () => undefined);

    await autoSpawnTasks('proj-1', '/shell', sessionManager as never, configManager, null, null, null, null, [], { startFirstAgent } as never);

    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(startFirstAgent).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('its agent is still running on its host'));
  });
});
