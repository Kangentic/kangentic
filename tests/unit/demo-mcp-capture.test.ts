/**
 * scripts/lib/demo-mcp-capture.mjs gets a recording whose agent calls Kangentic's own MCP tools
 * ready to start: it seeds a running /preview with the board the scene paints, writes the two
 * launch files the desktop hands Claude for its server, and judges the headless run that leaves
 * the work the recorded session reviews. `prepareMcpCapture` needs a real git worktree and a real
 * `claude -p` run, so it is out of reach of a unit test. This file pins the five exports that are
 * pure or touch only the temp folder: `laneNameOf`, `seedPlanFor`, `writeLaunchFiles`,
 * `preparedRunSucceeded`, and `planFixtureOf`, which turns the plan a recorded workflow agent saved
 * into the fixture the web build seeds.
 *
 * `prepareWorkflowAgentCapture` is reachable because every call it makes to the preview goes
 * through ./preview-bridge.mjs, which this file replaces with a fake preview: an in-memory
 * `window.electronAPI` (projects, config, seeding, columns, cards, workflows) that runs the exact
 * expression strings the rig builds, so the expressions themselves are exercised. It pins the
 * three guards that refuse a bad manifest entry BEFORE any preview call (a non-Claude agent, an
 * unknown backlog item, a backlog item whose project the dataset lacks, the last throwing a
 * `[workflow]` error rather than a bare TypeError); that a failure after the board is seeded
 * releases it before the ORIGINAL error is rethrown, even when the release fails too (the seeded
 * project dropped, the preview's Claude path put back only if it had been changed); the launch it returns and the cleanup that
 * takes the board and the launch folder back; and that a launch folder that cannot be removed is
 * reported by path instead of thrown, without hiding the release's own failure.
 *
 * `preparedRunSucceeded` reads the stdout of `claude -p --output-format json`, an external input,
 * so it is pinned to two REAL captures (tests/fixtures/claude-print-result-success.json and
 * claude-print-result-condition-check.json) and to variations of them, never to a hand-written
 * shape alone. `seedPlanFor` runs over the real sample install (tests/captures/helpers/demo-dataset.ts)
 * for the main pins, plus a small synthetic dataset for the distinctions the real data cannot
 * make: every Done task there is also archived, so a swap of the two flags would pass on it.
 * Every file this test writes lives under os.tmpdir() and is removed afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as dataset from '../captures/helpers/demo-dataset';
import {
  laneNameOf,
  planFixtureOf,
  prepareWorkflowAgentCapture,
  preparedRunSucceeded,
  seedPlanFor,
  writeLaunchFiles,
} from '../../scripts/lib/demo-mcp-capture.mjs';

// Every call prepareWorkflowAgentCapture makes to the running preview goes through these three.
const previewBridge = vi.hoisted(() => ({
  readPreviewPort: vi.fn(),
  evaluateInPreview: vi.fn(),
  postToPreview: vi.fn(),
}));
vi.mock('../../scripts/lib/preview-bridge.mjs', () => previewBridge);

const FIXTURES_DIRECTORY = path.resolve(__dirname, '..', 'fixtures');

interface SeededTask {
  key: string;
  title: string;
  description: string;
  labels: string[];
  displayId: number;
  done: boolean;
  archived: boolean;
  lane: string;
  branchName: string | null;
  baseBranch: string | null;
  worktreePath?: string;
}

interface SeededBacklogItem {
  title: string;
  description: string;
  priority: number;
  labels: string[];
}

interface SeededProject {
  key: string;
  name: string;
  path: string;
  defaultAgent: string;
  columnAgents: Record<string, string>;
  tasks: SeededTask[];
  backlog: SeededBacklogItem[];
  sessions: unknown[];
}

interface SeedPlan {
  projects: SeededProject[];
}

interface LaunchSettings {
  verbose?: boolean;
  permissions?: { allow: string[]; defaultMode?: string };
}

function mustFind<Item>(items: readonly Item[], predicate: (item: Item) => boolean, description: string): Item {
  const found = items.find(predicate);
  if (found === undefined) throw new Error(`the sample install has no ${description}`);
  return found;
}

function readFixture(fileName: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), 'utf-8');
}

describe('preparedRunSucceeded', () => {
  const successCapture = readFixture('claude-print-result-success.json');
  const conditionCheckCapture = readFixture('claude-print-result-condition-check.json');

  it('is true for a real success capture of claude -p --output-format json', () => {
    expect(preparedRunSucceeded(successCapture)).toBe(true);
  });

  it('is true for the second real capture, which carries a different model and a longer answer', () => {
    expect(preparedRunSucceeded(conditionCheckCapture)).toBe(true);
  });

  it('is false once a real capture reports is_error true', () => {
    const flipped = successCapture.replace('"is_error":false', '"is_error":true');
    // Guard against the replace matching nothing, which would turn this into the success case.
    expect(flipped).not.toBe(successCapture);
    expect(preparedRunSucceeded(flipped)).toBe(false);
  });

  it('is false for the error result shape the JSON extractor test builds', () => {
    const errorResult = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: 529 overloaded',
    });
    expect(preparedRunSucceeded(errorResult)).toBe(false);
  });

  it('is false for a result object whose is_error is missing, or is not the boolean false', () => {
    const parsed = JSON.parse(successCapture) as Record<string, unknown>;
    const withoutIsError = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'is_error'));
    expect(preparedRunSucceeded(JSON.stringify(withoutIsError))).toBe(false);
    expect(preparedRunSucceeded(JSON.stringify({ ...parsed, is_error: null }))).toBe(false);
    expect(preparedRunSucceeded(JSON.stringify({ ...parsed, is_error: 'false' }))).toBe(false);
  });

  it('is false for a JSON object that is not a result record', () => {
    const parsed = JSON.parse(successCapture) as Record<string, unknown>;
    expect(preparedRunSucceeded(JSON.stringify({ ...parsed, type: 'assistant' }))).toBe(false);
  });

  it('is false for a JSON array of records, even one that ends in a real success result', () => {
    // The shape a verbose run prints: the records of the whole conversation, the result last.
    const records = [
      { type: 'system', subtype: 'init', session_id: 'd4aff2de-7eb9-4bf8-85f8-a6475887fafd' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      JSON.parse(successCapture),
    ];
    expect(preparedRunSucceeded(JSON.stringify(records))).toBe(false);
  });

  it('is false for empty stdout, whitespace, non-JSON text, and a JSON scalar or null', () => {
    expect(preparedRunSucceeded('')).toBe(false);
    expect(preparedRunSucceeded('   \n')).toBe(false);
    expect(preparedRunSucceeded('Error: claude exited before printing a result')).toBe(false);
    expect(preparedRunSucceeded('null')).toBe(false);
    expect(preparedRunSucceeded('true')).toBe(false);
    expect(preparedRunSucceeded('"ok"')).toBe(false);
  });

  it('is false for a real capture cut off mid-object, as a killed run leaves it', () => {
    expect(preparedRunSucceeded(successCapture.slice(0, successCapture.length / 2))).toBe(false);
  });
});

describe('planFixtureOf', () => {
  const lanes = [
    { id: 'lane-uuid-todo', name: 'To Do' },
    { id: 'lane-uuid-planning', name: 'Planning' },
    { id: 'lane-uuid-executing', name: 'Executing' },
  ];
  const runSettings = {
    base_branch: null, use_worktree: null, run_mode: 'column_settings', profile_id: null,
    agent_override: null, model_override: null, effort_override: null, permission_mode: null,
  };
  function plannedTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      key: 'pdf-route', title: 'Invoice PDF route', description: 'The server half.', labels: ['feature'], priority: 0,
      project_id: null, existing_task_id: null,
      route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
      canvas_x: null, canvas_y: null, ...runSettings, ...overrides,
    };
  }
  function workflowWith(tasks: Array<Record<string, unknown>>, links: Array<{ blocker: string; blocked: string }> = []) {
    return { title: 'Invoice PDF export', brief: 'Invoice PDF export\n\nA downloadable invoice', draft: { tasks, links } };
  }

  it('names each column by its name, so the plan reads on the sample install\'s own ids', () => {
    const plan = planFixtureOf(workflowWith([
      plannedTask({ route_start_swimlane_id: 'lane-uuid-executing', skipped_swimlane_ids: ['lane-uuid-planning'] }),
    ]), lanes);

    expect(plan.tasks[0]).toMatchObject({ routeStart: 'Executing', routeLast: null, skipped: ['Planning'] });
  });

  it('keeps the title, the brief, the links, and every run setting but the profile, as saved', () => {
    const plan = planFixtureOf(workflowWith(
      [plannedTask(), plannedTask({ key: 'billing-page', title: 'Billing page', model_override: 'claude-opus-5' })],
      [{ blocker: 'pdf-route', blocked: 'billing-page' }],
    ), lanes);

    expect(plan.title).toBe('Invoice PDF export');
    expect(plan.brief).toBe('Invoice PDF export\n\nA downloadable invoice');
    expect(plan.links).toEqual([{ blocker: 'pdf-route', blocked: 'billing-page' }]);
    expect(plan.tasks[1].runSettings).toEqual({ ...Object.fromEntries(Object.entries(runSettings).filter(([key]) => key !== 'profile_id')), model_override: 'claude-opus-5' });
  });

  it('refuses a column its board does not have, rather than dropping it from the route', () => {
    expect(() => planFixtureOf(workflowWith([plannedTask({ route_last_swimlane_id: 'lane-uuid-gone' })]), lanes)).toThrow('which its board does not have');
  });

  it.each([
    [{ project_id: 'proj-other' }, 'another project'],
    [{ existing_task_id: 'task-on-board' }, 'takes over a task already on the board'],
    [{ profile_id: 'profile-1' }, 'Board Profile'],
  ])('refuses a plan the sample install\'s draft cannot show the same way: %j', (overrides, message) => {
    expect(() => planFixtureOf(workflowWith([plannedTask(overrides)]), lanes)).toThrow(message);
  });

  it('refuses a workflow with no plan, a started one or one the agent never saved', () => {
    expect(() => planFixtureOf({ title: 'Invoice PDF export', brief: null, draft: null }, lanes)).toThrow('has no plan');
  });
});

describe('writeLaunchFiles', () => {
  const MCP_URL = 'http://127.0.0.1:54321/mcp/contoso-web';
  const MCP_TOKEN = 'test-token-0123456789abcdef';
  const createdDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of createdDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  /** Writes the launch files and registers the folder for removal before any assertion can fail. */
  function writeTracked(userSettings?: LaunchSettings & Record<string, unknown>) {
    const launch = writeLaunchFiles(MCP_URL, MCP_TOKEN, userSettings);
    createdDirectories.push(launch.directory);
    return launch;
  }

  function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  it('writes mcp.json and settings.json into a fresh kangentic-demo-mcp folder under the temp directory', () => {
    const launch = writeTracked({ verbose: true });

    expect(path.resolve(path.dirname(launch.directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(launch.directory)).toMatch(/^kangentic-demo-mcp-./);
    expect(launch.mcpConfigPath).toBe(path.join(launch.directory, 'mcp.json'));
    expect(launch.settingsPath).toBe(path.join(launch.directory, 'settings.json'));
    expect(fs.existsSync(launch.mcpConfigPath)).toBe(true);
    expect(fs.existsSync(launch.settingsPath)).toBe(true);
  });

  it('names the server URL and the per-launch token in mcp.json, and nothing else', () => {
    const launch = writeTracked({ verbose: true });

    expect(readJson(launch.mcpConfigPath)).toStrictEqual({
      mcpServers: { kangentic: { type: 'http', url: MCP_URL, headers: { 'X-Kangentic-Token': MCP_TOKEN } } },
    });
  });

  it('keeps the display preference and allows only the mcp__kangentic rule in settings.json', () => {
    const launch = writeTracked({ verbose: true });

    expect(readJson(launch.settingsPath)).toStrictEqual({
      verbose: true,
      permissions: { allow: ['mcp__kangentic'] },
    });
  });

  it('pins Claude\'s built-in default mode beside the allow rule when asked, for a launch that passes no mode flag', () => {
    const launch = writeLaunchFiles(MCP_URL, MCP_TOKEN, { verbose: true }, { pinBuiltInDefaultMode: true });
    createdDirectories.push(launch.directory);

    expect(readJson(launch.settingsPath)).toStrictEqual({
      verbose: true,
      permissions: { allow: ['mcp__kangentic'], defaultMode: 'default' },
    });
  });

  it('writes just the permissions block when the entry carries no settings', () => {
    const launch = writeTracked(undefined);

    expect(readJson(launch.settingsPath)).toStrictEqual({ permissions: { allow: ['mcp__kangentic'] } });
  });

  it('gives each call its own folder', () => {
    const first = writeTracked();
    const second = writeTracked();

    expect(second.directory).not.toBe(first.directory);
  });

  it('throws when the entry carries a permissions key, naming that it carries none', () => {
    expect(() => writeLaunchFiles(MCP_URL, MCP_TOKEN, { verbose: true, permissions: { allow: ['Bash'] } })).toThrow(
      /carries no permissions/,
    );
  });

  it('refuses a permissions key before it creates any folder', () => {
    const makeDirectory = vi.spyOn(fs, 'mkdtempSync');

    expect(() => writeLaunchFiles(MCP_URL, MCP_TOKEN, { permissions: { allow: [] } })).toThrow(/carries no permissions/);
    expect(makeDirectory).not.toHaveBeenCalled();
  });

  it('removes the folder, token and all, when a write fails', () => {
    const makeDirectory = vi.spyOn(fs, 'mkdtempSync');
    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (String(target).endsWith('settings.json')) throw new Error('disk full');
      return realWriteFileSync(target, data, options);
    });

    expect(() => writeLaunchFiles(MCP_URL, MCP_TOKEN, { verbose: true })).toThrow('disk full');

    // mcp.json had already been written with the token when settings.json failed.
    expect(makeDirectory).toHaveBeenCalledTimes(1);
    const result = makeDirectory.mock.results[0];
    expect(result.type).toBe('return');
    const directory = String(result.value);
    createdDirectories.push(directory);
    expect(fs.existsSync(directory)).toBe(false);
  });
});

