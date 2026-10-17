/**
 * The Completed Tasks dialog draws "-" in every cell of an archived task with no summary, and a
 * footer of "$0.00 total cost, 0 tokens", which is what the web demo showed before the sample
 * install carried these. The seed writes one summary per entry in DEMO_ARCHIVED_SUMMARIES, so an
 * archived task added without one, or a summary left behind by a retired task, would bring the
 * dashes back quietly. This pins the two lists to each other.
 *
 * The summaries are no longer written by hand: each is its task's recorded run
 * (tests/captures/fixtures/demo/archived/runs.json, scripts/capture-demo-archived-runs.mjs). So this
 * also pins that every archived task HAS a run, that every run belongs to an archived task, and that
 * the summary the dialog reads is that run's numbers rather than a copy that could drift.
 *
 * The older history rows take their ticket numbers, PR links and model names from the same sources,
 * and the two archived-run scripts find each run's clone through one shared rule; both are pinned
 * below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { humanizeClaudeModelId } from '../../src/main/agent/adapters/claude/model-display-name';
import {
  DEMO_ARCHIVED_RUNS, DEMO_ARCHIVED_SUMMARIES, DEMO_ARCHIVED_TASKS, DEMO_COLUMN_MODELS, DEMO_HISTORY, DEMO_KNOWLEDGE_GRAPH_CONFIG, DEMO_PROJECTS, DEMO_ALL_SESSIONS, DEMO_SESSIONS, DEMO_TASKS,
  archivedRunPromptOf, archivedSessionIdOf, archivedToolBreakdown, buildDemoPreConfig, taskSlugOf,
} from '../../tests/captures/helpers/demo-dataset';
import { DEMO_COMPLETED_TASK_ID, DEMO_COMPLETED_TASK_REPORT, DEMO_COMPLETED_TASK_SUMMARY, demoCompletedTaskReportInput } from '../../tests/captures/helpers/demo-task-report';
import { assembleTaskReport } from '../../src/main/ipc/helpers/task-report-assemble';
import { mergeToolBreakdowns } from '../../src/shared/tool-call-totals';
import type { TaskReport } from '../../src/shared/types';
import { archivedClonePath, archivedCloneSegments, scratchClonePath, scratchRootFromArgv } from '../../scripts/lib/demo-archived-clone.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('demo archived task summaries', () => {
  const archivedTaskIds = DEMO_TASKS.filter((task) => task.archivedDaysAgo).map((task) => task.id).sort();

  it('gives every archived task exactly one summary, and no other task any', () => {
    // Vacuity guard: the sample install archives tasks in all three projects.
    expect(archivedTaskIds.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_ARCHIVED_SUMMARIES.map((summary) => summary.taskId).sort()).toEqual(archivedTaskIds);
  });

  it('fills every cell the dialog draws', () => {
    for (const summary of DEMO_ARCHIVED_SUMMARIES) {
      const toolCalls = Object.values(summary.tools).reduce((sum, calls) => sum + calls, 0);
      // The churn cell draws "+0 -6" for a task that only deleted, so it is the sum that must be
      // above zero, as useCompletedColumns tests it.
      const linesChanged = summary.linesAdded + summary.linesRemoved;
      for (const [field, value] of Object.entries({
        costUsd: summary.costUsd, durationMs: summary.durationMs, inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens, toolCalls, filesChanged: summary.filesChanged, linesChanged,
      })) {
        expect(value, `${summary.taskId}.${field} would draw "-"`).toBeGreaterThan(0);
      }
    }
  });

  it('takes every summary from its task\'s recorded run, and records a run for no other task', () => {
    expect(Object.keys(DEMO_ARCHIVED_RUNS).sort()).toEqual(archivedTaskIds);
    for (const summary of DEMO_ARCHIVED_SUMMARIES) {
      const run = DEMO_ARCHIVED_RUNS[summary.taskId];
      expect(summary, summary.taskId).toMatchObject({
        taskId: summary.taskId, effort: run.effort ?? null, permissionMode: run.permissionMode,
        costUsd: run.costUsd, durationMs: run.durationMs, inputTokens: run.inputTokens,
        outputTokens: run.outputTokens, tools: run.tools, filesChanged: run.filesChanged,
        linesAdded: run.linesAdded, linesRemoved: run.linesRemoved,
      });
      // The row names the model the run reports, never a fixed one: the history ran on another.
      expect(summary.modelDisplayName, summary.taskId).toMatch(/\S/);
      // A run is the agent's own work on the task's own prompt, the one Kangentic's default
      // template sends, and the card names the agent that made it.
      const task = DEMO_TASKS.find((candidate) => candidate.id === summary.taskId);
      expect(task, summary.taskId).toBeDefined();
      if (task) expect(run.prompt, summary.taskId).toBe(archivedRunPromptOf(task));
      expect(task?.agent, `${summary.taskId} names the agent its run was made with`).toBe(run.agent);
      expect(run.agentSessionId, `${summary.taskId} keeps no history id for the Knowledge Graph capture`).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('runs each history task on its own work: an upstream one at the parent of its own commit, on the history\'s model', () => {
    const seenHistoryTaskIds = new Set<string>();
    for (const entry of DEMO_HISTORY.tasks) {
      expect(seenHistoryTaskIds.has(entry.id), `${entry.id} listed twice`).toBe(false);
      seenHistoryTaskIds.add(entry.id);
      const task = DEMO_TASKS.find((candidate) => candidate.id === entry.id);
      expect(task?.archivedDaysAgo, `${entry.id} is not an archived task`).toBe(entry.archivedDaysAgo);
      // A history task predates nothing it could not: it was archived after its project was added.
      const project = DEMO_PROJECTS.find((candidate) => candidate.id === task?.projectId);
      expect(entry.archivedDaysAgo, `${entry.id} predates ${project?.name}`).toBeLessThan(project?.createdDaysAgo ?? 0);
      if (entry.upstream) expect(entry.upstream.parent, entry.id).toMatch(/^[0-9a-f]{40}$/);
      const run = DEMO_ARCHIVED_RUNS[entry.id];
      if (!run) continue;
      expect(run.model, entry.id).toBe(DEMO_HISTORY.model);
      expect(run.effort, entry.id).toBe(DEMO_HISTORY.effort);
      if (entry.upstream) expect(run.ref, `${entry.id} started somewhere other than its commit's parent`).toBe(entry.upstream.parent);
    }
    // Every project's history numbers its tickets after the board's, one apart, so no card moves.
    for (const project of DEMO_PROJECTS) {
      const numbers = DEMO_TASKS.filter((task) => task.projectId === project.id).map((task) => task.display_id).sort((left, right) => left - right);
      expect(numbers, project.name).toEqual(numbers.map((_, index) => index + 1));
    }
  });

  it('is derived, never written here: the seed reads the run file', () => {
    const dataset = fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/helpers/demo-dataset.ts'), 'utf-8');
    expect(dataset).toContain("from '../fixtures/demo/archived/runs.json'");
  });
});

/**
 * An archived task's window shows the completed task view, whose report the mock derives from the
 * task's summary (`buildTaskReport`) and the seed completes with what the recorded run adds: its
 * agent, effort and permission mode. The mock is evaluated here as the browser evaluates it, so the
 * Runs table, the header strip and the Models card are held to the same run the Completed Tasks
 * row is.
 */
