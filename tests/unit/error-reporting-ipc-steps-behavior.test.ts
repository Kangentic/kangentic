/**
 * What a user loses if these reports go quiet: a step inside an IPC handler or one
 * of its helpers that fails and is caught keeps the handler answering, so nothing
 * reaches the IPC wrap and nothing reaches Sentry. A task report with no usage, an
 * Earlier list that comes back empty, a finished task whose windows stay open, a
 * spare worktree claimed with links into a deleted folder: each would look like a
 * quiet day.
 *
 * Each case runs the real module, makes one dependency throw a code defect (a
 * TypeError whose message carries text a user could have written), and reads the
 * call that reached `reportHandledError`: its source, its `area` and `step` tags,
 * and the fixed message. Where the catch guards an expected outcome, a second case
 * pins that the expected outcome sends nothing. The sites that used to swallow a
 * failure and then destroy something also pin what they do now.
 *
 * Modules are imported per test (`vi.resetModules`) because each reporter latches a
 * key once per run, and each test installs only the mocks its module needs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { IPC } from '../../src/shared/ipc-channels';
import { reportedFailures, type ReportedFailure } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

/** Text a user could have written, which must never leave with a report. */
const USER_TEXT = 'Fix Acme billing export';

function defect(): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
}

/** What the retrieval client rejects with while its worker is down: an expected class. */
function workerDown(): Error {
  return Object.assign(new Error('The retrieval worker exited'), { name: 'RetrievalUnavailableError' });
}

const installedMockPaths = new Set<string>();

/** doMock each path, remembering it so the test's teardown can unmock it. */
function installMocks(factories: Record<string, () => unknown>): void {
  for (const [modulePath, factory] of Object.entries(factories)) {
    installedMockPaths.add(modulePath);
    vi.doMock(modulePath, factory);
  }
}

type ReportedCall = ReportedFailure;

function reportedCalls(): ReportedCall[] {
  return reportedFailures(reportHandledError);
}

function stepReports(): ReportedCall[] {
  return reportedCalls().filter((call) => call.tags.source === 'handler_step');
}

/** One `handler_step` report went out, under this area and step, carrying no user text. */
function expectOnlyStepReport(area: string, step: string, errorName = 'TypeError'): void {
  const calls = stepReports();
  expect(calls).toHaveLength(1);
  expect(calls[0].tags).toMatchObject({ source: 'handler_step', area, step, error_name: errorName });
  expect(calls[0].sent.message).toBe(`Handled handler_step failure: ${errorName}`);
  expect(JSON.stringify(calls[0].tags)).not.toMatch(/acme/i);
}

const temporaryFolders: string[] = [];

