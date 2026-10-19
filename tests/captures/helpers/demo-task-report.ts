/**
 * The completed task view's report for one archived contoso task, Set up CI/CD pipeline, which the
 * completed-task scenes open (tests/captures/scenes.ts). The mock derives a report for every other
 * archived task from its summary alone: one run, no route, no ledger, no calls and no commits,
 * which is all a recorded headless run can say. A figure of the view needs the rest, so this one
 * task carries a whole record, and the scenes seed it (`__mockTaskReports`).
 *
 * What is the run's own (task-cw-done-deploy in archived/runs.json, its clone, its transcript):
 * - The header strip's cost, runtime and churn: the Completed Tasks row's own summary, which the
 *   mock hands the report by reference, so the strip and the row cannot disagree.
 * - The four runs: the one headless run, cut at the three points its transcript changes phase
 *   (validating the workflow it wrote, applying what that found, the final review pass). Each
 *   runtime is the span between those timestamps, each phase's tool calls are the calls it made,
 *   and its tokens are its turns' tokens. Each cost is a literal worked out when the run was split,
 *   which shared the run's $2.12 by each phase's tokens at Opus's relative prices and rounded it to
 *   the cent by largest remainder. tests/unit/demo-archived-summaries.test.ts holds the four runs
 *   to the row.
 * - Models and tokens: main's ledger over the transcript (`extractTurnUsageRecords`, grouped as
 *   `getTaskModelUsage` groups it). The run made every turn on one model, so there is one row.
 * - Files changed: the clone's git status, most-changed first.
 * - The summary and the two condition reasons say what the transcript's own notes say.
 *
 * What is authored, since no recording holds it: which column each phase ran in, the second
 * conversation (one headless run is one conversation), the time between runs, the moves, the two
 * commits (the run committed nothing), the three background calls, and the summary's wording.
 *
 * Main assembles the report (`assembleTaskReport`) from these rows, so the route, each run's
 * columns, each run's share of its conversation's cumulative readings, the call outcomes and
 * every total are main's arithmetic. Every time is an offset from a fixed anchor; the mock moves
 * them so the Done move lands on the archived row's own `archived_at`.
 */
import { assembleTaskReport } from '../../../src/main/ipc/helpers/task-report-assemble';
import type { TaskReportSessionRecord } from '../../../src/main/db/repositories/session-repository';
import type { TaskBackgroundCallRow } from '../../../src/main/db/repositories/background-call-repository';
import type { TaskModelUsageRow } from '../../../src/main/retrieval/conversation/conversation-usage-store';
import type { TaskKnowledge } from '../../../src/main/retrieval/task-knowledge';
import type { AutomationRun, Swimlane, TaskMoveRecord, TaskReport } from '../../../src/shared/types';
import {
  DEMO_ARCHIVED_RUNS, DEMO_ARCHIVED_SUMMARIES, DEMO_LANES_BY_PROJECT, PROJECT_CONTOSO,
  archivedSessionIdOf, archivedToolBreakdown, demoLaneId, type DemoArchivedSummary,
} from './demo-dataset';

export const DEMO_COMPLETED_TASK_ID = 'task-cw-done-deploy';

/** The task's Completed Tasks row. It fails loudly without its recorded run, since there is nothing to split. */
function recordedSummary(): DemoArchivedSummary {
  const found = DEMO_ARCHIVED_SUMMARIES.find((candidate) => candidate.taskId === DEMO_COMPLETED_TASK_ID);
  if (!found || !DEMO_ARCHIVED_RUNS[DEMO_COMPLETED_TASK_ID]) throw new Error(`${DEMO_COMPLETED_TASK_ID} has no recorded run; re-run scripts/capture-demo-archived-runs.mjs`);
  return found;
}

/** The task's Completed Tasks row, which the header strip reads and the runs add back to. */
export const DEMO_COMPLETED_TASK_SUMMARY: DemoArchivedSummary = recordedSummary();
const run = DEMO_ARCHIVED_RUNS[DEMO_COMPLETED_TASK_ID];

/** The move into Executing. Every time below is an offset from it; the mock re-anchors them. */
const ANCHOR_MS = Date.parse('2026-10-05T13:18:47.000Z');
const timestampAt = (offsetMs: number): string => new Date(ANCHOR_MS + offsetMs).toISOString();
const ONE_DAY_MS = 86_400_000;

const EXECUTING = demoLaneId(PROJECT_CONTOSO, 'executing');
const REVIEW = demoLaneId(PROJECT_CONTOSO, 'review');
const TODO = demoLaneId(PROJECT_CONTOSO, 'todo');
const DONE = demoLaneId(PROJECT_CONTOSO, 'done');