describe('demo archived task reports', () => {
  interface MockState {
    summaryCache: Record<string, unknown>;
    taskRunFacts: Record<string, { agent: string | null; effort: string | null; permissionMode: string }>;
    config: Record<string, unknown>;
    buildTaskReport: (taskId: string) => {
      summary: unknown;
      conversations: Array<{
        runs: Array<{ agent: string; effort: string | null; permissionMode: string | null; costUsd: number; runtimeMs: number; toolCallCount: number; model: string | null }>;
      }>;
      modelFallback: Array<{ model: string; inputWithCacheTokens: number; outputTokens: number }>;
      totals: {
        runs: { runCount: number; runtimeMs: number | null; costUsd: number | null; toolCallCount: number; compactionCount: number };
        models: unknown;
        backgroundCalls: { durationMs: number | null; costUsd: number | null; tokens: number | null };
      };
      summaryState: { kind: string };
    };
  }

  type PreConfigure = (configure: (state: MockState) => unknown) => void;

  /** The browser's `window` once the mock has run in it. */
  function loadMockWindow(): Record<string, unknown> {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'tests/ui/mock-electron-api.js'), 'utf-8');
    const windowObject: Record<string, unknown> = {};
    windowObject.window = windowObject;
    vm.runInNewContext(source, { window: windowObject, document: undefined, crypto: webcrypto, setTimeout, clearTimeout, console }, { timeout: 5000 });
    return windowObject;
  }

  /** The mock's state, as `__mockPreConfigure` hands it to a seed. */
  function stateOf(windowObject: Record<string, unknown>): MockState {
    const captured: { state: MockState | null } = { state: null };
    (windowObject.__mockPreConfigure as PreConfigure)((state) => { captured.state = state; });
    if (!captured.state) throw new Error('the mock did not hand __mockPreConfigure its state');
    return captured.state;
  }

  function loadMockState(): MockState {
    return stateOf(loadMockWindow());
  }

  /** Thrown from the wrapped `__mockPreConfigure` to end the generated script once its seed has run. */
  const SEED_RAN = new Error('the dataset seed ran');

  /**
   * The mock's state after the dataset's own seed has run against it: the generated script
   * (`buildDemoPreConfig`) evaluated as the page evaluates it, with its `__mockPreConfigure` call
   * answered by the real mock. The script is ended right after that call. What follows it replaces
   * bridge methods and arms the session clocks, none of which the seed's rows depend on.
   */
  function loadSeededMockState(): MockState {
    const windowObject = loadMockWindow();
    const preConfigure = windowObject.__mockPreConfigure as PreConfigure;
    const seeded: { state: MockState | null } = { state: null };
    windowObject.__mockPreConfigure = (configure: (state: MockState) => unknown) => {
      preConfigure(configure);
      preConfigure((state) => { seeded.state = state; });
      throw SEED_RAN;
    };
    // A stub recording per session is all the build's recordings check wants.
    const script = buildDemoPreConfig({
      scrollback: Object.fromEntries(DEMO_ALL_SESSIONS.map((session) => [session.id, 'recording'])),
      knowledgeGraph: 'fetched',
    });
    try {
      new Function('window', script)(windowObject);
    } catch (error) {
      if (error !== SEED_RAN) throw error;
    }
    if (!seeded.state) throw new Error('the dataset seed never called __mockPreConfigure');
    return seeded.state;
  }

  it('derives one run per archived task that matches its summary and its recorded run', () => {
    const state = loadMockState();
    // The sample install's Knowledge Graph settings, as the seed applies them.
    state.config.knowledgeGraph = { ...DEMO_KNOWLEDGE_GRAPH_CONFIG };
    expect(DEMO_ARCHIVED_SUMMARIES.length).toBeGreaterThan(0);
    for (const summary of DEMO_ARCHIVED_SUMMARIES) {
      const task = DEMO_TASKS.find((candidate) => candidate.id === summary.taskId);
      state.taskRunFacts[summary.taskId] = { agent: task?.agent ?? null, effort: summary.effort, permissionMode: summary.permissionMode };
      const toolCallCount = Object.values(summary.tools).reduce((sum, calls) => sum + calls, 0);
      state.summaryCache[summary.taskId] = {
        sessionId: archivedSessionIdOf(summary.taskId), totalCostUsd: summary.costUsd, totalInputTokens: summary.inputTokens,
        totalOutputTokens: summary.outputTokens, modelDisplayName: summary.modelDisplayName, durationMs: summary.durationMs,
        toolCallCount, compactionCount: 0, linesAdded: summary.linesAdded, linesRemoved: summary.linesRemoved,
        filesChanged: summary.filesChanged, taskCreatedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:00.000Z',
        exitedAt: '2026-10-01T01:00:00.000Z', exitCode: 0, toolBreakdown: [],
      };
      const report = state.buildTaskReport(summary.taskId);
      expect(report.summary, summary.taskId).toBe(state.summaryCache[summary.taskId]);
      expect(report.conversations, summary.taskId).toHaveLength(1);
      const run = DEMO_ARCHIVED_RUNS[summary.taskId];
      expect(report.conversations[0].runs[0], summary.taskId).toMatchObject({
        costUsd: summary.costUsd, runtimeMs: summary.durationMs, toolCallCount, model: summary.modelDisplayName,
        agent: run.agent, effort: run.effort ?? null, permissionMode: run.permissionMode,
      });
      expect(report.modelFallback, summary.taskId).toEqual([
        { model: summary.modelDisplayName, inputWithCacheTokens: summary.inputTokens, outputTokens: summary.outputTokens },
      ]);
      // The Usage tab's Total rows read the report's totals, which are this one run's.
      expect(report.totals, summary.taskId).toEqual({
        runs: { runCount: 1, runtimeMs: summary.durationMs, costUsd: summary.costUsd, toolCallCount, compactionCount: 0 },
        models: null,
        backgroundCalls: { durationMs: null, costUsd: null, tokens: null },
      });
      // Summaries are on in the sample install and none is written (no agent is chosen to write
      // one), so main reports pending and the card names what is missing. The runs record no
      // closing message, so the card shows none rather than an authored one.
      expect(report.summaryState.kind, summary.taskId).toBe('pending');
    }
  });

  it('reads summaries as off where the Knowledge Graph is off, as main does', () => {
    const state = loadMockState();
    const [summary] = DEMO_ARCHIVED_SUMMARIES;
    state.summaryCache[summary.taskId] = { sessionId: archivedSessionIdOf(summary.taskId), toolBreakdown: [] };
    expect(state.buildTaskReport(summary.taskId).summaryState.kind).toBe('off');
    state.config.knowledgeGraph = { ...DEMO_KNOWLEDGE_GRAPH_CONFIG, taskSummaries: false };
    expect(state.buildTaskReport(summary.taskId).summaryState.kind).toBe('off');
    state.config.knowledgeGraph = { ...DEMO_KNOWLEDGE_GRAPH_CONFIG, indexingEnabled: false };
    expect(state.buildTaskReport(summary.taskId).summaryState.kind).toBe('indexing-off');
  });

  describe('the completed-task scenes\' report', () => {
    const run = DEMO_ARCHIVED_RUNS[DEMO_COMPLETED_TASK_ID];
    const summary = DEMO_COMPLETED_TASK_SUMMARY;
    const report = DEMO_COMPLETED_TASK_REPORT;
    const runs = report.conversations.flatMap((conversation) => conversation.runs);

    it('is what main assembles from its rows, and survives the JSON a scene seed travels as', () => {
      expect(report).toEqual(assembleTaskReport(demoCompletedTaskReportInput()));
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
      // The mock hands it the row's own summary; a summary here would be a second copy.
      expect(report.summary).toBeNull();
    });

    it('splits the recorded run into runs that add back to the Completed Tasks row', () => {
      // Vacuity guard: the view's point is several runs over more than one conversation.
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(report.conversations.length).toBeGreaterThanOrEqual(2);
      expect(runs.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)).toBeCloseTo(summary.costUsd, 6);
      expect(runs.reduce((sum, entry) => sum + (entry.runtimeMs ?? 0), 0)).toBe(summary.durationMs);
      expect(report.totals.runs.costUsd ?? 0).toBeCloseTo(summary.costUsd, 6);
      expect(report.totals.runs.runtimeMs).toBe(summary.durationMs);
      // The Runs Total pill reads the summary's breakdown, so the runs' rows merge back into it.
      expect(mergeToolBreakdowns(runs.map((entry) => entry.toolBreakdown))).toEqual(mergeToolBreakdowns([archivedToolBreakdown(summary.tools)]));
      expect(report.totals.runs.toolCallCount).toBe(Object.values(summary.tools).reduce((sum, calls) => sum + calls, 0));
      // The run's own conversation is one of them, so the copy button names a history that exists.
      expect(report.conversations.map((conversation) => conversation.conversationId)).toContain(run.agentSessionId);
    });

    it('ends on a run in the row\'s own model and mode that exited cleanly', () => {
      const latest = [...runs].sort((first, second) => first.startedAt.localeCompare(second.startedAt)).at(-1);
      expect(latest?.exitCode).toBe(0);
      for (const entry of runs) {
        expect(entry.agent, entry.recordId).toBe(run.agent);
        expect(entry.model, entry.recordId).toBe(report.models?.[0]?.model);
        expect(entry.permissionMode, entry.recordId).toBe(run.permissionMode);
        expect(entry.effort, entry.recordId).toBe(run.effort ?? null);
      }
    });

    it('reads its tokens from the recorded run: the ledger adds up to the run\'s input and output', () => {
      const models = report.models ?? [];
      expect(models.length, 'no ledger, so the view shows the fallback card instead').toBeGreaterThan(0);
      const input = models.reduce((sum, row) => sum + row.freshInputTokens + row.cacheWriteTokens + row.cacheReadTokens, 0);
      expect(input).toBe(run.inputTokens);
      expect(models.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(run.outputTokens);
      // A turn that reported usage is one of the run's turns, never more.
      expect(models.reduce((sum, row) => sum + row.turns, 0)).toBeLessThanOrEqual(run.numTurns);
      // The runs' own token readings add up to the run as well, and the Models card falls back to
      // them when the ledger cannot be read.
      expect(report.modelFallback.reduce((sum, row) => sum + row.inputWithCacheTokens, 0)).toBe(run.inputTokens);
      expect(report.modelFallback.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(run.outputTokens);
      // The changed files are the run's own, as many as the row counts.
      expect(report.knowledge?.changedFileCount).toBe(run.filesChanged);
    });

    it('repeats a column with every stay long enough to draw its visit card', () => {
      // The Route card draws a column's visits only when it has two or more stays of a minute or more.
      const repeated = report.route.filter((column) => column.visits.length >= 2);
      expect(repeated.length).toBeGreaterThan(0);
      for (const column of repeated) {
        for (const visit of column.visits) expect(visit.durationMs, column.name).toBeGreaterThanOrEqual(60_000);
      }
    });

    it('shows a condition met and a condition not met', () => {
      const outcomes = report.backgroundCalls.map((call) => call.outcome);
      expect(outcomes).toContain('ran');
      expect(outcomes).toContain('skipped');
      expect(report.summaryState.kind).toBe('written');
    });

    it('is served by the mock on the archived row: its summary by reference, its Done move on archived_at', async () => {
      const windowObject = loadMockWindow();
      const state = stateOf(windowObject) as MockState & { archivedTasks: Array<Record<string, unknown>> };
      const archivedAt = '2026-10-12T09:30:00.000Z';
      state.archivedTasks.push({ id: DEMO_COMPLETED_TASK_ID, archived_at: archivedAt });
      const rowSummary = { sessionId: archivedSessionIdOf(DEMO_COMPLETED_TASK_ID), totalCostUsd: summary.costUsd, durationMs: summary.durationMs, toolBreakdown: [] };
      state.summaryCache[DEMO_COMPLETED_TASK_ID] = rowSummary;
      windowObject.__mockTaskReports = JSON.parse(JSON.stringify({ [DEMO_COMPLETED_TASK_ID]: report }));
      const api = windowObject.electronAPI as {
        sessions: { getTaskReport: (projectId: string, taskId: string) => Promise<TaskReport> };
        knowledgeGraph: { taskSummary: (projectId: string, taskId: string) => Promise<string | null> };
      };
      const served = await api.sessions.getTaskReport('proj-contoso-web', DEMO_COMPLETED_TASK_ID);
      expect(served.summary).toBe(rowSummary);
      expect(served.endedAt).toBe(archivedAt);
      // One offset moves every time, so each one keeps its distance from the Done move. Every
      // timestamp in the report is compared, so a time field the report gains fails here until the
      // mock moves it too.
      const offsetMs = Date.parse(archivedAt) - Date.parse(report.endedAt ?? '');
      const moved = (value: string): string => new Date(Date.parse(value) + offsetMs).toISOString();
      const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      const unmoved: string[] = [];
      let timestampCount = 0;
      const compareTimes = (sourceValue: unknown, servedValue: unknown, keyPath: string): void => {
        if (typeof sourceValue === 'string' && isoTimestamp.test(sourceValue)) {
          timestampCount += 1;
          if (servedValue !== moved(sourceValue)) unmoved.push(keyPath);
        } else if (Array.isArray(sourceValue)) {
          sourceValue.forEach((item, index) => compareTimes(item, Array.isArray(servedValue) ? servedValue[index] : undefined, `${keyPath}[${index}]`));
        } else if (sourceValue !== null && typeof sourceValue === 'object') {
          const servedRecord = (servedValue ?? {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(sourceValue)) compareTimes(value, servedRecord[key], `${keyPath}.${key}`);
        }
      };
      compareTimes({ ...report, summary: null }, { ...served, summary: null }, 'report');
      expect(unmoved).toEqual([]);
      // Vacuity guard: the start and end, every visit, run, call and commit.
      expect(timestampCount).toBeGreaterThanOrEqual(10);
      // Asked again, the same object: the window and a re-read agree.
      expect(await api.sessions.getTaskReport('proj-contoso-web', DEMO_COMPLETED_TASK_ID)).toBe(served);
      // The graph's summary panel reads the written summary the view shows.
      expect(report.summaryState.kind).toBe('written');
      if (report.summaryState.kind === 'written') {
        expect(await api.knowledgeGraph.taskSummary('proj-contoso-web', DEMO_COMPLETED_TASK_ID)).toBe(report.summaryState.text);
      }
      // Sibling negative: another archived task keeps the report the mock derives from its row.
      expect(await api.knowledgeGraph.taskSummary('proj-contoso-web', 'task-cw-done-schema')).toBeNull();
      expect((await api.sessions.getTaskReport('proj-contoso-web', 'task-cw-done-schema')).route).toEqual([]);
    });

    it('serves the derived report until the archived row exists, and caches nothing before it', async () => {
      const windowObject = loadMockWindow();
      const state = stateOf(windowObject) as MockState & { archivedTasks: Array<Record<string, unknown>> };
      windowObject.__mockTaskReports = JSON.parse(JSON.stringify({ [DEMO_COMPLETED_TASK_ID]: report }));
      const api = windowObject.electronAPI as {
        sessions: { getTaskReport: (projectId: string, taskId: string) => Promise<TaskReport> };
      };
      // No row to put the Done move on, so the seed is neither served nor pinned at its own anchor.
      expect((await api.sessions.getTaskReport('proj-contoso-web', DEMO_COMPLETED_TASK_ID)).route).toEqual([]);
      const archivedAt = '2026-10-12T09:30:00.000Z';
      state.archivedTasks.push({ id: DEMO_COMPLETED_TASK_ID, archived_at: archivedAt });
      const served = await api.sessions.getTaskReport('proj-contoso-web', DEMO_COMPLETED_TASK_ID);
      expect(served.route).toHaveLength(report.route.length);
      expect(served.endedAt).toBe(archivedAt);
    });
  });

  it('seeds each archived task\'s run facts from its recorded run', () => {
    const state = loadSeededMockState();
    // Vacuity guard: the sample install archives tasks, so the loop below checks something.
    expect(DEMO_ARCHIVED_SUMMARIES.length).toBeGreaterThan(0);
    // One entry per archived task with a summary, and none for any other task.
    expect(Object.keys(state.taskRunFacts).sort()).toEqual(DEMO_ARCHIVED_SUMMARIES.map((summary) => summary.taskId).sort());
    for (const summary of DEMO_ARCHIVED_SUMMARIES) {
      const task = DEMO_TASKS.find((candidate) => candidate.id === summary.taskId);
      expect(task, summary.taskId).toBeDefined();
      // The expected facts are non-empty, or an entry the seed left blank would equal them.
      expect(task?.agent, `${summary.taskId} names no agent`).toMatch(/\S/);
      expect(summary.permissionMode, `${summary.taskId} names no permission mode`).toMatch(/\S/);
      expect(state.taskRunFacts[summary.taskId], summary.taskId).toEqual({
        agent: task?.agent, effort: summary.effort, permissionMode: summary.permissionMode,
      });
      // The row's per-tool table is archivedToolBreakdown's, the one the completed-task report's
      // runs merge back into.
      const seededRow = state.summaryCache[summary.taskId] as { toolBreakdown?: unknown } | undefined;
      expect(seededRow?.toolBreakdown, summary.taskId).toEqual(archivedToolBreakdown(summary.tools));
    }
    // The history's runs ran at an effort, so at least one entry carries one rather than null.
    expect(DEMO_ARCHIVED_SUMMARIES.some((summary) => summary.effort !== null)).toBe(true);
  });
});

