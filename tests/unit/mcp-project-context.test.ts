import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test (`mcp-project-context.ts`) pulls in several
// Electron/Node-native dependencies through its own imports:
//   - getProjectDb   -> better-sqlite3 native module
//   - autoSpawnForTask -> Electron ipcMain, PTY session manager
//   - handleTaskMove  -> Electron ipcMain, DB handlers
//   - WorktreeManager -> simple-git, fs.access
//   - RequestResolver -> project-resolver (would re-import mcp-project-context)
//
// We stub each of these so the unit scope stays pure (no Electron process,
// no native SQLite). The stubs are intentionally minimal - just enough for
// the module-level imports to resolve without crashing.

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  autoSpawnForTask: vi.fn(() => Promise.resolve()),
  // The MCP delete path reaps what the session left running before it removes
  // the worktree. Inert here: the ordering is pinned in the reap wiring tests.
  reapTaskLeftovers: vi.fn(() => Promise.resolve()),
}));

// The MCP delete closes the task's pop-outs and offscreen lane once its
// sessions are gone. The pop-out manager and the lane manager import Electron,
// which this file does not mock, so the helper is stubbed at its module.
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({
  closeTaskWindows: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  handleTaskMove: vi.fn(() => Promise.resolve()),
}));

// A move that carries a message re-reads where the task landed, and names the
// column it landed in, before it hands the message to the delivery. Only
// `onTaskMove` uses either module in this file, so each is a stub the move tests
// below configure: the landed column the task reads back, and the delivery spy.
const landedTaskState = vi.hoisted(() => ({ swimlaneId: 'lane-review' as string | null, columnName: 'Code Review' as string | null }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: vi.fn(() => (landedTaskState.swimlaneId ? { swimlane_id: landedTaskState.swimlaneId } : undefined)) },
    swimlanes: { getById: vi.fn(() => (landedTaskState.columnName ? { name: landedTaskState.columnName } : undefined)) },
  })),
}));
const deliverMessageAfterMoveSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageAfterMove: deliverMessageAfterMoveSpy,
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  prepareWorktreeForRemoval: vi.fn(() => Promise.resolve()),
  WorktreeManager: vi.fn().mockImplementation(() => ({
    withLock: vi.fn(() => Promise.resolve()),
    removeWorktree: vi.fn(() => Promise.resolve(false)),
    pruneWorktrees: vi.fn(() => Promise.resolve()),
    removeBranch: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../../src/shared/ipc-channels', () => ({
  IPC: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

// sendToRenderer (invoked when a callback fires) mirrors into the IPC traffic
// recorder; stub it so invoking a callback stays a pure unit test. Hoisted as a
// NAMED spy rather than an inline `vi.fn()` so tests can assert the push
// actually reached the recorder: that is the only thing distinguishing a call
// routed through `sendToRenderer` from a raw `webContents.send`, which is
// precisely the bug class `src/main/ipc/send-to-renderer.ts` was extracted to
// close. Its sibling call site in pr-linking.ts already has this revert-proof
// (pr-link-ladder.test.ts); without it here, coverage of the shared helper's
// two callers is asymmetric.
const recordPushSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/diagnostics/ipc-recorder', () => ({
  recordPush: recordPushSpy,
}));

// strategy-propagation.ts pulls in a large transitive chain (SessionRepository,
// agent-registry, injection-plan, column-strategy, session-reconcile,
// auto-spawn-reconcile, ipc/task-lifecycle-lock) that this file has no reason
// to load for real - the onSwimlaneUpdated gate below only needs to prove
// mcp-project-context.ts calls these three with the right arguments, not that
// they do the right thing internally (that is strategy-propagation.test.ts's
// and auto-spawn-reconcile.test.ts's job).
vi.mock('../../src/main/ipc/handlers/strategy-propagation', () => ({
  propagateBoardProfileChange: vi.fn(),
  propagateStrategyToLiveSessions: vi.fn(),
  buildColumnStrategyChanges: vi.fn(() => []),
}));

// The apply step is tested where it lives (task-runtime-override-handler.test.ts);
// here only the host's wiring around it is: the lock, the fields, the resync.
const applySettingsSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/handlers/task-runtime-override', () => ({
  applyTaskSettingsToLiveSession: applySettingsSpy,
}));
const withTaskLockSpy = vi.hoisted(() => vi.fn((_taskId: string, work: () => Promise<unknown>) => work()));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: withTaskLockSpy,
}));

// The task reads' Knowledge Graph lookup is tested where it lives
// (task-knowledge-store.test.ts, against a real database). Here only the
// context's gate around it is: the index switch, the summaries switch, and a
// read that fails.
// The read itself runs in the retrieval worker ('task.knowledge').
const workerCallSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: workerCallSpy },
}));

// The completed task view's two reads are tested where they live
// (task-report.test.ts, git-task-changes-handler.test.ts). Here only the
// context's wiring around them is: which project and arguments it forwards.
// Both modules keep their other exports, since sessions.ts and the IPC
// registration also import from them.
const readTaskReportSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/helpers/task-report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/helpers/task-report')>()),
  readTaskReport: readTaskReportSpy,
}));
const readTaskChangesSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/handlers/git-diff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/handlers/git-diff')>()),
  readTaskChanges: readTaskChangesSpy,
}));

// RequestResolver is imported by mcp-project-context and called with `new`.
// Track constructor calls via a hoisted spy variable that the test body can
// inspect after each call.
const resolverConstructorCalls: Array<Record<string, unknown>> = [];

vi.mock('../../src/main/agent/mcp-http/project-resolver', () => {
  function RequestResolver(params: Record<string, unknown>) {
    resolverConstructorCalls.push(params);
    Object.assign(this as object, { _params: params });
  }
  return { RequestResolver };
});

import { createRequestResolver, buildCommandContextForProject } from '../../src/main/agent/mcp-project-context';
import {
  propagateStrategyToLiveSessions,
  buildColumnStrategyChanges,
} from '../../src/main/ipc/handlers/strategy-propagation';
import { reapTaskLeftovers } from '../../src/main/ipc/helpers';
import { closeTaskWindows } from '../../src/main/ipc/helpers/task-windows';
import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { WorktreeManager, prepareWorktreeForRemoval } from '../../src/main/git/worktree-manager';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { GitTaskChangesResult, Project, Swimlane, TaskReport } from '../../src/shared/types';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Example Project',
    path: '/projects/example',
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeIpcContext(projectResult: Project | null): IpcContext {
  return {
    projectRepo: {
      getById: vi.fn(() => projectResult),
      list: vi.fn(() => (projectResult ? [projectResult] : [])),
    },
    boardEvents: { emitBoardChanged: vi.fn() },
  } as unknown as IpcContext;
}

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111';

