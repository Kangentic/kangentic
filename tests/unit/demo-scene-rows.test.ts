/**
 * A scene-only row joins the sample install only when a scene names it, and the build refuses to
 * ship one without a recording.
 *
 * A card only one figure needs (the review that calls Kangentic's own MCP tools, DEMO_SCENE_TASKS)
 * cannot live in the dataset: a new card changes every figure already placed, from the board's
 * counts to the Monitor's rows and the usage totals. So the generated seed carries it apart and
 * adds it only for the ids in `window.__demoSceneRows`, which demo/boot.js publishes from a scene's
 * `rows` before it calls the seed. This file holds the contract from both sides. A seed that is
 * told nothing leaves the row out of everything it hands the mock, a seed that is told the id adds
 * the task and its one session ahead of the session patches and of everything derived from a row,
 * and a seed told an id it does not carry refuses it by name. The build's recordings check covers
 * the scene-only sessions too, so a missing recording fails the build rather than painting a blank
 * terminal in the one figure that shows it.
 *
 * The seed is evaluated as the page evaluates it (the generated script over the real mock, as
 * demo-archived-summaries.test.ts does), and what is read back is what it hands the mock's
 * `__mockPreConfigure`: the task rows, the session rows, and the lanes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  DEMO_ALL_SESSIONS, DEMO_SCENE_SESSIONS, DEMO_SCENE_TASKS, DEMO_SESSIONS, DEMO_TASKS, PROJECT_CONTOSO,
  SESSION_VALIDATE, TASK_VALIDATE, buildDemoPreConfig,
} from '../../tests/captures/helpers/demo-dataset';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MOCK_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'tests/ui/mock-electron-api.js'), 'utf-8');

/** The rows of the mock's state that the seed fills and these tests read back. */
interface SeededState {
  tasks: Array<{ id: string; projectId: string; display_id: number; swimlane_id: string }>;
  archivedTasks: Array<{ id: string }>;
  sessions: Array<{ id: string; taskId: string | null; projectId: string; cwd: string }>;
  swimlanes: Array<{ id: string; projectId: string; name: string }>;
  activityCache: Record<string, string>;
}

type PreConfigure = (configure: (state: SeededState) => unknown) => void;

/** What a scene publishes to the seed before it runs (demo/boot.js). */
interface ScenePublication {
  /** Left unset to model a page whose scene names no rows. */
  sceneRows?: string[];
  sessionPatches?: Record<string, { activity?: string }>;
}

/** Thrown from the wrapped `__mockPreConfigure` to end the generated script once its seed has run. */
const SEED_RAN = new Error('the dataset seed ran');

/** One recording stub per session, scene-only ones included, which is all the build's recordings check wants. */
function recordingsFor(sessionIds: string[]): Record<string, string> {
  return Object.fromEntries(sessionIds.map((sessionId) => [sessionId, 'recording']));
}

const ALL_SESSION_IDS = DEMO_ALL_SESSIONS.map((session) => session.id);

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the action to throw, and it returned');
}

/**
 * The mock's state after the generated seed has run against it, with `publication` set on the
 * page's `window` first. The script is ended right after its `__mockPreConfigure` call, because
 * what follows replaces bridge methods and arms the session clocks, none of which these rows
 * depend on.
 */
function runSeed(publication: ScenePublication = {}): SeededState {
  const windowObject: Record<string, unknown> = {};
  windowObject.window = windowObject;
  vm.runInNewContext(
    MOCK_SOURCE,
    { window: windowObject, document: undefined, crypto: webcrypto, setTimeout, clearTimeout, console },
    { timeout: 5000 },
  );
  if (publication.sceneRows) windowObject.__demoSceneRows = publication.sceneRows;
  if (publication.sessionPatches) windowObject.__demoSessionPatches = publication.sessionPatches;

  const preConfigure = windowObject.__mockPreConfigure as PreConfigure;
  const seeded: { state: SeededState | null } = { state: null };
  windowObject.__mockPreConfigure = (configure: (state: SeededState) => unknown) => {
    preConfigure(configure);
    preConfigure((state) => { seeded.state = state; });
    throw SEED_RAN;
  };

  const script = buildDemoPreConfig({ scrollback: recordingsFor(ALL_SESSION_IDS), knowledgeGraph: 'fetched' });
  try {
    new Function('window', script)(windowObject);
  } catch (error) {
    if (error !== SEED_RAN) throw error;
  }
  if (!seeded.state) throw new Error('the dataset seed never called __mockPreConfigure');
  return seeded.state;
}

