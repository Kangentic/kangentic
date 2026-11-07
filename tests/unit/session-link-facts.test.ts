/**
 * sessionLinkFacts and the SESSION_RESOLVE_LINK_PATHS / SESSION_REVEAL_LINK_PATH
 * handlers in src/main/ipc/handlers/sessions.ts.
 *
 * These run the real handler bodies and the real resolveExecutionTarget. Only
 * the file-system service the facts feed (presentLinkPaths, revealLinkPath) is
 * replaced, so each test reads the facts it was handed. What a user loses if
 * this goes: a session whose agent runs on a remote server would link paths of
 * THIS machine, and a hover on a path in another project's session would read
 * the ambient project's settings.
 *
 * Mock strategy mirrors task-resolve-pr-no-project.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  linkPRForTask: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

vi.mock('../../src/main/terminal-links/link-path-service', () => ({
  presentLinkPaths: vi.fn(async (printedPaths: string[]) => printedPaths.map(() => true)),
  revealLinkPath: vi.fn(async () => true),
}));

import { ipcMain } from 'electron';
import { registerSessionHandlers, sessionLinkFacts } from '../../src/main/ipc/handlers/sessions';
import { presentLinkPaths, revealLinkPath } from '../../src/main/terminal-links/link-path-service';
import { IPC } from '../../src/shared/ipc-channels';
import type { StoredCliTarget } from '../../src/shared/types';

const SESSION_PROJECT_ID = 'proj-session';
const AMBIENT_PROJECT_ID = 'proj-ambient';
const SESSION_PROJECT_PATH = 'C:\\Users\\dev\\session-project';

interface ContextOptions {
  agentName?: string | null;
  session?: { shell: string; commandCwd: string; cliTarget: StoredCliTarget | null; projectId: string } | null;
  getEffectiveConfig?: (projectPath?: string) => unknown;
}

function remoteConfig() {
  return {
    agent: {
      executionServers: { claude: { url: 'https://agent-host.example' } },
      execution: { claude: { mode: 'remote' } },
    },
  };
}

function localConfig() {
  return { agent: { executionServers: {}, execution: { claude: { mode: 'local' } } } };
}

function createMockContext(options: ContextOptions = {}) {
  const session = options.session === undefined
    ? { shell: 'bash', commandCwd: '/home/dev/project', cliTarget: null, projectId: SESSION_PROJECT_ID }
    : options.session;
  return {
    currentProjectId: AMBIENT_PROJECT_ID,
    currentProjectPath: 'C:\\Users\\dev\\ambient-project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      getSessionPathContext: vi.fn(() => session),
      getSessionAgentName: vi.fn(() => (options.agentName === undefined ? 'claude' : options.agentName)),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn(),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(options.getEffectiveConfig ?? (() => localConfig())),
    },
    projectRepo: {
      getById: vi.fn((projectId: string) => (projectId === SESSION_PROJECT_ID ? { id: projectId, path: SESSION_PROJECT_PATH } : null)),
    },
    boardEvents: { emitBoardChanged: vi.fn() },
  };
}

function findHandler(channel: string): (...args: unknown[]) => unknown {
  const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
  const registration = handleMock.mock.calls.find((call) => call[0] === channel);
  if (!registration) throw new Error(`No ipcMain.handle registration found for channel "${channel}"`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('sessionLinkFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for a session the manager does not know', () => {
    const context = createMockContext({ session: null });
    expect(sessionLinkFacts(context as never, 'no-such-session')).toBeNull();
    expect(context.configManager.getEffectiveConfig).not.toHaveBeenCalled();
  });

  it('carries the session\'s shell, command folder and CLI target through', () => {
    const cliTarget: StoredCliTarget = { kind: 'wsl', distro: 'Ubuntu' };
    const context = createMockContext({
      session: { shell: 'wsl', commandCwd: '/home/dev/project', cliTarget, projectId: SESSION_PROJECT_ID },
    });
    expect(sessionLinkFacts(context as never, 'session-1')).toEqual({
      shell: 'wsl',
      commandCwd: '/home/dev/project',
      cliTarget,
      runsOnRemoteServer: false,
    });
  });

  it('is not remote for a local agent', () => {
    const context = createMockContext({ getEffectiveConfig: () => localConfig() });
    expect(sessionLinkFacts(context as never, 'session-1')?.runsOnRemoteServer).toBe(false);
  });

  it('is remote when the agent resolves to an execution server', () => {
    const context = createMockContext({ getEffectiveConfig: () => remoteConfig() });
    expect(sessionLinkFacts(context as never, 'session-1')?.runsOnRemoteServer).toBe(true);
  });

  it('fails closed to remote when the config cannot be read', () => {
    const context = createMockContext({
      getEffectiveConfig: () => { throw new Error('config unreadable'); },
    });
    expect(sessionLinkFacts(context as never, 'session-1')?.runsOnRemoteServer).toBe(true);
  });

  it('fails closed to remote when remote mode names no server, which resolveExecutionTarget refuses', () => {
    const context = createMockContext({
      getEffectiveConfig: () => ({ agent: { executionServers: {}, execution: { claude: { mode: 'remote' } } } }),
    });
    expect(sessionLinkFacts(context as never, 'session-1')?.runsOnRemoteServer).toBe(true);
  });

  it('is not remote, and reads no config, for a session with no agent name', () => {
    const context = createMockContext({ agentName: null, getEffectiveConfig: () => remoteConfig() });
    expect(sessionLinkFacts(context as never, 'session-1')?.runsOnRemoteServer).toBe(false);
    expect(context.configManager.getEffectiveConfig).not.toHaveBeenCalled();
  });

  it('reads the session\'s own project, never the ambient current one', () => {
    const context = createMockContext();
    sessionLinkFacts(context as never, 'session-1');
    expect(context.projectRepo.getById).toHaveBeenCalledTimes(1);
    expect(context.projectRepo.getById).toHaveBeenCalledWith(SESSION_PROJECT_ID);
    expect(context.configManager.getEffectiveConfig).toHaveBeenCalledWith(SESSION_PROJECT_PATH);
  });
});

describe('SESSION_RESOLVE_LINK_PATHS and SESSION_REVEAL_LINK_PATH', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers false for every printed path of an unknown session, without asking the file system', async () => {
    registerSessionHandlers(createMockContext({ session: null }) as never);
    const handler = findHandler(IPC.SESSION_RESOLVE_LINK_PATHS);
    expect(await handler(null, 'no-such-session', ['a.ts', 'b.ts', 'c.ts'])).toEqual([false, false, false]);
    expect(presentLinkPaths).not.toHaveBeenCalled();
  });

  it('answers false to a reveal for an unknown session, without asking the file system', async () => {
    registerSessionHandlers(createMockContext({ session: null }) as never);
    const handler = findHandler(IPC.SESSION_REVEAL_LINK_PATH);
    expect(await handler(null, 'no-such-session', 'a.ts')).toBe(false);
    expect(revealLinkPath).not.toHaveBeenCalled();
  });

  it('hands the session\'s facts to the resolver for a known session', async () => {
    registerSessionHandlers(createMockContext({ getEffectiveConfig: () => remoteConfig() }) as never);
    const expectedFacts = {
      shell: 'bash',
      commandCwd: '/home/dev/project',
      cliTarget: null,
      runsOnRemoteServer: true,
    };

    expect(await findHandler(IPC.SESSION_RESOLVE_LINK_PATHS)(null, 'session-1', ['a.ts'])).toEqual([true]);
    expect(presentLinkPaths).toHaveBeenCalledWith(['a.ts'], expectedFacts);

    expect(await findHandler(IPC.SESSION_REVEAL_LINK_PATH)(null, 'session-1', 'a.ts')).toBe(true);
    expect(revealLinkPath).toHaveBeenCalledWith('a.ts', expectedFacts);
  });
});