/** The Done move: ten minutes after the last run's turn ended, where the dataset puts the run's exit. */
const DONE_MS = 1_272_000;

/** The headless run's main conversation; the review conversation is the authored second one. */
const MAIN_CONVERSATION = run.agentSessionId;
const REVIEW_CONVERSATION = 'c3b7e2a9-4f1d-4e8b-9a6c-2d5f0e7b1a43';

interface RunPhase {
  recordId: string;
  column: 'executing' | 'review';
  /** When its session started and when it was suspended or exited, from the anchor. */
  startMs: number;
  endMs: number;
  /** The phase's own share of the run, from the transcript. */
  runtimeMs: number;
  costUsd: number;
  /** Fresh, cache write and cache read together, as the summary counts input. */
  inputTokens: number;
  outputTokens: number;
  tools: Record<string, number>;
  exited: boolean;
}

/**
 * The run's four phases. The transcript's cut points: 13:21:33.351 ("Now let me validate the YAML
 * and the smoke-test logic locally"), 13:24:46.585 ("Both paths verified. Updating the workflow to
 * the tested script"), and 13:25:08.205 ("Let me do a final review check"); the run started at
 * 13:18:52.334 and lasted 451,983 ms. The last record is the summary's own session id.
 */
const PHASES: RunPhase[] = [
  { recordId: `${archivedSessionIdOf(DEMO_COMPLETED_TASK_ID)}-executing-1`, column: 'executing', startMs: 5_000, endMs: 240_000, runtimeMs: 161_017, costUsd: 0.77, inputTokens: 472_050, outputTokens: 4_982, tools: { Bash: 9, Read: 1, Write: 2 }, exited: false },
  { recordId: `${archivedSessionIdOf(DEMO_COMPLETED_TASK_ID)}-review-1`, column: 'review', startMs: 245_000, endMs: 445_000, runtimeMs: 193_234, costUsd: 0.52, inputTokens: 454_929, outputTokens: 3_947, tools: { Bash: 7, Read: 1, ToolSearch: 1, TaskStop: 1 }, exited: false },
  { recordId: `${archivedSessionIdOf(DEMO_COMPLETED_TASK_ID)}-executing-2`, column: 'executing', startMs: 450_000, endMs: 590_000, runtimeMs: 21_620, costUsd: 0.23, inputTokens: 199_135, outputTokens: 1_813, tools: { Bash: 2, Edit: 2 }, exited: false },
  { recordId: archivedSessionIdOf(DEMO_COMPLETED_TASK_ID), column: 'review', startMs: 595_000, endMs: DONE_MS, runtimeMs: 76_112, costUsd: 0.6, inputTokens: 548_692, outputTokens: 3_853, tools: { Bash: 2, Edit: 3, ToolSearch: 1, WebFetch: 3, WebSearch: 1 }, exited: true },
];
const [FIRST_BUILD, FIRST_REVIEW, SECOND_BUILD] = PHASES;

/** Code Review's turn-end check that sent the task back, in the seconds before that move. */
const SENT_BACK_CHECK_MS = FIRST_REVIEW.endMs - 6_000;
/** The final review's first turn end, whose check found nothing more to send back. */
const PASSED_CHECK_MS = 672_000;

/** Every column of the contoso board, with the fields the assembler reads (id, name, color, icon, role, position). */
const SWIMLANES: Swimlane[] = DEMO_LANES_BY_PROJECT[PROJECT_CONTOSO].map((lane, position) => ({
  id: demoLaneId(PROJECT_CONTOSO, lane.slug), name: lane.name, description: null, role: lane.role, position,
  color: lane.color, icon: lane.icon, is_archived: lane.is_archived, is_ghost: false, permission_mode: null,
  auto_spawn: lane.auto_spawn, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null,
  plan_approval: 'manual', agent_override: lane.agent, model_override: null, effort_override: null, handoff_context: false,
  session_target: lane.slug === 'review' ? 'isolated' : 'main', session_spawn_strategy: 'create_or_resume',
  created_at: timestampAt(-ONE_DAY_MS),
}));