describe('createRequestResolver', () => {
  beforeEach(() => {
    resolverConstructorCalls.length = 0;
    vi.clearAllMocks();
  });

  it('returns null when projectRepo.getById returns null (unknown project ID)', () => {
    const ipcContext = makeIpcContext(null);
    const result = createRequestResolver(ipcContext, DEFAULT_ID);
    expect(result).toBeNull();
    // RequestResolver constructor must NOT be called - nothing to bind a
    // context to when the project row doesn't exist.
    expect(resolverConstructorCalls).toHaveLength(0);
  });

  it('returns null when buildCommandContextForProject returns null (project vanished after getById)', () => {
    // createRequestResolver does its own getById check first, then calls
    // buildCommandContextForProject which does a second getById internally.
    // When that second call returns null, buildCommandContextForProject returns
    // null, so createRequestResolver must also return null.
    const project = makeProject({ id: DEFAULT_ID, name: 'Board A' });
    const getById = vi.fn()
      .mockReturnValueOnce(project)  // outer check in createRequestResolver
      .mockReturnValueOnce(null);    // inner check inside buildCommandContextForProject
    const ipcContext = { projectRepo: { getById, list: vi.fn(() => [project]) } } as unknown as IpcContext;

    const result = createRequestResolver(ipcContext, DEFAULT_ID);

    expect(result).toBeNull();
    expect(resolverConstructorCalls).toHaveLength(0);
  });

  it('constructs a RequestResolver when the project exists and context builds successfully', () => {
    const project = makeProject({ id: DEFAULT_ID, name: 'My Board' });
    const ipcContext = makeIpcContext(project);

    const result = createRequestResolver(ipcContext, DEFAULT_ID);

    expect(result).not.toBeNull();
    expect(resolverConstructorCalls).toHaveLength(1);
    const constructorArg = resolverConstructorCalls[0];
    expect(constructorArg.defaultProjectId).toBe(DEFAULT_ID);
    expect(constructorArg.defaultProjectName).toBe('My Board');
    expect(constructorArg.ipcContext).toBe(ipcContext);
    // defaultContext must be the CommandContext returned by
    // buildCommandContextForProject - verify its shape.
    const defaultContext = constructorArg.defaultContext as Record<string, unknown>;
    expect(typeof defaultContext.getProjectPath).toBe('function');
  });

  it('passes the project name from the DB row into the resolver (not a hardcoded value)', () => {
    const project = makeProject({ id: DEFAULT_ID, name: 'Custom Board Name' });
    const ipcContext = makeIpcContext(project);

    createRequestResolver(ipcContext, DEFAULT_ID);

    expect(resolverConstructorCalls[0].defaultProjectName).toBe('Custom Board Name');
  });

  it('passes the ipcContext reference unchanged into the resolver', () => {
    const project = makeProject({ id: DEFAULT_ID });
    const ipcContext = makeIpcContext(project);

    createRequestResolver(ipcContext, DEFAULT_ID);

    expect(resolverConstructorCalls[0].ipcContext).toBe(ipcContext);
  });
});

describe('buildCommandContextForProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when projectRepo.getById returns null', () => {
    const ipcContext = makeIpcContext(null);
    const result = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(result).toBeNull();
  });

  it('returns a CommandContext with getProjectPath returning the project path', () => {
    const project = makeProject({ id: DEFAULT_ID, path: '/repos/myboard' });
    const ipcContext = makeIpcContext(project);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();
    expect(context!.getProjectPath()).toBe('/repos/myboard');
  });

  it('returned CommandContext exposes all required lifecycle callbacks', () => {
    const project = makeProject({ id: DEFAULT_ID });
    const ipcContext = makeIpcContext(project);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();
    expect(typeof context!.onTaskCreated).toBe('function');
    expect(typeof context!.onTaskUpdated).toBe('function');
    expect(typeof context!.onTaskDeleted).toBe('function');
    expect(typeof context!.onTaskMove).toBe('function');
    expect(typeof context!.onSwimlaneUpdated).toBe('function');
    expect(typeof context!.onBacklogChanged).toBe('function');
    expect(typeof context!.onLabelColorsChanged).toBe('function');
  });

  // #929. The move tool refuses a stale "next" from the column the agent's turn
  // began in; without this wiring the refusal is dead in production while every
  // handler test, which injects the accessor, stays green.
  it('answers when a session\'s turn began from the session manager\'s work-turn stamp', () => {
    const workTurnStartedAt = vi.fn((sessionId: string) => (sessionId === 'session-own' ? 1_700_000_000_000 : null));
    const ipcContext = Object.assign(makeIpcContext(makeProject({ id: DEFAULT_ID })), { sessionManager: { workTurnStartedAt } });

    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);

    expect(context!.getSessionTurnStartedAt?.('session-own')).toBe(1_700_000_000_000);
    expect(context!.getSessionTurnStartedAt?.('session-other')).toBeNull();
    expect(workTurnStartedAt).toHaveBeenCalledWith('session-own');
  });
});

