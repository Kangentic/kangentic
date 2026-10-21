/**
 * The completed task view's report, assembled from rows (`assembleTaskReport`).
 * Fixtures follow #797's shape: a main conversation resumed across three runs,
 * an isolated Code Review conversation, and a column move log.
 */

import { describe, it, expect } from 'vitest';
import { assembleTaskReport, assembleTaskRoute, type TaskReportInput } from '../../src/main/ipc/helpers/task-report-assemble';
import type { TaskBackgroundCallRow } from '../../src/main/db/repositories/background-call-repository';
import type { AutomationRun, SessionRecord, Swimlane, TaskMoveRecord } from '../../src/shared/types';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-13T03:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

function lane(id: string, name: string, position: number, role: Swimlane['role'] = null): Swimlane {
  return { id, name, position, role, color: '#888888', icon: null } as unknown as Swimlane;
}

const SWIMLANES: Swimlane[] = [
  lane('todo', 'To Do', 0, 'todo'),
  lane('planning', 'Planning', 1),
  lane('executing', 'Executing', 2),
  lane('review', 'Code Review', 3),
  lane('testing', 'Testing', 4),
  lane('merge', 'Merge', 5),
  lane('done', 'Done', 6, 'done'),
];

function move(id: string, to: string, minutes: number, from: string | null = null): TaskMoveRecord {
  return { id, task_id: 'task-797', from_swimlane_id: from, to_swimlane_id: to, origin: 'user', reason: null, at: at(minutes) } as unknown as TaskMoveRecord;
}

function session(overrides: Partial<SessionRecord> & { id: string; started_at: string }): SessionRecord {
  return {
    task_id: 'task-797',
    session_type: 'claude',
    agent_session_id: null,
    isolated_swimlane_id: null,
    command: 'claude',
    cwd: '/mock/project',
    permission_mode: 'plan',
    status: 'exited',
    exit_code: null,
    suspended_at: null,
    exited_at: null,
    total_cost_usd: null,
    total_duration_ms: null,
    total_input_tokens: null,
    total_output_tokens: null,
    model_id: 'claude-opus-5-5',
    model_display_name: 'Opus 5.5',
    applied_effort: 'xhigh',
    tool_call_count: 0,
    compaction_count: 0,
    tool_breakdown: null,
    ...overrides,
  } as unknown as SessionRecord;
}

function baseInput(overrides: Partial<TaskReportInput> = {}): TaskReportInput {
  return {
    sessions: [],
    swimlanes: SWIMLANES,
    moves: [],
    summary: null,
    automationRuns: [],
    conditionsByAutomationId: new Map(),
    backgroundCalls: [],
    ledger: null,
    knowledge: null,
    summaryState: { kind: 'pending' },
    nowMs: T0 + 1_000 * MINUTE,
    ...overrides,
  };
}

/** One automation run; `callId` names the condition check behind it, or null for a run from before the call ledger. */
function automationRun(id: string, name: string, minutes: number, met: boolean | null, callId: string | null, overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    automation_id: `automation-${name}`,
    automation_name: name,
    type: 'move_to_column',
    task_id: 'task-797',
    swimlane_id: 'executing',
    trigger: 'turn_end',
    status: met ? 'succeeded' : 'skipped',
    detail: null,
    attempts: 1,
    started_at: at(minutes),
    finished_at: at(minutes),
    condition_met: met,
    condition_reason: null,
    check: callId === null ? null : {
      callId, agent: 'claude', model: 'claude-haiku-5-5-20260101', modelReported: true, effort: 'low',
      inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 14_000, outputTokens: 50,
      costUsd: 0.004, durationMs: 4_800, outcome: 'succeeded', rowsAnswered: 2,
    },
    ...overrides,
  } as unknown as AutomationRun;
}

/** One row of the task's background calls. */
function backgroundCall(overrides: Partial<TaskBackgroundCallRow> & { id: string; job: string }): TaskBackgroundCallRow {
  return { swimlaneId: null, modelId: 'claude-haiku-5-5', effort: 'low', tokens: 100, costUsd: 0.001, durationMs: 1_000, startedAt: at(0), ...overrides };
}