function makeTemporaryFolder(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryFolders.push(folder);
  return folder;
}

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const modulePath of installedMockPaths) vi.doUnmock(modulePath);
  installedMockPaths.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const folder of temporaryFolders.splice(0)) {
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------
// The guard for a catch whose common failure is another program's plain Error
// ---------------------------------------------------------------------------

describe('isDefectOrEnvironmentFailure', () => {
  const failures: Array<{ name: string; error: unknown; expected: boolean }> = [
    { name: 'a TypeError', error: new TypeError('x'), expected: true },
    { name: 'a RangeError', error: new RangeError('x'), expected: true },
    { name: 'a ReferenceError', error: new ReferenceError('x'), expected: true },
    { name: 'an errno', error: Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' }), expected: true },
    { name: 'a SQLite code', error: Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }), expected: true },
    { name: 'a plain Error, as an agent CLI that exited throws', error: new Error('the agent exited 1'), expected: false },
    { name: 'a thrown string', error: 'the chat ended', expected: false },
  ];

  it.each(failures)('answers for $name', async ({ error, expected }) => {
    const { isDefectOrEnvironmentFailure } = await import('../../src/main/ipc/helpers/handler-step-report');
    expect(isDefectOrEnvironmentFailure(error)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Helpers that take their dependencies as arguments
// ---------------------------------------------------------------------------

describe('queued conversation-expired notices', () => {
  const notices = [{ projectId: 'project-1', taskId: 'task-aaa00001' }];

  it('keeps every notice and reports when the board read throws', async () => {
    const { keepNoticesForLiveTasks } = await import('../../src/main/ipc/helpers/pending-conversation-expired');

    const kept = keepNoticesForLiveTasks(notices as never, () => { throw defect(); });

    expect(kept).toEqual(notices);
    expectOnlyStepReport('spawn', 'expired_notice_filter');
  });

  it('sends nothing more for a database the open-failure notifier already reported', async () => {
    const { keepNoticesForLiveTasks } = await import('../../src/main/ipc/helpers/pending-conversation-expired');
    const { markReported } = await import('../../src/main/analytics/handled-report');
    const openFailure = new Error('unable to open database file');
    markReported(openFailure);

    expect(keepNoticesForLiveTasks(notices as never, () => { throw openFailure; })).toEqual(notices);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('tool breakdown repair', () => {
  async function seededDatabase(): Promise<Database.Database> {
    const { TOOL_BREAKDOWN_REPAIR_FLAG, TOOL_BREAKDOWN_REPAIR_RETRY } = await import('../../src/main/ipc/helpers/tool-breakdown-repair');
    const database = new Database(':memory:');
    runProjectMigrations(database);
    database.prepare('DELETE FROM schema_meta WHERE key = ?').run(TOOL_BREAKDOWN_REPAIR_FLAG);
    database.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(TOOL_BREAKDOWN_REPAIR_RETRY, JSON.stringify(['record-1']));
    return database;
  }

  it('reports a replay batch that throws and leaves the repair to the next open', async () => {
    const database = await seededDatabase();
    const { repairToolBreakdownDurations, toolBreakdownRepairRan } = await import('../../src/main/ipc/helpers/tool-breakdown-repair');

    const result = await repairToolBreakdownDurations(database, '/mock/sessions', async () => { throw defect(); });

    expect(result).toMatchObject({ completed: false, scanned: 0, repaired: 0 });
    expect(toolBreakdownRepairRan(database)).toBe(false);
    expectOnlyStepReport('session_metrics', 'tool_breakdown_batch');
    database.close();
  });

  it('does not report a worker that is down', async () => {
    const database = await seededDatabase();
    const { repairToolBreakdownDurations } = await import('../../src/main/ipc/helpers/tool-breakdown-repair');

    const result = await repairToolBreakdownDurations(database, '/mock/sessions', async () => { throw workerDown(); });

    expect(result.completed).toBe(false);
    expect(reportHandledError).not.toHaveBeenCalled();
    database.close();
  });

  it('reports a flag write that fails after the rows were patched', async () => {
    const database = await seededDatabase();
    const { repairToolBreakdownDurations } = await import('../../src/main/ipc/helpers/tool-breakdown-repair');

    const result = await repairToolBreakdownDurations(database, '/mock/sessions', async () => {
      // The table the flag is written to goes while the batch is being replayed.
      database.exec('DROP TABLE schema_meta');
      return { breakdowns: {}, unreadable: [] };
    });

    expect(result).toMatchObject({ completed: false, scanned: 1 });
    expectOnlyStepReport('session_metrics', 'tool_breakdown_flag', 'SqliteError');
    database.close();
  });
});

describe('auto command outcome', () => {
  it('reports a record write that throws and still sends the notice', async () => {
    const { reportAutoCommandOutcome } = await import('../../src/main/ipc/helpers/auto-command-outcome');
    const send = vi.fn();
    const context = { currentProjectId: 'project-1', mainWindow: { isDestroyed: () => false, webContents: { send } } };
    const tasks = { recordAutoCommandOutcome: vi.fn(() => { throw defect(); }) };

    reportAutoCommandOutcome(
      context as never,
      tasks as never,
      { id: 'task-aaa00001', title: USER_TEXT },
      { outcome: 'failed', commands: ['/review'], reason: 'no prompt', interruptedTurn: false, escalated: false } as never,
      'project-1',
    );

    expectOnlyStepReport('spawn', 'auto_command_record');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('task write announcements', () => {
  it('reports a board listener that throws, without failing the write', async () => {
    const { announceTaskBoardChange } = await import('../../src/main/ipc/helpers/task-write-announce');
    const context = { boardEvents: { emitBoardChanged: vi.fn(() => { throw defect(); }) } };

    expect(() => announceTaskBoardChange(context as never, 'project-1', { change: 'tasks', ids: ['task-aaa00001'] } as never)).not.toThrow();

    expectOnlyStepReport('announce', 'board_listener');
  });

  it('reports a send to the main window that throws', async () => {
    installMocks({
      '../../src/main/ipc/send-to-renderer': () => ({ sendToRenderer: vi.fn(() => { throw defect(); }) }),
    });
    const { announceToMainWindow } = await import('../../src/main/ipc/helpers/task-write-announce');
    const context = { mainWindow: { isDestroyed: () => false, webContents: { id: 1 } } };
    const popOutSender = { isDestroyed: () => false, id: 2 };

    expect(() => announceToMainWindow(context as never, { sender: popOutSender } as never, 'project-1')).not.toThrow();

    expectOnlyStepReport('announce', 'renderer_send');
  });
});

describe('MCP connection watch', () => {
  async function startWatch(check: () => Promise<unknown>) {
    const { McpConnectionWatch } = await import('../../src/main/ipc/helpers/mcp-connection-watch');
    const sessions = Object.assign(new EventEmitter(), {
      getSessionAgentName: () => 'claude',
      getSession: () => ({ projectId: 'project-1' }),
      getSessionCliTarget: () => null,
    });
    const notify = vi.fn();
    new McpConnectionWatch({ sessions: sessions as never, isEnabled: () => true, check: check as never, notify }).start();
    return { sessions, notify };
  }

  it('reports a check that cannot run because of a defect', async () => {
    const check = vi.fn(async () => { throw defect(); });
    const { sessions, notify } = await startWatch(check);

    sessions.emit('first-output', 'session-1');

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expectOnlyStepReport('mcp_watch', 'session_start_check');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not report a probe program that failed with a plain Error', async () => {
    const check = vi.fn(async () => { throw new Error('the distro did not answer'); });
    const { sessions } = await startWatch(check);

    sessions.emit('first-output', 'session-1');

    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('Command Terminal history', () => {
  const row = {
    agent_session_id: 'agent-session-1',
    agent_name: 'claude',
    cwd: '/mock/project',
    cli_target: null,
    ended_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  async function makeHistory(repository: Record<string, unknown>, conversationAvailable = true) {
    const { CommandTerminalHistory } = await import('../../src/main/ipc/helpers/command-terminal-history');
    const conversationEnded = vi.fn();
    const history = new CommandTerminalHistory({
      sessionManager: { listSessions: () => [] } as never,
      getRepository: () => repository as never,
      conversationAvailable: async () => conversationAvailable,
      notifyChanged: vi.fn(),
      conversationEnded,
      searchText: vi.fn(),
    });
    return { history, conversationEnded };
  }

  it('reports a list read that throws and answers an empty Earlier list', async () => {
    const { history } = await makeHistory({ deleteUnusedExcept: vi.fn(() => { throw defect(); }), listUsed: vi.fn(() => []) });

    await expect(history.list('project-1')).resolves.toEqual([]);

    expectOnlyStepReport('command_terminal', 'history_list');
  });

  it('reports a row read that throws and answers that the conversation is gone', async () => {
    const { history } = await makeHistory({ get: vi.fn(() => { throw defect(); }) });

    expect(history.find('project-1', 'agent-session-1')).toBeNull();

    expectOnlyStepReport('command_terminal', 'history_find');
  });

  it('reports a guarded write that throws and goes on with the list', async () => {
    const { history, conversationEnded } = await makeHistory({
      deleteUnusedExcept: vi.fn(),
      listUsed: vi.fn(() => [row]),
      delete: vi.fn(() => { throw defect(); }),
    }, false);

    // The row's transcript is gone, so the list drops it: the delete is the write that throws.
    await expect(history.list('project-1')).resolves.toEqual([]);

    expectOnlyStepReport('command_terminal', 'history_write');
    expect(conversationEnded).toHaveBeenCalledWith('project-1', 'agent-session-1');
  });
});

// ---------------------------------------------------------------------------
// Helpers whose dependencies are imported modules
// ---------------------------------------------------------------------------

describe('closing a finished task\'s windows', () => {
  it('reports a close that throws and still forgets the agent\'s browser control', async () => {
    const forgetAgentControl = vi.fn();
    installMocks({
      '../../src/main/pop-out/pop-out-window-manager': () => ({
        popOutWindowManager: { closeForTask: vi.fn(() => { throw defect(); }), listOpenKeys: vi.fn(() => []) },
      }),
      '../../src/main/browser/browser-lane-manager': () => ({ destroyLanesForTask: vi.fn(() => 0) }),
      '../../src/main/browser/passkey-guard': () => ({ forgetAgentControl }),
    });
    const { closeTaskWindows } = await import('../../src/main/ipc/helpers/task-windows');

    expect(() => closeTaskWindows('project-1', 'task-aaa00001')).not.toThrow();

    expect(forgetAgentControl).toHaveBeenCalledWith('project-1', 'task-aaa00001');
    expectOnlyStepReport('task_windows', 'close_windows');
  });
});

describe('openPathBounded', () => {
  it('reports an openPath that rejects, and answers its message rather than success', async () => {
    const rejection = new TypeError('openPath is not a function');
    installMocks({ electron: () => ({ shell: { openPath: vi.fn(() => Promise.reject(rejection)) } }) });
    const { openPathBounded } = await import('../../src/main/ipc/helpers/open-path');

    await expect(openPathBounded('/mock/file.txt')).resolves.toBe('openPath is not a function');

    expectOnlyStepReport('system', 'open_path_rejected');
  });

  it('reports a rejection that lands after the timeout answered, once', async () => {
    vi.useFakeTimers();
    let rejectOpen: (reason: Error) => void = () => undefined;
    const pendingOpen = new Promise<string>((_resolve, reject) => { rejectOpen = reject; });
    installMocks({ electron: () => ({ shell: { openPath: vi.fn(() => pendingOpen) } }) });
    const { openPathBounded } = await import('../../src/main/ipc/helpers/open-path');

    const answer = openPathBounded('/mock/file.txt', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(answer).resolves.toBe('');
    expect(reportHandledError).not.toHaveBeenCalled();

    rejectOpen(defect());
    await vi.advanceTimersByTimeAsync(0);

    expectOnlyStepReport('system', 'open_path_rejected');
  });
});

describe('PTY grid persistence', () => {
  it('reports a grid write that throws', async () => {
    installMocks({
      '../../src/main/db/database': () => ({ getOpenProjectDb: vi.fn(() => { throw defect(); }) }),
    });
    const { persistPtyGrid } = await import('../../src/main/ipc/handlers/session-grid-persistence');
    const context = { sessionManager: { getSessionProjectId: () => 'project-1', getSession: () => undefined } };

    expect(() => persistPtyGrid(context as never, 'session-1', { cols: 120, rows: 40 }, 'desktop' as never)).not.toThrow();

    expectOnlyStepReport('session_metrics', 'pty_grid_write');
  });
});

describe('background call sink', () => {
  it('reports a project read that throws and records nothing', async () => {
    const record = vi.fn();
    installMocks({
      '../../src/main/ipc/helpers/project-repos': () => ({ getProjectRepos: vi.fn(() => ({ backgroundCalls: { record } })) }),
    });
    const { backgroundCallSink } = await import('../../src/main/ipc/helpers/background-call-sink');
    const context = { projectRepo: { getById: vi.fn(() => { throw defect(); }) } };

    expect(() => backgroundCallSink(context as never)('project-1', {} as never)).not.toThrow();

    expect(record).not.toHaveBeenCalled();
    expectOnlyStepReport('projects', 'background_call_project_read');
  });
});

describe('hiding a project with its SSH host', () => {
  it('reports a task that could not be suspended and goes on with the rest', async () => {
    const endWorkflowAgentsOfProject = vi.fn(async () => undefined);
    installMocks({
      '../../src/main/git/git-fetch-scheduler': () => ({ gitFetchScheduler: { stop: vi.fn() } }),
      '../../src/main/pr/pr-refresh-scheduler': () => ({ prRefreshScheduler: { stop: vi.fn() } }),
      '../../src/main/retrieval/retrieval-service': () => ({ retrievalService: { stop: vi.fn(), reconcileEmbedWorker: vi.fn() } }),
      '../../src/main/workflows/workflow-agent': () => ({ endWorkflowAgentsOfProject }),
      '../../src/main/workflows/workflow-hidden-project': () => ({ pauseWorkflowsOfProject: vi.fn(async () => undefined) }),
      '../../src/main/ipc/handlers/command-terminal-restore': () => ({ forgetCommandTerminalRestore: vi.fn() }),
      '../../src/main/ipc/handlers/session-pause': () => ({ pauseTaskSession: vi.fn(async () => { throw defect(); }) }),
      '../../src/main/ipc/helpers/task-windows': () => ({ closeProjectTaskWindows: vi.fn() }),
    });
    const { suspendProjectForHiding } = await import('../../src/main/ipc/helpers/hide-project');
    const context = { sessionManager: { listSessions: () => [], endCommandTerminal: vi.fn() } };
    const project = { id: 'project-1', name: USER_TEXT };

    await expect(suspendProjectForHiding(context as never, project as never, () => [{ id: 'task-aaa00001' }])).resolves.toBeUndefined();

    expectOnlyStepReport('projects', 'hide_suspend');
    expect(endWorkflowAgentsOfProject).toHaveBeenCalledTimes(1);
  });
});

describe('a resume that found no conversation', () => {
  it('reports a mark that throws and leaves the retry to the listener', async () => {
    installMocks({
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { get: vi.fn() } }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
    });
    const { markResumeMiss } = await import('../../src/main/ipc/helpers/resume-miss');
    const context = {
      sessionManager: { launchOutputClass: vi.fn(async () => { throw defect(); }), getSessionAgentName: vi.fn() },
      projectRepo: { getById: vi.fn() },
    };

    await expect(markResumeMiss(context as never, { sessionId: 'session-1', taskId: 'task-aaa00001', projectId: 'project-1' })).resolves.toBe('not_a_miss');

    expectOnlyStepReport('session_resume', 'resume_miss_mark');
  });
});

describe('the completed task view\'s index reads', () => {
  const retrievalCall = vi.fn();

  function installTaskReportMocks(): void {
    retrievalCall.mockReset();
    installMocks({
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/session-repository': () => ({
        SessionRepository: class {
          getLatestAgentSessionForTask() {
            return { session_type: 'claude_agent', agent_session_id: 'agent-session-1', cwd: '/mock/project', cli_target: null, transcript_path: null };
          }
          listTaskReportRecords() { return []; }
          getSummaryForTask() { return null; }
        },
      }),
      '../../src/main/retrieval/retrieval-client': () => ({ retrievalClient: { call: retrievalCall } }),
      '../../src/main/retrieval/remote-targets': () => ({ collectRemoteTargets: () => [] }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: {} }),
      '../../src/main/ipc/helpers/project-repos': () => ({
        getProjectRepos: () => ({
          automationRuns: { listForTask: () => [] },
          automations: { listAll: () => [] },
          swimlanes: { list: () => [] },
          taskMoves: { listForTask: () => [] },
          backgroundCalls: { listForTask: () => [] },
        }),
      }),
      '../../src/main/ipc/helpers/task-report-assemble': () => ({
        assembleTaskReport: (input: unknown) => input,
        assembleTaskRoute: vi.fn(),
      }),
    });
  }

  it('reports a last-message read that throws and shows no closing message', async () => {
    installTaskReportMocks();
    retrievalCall.mockRejectedValue(defect());
    const { readTaskLastMessage } = await import('../../src/main/ipc/helpers/task-report');

    await expect(readTaskLastMessage('project-1', 'task-aaa00001')).resolves.toBeNull();

    expectOnlyStepReport('transcripts', 'task_last_message_read');
  });

  it('does not report a last-message read while the worker is down', async () => {
    installTaskReportMocks();
    retrievalCall.mockRejectedValue(workerDown());
    const { readTaskLastMessage } = await import('../../src/main/ipc/helpers/task-report');

    await expect(readTaskLastMessage('project-1', 'task-aaa00001')).resolves.toBeNull();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports the report\'s index reads once and still assembles the report without them', async () => {
    installTaskReportMocks();
    retrievalCall.mockImplementation(async () => { throw defect(); });
    const { readTaskReport } = await import('../../src/main/ipc/helpers/task-report');
    const context = { configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true } }) } };

    const report = await readTaskReport(context as never, 'project-1', 'task-aaa00001') as unknown as { ledger: unknown; knowledge: unknown };

    expect(retrievalCall).toHaveBeenCalledTimes(3);
    expect(report.ledger).toBeNull();
    expect(report.knowledge).toBeNull();
    expectOnlyStepReport('transcripts', 'task_report_index_read');
  });
});

// ---------------------------------------------------------------------------
// Spare worktrees
// ---------------------------------------------------------------------------

describe('spare worktrees', () => {
  it('reports a task read that fails, and sweeps nothing', async () => {
    const projectPath = makeTemporaryFolder('kangentic-spares-');
    const { discardProjectSpares } = await import('../../src/main/ipc/helpers/spare-worktrees');
    const pool = { stop: vi.fn(async () => undefined), sweep: vi.fn(async () => undefined) };
    const tasks = { list: () => { throw defect(); }, listArchived: () => [] };

    await expect(discardProjectSpares({ spareWorktrees: pool } as never, projectPath, tasks as never)).resolves.toBeUndefined();

    // What stays on disk is pinned on real spares by spare-worktree-pool-lifecycle.test.ts.
    expect(pool.sweep).not.toHaveBeenCalled();
    expectOnlyStepReport('spares', 'referenced_folders_read');
  });

  it('reports a startup pass whose settings read throws, and skips the sweep', async () => {
    const projectPath = makeTemporaryFolder('kangentic-spares-');
    const { sweepSpareWorktreesAtOpen } = await import('../../src/main/ipc/helpers/spare-worktrees');
    const pool = { stop: vi.fn(), sweep: vi.fn(async () => undefined) };
    const context = { spareWorktrees: pool, configManager: { getEffectiveConfig: () => { throw defect(); } } };

    expect(() => sweepSpareWorktreesAtOpen(context as never, { projectPath } as never, { list: () => [], listArchived: () => [] } as never)).not.toThrow();

    expect(pool.sweep).not.toHaveBeenCalled();
    expectOnlyStepReport('spares', 'sweep_inputs_read');
  });

  it('reports a startup sweep that rejects', async () => {
    const projectPath = makeTemporaryFolder('kangentic-spares-');
    const { sweepSpareWorktreesAtOpen } = await import('../../src/main/ipc/helpers/spare-worktrees');
    const pool = { stop: vi.fn(), sweep: vi.fn(async () => { throw defect(); }) };
    const context = { spareWorktrees: pool, configManager: { getEffectiveConfig: () => ({ git: { worktreesEnabled: false } }) } };

    sweepSpareWorktreesAtOpen(context as never, { projectPath } as never, { list: () => [], listArchived: () => [] } as never);

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expectOnlyStepReport('spares', 'startup_sweep');
  });
});

// ---------------------------------------------------------------------------
// The leftover reap: a throw around the host's reap answers "nothing known"
// ---------------------------------------------------------------------------

describe('reapTaskLeftovers', () => {
  it('reports a reap that throws and answers that no task is known to have left a process', async () => {
    installMocks({
      '../../src/main/git/worktree-manager': () => ({ WorktreeManager: class {}, prepareWorktreeForRemoval: vi.fn(), GitQueuePriority: {} }),
      '../../src/main/git/worktree-creation-registry': () => ({ waitForWorktreeCreation: vi.fn() }),
      '../../src/main/git/removed-worktrees': () => ({ scheduleRemovedWorktreeDeletion: vi.fn() }),
      '../../src/main/git/worktree-head': () => ({ readWorktreeHead: vi.fn() }),
      '../../src/main/ipc/handlers/git-stats-capture': () => ({ waitForChurnRead: vi.fn() }),
      '../../src/main/db/database': () => ({ getOpenProjectDb: vi.fn(() => null), getProjectDb: vi.fn() }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: {} }),
      '../../src/main/agent/shared/wsl-distro': () => ({ isWslDistroRunning: vi.fn(), resolveWslDistroFacts: vi.fn() }),
      '../../src/main/ipc/helpers/project-repos': () => ({ getProjectRepos: vi.fn() }),
      '../../src/main/transition-engine/resume-id-reconcile': () => ({ backgroundSessionHoldingConversation: vi.fn() }),
      '../../src/main/ipc/helpers/session-folders': () => ({ removeSessionFolders: vi.fn() }),
      '../../src/main/ipc/helpers/task-windows': () => ({ closeTaskWindows: vi.fn() }),
      '../../src/main/stop-script/terminal-stop': () => ({ stopBeforeReap: vi.fn(async () => undefined) }),
      '../../src/main/browser/annotation-drafts': () => ({ discardAnnotationDraft: vi.fn() }),
      '../../src/devtools/main/worktree-preview-stop': () => ({ stopWorktreePreviews: vi.fn() }),
      '../../src/main/accounts/account-background-stop': () => ({ stopBackgroundSessionOnAccount: vi.fn() }),
    });
    const { reapTaskLeftovers } = await import('../../src/main/ipc/helpers/task-cleanup');
    const { NOTHING_LEFT_RUNNING } = await import('../../src/main/ipc/helpers/reap-verdict');
    const reapTaskProcesses = vi.fn(async () => { throw defect(); });
    const context = {
      configManager: { load: () => ({}), getEffectiveConfig: () => ({ agent: { cliPaths: {} } }) },
      projectRepo: { list: () => [] },
      sessionManager: { reapTaskProcesses, listProcesses: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    };

    const verdict = await reapTaskLeftovers(
      context as never,
      null,
      [{ id: 'task-aaa00001', worktree_path: null, title: USER_TEXT }],
      { skipStopScript: true },
    );

    expect(reapTaskProcesses).toHaveBeenCalledTimes(1);
    expect(verdict).toBe(NOTHING_LEFT_RUNNING);
    expectOnlyStepReport('task_cleanup', 'leftover_reap');
  });
});

// ---------------------------------------------------------------------------
// Project delete: what a failed read keeps on disk
// ---------------------------------------------------------------------------

describe('project delete', () => {
  const PROJECT_ID = 'project-1';
  const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'error-report-project-delete'));
  const KANGENTIC_DIR = path.join(PROJECT_PATH, '.kangentic');
  const WORKTREES_DIR = path.join(KANGENTIC_DIR, 'worktrees');

  interface DeleteHarness {
    existingPaths: Set<string>;
    removedPaths: string[];
    listWorktrees: () => string[];
    listTasks: () => unknown[];
    removeFolder: (target: string) => void;
    detachWorkflows: () => void;
    removedCopyHoldsLink: boolean;
  }

  function makeHarness(): DeleteHarness {
    return {
      existingPaths: new Set([PROJECT_PATH, KANGENTIC_DIR]),
      removedPaths: [],
      listWorktrees: () => [],
      listTasks: () => [],
      removeFolder: () => undefined,
      detachWorkflows: () => undefined,
      removedCopyHoldsLink: false,
    };
  }

  function missingFile(): NodeJS.ErrnoException {
    return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  }

  /** The mock graph follows project-delete-removed-worktrees.test.ts, which drives the same function. */
  async function loadCleanupProject(harness: DeleteHarness) {
    installMocks({
      electron: () => ({ ipcMain: { handle: vi.fn() } }),
      '../../src/main/git/original-fs': () => ({
        default: {
          existsSync: vi.fn((target: string) => harness.existingPaths.has(target)),
          unlinkSync: vi.fn(() => { throw missingFile(); }),
          readdirSync: vi.fn((target: string) => {
            if (target === WORKTREES_DIR) return harness.listWorktrees();
            throw missingFile();
          }),
          rmSync: vi.fn((target: string) => {
            harness.removeFolder(target);
            harness.removedPaths.push(target);
          }),
        },
      }),
      '../../src/main/git/removed-worktrees': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/removed-worktrees')>('../../src/main/git/removed-worktrees')),
        deleteRemovedWorktreesNow: vi.fn(async () => harness.removedCopyHoldsLink),
      }),
      '../../src/main/ipc/helpers/spare-worktrees': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/spare-worktrees')>('../../src/main/ipc/helpers/spare-worktrees')),
        discardProjectSpares: vi.fn(async () => undefined),
      }),
      '../../src/main/git/worktree-links': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/worktree-links')>('../../src/main/git/worktree-links')),
        clearWorktreeLinks: vi.fn(async () => true),
      }),
      '../../src/main/ipc/handlers/project-relocate': () => ({ relocateProject: vi.fn() }),
      '../../src/main/transition-engine/session-startup': () => ({
        resumeSuspendedSessions: vi.fn(async () => undefined),
        autoSpawnTasks: vi.fn(async () => undefined),
      }),
      '../../src/main/transition-engine/resource-cleanup': () => ({
        cleanupStaleResourcesAsync: vi.fn(async () => undefined),
        sweepAutomationRuns: vi.fn(() => 0),
      }),
      '../../src/main/git/worktree-manager': () => ({
        WorktreeManager: class {
          static clearQueue = vi.fn();
          withLock = async (job: () => Promise<unknown>) => job();
          removeWorktree = async () => true;
        },
        prepareWorktreeForRemoval: vi.fn(async () => undefined),
      }),
      '../../src/main/git/git-checks': () => ({
        isGitRepo: vi.fn(() => false),
        isInsideWorktree: vi.fn(() => false),
        isKangenticWorktree: vi.fn(() => false),
      }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { list: vi.fn(() => []), get: vi.fn(), getOrThrow: vi.fn() } }),
      '../../src/main/db/database': () => ({
        getProjectDb: vi.fn(() => ({})),
        getExistingProjectDb: vi.fn(() => ({})),
        closeProjectDb: vi.fn(),
      }),
      '../../src/main/config/apply-runtime-config': () => ({ applyRuntimeConfig: vi.fn() }),
      '../../src/main/ipc/helpers': () => ({
        ensureGitignore: vi.fn(async () => undefined),
        reapTaskLeftovers: vi.fn(async () => ({ tasksLeftRunningInWorktree: new Set<string>() })),
        leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => true, onReport: () => undefined })),
      }),
      '../../src/main/ipc/helpers/task-windows': () => ({ closeTaskWindows: vi.fn(), closeProjectTaskWindows: vi.fn() }),
      '../../src/main/ipc/helpers/project-entry-search': () => ({ searchProjectEntries: vi.fn() }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn() }),
      '../../src/main/shutdown-state': () => ({ isShuttingDown: vi.fn(() => false) }),
      '../../src/main/diagnostics/project-log-context': () => ({
        runWithProjectLogContext: vi.fn((_name: string, work: () => unknown) => work()),
      }),
      '../../src/main/pr/pr-refresh-scheduler': () => ({ prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() } }),
      '../../src/main/git/git-fetch-scheduler': () => ({ gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() } }),
      '../../src/main/retrieval/retrieval-service': () => ({
        retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
      }),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: {
          call: vi.fn(async () => ({ breakdowns: {}, unreadable: [] })),
          closeProject: vi.fn(async () => undefined),
        },
      }),
      '../../src/main/ipc/helpers/tool-breakdown-repair': () => ({
        repairToolBreakdownDurations: vi.fn(async () => ({ completed: true, scanned: 0, repaired: 0, unreadable: 0 })),
      }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class { list = () => []; } }),
      '../../src/main/db/repositories/task-repository': () => ({
        TaskRepository: class {
          list = () => harness.listTasks();
          listArchived = () => [];
          countAll = () => 0;
        },
      }),
      '../../src/main/workflows/workflow-project-delete': () => ({
        detachProjectFromWorkflows: vi.fn(() => harness.detachWorkflows()),
      }),
      '../../src/main/workflows/workflow-agent': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/workflows/workflow-agent')>('../../src/main/workflows/workflow-agent')),
        endWorkflowAgentsOfProject: vi.fn(async () => undefined),
      }),
    });
    const { cleanupProject } = await import('../../src/main/ipc/handlers/projects');
    const context = {
      boardConfigManager: { detach: vi.fn() },
      sessionManager: {
        closeProjectInPtyHost: vi.fn(async () => undefined),
        kill: vi.fn(),
        awaitExit: vi.fn(async () => undefined),
        remove: vi.fn(),
        removeByTaskId: vi.fn(async () => undefined),
        listSessions: vi.fn(() => []),
      },
      currentProjectId: null,
      currentProjectPath: null,
      recoveredProjects: new Set<string>(),
      snapshottedProjects: new Set<string>(),
    };
    return () => cleanupProject(context as never, PROJECT_ID, PROJECT_PATH);
  }

  it('leaves .kangentic on disk and reports when the worktree folders cannot be listed', async () => {
    const harness = makeHarness();
    harness.existingPaths.add(WORKTREES_DIR);
    harness.listWorktrees = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
    const cleanup = await loadCleanupProject(harness);

    await cleanup();

    // Before, the failed listing read as "no worktrees" and the recursive delete ran,
    // following any link an unlisted worktree still held.
    expect(harness.removedPaths).not.toContain(KANGENTIC_DIR);
    expectOnlyStepReport('projects', 'delete_links_unreadable', 'Error');
  });

  it('removes .kangentic and reports nothing when the worktree folder went before the listing', async () => {
    const harness = makeHarness();
    harness.existingPaths.add(WORKTREES_DIR);
    harness.listWorktrees = () => { throw missingFile(); };
    const cleanup = await loadCleanupProject(harness);

    await cleanup();

    expect(harness.removedPaths).toContain(KANGENTIC_DIR);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('leaves .kangentic on disk when a set-aside copy that may hold a link is still there', async () => {
    const harness = makeHarness();
    harness.removedCopyHoldsLink = true;
    const cleanup = await loadCleanupProject(harness);

    await cleanup();

    expect(harness.removedPaths).not.toContain(KANGENTIC_DIR);
    // The deleter reports its own failed delete: this site only keeps the folder.
    expect(stepReports()).toHaveLength(0);
  });

  it('reports a task read that throws and still finishes the delete', async () => {
    const harness = makeHarness();
    harness.listTasks = () => { throw defect(); };
    const cleanup = await loadCleanupProject(harness);

    await expect(cleanup()).resolves.toBeUndefined();

    expect(harness.removedPaths).toContain(KANGENTIC_DIR);
    expectOnlyStepReport('projects', 'delete_tasks_read');
  });

  it('reports a workflow detach that throws and still finishes the delete', async () => {
    const harness = makeHarness();
    harness.detachWorkflows = () => { throw defect(); };
    const cleanup = await loadCleanupProject(harness);

    await expect(cleanup()).resolves.toBeUndefined();

    expect(harness.removedPaths).toContain(KANGENTIC_DIR);
    expectOnlyStepReport('projects', 'workflow_detach');
  });

  it('reports a .kangentic removal that throws', async () => {
    const harness = makeHarness();
    harness.removeFolder = (target) => { if (target === KANGENTIC_DIR) throw defect(); };
    const cleanup = await loadCleanupProject(harness);

    await expect(cleanup()).resolves.toBeUndefined();

    expectOnlyStepReport('projects', 'delete_kangentic_folder');
  });
});

