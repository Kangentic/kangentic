/**
 * The completed task view's reads (`src/main/ipc/helpers/task-report.ts`):
 * `readTaskReport` (`sessions.getTaskReport`) and `readTaskLastMessage`.
 *
 * Everything the file touches outside itself is mocked at the module edge: the
 * project database, the repositories, the retrieval client, the remote target
 * collector and the agent registry. The assembler (`assembleTaskReport`) is the
 * REAL one, so a section the read gives up on shows as the report's own null
 * (`models`, `knowledge`) and the summary state reads off the report.
 *
 * Red-green (the source was toggled and restored for these, then read back):
 *   - a third `{ timeoutMs }` argument on an index read: the no-options test fails;
 *   - dropping the empty `projectId` guard: the empty-id test fails;
 *   - `commits: 20` changed: the limits test fails;
 *   - the ledger read made unconditional: the skipped-ledger test fails;
 *   - the `finally { clearTimeout }` removed: the lingering-timer test fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig, TaskReport } from '../../src/shared/types';
import type { LatestAgentSessionRecord, TaskReportSessionRecord } from '../../src/main/db/repositories/session-repository';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskKnowledge } from '../../src/main/retrieval/task-knowledge';
import type { TaskModelUsageRow } from '../../src/main/retrieval/conversation/conversation-usage-store';

const hoisted = vi.hoisted(() => ({
  retrievalCall: vi.fn<(method: string, params: unknown, options?: unknown) => Promise<unknown>>(),
  getProjectDb: vi.fn<(projectId: string) => unknown>(),
  getProjectRepos: vi.fn<() => unknown>(),
  listTaskReportRecords: vi.fn<(taskId: string) => unknown[]>(),
  getLatestAgentSessionForTask: vi.fn<(taskId: string) => unknown>(),
  getSummaryForTask: vi.fn<(taskId: string) => unknown>(),
  collectRemoteTargets: vi.fn<() => unknown>(),
  loadConfig: vi.fn<() => unknown>(),
}));

vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: hoisted.retrievalCall },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: hoisted.getProjectDb }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: hoisted.getProjectRepos }));
// The assembler also imports `parseToolBreakdown` from this module, so only the class is replaced.
vi.mock('../../src/main/db/repositories/session-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/repositories/session-repository')>()),
  SessionRepository: class {
    listTaskReportRecords = hoisted.listTaskReportRecords;
    getLatestAgentSessionForTask = hoisted.getLatestAgentSessionForTask;
    getSummaryForTask = hoisted.getSummaryForTask;
  },
}));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: hoisted.collectRemoteTargets }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: {} }));

// Imported AFTER all mocks are defined.
import { readTaskReport, readTaskLastMessage } from '../../src/main/ipc/helpers/task-report';
import { serializeCliTarget } from '../../src/main/agent/shared/cli-target';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const REMOTE_TARGETS_SENTINEL = [{ adapter: 'mock-adapter', targets: ['mock-target'] }];
const WRITTEN_SUMMARY = 'Moved the toolbar into the header.';

const LEDGER_ROWS: TaskModelUsageRow[] = [
  {
    modelId: 'claude-opus-5-5',
    subagentType: null,
    turns: 4,
    freshInputTokens: 100,
    cacheWriteTokens: 200,
    cacheReadTokens: 300,
    outputTokens: 50,
  },
];

const KNOWLEDGE: TaskKnowledge = {
  summary: null,
  commits: [{ sha: 'abc1234', subject: 'Move the toolbar', committedAt: '2026-10-13T03:00:00.000Z' }],
  commitCount: 1,
  changedFiles: ['src/toolbar.ts'],
  changedFileCount: 1,
};

type KnowledgeGraphConfig = AppConfig['knowledgeGraph'];

function fakeContext(): IpcContext {
  return { configManager: { load: hoisted.loadConfig } } as unknown as IpcContext;
}

function useKnowledgeGraph(knowledgeGraph: KnowledgeGraphConfig): void {
  hoisted.loadConfig.mockReturnValue({ knowledgeGraph });
}

/**
 * Answers the three index reads. `overrides` replaces one method's answer (a
 * rejection, or a promise that never settles). Every answer is a Promise, as
 * the real client's is: a bare value would throw inside the source's `.catch`.
 */
