/**
 * `handleGetUsageStats`'s Background section
 * (src/main/agent/commands/usage-commands.ts, `formatBackgroundLine` and the
 * `includeSeries` strip in the handler).
 *
 * Background calls are the headless runs Kangentic makes on the user's behalf
 * (condition checks, workflow step checks, task summaries, task titles,
 * terminal names). The CLI message reports them as ONE line after the session
 * lines, the same numbers the dashboard's Background card shows, and says they
 * are not in the totals above it. The expected strings below are written out
 * by hand from that intent (a call count, an optional cost, a usage clause, a
 * jobs sentence whose first label keeps its capital), not rebuilt from the
 * label table with the implementation's own transform.
 *
 * The payload deliberately fills every series the handler strips (the three
 * session series and `background.byDay`), because an empty series would stay
 * absent whether or not the strip ran.
 *
 * `usageStatsService` is a module-level singleton built from real dependencies
 * at import time, so the whole module is mocked, as in
 * usage-commands-subagent-message.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type {
  BackgroundCallTotals,
  BackgroundDayUsage,
  BackgroundJobUsage,
  BackgroundUsage,
  CostSeriesPoint,
  TokenSeriesPoint,
  UsageDashboardStats,
} from '../../src/shared/types';
import { makeUsageKpis, makeUsageStats } from './helpers/usage-stats-fixture';

const { mockGetDashboardStats } = vi.hoisted(() => ({
  mockGetDashboardStats: vi.fn(),
}));

vi.mock('../../src/main/usage-stats/usage-stats-service', () => ({
  usageStatsService: { getDashboardStats: mockGetDashboardStats },
}));

import { handleGetUsageStats } from '../../src/main/agent/commands/usage-commands';

const BACKGROUND_LINE_PREFIX = '  Background (not in the totals above):';

const TOKEN_SERIES: TokenSeriesPoint[] = [
  { bucketStartMs: 1000, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 1, cacheReadTokens: 2, allocatedCostUsd: 0.5, turnCount: 1 },
];

const COST_SERIES: CostSeriesPoint[] = [
  { bucketStartMs: 1000, costUsd: 0.5, inputTokens: 10, outputTokens: 5, sessionCount: 1, byModel: [] },
];

const TOKEN_MODEL_SERIES: CostSeriesPoint[] = [
  {
    bucketStartMs: 1000,
    costUsd: 0,
    inputTokens: 10,
    outputTokens: 5,
    sessionCount: 1,
    byModel: [{ modelId: 'model-one', costUsd: 0, inputTokens: 10, outputTokens: 5 }],
  },
];

function makeTotals(overrides: Partial<BackgroundCallTotals> = {}): BackgroundCallTotals {
  return {
    calls: 0,
    failedCalls: 0,
    reportedCalls: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    durationMs: 0,
    ...overrides,
  };
}

/** A job row; `makeJob('condition_check')` is a job with no calls. */
function makeJob(job: BackgroundJobUsage['job'], overrides: Partial<BackgroundCallTotals> = {}): BackgroundJobUsage {
  return { ...makeTotals(overrides), job, models: [] };
}

/**
 * Every job in the one display order (condition checks, workflow steps, task
 * summaries, task titles, terminal names). Condition checks and task summaries
 * have no calls, so the sentence's first job is the SECOND row: the capital
 * goes to the first job that has calls, not to the first row.
 */
function makeByJob(costs: { workflowSteps: number | null; taskTitles: number | null; terminalNames: number | null }): BackgroundJobUsage[] {
  return [
    makeJob('condition_check'),
    makeJob('workflow_step', { calls: 2, costUsd: costs.workflowSteps }),
    makeJob('task_summary'),
    makeJob('task_title', { calls: 3, costUsd: costs.taskTitles }),
    makeJob('terminal_name', { calls: 1, costUsd: costs.terminalNames }),
  ];
}

const REPORTED_TOTALS: BackgroundCallTotals = makeTotals({
  calls: 6,
  reportedCalls: 5,
  inputTokens: 1234,
  cacheCreationInputTokens: 100,
  cacheReadInputTokens: 5000,
  outputTokens: 400,
  costUsd: 0.5,
});