// ---------------------------------------------------------------------------
// Handlers that answer with the failure instead of rejecting
// ---------------------------------------------------------------------------

type CapturedHandler = (...handlerArguments: unknown[]) => unknown;

/** An `electron` mock whose `ipcMain.handle` keeps each handler by channel. */
function capturingIpcMain(): { handlers: Map<string, CapturedHandler>; electronMock: () => unknown } {
  const handlers = new Map<string, CapturedHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: CapturedHandler) => { handlers.set(channel, handler); }),
    on: vi.fn(),
  };
  return { handlers, electronMock: () => ({ ipcMain, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }) };
}

// ---------------------------------------------------------------------------
// The Done-move probe: a count that fails must not read as "nothing to lose"
// ---------------------------------------------------------------------------

describe('probePendingChanges', () => {
  const countLocalOnlyCommits = vi.fn();

  async function loadProbe(headSha: string | null) {
    countLocalOnlyCommits.mockReset();
    installMocks({
      electron: () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }),
      '../../src/main/git/git-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/git-client')>('../../src/main/git/git-client')),
        gitAt: vi.fn(() => ({
          status: vi.fn(async () => ({ files: [] })),
          raw: vi.fn(async () => 'origin\n'),
        })),
      }),
      '../../src/main/git/worktree-head': () => ({
        readWorktreeHead: vi.fn(async () => ({ branch: headSha ? 'feat/work' : null, sha: headSha })),
      }),
      '../../src/main/git/fetch-throttle': () => ({ fetchAllRemotesIfStale: vi.fn(async () => undefined) }),
      '../../src/main/git/local-only-commits': () => ({ countLocalOnlyCommits }),
      '../../src/main/git/diff-service': () => ({ DiffService: class {} }),
      '../../src/main/git/diff-watcher': () => ({ DiffWatcher: class {} }),
    });
    const { probePendingChanges } = await import('../../src/main/ipc/handlers/git-diff');
    return probePendingChanges;
  }

  it('answers that there may be changes, and reports, when the local-only count fails on a real commit', async () => {
    const probePendingChanges = await loadProbe('abc123');
    countLocalOnlyCommits.mockRejectedValue(defect());

    const result = await probePendingChanges('/mock/worktree');

    // Before, the failed count read as zero and a Done move with auto-cleanup deleted
    // the branch with no confirm.
    expect(result).toMatchObject({ hasPendingChanges: true, uncommittedFileCount: 0, unpushedCommitCount: 0 });
    expectOnlyStepReport('git_diff', 'local_only_count');
  });

  it('answers no changes and reports nothing for an unborn branch, which has no commit to lose', async () => {
    const probePendingChanges = await loadProbe(null);
    countLocalOnlyCommits.mockRejectedValue(new Error('fatal: bad revision HEAD'));

    const result = await probePendingChanges('/mock/worktree');

    expect(result).toMatchObject({ hasPendingChanges: false, unpushedCommitCount: 0 });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backlog promote and demote: a failed copy never deletes the file it failed to copy
// ---------------------------------------------------------------------------

describe('backlog attachment copies', () => {
  const attachment = { file_path: '/mock/attachments/spec.png', filename: 'spec.png', media_type: 'image/png' };
  const task = {
    id: 'task-aaa00001',
    display_id: 7,
    title: USER_TEXT,
    description: '',
    swimlane_id: 'lane-todo',
    session_id: null,
    priority: 0,
    labels: [],
  };

  interface BacklogHarness {
    sourceExists: boolean;
    readSource: () => Buffer;
    copyToTask: () => void;
    copyToBacklog: () => void;
  }

  function missingSource(): NodeJS.ErrnoException {
    return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  }

  async function registerBacklog(harness: BacklogHarness) {
    const { handlers, electronMock } = capturingIpcMain();
    const repos = {
      backlog: {
        getById: vi.fn(() => ({ id: 'backlog-1', title: USER_TEXT, description: '', labels: [], priority: 0 })),
        delete: vi.fn(),
        createFromTask: vi.fn(() => ({ id: 'backlog-new' })),
      },
      tasks: { create: vi.fn(() => task), getById: vi.fn(() => task), update: vi.fn(), delete: vi.fn() },
      attachments: { add: vi.fn(() => harness.copyToTask()), list: vi.fn(() => [attachment]), deleteByTaskId: vi.fn() },
      backlogAttachments: { add: vi.fn(() => harness.copyToBacklog()), list: vi.fn(() => [attachment]), deleteByTaskId: vi.fn() },
    };
    const projectContext = { projectId: 'project-1', projectPath: '/mock/project' };
    installMocks({
      electron: electronMock,
      'node:fs': () => ({
        default: {
          existsSync: vi.fn(() => harness.sourceExists),
          readFileSync: vi.fn(() => harness.readSource()),
          mkdirSync: vi.fn(),
          copyFileSync: vi.fn(),
        },
      }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})), getExistingProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/backlog-repository': () => ({
        BacklogRepository: class {
          getById = repos.backlog.getById;
          delete = repos.backlog.delete;
          createFromTask = repos.backlog.createFromTask;
        },
      }),
      '../../src/main/db/repositories/task-repository': () => ({
        TaskRepository: class {
          create = repos.tasks.create;
          getById = repos.tasks.getById;
          update = repos.tasks.update;
          delete = repos.tasks.delete;
        },
      }),
      '../../src/main/db/repositories/swimlane-repository': () => ({
        SwimlaneRepository: class { getById = () => ({ id: 'lane-todo', auto_spawn: false, role: 'todo' }); },
      }),
      '../../src/main/db/repositories/action-repository': () => ({ ActionRepository: class { getTransitionsFor = () => []; } }),
      '../../src/main/db/repositories/attachment-repository': () => ({
        AttachmentRepository: class {
          add = repos.attachments.add;
          list = repos.attachments.list;
          deleteByTaskId = repos.attachments.deleteByTaskId;
        },
      }),
      '../../src/main/db/repositories/backlog-attachment-repository': () => ({
        BacklogAttachmentRepository: class {
          add = repos.backlogAttachments.add;
          list = repos.backlogAttachments.list;
          deleteByTaskId = repos.backlogAttachments.deleteByTaskId;
        },
      }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class { getLatestForTask = () => null; } }),
      '../../src/main/ipc/handlers/task-move': () => ({}),
      '../../src/main/boards': () => ({
        boardRegistry: { get: vi.fn(() => null), requireStable: vi.fn() },
        ImportSourceStore: class {
          list = vi.fn(() => []);
          add = vi.fn();
          remove = vi.fn();
          updateLabel = vi.fn();
        },
      }),
      '../../src/main/boards/adapters/asana': () => ({ registerAsanaIpcHandlers: vi.fn() }),
      '../../src/main/workflows/workflow-home': () => ({ isInWorkflow: vi.fn(() => false) }),
      '../../src/main/workflows/workflow-lock-check': () => ({ workflowTitleOf: vi.fn() }),
      '../../src/main/automations/turn-end/turn-end-passes': () => ({ supersedeMessageDeliveries: vi.fn() }),
      '../../src/main/ipc/helpers/project-repos': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/project-repos')>('../../src/main/ipc/helpers/project-repos')),
        resolveProjectContext: () => projectContext,
        getProjectRepos: () => ({ tasks: repos.tasks, attachments: repos.attachments }),
      }),
      '../../src/main/ipc/helpers': () => ({
        getProjectRepos: () => ({ tasks: repos.tasks, attachments: repos.attachments }),
        resolveProjectContext: () => projectContext,
        ensureTaskWorktree: vi.fn(async () => undefined),
        ensureTaskBranchCheckout: vi.fn(async () => undefined),
        notifySpawnBlocked: vi.fn(),
        spawnAgent: vi.fn(async () => undefined),
        autoSpawnForTask: vi.fn(async () => undefined),
        reportAutomationFailures: vi.fn(),
        createTransitionEngine: vi.fn(() => ({
          executeTransition: vi.fn(async () => ({ outcomes: [], failures: [], startedAgent: false })),
        })),
        cleanupTaskResources: vi.fn(async () => undefined),
      }),
    });
    const { registerBacklogHandlers } = await import('../../src/main/ipc/handlers/backlog');
    registerBacklogHandlers({
      currentProjectId: 'project-1',
      currentProjectPath: '/mock/project',
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: { listSessions: vi.fn(() => []), removeByTaskId: vi.fn() },
      terminalSubmitScheduler: { cancel: vi.fn() },
      boardEvents: { emitBoardChanged: vi.fn() },
    } as never);
    const handlerOf = (channel: string): CapturedHandler => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler;
    };
    return { repos, promote: handlerOf(IPC.BACKLOG_PROMOTE), demote: handlerOf(IPC.BACKLOG_DEMOTE) };
  }

  const promoteInput = { backlogTaskIds: ['backlog-1'], targetSwimlaneId: 'lane-todo' };

  it('a promote whose copy fails with the file still on disk undoes that task and keeps the backlog item', async () => {
    const copyFailure = defect();
    const { repos, promote } = await registerBacklog({
      sourceExists: true,
      readSource: () => Buffer.from('image'),
      copyToTask: () => { throw copyFailure; },
      copyToBacklog: () => undefined,
    });

    // Before, the failed copy was logged and the item's files were deleted right after.
    await expect(promote({}, promoteInput)).rejects.toBe(copyFailure);

    expect(repos.attachments.deleteByTaskId).toHaveBeenCalledWith(task.id);
    expect(repos.tasks.delete).toHaveBeenCalledWith(task.id);
    expect(repos.backlogAttachments.deleteByTaskId).not.toHaveBeenCalled();
    expect(repos.backlog.delete).not.toHaveBeenCalled();
    // The IPC wrap reports the rejection, so the step sends nothing of its own.
    expect(stepReports()).toHaveLength(0);
  });

  it('a promote whose attachment file is already gone goes on without it and reports the missing file', async () => {
    const { repos, promote } = await registerBacklog({
      sourceExists: false,
      readSource: () => { throw missingSource(); },
      copyToTask: () => undefined,
      copyToBacklog: () => undefined,
    });

    await expect(promote({}, promoteInput)).resolves.toBeDefined();

    expect(repos.tasks.delete).not.toHaveBeenCalled();
    expect(repos.backlog.delete).toHaveBeenCalledWith('backlog-1');
    expectOnlyStepReport('backlog', 'promote_attachment_missing', 'Error');
  });

  it('a demote whose copy fails with the file still on disk takes the backlog row back and keeps the task', async () => {
    const copyFailure = defect();
    const { repos, demote } = await registerBacklog({
      sourceExists: true,
      readSource: () => Buffer.from('image'),
      copyToTask: () => undefined,
      copyToBacklog: () => { throw copyFailure; },
    });

    // Before, the failed copy was logged and the task's files and row were deleted right after.
    await expect(demote({}, { taskId: task.id }, 'project-1')).rejects.toBe(copyFailure);

    expect(repos.backlogAttachments.deleteByTaskId).toHaveBeenCalledWith('backlog-new');
    expect(repos.backlog.delete).toHaveBeenCalledWith('backlog-new');
    expect(repos.attachments.deleteByTaskId).not.toHaveBeenCalled();
    expect(repos.tasks.delete).not.toHaveBeenCalled();
    expect(stepReports()).toHaveLength(0);
  });

  it('a demote whose attachment file is already gone goes on without it and reports the missing file', async () => {
    const { repos, demote } = await registerBacklog({
      sourceExists: false,
      readSource: () => { throw missingSource(); },
      copyToTask: () => undefined,
      copyToBacklog: () => undefined,
    });

    await expect(demote({}, { taskId: task.id }, 'project-1')).resolves.toBeDefined();

    expect(repos.tasks.delete).toHaveBeenCalledWith(task.id);
    expectOnlyStepReport('backlog', 'demote_attachment_missing', 'Error');
  });
});