const MOVES_797 = [
  move('m0', 'todo', 0),
  move('m1', 'planning', 4, 'todo'),
  move('m2', 'executing', 24, 'planning'),
  move('m3', 'review', 83, 'executing'),
  move('m4', 'testing', 107, 'review'),
  move('m5', 'merge', 122, 'testing'),
  move('m6', 'done', 123, 'merge'),
];

const SESSIONS_797 = [
  session({ id: 'leg-1', agent_session_id: 'main', started_at: at(4), suspended_at: at(16), total_cost_usd: 1.85, total_duration_ms: 12 * MINUTE, tool_call_count: 23 }),
  session({ id: 'leg-2', agent_session_id: 'main', started_at: at(18), suspended_at: at(83), total_cost_usd: 26.04, total_duration_ms: 77 * MINUTE, tool_call_count: 241, compaction_count: 1 }),
  session({ id: 'review-run', agent_session_id: 'review', isolated_swimlane_id: 'review', started_at: at(83), exited_at: at(107), total_cost_usd: 16.74, total_duration_ms: 24 * MINUTE, tool_call_count: 274, permission_mode: 'auto' }),
  session({ id: 'leg-3', agent_session_id: 'main', started_at: at(107), suspended_at: at(123), total_cost_usd: 30.84, total_duration_ms: 93 * MINUTE, tool_call_count: 92, model_id: 'claude-sonnet-5-5', model_display_name: 'Sonnet 5.5', applied_effort: 'high' }),
];

describe('assembleTaskRoute (sessions.getTaskRoute)', () => {
  it('is the report\'s own route, so the conversation window\'s tabs match the Route card\'s pills', () => {
    const input = baseInput({ moves: MOVES_797, sessions: SESSIONS_797 });

    expect(assembleTaskRoute(input)).toEqual(assembleTaskReport(input).route);
  });

  it('reads only the moves and the columns: no sessions, ledger or index', () => {
    const route = assembleTaskRoute({ swimlanes: SWIMLANES, moves: MOVES_797, nowMs: T0 + 1_000 * MINUTE });

    expect(route.map((column) => column.name)).toEqual(['Planning', 'Executing', 'Code Review', 'Testing', 'Merge']);
    expect(route[1].visits).toEqual([{ startedAt: at(24), durationMs: 59 * MINUTE }]);
  });
});