const BY_DAY: BackgroundDayUsage[] = [
  { ...makeTotals({ calls: 2, costUsd: 0.1 }), dayStartMs: 1000, job: 'workflow_step', models: [] },
];

function makeBackground(overrides: Partial<BackgroundUsage> = {}): BackgroundUsage {
  return {
    totals: REPORTED_TOTALS,
    byJob: makeByJob({ workflowSteps: 0.1, taskTitles: 0.2, terminalNames: null }),
    byDay: BY_DAY,
    ...overrides,
  };
}

/** Every series the handler strips is filled (see the file header). */
function makeStats(overrides: Partial<UsageDashboardStats> = {}): UsageDashboardStats {
  return makeUsageStats({
    tokenSeries: TOKEN_SERIES,
    costSeries: COST_SERIES,
    tokenModelSeries: TOKEN_MODEL_SERIES,
    ...overrides,
  });
}

function makeContext(): CommandContext {
  return {} as unknown as CommandContext;
}

/** The message's Background line, or undefined when the message has none. */
function backgroundLineOf(message: string | undefined): string | undefined {
  return (message ?? '').split('\n').find((line) => line.startsWith(BACKGROUND_LINE_PREFIX));
}

async function runWith(
  background: BackgroundUsage | undefined,
  params: Record<string, unknown> = {},
) {
  mockGetDashboardStats.mockReturnValue(makeStats({ background }));
  return handleGetUsageStats({ allProjects: true, ...params }, makeContext());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleGetUsageStats Background line', () => {
  it('reports the call count, cost, usage and jobs on one line after the session lines', async () => {
    const response = await runWith(makeBackground());

    expect(response.success).toBe(true);
    expect(backgroundLineOf(response.message)).toBe(
      '  Background (not in the totals above): 6 calls, $0.50. Tokens: 1,234 fresh input + 400 output, 100 cache write, 5,000 cache read. Workflow steps 2 ($0.10), task titles 3 ($0.20), terminal names 1.',
    );
    // The Background line is the last line of the message, after the
    // session lines, so it can never be read as part of their totals.
    const lines = (response.message ?? '').split('\n');
    expect(lines[lines.length - 1]).toBe(backgroundLineOf(response.message));
  });

  it('capitalizes only the first job that has calls and lowercases the rest, skipping jobs with none', async () => {
    const response = await runWith(makeBackground());

    const line = backgroundLineOf(response.message) ?? '';
    // Condition checks and Task summaries have no calls, so neither appears.
    expect(line).not.toContain('ondition checks');
    expect(line).not.toContain('ask summaries');
    // First with calls keeps its capital; every later label is lowered.
    expect(line).toContain('. Workflow steps 2 (');
    expect(line).toContain(', task titles 3 (');
    expect(line).toContain(', terminal names 1.');
    expect(line).not.toContain('Task titles');
    expect(line).not.toContain('Terminal names');
  });

  it('lowers every label after the first even when the first job in the list has calls', async () => {
    const byJob: BackgroundJobUsage[] = [
      makeJob('condition_check', { calls: 4, costUsd: 0.04 }),
      makeJob('workflow_step', { calls: 1, costUsd: 0.01 }),
      makeJob('task_summary'),
      makeJob('task_title'),
      makeJob('terminal_name'),
    ];
    const response = await runWith(makeBackground({
      totals: makeTotals({ calls: 5, reportedCalls: 5, costUsd: 0.05 }),
      byJob,
    }));

    expect(backgroundLineOf(response.message)).toMatch(/\. Condition checks 4 \(\$0\.04\), workflow steps 1 \(\$0\.01\)\.$/);
  });

  it('says usage was not reported, and prints no token figures, when no call reported usage', async () => {
    const response = await runWith(makeBackground({
      totals: makeTotals({ calls: 6, reportedCalls: 0, costUsd: 0.5 }),
    }));

    const line = backgroundLineOf(response.message) ?? '';
    expect(line).toBe(
      '  Background (not in the totals above): 6 calls, $0.50. usage not reported. Workflow steps 2 ($0.10), task titles 3 ($0.20), terminal names 1.',
    );
    // The main-thread line carries "Tokens", so this has to be asserted on the
    // Background line alone.
    expect(line).not.toContain('Tokens:');
  });

  it('prints the token figures, not the unreported clause, when calls reported usage', async () => {
    const response = await runWith(makeBackground());

    const line = backgroundLineOf(response.message) ?? '';
    expect(line).toContain('Tokens: 1,234 fresh input + 400 output');
    expect(line).not.toContain('usage not reported');
  });

  it('omits the cost when no call reported one', async () => {
    const response = await runWith(makeBackground({
      totals: makeTotals({ calls: 6, reportedCalls: 5, inputTokens: 1234, cacheCreationInputTokens: 100, cacheReadInputTokens: 5000, outputTokens: 400, costUsd: null }),
      byJob: makeByJob({ workflowSteps: null, taskTitles: null, terminalNames: null }),
    }));

    const line = backgroundLineOf(response.message) ?? '';
    // The Cost line above has a "$", so scope the check to the Background line.
    expect(line).not.toContain('$');
    expect(line).toBe(
      '  Background (not in the totals above): 6 calls. Tokens: 1,234 fresh input + 400 output, 100 cache write, 5,000 cache read. Workflow steps 2, task titles 3, terminal names 1.',
    );
  });

  it('adds no Background line when the range had no background calls', async () => {
    const response = await runWith(makeBackground({
      totals: makeTotals(),
      byJob: [
        makeJob('condition_check'),
        makeJob('workflow_step'),
        makeJob('task_summary'),
        makeJob('task_title'),
        makeJob('terminal_name'),
      ],
      byDay: [],
    }));

    expect(response.success).toBe(true);
    expect(backgroundLineOf(response.message)).toBeUndefined();
    expect(response.message).not.toContain('Background');
  });

  it('adds no Background line when the payload has no background at all (an older build)', async () => {
    const response = await runWith(undefined);

    expect(response.success).toBe(true);
    expect(response.message).not.toContain('Background');
  });
});

