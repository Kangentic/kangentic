/**
 * A column message typed into a LIVE remote agent names the task's attachments where that agent reads them.
 *
 * `handleTaskMove`'s warm injection (src/main/ipc/handlers/task-move.ts) copies the attachments to the host only when
 * the message uses `{{attachments}}` (`templateUsesVar` + `withAttachmentsOnHost`). remote-prompt-paths.test.ts runs the
 * copy itself and transition-engine.test.ts the cold spawn, so neither notices this call going missing: a file attached
 * since the agent started would be named by a path that does not exist on the host.
 *
 * The harness is task-move-message-paste.test.ts's: the same module stubs, a stub automation runner, a mocked turn wait.
 * A message with a line break (and `{{attachments}}` always has one) is pasted after the turn ends, so the text the
 * agent gets is what `terminalSubmit.submitContent` receives.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoCommandMode, Swimlane, Task } from '../../src/shared/types';
import type { TurnCompletionResult } from '../../src/main/transition-engine/turn-completion';
import { setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { setHostAccessLookup, type HostAccess } from '../../src/main/remote/host-transfer';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const hoisted = vi.hoisted(() => ({
  turnWaits: [] as Array<{ resolve: (result: TurnCompletionResult) => void }>,
  columnMessage: { message: '', mode: 'immediate' as AutoCommandMode },
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })),
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  getGlobalDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []) })) })),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => ({
      id: 'rec-main', task_id: 'task-remote-0001', isolated_swimlane_id: null, agent_session_id: 'agent-A', status: 'running',
      started_at: '2026-01-01T00:00:00Z', session_type: 'claude_agent', permission_mode: null, applied_model: null, applied_effort: null,
    }));
    getLatestForTaskByTypeAndIsolation = vi.fn(() => null);
    findByAnyId = vi.fn(() => undefined);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class { static scheduleBackgroundPrune = vi.fn(); } }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({ markRecordExited: vi.fn(), markRecordSuspended: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));
vi.mock('../../src/main/transition-engine/agent-resolver', () => ({ resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(() => undefined) } }));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/agent/shared', async () => {
  const { interpolateTaskTemplate } = await import('../../src/main/agent/shared/template-utils');
  const { resolveTaskTemplateVars } = await import('../../src/main/agent/shared/task-template-resolvers');
  return {
    interpolateTemplate: vi.fn((template: string) => template),
    resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
    execVersion: vi.fn(async () => '1.0.0'),
    interpolateTaskTemplate,
    resolveTaskTemplateVars,
  };
});
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({ reportAutoCommandOutcome: vi.fn() }));
vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: vi.fn(() => new Promise<TurnCompletionResult>((resolve) => { hoisted.turnWaits.push({ resolve }); })),
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({ executeTransition: vi.fn(async () => ({ outcomes: [], failures: [] })) })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  reapTaskLeftovers: vi.fn(async () => {}),
  reportAutomationFailures: vi.fn(),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { abortInFlightMove } from '../../src/main/ipc/handlers/task-move-controllers';
import { supersedeMessageDeliveries } from '../../src/main/automations/turn-end/turn-end-passes';

const TASK_ID = 'task-remote-0001';
const SESSION_ID = 'active-session-1';
const LANE_A = 'lane-a';
const LANE_B = 'lane-b';
const HOST_PROJECT = '/home/dev/proj';

let scratch: string;
let shell: string;
let attachment: string;
let hostAttachment: string;
let hostHolds: Map<string, Buffer>;
let linkDown: boolean;
let hostAsked: number;
let supersededDuringCopy: boolean;

function answer(stdout: string): HostCommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

async function fakeHost(request: HostCommandRequest): Promise<HostCommandResult> {
  hostAsked += 1;
  if (linkDown) throw new Error('the link is down');
  const [, script, , ...args] = request.args;
  if (script.includes('position=0')) {
    if (supersededDuringCopy) abortInFlightMove(TASK_ID);
    return answer(args.map((hostPath, index) => `KG:size:${index + 1}:${hostHolds.get(hostPath)?.length ?? '-'}`).join('\n'));
  }
  const [hostPath, , step] = args;
  if (step === 'first') hostHolds.set(hostPath, Buffer.from(request.stdin ?? '', 'base64'));
  return answer('KG:ok\n');
}

const hostAccess: HostAccess = { hostId: 'host-1', runCommand: fakeHost, pathPresence: vi.fn(), removeFiles: vi.fn(), listeningPorts: vi.fn() };

function makeSwimlane(id: string): Swimlane {
  return {
    id, name: `Lane ${id}`, role: null, position: 0, color: '#888', icon: null, is_archived: false, is_ghost: false,
    permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null,
    model_override: null, effort_override: null, handoff_context: false, session_target: 'main',
    session_spawn_strategy: 'create_or_resume', created_at: '2025-01-01T00:00:00.000Z',
  };
}

function makeTask(swimlaneId: string): Task {
  return {
    id: TASK_ID, display_id: 12, title: 'My Task', description: '', swimlane_id: swimlaneId, position: 0, agent: 'claude',
    session_id: SESSION_ID, worktree_path: path.join(shell, '.kangentic', 'worktrees', '12'), branch_name: 'my-task',
    pr_number: null, pr_url: null, base_branch: null, use_worktree: null, labels: [], priority: 0, attachment_count: 1,
    automations_disabled: false, archived_at: null, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
  };
}

function makeContext() {
  let currentLane = LANE_A;
  const lanes = new Map([LANE_A, LANE_B].map((id) => [id, makeSwimlane(id)]));
  mockGetProjectRepos.mockReturnValue({
    tasks: {
      getById: vi.fn(() => makeTask(currentLane)),
      move: vi.fn((input: { targetSwimlaneId: string }) => { currentLane = input.targetSwimlaneId; }),
      update: vi.fn(),
      list: vi.fn(() => [makeTask(currentLane)]),
      archive: vi.fn(),
    },
    swimlanes: { getById: vi.fn((id: string) => lanes.get(id) ?? null), list: vi.fn(() => [...lanes.values()]) },
    actions: { getTransitionsFor: vi.fn(() => []) },
    automations: {
      listForColumn: vi.fn((laneId: string) => (laneId !== LANE_B ? [] : [{
        id: 'row-first', swimlane_id: laneId, name: 'Message', type: 'send_message', trigger: 'enter', position: 0, enabled: true,
        config: { message: hoisted.columnMessage.message, mode: hoisted.columnMessage.mode }, condition: null, max_runs: null,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      }])),
      getForTrigger: vi.fn(() => []),
    },
    automationRuns: { start: vi.fn(), finish: vi.fn(), recordSkipped: vi.fn() },
    attachments: { deleteByTaskId: vi.fn(), getPathsForTask: vi.fn(() => [attachment]) },
  });
  return {
    currentProjectId: 'proj-test',
    currentProjectPath: shell,
    boardEvents: { emitBoardChanged: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      drainQueue: vi.fn(), columnBlocks: vi.fn(() => false), isResuming: vi.fn(() => false), holdColumnSlot: vi.fn(() => () => undefined),
      removeByTaskId: vi.fn(), killByTaskId: vi.fn(), listSessions: vi.fn(() => []), suspend: vi.fn(async () => {}),
      getSession: vi.fn((id: string) => ({ id, status: 'running' })), awaitInputReady: vi.fn(async () => true),
      findLiveSessionByTaskId: vi.fn(() => null), getUsageCache: vi.fn((): Record<string, unknown> => ({})),
      getFirstReportedEffort: vi.fn((): string | null => null),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' }, agent: { permissionMode: 'acceptEdits' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null), getBoardProfiles: vi.fn(() => []) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent: vi.fn(async () => {}) },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
}

function move(context: unknown): Promise<void> {
  return handleTaskMove(context as never, { taskId: TASK_ID, targetSwimlaneId: LANE_B, targetPosition: 0 }, 'renderer');
}

/** What the agent is handed: the pasted message, once the turn it waits for ends. */
async function pastedText(context: ReturnType<typeof makeContext>): Promise<string> {
  await vi.waitFor(() => expect(hoisted.turnWaits).toHaveLength(1));
  hoisted.turnWaits[0].resolve('completed');
  await vi.waitFor(() => expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1));
  return context.terminalSubmit.submitContent.mock.calls[0][1] as unknown as string;
}