describe('assembleTaskReport', () => {
  it('spans the first move into a working column to the last move into Done', () => {
    const report = assembleTaskReport(baseInput({ moves: MOVES_797, sessions: SESSIONS_797 }));

    expect(report.startedAt).toBe(at(4));
    expect(report.endedAt).toBe(at(123));
  });

  it('starts a task created straight into a working column at that move', () => {
    const report = assembleTaskReport(baseInput({ moves: [move('born', 'planning', 2), move('m6', 'done', 30, 'planning')] }));

    expect(report.startedAt).toBe(at(2));
    expect(report.endedAt).toBe(at(30));
  });

  it('falls back to the sessions when the task has no column moves', () => {
    const report = assembleTaskReport(baseInput({ sessions: SESSIONS_797 }));

    expect(report.startedAt).toBe(at(4));
    expect(report.endedAt).toBe(at(123));
    expect(report.route).toEqual([]);
  });

  it('lists the working columns in board order, To Do and Done left out, with each total', () => {
    const report = assembleTaskReport(baseInput({ moves: MOVES_797 }));

    expect(report.route.map((column) => column.name)).toEqual(['Planning', 'Executing', 'Code Review', 'Testing', 'Merge']);
    expect(report.route.map((column) => column.totalMs)).toEqual([20, 59, 24, 15, 1].map((minutes) => minutes * MINUTE));
  });

  it('keeps each visit to a column, in the order they happened', () => {
    const moves = [
      move('a', 'executing', 0),
      move('b', 'review', 30, 'executing'),
      move('c', 'executing', 60, 'review'),
      move('d', 'review', 70, 'executing'),
      move('e', 'done', 100, 'review'),
    ];
    const report = assembleTaskReport(baseInput({ moves }));
    const review = report.route.find((column) => column.name === 'Code Review');

    expect(review?.visits).toEqual([
      { startedAt: at(30), durationMs: 30 * MINUTE },
      { startedAt: at(70), durationMs: 30 * MINUTE },
    ]);
    expect(review?.totalMs).toBe(60 * MINUTE);
  });

  it('groups runs by conversation, each run with its own share of the cost and runtime', () => {
    const report = assembleTaskReport(baseInput({ moves: MOVES_797, sessions: SESSIONS_797 }));
    const [main, review] = report.conversations;

    expect(main.conversationId).toBe('main');
    expect(main.isolatedColumn).toBeNull();
    expect(main.runs.map((run) => run.recordId)).toEqual(['leg-1', 'leg-2', 'leg-3']);
    expect(main.runs[1].costUsd).toBeCloseTo(24.19, 10);
    expect(main.runs[2].costUsd).toBeCloseTo(4.80, 10);
    expect(main.runs[1].runtimeMs).toBe(65 * MINUTE);
    expect(main.runs[2].model).toBe('Sonnet 5.5');
    expect(main.runs[2].effort).toBe('high');

    expect(review.conversationId).toBe('review');
    expect(review.isolatedColumn?.name).toBe('Code Review');
    expect(review.runs[0].costUsd).toBeCloseTo(16.74, 10);
  });

  it('names the columns a run overlapped, and an isolated run by its own column', () => {
    const report = assembleTaskReport(baseInput({ moves: MOVES_797, sessions: SESSIONS_797 }));
    const runs = report.conversations.flatMap((conversation) => conversation.runs);
    const columnsOf = (recordId: string) => runs.find((run) => run.recordId === recordId)?.columns.map((column) => column.name);

    expect(columnsOf('leg-1')).toEqual(['Planning']);
    expect(columnsOf('leg-2')).toEqual(['Planning', 'Executing']);
    expect(columnsOf('leg-3')).toEqual(['Testing', 'Merge']);
    expect(columnsOf('review-run')).toEqual(['Code Review']);
  });

  it('leaves out a column a run only touched as it ended, and names a short run for its longest stay', () => {
    const moves = [move('a', 'executing', 0), move('b', 'review', 30, 'executing'), move('c', 'done', 60, 'review')];
    const sessions = [
      // Suspended 300 ms after the task entered Code Review, as a move into an isolated column does.
      session({ id: 'main', agent_session_id: 'main', started_at: at(0), suspended_at: new Date(T0 + 30 * MINUTE + 300).toISOString(), total_cost_usd: 1, total_duration_ms: 1 }),
      // A five-second run across the move: most of it in Code Review.
      session({ id: 'blip', agent_session_id: 'blip', started_at: new Date(T0 + 30 * MINUTE - 1_000).toISOString(), suspended_at: new Date(T0 + 30 * MINUTE + 4_000).toISOString(), total_cost_usd: 1, total_duration_ms: 1 }),
    ];
    const report = assembleTaskReport(baseInput({ moves, sessions }));
    const runs = report.conversations.flatMap((conversation) => conversation.runs);
    const columnsOf = (recordId: string) => runs.find((run) => run.recordId === recordId)?.columns.map((column) => column.name);

    expect(columnsOf('main')).toEqual(['Executing']);
    expect(columnsOf('blip')).toEqual(['Code Review']);
  });

  it('starts at the first session when the move log begins after it', () => {
    const moves = [move('late', 'executing', 600), move('done', 'done', 700, 'executing')];
    const sessions = [session({ id: 'early', agent_session_id: 'early', started_at: at(4), suspended_at: at(700), total_cost_usd: 1, total_duration_ms: 1 })];
    const report = assembleTaskReport(baseInput({ moves, sessions }));

    expect(report.startedAt).toBe(at(4));
    expect(report.endedAt).toBe(at(700));
  });

  it('keeps each run\'s own exit code, so a crashed earlier run shows though the task ended cleanly', () => {
    const sessions = [
      session({ id: 'crashed', agent_session_id: 'main', started_at: at(0), exited_at: at(10), exit_code: 1073807364, total_cost_usd: 1, total_duration_ms: 1 }),
      session({ id: 'clean', agent_session_id: 'main', started_at: at(20), suspended_at: at(30), total_cost_usd: 2, total_duration_ms: 2 }),
    ];
    const runs = assembleTaskReport(baseInput({ sessions })).conversations[0].runs;

    expect(runs.map((run) => [run.recordId, run.exitCode])).toEqual([['crashed', 1073807364], ['clean', null]]);
  });

  it('knows no column for a main run when the task has no column moves', () => {
    const report = assembleTaskReport(baseInput({ sessions: SESSIONS_797 }));

    expect(report.conversations[0].runs.every((run) => run.columns.length === 0)).toBe(true);
  });

  it('leaves out a session that never reported usage', () => {
    const sessions = [...SESSIONS_797, session({ id: 'empty', agent_session_id: 'main', started_at: at(20) })];
    const report = assembleTaskReport(baseInput({ sessions }));

    expect(report.conversations[0].runs.map((run) => run.recordId)).toEqual(['leg-1', 'leg-2', 'leg-3']);
  });

  it('lists every automation a check was asked about, with its outcome and the agent\'s reason, plus a title call, oldest first', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [
        automationRun('r1', 'Apply findings', 70, true, 'call-1', { condition_reason: 'The reply lists two findings.' }),
        // The same check answered this one too: one call, two rows.
        automationRun('r2', 'On to Code Review', 70, false, 'call-1', { condition_reason: 'The reply does not end with "Findings: applied".' }),
        automationRun('r3', 'On to Code Review', 79, true, 'call-2'),
        automationRun('r4', 'On to Code Review', 75, false, 'call-3'),
      ],
      conditionsByAutomationId: new Map([['automation-Apply findings', 'The final message lists findings.']]),
      backgroundCalls: [
        { id: 'call-1', job: 'condition_check', swimlaneId: 'executing', modelId: 'claude-haiku-5-5', effort: 'low', tokens: 14_060, costUsd: 0.004, durationMs: 4_800, startedAt: at(70) },
        { id: 'call-title', job: 'task_title', swimlaneId: null, modelId: 'claude-haiku-5-5', effort: 'low', tokens: 2_100, costUsd: 0.001, durationMs: 2_400, startedAt: at(-1) },
      ],
    }));

    expect(report.backgroundCalls.map((call) => [call.automationName, call.outcome])).toEqual([
      [null, null],
      ['Apply findings', 'ran'],
      ['On to Code Review', 'skipped'],
      ['On to Code Review', 'skipped'],
      ['On to Code Review', 'ran'],
    ]);
    const [title, applyFindings, notMet] = report.backgroundCalls;
    expect(title.job).toBe('task_title');
    expect(title.column).toBeNull();
    expect(title.model).toBe('Haiku 5.5');
    expect(title.reason).toBeNull();
    expect(applyFindings.column?.name).toBe('Executing');
    expect(applyFindings.condition).toBe('The final message lists findings.');
    expect(applyFindings.reason).toBe('The reply lists two findings.');
    expect(applyFindings.tokens).toBe(14_060);
    expect(applyFindings.callId).toBe('call-1');
    expect(notMet.callId).toBe('call-1');
    expect(notMet.reason).toBe('The reply does not end with "Findings: applied".');
  });

  it('merges the ledger by model label, the main thread apart from each subagent type', () => {
    const report = assembleTaskReport(baseInput({
      sessions: SESSIONS_797,
      ledger: [
        { modelId: 'claude-opus-5-5', subagentType: null, turns: 200, freshInputTokens: 400, cacheWriteTokens: 900, cacheReadTokens: 70_000, outputTokens: 200 },
        { modelId: 'claude-opus-5-5[1m]', subagentType: null, turns: 37, freshInputTokens: 98, cacheWriteTokens: 84, cacheReadTokens: 6_600, outputTokens: 33 },
        { modelId: 'claude-haiku-5-5-20260101', subagentType: 'doc-auditor', turns: 11, freshInputTokens: 26, cacheWriteTokens: 203, cacheReadTokens: 1_640, outputTokens: 34 },
      ],
    }));

    expect(report.models).toEqual([
      { model: 'Opus 5.5', subagent: null, turns: 237, freshInputTokens: 498, cacheWriteTokens: 984, cacheReadTokens: 76_600, outputTokens: 233 },
      { model: 'Haiku 5.5', subagent: 'doc-auditor', turns: 11, freshInputTokens: 26, cacheWriteTokens: 203, cacheReadTokens: 1_640, outputTokens: 34 },
    ]);
  });

  it('reads no models when the ledger cannot be read, and falls back to the session rows', () => {
    const sessions = SESSIONS_797.map((record) => ({ ...record, total_input_tokens: 1_000, total_output_tokens: 100 }));
    const report = assembleTaskReport(baseInput({ sessions, ledger: null }));

    expect(report.models).toBeNull();
    // Each conversation's latest reading: main's leg-3 (Sonnet) and the review run (Opus).
    expect(report.modelFallback).toEqual(expect.arrayContaining([
      { model: 'Sonnet 5.5', inputWithCacheTokens: 1_000, outputTokens: 100 },
      { model: 'Opus 5.5', inputWithCacheTokens: 1_000, outputTokens: 100 },
    ]));
    expect(report.modelFallback).toHaveLength(2);
  });
});