describe('handleGetUsageStats includeSeries', () => {
  it('drops the session series and the Background per-day rows by default, keeping totals and byJob', async () => {
    const background = makeBackground();
    const response = await runWith(background);

    expect(response.success).toBe(true);
    const data = response.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('tokenSeries');
    expect(data).not.toHaveProperty('costSeries');
    expect(data).not.toHaveProperty('tokenModelSeries');
    // An exact match pins both halves at once: byDay is gone, totals and byJob stay.
    expect(data.background).toEqual({ totals: background.totals, byJob: background.byJob });
    expect(data.background).not.toHaveProperty('byDay');
    // The KPI and breakdown reads the strip must leave alone.
    expect(data.kpis).toEqual(makeUsageKpis());
    expect(data).toHaveProperty('byModel');
  });

  it('leaves no background key on the stripped data when the payload has none', async () => {
    const response = await runWith(undefined);

    const data = response.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('background');
    expect(data).not.toHaveProperty('tokenSeries');
  });

  it('keeps every series, and the Background per-day rows, when includeSeries is true', async () => {
    const background = makeBackground();
    const response = await runWith(background, { includeSeries: true });

    expect(response.success).toBe(true);
    const data = response.data as Record<string, unknown>;
    expect(data.tokenSeries).toEqual(TOKEN_SERIES);
    expect(data.costSeries).toEqual(COST_SERIES);
    expect(data.tokenModelSeries).toEqual(TOKEN_MODEL_SERIES);
    expect(data.background).toEqual(background);
    expect((data.background as BackgroundUsage).byDay).toEqual(BY_DAY);
  });

  it('treats a non-true includeSeries value as off', async () => {
    const response = await runWith(makeBackground(), { includeSeries: 'true' });

    const data = response.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('tokenSeries');
    expect(data.background).not.toHaveProperty('byDay');
  });
});
