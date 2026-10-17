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
 * The row's recorded sessions (frames, diff, peeks, trail, blame) are the heavy part, and the web
 * build keeps them out of the eager seed (`sceneRowData: 'separate'`): each row gets its own script
 * (buildDemoSceneRowScripts), which demo/boot.js writes into the page only on a frame naming the
 * row. So the last block holds that split: what leaves the seed lands in the row's script and
 * nowhere else, a seed with the script in place seeds what the inline seed does, and a seed told
 * the row without its script refuses it.
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
  SESSION_VALIDATE, TASK_VALIDATE, buildDemoPreConfig, buildDemoSceneRowScripts,
} from '../../tests/captures/helpers/demo-dataset';
import type { DemoHistory } from '../../tests/captures/helpers/demo-dataset';
import { loadDemoEnds, loadDemoMessageTrails } from '../../tests/captures/helpers/demo-scrollback';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MOCK_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'tests/ui/mock-electron-api.js'), 'utf-8');

/** The rows of the mock's state that the seed fills and these tests read back. */
interface SeededState {
  tasks: Array<{ id: string; projectId: string; display_id: number; swimlane_id: string }>;
  archivedTasks: Array<{ id: string }>;
  sessions: Array<{ id: string; taskId: string | null; projectId: string; cwd: string }>;
  swimlanes: Array<{ id: string; projectId: string; name: string }>;
  activityCache: Record<string, string>;
  messageTrailCache: Record<string, Array<{ uuid: string; ts: number; text: string }>>;
}

type SeedOptions = NonNullable<Parameters<typeof buildDemoPreConfig>[0]>;