describe('assembleTaskReport background calls', () => {
  it('leaves out a condition check or a workflow step no automation run names, and keeps a title call', () => {
    const report = assembleTaskReport(baseInput({
      backgroundCalls: [
        backgroundCall({ id: 'call-orphan-check', job: 'condition_check', startedAt: at(1) }),
        backgroundCall({ id: 'call-orphan-step', job: 'workflow_step', startedAt: at(2) }),
        backgroundCall({ id: 'call-title', job: 'task_title', startedAt: at(3) }),
      ],
    }));

    // The title call is the positive control: it proves the list is not simply empty.
    expect(report.backgroundCalls.map((call) => call.callId)).toEqual(['call-title']);
  });

  it('shows a fired automation from before the call ledger with no call, tokens, runtime or cost', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [automationRun('legacy', 'Legacy check', 5, true, null)],
    }));

    expect(report.backgroundCalls).toHaveLength(1);
    expect(report.backgroundCalls[0]).toMatchObject({
      automationName: 'Legacy check',
      job: 'condition_check',
      callId: null,
      tokens: null,
      durationMs: null,
      costUsd: null,
      model: null,
      effort: null,
    });
  });

  it('reads a check that gave no answer as an error, with the skip the runner recorded as its reason', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [
        // The runner writes a detail on every run: a success line for a fired one, "Condition not met." for a skipped one with no reason.
        automationRun('r-fired', 'Fired', 10, true, 'call-fired', { detail: 'Sent.' }),
        automationRun('r-unmet', 'Not met', 11, false, 'call-unmet', { detail: 'Condition not met.' }),
        // The runner keeps the call of a check that failed, and records the row as skipped with no answer.
        automationRun('r-failed', 'Check failed', 12, null, 'call-failed', { detail: 'The Automation agent could not check the condition: timed out' }),
      ],
      backgroundCalls: [
        backgroundCall({ id: 'call-fired', job: 'condition_check', startedAt: at(10) }),
        backgroundCall({ id: 'call-unmet', job: 'condition_check', startedAt: at(11) }),
        backgroundCall({ id: 'call-failed', job: 'condition_check', startedAt: at(12) }),
      ],
    }));

    expect(report.backgroundCalls.map((call) => [call.automationName, call.outcome])).toEqual([
      ['Fired', 'ran'],
      ['Not met', 'skipped'],
      ['Check failed', 'error'],
    ]);
    expect(report.backgroundCalls[2].reason).toBe('The Automation agent could not check the condition: timed out');
    // With no reason from the agent, an answered row reads the runner's own outcome line.
    expect(report.backgroundCalls[0].reason).toBe('Sent.');
    expect(report.backgroundCalls[1].reason).toBe('Condition not met.');
  });

  it('reads an error from the run detail first, and the answered reason only when there is no detail', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [
        automationRun('r-detail', 'With detail', 10, null, 'call-a', { condition_reason: 'x reason', detail: 'y detail' }),
        automationRun('r-none', 'No detail', 11, null, 'call-b', { condition_reason: 'x reason', detail: null }),
      ],
      backgroundCalls: [
        backgroundCall({ id: 'call-a', job: 'condition_check', startedAt: at(10) }),
        backgroundCall({ id: 'call-b', job: 'condition_check', startedAt: at(11) }),
      ],
    }));

    expect(report.backgroundCalls.map((call) => [call.outcome, call.reason])).toEqual([
      ['error', 'y detail'],
      ['error', 'x reason'],
    ]);
  });

  it('reads the run status for an automation whose Condition was met: ran, skipped by a later gate, failed, or interrupted', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [
        automationRun('r-ran', 'Ran', 10, true, 'call-1', { condition_reason: 'It applies.', detail: 'exit 0' }),
        // A met Condition a later gate stopped: the reason is the gate's, not the answer's.
        automationRun('r-gate', 'Gated', 11, true, 'call-2', { status: 'skipped', condition_reason: 'It applies.', detail: 'Already ran this visit.' }),
        automationRun('r-failed', 'Failed', 12, true, 'call-3', { status: 'failed', condition_reason: 'It applies.', detail: 'exit 1' }),
        automationRun('r-interrupted', 'Interrupted', 13, true, 'call-4', { status: 'interrupted', condition_reason: 'It applies.', detail: null }),
      ],
      backgroundCalls: ['call-1', 'call-2', 'call-3', 'call-4'].map((id, index) => backgroundCall({ id, job: 'condition_check', startedAt: at(10 + index) })),
    }));

    expect(report.backgroundCalls.map((call) => [call.automationName, call.outcome, call.reason])).toEqual([
      ['Ran', 'ran', 'It applies.'],
      ['Gated', 'skipped', 'Already ran this visit.'],
      ['Failed', 'error', 'exit 1'],
      ['Interrupted', 'error', 'It applies.'],
    ]);
  });

  it('lists no row for an automation that was never asked (no answer and no check), as for one with no Condition', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [
        automationRun('r-asked', 'Asked', 10, false, 'call-asked'),
        // A spent Frequency or a column that cannot run it: skipped before any check.
        automationRun('r-never', 'Never asked', 11, null, null, { detail: 'This automation has run its limit on this task.' }),
      ],
    }));

    expect(report.backgroundCalls.map((call) => call.automationName)).toEqual(['Asked']);
  });
});