function answerIndexCalls(overrides: Partial<Record<string, () => Promise<unknown>>> = {}): void {
  hoisted.retrievalCall.mockImplementation((method: string) => {
    const override = overrides[method];
    if (override) return override();
    if (method === 'usage.taskModels') return Promise.resolve(LEDGER_ROWS);
    if (method === 'task.knowledge') return Promise.resolve(new Map([[TASK_ID, KNOWLEDGE]]));
    if (method === 'summary.forTask') return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected retrieval method ${method}`));
  });
}

function rejects(message: string): () => Promise<unknown> {
  return () => Promise.reject(new Error(message));
}

function neverSettles(): Promise<unknown> {
  return new Promise<unknown>(() => {});
}

function methodsCalled(): string[] {
  return hoisted.retrievalCall.mock.calls.map((call) => call[0]);
}

/** What `getLatestAgentSessionForTask` answers: the newest record of the task that names a conversation. */
function latestAgentSession(fields: { session_type: string; agent_session_id: string; cwd: string; cli_target?: string | null }): LatestAgentSessionRecord {
  return { cli_target: null, ...fields };
}

/**
 * A `cli_target` column value as a session that ran in a WSL distro leaves it:
 * the real serializer's output, with the homes a reader after the session needs.
 */
const STORED_WSL_TARGET = serializeCliTarget({
  kind: 'wsl',
  distro: 'Ubuntu',
  facts: {
    distro: 'Ubuntu',
    homeLinux: '/home/dev',
    homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '',
    env: {},
    networkingMode: 'nat',
  },
});

beforeEach(() => {
  for (const mock of Object.values(hoisted)) mock.mockReset();
  hoisted.getProjectDb.mockReturnValue({});
  hoisted.getProjectRepos.mockReturnValue({
    swimlanes: { list: () => [] },
    taskMoves: { listForTask: () => [] },
    automationRuns: { listForTask: () => [] },
    automations: { listAll: () => [] },
    backgroundCalls: { listForTask: () => [] },
  });
  hoisted.listTaskReportRecords.mockReturnValue([]);
  hoisted.getLatestAgentSessionForTask.mockReturnValue(undefined);
  hoisted.getSummaryForTask.mockReturnValue(null);
  hoisted.collectRemoteTargets.mockReturnValue(REMOTE_TARGETS_SENTINEL);
  useKnowledgeGraph({ indexingEnabled: true, enabled: true });
  answerIndexCalls();
  // The reject and timeout paths log; keep the run quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readTaskReport summary state', () => {
  it('reads a written summary as written', async () => {
    answerIndexCalls({ 'summary.forTask': () => Promise.resolve(WRITTEN_SUMMARY) });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'written', text: WRITTEN_SUMMARY });
  });

  it('keeps a written summary written when the Knowledge Graph is off', async () => {
    useKnowledgeGraph({ indexingEnabled: true, enabled: false });
    answerIndexCalls({ 'summary.forTask': () => Promise.resolve(WRITTEN_SUMMARY) });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'written', text: WRITTEN_SUMMARY });
  });

  it('keeps a written summary written when task summaries are switched off', async () => {
    useKnowledgeGraph({ indexingEnabled: true, enabled: true, taskSummaries: false });
    answerIndexCalls({ 'summary.forTask': () => Promise.resolve(WRITTEN_SUMMARY) });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'written', text: WRITTEN_SUMMARY });
  });

  it('is indexing-off with indexing off, and never calls the retrieval worker', async () => {
    useKnowledgeGraph({ indexingEnabled: false, enabled: true });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'indexing-off' });
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
    expect(report.models).toBeNull();
    expect(report.knowledge).toBeNull();
  });

  it('is off with indexing on and the Knowledge Graph off', async () => {
    useKnowledgeGraph({ indexingEnabled: true, enabled: false });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'off' });
  });

  it('is off with the Knowledge Graph unset', async () => {
    useKnowledgeGraph({ indexingEnabled: true });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'off' });
  });

  it('is off when the Knowledge Graph is on but task summaries are switched off', async () => {
    useKnowledgeGraph({ indexingEnabled: true, enabled: true, taskSummaries: false });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'off' });
  });

  it('is pending when the Knowledge Graph and task summaries are on and none is written', async () => {
    useKnowledgeGraph({ indexingEnabled: true, enabled: true });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'pending' });
  });

  it('reads a config that throws as indexing on and summaries off', async () => {
    hoisted.loadConfig.mockImplementation(() => {
      throw new Error('config unreadable');
    });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).toEqual({ kind: 'off' });
    // Indexing reading as on is what makes the three index reads happen.
    expect(methodsCalled().sort()).toEqual(['summary.forTask', 'task.knowledge', 'usage.taskModels']);
    expect(report.models).toEqual([expect.objectContaining({ turns: 4 })]);
  });
});

describe('readTaskReport session records', () => {
  it('builds the runs from the task\'s projected records', async () => {
    const record: TaskReportSessionRecord = {
      id: 'record-1', session_type: 'claude', isolated_swimlane_id: null, agent_session_id: 'conversation-a', permission_mode: 'plan',
      started_at: '2026-10-13T03:00:00.000Z', suspended_at: '2026-10-13T03:10:00.000Z', exited_at: null, exit_code: null,
      total_cost_usd: 0.5, total_input_tokens: 100, total_output_tokens: 10, total_duration_ms: 600_000,
      model_id: 'claude-opus-5-5', model_display_name: 'Opus 5.5', applied_effort: 'high',
      tool_call_count: 7, compaction_count: 0, tool_breakdown: null,
    };
    hoisted.listTaskReportRecords.mockReturnValue([record]);

    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);

    expect(hoisted.listTaskReportRecords).toHaveBeenCalledWith(TASK_ID);
    expect(report.conversations).toEqual([expect.objectContaining({
      conversationId: 'conversation-a',
      runs: [expect.objectContaining({ recordId: 'record-1', costUsd: 0.5, runtimeMs: 600_000, toolCallCount: 7 })],
    })]);
  });
});

describe('readTaskReport index reads', () => {
  it('asks task.knowledge for this task with twenty commits and every changed file', async () => {
    await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(hoisted.retrievalCall).toHaveBeenCalledWith('task.knowledge', {
      projectId: PROJECT_ID,
      taskIds: [TASK_ID],
      limits: { commits: 20, files: null },
    });
  });

  it('asks task.knowledge for the commit limit a caller passes, and still every changed file', async () => {
    await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID, { commitLimit: 100 });
    expect(hoisted.retrievalCall).toHaveBeenCalledWith('task.knowledge', {
      projectId: PROJECT_ID,
      taskIds: [TASK_ID],
      limits: { commits: 100, files: null },
    });
  });

  it('skips the turn ledger when the caller leaves it out, and reads the other two', async () => {
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID, { includeLedger: false });
    expect(methodsCalled().sort()).toEqual(['summary.forTask', 'task.knowledge']);
    expect(report.models).toBeNull();
    expect(report.knowledge).not.toBeNull();
  });

  it('asks the other two reads about this project and task', async () => {
    await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(hoisted.retrievalCall).toHaveBeenCalledWith('usage.taskModels', { projectId: PROJECT_ID, taskId: TASK_ID });
    expect(hoisted.retrievalCall).toHaveBeenCalledWith('summary.forTask', { projectId: PROJECT_ID, taskId: TASK_ID });
  });

  it('passes no options argument on any of the three reads, so each keeps the client interactive budget', async () => {
    await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(methodsCalled().sort()).toEqual(['summary.forTask', 'task.knowledge', 'usage.taskModels']);
    for (const call of hoisted.retrievalCall.mock.calls) {
      expect(call).toHaveLength(2);
    }
  });

  it('puts a healthy index into the report', async () => {
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.models).toEqual([expect.objectContaining({ turns: 4, outputTokens: 50 })]);
    expect(report.knowledge).toEqual({
      commits: KNOWLEDGE.commits,
      commitCount: 1,
      changedFiles: ['src/toolbar.ts'],
      changedFileCount: 1,
    });
  });
});

describe('readTaskReport when an index read rejects', () => {
  it('costs only the models section when usage.taskModels rejects', async () => {
    answerIndexCalls({ 'usage.taskModels': rejects('worker restarting') });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.models).toBeNull();
    expect(report.knowledge).not.toBeNull();
    expect(report.summaryState).toEqual({ kind: 'pending' });
  });

  it('costs only the knowledge section when task.knowledge rejects', async () => {
    answerIndexCalls({ 'task.knowledge': rejects('worker restarting') });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.knowledge).toBeNull();
    expect(report.models).not.toBeNull();
    expect(report.summaryState).toEqual({ kind: 'pending' });
  });

  it('costs only the written summary when summary.forTask rejects', async () => {
    answerIndexCalls({ 'summary.forTask': rejects('worker restarting') });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.summaryState).not.toMatchObject({ kind: 'written' });
    // Switches on and nothing written reads as pending, never as an error.
    expect(report.summaryState).toEqual({ kind: 'pending' });
    expect(report.models).not.toBeNull();
    expect(report.knowledge).not.toBeNull();
  });

  it('still resolves when all three reads reject', async () => {
    answerIndexCalls({
      'usage.taskModels': rejects('down'),
      'task.knowledge': rejects('down'),
      'summary.forTask': rejects('down'),
    });
    const report = await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(report.models).toBeNull();
    expect(report.knowledge).toBeNull();
    expect(report.summaryState).toEqual({ kind: 'pending' });
  });
});

describe('readTaskReport when an index read never settles', () => {
  const sections: Array<{ method: string; check: (report: TaskReport) => void }> = [
    {
      method: 'usage.taskModels',
      check: (report) => {
        expect(report.models).toBeNull();
        expect(report.knowledge).not.toBeNull();
      },
    },
    {
      method: 'task.knowledge',
      check: (report) => {
        expect(report.knowledge).toBeNull();
        expect(report.models).not.toBeNull();
      },
    },
    {
      method: 'summary.forTask',
      check: (report) => {
        expect(report.summaryState).toEqual({ kind: 'pending' });
        expect(report.models).not.toBeNull();
      },
    },
  ];

  it.each(sections)('resolves at exactly 8000 ms without the $method section', async ({ method, check }) => {
    vi.useFakeTimers();
    answerIndexCalls({ [method]: neverSettles });
    let settled = false;
    const reportPromise = readTaskReport(fakeContext(), PROJECT_ID, TASK_ID).then((report) => {
      settled = true;
      return report;
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    check(await reportPromise);
  });

  it('leaves no wait timer behind once every read has settled', async () => {
    vi.useFakeTimers();
    await readTaskReport(fakeContext(), PROJECT_ID, TASK_ID);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readTaskLastMessage', () => {
  it('returns null for an empty projectId without opening a database', async () => {
    const message = await readTaskLastMessage('', TASK_ID);
    expect(message).toBeNull();
    expect(hoisted.getProjectDb).not.toHaveBeenCalled();
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
  });

  it('returns null when no record of the task names a conversation, without calling the worker', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(undefined);
    const message = await readTaskLastMessage(PROJECT_ID, TASK_ID);
    expect(message).toBeNull();
    expect(hoisted.getLatestAgentSessionForTask).toHaveBeenCalledWith(TASK_ID);
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
  });

  it('returns null for a record whose conversation id is empty, without calling the worker', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({ session_type: 'claude', agent_session_id: '', cwd: '/mock/project' }));
    const message = await readTaskLastMessage(PROJECT_ID, TASK_ID);
    expect(message).toBeNull();
    expect(hoisted.retrievalCall).not.toHaveBeenCalled();
  });

  // Which record is newest (a newer one with no conversation id passed over) is the
  // repository's query, pinned on a real database in session-repository-task-report-reads.test.ts.
  it('reads the transcript of the record the repository names', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({ session_type: 'codex', agent_session_id: 'conversation-b', cwd: '/mock/second' }));
    hoisted.retrievalCall.mockResolvedValue({ text: 'Done.', uuid: 'reply-1', ts: Date.parse('2026-10-13T03:00:00.000Z') });

    await readTaskLastMessage(PROJECT_ID, TASK_ID);

    expect(hoisted.getProjectDb).toHaveBeenCalledWith(PROJECT_ID);
    expect(hoisted.getLatestAgentSessionForTask).toHaveBeenCalledWith(TASK_ID);
    expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
    expect(hoisted.retrievalCall).toHaveBeenCalledWith(
      'transcript.finalReply',
      {
        facts: { sessionType: 'codex', agentSessionId: 'conversation-b', cwd: '/mock/second', cliTarget: null },
        remoteTargets: REMOTE_TARGETS_SENTINEL,
      },
      { timeoutMs: 15_000 },
    );
  });

  it('hands the worker the stored target of a session that ran in a WSL distro, parsed', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({
      session_type: 'claude',
      agent_session_id: 'conversation-wsl',
      cwd: '/home/dev/project',
      cli_target: STORED_WSL_TARGET,
    }));
    hoisted.retrievalCall.mockResolvedValue({ text: 'Done.', uuid: 'reply-1', ts: Date.parse('2026-10-13T03:00:00.000Z') });

    await readTaskLastMessage(PROJECT_ID, TASK_ID);

    expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
    const [method, params] = hoisted.retrievalCall.mock.calls[0] as [string, { facts: Record<string, unknown> }];
    expect(method).toBe('transcript.finalReply');
    expect(params.facts).toMatchObject({ sessionType: 'claude', agentSessionId: 'conversation-wsl', cwd: '/home/dev/project' });
    // The worker places the read from this object's homes (`placeFromStored`). Null
    // reads this machine's home, and the row's raw JSON string has no homes to read
    // (so it would read this machine too); only the parsed object reaches the distro.
    expect(params.facts.cliTarget).toMatchObject({
      kind: 'wsl',
      distro: 'Ubuntu',
      homeLinux: '/home/dev',
      homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu',
    });
  });

  it('returns null for a null reply', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({ session_type: 'claude', agent_session_id: 'conversation-a', cwd: '/mock/project' }));
    hoisted.retrievalCall.mockResolvedValue(null);
    expect(await readTaskLastMessage(PROJECT_ID, TASK_ID)).toBeNull();
  });

  it('returns the reply text with its time as an ISO string', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({ session_type: 'claude', agent_session_id: 'conversation-a', cwd: '/mock/project' }));
    hoisted.retrievalCall.mockResolvedValue({ text: 'All set.', uuid: 'reply-1', ts: Date.parse('2026-10-13T03:00:00.000Z') });
    expect(await readTaskLastMessage(PROJECT_ID, TASK_ID)).toEqual({
      text: 'All set.',
      writtenAt: '2026-10-13T03:00:00.000Z',
    });
  });

  it('returns the text with writtenAt null when the reply time is NaN', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({ session_type: 'claude', agent_session_id: 'conversation-a', cwd: '/mock/project' }));
    hoisted.retrievalCall.mockResolvedValue({ text: 'All set.', uuid: 'reply-1', ts: Number.NaN });
    expect(await readTaskLastMessage(PROJECT_ID, TASK_ID)).toEqual({ text: 'All set.', writtenAt: null });
  });

  it('returns null when the worker call rejects', async () => {
    hoisted.getLatestAgentSessionForTask.mockReturnValue(latestAgentSession({ session_type: 'claude', agent_session_id: 'conversation-a', cwd: '/mock/project' }));
    hoisted.retrievalCall.mockRejectedValue(new Error('worker restarting'));
    await expect(readTaskLastMessage(PROJECT_ID, TASK_ID)).resolves.toBeNull();
  });
});