function taskIdsOf(state: SeededState): string[] {
  return [...state.tasks, ...state.archivedTasks].map((task) => task.id);
}

describe('the scene-only row in the dataset', () => {
  it('is a row of its own: in neither the sample install\'s tasks nor its sessions', () => {
    // Vacuity guards for everything below: the row exists, belongs to contoso-web, and is carried
    // apart from the install, so "the seed leaves it out" and "the seed adds it" both say something.
    expect(DEMO_SCENE_TASKS.map((task) => task.id)).toEqual([TASK_VALIDATE]);
    expect(DEMO_SCENE_SESSIONS.map((session) => session.id)).toEqual([SESSION_VALIDATE]);
    expect(DEMO_SCENE_TASKS[0].projectId).toBe(PROJECT_CONTOSO);
    expect(DEMO_TASKS.map((task) => task.id)).not.toContain(TASK_VALIDATE);
    expect(DEMO_SESSIONS.map((session) => session.id)).not.toContain(SESSION_VALIDATE);
  });
});

describe('the seed\'s scene rows', () => {
  it('leaves the scene-only task and session out of a seed whose scene names no rows', () => {
    for (const publication of [{}, { sceneRows: [] }] satisfies ScenePublication[]) {
      const state = runSeed(publication);
      const label = JSON.stringify(publication);
      // Vacuity guard: the install itself was seeded, so the absence below is not an empty seed.
      expect(state.tasks.length, label).toBeGreaterThan(0);
      expect(state.sessions.length, label).toBeGreaterThan(0);
      expect(state.tasks.map((task) => task.id), label).toContain(DEMO_TASKS.find((task) => !task.archivedDaysAgo)?.id);
      expect(taskIdsOf(state), label).not.toContain(TASK_VALIDATE);
      expect(state.sessions.map((session) => session.id), label).not.toContain(SESSION_VALIDATE);
    }
  });

  it('adds nothing but the scene-only row, so no other figure changes', () => {
    const without = runSeed();
    const withRow = runSeed({ sceneRows: [TASK_VALIDATE] });
    expect(withRow.tasks.map((task) => task.id).filter((id) => id !== TASK_VALIDATE)).toEqual(without.tasks.map((task) => task.id));
    expect(withRow.sessions.map((session) => session.id).filter((id) => id !== SESSION_VALIDATE)).toEqual(without.sessions.map((session) => session.id));
    expect(withRow.tasks).toHaveLength(without.tasks.length + 1);
    expect(withRow.sessions).toHaveLength(without.sessions.length + 1);
  });

  it('carries the named task, in contoso-web\'s Code Review lane, with exactly one session', () => {
    const state = runSeed({ sceneRows: [TASK_VALIDATE] });

    const carried = state.tasks.filter((task) => task.id === TASK_VALIDATE);
    expect(carried).toHaveLength(1);
    expect(carried[0].projectId).toBe(PROJECT_CONTOSO);
    // The ticket the recording prints, which the card has to agree with.
    expect(carried[0].display_id).toBe(68);

    const reviewLanes = state.swimlanes.filter((lane) => lane.projectId === PROJECT_CONTOSO && lane.name === 'Code Review');
    expect(reviewLanes).toHaveLength(1);
    expect(carried[0].swimlane_id).toBe(reviewLanes[0].id);

    const sessions = state.sessions.filter((session) => session.id === SESSION_VALIDATE);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].taskId).toBe(TASK_VALIDATE);
    expect(sessions[0].projectId).toBe(PROJECT_CONTOSO);
    // The task's only session: the fold takes the sessions of the named task and no other.
    expect(state.sessions.filter((session) => session.taskId === TASK_VALIDATE)).toHaveLength(1);
  });

  it('adds the row before anything is derived from a task, so its session runs in the task\'s worktree', () => {
    const state = runSeed({ sceneRows: [TASK_VALIDATE] });
    const session = state.sessions.find((candidate) => candidate.id === SESSION_VALIDATE);
    const worktreeFolder = DEMO_SCENE_TASKS[0].worktree_folder;
    expect(worktreeFolder).toBeTruthy();
    // A task found by id only after the fold would leave the session in the project directory.
    expect(session?.cwd.endsWith(worktreeFolder ?? '')).toBe(true);
  });

  it('adds the row before the session patches fold in, so a scene can patch the scene-only session', () => {
    const [sceneSession] = DEMO_SCENE_SESSIONS;
    const patchedActivity = sceneSession.activity === 'idle' ? 'thinking' : 'idle';
    const sessionPatches = { [SESSION_VALIDATE]: { activity: patchedActivity } };

    const patched = runSeed({ sceneRows: [TASK_VALIDATE], sessionPatches });
    expect(patched.activityCache[SESSION_VALIDATE]).toBe(patchedActivity);
    // The patch is the only thing that moved it: the same seed without it reads the row's own.
    expect(runSeed({ sceneRows: [TASK_VALIDATE] }).activityCache[SESSION_VALIDATE]).toBe(sceneSession.activity);
    // A patch for a row the scene did not name patches nothing and adds nothing.
    const unnamed = runSeed({ sessionPatches });
    expect(unnamed.activityCache[SESSION_VALIDATE]).toBeUndefined();
    expect(unnamed.sessions.map((session) => session.id)).not.toContain(SESSION_VALIDATE);
  });

  it('refuses an id it does not carry, naming it', () => {
    expect(thrownMessage(() => runSeed({ sceneRows: ['task-nope'] })))
      .toBe('No scene-only task "task-nope" in the sample install\'s scene rows');
  });

  it('refuses a sample install task, which is a dataset row and not a scene-only one', () => {
    const installTaskId = DEMO_TASKS[0].id;
    expect(thrownMessage(() => runSeed({ sceneRows: [installTaskId] })))
      .toBe(`No scene-only task "${installTaskId}" in the sample install's scene rows`);
  });

  it('refuses the whole list when one id in it is not carried', () => {
    expect(thrownMessage(() => runSeed({ sceneRows: [TASK_VALIDATE, 'task-nope'] }))).toContain('"task-nope"');
  });
});