/** Each move ends the phase before it, so a run's session and its column stay in step. */
const MOVES: TaskMoveRecord[] = [
  { id: 'move-1', task_id: DEMO_COMPLETED_TASK_ID, from_swimlane_id: TODO, to_swimlane_id: EXECUTING, origin: 'renderer', reason: null, at: timestampAt(0) },
  { id: 'move-2', task_id: DEMO_COMPLETED_TASK_ID, from_swimlane_id: EXECUTING, to_swimlane_id: REVIEW, origin: 'renderer', reason: null, at: timestampAt(FIRST_BUILD.endMs) },
  { id: 'move-3', task_id: DEMO_COMPLETED_TASK_ID, from_swimlane_id: REVIEW, to_swimlane_id: EXECUTING, origin: 'automation', reason: 'Back for revisions', at: timestampAt(FIRST_REVIEW.endMs) },
  { id: 'move-4', task_id: DEMO_COMPLETED_TASK_ID, from_swimlane_id: EXECUTING, to_swimlane_id: REVIEW, origin: 'renderer', reason: null, at: timestampAt(SECOND_BUILD.endMs) },
  { id: 'move-5', task_id: DEMO_COMPLETED_TASK_ID, from_swimlane_id: REVIEW, to_swimlane_id: DONE, origin: 'renderer', reason: null, at: timestampAt(DONE_MS) },
];

/** Each record carries its conversation's cumulative readings, as the CLI reports them; main takes each leg's share. */
function sessionRecords(): TaskReportSessionRecord[] {
  const cumulative = new Map<string, { costUsd: number; durationMs: number; inputTokens: number; outputTokens: number }>();
  return PHASES.map((phase) => {
    const conversation = phase.column === 'review' ? REVIEW_CONVERSATION : MAIN_CONVERSATION;
    const before = cumulative.get(conversation) ?? { costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 };
    const after = {
      costUsd: Math.round((before.costUsd + phase.costUsd) * 100) / 100,
      durationMs: before.durationMs + phase.runtimeMs,
      inputTokens: before.inputTokens + phase.inputTokens,
      outputTokens: before.outputTokens + phase.outputTokens,
    };
    cumulative.set(conversation, after);
    const breakdown = archivedToolBreakdown(phase.tools);
    return {
      id: phase.recordId,
      session_type: run.agent,
      isolated_swimlane_id: phase.column === 'review' ? REVIEW : null,
      agent_session_id: conversation,
      permission_mode: run.permissionMode,
      started_at: timestampAt(phase.startMs),
      suspended_at: phase.exited ? null : timestampAt(phase.endMs),
      exited_at: phase.exited ? timestampAt(phase.endMs) : null,
      exit_code: phase.exited ? 0 : null,
      total_cost_usd: after.costUsd,
      total_input_tokens: after.inputTokens,
      total_output_tokens: after.outputTokens,
      total_duration_ms: after.durationMs,
      model_id: run.model,
      model_display_name: DEMO_COMPLETED_TASK_SUMMARY.modelDisplayName,
      // The run took the CLI's default effort and recorded none, so every run reads a dash. An
      // effort on the review runs would be authored; the honest dash was kept instead.
      applied_effort: run.effort ?? null,
      tool_call_count: breakdown.reduce((sum, tool) => sum + tool.callCount, 0),
      compaction_count: 0,
      tool_breakdown: JSON.stringify(breakdown),
    };
  });
}

/** Code Review's turn-end gate, an Agent evaluation, as the board had it while the task ran. */
const BACK_FOR_REVISIONS_ID = 'automation-cw-back-for-revisions';
const BACK_FOR_REVISIONS_CONDITION = 'The review found work the implementer can do';
const CHECK_MODEL = 'claude-haiku-5-5';

const AUTOMATION_RUNS: AutomationRun[] = [
  {
    id: 'automation-run-1', automation_id: BACK_FOR_REVISIONS_ID, automation_name: 'Back for revisions', type: 'move_to_column',
    task_id: DEMO_COMPLETED_TASK_ID, swimlane_id: REVIEW, trigger: 'turn_end', status: 'succeeded', detail: 'Moved to Executing', attempts: 1,
    started_at: timestampAt(SENT_BACK_CHECK_MS), finished_at: timestampAt(FIRST_REVIEW.endMs),
    condition_met: true, condition_reason: 'The smoke step in ci.yml is not the script the review ran, so it asks for the tested one.',
    final_line_met: null, final_line_reason: null,
    check: {
      callId: 'call-check-1', agent: 'claude', model: CHECK_MODEL, modelReported: true, effort: 'low',
      inputTokens: 9_150, cacheCreationInputTokens: 0, cacheReadInputTokens: 2_900, outputTokens: 350, costUsd: 0.005,
      durationMs: 4_800, outcome: 'succeeded', rowsAnswered: 1,
    },
  },
  {
    id: 'automation-run-2', automation_id: BACK_FOR_REVISIONS_ID, automation_name: 'Back for revisions', type: 'move_to_column',
    task_id: DEMO_COMPLETED_TASK_ID, swimlane_id: REVIEW, trigger: 'turn_end', status: 'skipped', detail: 'The condition was not met', attempts: 1,
    started_at: timestampAt(PASSED_CHECK_MS), finished_at: timestampAt(PASSED_CHECK_MS + 4_000),
    condition_met: false, condition_reason: 'The review fixed what it found and leaves one question for you: which host to deploy to.',
    final_line_met: null, final_line_reason: null,
    check: {
      callId: 'call-check-2', agent: 'claude', model: CHECK_MODEL, modelReported: true, effort: 'low',
      inputTokens: 8_240, cacheCreationInputTokens: 0, cacheReadInputTokens: 2_410, outputTokens: 300, costUsd: 0.004,
      durationMs: 3_900, outcome: 'succeeded', rowsAnswered: 1,
    },
  },
];

