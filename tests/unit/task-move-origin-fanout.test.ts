/**
 * handleTaskMove owns the notification fan-out for every one of its callers,
 * keyed on a required `origin` argument.
 *
 * Before this, the handler announced nothing at all and each call site was
 * expected to fan out for itself. Three of the four got it wrong in different
 * ways and the mobile bridge did neither half, so a task moved from the phone
 * landed in the DB and told nobody: the desktop board went on rendering the
 * card in the column it had just left until something else forced a reload.
 *
 * `origin` being a required positional parameter means tsc already proves
 * "every call site passes one" and the `Record<TaskMoveOrigin, ...>` push table
 * already proves "every origin is mapped". This file covers the three things
 * types cannot reach:
 *
 *   1. The origin literals at the call sites are the RIGHT ones. tsc only knows
 *      they are members of the union - it cannot know the mobile bridge should
 *      not be claiming to be an agent. The four sites live in four modules, so
 *      nothing else cross-checks them.
 *   2. The per-origin push policy: `renderer` stays silent (it moved the card
 *      itself), and `mobile` never rides the agent channel, whose listener
 *      toasts "Task updated by agent" - wrong provenance for a card the user
 *      dragged on their own phone.
 *   3. A committed move announces even when the move later FAILS. That is not
 *      a detail: the rollback skips the revert entirely on the abort path,
 *      skips it again when its CAS sees a concurrent move, and is best-effort
 *      inside its own try/catch - so "the move threw" does not imply "the DB is
 *      unchanged". Announcing only on success would silently reproduce the very
 *      bug this whole mechanism exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Task, Swimlane } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
  default: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    getSummaryForTask = vi.fn(() => null);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
  prepareInjectionPlan: vi.fn(() => null),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
}));

const mockAutoLinkPRForTask = vi.fn();
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: (...args: unknown[]) => mockAutoLinkPRForTask(...args),
}));

import { handleTaskMove, type TaskMoveOrigin } from '../../src/main/ipc/handlers/task-move';
import { IPC } from '../../src/shared/ipc-channels';

const TASK_ID = 'task-origin-fanout-1';
const TASK_TITLE = 'Move me';
const SOURCE_LANE_ID = 'lane-source';
const QUIET_TARGET_LANE_ID = 'lane-no-spawn';
const SPAWNING_TARGET_LANE_ID = 'lane-spawning';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: TASK_TITLE,
    description: '',
    swimlane_id: SOURCE_LANE_ID,
    position: 0,
    agent: 'claude',
    session_id: null,
    worktree_path: null,
    branch_name: 'move-me',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeContext(task: Task | null) {
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      removeByTaskId: vi.fn(),
      killByTaskId: vi.fn(),
      listSessions: vi.fn(() => []),
      suspend: vi.fn(async () => {}),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };

  mockGetProjectRepos.mockReturnValue({
    tasks: {
      getById: vi.fn(() => (task ? { ...task } : undefined)),
      move: vi.fn(),
      update: vi.fn(),
      list: vi.fn(() => (task ? [{ ...task }] : [])),
      archive: vi.fn(),
      clearArchived: vi.fn(),
    },
    swimlanes: {
      getById: vi.fn((id: string) =>
        ({
          [SOURCE_LANE_ID]: makeSwimlane(SOURCE_LANE_ID, { role: 'todo' }),
          // auto_spawn:false keeps Phase 1 self-contained (Priority 2.5), so a
          // plain committed move needs no worktree or spawn mocking.
          [QUIET_TARGET_LANE_ID]: makeSwimlane(QUIET_TARGET_LANE_ID, { auto_spawn: false }),
          // auto_spawn:true makes Phase 1 return a plan and carry into Phase 2,
          // which is the only way to reach the abort path.
          [SPAWNING_TARGET_LANE_ID]: makeSwimlane(SPAWNING_TARGET_LANE_ID, { auto_spawn: true }),
        })[id] ?? null,
      ),
      list: vi.fn(() => []),
    },
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn() },
  });

  return context;
}

function pushedChannels(context: ReturnType<typeof makeContext>): string[] {
  return context.mainWindow.webContents.send.mock.calls.map((call) => call[0] as string);
}

describe('the origin literal at each handleTaskMove call site', () => {
  const ORIGINS: TaskMoveOrigin[] = ['renderer', 'agent', 'mobile', 'auto-move'];

  /** Top-level arguments of the call whose '(' is at openParen. */
  function argumentsOf(source: string, openParen: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let start = openParen + 1;
    let inString: string | null = null;

    for (let index = openParen; index < source.length; index++) {
      const character = source[index];
      if (inString) {
        if (character === '\\') { index++; continue; }
        if (character === inString) inString = null;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') { inString = character; continue; }
      if (character === '(' || character === '[' || character === '{') { depth++; continue; }
      if (character === ')' || character === ']' || character === '}') {
        depth--;
        if (depth === 0) { args.push(source.slice(start, index).trim()); return args; }
        continue;
      }
      if (character === ',' && depth === 1) {
        args.push(source.slice(start, index).trim());
        start = index + 1;
      }
    }
    return args;
  }

  function callSites(): { file: string; origin: string }[] {
    const found: { file: string; origin: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;

        const source = fs.readFileSync(full, 'utf8');
        const needle = 'handleTaskMove(';
        for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
          const lineStart = source.lastIndexOf('\n', i) + 1;
          const line = source.slice(lineStart, source.indexOf('\n', i));
          // The declaration and the import are not call sites.
          if (line.includes('import ') || line.includes('export async function')) continue;
          const args = argumentsOf(source, i + needle.length - 1);
          found.push({
            file: path.relative(REPO_ROOT, full).replace(/\\/g, '/'),
            origin: args[2] ?? '<missing>',
          });
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    return found;
  }

  it('names an origin from the union at every call site', () => {
    const sites = callSites();
    // Four callers today: the TASK_MOVE IPC handler, the MCP command context,
    // the plan-exit auto-move, and the mobile bridge verb.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const site of sites) {
      expect(ORIGINS.map((origin) => `'${origin}'`)).toContain(site.origin);
    }
  });

  it('gives each caller the origin that matches how the move was actually made', () => {
    const byFile = Object.fromEntries(callSites().map((site) => [site.file, site.origin]));

    // A phone move must never claim to be an agent: the agent channel toasts
    // "Task updated by agent", and no agent touched this task.
    expect(byFile['src/main/mobile-bridge/handlers/move-task.ts']).toBe("'mobile'");
    expect(byFile['src/main/agent/mcp-project-context.ts']).toBe("'agent'");
    expect(byFile['src/main/ipc/handlers/sessions.ts']).toBe("'auto-move'");
    // The renderer already moved the card optimistically, so this one is silent.
    expect(byFile['src/main/ipc/handlers/task-move.ts']).toBe("'renderer'");
  });

  it('routes its pushes through sendToRenderer, never a raw webContents.send', () => {
    // A raw send bypasses the IPC recorder. That is not cosmetic: the plan-exit
    // auto-move used a raw send for exactly this channel, so TASK_AUTO_MOVED
    // never appeared in the dev IPC log at all - a blind spot that actively
    // misled the investigation into the bug this file guards.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/ipc/handlers/task-move.ts'), 'utf8');
    expect(source).toContain('sendToRenderer(');
    expect(source).not.toMatch(/mainWindow\.webContents\.send\(/);
  });
});

