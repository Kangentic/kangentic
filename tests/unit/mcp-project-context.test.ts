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
  captureSessionLeftovers: vi.fn(() => null),
  reapSessionLeftovers: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  handleTaskMove: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
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
import { reapSessionLeftovers } from '../../src/main/ipc/helpers';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project, Swimlane } from '../../src/shared/types';

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

  it('reads evaluateBranchPolicies from the target project path', () => {
    const { ipcContext, getEffectiveConfig } = makeOptionsContext({ prEvaluateBranchPolicies: true });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    // Exact shape: the same mapper the linker's own sweep uses
    // (`prResolveOptionsFromGitConfig`), so a tool-triggered resolve and the
    // background sweep can never write different verdicts for one PR.
    expect(context!.getPrResolveOptions!()).toEqual({ evaluateBranchPolicies: true, bypassCountsAsReady: false });
    expect(getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('reads bypassCountsAsReady from the target project path', () => {
    const { ipcContext } = makeOptionsContext({ prBypassCountsAsReady: true });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrResolveOptions!()).toEqual({ evaluateBranchPolicies: false, bypassCountsAsReady: true });
  });

  it('reads an explicit false for the default-on bypass setting as off', () => {
    const { ipcContext } = makeOptionsContext({ prBypassCountsAsReady: false });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrResolveOptions!()).toEqual({ evaluateBranchPolicies: false, bypassCountsAsReady: false });
  });

  it('reads an absent key as off, never as undefined', () => {
    // The stub returns the raw git block with no DEFAULT_CONFIG merge, so the
    // default-on bypass key reads false here too; production reads its
    // default through `getEffectiveConfig`'s merge.
    const { ipcContext } = makeOptionsContext({ defaultBaseBranch: 'main' });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(context!.getPrResolveOptions!()).toEqual({ evaluateBranchPolicies: false, bypassCountsAsReady: false });
  });

  it('returns every option off instead of throwing when the config is unreadable', () => {
    const { ipcContext } = makeOptionsContext(() => { throw new Error('config unreadable'); });
    const context = buildCommandContextForProject(ipcContext, DEFAULT_ID);
    expect(() => context!.getPrResolveOptions!()).not.toThrow();
    expect(context!.getPrResolveOptions!()).toEqual({});
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
// onTaskDeleted - worktree teardown ordering (pty-teardown-grace)
//
// The exit promise is captured BETWEEN the kill and the remove: `remove()`
// itself does not wait (the deferred PTY lives outside the registry row, so
// deleting the row cannot cut its grace short), but the filesystem-touching
// work that follows - reapSessionLeftovers and the worktree removal inside
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

  it('waits for the killed session to exit before reaping leftovers or entering the worktree lock', async () => {
    const timeline: string[] = [];
    const exitDeferred = createDeferred();

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

    vi.mocked(reapSessionLeftovers).mockImplementationOnce(async () => {
      timeline.push('reapSessionLeftovers');
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
    expect(reapSessionLeftovers).not.toHaveBeenCalled();
    expect(withLockMock).not.toHaveBeenCalled();

    exitDeferred.resolve();
    await vi.waitFor(() => {
      expect(timeline).toContain('withLock:exit');
    });

    expect(timeline).toEqual([
      'kill:session-1',
      'awaitExit:session-1',
      'remove:session-1',
      'reapSessionLeftovers',
      'withLock:enter',
      'removeWorktree',
      'withLock:exit',
    ]);
  });
});