/** A Condition check's call row, read off the automation run it answered so the two cannot disagree. */
function conditionCheckCall(automationRun: AutomationRun): TaskBackgroundCallRow {
  const check = automationRun.check;
  if (!check) throw new Error(`${automationRun.id} records no condition check`);
  const tokenCounts = [check.inputTokens, check.cacheCreationInputTokens, check.cacheReadInputTokens, check.outputTokens];
  return {
    id: check.callId, job: 'condition_check', swimlaneId: automationRun.swimlane_id, modelId: check.model, effort: check.effort,
    tokens: tokenCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0),
    costUsd: check.costUsd, durationMs: check.durationMs, startedAt: automationRun.started_at,
  };
}

const BACKGROUND_CALLS: TaskBackgroundCallRow[] = [
  ...AUTOMATION_RUNS.map(conditionCheckCall),
  { id: 'call-summary', job: 'task_summary', swimlaneId: null, modelId: CHECK_MODEL, effort: 'low', tokens: 9_300, costUsd: 0.006, durationMs: 6_200, startedAt: timestampAt(DONE_MS + 18_000) },
];

/** main's ledger over the run's transcript. Every turn ran on one model, so its one row sums the four token kinds. */
const LEDGER: TaskModelUsageRow[] = [
  { modelId: run.model, subagentType: null, turns: 35, freshInputTokens: 74, cacheWriteTokens: 44_173, cacheReadTokens: 1_630_559, outputTokens: 14_595 },
];

/** The run committed nothing; these are the change as it reached main, in the run's own two steps. */
const COMMITS: TaskKnowledge['commits'] = [
  { sha: '9c71e0f4a2b6d83517c9e0a4f2b8d6135e7a90c2', subject: 'Run the tested smoke script in CI and gate deploy on DEPLOY_TARGET', committedAt: timestampAt(1_265_000) },
  { sha: '4e2b9d17c0a85f3361e7b9a2d4c08f51e6a3b7d9', subject: 'Add the CI/CD workflow, pin Node 24, and add the lockfile npm ci needs', committedAt: timestampAt(236_000) },
];

/** The clone's git status, most-changed first (2,929, 107, 32 and 1 lines; together the row's 3,069). */
const CHANGED_FILES = ['package-lock.json', '.github/workflows/ci.yml', 'README.md', '.nvmrc'];

const SUMMARY_TEXT = 'Added .github/workflows/ci.yml, which runs npm ci, the typecheck, the tests, the build and an API smoke test on pull requests and pushes to main, then uploads the app with its server source. Pinned Node 24 in .nvmrc, added the package-lock.json that npm ci needs, and documented the pipeline in the README. The deploy job is wired but deploys nothing yet: it waits for a DEPLOY_TARGET variable and a chosen host.';

/** The rows, exported so a unit test can hold the seeded report to main's assembly of them. */
export function demoCompletedTaskReportInput(): Parameters<typeof assembleTaskReport>[0] {
  return {
    sessions: sessionRecords(),
    swimlanes: SWIMLANES,
    moves: MOVES,
    // The mock hands the report the Completed Tasks row's own summary when it serves it.
    summary: null,
    automationRuns: AUTOMATION_RUNS,
    conditionsByAutomationId: new Map([[BACK_FOR_REVISIONS_ID, BACK_FOR_REVISIONS_CONDITION]]),
    backgroundCalls: BACKGROUND_CALLS,
    ledger: LEDGER,
    knowledge: { summary: { text: SUMMARY_TEXT, writtenAt: timestampAt(DONE_MS + 24_200) }, commits: COMMITS, commitCount: COMMITS.length, changedFiles: CHANGED_FILES, changedFileCount: CHANGED_FILES.length },
    summaryState: { kind: 'written', text: SUMMARY_TEXT },
    nowMs: ANCHOR_MS + DONE_MS,
  };
}

/** The report the completed-task scenes seed, with no summary until the mock hands it the row's. */
export const DEMO_COMPLETED_TASK_REPORT: TaskReport = assembleTaskReport(demoCompletedTaskReportInput());