describe('assembleTaskReport models', () => {
  const COUNTS = { turns: 3, freshInputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 30, outputTokens: 40 };

  it('reads a ledger row that named no model as Unknown model', () => {
    const report = assembleTaskReport(baseInput({
      sessions: SESSIONS_797,
      ledger: [{ modelId: null, subagentType: null, ...COUNTS }],
    }));

    expect(report.models).toEqual([{ model: 'Unknown model', subagent: null, ...COUNTS }]);
  });

  it('reads a subagent of no known type as subagent, apart from the main thread on the same model', () => {
    const report = assembleTaskReport(baseInput({
      sessions: SESSIONS_797,
      ledger: [
        { modelId: 'claude-opus-5-5', subagentType: '', ...COUNTS },
        { modelId: 'claude-opus-5-5', subagentType: null, ...COUNTS },
      ],
    }));

    expect(report.models).toEqual([
      { model: 'Opus 5.5', subagent: 'subagent', ...COUNTS },
      { model: 'Opus 5.5', subagent: null, ...COUNTS },
    ]);
  });

  it('reads an empty ledger as no models, and an unreadable one as unknown', () => {
    const empty = assembleTaskReport(baseInput({ ledger: [] }));
    const unreadable = assembleTaskReport(baseInput({ ledger: null }));

    expect(empty.models).not.toBeNull();
    expect(empty.models).toEqual([]);
    expect(unreadable.models).toBeNull();
  });

  it('takes a conversation\'s latest reading from the rows that reported usage, not from a newer row with tokens and no cost', () => {
    const sessions = [
      session({ id: 'costed', agent_session_id: 'main', started_at: at(0), suspended_at: at(10), total_cost_usd: 1, total_duration_ms: MINUTE, total_input_tokens: 1_000, total_output_tokens: 100 }),
      // The newest row of the conversation, on another model, with tokens but no cost.
      session({ id: 'uncosted', agent_session_id: 'main', started_at: at(20), suspended_at: at(30), total_cost_usd: null, total_input_tokens: 9_000, total_output_tokens: 900, model_id: 'claude-sonnet-5-5', model_display_name: 'Sonnet 5.5' }),
    ];
    const report = assembleTaskReport(baseInput({ sessions }));

    expect(report.modelFallback).toEqual([{ model: 'Opus 5.5', inputWithCacheTokens: 1_000, outputTokens: 100 }]);
  });

  it('breaks a tie between a conversation\'s records that started together on the greater id, whatever order the records come in', () => {
    // The summary reads the newest record by `ORDER BY started_at DESC, id DESC`, and the
    // report's sessions arrive in any order, so the pick cannot depend on which comes first.
    const lesserId = session({ id: 'run-a', agent_session_id: 'main', started_at: at(0), total_cost_usd: 1, total_duration_ms: MINUTE, total_input_tokens: 1_000, total_output_tokens: 100 });
    const greaterId = session({ id: 'run-b', agent_session_id: 'main', started_at: at(0), total_cost_usd: 2, total_duration_ms: MINUTE, total_input_tokens: 2_000, total_output_tokens: 200 });

    const lesserFirst = assembleTaskReport(baseInput({ sessions: [lesserId, greaterId] }));
    const greaterFirst = assembleTaskReport(baseInput({ sessions: [greaterId, lesserId] }));

    const expected = [{ model: 'Opus 5.5', inputWithCacheTokens: 2_000, outputTokens: 200 }];
    expect(lesserFirst.modelFallback).toEqual(expected);
    expect(greaterFirst.modelFallback).toEqual(expected);
  });
});