describe('laneNameOf', () => {
  it('names a real task\'s column by its display name, not by its slug', () => {
    const validateTask = mustFind(dataset.DEMO_ALL_TASKS, (task) => task.id === dataset.TASK_VALIDATE, 'Validate task');
    const authTask = mustFind(dataset.DEMO_ALL_TASKS, (task) => task.id === dataset.TASK_AUTH, 'auth task');

    expect(validateTask.lane).toBe('review');
    expect(laneNameOf(dataset, validateTask)).toBe('Code Review');
    expect(authTask.lane).toBe('todo');
    expect(laneNameOf(dataset, authTask)).toBe('To Do');
  });

  it('reads the lanes of the task\'s own project when two boards share a slug', () => {
    const twoBoards = {
      DEMO_LANES_BY_PROJECT: {
        'proj-alpha': [{ slug: 'work', name: 'Alpha Work', agent: null }],
        'proj-beta': [{ slug: 'work', name: 'Beta Work', agent: null }],
      },
    };

    expect(laneNameOf(twoBoards, { id: 'alpha-1', projectId: 'proj-alpha', lane: 'work' })).toBe('Alpha Work');
    expect(laneNameOf(twoBoards, { id: 'beta-1', projectId: 'proj-beta', lane: 'work' })).toBe('Beta Work');
  });

  it('throws, naming the slug, for a task whose lane its project\'s board lacks', () => {
    const validateTask = mustFind(dataset.DEMO_ALL_TASKS, (task) => task.id === dataset.TASK_VALIDATE, 'Validate task');
    const strayTask = { ...validateTask, lane: 'no-such-lane' };

    expect(() => laneNameOf(dataset, strayTask)).toThrow(/no-such-lane/);
    expect(() => laneNameOf(dataset, strayTask)).toThrow(dataset.TASK_VALIDATE);
  });

  it('throws for a task of a project with no board at all', () => {
    const validateTask = mustFind(dataset.DEMO_ALL_TASKS, (task) => task.id === dataset.TASK_VALIDATE, 'Validate task');
    const orphanTask = { ...validateTask, projectId: 'proj-without-a-board' };

    expect(() => laneNameOf(dataset, orphanTask)).toThrow(/review/);
  });

  it('does not take another project\'s lane for the slug', () => {
    // The 'qa' slug exists on the alpha board only, so a beta task naming it has no column.
    const onlyAlphaHasIt = {
      DEMO_LANES_BY_PROJECT: {
        'proj-alpha': [{ slug: 'qa', name: 'Alpha QA', agent: null }],
        'proj-beta': [{ slug: 'work', name: 'Beta Work', agent: null }],
      },
    };

    expect(() => laneNameOf(onlyAlphaHasIt, { id: 'beta-1', projectId: 'proj-beta', lane: 'qa' })).toThrow(/qa/);
  });
});