describe('what each origin announces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function move(origin: TaskMoveOrigin, targetSwimlaneId = QUIET_TARGET_LANE_ID) {
    const context = makeContext(makeTask());
    await handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId, targetPosition: 0 }, origin);
    return context;
  }

  it('emits on the board-changed bus for EVERY origin, renderer included', async () => {
    for (const origin of ['renderer', 'agent', 'mobile', 'auto-move'] as TaskMoveOrigin[]) {
      vi.clearAllMocks();
      const context = await move(origin);
      expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledWith({
        projectId: 'proj-test',
        change: 'task-updated',
        ids: [TASK_ID],
      });
    }
    // The bus is what reaches paired phones and the Agent Monitor, both of which
    // are external to whoever made the move - so a plain desktop drag has to
    // feed it too. That row of the matrix was missing entirely before.
  });

  it('announces a within-column reorder, which commits and then returns early', async () => {
    // A same-lane drop sets moveCommitted and immediately returns null before
    // any of Phase 1's side-effect work, so it reaches the announce block by a
    // different route than every other case here. It still moved the row, so it
    // still has to be announced: a phone reordering a column has to show up on
    // the desktop, and the Monitor's ordering is read from the same rows.
    //
    // Red: moving `moveCommitted = true` below the `fromSwimlaneId ===
    // targetSwimlaneId` early return makes all three assertions fail.
    const context = await move('mobile', SOURCE_LANE_ID);

    expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledWith({
      projectId: 'proj-test',
      change: 'task-updated',
      ids: [TASK_ID],
    });
    expect(pushedChannels(context)).toEqual([IPC.TASK_MOVED_BY_MOBILE]);
    expect(mockAutoLinkPRForTask).toHaveBeenCalledTimes(1);
  });

  it('sends NO renderer push for a renderer-origin move', async () => {
    const context = await move('renderer');
    expect(pushedChannels(context)).toEqual([]);
    // Pushing here would cost a redundant board reload, and on the agent
    // channel the user would toast themselves for their own drag.
  });

  it('sends the quiet mobile channel, and never the agent one, for a phone move', async () => {
    const context = await move('mobile');
    expect(pushedChannels(context)).toEqual([IPC.TASK_MOVED_BY_MOBILE]);
    expect(pushedChannels(context)).not.toContain(IPC.TASK_UPDATED_BY_AGENT);

    // Bare projectId, matching the other quiet channels - no title to toast with.
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.TASK_MOVED_BY_MOBILE,
      'proj-test',
    );
  });

  it('sends the agent channel with the task title for an agent move', async () => {
    const context = await move('agent');
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.TASK_UPDATED_BY_AGENT,
      TASK_ID,
      TASK_TITLE,
      'proj-test',
    );
  });

  it('sends the auto-moved channel with the destination lane for a plan-exit move', async () => {
    const context = await move('auto-move');
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.TASK_AUTO_MOVED,
      TASK_ID,
      QUIET_TARGET_LANE_ID,
      TASK_TITLE,
      'proj-test',
    );
  });

  it('resolves the PR link for every origin, not just the two that used to', async () => {
    // This used to live at the call sites, so an agent's move and a phone's move
    // never linked a PR for the lane they landed in.
    for (const origin of ['renderer', 'agent', 'mobile', 'auto-move'] as TaskMoveOrigin[]) {
      vi.clearAllMocks();
      await move(origin);
      expect(mockAutoLinkPRForTask).toHaveBeenCalledTimes(1);
    }
  });
});