describe('assembleTaskReport runs', () => {
  it('skips a prior leg with a runtime but no cost: not shown, and not the baseline of the next leg\'s runtime', () => {
    const sessions = [
      session({ id: 'leg-a', agent_session_id: 'main', started_at: at(0), suspended_at: at(10), total_cost_usd: 2, total_duration_ms: 600_000 }),
      // Reported a runtime and no cost, so the task summary skips it too.
      session({ id: 'leg-b-no-cost', agent_session_id: 'main', started_at: at(20), suspended_at: at(30), total_cost_usd: null, total_duration_ms: 900_000 }),
      session({ id: 'leg-c', agent_session_id: 'main', started_at: at(40), suspended_at: at(50), total_cost_usd: 5, total_duration_ms: 1_000_000 }),
    ];
    const [main] = assembleTaskReport(baseInput({ sessions })).conversations;

    expect(main.runs.map((run) => run.recordId)).toEqual(['leg-a', 'leg-c']);
    expect(main.runs[1].runtimeMs).toBe(400_000);
    expect(main.runs[1].costUsd).toBeCloseTo(3, 10);
  });

  it('names a column again when one run worked in it, then in another, then back in it', () => {
    const moves = [
      move('a', 'executing', 0),
      move('b', 'review', 30, 'executing'),
      move('c', 'executing', 60, 'review'),
      move('d', 'done', 100, 'executing'),
    ];
    // One run alive across all three stays.
    const sessions = [session({ id: 'run', agent_session_id: 'main', started_at: at(0), suspended_at: at(90), total_cost_usd: 1, total_duration_ms: 1 })];
    const [main] = assembleTaskReport(baseInput({ moves, sessions })).conversations;

    expect(main.runs[0].columns).toHaveLength(3);
    expect(main.runs[0].columns.map((column) => column.name)).toEqual(['Executing', 'Code Review', 'Executing']);
  });
});