describe('seedPlanFor over the real sample install', () => {
  const SEED_ROOT = path.join(os.tmpdir(), 'kangentic-demo-mcp-seed-root');
  const contosoProject = mustFind(dataset.DEMO_PROJECTS, (project) => project.id === dataset.PROJECT_CONTOSO, 'contoso-web project');
  const recordedTask = mustFind(dataset.DEMO_ALL_TASKS, (task) => task.id === dataset.TASK_VALIDATE, 'Validate task');
  if (!recordedTask.worktree_folder) throw new Error('the Validate task needs a worktree folder to run in');
  const worktree = path.join(SEED_ROOT, '.kangentic', 'worktrees', recordedTask.worktree_folder);

  const plan = seedPlanFor(dataset, contosoProject, SEED_ROOT, recordedTask, worktree) as SeedPlan;
  const [seededProject] = plan.projects;

  const contosoTasks = dataset.DEMO_ALL_TASKS.filter((task) => task.projectId === dataset.PROJECT_CONTOSO);
  const projectOfTask = new Map(dataset.DEMO_ALL_TASKS.map((task) => [task.id, task.projectId]));
  const contosoLanes = dataset.DEMO_LANES_BY_PROJECT[dataset.PROJECT_CONTOSO];
  const seededTaskById = new Map(seededProject.tasks.map((task) => [task.key, task]));

  function seededTask(taskId: string): SeededTask {
    const found = seededTaskById.get(taskId);
    if (!found) throw new Error(`the plan has no task ${taskId}`);
    return found;
  }

  it('seeds one project, registered at the scratch clone rather than at the sample install\'s path', () => {
    expect(plan.projects).toHaveLength(1);
    expect(seededProject.key).toBe(dataset.PROJECT_CONTOSO);
    expect(seededProject.name).toBe(contosoProject.name);
    expect(seededProject.defaultAgent).toBe(contosoProject.default_agent);
    expect(seededProject.path).toBe(SEED_ROOT);
    expect(seededProject.path).not.toBe(contosoProject.path);
    expect(seededProject.sessions).toEqual([]);
  });

  it('seeds every contoso task, the scene-only Validate task included, once each', () => {
    // Vacuity guard: the board is not trivially small, and the scene-only task is one of its tasks.
    expect(contosoTasks.length).toBeGreaterThan(10);
    expect(contosoTasks.some((task) => task.id === dataset.TASK_VALIDATE)).toBe(true);

    const seededKeys = seededProject.tasks.map((task) => task.key);
    expect(new Set(seededKeys).size).toBe(seededKeys.length);
    expect([...seededKeys].sort()).toEqual(contosoTasks.map((task) => task.id).sort());
  });

  it('reads the scene-only rows: Validate is #68, a row the install\'s own task list does not carry', () => {
    expect(dataset.DEMO_TASKS.some((task) => task.id === dataset.TASK_VALIDATE)).toBe(false);
    expect(seededTask(dataset.TASK_VALIDATE).displayId).toBe(68);
  });

  it('seeds no task of another project', () => {
    // Vacuity guard: other projects do have tasks in the dataset to leak.
    expect(dataset.DEMO_ALL_TASKS.some((task) => task.projectId !== dataset.PROJECT_CONTOSO)).toBe(true);
    for (const task of seededProject.tasks) {
      expect(projectOfTask.get(task.key)).toBe(dataset.PROJECT_CONTOSO);
    }
    expect(seededProject.tasks.length).toBeLessThan(dataset.DEMO_ALL_TASKS.length);
  });

  it('places each task in its column by the column\'s NAME', () => {
    expect(seededTask(dataset.TASK_AUTH).lane).toBe('To Do');
    expect(seededTask(dataset.TASK_WEBSOCKET).lane).toBe('Planning');
    expect(seededTask(dataset.TASK_MIDDLEWARE).lane).toBe('Executing');
    expect(seededTask(dataset.TASK_RATE_LIMIT).lane).toBe('Code Review');
    expect(seededTask(dataset.TASK_VALIDATE).lane).toBe('Code Review');
    expect(seededTask(dataset.TASK_SCHEMA).lane).toBe('Done');

    // A name where a slug would be: the two vocabularies share no string on this board.
    const laneSlugs = new Set(contosoLanes.map((lane) => lane.slug));
    const laneNames = new Set(contosoLanes.map((lane) => lane.name));
    for (const task of seededProject.tasks) {
      expect(laneNames.has(task.lane)).toBe(true);
      expect(laneSlugs.has(task.lane)).toBe(false);
    }
  });

  it('marks a task done exactly when it sits in the done lane, and archived exactly when it has an archive age', () => {
    // Vacuity guards: the plan holds tasks on both sides of each flag.
    expect(seededProject.tasks.some((task) => task.done)).toBe(true);
    expect(seededProject.tasks.some((task) => !task.done)).toBe(true);
    expect(seededProject.tasks.some((task) => task.archived)).toBe(true);
    expect(seededProject.tasks.some((task) => !task.archived)).toBe(true);

    for (const source of contosoTasks) {
      const planned = seededTask(source.id);
      expect(planned.done, `${source.id} done`).toBe(source.lane === 'done');
      expect(planned.archived, `${source.id} archived`).toBe(Boolean(source.archivedDaysAgo));
    }
    expect(seededTask(dataset.TASK_SCHEMA)).toMatchObject({ done: true, archived: true });
    expect(seededTask(dataset.TASK_VALIDATE)).toMatchObject({ done: false, archived: false });
  });

  it('carries each task\'s text, labels, ticket number and branch from the dataset', () => {
    for (const source of contosoTasks) {
      expect(seededTask(source.id), source.id).toMatchObject({
        title: source.title,
        description: source.description,
        labels: source.labels,
        displayId: source.display_id,
        branchName: source.branch_name,
        baseBranch: source.base_branch,
      });
    }
  });

  it('builds columnAgents only from the lanes that name an agent, keyed by lane name', () => {
    const lanesWithAgent = contosoLanes.filter((lane) => lane.agent);
    const lanesWithoutAgent = contosoLanes.filter((lane) => !lane.agent);
    // Vacuity guards: the board has both kinds of lane, so "only" and "all" are both exercised.
    expect(lanesWithAgent.length).toBeGreaterThan(0);
    expect(lanesWithoutAgent.length).toBeGreaterThan(0);

    expect(Object.keys(seededProject.columnAgents).sort()).toEqual(lanesWithAgent.map((lane) => lane.name).sort());
    for (const lane of lanesWithAgent) {
      expect(seededProject.columnAgents[lane.name], lane.name).toBe(lane.agent);
    }
    for (const lane of lanesWithoutAgent) {
      expect(seededProject.columnAgents, lane.name).not.toHaveProperty(lane.name);
    }
    for (const lane of contosoLanes) {
      expect(seededProject.columnAgents, `slug ${lane.slug}`).not.toHaveProperty(lane.slug);
    }
    expect(seededProject.columnAgents['Code Review']).toBe('claude');
  });

  it('gives only the recorded task a worktree path', () => {
    expect(seededTask(dataset.TASK_VALIDATE).worktreePath).toBe(worktree);
    const others = seededProject.tasks.filter((task) => task.key !== dataset.TASK_VALIDATE);
    expect(others.length).toBeGreaterThan(0);
    for (const task of others) {
      expect(task, task.key).not.toHaveProperty('worktreePath');
    }
  });

  it('seeds the backlog of this project only, as title, description, priority and labels', () => {
    const contosoBacklog = dataset.DEMO_BACKLOG.filter((item) => item.projectId === dataset.PROJECT_CONTOSO);
    // Vacuity guards: this project has a backlog, and other projects have items to leak.
    expect(contosoBacklog.length).toBeGreaterThan(0);
    expect(dataset.DEMO_BACKLOG.some((item) => item.projectId !== dataset.PROJECT_CONTOSO)).toBe(true);

    expect(seededProject.backlog).toStrictEqual(
      contosoBacklog.map((item) => ({
        title: item.title,
        description: item.description,
        priority: item.priority,
        labels: item.labels,
      })),
    );
  });
});