describe('demo history task rows', () => {
  const historyIds = new Set(DEMO_HISTORY.tasks.map((entry) => entry.id));
  // DEMO_BOARD_TASKS is not exported: the board's tasks are every task the history does not list.
  const ownTasks = (projectId: string) => DEMO_TASKS.filter((task) => task.projectId === projectId);

  it('keeps each board at 1..N and numbers its history after it, oldest first', () => {
    for (const project of DEMO_PROJECTS) {
      const board = ownTasks(project.id).filter((task) => !historyIds.has(task.id));
      const history = ownTasks(project.id).filter((task) => historyIds.has(task.id)).sort((left, right) => left.display_id - right.display_id);
      // Vacuity guards: every project has a board and a history, or the order pinned below is empty.
      expect(board.length, `${project.name} has no board tasks`).toBeGreaterThan(0);
      expect(history.length, `${project.name} has no history`).toBeGreaterThan(0);
      // No card on a board moves: the board's own tickets are 1..N, so the history cannot sit before them.
      const boardNumbers = board.map((task) => task.display_id).sort((left, right) => left - right);
      expect(boardNumbers, `${project.name} board was renumbered`).toEqual(boardNumbers.map((_, index) => index + 1));
      expect(Math.max(...boardNumbers), `${project.name} history took a number below the board's`).toBeLessThan(history[0].display_id);
      // Oldest archived first: the biggest archivedDaysAgo gets the smallest number.
      const archivedDays = history.map((task) => task.archivedDaysAgo ?? 0);
      expect(new Set(archivedDays).size, `${project.name} history has one archive date, so its order proves nothing`).toBeGreaterThan(1);
      expect(archivedDays, `${project.name} history is not numbered oldest first`).toEqual([...archivedDays].sort((left, right) => right - left));
    }
  });

  it('gives every Done task in a project its own position', () => {
    for (const project of DEMO_PROJECTS) {
      const positions = ownTasks(project.id).filter((task) => task.lane === 'done').map((task) => task.position);
      expect(positions.length, project.name).toBeGreaterThan(1);
      expect(new Set(positions).size, `${project.name} stacks two Done cards at one position`).toBe(positions.length);
    }
  });

  it('links an upstream task to its merged pull request and gives any other none', () => {
    let linked = 0;
    let unlinked = 0;
    for (const entry of DEMO_HISTORY.tasks) {
      const task = DEMO_TASKS.find((candidate) => candidate.id === entry.id);
      const project = DEMO_PROJECTS.find((candidate) => candidate.id === task?.projectId);
      const pullRequest = entry.upstream?.pr ?? null;
      if (pullRequest) {
        linked += 1;
        expect(task?.pr_number, entry.id).toBe(pullRequest);
        expect(task?.pr_state, entry.id).toBe('merged');
        expect(task?.pr_url, entry.id).toBe(`${project?.github_url}/pull/${pullRequest}`);
        expect(task?.pr_url, entry.id).toMatch(new RegExp(`/pull/${pullRequest}$`));
      } else {
        unlinked += 1;
        expect(task?.pr_number, entry.id).toBeNull();
        expect(task?.pr_state, entry.id).toBeNull();
        expect(task?.pr_url, entry.id).toBeNull();
      }
    }
    // Both branches ran: some history task is an upstream commit with a PR, and some has none.
    expect(linked).toBeGreaterThan(0);
    expect(unlinked).toBeGreaterThan(0);
  });
});