describe('assembleTaskReport totals', () => {
  it('totals every run of every conversation: runtime, cost, tool calls and compactions', () => {
    const report = assembleTaskReport(baseInput({ sessions: SESSIONS_797 }));

    // Each conversation's final reading, added up: main's leg-3 plus the review run.
    expect(report.totals.runs.runCount).toBe(4);
    expect(report.totals.runs.costUsd).toBeCloseTo(30.84 + 16.74, 10);
    expect(report.totals.runs.runtimeMs).toBe(93 * MINUTE + 24 * MINUTE);
    expect(report.totals.runs.toolCallCount).toBe(23 + 241 + 274 + 92);
    expect(report.totals.runs.compactionCount).toBe(1);
  });

  it('totals a runtime no run reported to null, and a run with none leaves the others\' sum', () => {
    const noRuntime = [
      session({ id: 'leg-1', agent_session_id: 'main', started_at: at(0), total_cost_usd: 1, total_duration_ms: null }),
      session({ id: 'leg-2', agent_session_id: 'other', started_at: at(10), total_cost_usd: 2, total_duration_ms: null }),
    ];
    expect(assembleTaskReport(baseInput({ sessions: noRuntime })).totals.runs.runtimeMs).toBeNull();

    const oneRuntime = [
      session({ id: 'leg-1', agent_session_id: 'main', started_at: at(0), total_cost_usd: 1.85, total_duration_ms: 722_000 }),
      session({ id: 'leg-2', agent_session_id: 'other', started_at: at(10), total_cost_usd: 2, total_duration_ms: null }),
    ];
    const total = assembleTaskReport(baseInput({ sessions: oneRuntime })).totals.runs;
    expect(total.runtimeMs).toBe(722_000);
    expect(total.costUsd).toBeCloseTo(3.85, 10);
  });

  it('totals no runs to null runtime and cost, and leaves a row with no cost out of the count', () => {
    const sessions = [session({ id: 'never-reported', agent_session_id: 'main', started_at: at(0), total_duration_ms: 60_000, tool_call_count: 5 })];
    const total = assembleTaskReport(baseInput({ sessions })).totals.runs;

    expect(total).toEqual({ runCount: 0, runtimeMs: null, costUsd: null, toolCallCount: 0, compactionCount: 0 });
  });

  it('adds up the merged ledger rows, and has no models total when the ledger cannot be read', () => {
    const ledger = [
      { modelId: 'claude-opus-5-5', subagentType: null, turns: 200, freshInputTokens: 400, cacheWriteTokens: 900, cacheReadTokens: 70_000, outputTokens: 200 },
      { modelId: 'claude-opus-5-5[1m]', subagentType: null, turns: 37, freshInputTokens: 98, cacheWriteTokens: 84, cacheReadTokens: 6_600, outputTokens: 33 },
      { modelId: 'claude-haiku-5-5-20260101', subagentType: 'doc-auditor', turns: 11, freshInputTokens: 26, cacheWriteTokens: 203, cacheReadTokens: 1_640, outputTokens: 34 },
    ];
    expect(assembleTaskReport(baseInput({ sessions: SESSIONS_797, ledger })).totals.models).toEqual({
      turns: 248, freshInputTokens: 524, cacheWriteTokens: 1_187, cacheReadTokens: 78_240, outputTokens: 267,
    });
    expect(assembleTaskReport(baseInput({ ledger: [] })).totals.models).toEqual({
      turns: 0, freshInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0,
    });
    expect(assembleTaskReport(baseInput({ ledger: null })).totals.models).toBeNull();
  });

  it('counts a check that answered two automations once, and adds a title call', () => {
    const report = assembleTaskReport(baseInput({
      automationRuns: [
        automationRun('r1', 'Apply findings', 70, true, 'call-1'),
        automationRun('r2', 'On to Code Review', 70, false, 'call-1'),
      ],
      backgroundCalls: [
        backgroundCall({ id: 'call-1', job: 'condition_check', startedAt: at(70) }),
        backgroundCall({ id: 'call-title', job: 'task_title', tokens: 2_100, costUsd: 0.001, durationMs: 2_400, startedAt: at(-1) }),
      ],
    }));

    expect(report.backgroundCalls).toHaveLength(3);
    const total = report.totals.backgroundCalls;
    // The check's figures come from its run (4,800 ms, $0.004, 14,060 tokens), counted once.
    expect(total.durationMs).toBe(4_800 + 2_400);
    expect(total.costUsd).toBeCloseTo(0.004 + 0.001, 10);
    expect(total.tokens).toBe(14_060 + 2_100);
  });

  it('counts each automation from before the call ledger on its own, and totals figures none reported to null', () => {
    const legacyOnly = assembleTaskReport(baseInput({
      automationRuns: [
        automationRun('legacy-1', 'Apply findings', 5, true, null),
        automationRun('legacy-2', 'On to Code Review', 5, true, null),
      ],
    }));
    expect(legacyOnly.backgroundCalls).toHaveLength(2);
    expect(legacyOnly.totals.backgroundCalls).toEqual({ durationMs: null, costUsd: null, tokens: null });

    const withTitle = assembleTaskReport(baseInput({
      automationRuns: [automationRun('legacy-1', 'Apply findings', 5, true, null)],
      backgroundCalls: [backgroundCall({ id: 'call-title', job: 'task_title', tokens: 2_100, costUsd: 0.001, durationMs: 2_400 })],
    }));
    expect(withTitle.totals.backgroundCalls).toEqual({ durationMs: 2_400, costUsd: 0.001, tokens: 2_100 });
  });
});