describe('a committed move announces even when the move later fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTaskWorktree.mockResolvedValue(null);
  });

  it('still announces when a superseding move aborts this one after the DB write', async () => {
    // The abort path deliberately does NOT revert the move (`!abort &&` guards
    // the revert), so the row really is in its new column. If this went
    // unannounced the board would show the card where it no longer is - the
    // exact failure this mechanism exists to prevent.
    const abortController = new AbortController();
    abortController.abort();
    mockEnsureTaskWorktree.mockRejectedValue(abortController.signal.reason as DOMException);

    const context = makeContext(makeTask());
    await expect(
      handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: SPAWNING_TARGET_LANE_ID, targetPosition: 0 },
        'mobile',
      ),
    ).resolves.toBeUndefined();

    expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledTimes(1);
    expect(pushedChannels(context)).toEqual([IPC.TASK_MOVED_BY_MOBILE]);
    // moveSucceeded is set once runMove resolves without throwing, and the
    // abort path returns rather than throwing - so PR linking, which is gated
    // on moveSucceeded (not "the caller's promise resolved cleanly with no
    // abort"), fires here too. The 60s per-task throttle in linkPRForTask is
    // what keeps a burst of superseded moves from becoming a burst of gh calls.
    expect(mockAutoLinkPRForTask).toHaveBeenCalledTimes(1);
  });

  it('still announces when Phase 2 throws and the move is rethrown', async () => {
    mockEnsureTaskWorktree.mockRejectedValue(new Error('Worktree setup failed'));

    const context = makeContext(makeTask());
    await expect(
      handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: SPAWNING_TARGET_LANE_ID, targetPosition: 0 },
        'mobile',
      ),
    ).rejects.toThrow('Worktree setup failed');

    // The rollback is best-effort and its CAS can decline to revert, so a
    // throw is not proof the DB is unchanged.
    expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledTimes(1);

    // PR linking is the one thing that stays success-only, matching what the
    // call sites did before they handed this over.
    expect(mockAutoLinkPRForTask).not.toHaveBeenCalled();
  });

  it('announces nothing when the move never committed', async () => {
    // No task row: Phase 1 throws before tasks.move, so there is no board
    // change to report and the announce block must stay shut.
    const context = makeContext(null);
    await expect(
      handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: QUIET_TARGET_LANE_ID, targetPosition: 0 },
        'mobile',
      ),
    ).rejects.toThrow();

    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
    expect(pushedChannels(context)).toEqual([]);
    expect(mockAutoLinkPRForTask).not.toHaveBeenCalled();
  });
});

