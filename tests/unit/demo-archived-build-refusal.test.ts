/**
 * The web build refuses to seed an archived task that has no recorded run.
 *
 * An archived task with no run would draw "-" in every Completed Tasks cell. The refusal lives in
 * `buildDemoPreConfig`, at build time, and not at module load, because the run recorder
 * (scripts/capture-demo-archived-runs.mjs) has to load the dataset before the runs exist. The list
 * it reads, `DEMO_ARCHIVED_TASKS_WITHOUT_RUN`, is computed at module load from
 * tests/captures/fixtures/demo/archived/runs.json, so with the real data the throw is unreachable.
 * This file reloads the dataset over a runs file with a task's run taken out and holds the three
 * halves of the contract: the module still loads, the list names the gap, and the build throws.
 *
 * `buildDemoPreConfig` checks every session's recording BEFORE it checks the runs, so each call
 * here passes a stub recording per session. Without it the build would throw for the recordings,
 * and a bare `toThrow()` would pass against the wrong check.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The specifier the test hands vi.doMock, relative to this file. It resolves to the same file the
// dataset imports as '../fixtures/demo/archived/runs.json'.
const RUNS_SPECIFIER = '../captures/fixtures/demo/archived/runs.json';
const RUNS_FILE = path.resolve(__dirname, RUNS_SPECIFIER);

async function importDataset() {
  return import('../captures/helpers/demo-dataset');
}
type DemoDataset = Awaited<ReturnType<typeof importDataset>>;

/** The dataset module as a fresh load sees it, over the real runs file. */
async function loadRealDataset(): Promise<DemoDataset> {
  vi.resetModules();
  return importDataset();
}

/** The dataset module as a fresh load sees it, over `runs` in place of the real runs file. */
async function loadDatasetOverRuns(runs: Record<string, unknown>): Promise<DemoDataset> {
  vi.resetModules();
  vi.doMock(RUNS_SPECIFIER, () => ({ default: runs }));
  return importDataset();
}

/** The runs file's own contents, minus the runs of `taskIds`. */
function realRunsWithout(taskIds: string[]): Record<string, unknown> {
  const runs = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf-8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(runs).filter(([taskId]) => !taskIds.includes(taskId)));
}

/** One recording stub per session, which is all the build's recordings check wants. */
function stubRecordings(dataset: DemoDataset): Record<string, string> {
  return Object.fromEntries(dataset.DEMO_SESSIONS.map((session) => [session.id, 'recording']));
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the action to throw, and it returned');
}

describe('the demo build refuses an archived task with no recorded run', () => {
  afterEach(() => {
    vi.doUnmock(RUNS_SPECIFIER);
    vi.resetModules();
  });

  it('lists nothing and builds on the real runs', async () => {
    const dataset = await loadRealDataset();
    // Vacuity guard: the sample install archives tasks, so an empty list says something.
    expect(dataset.DEMO_ARCHIVED_TASKS.length).toBeGreaterThan(0);
    expect(dataset.DEMO_ARCHIVED_TASKS_WITHOUT_RUN).toEqual([]);

    const script = dataset.buildDemoPreConfig({ scrollback: stubRecordings(dataset) });
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
  });

  it('still loads the module when one archived task has no run, and lists exactly that task', async () => {
    const real = await loadRealDataset();
    // The list only covers an archived task with no session on the board, so take the id from it.
    const droppedTaskId = real.DEMO_ARCHIVED_TASKS[0].id;

    const dataset = await loadDatasetOverRuns(realRunsWithout([droppedTaskId]));

    // The mock took: the dropped task has no run, and every other archived task keeps its own.
    expect(dataset.DEMO_ARCHIVED_RUNS[droppedTaskId]).toBeUndefined();
    expect(dataset.DEMO_ARCHIVED_TASKS_WITHOUT_RUN).toEqual([droppedTaskId]);
    // The summaries leave the gap out rather than failing the load, which the recorder relies on.
    expect(dataset.DEMO_ARCHIVED_SUMMARIES.map((summary) => summary.taskId)).not.toContain(droppedTaskId);
    expect(dataset.DEMO_ARCHIVED_SUMMARIES).toHaveLength(real.DEMO_ARCHIVED_SUMMARIES.length - 1);
  });

  it('refuses to build, naming the task and the command that records its run', async () => {
    const real = await loadRealDataset();
    const droppedTaskId = real.DEMO_ARCHIVED_TASKS[0].id;

    const dataset = await loadDatasetOverRuns(realRunsWithout([droppedTaskId]));
    const message = thrownMessage(() => dataset.buildDemoPreConfig({ scrollback: stubRecordings(dataset) }));

    // It is the runs check that threw, not the recordings check that runs before it.
    expect(message).not.toContain('no terminal recording');
    expect(message).toContain('[demo] no recorded run for 1 archived task(s)');
    expect(message).toContain(`first ${droppedTaskId}:`);
    expect(message).toContain('node scripts/capture-demo-archived-runs.mjs');
  });

  it('counts every missing run and names the first in the dataset\'s order', async () => {
    const real = await loadRealDataset();
    // Vacuity guard: two tasks must be droppable for the count to be more than one.
    expect(real.DEMO_ARCHIVED_TASKS.length).toBeGreaterThan(1);
    const [firstTask, secondTask] = real.DEMO_ARCHIVED_TASKS;

    const dataset = await loadDatasetOverRuns(realRunsWithout([secondTask.id, firstTask.id]));
    expect(dataset.DEMO_ARCHIVED_TASKS_WITHOUT_RUN).toEqual([firstTask.id, secondTask.id]);

    const message = thrownMessage(() => dataset.buildDemoPreConfig({ scrollback: stubRecordings(dataset) }));
    expect(message).toContain('no recorded run for 2 archived task(s)');
    expect(message).toContain(`first ${firstTask.id}:`);
  });
});