describe('demo archived run model names', () => {
  const historyIds = new Set(DEMO_HISTORY.tasks.map((entry) => entry.id));
  const boardSummaries = DEMO_ARCHIVED_SUMMARIES.filter((summary) => !historyIds.has(summary.taskId));
  const historySummaries = DEMO_ARCHIVED_SUMMARIES.filter((summary) => historyIds.has(summary.taskId));
  // The recordings' own Opus sessions name the model the way its card does.
  const recordedOpusName = DEMO_SESSIONS.find((session) => session.model?.id === DEMO_COLUMN_MODELS.opus)?.model?.displayName;

  it('names a run on a model the recordings ran on as the dataset names it, not as the id humanizes', () => {
    expect(recordedOpusName, 'no recorded session runs on the Opus model').toMatch(/\S/);
    // The two spellings differ, so a summary that skipped the dataset's name and humanized the id would fail.
    expect(humanizeClaudeModelId(DEMO_COLUMN_MODELS.opus)).not.toBe(recordedOpusName);
    const onOpus = boardSummaries.filter((summary) => DEMO_ARCHIVED_RUNS[summary.taskId].model === DEMO_COLUMN_MODELS.opus);
    expect(onOpus.length, 'no board run is on the Opus model').toBeGreaterThan(0);
    for (const summary of onOpus) expect(summary.modelDisplayName, summary.taskId).toBe(recordedOpusName);
  });

  it('records every board run on the model it was asked for, the main conversation\'s and never its advisor\'s', () => {
    // Claude Code's advisor answers on its own model and bills it to the run. Read off the result's
    // largest output, three board runs were once recorded on the advisor's model; the recorder now
    // reads the main conversation's model from the history (mainLoopModel).
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/fixtures/demo/manifest.json'), 'utf-8')) as { archived: { model: string } };
    expect(boardSummaries.length, 'no board run has a summary').toBeGreaterThan(0);
    for (const summary of boardSummaries) {
      expect(DEMO_ARCHIVED_RUNS[summary.taskId].model, summary.taskId).toBe(manifest.archived.model);
      expect(summary.modelDisplayName, summary.taskId).toBe(recordedOpusName);
    }
  });

  it('names a history run for the history\'s own model and effort, which no board run shares', () => {
    const historyName = humanizeClaudeModelId(DEMO_HISTORY.model);
    expect(historyName, DEMO_HISTORY.model).not.toBeNull();
    expect(historySummaries.length, 'no history run has a summary').toBeGreaterThan(0);
    for (const summary of historySummaries) {
      expect(summary.modelDisplayName, summary.taskId).toBe(historyName);
      expect(summary.effort, summary.taskId).toBe(DEMO_HISTORY.effort);
    }
    // The history ran on another model than every board run, so no board row reads like it.
    for (const summary of boardSummaries) {
      expect(summary.modelDisplayName, summary.taskId).not.toBe(historyName);
      // A board run was made at the CLI's default effort, which a summary records as null.
      expect(summary.effort, summary.taskId).toBeNull();
    }
  });
});