/** How the seed under test is built: its options, and the row scripts run on the page ahead of it. */
interface SeedBuild {
  options?: SeedOptions;
  rowScripts?: string[];
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
 * page's `window` first, and any row scripts run on it before the seed, as demo/boot.js writes
 * them in ahead of it. The script is ended right after its `__mockPreConfigure` call, because
 * what follows replaces bridge methods and arms the session clocks, none of which these rows
 * depend on.
 */
function runSeed(publication: ScenePublication = {}, build: SeedBuild = {}): SeededState {
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

  for (const rowScript of build.rowScripts ?? []) new Function('window', rowScript)(windowObject);
  const script = buildDemoPreConfig(build.options ?? { scrollback: recordingsFor(ALL_SESSION_IDS), knowledgeGraph: 'fetched' });
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

/** A text unique to one session and one map, so a search of the generated scripts can say where each entry went. */
function markerOf(sessionId: string, map: string): string {
  return `marker-${map}-${sessionId}`;
}

/** The project whose history the marked blame sits under. */
const MARKED_PROJECT = 'contoso-web';

/**
 * Every session-keyed option, plus the history's blame, filled with a marker per session: what the
 * split moves is then readable straight off the generated text.
 */
function markedOptions(): SeedOptions {
  const perSession = <Value>(build: (sessionId: string) => Value): Record<string, Value> =>
    Object.fromEntries(ALL_SESSION_IDS.map((sessionId) => [sessionId, build(sessionId)]));
  const blame: DemoHistory['blame'] = perSession((sessionId) => ({ [markerOf(sessionId, 'blame')]: { lines: [] } }));
  return {
    scrollback: perSession((sessionId) => markerOf(sessionId, 'scrollback')),
    changes: perSession((sessionId) => ({ files: [{ path: markerOf(sessionId, 'changes'), status: 'M', insertions: 1, deletions: 0, original: '', modified: '', language: null }], totalInsertions: 1, totalDeletions: 0 })),
    peeks: perSession((sessionId) => [markerOf(sessionId, 'peeks')]),
    ends: perSession((sessionId) => ({ durationMs: 1000, stopReason: markerOf(sessionId, 'ends') })),
    openFrames: perSession((sessionId) => ({ serialized: markerOf(sessionId, 'openFrames'), peek: [] })),
    tiledFrames: perSession((sessionId) => ({ serialized: markerOf(sessionId, 'tiledFrames'), openFrame: null })),
    peekTimelines: perSession((sessionId) => [{ t: 0, lines: [markerOf(sessionId, 'peekTimelines')] }]),
    messageTrails: perSession((sessionId) => [{ t: 0, uuid: sessionId, ts: 0, text: markerOf(sessionId, 'messageTrails') }]),
    history: { [MARKED_PROJECT]: { project: MARKED_PROJECT, branch: 'main', tipHash: 'tip', commits: [], diffs: {}, blame } },
    knowledgeGraph: 'fetched',
  };
}

const MARKED_MAPS = ['scrollback', 'changes', 'peeks', 'ends', 'openFrames', 'tiledFrames', 'peekTimelines', 'messageTrails', 'blame'];
/** A sample install session, the control for each absence below. */
const INSTALL_SESSION_ID = DEMO_SESSIONS[0].id;

/** What the seed holds for each of MARKED_MAPS: the map by session id, blame being the marked project's. */
type SeedHoldings = Record<string, Record<string, unknown>>;

/** The one call the seed hands its state to, which the probe below is put ahead of. */
const PRE_CONFIGURE_CALL = 'window.__mockPreConfigure(function (state) {';

/**
 * What the generated seed holds in its own variables once its scene rows are folded in, before
 * anything is derived from them. Those variables are private to the seed's function, and the
 * bridge answers built from them cannot stand in: a working session's open frame masks its
 * scrollback and its peek, the peek timelines and the tiled frames are read only on the live path
 * (timers and recordings), and the script past `__mockPreConfigure` is the live page's machinery
 * (recordings, timers, a document). So a probe line goes ahead of the seed's single
 * `__mockPreConfigure` call, where the generated fold has already run, and publishes the variables
 * the fold merges into. `data.ends` is read through `data`, because the seed's later `var ends` is
 * hoisted and still undefined at that point. The script is ended at that call, as `runSeed` ends
 * it just after it, so nothing past it needs a page.
 */
function seedHoldings(publication: ScenePublication, options: SeedOptions, rowScripts: string[] = []): SeedHoldings {
  const script = buildDemoPreConfig(options);
  if (script.split(PRE_CONFIGURE_CALL).length !== 2) {
    throw new Error(`expected the seed to make exactly one ${PRE_CONFIGURE_CALL} call, to put the probe ahead of it`);
  }
  const probe = 'window.__seedHoldings = { scrollback: scrollback, changes: changes, peeks: peeks, ends: data.ends, '
    + 'openFrames: openFrames, tiledFrames: tiledFrames, peekTimelines: peekTimelines, messageTrails: messageTrails, '
    + `blame: history[${JSON.stringify(MARKED_PROJECT)}].blame };\n`;
  const probedScript = script.replace(PRE_CONFIGURE_CALL, () => probe + PRE_CONFIGURE_CALL);

  const windowObject: Record<string, unknown> = {};
  windowObject.window = windowObject;
  if (publication.sceneRows) windowObject.__demoSceneRows = publication.sceneRows;
  windowObject.__mockPreConfigure = () => { throw SEED_RAN; };
  for (const rowScript of rowScripts) new Function('window', rowScript)(windowObject);
  try {
    new Function('window', probedScript)(windowObject);
  } catch (error) {
    if (error !== SEED_RAN) throw error;
  }
  const holdings = windowObject.__seedHoldings as SeedHoldings | undefined;
  if (!holdings) throw new Error('the dataset seed never reached its __mockPreConfigure call');
  return holdings;
}

describe('a scene-only row\'s recorded sessions, apart from the seed', () => {
  it('leave a separate seed entirely and stay in an inline one', () => {
    const separate = buildDemoPreConfig({ ...markedOptions(), sceneRowData: 'separate' });
    const inline = buildDemoPreConfig(markedOptions());
    for (const map of MARKED_MAPS) {
      expect(separate, `a separate seed still carries the scene-only session's ${map}`).not.toContain(markerOf(SESSION_VALIDATE, map));
      expect(inline, `an inline seed lost the scene-only session's ${map}`).toContain(markerOf(SESSION_VALIDATE, map));
      // Control: the install's own sessions are carried either way.
      expect(separate, `a separate seed lost the install's ${map}`).toContain(markerOf(INSTALL_SESSION_ID, map));
    }
  });

  it('land in one script per scene-only task, holding that row\'s sessions and nothing of the install\'s', () => {
    const scripts = buildDemoSceneRowScripts(markedOptions());
    expect(Object.keys(scripts)).toEqual(DEMO_SCENE_TASKS.map((task) => task.id));
    for (const map of MARKED_MAPS) {
      expect(scripts[TASK_VALIDATE], `the row script has no ${map}`).toContain(markerOf(SESSION_VALIDATE, map));
      expect(scripts[TASK_VALIDATE], `the row script carries the install's ${map}`).not.toContain(markerOf(INSTALL_SESSION_ID, map));
    }
  });

  it('change none of the maps they are built from, which feed both builders', () => {
    const options = markedOptions();
    const before = JSON.stringify(options);
    buildDemoPreConfig({ ...options, sceneRowData: 'separate' });
    buildDemoSceneRowScripts(options);
    expect(JSON.stringify(options)).toBe(before);
  });

  it('seed what the inline seed does once the row\'s script has run ahead of the seed', () => {
    // The real trail and clock, so the trail seeded at the session's opening moment is the one the
    // task-mcp card shows. It is read back from what the seed hands the mock.
    const options: SeedOptions = { scrollback: recordingsFor(ALL_SESSION_IDS), messageTrails: loadDemoMessageTrails(), ends: loadDemoEnds(), knowledgeGraph: 'fetched' };
    const inline = runSeed({ sceneRows: [TASK_VALIDATE] }, { options });
    const separate = runSeed({ sceneRows: [TASK_VALIDATE] }, {
      options: { ...options, sceneRowData: 'separate' },
      rowScripts: [buildDemoSceneRowScripts(options)[TASK_VALIDATE]],
    });
    // Vacuity guard: the session opens with a trail, so equality below compares something.
    expect(inline.messageTrailCache[SESSION_VALIDATE]?.length ?? 0).toBeGreaterThan(0);
    expect(separate.messageTrailCache[SESSION_VALIDATE]).toEqual(inline.messageTrailCache[SESSION_VALIDATE]);
    expect(separate.sessions.map((session) => session.id)).toEqual(inline.sessions.map((session) => session.id));
  });

  it('merge each recorded map and the blame into the seed\'s own variable for it, only for a row the page names', () => {
    const marked = markedOptions();
    const recordedMaps = marked as unknown as Record<string, Record<string, unknown>>;
    const recordedFor = (map: string, sessionId: string): unknown => map === 'blame'
      ? marked.history?.[MARKED_PROJECT]?.blame[sessionId]
      : recordedMaps[map]?.[sessionId];
    const separateOptions: SeedOptions = { ...marked, sceneRowData: 'separate' };
    // The row's script is on the page in both runs, so the only difference between them is the name.
    const rowScripts = [buildDemoSceneRowScripts(marked)[TASK_VALIDATE]];

    const named = seedHoldings({ sceneRows: [TASK_VALIDATE] }, separateOptions, rowScripts);
    const unnamed = seedHoldings({}, separateOptions, rowScripts);

    for (const map of MARKED_MAPS) {
      const expectedRow = recordedFor(map, SESSION_VALIDATE);
      const expectedInstall = recordedFor(map, INSTALL_SESSION_ID);
      // Vacuity guards: the marked entry exists to be merged, and the seed's own copy of the
      // install's entry is there either way, so a missing row entry is not an empty seed.
      expect(expectedRow, `the marked options hold no ${map} for the scene-only session`).toBeDefined();
      expect(named[map]?.[INSTALL_SESSION_ID], `the seed told the row lost the install's ${map}`).toEqual(expectedInstall);
      expect(unnamed[map]?.[INSTALL_SESSION_ID], `the seed told no row lost the install's ${map}`).toEqual(expectedInstall);
      // The row's entry is held whole, under the variable of its own map: an entry merged into
      // another map, or into none, leaves this one without it. Soft, so a merge that lands in
      // the wrong map reports every map it breaks and not only the first.
      expect.soft(named[map]?.[SESSION_VALIDATE], `the seed told the row does not hold the scene-only session's ${map}`).toEqual(expectedRow);
      // Not named: nothing of the row is held, though its script is on the page.
      expect.soft(unnamed[map]?.[SESSION_VALIDATE], `the seed told no row holds the scene-only session's ${map}`).toBeUndefined();
      expect.soft(JSON.stringify(unnamed), `the seed told no row carries the scene-only session's ${map} marker`).not.toContain(markerOf(SESSION_VALIDATE, map));
    }
  });

  it('let a separate seed boot a frame that names no row without any script', () => {
    const state = runSeed({}, { options: { ...markedOptions(), sceneRowData: 'separate' } });
    expect(state.sessions.map((session) => session.id)).not.toContain(SESSION_VALIDATE);
    expect(state.tasks.length).toBeGreaterThan(0);
  });

  it('are refused by name when a separate seed is told the row and its script never ran', () => {
    expect(thrownMessage(() => runSeed({ sceneRows: [TASK_VALIDATE] }, { options: { ...markedOptions(), sceneRowData: 'separate' } })))
      .toBe(`No recorded sessions for the scene-only task "${TASK_VALIDATE}": its scene-rows script did not run before the seed`);
  });
});