// The move tool names the task's own agent and its live session; a move that
// ends that session waits for its turn (#916). Both reach `handleTaskMove`.
describe('buildCommandContextForProject - onTaskMove', () => {
  const MOVE_INPUT = { taskId: 'task-1', targetSwimlaneId: 'lane-review', targetPosition: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the task\'s own agent and its session to the move', async () => {
    const context = buildCommandContextForProject(makeIpcContext(makeProject({ id: DEFAULT_ID, path: '/repos/myboard' })), DEFAULT_ID);

    await context!.onTaskMove(MOVE_INPUT, { moverIsTaskAgent: true, moverSessionId: 'session-own' });

    expect(handleTaskMove).toHaveBeenCalledWith(
      expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard',
      { moverIsTaskAgent: true, moverSessionId: 'session-own' },
    );
  });

  it('passes no options for a move by anyone else', async () => {
    const context = buildCommandContextForProject(makeIpcContext(makeProject({ id: DEFAULT_ID, path: '/repos/myboard' })), DEFAULT_ID);

    await context!.onTaskMove(MOVE_INPUT);

    expect(handleTaskMove).toHaveBeenCalledWith(expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard', undefined);
  });

  // A message that follows the move reaches the agent after it lands, so the
  // move says so (`carriesMessage`) and its return recap leaves out the reply
  // that message usually repeats. Only a message with text counts: an empty or
  // blank one delivers nothing, and a recap that left the reply out for it would
  // hand the agent neither.
  //
  // Red-green: pass `carriesMessage: true` for any `options.message` (or drop it)
  // in mcp-project-context.ts's `onTaskMove` and the matching test fails.
  describe('a move that carries a message', () => {
    beforeEach(() => {
      landedTaskState.swimlaneId = MOVE_INPUT.targetSwimlaneId;
      landedTaskState.columnName = 'Code Review';
    });

    function contextForMove() {
      return buildCommandContextForProject(makeIpcContext(makeProject({ id: DEFAULT_ID, path: '/repos/myboard' })), DEFAULT_ID)!;
    }

    it('tells the move it carries a message, and delivers the trimmed text once the task landed', async () => {
      await contextForMove().onTaskMove(MOVE_INPUT, { message: '  Address the findings.  ' });

      expect(handleTaskMove).toHaveBeenCalledWith(
        expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard',
        { carriesMessage: true },
      );
      expect(deliverMessageAfterMoveSpy).toHaveBeenCalledWith(
        expect.anything(), DEFAULT_ID, MOVE_INPUT.taskId, 'Code Review', 'Address the findings.',
      );
    });

    it('adds the flag beside the task agent\'s own options', async () => {
      await contextForMove().onTaskMove(MOVE_INPUT, {
        message: 'Address the findings.',
        moverIsTaskAgent: true,
        moverSessionId: 'session-own',
      });

      expect(handleTaskMove).toHaveBeenCalledWith(
        expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard',
        { moverIsTaskAgent: true, moverSessionId: 'session-own', carriesMessage: true },
      );
    });

    it.each([
      { label: 'an empty message', message: '' },
      { label: 'a blank message', message: '   \n  ' },
    ])('does not tell the move it carries one for $label, and delivers nothing', async ({ message }) => {
      await contextForMove().onTaskMove(MOVE_INPUT, { message });

      expect(handleTaskMove).toHaveBeenCalledWith(
        expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard', undefined,
      );
      expect(deliverMessageAfterMoveSpy).not.toHaveBeenCalled();
    });

    it('does not tell the move it carries one when the caller passes no message', async () => {
      await contextForMove().onTaskMove(MOVE_INPUT, { moverIsTaskAgent: true });

      expect(handleTaskMove).toHaveBeenCalledWith(
        expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard',
        { moverIsTaskAgent: true },
      );
    });

    it('delivers nothing when the move did not land the task in its target column', async () => {
      landedTaskState.swimlaneId = 'lane-elsewhere';

      await contextForMove().onTaskMove(MOVE_INPUT, { message: 'Address the findings.' });

      // The move still told its recap about the message it was asked to carry.
      expect(handleTaskMove).toHaveBeenCalledWith(
        expect.anything(), MOVE_INPUT, 'agent', DEFAULT_ID, '/repos/myboard',
        { carriesMessage: true },
      );
      expect(deliverMessageAfterMoveSpy).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// getDefaultBaseBranch
//
// Board default first, `||` fallback to the effective config's
// `git.defaultBaseBranch`, wrapped so an unreadable config never fails the
// tool call it feeds. The empty-string case is the one that proves the `||`:
// an empty board default must fall through, which a `??` would not do.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - getDefaultBaseBranch', () => {
  const PROJECT_PATH = '/projects/example';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeBaseBranchContext(options: {
    boardDefault?: string;
    boardThrows?: boolean;
    configDefault?: string;
  }) {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const getDefaultBaseBranchForPath = vi.fn(() => {
      if (options.boardThrows) throw new Error('board config unreadable');
      return options.boardDefault;
    });
    const getEffectiveConfig = vi.fn(() => ({
      git: { defaultBaseBranch: options.configDefault },
    }));
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      boardConfigManager: { getDefaultBaseBranchForPath },
      configManager: { getEffectiveConfig },
    } as unknown as IpcContext;
    return { ipcContext, getDefaultBaseBranchForPath, getEffectiveConfig };
  }

  it('prefers the board default over a different effective-config value', () => {
    const { ipcContext } = makeBaseBranchContext({ boardDefault: 'develop', configDefault: 'main' });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    expect(context!.getDefaultBaseBranch!()).toBe('develop');
  });

  it('falls back to the effective config when the board has no default', () => {
    const { ipcContext } = makeBaseBranchContext({ configDefault: 'release' });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    expect(context!.getDefaultBaseBranch!()).toBe('release');
  });

  it('falls through an empty-string board default to the effective config', () => {
    const { ipcContext } = makeBaseBranchContext({ boardDefault: '', configDefault: 'qa' });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    expect(context!.getDefaultBaseBranch!()).toBe('qa');
  });

  it('returns undefined instead of throwing when the board config manager throws', () => {
    const { ipcContext } = makeBaseBranchContext({ boardThrows: true, configDefault: 'main' });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    expect(() => context!.getDefaultBaseBranch!()).not.toThrow();
    expect(context!.getDefaultBaseBranch!()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getPrResolveOptions
//
// The per-resolve PR settings for the two linkPRForTask calls the MCP command
// handlers make themselves. Same project binding and failure posture as
// getDefaultBaseBranch: read for the TARGET project's path, and an unreadable
// config reads as every option off rather than a failed tool call.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - getPrResolveOptions', () => {
  const PROJECT_PATH = '/projects/example';

  function makeOptionsContext(gitConfig: Record<string, unknown> | (() => never)) {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const getEffectiveConfig = vi.fn(() => {
      if (typeof gitConfig === 'function') return gitConfig();
      return { git: gitConfig };
    });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      boardConfigManager: { getDefaultBaseBranchForPath: vi.fn(() => undefined) },
      configManager: { getEffectiveConfig },
    } as unknown as IpcContext;
    return { ipcContext, getEffectiveConfig };
  }

  it('reads bypassCountsAsReady from the target project path', () => {
    const { ipcContext, getEffectiveConfig } = makeOptionsContext({ prBypassCountsAsReady: true });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    // Exact shape: the same mapper the linker's own sweep uses
    // (`prResolveOptionsFromGitConfig`), so a tool-triggered resolve and the
    // background sweep can never write different verdicts for one PR.
    expect(context!.getPrResolveOptions!()).toEqual({ bypassCountsAsReady: true });
    expect(getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('reads an explicit false for the default-on bypass setting as off', () => {
    const { ipcContext } = makeOptionsContext({ prBypassCountsAsReady: false });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrResolveOptions!()).toEqual({ bypassCountsAsReady: false });
  });

  it('reads an absent key as off, never as undefined', () => {
    // The stub returns the raw git block with no DEFAULT_CONFIG merge, so the
    // default-on bypass key reads false here too; production reads its
    // default through `getEffectiveConfig`'s merge.
    const { ipcContext } = makeOptionsContext({ defaultBaseBranch: 'main' });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrResolveOptions!()).toEqual({ bypassCountsAsReady: false });
  });

  it('returns every option off instead of throwing when the config is unreadable', () => {
    const { ipcContext } = makeOptionsContext(() => { throw new Error('config unreadable'); });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(() => context!.getPrResolveOptions!()).not.toThrow();
    expect(context!.getPrResolveOptions!()).toEqual({});
  });

  // The in-flight re-poll flag rides the same binding: an agent's own link
  // write has to start the 30 s re-poll, since during `/pull-request` it waits
  // on CI inside one turn and no idle arrives to start it.
  it.each([
    [{ prAutoRefresh: true }, true],
    [{ prAutoRefresh: false }, false],
    [{}, false],
  ] as Array<[Record<string, unknown>, boolean]>)('getPrRepollInFlight reads %j as %s from the target project path', (gitConfig, expected) => {
    const { ipcContext, getEffectiveConfig } = makeOptionsContext(gitConfig);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrRepollInFlight!()).toBe(expected);
    expect(getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('getPrRepollInFlight reads off instead of throwing when the config is unreadable', () => {
    const { ipcContext } = makeOptionsContext(() => { throw new Error('config unreadable'); });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrRepollInFlight!()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readTaskKnowledge
//
// What `kangentic_find_task` and `kangentic_get_current_task` print under a
// task comes through this gate. The index switch decides whether the index may
// be read at all. The Task summaries switch only stops NEW summaries, so a
// written one is still shown: it is reported to the printer, never applied
// here. A failed read must never fail the task lookup it decorates.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - readTaskKnowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeKnowledgeContext(config: (() => unknown) | unknown) {
    const project = makeProject({ id: DEFAULT_ID });
    const load = vi.fn(() => (typeof config === 'function' ? (config as () => unknown)() : config));
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      configManager: { load },
    } as unknown as IpcContext;
    return buildCommandContextForProject(ipcContext, DEFAULT_ID)!;
  }

  it('reads the index of the target project, and reports the summaries switch as on by default', async () => {
    const byTask = new Map([['task-a', { summary: null, commits: [], commitCount: 0, changedFiles: [], changedFileCount: 0 }]]);
    workerCallSpy.mockResolvedValue(byTask);
    const context = makeKnowledgeContext({ knowledgeGraph: undefined });

    const read = await context.readTaskKnowledge!(['task-a']);

    expect(workerCallSpy).toHaveBeenCalledWith('task.knowledge', { projectId: DEFAULT_ID, taskIds: ['task-a'] });
    expect(read).toEqual({ indexOn: true, summariesOn: true, byTask });
  });

  it('does not read the index at all when indexing is off', async () => {
    const context = makeKnowledgeContext({ knowledgeGraph: { indexingEnabled: false } });

    expect(await context.readTaskKnowledge!(['task-a'])).toEqual({ indexOn: false });
    expect(workerCallSpy).not.toHaveBeenCalled();
  });

  it('reads the index while only the Task summaries switch is off, and reports it off', async () => {
    workerCallSpy.mockResolvedValue(new Map());
    const context = makeKnowledgeContext({ knowledgeGraph: { indexingEnabled: true, taskSummaries: false } });

    const read = await context.readTaskKnowledge!(['task-a']);

    expect(workerCallSpy).toHaveBeenCalledOnce();
    expect(read).toMatchObject({ indexOn: true, summariesOn: false });
  });

  it('treats a config that cannot be read as the defaults: index on, summaries on', async () => {
    workerCallSpy.mockResolvedValue(new Map());
    const context = makeKnowledgeContext(() => { throw new Error('config unreadable'); });

    expect(await context.readTaskKnowledge!(['task-a'])).toMatchObject({ indexOn: true, summariesOn: true });
  });

  it('answers with no knowledge, and does not throw, when the index read fails or the worker is down', async () => {
    workerCallSpy.mockRejectedValue(new Error('no such table: memory_chunks'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const context = makeKnowledgeContext({ knowledgeGraph: undefined });

      const read = await context.readTaskKnowledge!(['task-a']);

      expect(read).toEqual({ indexOn: true, summariesOn: true, byTask: new Map() });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// get_task_report reads
//
// `get_task_report` shows what the completed task view shows, through two
// callbacks on the context. Each must forward the context's own project, never
// an ambient one, and the git read must skip the commits' web links because the
// report carries no commits. The reads themselves are tested where they live.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - get_task_report reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeReportContext() {
    const project = makeProject({ id: DEFAULT_ID });
    const ipcContext = makeIpcContext(project);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;
    return { ipcContext, context };
  }

  it('readTaskReport forwards the IPC context, the context\'s project, the task and the options, and returns the report', async () => {
    const report = { taskId: 'task-1' } as unknown as TaskReport;
    readTaskReportSpy.mockResolvedValue(report);
    const { ipcContext, context } = makeReportContext();

    const result = await context.readTaskReport!('task-1', { commitLimit: 100, includeLedger: false });

    expect(readTaskReportSpy).toHaveBeenCalledOnce();
    expect(readTaskReportSpy).toHaveBeenCalledWith(ipcContext, DEFAULT_ID, 'task-1', { commitLimit: 100, includeLedger: false });
    expect(result).toBe(report);
  });

  it('readTaskChanges reads the task in the context\'s project without commit web links, and returns the changes', async () => {
    const changes = { branchName: 'feature/x' } as unknown as GitTaskChangesResult;
    readTaskChangesSpy.mockResolvedValue(changes);
    const { ipcContext, context } = makeReportContext();

    const result = await context.readTaskChanges!('task-1');

    expect(readTaskChangesSpy).toHaveBeenCalledOnce();
    expect(readTaskChangesSpy).toHaveBeenCalledWith(ipcContext, { projectId: DEFAULT_ID, taskId: 'task-1' }, { commitWebLinks: false });
    expect(result).toBe(changes);
  });
});

// ---------------------------------------------------------------------------
// onSwimlaneUpdated write-back
//
// Regression lock: an MCP update_column edits a swimlane row and fires
// onSwimlaneUpdated. That callback must persist the team-shared column fields
// to kangentic.json (via BoardConfigManager.writeBackForProject), not only push
// the renderer notification - otherwise an agent's model/effort/permission edit
// is lost on restart and never reaches teammates via git. It must be
// project-scoped so a cross-project update_column reaches the right file.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - onSwimlaneUpdated write-back', () => {
  const PROJECT_PATH = '/projects/example';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeWriteBackContext() {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const send = vi.fn();
    const writeBackForProject = vi.fn();
    const emitBoardChanged = vi.fn();
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
      boardConfigManager: { writeBackForProject },
      boardEvents: { emitBoardChanged },
    } as unknown as IpcContext;
    return { ipcContext, send, writeBackForProject, emitBoardChanged };
  }

  // onSwimlaneUpdated only reads id + name off the swimlane.
  const fakeSwimlane = (): Swimlane => ({ id: 'lane-1', name: 'To Do' }) as unknown as Swimlane;

  it('writes back the targeted project id and path (project-scoped)', () => {
    const { ipcContext, writeBackForProject } = makeWriteBackContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    context!.onSwimlaneUpdated(fakeSwimlane());

    expect(writeBackForProject).toHaveBeenCalledTimes(1);
    expect(writeBackForProject).toHaveBeenCalledWith(DEFAULT_ID, PROJECT_PATH);
  });

  it('still notifies the renderer (write-back is additive)', () => {
    const { ipcContext, send } = makeWriteBackContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);

    context!.onSwimlaneUpdated(fakeSwimlane());

    // The ipc-channels mock is a Proxy that returns each key as its own string,
    // so the channel arrives as the literal 'SWIMLANE_UPDATED_BY_AGENT'.
    expect(send).toHaveBeenCalledWith(
      'SWIMLANE_UPDATED_BY_AGENT', 'lane-1', 'To Do', DEFAULT_ID,
    );
  });

  it('does not write back for non-swimlane callbacks (onBacklogChanged)', () => {
    const { ipcContext, writeBackForProject } = makeWriteBackContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);

    context!.onBacklogChanged();

    expect(writeBackForProject).not.toHaveBeenCalled();
  });

  // onSwimlaneDeleted carries the SAME obligation, for a sharper reason than
  // update's. kangentic.json re-seeds the database on project open
  // (applyConfigOnOpen runs before the export), so a delete that skips the
  // write-back leaves the column listed in the file WITH its id - and the next
  // project open re-creates it, same uuid, nothing logged. The delete looks like
  // it worked until you restart.
  //
  // This is unit-tested rather than exercised in a /preview because
  // writeBackForProject short-circuits on `isEphemeral`, and an ephemeral
  // preview is exactly what /preview runs.

  it('writes back on delete too, or the next project open resurrects the column', () => {
    const { ipcContext, writeBackForProject } = makeWriteBackContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);

    context!.onSwimlaneDeleted(fakeSwimlane());

    expect(writeBackForProject).toHaveBeenCalledTimes(1);
    expect(writeBackForProject).toHaveBeenCalledWith(DEFAULT_ID, PROJECT_PATH);
  });

  it('notifies the renderer on delete via the shared columns-changed channel', () => {
    const { ipcContext, send, emitBoardChanged } = makeWriteBackContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);

    context!.onSwimlaneDeleted(fakeSwimlane());

    // Reuses SWIMLANE_UPDATED_BY_AGENT deliberately: the renderer's only
    // consumer treats it as "this project's columns changed, re-read them".
    expect(send).toHaveBeenCalledWith(
      'SWIMLANE_UPDATED_BY_AGENT', 'lane-1', 'To Do', DEFAULT_ID,
    );
    expect(emitBoardChanged).toHaveBeenCalledWith({
      projectId: DEFAULT_ID, change: 'swimlane-updated', ids: ['lane-1'],
    });
  });
});

// ---------------------------------------------------------------------------
// Consolidated board-changed bus fan-out
//
// The mobile bridge's read-board subscription consumes context.boardEvents
// instead of each ad-hoc *_BY_AGENT channel. Every board-mutation callback
// must feed BOTH the existing renderer IPC push (unchanged, zero risk to the
// renderer) AND the boardEvents bus (additive).
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - consolidated board-changed bus fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeFanOutContext() {
    const project = makeProject({ id: DEFAULT_ID });
    const send = vi.fn();
    const emitBoardChanged = vi.fn();
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged },
      sessionManager: { removeByTaskId: vi.fn() },
    } as unknown as IpcContext;
    return { ipcContext, send, emitBoardChanged };
  }

  it('onTaskCreated fires a task-created board event', () => {
    const { ipcContext, emitBoardChanged } = makeFanOutContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTaskCreated({ id: 'task-0', title: 'Task Zero' } as never, 'To Do', 'lane-0');

    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'task-created', ids: ['task-0'] });
  });

  it('onTaskUpdated fires both the IPC push and a task-updated board event', () => {
    const { ipcContext, send, emitBoardChanged } = makeFanOutContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTaskUpdated({ id: 'task-1', title: 'Task One' } as never);

    expect(send).toHaveBeenCalledWith('TASK_UPDATED_BY_AGENT', 'task-1', 'Task One', DEFAULT_ID);
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'task-updated', ids: ['task-1'] });
  });

  it('onTaskPrLinkChanged pushes the QUIET channel but still fires the task-updated board event', () => {
    // The quiet twin of onTaskUpdated, used by the link-time PR re-resolve.
    // Two halves, and both matter:
    //   - the renderer push must be TASK_PR_LINK_CHANGED (bare projectId), so
    //     useAgentDrivenInvalidation reloads the board without toasting;
    //   - emitBoardChanged must NOT go quiet with it, because the monitor and
    //     the mobile bridge's board-event bus consume that event and a PR link
    //     change is a real row change to them.
    const { ipcContext, send, emitBoardChanged } = makeFanOutContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTaskPrLinkChanged!({ id: 'task-1', title: 'Task One' } as never);

    expect(send).toHaveBeenCalledWith('TASK_PR_LINK_CHANGED', DEFAULT_ID);
    expect(send).not.toHaveBeenCalledWith(
      'TASK_UPDATED_BY_AGENT', expect.anything(), expect.anything(), expect.anything(),
    );
    // The `not.toHaveBeenCalledWith` above matches on an exact 4-argument shape,
    // so on its own it would miss a loud push made with any other arity. Pinning
    // the total to one push closes that: an extra send of ANY shape reds this.
    expect(send).toHaveBeenCalledTimes(1);

    // Revert-proof for the `sendToRenderer` routing: restoring a raw
    // `ipcContext.mainWindow.webContents.send(...)` here keeps every assertion
    // above green while silently dropping the push from the IPC traffic log.
    expect(recordPushSpy).toHaveBeenCalledWith('TASK_PR_LINK_CHANGED', [DEFAULT_ID]);

    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'task-updated', ids: ['task-1'] });
  });

  it('onTaskDeleted fires a task-deleted board event', () => {
    const { ipcContext, emitBoardChanged } = makeFanOutContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTaskDeleted({ id: 'task-2', title: 'Task Two', session_id: null, worktree_path: null } as never);

    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'task-deleted', ids: ['task-2'] });
  });

  it('onSwimlaneUpdated fires a swimlane-updated board event', () => {
    const { ipcContext, emitBoardChanged } = makeFanOutContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onSwimlaneUpdated({ id: 'lane-1', name: 'Review' } as never);

    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'swimlane-updated', ids: ['lane-1'] });
  });

  it('onBacklogChanged fires a backlog-changed board event with no ids', () => {
    const { ipcContext, emitBoardChanged } = makeFanOutContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onBacklogChanged();

    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'backlog-changed', ids: [] });
  });
});