/**
 * The recorder (scripts/capture-demo-archived-runs.mjs) reads its plan from the manifest's `archived`
 * block: the commit a task starts from (`refs`) and a permission mode that differs from the default
 * (`permissionModes`). Each is looked up by task id, so a key that matches no task does nothing and
 * the run is made at the default, which for a task already merged upstream is a run that has no work
 * to do. The recorded runs are the record of what the plan did, so this holds one to the other.
 */
describe('demo archived runs follow the manifest\'s plan', () => {
  interface ArchivedPlan {
    model: string;
    permissionMode: string;
    permissionModes?: Record<string, string>;
    refs?: Record<string, string>;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/fixtures/demo/manifest.json'), 'utf-8')) as {
    archived: ArchivedPlan;
    repos: Record<string, { git?: string; scaffold?: string }>;
  };
  const plan = manifest.archived;
  // A `$comment` key documents the block it sits in, and is not a task.
  const withoutComment = (entries: Record<string, string> | undefined): Array<[string, string]> => Object.entries(entries ?? {}).filter(([key]) => key !== '$comment');
  const refs = withoutComment(plan.refs);
  const permissionModes = withoutComment(plan.permissionModes);
  const historyIds = new Set(DEMO_HISTORY.tasks.map((entry) => entry.id));
  const boardRunIds = DEMO_ARCHIVED_TASKS.map((task) => task.id).filter((taskId) => !historyIds.has(taskId));

  it('names only board tasks that have a recorded run, each start a whole commit id', () => {
    // Vacuity: the plan pins starts and a permission override, or the loops below say nothing.
    expect(refs.length).toBeGreaterThan(0);
    expect(permissionModes.length).toBeGreaterThan(0);
    for (const [taskId, ref] of refs) {
      expect(boardRunIds, `manifest.archived.refs names ${taskId}, which is not an archived board task`).toContain(taskId);
      expect(ref, taskId).toMatch(/^[0-9a-f]{40}$/);
    }
    for (const [taskId] of permissionModes) {
      expect(boardRunIds, `manifest.archived.permissionModes names ${taskId}, which is not an archived board task`).toContain(taskId);
    }
  });

  it('records each board run in the permission mode the plan gave its task', () => {
    const overrides = new Map(permissionModes);
    for (const taskId of boardRunIds) {
      expect(DEMO_ARCHIVED_RUNS[taskId].permissionMode, taskId).toBe(overrides.get(taskId) ?? plan.permissionMode);
    }
    // The override took: at least one run is in a mode other than the default.
    expect(boardRunIds.some((taskId) => DEMO_ARCHIVED_RUNS[taskId].permissionMode !== plan.permissionMode)).toBe(true);
  });

  it('starts each run where its project\'s repository starts it: the scaffold with no commit, an upstream sample at a pinned or recorded one', () => {
    const pinned = new Map(refs);
    let scaffolded = 0;
    let upstream = 0;
    for (const task of DEMO_ARCHIVED_TASKS) {
      const project = DEMO_PROJECTS.find((candidate) => candidate.id === task.projectId);
      const spec = manifest.repos[project?.name ?? ''];
      const run = DEMO_ARCHIVED_RUNS[task.id];
      if (spec?.scaffold) {
        scaffolded += 1;
        expect(run.ref, `${task.id} runs in a scaffold, which has no upstream commit to name`).toBeNull();
        continue;
      }
      upstream += 1;
      expect(run.ref, `${task.id} runs in an upstream sample and records no commit`).toMatch(/^[0-9a-f]{40}$/);
      const pin = pinned.get(task.id);
      if (pin) expect(run.ref, `${task.id} was started at ${String(run.ref)}, not the commit the manifest pins`).toBe(pin);
    }
    // Both kinds of project have archived runs.
    expect(scaffolded).toBeGreaterThan(0);
    expect(upstream).toBeGreaterThan(0);
  });
});