describe('the announce block never clobbers the move outcome', () => {
  // BoardEventBus is a plain EventEmitter, so a subscriber's own throw
  // dispatches synchronously on handleTaskMove's stack. The announce block
  // wraps both the bus emit and the renderer push in a try/catch specifically
  // so that throw cannot replace whatever runMove was already propagating, nor
  // turn a clean move into a rejection - "announcing is best-effort" has to
  // hold even when a listener is broken.
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTaskWorktree.mockResolvedValue(null);
  });

  it('resolves cleanly and still links the PR when the bus subscriber throws on a successful move', async () => {
    const context = makeContext(makeTask());
    context.boardEvents.emitBoardChanged.mockImplementation(() => {
      throw new Error('subscriber exploded');
    });

    await expect(
      handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: QUIET_TARGET_LANE_ID, targetPosition: 0 },
        'mobile',
      ),
    ).resolves.toBeUndefined();

    // PR linking sits OUTSIDE the announce try/catch, gated only on
    // moveSucceeded - it must still fire even though the emit right before it
    // threw. If the try/catch's scope ever widened to swallow this too (or
    // moved inside it), this assertion is what would catch it; a bare
    // "resolves" alone would pass either way.
    expect(mockAutoLinkPRForTask).toHaveBeenCalledTimes(1);
  });

  it('propagates the original error, not the subscriber error, when the bus subscriber throws during a failed move', async () => {
    mockEnsureTaskWorktree.mockRejectedValue(new Error('Worktree setup failed: disk full'));

    const context = makeContext(makeTask());
    context.boardEvents.emitBoardChanged.mockImplementation(() => {
      throw new Error('subscriber exploded');
    });

    // Without the try/catch, the announce block's throw happens inside a
    // `finally`, which would REPLACE the rejection runMove was already
    // propagating - the rollback suite's assertions on the original error
    // message depend on that not happening.
    await expect(
      handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: SPAWNING_TARGET_LANE_ID, targetPosition: 0 },
        'mobile',
      ),
    ).rejects.toThrow('Worktree setup failed');
  });

  it('resolves cleanly when the renderer push throws after a successful bus emit', async () => {
    // Pins that BOTH calls in the announce block are inside the try, not just
    // the first one - a narrowing regression (try around the emit only) would
    // let this throw escape uncaught.
    const context = makeContext(makeTask());
    context.mainWindow.webContents.send.mockImplementation(() => {
      throw new Error('renderer push exploded');
    });

    await expect(
      handleTaskMove(
        context as never,
        { taskId: TASK_ID, targetSwimlaneId: QUIET_TARGET_LANE_ID, targetPosition: 0 },
        'mobile',
      ),
    ).resolves.toBeUndefined();

    expect(context.boardEvents.emitBoardChanged).toHaveBeenCalledTimes(1);
  });
});