// ---------------------------------------------------------------------------
// onSwimlaneUpdated - strategy propagation gate
//
// An MCP update_column edit must reach live sessions (model/effort injection,
// the auto_spawn reconcile) exactly as a human column edit does - but only
// when there is a previous row to diff against (a create-column path has none)
// and only when the edited project is the one currently focused (a background
// project's tasks pick the new column config up when they next spawn, rather
// than having this reconcile spawn/suspend agents in a checkout nobody is
// looking at).
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - onSwimlaneUpdated strategy propagation gate', () => {
  const PROJECT_PATH = '/projects/example';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeGateContext(currentProjectId: string | undefined) {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
      currentProjectId,
    } as unknown as IpcContext;
    return { ipcContext };
  }

  // onSwimlaneUpdated only reads id + name off the swimlane for its own
  // renderer push; the propagation gate reads the whole row via `previous`.
  const nextSwimlane = (): Swimlane => ({ id: 'lane-1', name: 'To Do' }) as unknown as Swimlane;
  const previousSwimlane = (): Swimlane => ({ id: 'lane-1', name: 'Backlog' }) as unknown as Swimlane;

  it('propagates when a previous row is supplied and the project matches the active one', () => {
    const { ipcContext } = makeGateContext(DEFAULT_ID);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();
    const markerChanges = [{ marker: 'column-strategy-changes' }] as never;
    vi.mocked(buildColumnStrategyChanges).mockReturnValue(markerChanges);

    context!.onSwimlaneUpdated(nextSwimlane(), previousSwimlane());

    expect(buildColumnStrategyChanges).toHaveBeenCalledWith({
      context: ipcContext,
      projectId: DEFAULT_ID,
      before: previousSwimlane(),
      after: nextSwimlane(),
    });
    expect(propagateStrategyToLiveSessions).toHaveBeenCalledTimes(1);
    expect(propagateStrategyToLiveSessions).toHaveBeenCalledWith(
      ipcContext, 'MCP_UPDATE_COLUMN', markerChanges, DEFAULT_ID,
    );
  });

  it('does not propagate when the project does not match the active one', () => {
    const { ipcContext } = makeGateContext('some-other-project-id');
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    context!.onSwimlaneUpdated(nextSwimlane(), previousSwimlane());

    expect(propagateStrategyToLiveSessions).not.toHaveBeenCalled();
    expect(buildColumnStrategyChanges).not.toHaveBeenCalled();
  });

  it('does not propagate when there is no previous row (create-column path)', () => {
    const { ipcContext } = makeGateContext(DEFAULT_ID);
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context).not.toBeNull();

    context!.onSwimlaneUpdated(nextSwimlane());

    expect(propagateStrategyToLiveSessions).not.toHaveBeenCalled();
    expect(buildColumnStrategyChanges).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onTasksReordered
//
// Fired after `kangentic_reorder_tasks` or a same-column `kangentic_move_task`.
// Every other test in this file stubs the callback as a bare `vi.fn()`, so its
// real body has never been exercised. Three deliberate decisions are pinned
// here (see the comment on the callback in mcp-project-context.ts):
//
//   - it announces the change through SWIMLANE_UPDATED_BY_AGENT, not
//     TASK_UPDATED_BY_AGENT - a task push names one arbitrary card, which is
//     wrong for an N-card reorder;
//   - the board-changed event carries the FULL ordered id list, not just one
//     id;
//   - it does NOT delegate to onSwimlaneUpdated, which would also write back
//     kangentic.json and propagate column strategy to live sessions - neither
//     applies to a presentation-only reorder.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - onTasksReordered', () => {
  const PROJECT_PATH = '/projects/example';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeReorderContext() {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const send = vi.fn();
    const writeBackForProject = vi.fn();
    const emitBoardChanged = vi.fn();
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
      boardConfigManager: { writeBackForProject },
      boardEvents: { emitBoardChanged },
    } as unknown as IpcContext;
    return { ipcContext, send, writeBackForProject, emitBoardChanged };
  }

  // onTasksReordered only reads id + name off the swimlane, same as
  // onSwimlaneUpdated's own renderer push.
  const fakeSwimlane = (): Swimlane => ({ id: 'lane-1', name: 'To Do' }) as unknown as Swimlane;

  it('sends SWIMLANE_UPDATED_BY_AGENT, not TASK_UPDATED_BY_AGENT, for an N-card reorder', () => {
    const { ipcContext, send } = makeReorderContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTasksReordered(fakeSwimlane(), ['task-a', 'task-b', 'task-c']);

    expect(send).toHaveBeenCalledWith('SWIMLANE_UPDATED_BY_AGENT', 'lane-1', 'To Do', DEFAULT_ID);
    expect(send).not.toHaveBeenCalledWith(
      'TASK_UPDATED_BY_AGENT', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('emits a task-updated board event carrying the FULL ordered id list', () => {
    const { ipcContext, emitBoardChanged } = makeReorderContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTasksReordered(fakeSwimlane(), ['task-a', 'task-b', 'task-c']);

    expect(emitBoardChanged).toHaveBeenCalledWith({
      projectId: DEFAULT_ID,
      change: 'task-updated',
      ids: ['task-a', 'task-b', 'task-c'],
    });
  });

  it('does not delegate to onSwimlaneUpdated: no kangentic.json write-back', () => {
    // writeBackForProject is unconditional inside onSwimlaneUpdated, so its
    // absence here is the sharpest signal a reorder took a different path - a
    // reorder changes neither the column's config nor any live session.
    const { ipcContext, writeBackForProject } = makeReorderContext();
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTasksReordered(fakeSwimlane(), ['task-a']);

    expect(writeBackForProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onTaskSettingsChanged - an agent or phone pin reaches the live session
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - onTaskSettingsChanged', () => {
  const PROJECT_PATH = '/projects/example';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSettingsContext() {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const send = vi.fn();
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
      boardEvents: { emitBoardChanged: vi.fn() },
    } as unknown as IpcContext;
    return { ipcContext, send, context: buildCommandContextForProject(ipcContext, DEFAULT_ID)! };
  }

  const liveTask = { id: 'task-1', title: 'T', session_id: 'session-1' } as never;
  const effortOnly = { model: false, effort: true };

  /** Lets the deferred apply and its `.then` / `.catch` settle. */
  async function settleDeferredApply(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('applies the fields the write moved, under the task lock, for this project', async () => {
    applySettingsSpy.mockResolvedValue({ ok: true, mode: 'persisted' });
    const { ipcContext, context } = makeSettingsContext();

    context.onTaskSettingsChanged?.(liveTask, effortOnly);

    await vi.waitFor(() => expect(applySettingsSpy).toHaveBeenCalledOnce());
    expect(withTaskLockSpy).toHaveBeenCalledWith('task-1', expect.any(Function));
    expect(applySettingsSpy).toHaveBeenCalledWith(
      ipcContext, DEFAULT_ID, PROJECT_PATH, 'task-1', effortOnly,
    );
  });

  // The restart writes the agent's exit sequence into its PTY. Run inside the
  // tool call, that lands before the reply, so an agent updating its own task
  // never learns its turn is ending.
  it('starts the apply only after the call that triggered it has returned', async () => {
    applySettingsSpy.mockResolvedValue({ ok: true, mode: 'persisted' });
    const { context } = makeSettingsContext();

    context.onTaskSettingsChanged?.(liveTask, effortOnly);
    await Promise.resolve();

    expect(withTaskLockSpy).not.toHaveBeenCalled();
    expect(applySettingsSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(applySettingsSpy).toHaveBeenCalledOnce());
  });

  it('re-syncs the board quietly after a restart, which cleared the task session id', async () => {
    applySettingsSpy.mockResolvedValue({ ok: true, mode: 'restart' });
    const { send, context } = makeSettingsContext();

    context.onTaskSettingsChanged?.(liveTask, effortOnly);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('TASK_SESSION_RESYNC', DEFAULT_ID));
  });

  it('sends no re-sync when nothing restarted', async () => {
    applySettingsSpy.mockResolvedValue({ ok: true, mode: 'persisted' });
    const { send, context } = makeSettingsContext();

    context.onTaskSettingsChanged?.(liveTask, effortOnly);

    await vi.waitFor(() => expect(applySettingsSpy).toHaveBeenCalledOnce());
    await settleDeferredApply();
    expect(send).not.toHaveBeenCalledWith('TASK_SESSION_RESYNC', DEFAULT_ID);
  });

  it('re-syncs and warns when the restart failed after clearing the session id', async () => {
    applySettingsSpy.mockResolvedValue({ ok: false, reason: 'respawn failed: boom' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, context } = makeSettingsContext();

    context.onTaskSettingsChanged?.(liveTask, effortOnly);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('TASK_SESSION_RESYNC', DEFAULT_ID));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('respawn failed: boom'));
    warnSpy.mockRestore();
  });

  it('logs a thrown apply instead of leaving an unhandled rejection', async () => {
    applySettingsSpy.mockRejectedValue(new Error('task vanished'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send, context } = makeSettingsContext();

    context.onTaskSettingsChanged?.(liveTask, effortOnly);

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Settings apply failed'), expect.objectContaining({ message: 'task vanished' }),
    ));
    expect(send).not.toHaveBeenCalledWith('TASK_SESSION_RESYNC', DEFAULT_ID);
    errorSpy.mockRestore();
  });

  it('does nothing for a task with no live session', async () => {
    const { context } = makeSettingsContext();

    context.onTaskSettingsChanged?.({ id: 'task-1', title: 'T', session_id: null } as never, effortOnly);
    await settleDeferredApply();

    expect(withTaskLockSpy).not.toHaveBeenCalled();
    expect(applySettingsSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onTaskDeleted - worktree teardown ordering (pty-teardown-grace)
//
// The exit promise is captured BETWEEN the kill and the remove: `remove()`
// itself does not wait (the deferred PTY lives outside the registry row, so
// deleting the row cannot cut its grace short), but the filesystem-touching
// work that follows - reapTaskLeftovers and the worktree removal inside
// worktreeManager.withLock - must wait for the real process exit, not for
// the kill() call. The wait happens BEFORE the per-project git lock is
// entered, so a young session's grace never head-of-line-blocks every other
// task's worktree work in the project.
// ---------------------------------------------------------------------------

describe('buildCommandContextForProject - onTaskDeleted worktree teardown ordering', () => {
  const PROJECT_PATH = '/projects/example';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for the killed session to exit before closing its windows, reaping leftovers or entering the worktree lock', async () => {
    const timeline: string[] = [];
    const exitDeferred = createDeferred();
    // Closed only once no session is left: a Browser pop-out closing while the
    // agent still ran would be handed off to an offscreen lane.
    vi.mocked(closeTaskWindows).mockImplementationOnce(() => {
      timeline.push('closeTaskWindows');
    });

    const withLockMock = vi.fn(async (fn: () => Promise<void>) => {
      timeline.push('withLock:enter');
      await fn();
      timeline.push('withLock:exit');
    });
    const removeWorktreeMock = vi.fn(async () => {
      timeline.push('removeWorktree');
      return false;
    });
    // A plain function expression, not an arrow function: vi.fn() invokes the
    // implementation with `new`, and an arrow function can never be a
    // constructor - it would throw "is not a constructor" the moment
    // onTaskDeleted reaches `new WorktreeManager(projectPath)`.
    vi.mocked(WorktreeManager).mockImplementationOnce(function mockWorktreeManager() {
      return {
        withLock: withLockMock,
        removeWorktree: removeWorktreeMock,
        pruneWorktrees: vi.fn(async () => {}),
        removeBranch: vi.fn(async () => {}),
      };
    } as unknown as typeof WorktreeManager);

    vi.mocked(reapTaskLeftovers).mockImplementationOnce(async () => {
      timeline.push('reapTaskLeftovers');
    });

    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
      sessionManager: {
        kill: vi.fn((sessionId: string) => { timeline.push(`kill:${sessionId}`); }),
        awaitExit: vi.fn((sessionId: string) => {
          timeline.push(`awaitExit:${sessionId}`);
          return exitDeferred.promise;
        }),
        remove: vi.fn((sessionId: string) => { timeline.push(`remove:${sessionId}`); }),
        removeByTaskId: vi.fn(),
      },
    } as unknown as IpcContext;

    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTaskDeleted({
      id: 'task-1',
      title: 'Task One',
      session_id: 'session-1',
      worktree_path: '/projects/example/.kangentic/worktrees/task-1',
      branch_name: null,
    } as never);

    // onTaskDeleted's synchronous body (kill, capture awaitExit, remove) has
    // already run by the time the call above returns.
    expect(timeline).toEqual(['kill:session-1', 'awaitExit:session-1', 'remove:session-1']);

    // Drain a couple of microtask ticks: the detached async IIFE must still
    // be parked on `await sessionExited`, so neither the reap nor the
    // worktree lock has run yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(timeline).toEqual(['kill:session-1', 'awaitExit:session-1', 'remove:session-1']);
    expect(closeTaskWindows).not.toHaveBeenCalled();
    expect(reapTaskLeftovers).not.toHaveBeenCalled();
    expect(withLockMock).not.toHaveBeenCalled();

    exitDeferred.resolve();
    await vi.waitFor(() => {
      expect(timeline).toContain('withLock:exit');
    });

    expect(closeTaskWindows).toHaveBeenCalledWith(DEFAULT_ID, 'task-1');
    expect(timeline).toEqual([
      'kill:session-1',
      'awaitExit:session-1',
      'remove:session-1',
      'closeTaskWindows',
      'reapTaskLeftovers',
      'withLock:enter',
      'removeWorktree',
      'withLock:exit',
    ]);
  });

  // Pins the `await spawnsSettled` in onTaskDeleted. `removeByTaskId` resolves
  // once a spawn of the task that is still in its host round trip has settled:
  // the PTY the host may already have started holds the worktree as its cwd
  // until it exits, and the task row does not name that session yet, so
  // `task.session_id` (null here) has nothing for the kill and awaitExit above
  // to wait on. Drop the await and the reap and the removal run at once, which
  // is the Windows delete failure this ordering exists to prevent.
  it('waits for a spawn of the task still in flight before reaping leftovers or removing the worktree', async () => {
    const timeline: string[] = [];
    const spawnsSettled = createDeferred();

    const withLockMock = vi.fn(async (fn: () => Promise<void>) => {
      timeline.push('withLock:enter');
      await fn();
      timeline.push('withLock:exit');
    });
    const removeWorktreeMock = vi.fn(async () => {
      timeline.push('removeWorktree');
      return false;
    });
    // A plain function expression for the same reason as above: `new` on an
    // arrow function throws.
    vi.mocked(WorktreeManager).mockImplementationOnce(function mockWorktreeManager() {
      return {
        withLock: withLockMock,
        removeWorktree: removeWorktreeMock,
        pruneWorktrees: vi.fn(async () => {}),
        removeBranch: vi.fn(async () => {}),
      };
    } as unknown as typeof WorktreeManager);

    vi.mocked(reapTaskLeftovers).mockImplementationOnce(async () => {
      timeline.push('reapTaskLeftovers');
    });
    vi.mocked(closeTaskWindows).mockImplementationOnce(() => {
      timeline.push('closeTaskWindows');
    });

    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const emitBoardChanged = vi.fn();
    const removeByTaskId = vi.fn((taskId: string) => {
      timeline.push(`removeByTaskId:${taskId}`);
      return spawnsSettled.promise;
    });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
      sessionManager: {
        kill: vi.fn(),
        awaitExit: vi.fn(() => Promise.resolve()),
        remove: vi.fn(),
        removeByTaskId,
      },
    } as unknown as IpcContext;

    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;

    context.onTaskDeleted({
      id: 'task-1',
      title: 'Task One',
      session_id: null,
      worktree_path: '/projects/example/.kangentic/worktrees/task-1',
      branch_name: null,
    } as never);

    // The teardown asked for the spawns' settle, and the delete itself is not
    // held back by the wait: the board event fires on the same tick.
    expect(removeByTaskId).toHaveBeenCalledWith('task-1');
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: DEFAULT_ID, change: 'task-deleted', ids: ['task-1'] });

    // A whole macrotask, not a couple of microtask ticks: the reverted code (no
    // await on the spawns) reaches the reap, the lock and the removal through
    // several awaited steps, which a short drain would not carry it through.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timeline).toEqual(['removeByTaskId:task-1']);
    expect(closeTaskWindows).not.toHaveBeenCalled();
    expect(reapTaskLeftovers).not.toHaveBeenCalled();
    expect(withLockMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();

    spawnsSettled.resolve();
    await vi.waitFor(() => {
      expect(timeline).toContain('withLock:exit');
    });

    expect(timeline).toEqual([
      'removeByTaskId:task-1',
      'closeTaskWindows',
      'reapTaskLeftovers',
      'withLock:enter',
      'removeWorktree',
      'withLock:exit',
    ]);
  });

  it('reaps a deleted task that has no worktree: a project-folder task leaves processes behind too', async () => {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
      sessionManager: {
        kill: vi.fn(),
        awaitExit: vi.fn(() => Promise.resolve()),
        remove: vi.fn(),
        removeByTaskId: vi.fn(() => Promise.resolve()),
      },
    } as unknown as IpcContext;

    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;
    context.onTaskDeleted({
      id: 'task-3',
      title: 'Task Three',
      session_id: 'session-3',
      worktree_path: null,
      branch_name: null,
    } as never);

    await vi.waitFor(() => {
      // The title travels with it, for the leftover-process toast.
      expect(reapTaskLeftovers).toHaveBeenCalledWith(ipcContext, PROJECT_PATH, [{ id: 'task-3', worktree_path: null, title: 'Task Three' }]);
    });
    expect(WorktreeManager).not.toHaveBeenCalled();
  });

  // Pins the `await prepareWorktreeForRemoval(worktreePath, 'thorough')` in
  // onTaskDeleted. A new worktree's setup script runs after the git queue, and
  // a removal inside the queue refuses a path a creation still holds, so the
  // delete would leave the worktree and its branch behind. The wait therefore
  // sits OUTSIDE the queue: after the reap, before the worktree lock. Dropping
  // the call leaves the timeline without it; dropping the await takes the lock
  // while the creation is still pending.
  it('waits, outside the git queue, for a creation still setting the worktree up, after the reap and before the lock', async () => {
    const timeline: string[] = [];
    const creationSettled = createDeferred();
    const worktreePath = '/projects/example/.kangentic/worktrees/task-1';

    const withLockMock = vi.fn(async (fn: () => Promise<void>) => {
      timeline.push('withLock:enter');
      await fn();
      timeline.push('withLock:exit');
    });
    const removeWorktreeMock = vi.fn(async () => {
      timeline.push('removeWorktree');
      return false;
    });
    // A plain function expression for the same reason as above: `new` on an
    // arrow function throws.
    vi.mocked(WorktreeManager).mockImplementationOnce(function mockWorktreeManager() {
      return {
        withLock: withLockMock,
        removeWorktree: removeWorktreeMock,
        pruneWorktrees: vi.fn(async () => {}),
        removeBranch: vi.fn(async () => {}),
      };
    } as unknown as typeof WorktreeManager);
    vi.mocked(reapTaskLeftovers).mockImplementationOnce(async () => {
      timeline.push('reapTaskLeftovers');
    });
    vi.mocked(prepareWorktreeForRemoval).mockImplementationOnce(async () => {
      timeline.push('prepareWorktreeForRemoval');
      await creationSettled.promise;
    });

    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
      sessionManager: {
        kill: vi.fn(),
        awaitExit: vi.fn(() => Promise.resolve()),
        remove: vi.fn(),
        removeByTaskId: vi.fn(() => Promise.resolve()),
      },
    } as unknown as IpcContext;

    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;
    context.onTaskDeleted({
      id: 'task-1',
      title: 'Task One',
      session_id: null,
      worktree_path: worktreePath,
      branch_name: null,
    } as never);

    try {
      await vi.waitFor(() => {
        expect(timeline).toContain('prepareWorktreeForRemoval');
      });
      // A whole macrotask, not a few microtask ticks: the reverted code (no
      // await) reaches the lock and the removal through several awaited steps.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(timeline).toEqual(['reapTaskLeftovers', 'prepareWorktreeForRemoval']);
      expect(withLockMock).not.toHaveBeenCalled();
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      creationSettled.resolve();
    }

    await vi.waitFor(() => {
      expect(timeline).toContain('withLock:exit');
    });
    expect(prepareWorktreeForRemoval).toHaveBeenCalledTimes(1);
    expect(prepareWorktreeForRemoval).toHaveBeenCalledWith(worktreePath, 'thorough');
    expect(timeline).toEqual([
      'reapTaskLeftovers',
      'prepareWorktreeForRemoval',
      'withLock:enter',
      'removeWorktree',
      'withLock:exit',
    ]);
  });

  it('does not wait on a creation for a deleted task that has no worktree', async () => {
    const project = makeProject({ id: DEFAULT_ID, path: PROJECT_PATH });
    const ipcContext = {
      projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardConfigManager: { writeBackForProject: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { autoCleanup: false } })) },
      sessionManager: {
        kill: vi.fn(),
        awaitExit: vi.fn(() => Promise.resolve()),
        remove: vi.fn(),
        removeByTaskId: vi.fn(() => Promise.resolve()),
      },
    } as unknown as IpcContext;

    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID)!;
    context.onTaskDeleted({
      id: 'task-4',
      title: 'Task Four',
      session_id: null,
      worktree_path: null,
      branch_name: null,
    } as never);

    await vi.waitFor(() => {
      expect(reapTaskLeftovers).toHaveBeenCalledTimes(1);
    });
    // A whole macrotask: the waitFor above can return while the teardown is
    // still parked on the reap's await, before it reaches the worktree guard,
    // so without this turn the negative below would hold for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prepareWorktreeForRemoval).not.toHaveBeenCalled();
    expect(WorktreeManager).not.toHaveBeenCalled();
  });
});