describe('Conversation viewer reads', () => {
  const retrievalCall = vi.fn();

  async function registerHandlers(): Promise<Map<string, CapturedHandler>> {
    retrievalCall.mockReset();
    const { handlers, electronMock } = capturingIpcMain();
    installMocks({
      electron: electronMock,
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class {} }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: {} }),
      '../../src/main/retrieval/remote-targets': () => ({ collectRemoteTargets: () => [] }),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: { call: retrievalCall },
      }),
    });
    const { registerTranscriptHandlers } = await import('../../src/main/ipc/handlers/transcripts');
    registerTranscriptHandlers({ currentProjectId: 'project-1', sessionManager: { getSession: vi.fn() } } as never);
    return handlers;
  }

  async function answerOf(handlers: Map<string, CapturedHandler>, channel: string, request: unknown): Promise<{ status: string; reason?: string }> {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    const answer = await handler({}, request);
    return typeof answer === 'string' ? JSON.parse(answer) : answer as { status: string; reason?: string };
  }

  const reads: Array<{ name: string; channel: string; request: Record<string, string>; step: string }> = [
    { name: 'a page', channel: IPC.TRANSCRIPT_PAGE, request: { projectId: 'project-1', conversationId: 'conversation-1', direction: 'before' }, step: 'page_read' },
    { name: 'a locate', channel: IPC.TRANSCRIPT_LOCATE, request: { projectId: 'project-1', sessionId: 'session-1', turnUuid: 'turn-1' }, step: 'locate_read' },
    { name: 'a timeline', channel: IPC.TRANSCRIPT_TIMELINE, request: { projectId: 'project-1', conversationId: 'conversation-1' }, step: 'timeline_read' },
  ];

  it.each(reads)('reports $name read that throws and answers that the read failed', async ({ channel, request, step }) => {
    const handlers = await registerHandlers();
    retrievalCall.mockRejectedValue(defect());

    const answer = await answerOf(handlers, channel, request);

    expect(answer).toEqual({ status: 'unavailable', reason: 'read_failed' });
    expectOnlyStepReport('transcripts', step);
  });

  it('does not report a read while the worker is down, and says so in the answer', async () => {
    const handlers = await registerHandlers();
    const { RetrievalUnavailableError } = await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client');
    retrievalCall.mockRejectedValue(new RetrievalUnavailableError('The retrieval worker exited'));

    const answer = await answerOf(handlers, IPC.TRANSCRIPT_TIMELINE, { projectId: 'project-1', conversationId: 'conversation-1' });

    expect(answer).toEqual({ status: 'unavailable', reason: 'worker_unavailable' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('MCP connection check handler', () => {
  const checkMcpConnection = vi.fn();

  async function registerHandlers(): Promise<CapturedHandler> {
    checkMcpConnection.mockReset();
    const { handlers, electronMock } = capturingIpcMain();
    installMocks({
      electron: electronMock,
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { get: vi.fn() } }),
      '../../src/main/agent/mcp-connection-check': () => ({ checkMcpConnection, wslDistrosOfCliPaths: vi.fn(() => []) }),
      '../../src/main/agent/mcp-server-start-failure': () => ({ mcpServerStartFailure: vi.fn(() => null) }),
      '../../src/main/pop-out/window-broadcast': () => ({ broadcast: vi.fn() }),
    });
    const { registerMcpServerHandlers } = await import('../../src/main/ipc/handlers/mcp-server');
    registerMcpServerHandlers({
      configManager: { getEffectiveConfig: () => ({ agent: { cliPaths: {} } }), load: () => ({}) },
      currentProjectPath: null,
      currentProjectId: 'project-1',
      mcpServerHandle: null,
      sessionManager: new EventEmitter(),
      mainWindow: { isDestroyed: () => false },
    } as never);
    const handler = handlers.get(IPC.MCP_SERVER_CHECK_CONNECTION);
    if (!handler) throw new Error('the connection check handler was not registered');
    return handler;
  }

  it('reports a check that throws a defect and answers it as a failure', async () => {
    const handler = await registerHandlers();
    checkMcpConnection.mockRejectedValue(new TypeError('handle.port is not a number'));

    await expect(handler({}, { explicit: true })).resolves.toEqual({ connected: false, error: 'handle.port is not a number' });

    expectOnlyStepReport('mcp_watch', 'connection_check');
  });

  it('answers a probe program that failed with a plain Error and reports nothing', async () => {
    const handler = await registerHandlers();
    checkMcpConnection.mockRejectedValue(new Error('the distro did not answer'));

    await expect(handler({}, { explicit: true })).resolves.toEqual({ connected: false, error: 'the distro did not answer' });

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