describe('seedPlanFor over a board where the flags and the agents come apart', () => {
  interface SyntheticTask {
    id: string;
    projectId: string;
    title: string;
    description: string;
    labels: string[];
    display_id: number;
    lane: string;
    branch_name: string | null;
    base_branch: string | null;
    archivedDaysAgo?: number;
  }

  const ALPHA = 'proj-alpha';
  const BETA = 'proj-beta';

  function syntheticTask(fields: Pick<SyntheticTask, 'id' | 'projectId' | 'lane' | 'display_id'> & Partial<SyntheticTask>): SyntheticTask {
    return {
      title: `Title of ${fields.id}`,
      description: `About ${fields.id}`,
      labels: ['synthetic'],
      branch_name: `branch-${fields.id}`,
      base_branch: 'main',
      ...fields,
    };
  }

  const syntheticDataset = {
    DEMO_LANES_BY_PROJECT: {
      [ALPHA]: [
        { slug: 'todo', name: 'Parked', agent: null },
        { slug: 'build', name: 'Build Zone', agent: 'claude' },
        { slug: 'done', name: 'Shipped', agent: null },
      ],
      [BETA]: [
        { slug: 'todo', name: 'Beta Parked', agent: 'codex' },
        { slug: 'build', name: 'Beta Build', agent: null },
      ],
    },
    DEMO_ALL_TASKS: [
      // In the done lane with no archive age: done, but not archived.
      syntheticTask({ id: 'alpha-shipped-live', projectId: ALPHA, lane: 'done', display_id: 1 }),
      // Archived, but sitting in a lane that is not the done lane: archived, but not done.
      syntheticTask({ id: 'alpha-archived-in-build', projectId: ALPHA, lane: 'build', display_id: 2, archivedDaysAgo: 4 }),
      syntheticTask({ id: 'alpha-parked', projectId: ALPHA, lane: 'todo', display_id: 3 }),
      syntheticTask({ id: 'beta-parked', projectId: BETA, lane: 'todo', display_id: 1 }),
    ],
    DEMO_BACKLOG: [
      { projectId: ALPHA, title: 'Alpha idea', description: 'Alpha details', priority: 1, labels: ['idea'] },
      { projectId: BETA, title: 'Beta idea', description: 'Beta details', priority: 3, labels: [] },
    ],
  };

  const alphaProject = { id: ALPHA, name: 'alpha', default_agent: 'claude' };
  const alphaRoot = path.join(os.tmpdir(), 'kangentic-demo-mcp-alpha-root');
  const alphaWorktree = path.join(alphaRoot, '.kangentic', 'worktrees', 'alpha-parked');
  const recorded = syntheticDataset.DEMO_ALL_TASKS[2];
  const plan = seedPlanFor(syntheticDataset, alphaProject, alphaRoot, recorded, alphaWorktree) as SeedPlan;
  const [seededProject] = plan.projects;
  const taskByKey = new Map(seededProject.tasks.map((task) => [task.key, task]));

  function seededTask(taskId: string): SeededTask {
    const found = taskByKey.get(taskId);
    if (!found) throw new Error(`the plan has no task ${taskId}`);
    return found;
  }

  it('reads done from the lane and archived from the archive age, independently', () => {
    expect(seededTask('alpha-shipped-live')).toMatchObject({ lane: 'Shipped', done: true, archived: false });
    expect(seededTask('alpha-archived-in-build')).toMatchObject({ lane: 'Build Zone', done: false, archived: true });
    expect(seededTask('alpha-parked')).toMatchObject({ lane: 'Parked', done: false, archived: false });
  });

  it('seeds this project\'s tasks and backlog only', () => {
    expect(seededProject.tasks.map((task) => task.key).sort()).toEqual([
      'alpha-archived-in-build',
      'alpha-parked',
      'alpha-shipped-live',
    ]);
    expect(seededProject.backlog).toStrictEqual([
      { title: 'Alpha idea', description: 'Alpha details', priority: 1, labels: ['idea'] },
    ]);
  });

  it('leaves a lane that names no agent out of columnAgents, and another project\'s agent lane too', () => {
    expect(seededProject.columnAgents).toStrictEqual({ 'Build Zone': 'claude' });
  });

  it('puts the worktree path on the recorded task alone', () => {
    expect(seededTask('alpha-parked').worktreePath).toBe(alphaWorktree);
    expect(seededTask('alpha-shipped-live')).not.toHaveProperty('worktreePath');
    expect(seededTask('alpha-archived-in-build')).not.toHaveProperty('worktreePath');
  });
});