beforeEach(async () => {
  supersedeMessageDeliveries(TASK_ID);
  for (const wait of hoisted.turnWaits) wait.resolve('aborted');
  await Promise.resolve();
  vi.clearAllMocks();
  hoisted.turnWaits.length = 0;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'task-move-remote-attachments-'));
  shell = path.join(scratch, 'shell');
  const directory = path.join(shell, '.kangentic', 'tasks', TASK_ID, 'attachments');
  fs.mkdirSync(directory, { recursive: true });
  attachment = path.join(directory, 'shot.png');
  fs.writeFileSync(attachment, Buffer.from([1, 2, 3, 0, 255]));
  hostAttachment = `${HOST_PROJECT}/.kangentic/tasks/${TASK_ID}/attachments/shot.png`;
  hostHolds = new Map();
  linkDown = false;
  hostAsked = 0;
  supersededDuringCopy = false;
  setRemoteProjectLookup((projectPath) => (projectPath === shell ? { hostId: 'host-1', path: HOST_PROJECT } : null));
  setHostAccessLookup(() => hostAccess);
});

afterEach(() => {
  setRemoteProjectLookup(null);
  setHostAccessLookup(null);
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('a column message typed into a live remote agent', () => {
  // Without the copy the agent is handed a host path to a file that was attached after it started and is not there.
  it('copies the attachments to the host first when it uses {{attachments}}, and names the host path', async () => {
    hoisted.columnMessage.message = 'Review the screenshot:{{attachments}}';
    const context = makeContext();

    await move(context);
    const text = await pastedText(context);

    expect(hostHolds.get(hostAttachment)).toEqual(Buffer.from([1, 2, 3, 0, 255]));
    expect(text).toContain(hostAttachment);
  });

  // Without the note the agent is told to read a path that names nothing.
  it('names a file that did not reach the host instead of its path, and still delivers', async () => {
    linkDown = true;
    hoisted.columnMessage.message = 'Review the screenshot:{{attachments}}';
    const context = makeContext();

    await move(context);
    const text = await pastedText(context);

    expect(text).toContain('(Not copied to this host, so not readable here: shot.png.');
    expect(text).not.toContain(hostAttachment);
    expect(text).toContain('Review the screenshot:');
  });

  // Without the check a replaced move tells the agent its files ran out of time, and then the newer column's message lands too.
  it('delivers nothing when a newer move replaces it during the copy', async () => {
    supersededDuringCopy = true;
    hoisted.columnMessage.message = 'Review the screenshot:{{attachments}}';
    const context = makeContext();

    await move(context);

    expect(hostHolds.size).toBe(0);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(hoisted.turnWaits).toHaveLength(0);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  // Without the gate every warm message would pay a round trip to the host for attachments it never mentions.
  it('asks the host nothing when it does not use {{attachments}}', async () => {
    hoisted.columnMessage.message = '/code-review';
    const context = makeContext();

    await move(context);

    await vi.waitFor(() => expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1));
    expect(hostAsked).toBe(0);
    expect(hostHolds.size).toBe(0);
  });
});
