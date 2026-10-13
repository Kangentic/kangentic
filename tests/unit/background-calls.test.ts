/**
 * The background call ledger (`background_calls`): the repository, the run log's
 * link to it, the recorder that writes it, and the dashboard fold.
 *
 * Against a REAL SQLite engine where storage is involved, following
 * automation-repository.test.ts: what matters is the rows the migration and the
 * queries produce.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BackgroundCallRepository, type RecordBackgroundCallInput } from '../../src/main/db/repositories/background-call-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { startRecordedCall, type BackgroundCallSink } from '../../src/main/background-calls/record-background-call';
import { foldBackgroundUsage } from '../../src/main/usage-stats/background-usage';
import type { AgentCallUsage } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function migratedDatabase(): { database: DatabaseType.Database; columnId: string; taskId: string } {
  const database = openTestDatabase();
  openDatabases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  runProjectMigrations(database);
  const columnId = new SwimlaneRepository(database).list()[0].id;
  const taskId = 'task-1';
  database
    .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, 'A task', '', columnId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  return { database, columnId, taskId };
}

const HAIKU_USAGE: AgentCallUsage = {
  model: 'claude-haiku-5-5', inputTokens: 2, cacheCreationInputTokens: 2402, cacheReadInputTokens: 535, outputTokens: 35, costUsd: 0.00050345,
};

function call(overrides: Partial<RecordBackgroundCallInput> = {}): RecordBackgroundCallInput {
  return {
    id: 'call-1',
    job: 'condition_check',
    taskId: 'task-1',
    swimlaneId: null,
    agent: 'claude',
    requestedModel: 'claude-haiku-5-5',
    effort: 'low',
    usage: HAIKU_USAGE,
    durationMs: 1151,
    outcome: 'succeeded',
    detail: null,
    startedAt: '2026-10-13T14:02:11.402Z',
    ...overrides,
  };
}

describe('BackgroundCallRepository', () => {
  it('groups calls by bucket, job, agent and model, with the four token sums and cost', () => {
    const { database } = migratedDatabase();
    const calls = new BackgroundCallRepository(database);
    calls.record(call({ id: 'a' }));
    calls.record(call({ id: 'b', startedAt: '2026-10-13T14:05:00.000Z' }));
    calls.record(call({ id: 'c', job: 'task_title', startedAt: '2026-10-13T14:06:00.000Z' }));

    const groups = calls.listGroups(null, null, 15 * 60_000);

    expect(groups).toHaveLength(2);
    const checks = groups.find((group) => group.job === 'condition_check');
    expect(checks).toMatchObject({
      agent: 'claude',
      modelId: 'claude-haiku-5-5',
      calls: 2,
      failedCalls: 0,
      reportedCalls: 2,
      inputTokens: 4,
      cacheCreationInputTokens: 4804,
      cacheReadInputTokens: 1070,
      outputTokens: 70,
      durationMs: 2302,
    });
    expect(checks?.costUsd).toBeCloseTo(0.0010069, 7);
  });

  it('keeps an agent that reports no usage at null cost, never zero, and counts its failures', () => {
    const { database } = migratedDatabase();
    const calls = new BackgroundCallRepository(database);
    calls.record(call({ id: 'a', agent: 'codex', requestedModel: null, usage: null }));
    calls.record(call({ id: 'b', agent: 'codex', requestedModel: null, usage: null, outcome: 'timed_out', detail: 'the agent timed out' }));

    const [group] = calls.listGroups(null, null, 15 * 60_000);

    expect(group).toMatchObject({ agent: 'codex', modelId: null, calls: 2, failedCalls: 1, reportedCalls: 0, inputTokens: 0, costUsd: null });
  });

  it('names the model the CLI reported, else the one asked for', () => {
    const { database } = migratedDatabase();
    const calls = new BackgroundCallRepository(database);
    calls.record(call({ id: 'a', requestedModel: 'haiku', usage: { ...HAIKU_USAGE, model: null } }));

    expect(calls.listGroups(null, null, 15 * 60_000)[0].modelId).toBe('haiku');
  });

  it('windows on started_at, inclusive since and exclusive until', () => {
    const { database } = migratedDatabase();
    const calls = new BackgroundCallRepository(database);
    calls.record(call({ id: 'before', startedAt: '2026-10-12T23:59:59.000Z' }));
    calls.record(call({ id: 'inside', startedAt: '2026-10-13T00:00:00.000Z' }));
    calls.record(call({ id: 'after', startedAt: '2026-10-14T00:00:00.000Z' }));

    const groups = calls.listGroups('2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z', 15 * 60_000);

    expect(groups.reduce((sum, group) => sum + group.calls, 0)).toBe(1);
  });

  it('reads as empty on a database that has no table yet (the worker opens without migrating)', () => {
    const database = openTestDatabase();
    openDatabases.push(database);

    expect(new BackgroundCallRepository(database).listGroups(null, null, 15 * 60_000)).toEqual([]);
  });
});

describe('the run log names the call that answered it', () => {
  const automation = (id: string, swimlaneId: string) => ({
    id, name: `Row ${id}`, type: 'send_message' as const, swimlane_id: swimlaneId, trigger: 'turn_end' as const,
  });

  it('links every row one batched check answered, and counts them', () => {
    const { database, columnId, taskId } = migratedDatabase();
    new BackgroundCallRepository(database).record(call({ id: 'call-1', swimlaneId: columnId }));
    const runs = new AutomationRunRepository(database);
    runs.recordSkipped({ id: 'run-1', automation: automation('a1', columnId), taskId, condition: { met: false, reason: 'No.', callId: 'call-1' } }, 'Condition not met: No.');
    runs.start({ id: 'run-2', automation: automation('a2', columnId), taskId, condition: { met: true, reason: 'Yes.', callId: 'call-1' } });

    const listed = runs.listForTask(taskId);

    expect(listed).toHaveLength(2);
    for (const run of listed) {
      expect(run.check).toMatchObject({
        callId: 'call-1',
        agent: 'claude',
        model: 'claude-haiku-5-5',
        modelReported: true,
        effort: 'low',
        inputTokens: 2,
        cacheCreationInputTokens: 2402,
        cacheReadInputTokens: 535,
        outputTokens: 35,
        outcome: 'succeeded',
        rowsAnswered: 2,
      });
    }
  });

  it('links the skips a check caused when it ran without answering', () => {
    const { database, columnId, taskId } = migratedDatabase();
    new BackgroundCallRepository(database).record(call({ id: 'call-late', outcome: 'timed_out', usage: null }));
    const runs = new AutomationRunRepository(database);
    runs.recordSkipped({ id: 'run-1', automation: automation('a1', columnId), taskId, backgroundCallId: 'call-late' }, 'The Automation agent did not answer in time.');

    const [run] = runs.listForTask(taskId);

    expect(run.check).toMatchObject({ callId: 'call-late', outcome: 'timed_out', inputTokens: null, costUsd: null });
  });

  it('links a workflow step check to its call', () => {
    const { database, columnId, taskId } = migratedDatabase();
    new BackgroundCallRepository(database).record(call({ id: 'call-step', job: 'workflow_step' }));
    const runs = new AutomationRunRepository(database);
    runs.recordWorkflowStep({ taskId, swimlaneId: columnId, workflowId: 'workflow-1', met: false, reason: 'Not yet.', detail: 'Not done yet: not yet.', backgroundCallId: 'call-step' });

    expect(runs.listForTask(taskId)[0].check?.callId).toBe('call-step');
  });

  it('carries no check for a row with none, or whose call record is gone', () => {
    const { database, columnId, taskId } = migratedDatabase();
    const runs = new AutomationRunRepository(database);
    runs.start({ id: 'run-plain', automation: automation('a1', columnId), taskId });
    runs.start({ id: 'run-orphan', automation: automation('a2', columnId), taskId, condition: { met: true, reason: null, callId: 'call-missing' } });

    for (const run of runs.listForTask(taskId)) expect(run.check).toBeNull();
  });
});

describe('startRecordedCall', () => {
  const meta = {
    projectId: 'project-1',
    job: 'condition_check' as const,
    taskId: 'task-1',
    swimlaneId: 'column-1',
    agent: 'claude',
    requestedModel: 'claude-haiku-5-5',
    effort: 'low',
  };

  it('hands out the id before the run, and records what the CLI reported once it succeeds', async () => {
    const sink = vi.fn<BackgroundCallSink>();
    let release!: (value: string) => void;
    const recorded = startRecordedCall(sink, meta, (onUsage) => new Promise<string>((resolve) => {
      onUsage(HAIKU_USAGE);
      release = resolve;
    }));

    expect(recorded.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sink).not.toHaveBeenCalled();
    release('C1: yes');
    await expect(recorded.done).resolves.toBe('C1: yes');
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    const [projectId, input] = sink.mock.calls[0];
    expect(projectId).toBe('project-1');
    expect(input).toMatchObject({
      id: recorded.callId, job: 'condition_check', taskId: 'task-1', swimlaneId: 'column-1',
      agent: 'claude', requestedModel: 'claude-haiku-5-5', effort: 'low', usage: HAIKU_USAGE, outcome: 'succeeded', detail: null,
    });
    expect(Date.parse(input.startedAt)).not.toBeNaN();
  });

  it('records a failure and a timeout as what they were, with whatever usage was reported first', async () => {
    const sink = vi.fn<BackgroundCallSink>();
    const failed = startRecordedCall(sink, meta, async (onUsage) => {
      onUsage(HAIKU_USAGE);
      throw new Error('API Error: 529 overloaded');
    });
    const timedOut = startRecordedCall(sink, meta, async () => {
      throw new Error('the agent timed out');
    });
    await expect(failed.done).rejects.toThrow('529');
    await expect(timedOut.done).rejects.toThrow('timed out');

    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
    const byId = new Map(sink.mock.calls.map(([, input]) => [input.id, input]));
    expect(byId.get(failed.callId)).toMatchObject({ outcome: 'failed', usage: HAIKU_USAGE, detail: 'API Error: 529 overloaded' });
    expect(byId.get(timedOut.callId)).toMatchObject({ outcome: 'timed_out', usage: null });
  });

  it('still records a run its caller stopped waiting for: it was paid for', async () => {
    const sink = vi.fn<BackgroundCallSink>();
    let release!: (value: string) => void;
    // The caller takes the id and walks away without awaiting `done`.
    const { callId } = startRecordedCall(sink, meta, () => new Promise<string>((resolve) => { release = resolve; }));
    expect(sink).not.toHaveBeenCalled();

    release('late answer');
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(sink.mock.calls[0][1].id).toBe(callId);
  });

  it('never lets a failed write fail the call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink: BackgroundCallSink = () => { throw new Error('SQLITE_BUSY'); };

    const recorded = startRecordedCall(sink, meta, async () => 'answer');

    await expect(recorded.done).resolves.toBe('answer');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('writes nothing without a project or a sink', async () => {
    const sink = vi.fn<BackgroundCallSink>();
    await startRecordedCall(sink, { ...meta, projectId: null }, async () => 'answer').done;
    await startRecordedCall(undefined, meta, async () => 'answer').done;
    await Promise.resolve();

    expect(sink).not.toHaveBeenCalled();
  });
});

describe('backgroundCallSink', () => {
  it('writes nothing for a project that was deleted while the call ran', async () => {
    vi.resetModules();
    const getProjectRepos = vi.fn();
    vi.doMock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos }));
    const { backgroundCallSink } = await import('../../src/main/ipc/helpers/background-call-sink');
    const context = { projectRepo: { getById: vi.fn(() => undefined) } } as unknown as Parameters<typeof backgroundCallSink>[0];

    backgroundCallSink(context)('project-gone', call());

    // Opening a deleted project's database would create an empty one again.
    expect(getProjectRepos).not.toHaveBeenCalled();
    vi.doUnmock('../../src/main/ipc/helpers/project-repos');
  });
});

describe('foldBackgroundUsage', () => {
  const group = (overrides: Partial<Parameters<typeof foldBackgroundUsage>[0][number]>) => ({
    bucketStartMs: new Date(2026, 9, 13, 10, 0).getTime(),
    job: 'condition_check',
    agent: 'claude',
    modelId: 'claude-haiku-5-5',
    calls: 1,
    failedCalls: 0,
    reportedCalls: 1,
    inputTokens: 10,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 30,
    outputTokens: 5,
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
  });

  it('lists every job in order, a job with no calls at zero', () => {
    const usage = foldBackgroundUsage([group({})]);

    expect(usage.byJob.map((row) => row.job)).toEqual(['condition_check', 'workflow_step', 'task_summary', 'task_title', 'terminal_name']);
    expect(usage.byJob[0]).toMatchObject({ calls: 1, costUsd: 0.01 });
    expect(usage.byJob[1]).toMatchObject({ calls: 0, costUsd: null, models: [] });
  });

  it('folds buckets into local days, newest first, jobs in order within a day', () => {
    const usage = foldBackgroundUsage([
      group({ bucketStartMs: new Date(2026, 9, 12, 9, 0).getTime(), job: 'task_title' }),
      group({ bucketStartMs: new Date(2026, 9, 13, 9, 0).getTime(), job: 'task_title' }),
      group({ bucketStartMs: new Date(2026, 9, 13, 23, 45).getTime() }),
      group({ bucketStartMs: new Date(2026, 9, 13, 0, 15).getTime() }),
    ]);

    expect(usage.byDay.map((row) => [new Date(row.dayStartMs).getDate(), row.job, row.calls])).toEqual([
      [13, 'condition_check', 2],
      [13, 'task_title', 1],
      [12, 'task_title', 1],
    ]);
    expect(usage.totals.calls).toBe(4);
  });

  it('counts a model and its context-window variant as one', () => {
    const usage = foldBackgroundUsage([
      group({ modelId: 'claude-opus-4-8', calls: 2 }),
      group({ modelId: 'claude-opus-4-8[1m]', calls: 3, bucketStartMs: new Date(2026, 9, 13, 11, 0).getTime() }),
      group({ modelId: 'claude-haiku-5-5', calls: 1, bucketStartMs: new Date(2026, 9, 13, 12, 0).getTime() }),
    ]);

    expect(usage.byJob[0].models).toEqual([
      { agent: 'claude', modelId: 'claude-opus-4-8', calls: 5 },
      { agent: 'claude', modelId: 'claude-haiku-5-5', calls: 1 },
    ]);
  });

  it('keeps cost null when no call reported one, and leaves out a job this build does not know', () => {
    const usage = foldBackgroundUsage([
      group({ costUsd: null, reportedCalls: 0 }),
      group({ job: 'a_future_job' }),
    ]);

    expect(usage.totals).toMatchObject({ calls: 1, costUsd: null, reportedCalls: 0 });
  });
});