describe('the build\'s recordings check over the scene-only rows', () => {
  it('refuses to build without a recording for the scene-only session, naming it', () => {
    // Vacuity guard: the session is one the check could miss, and it is not a dataset session.
    expect(ALL_SESSION_IDS).toContain(SESSION_VALIDATE);
    expect(DEMO_SCENE_SESSIONS[0].status).not.toBe('queued');

    const otherSessionIds = ALL_SESSION_IDS.filter((sessionId) => sessionId !== SESSION_VALIDATE);
    // Every other session has its recording, so it is only this one the check can be naming.
    expect(otherSessionIds.length).toBe(DEMO_SESSIONS.length);
    const message = thrownMessage(() => buildDemoPreConfig({ scrollback: recordingsFor(otherSessionIds) }));
    expect(message).toContain('[demo] no terminal recording for sess-cw-validate:');
  });

  it('refuses a recording that is present but empty', () => {
    const scrollback = { ...recordingsFor(ALL_SESSION_IDS), [SESSION_VALIDATE]: '' };
    expect(thrownMessage(() => buildDemoPreConfig({ scrollback }))).toContain('no terminal recording for sess-cw-validate');
  });

  it('builds when every session, scene-only ones included, has its recording', () => {
    expect(() => buildDemoPreConfig({ scrollback: recordingsFor(ALL_SESSION_IDS) })).not.toThrow();
  });
});
