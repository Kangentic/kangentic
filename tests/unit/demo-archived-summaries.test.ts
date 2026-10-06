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
import { humanizeClaudeModelId } from '../../src/main/agent/adapters/claude/model-display-name';
import {
  DEMO_ARCHIVED_RUNS, DEMO_ARCHIVED_SUMMARIES, DEMO_ARCHIVED_TASKS, DEMO_COLUMN_MODELS, DEMO_HISTORY, DEMO_PROJECTS, DEMO_SESSIONS, DEMO_TASKS,
  archivedRunPromptOf, taskSlugOf,
} from '../../tests/captures/helpers/demo-dataset';
import { archivedClonePath, archivedCloneSegments, scratchRootFromArgv } from '../../scripts/lib/demo-archived-clone.mjs';

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
        taskId: summary.taskId, effort: run.effort ?? null, costUsd: run.costUsd, durationMs: run.durationMs, inputTokens: run.inputTokens,
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