describe('demo archived run clone path', () => {
  const contosoPath = 'C:\\Users\\dev\\work\\contoso-web';

  it('puts a run in a sibling of the scratch clone named for its task, less the task- prefix', () => {
    expect(archivedCloneSegments(contosoPath, 'task-cw-done-deploy')).toEqual(['work', 'contoso-web-cw-done-deploy']);
  });

  it('reads a forward-slash path the same as a backslash one', () => {
    expect(archivedCloneSegments('C:/Users/dev/work/contoso-web', 'task-cw-done-deploy')).toEqual(['work', 'contoso-web-cw-done-deploy']);
  });

  it('roots the clone under the directory it is given', () => {
    const root = path.join(os.tmpdir(), 'demo-home');
    expect(archivedClonePath(root, contosoPath, 'task-cw-done-deploy')).toBe(path.join(root, 'work', 'contoso-web-cw-done-deploy'));
  });

  it('roots the scratch clone under the same directory, and puts every run beside it rather than inside it', () => {
    const root = path.join(os.tmpdir(), 'demo-home');
    const scratch = scratchClonePath(root, contosoPath);
    expect(scratch).toBe(path.join(root, 'work', 'contoso-web'));
    // A sibling, so the project's own clone (the History pane's and the graph's commit count) is never a run's working tree.
    const run = archivedClonePath(root, contosoPath, 'task-cw-done-deploy');
    expect(path.dirname(run)).toBe(path.dirname(scratch));
    expect(run).not.toBe(scratch);
    expect(path.basename(run).startsWith(`${path.basename(scratch)}-`)).toBe(true);
    // The same rule for a forward-slash dataset path, as on a recording machine that spells it so.
    expect(scratchClonePath(root, 'C:/Users/dev/work/contoso-web')).toBe(scratch);
  });

  // The clone rule lives in a script library and the slug rule in the dataset; the two must name
  // every archived task the same way, or the graph capture looks for a run's history elsewhere.
  it('names each archived task\'s clone with the dataset\'s own slug for it', () => {
    expect(DEMO_ARCHIVED_TASKS.length).toBeGreaterThan(0);
    for (const task of DEMO_ARCHIVED_TASKS) {
      const project = DEMO_PROJECTS.find((candidate) => candidate.id === task.projectId);
      const segments = archivedCloneSegments(project?.path ?? '', task.id);
      expect(segments.at(-1), task.id).toMatch(new RegExp(`-${taskSlugOf(task.id)}$`));
    }
  });
});

describe('demo capture scratch root', () => {
  it('is the home directory when no --root is given', () => {
    expect(scratchRootFromArgv(['--check'])).toBe(os.homedir());
  });

  it('is the directory after --root', () => {
    const root = path.join(os.tmpdir(), 'demo-scratch');
    expect(scratchRootFromArgv(['--force', '--root', root, '--check'])).toBe(root);
  });

  it('makes a relative --root absolute, as Claude files a run\'s history under its absolute directory', () => {
    expect(scratchRootFromArgv(['--root', 'demo-scratch'])).toBe(path.resolve('demo-scratch'));
  });

  it.each([
    ['nothing after it', ['--root']],
    ['another flag after it', ['--root', '--check']],
  ])('refuses a --root with %s rather than falling back to the home directory', (_label, argv) => {
    expect(() => scratchRootFromArgv(argv)).toThrow('--root needs a directory after it');
  });
});