describe('prepareWorkflowAgentCapture against a fake preview', () => {
  const PREVIEW_PORT = 54321;
  const ALPHA = 'proj-alpha';
  const EARLIER_PROJECT_ID = 'earlier-run-project';
  const SEEDED_PROJECT_ID = 'seeded-project';
  const PREVIOUS_CLAUDE_PATH = '/mock/bin/claude';
  const MCP_URL = 'http://127.0.0.1:54321/mcp/alpha';
  const SEED_MCP_TOKEN = 'seed-token-0123456789abcdef';
  const LAUNCH_URL = 'http://127.0.0.1:54321/mcp/alpha/workflow-workflow-1';
  const LAUNCH_TOKEN = 'launch-token-0123456789abcdef';
  const LAUNCH_PROMPT = 'the first message of the workflow agent';

  const workflowDataset = {
    DEMO_PROJECTS: [{ id: ALPHA, name: 'alpha', default_agent: 'claude' }],
    DEMO_ALL_TASKS: [],
    DEMO_LANES_BY_PROJECT: { [ALPHA]: [{ slug: 'todo', name: 'To Do', agent: null }] },
    DEMO_BACKLOG: [
      { id: 'alpha-idea', projectId: ALPHA, title: 'Alpha idea', description: 'Alpha details', priority: 1, labels: ['idea'] },
      // Its project is not in DEMO_PROJECTS: the manifest typo the project guard exists for.
      { id: 'ghost-idea', projectId: 'proj-ghost', title: 'Ghost idea', description: 'Ghost details', priority: 2, labels: [] },
    ],
  };
  const workflowEntry = {
    file: 'alpha-workflow.json',
    agent: 'claude',
    backlog: 'alpha-idea',
    project: 'alpha',
    claudeSettings: { verbose: true },
  };

  /** The seed answer of a preview whose MCP server is on. */
  const seedAnswerWithMcpServer = {
    projects: [{ projectId: SEEDED_PROJECT_ID, mcpUrl: MCP_URL, taskKeys: {} }],
    mcpToken: SEED_MCP_TOKEN,
  };

  interface PreviewState {
    /** The projects the preview holds, as `projects.list()` answers them. */
    registered: Array<{ id: string; path: string }>;
    deletedProjectIds: string[];
    /** The preview's configured Claude path (null for none). */
    claudePath: string | null;
    /** Every value the Claude path was set to, in order. */
    claudePathHistory: Array<string | null>;
    seedAnswer: unknown;
    seedPlans: Array<{ projects: Array<{ key: string; path: string }> }>;
    lanes: Array<{ id: string; name: string; role: string }>;
    createdCards: Array<{ input: Record<string, unknown>; projectId: string }>;
    createdWorkflows: Array<{ projectId: string; cardId: string }>;
    /** A project whose deletion rejects, to fail a release. */
    failDeleteOf: string | null;
  }

  let repoRoot = '';
  let root = '';
  const launchDirectories: string[] = [];

  /**
   * An in-memory `window.electronAPI` for the preview, and the evaluate mock that runs the rig's
   * own expression strings against it. The rig builds those strings (JSON-encoded ids, a
   * read-modify-write of the config), so running them rather than matching their text is what
   * pins the effect on the preview.
   */
  function installFakePreview(overrides: Partial<PreviewState> = {}): PreviewState {
    const state: PreviewState = {
      registered: [{ id: EARLIER_PROJECT_ID, path: root }],
      deletedProjectIds: [],
      claudePath: PREVIOUS_CLAUDE_PATH,
      claudePathHistory: [],
      seedAnswer: seedAnswerWithMcpServer,
      seedPlans: [],
      lanes: [
        { id: 'lane-todo', name: 'To Do', role: 'todo' },
        { id: 'lane-executing', name: 'Executing', role: 'none' },
      ],
      createdCards: [],
      createdWorkflows: [],
      failDeleteOf: null,
      ...overrides,
    };
    const electronAPI = {
      projects: {
        list: async () => state.registered.map((project) => ({ ...project })),
        delete: async (projectId: string) => {
          if (projectId === state.failDeleteOf) throw new Error(`the preview could not delete ${projectId}`);
          state.deletedProjectIds.push(projectId);
          state.registered = state.registered.filter((project) => project.id !== projectId);
        },
      },
      config: {
        get: async () => ({ agent: { cliPaths: state.claudePath === null ? {} : { claude: state.claudePath } } }),
        set: async (config: { agent: { cliPaths: { claude?: string } } }) => {
          state.claudePath = config.agent.cliPaths.claude ?? null;
          state.claudePathHistory.push(state.claudePath);
        },
      },
      dev: {
        seedKnowledgeGraphDemo: async (plan: { projects: Array<{ key: string; path: string }> }) => {
          state.seedPlans.push(plan);
          state.registered.push({ id: SEEDED_PROJECT_ID, path: plan.projects[0].path });
          return state.seedAnswer;
        },
      },
      swimlanes: { list: async () => state.lanes },
      tasks: {
        create: async (input: Record<string, unknown>, projectId: string) => {
          state.createdCards.push({ input, projectId });
          return { id: 'card-1', display_id: 7 };
        },
      },
      workflows: {
        create: async (projectId: string, cardId: string) => {
          state.createdWorkflows.push({ projectId, cardId });
          return { id: 'workflow-1' };
        },
      },
    };
    previewBridge.readPreviewPort.mockReturnValue(PREVIEW_PORT);
    previewBridge.evaluateInPreview.mockImplementation(async (_port: number, expression: string) =>
      vm.runInNewContext(expression, { window: { electronAPI } }));
    previewBridge.postToPreview.mockResolvedValue({
      cwd: root,
      prompt: LAUNCH_PROMPT,
      mcpServerUrl: LAUNCH_URL,
      mcpServerToken: LAUNCH_TOKEN,
    });
    return state;
  }

  function prepare(entryOverrides: Record<string, unknown> = {}) {
    return prepareWorkflowAgentCapture({
      repoRoot,
      dataset: workflowDataset,
      entry: { ...workflowEntry, ...entryOverrides },
      root,
    });
  }

  function expectNoPreviewCall(): void {
    expect(previewBridge.readPreviewPort).not.toHaveBeenCalled();
    expect(previewBridge.evaluateInPreview).not.toHaveBeenCalled();
    expect(previewBridge.postToPreview).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    previewBridge.readPreviewPort.mockReset();
    previewBridge.evaluateInPreview.mockReset();
    previewBridge.postToPreview.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The rig points the preview's Claude path at the repo's mock CLI, and on POSIX marks it
    // executable first, so the fixture has to exist under the repo root it is given.
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-demo-workflow-repo-'));
    const fixturesDirectory = path.join(repoRoot, 'tests', 'fixtures');
    fs.mkdirSync(fixturesDirectory, { recursive: true });
    fs.writeFileSync(path.join(fixturesDirectory, 'mock-claude.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(fixturesDirectory, 'mock-claude.js'), '#!/usr/bin/env node\n');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-demo-workflow-root-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of [repoRoot, root, ...launchDirectories.splice(0)]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an agent other than Claude before it touches the preview', async () => {
    installFakePreview();

    await expect(prepare({ agent: 'codex' })).rejects.toThrow(/^\[workflow\] alpha-workflow\.json: only Claude's launch shape/);
    expectNoPreviewCall();
  });

  it('refuses a backlog item the dataset does not have, naming it, before it touches the preview', async () => {
    installFakePreview();

    await expect(prepare({ backlog: 'no-such-idea' })).rejects.toThrow(/^\[workflow\] alpha-workflow\.json: the dataset has no backlog item no-such-idea/);
    expectNoPreviewCall();
  });

  it('refuses a backlog item whose project the dataset lacks with a [workflow] error naming it, before it touches the preview', async () => {
    installFakePreview();

    // Without the guard the project is undefined, the preview is connected and its earlier board
    // dropped, and seedPlanFor then fails on a bare TypeError reading the project's id.
    const failure = await prepare({ backlog: 'ghost-idea' }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect((failure as Error).message).toMatch(/^\[workflow\] /);
    expect((failure as Error).message).toContain('proj-ghost');
    expect((failure as Error).message).toContain('ghost-idea');
    expectNoPreviewCall();
  });

  it('releases the board it seeded, and rethrows the original error, when the preview reports no MCP server', async () => {
    const preview = installFakePreview({
      // The seed succeeded but the answer carries no token: the MCP server is off.
      seedAnswer: { projects: [{ projectId: SEEDED_PROJECT_ID, mcpUrl: MCP_URL, taskKeys: {} }] },
    });

    await expect(prepare()).rejects.toThrow('[workflow] the preview reports no MCP server');

    // Vacuity guard: the run got as far as seeding this project's board at the scratch clone.
    expect(preview.seedPlans).toHaveLength(1);
    expect(preview.seedPlans[0].projects[0]).toMatchObject({ key: ALPHA, path: root });
    // The earlier run's project was dropped before the seed, and the seeded one again on release.
    expect(preview.deletedProjectIds).toEqual([EARLIER_PROJECT_ID, SEEDED_PROJECT_ID]);
    expect(preview.registered).toEqual([]);
    // The Claude path had not been changed yet, so release leaves it alone.
    expect(preview.claudePathHistory).toEqual([]);
    expect(preview.claudePath).toBe(PREVIOUS_CLAUDE_PATH);
    expect(previewBridge.postToPreview).not.toHaveBeenCalled();
  });

  it('rethrows the ORIGINAL error, not the release\'s, when releasing the board fails too, and reports the release failure', async () => {
    installFakePreview({
      seedAnswer: { projects: [{ projectId: SEEDED_PROJECT_ID, mcpUrl: MCP_URL, taskKeys: {} }] },
      failDeleteOf: SEEDED_PROJECT_ID,
    });

    const failure = await prepare().then(() => null, (error: unknown) => error);

    // The caller needs the fault that stopped the capture, not the cleanup that failed after it.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[workflow] the preview reports no MCP server');
    expect((failure as Error).message).not.toContain('could not delete');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('releasing the board after that failure failed too'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`the preview could not delete ${SEEDED_PROJECT_ID}`));
  });

  it.each([
    ['a path was configured', PREVIOUS_CLAUDE_PATH],
    ['none was configured', null],
  ])('puts the preview\'s Claude path back and drops the board when a later step fails, and %s before', async (_description, previousClaudePath) => {
    const preview = installFakePreview({
      claudePath: previousClaudePath,
      // The board has no To Do column to put the backlog card in, which fails after the Claude path moved.
      lanes: [{ id: 'lane-executing', name: 'Executing', role: 'none' }],
    });

    await expect(prepare()).rejects.toThrow('[workflow] alpha\'s board has no To Do column');

    expect(preview.claudePathHistory).toHaveLength(2);
    expect(preview.claudePathHistory[0]).toContain('mock-claude');
    expect(preview.claudePathHistory[1]).toBe(previousClaudePath);
    expect(preview.claudePath).toBe(previousClaudePath);
    expect(preview.deletedProjectIds).toEqual([EARLIER_PROJECT_ID, SEEDED_PROJECT_ID]);
    expect(preview.registered).toEqual([]);
  });

  describe('once the capture is prepared', () => {
    /** Prepares the capture and registers its launch folder for removal before any assertion can fail. */
    async function prepareTracked() {
      const preview = installFakePreview();
      const capture = await prepare();
      const launchDirectory = path.dirname(capture.args[1]);
      launchDirectories.push(launchDirectory);
      return { preview, capture, launchDirectory };
    }

    function readJson(filePath: string): unknown {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    it('makes the workflow from a backlog card in To Do, and returns the desktop\'s own launch for the agent', async () => {
      const { preview, capture, launchDirectory } = await prepareTracked();

      expect(preview.createdCards).toEqual([{
        input: { title: 'Alpha idea', description: 'Alpha details', labels: ['idea'], swimlane_id: 'lane-todo' },
        projectId: SEEDED_PROJECT_ID,
      }]);
      expect(preview.createdWorkflows).toEqual([{ projectId: SEEDED_PROJECT_ID, cardId: 'card-1' }]);
      expect(previewBridge.postToPreview).toHaveBeenCalledWith(PREVIEW_PORT, '/workflow-agent-launch', {
        projectId: SEEDED_PROJECT_ID,
        workflowId: 'workflow-1',
      });
      expect(capture.cwd).toBe(root);
      expect(capture.prompt).toBe(LAUNCH_PROMPT);
      expect(capture.args).toEqual([
        '--mcp-config', path.join(launchDirectory, 'mcp.json'),
        '--settings', path.join(launchDirectory, 'settings.json'),
        '--read-only',
      ]);
      expect(readJson(capture.args[1])).toStrictEqual({
        mcpServers: { kangentic: { type: 'http', url: LAUNCH_URL, headers: { 'X-Kangentic-Token': LAUNCH_TOKEN } } },
      });
      // A workflow agent launches in the default mode, which passes no mode flag, so it is pinned.
      expect(readJson(capture.args[3])).toStrictEqual({
        verbose: true,
        permissions: { allow: ['mcp__kangentic'], defaultMode: 'default' },
      });
    });

    it('takes the board, the preview\'s Claude path and the launch folder back on cleanup', async () => {
      const { preview, capture, launchDirectory } = await prepareTracked();
      // Vacuity guard: before cleanup the board is seeded, the Claude path is the mock's, and the folder exists.
      expect(preview.registered).toEqual([{ id: SEEDED_PROJECT_ID, path: root }]);
      expect(preview.claudePath).toContain('mock-claude');
      expect(fs.existsSync(launchDirectory)).toBe(true);

      await capture.cleanup();

      expect(preview.registered).toEqual([]);
      expect(preview.deletedProjectIds).toEqual([EARLIER_PROJECT_ID, SEEDED_PROJECT_ID]);
      expect(preview.claudePath).toBe(PREVIOUS_CLAUDE_PATH);
      expect(fs.existsSync(launchDirectory)).toBe(false);
    });

    it('reports a launch folder it cannot remove by path, and does not throw, so cleanup still succeeds', async () => {
      const { preview, capture, launchDirectory } = await prepareTracked();
      const realRmSync = fs.rmSync;
      vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (String(target) === launchDirectory) throw new Error('EBUSY: resource busy or locked');
        return realRmSync(target, options);
      });

      await expect(capture.cleanup()).resolves.toBeUndefined();

      // mcp.json in that folder carries the preview's token, so the folder is named for a manual delete.
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(launchDirectory));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('delete that folder by hand'));
      // The release itself had already run.
      expect(preview.registered).toEqual([]);
    });

    it('still removes the launch folder, and throws the release\'s own failure, when the board cannot be dropped', async () => {
      const { preview, capture, launchDirectory } = await prepareTracked();
      preview.failDeleteOf = SEEDED_PROJECT_ID;

      await expect(capture.cleanup()).rejects.toThrow(`the preview could not delete ${SEEDED_PROJECT_ID}`);

      expect(fs.existsSync(launchDirectory)).toBe(false);
      // The step after the failed drop still ran.
      expect(preview.claudePath).toBe(PREVIOUS_CLAUDE_PATH);
    });
  });
});
