/**
 * The scene registry (tests/captures/scenes.ts) is data that two consumers build from and one
 * more reads: the web build boots each entry, the capture rig shoots it, and the site embeds it
 * by name with the alt text the entry carries. Nothing typechecks it in CI (tsconfig includes
 * src/** only), and most of its fields are loose records, so a typo'd config key, a task id the
 * sample install does not seed, or a reach tag that disagrees with the steps all no-op silently.
 * This test pins each of those against the real sources rather than a re-declared list, and it
 * is the only writing-style check the alt strings get: the character scan excludes tests/, and
 * an alt ships to a docs page.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { CHOREOGRAPHY_KEYS, SCENES, WORKFLOW_INVOICE_PDF, draftOfRecordedPlan, hasPose, type ChoreographyStep, type ChoreographyTarget, type DemoBootStep, type SceneDefinition } from '../../tests/captures/scenes';
import { DEMO_AGENT_OVERRIDES, DEMO_ALL_SESSIONS, DEMO_LANES_BY_PROJECT, DEMO_SCENE_SESSIONS, DEMO_SCENE_TASKS, DEMO_SESSIONS, DEMO_TASKS, PROJECT_CONTOSO, demoLaneId, demoLaneIds } from '../../tests/captures/helpers/demo-dataset';
import { loadDemoEnds, loadDemoRecordings } from '../../tests/captures/helpers/demo-scrollback';
import { DEFAULT_CONFIG, type SerializedTileNode, type SerializedWorkspace } from '../../src/shared/types';
import { nextOnRoute, startColumn, type RouteColumn, type RouteFields } from '../../src/shared/workflow-route';
import { SETTINGS_TABS } from '../../src/renderer/components/settings/settings-tabs';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEMO_BOOT_PATH = path.join(REPO_ROOT, 'demo/boot.js');
const AGENT_ADAPTERS_ROOT = path.join(REPO_ROOT, 'src/main/agent/adapters');
const DEMO_VITE_CONFIG_PATH = path.join(REPO_ROOT, 'demo/vite.config.mts');
const SHARED_TYPES_PATH = path.join(REPO_ROOT, 'src/shared/types.ts');

/**
 * Every top-level member `AppConfig` declares, OPTIONAL ones included.
 *
 * `Object.keys(DEFAULT_CONFIG)` is not the same set and using it rejected a legitimate key: an
 * optional block like `developer` has no runtime default, so a scene that switches on a developer
 * flag looked like a typo. The point of the check is that the renderer never reads the key, and a
 * declared member is read; a misspelling still is not.
 */
function declaredAppConfigKeys(): Set<string> {
  const sourceFile = ts.createSourceFile(
    SHARED_TYPES_PATH,
    fs.readFileSync(SHARED_TYPES_PATH, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'AppConfig') continue;
    const names = statement.members
      .map((member) => member.name)
      .filter((name): name is ts.Identifier | ts.StringLiteral => name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)))
      .map((name) => name.text);
    if (names.length === 0) break;
    return new Set(names);
  }
  throw new Error(
    'scene-registry: no top-level `interface AppConfig` with members in src/shared/types.ts. '
    + 'If it moved or was renamed, update declaredAppConfigKeys() in tests/unit/scene-registry.test.ts.',
  );
}

/** Each `*-adapter.ts` file's source, keyed by the agent id in its own `readonly name`. */
function adapterSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const folder of fs.readdirSync(AGENT_ADAPTERS_ROOT, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const folderPath = path.join(AGENT_ADAPTERS_ROOT, folder.name);
    for (const fileName of fs.readdirSync(folderPath)) {
      if (!fileName.endsWith('-adapter.ts')) continue;
      const source = fs.readFileSync(path.join(folderPath, fileName), 'utf-8');
      const agentName = source.match(/readonly name = '([^']+)'/)?.[1];
      if (agentName) sources.set(agentName, source);
    }
  }
  return sources;
}

/**
 * The agent ids whose adapter defines `probeAuth`. listAgents calls the probe only where an
 * adapter has one, so every other agent reports no auth state and the desktop can never show it
 * as signed out.
 */
function agentsWithAuthProbe(): Set<string> {
  const probed = new Set<string>();
  for (const [agentName, source] of adapterSources()) {
    if (/^\s+(?:async\s+)?probeAuth\s*\(/m.test(source)) probed.add(agentName);
  }
  return probed;
}

/**
 * Each agent's `runtime.reportsTurnEnd`, as its adapter declares it. Main's agent list reports
 * it, and the Column Manager blocks On agent turn end on a column whose agent says false. The
 * mock's own list leaves it out, which reads as true, so a demo agent that does not carry its
 * adapter's value draws a turn-end group the desktop would refuse.
 */
function adapterTurnEndReports(): Map<string, boolean> {
  const reports = new Map<string, boolean>();
  for (const [agentName, source] of adapterSources()) {
    const reported = source.match(/^\s+reportsTurnEnd: (true|false),/m)?.[1];
    if (reported) reports.set(agentName, reported === 'true');
  }
  return reports;
}

const DEMO_STATE_KEYS = ['config', 'tasks', 'sessions', 'seeds', 'steps', 'rows'];

/** The task ids a scene's install holds: the sample install's, plus the scene-only rows it adds. */
function sceneTaskIds(scene: SceneDefinition): Set<string> {
  return new Set([...DEMO_TASKS.map((task) => task.id), ...(scene.rows ?? [])]);
}

/** A sample project's columns in the shape the route helpers read: ids, board order, and roles. */
function routeColumnsOf(projectId: string): RouteColumn[] {
  return (DEMO_LANES_BY_PROJECT[projectId] ?? []).map((lane, position) => ({
    id: demoLaneId(projectId, lane.slug),
    position,
    role: lane.role,
    is_archived: lane.is_archived,
    is_ghost: false,
  }));
}

/** The session ids a scene's install holds: the sample install's, plus those of the rows it adds. */
function sceneSessionIds(scene: SceneDefinition): Set<string> {
  const added = DEMO_SCENE_SESSIONS.filter((session) => session.taskId !== null && (scene.rows ?? []).includes(session.taskId));
  return new Set([...DEMO_SESSIONS.map((session) => session.id), ...added.map((session) => session.id)]);
}
/** What a session patch may carry, and the values each field takes (DemoState.sessions). */
const SESSION_PATCH_VALUES: Record<string, readonly unknown[]> = {
  activity: ['thinking', 'idle', 'permission'],
  status: ['running', 'suspended', 'queued'],
  resuming: [true],
};
/** The keys a boot step may carry: a click, typed text, or a held hotkey, each with an optional wait. */
const BOOT_STEP_KEYS = ['click', 'type', 'text', 'press', 'waitFor'];

/** The gestures a choreography step may make (ChoreographyGesture), and what may ride beside one. */
const CHOREOGRAPHY_GESTURES = ['hover', 'click', 'contextmenu', 'drag', 'drop', 'type', 'key', 'choose', 'scroll', 'hotkeyDown', 'hotkeyUp', 'pose'];
const CHOREOGRAPHY_STEP_EXTRAS = ['waitFor', 'ms'];

/** Whether a scene moves under loop=1 by its own declaration: a cycle to play, a timeline, or a stated reason. */
function declaresMotion(scene: SceneDefinition): boolean {
  const choreography = scene.choreography ?? [];
  const poseIndex = choreography.findIndex((step) => 'pose' in step);
  const playsCycle = choreography.length > 0 && (poseIndex < 0 || poseIndex < choreography.length - 1);
  return playsCycle || (scene.timeline ?? []).length > 0 || (scene.motion ?? '').trim() !== '';
}

/** The gesture key a step makes, or null when it names none or several. */
function gestureOf(step: ChoreographyStep): string | null {
  const gestures = Object.keys(step).filter((key) => CHOREOGRAPHY_GESTURES.includes(key));
  return gestures.length === 1 ? gestures[0] : null;
}

/** A target is a selector, or a point inside the frame as fractions of it. */
function isTarget(target: ChoreographyTarget | undefined): boolean {
  if (typeof target === 'string') return target.trim() !== '';
  if (!target || typeof target !== 'object') return false;
  return [target.x, target.y].every((value) => typeof value === 'number' && value >= 0 && value <= 1);
}

/** The tells the writing-style scan bans, plus the `--` separator it cannot tell from a CLI flag. */
const BANNED_CHARACTERS = /[—–‘’“”]|--/;

const entries = Object.entries(SCENES);
const scenes = entries.map(([, scene]) => scene);

function stepsOf(scene: SceneDefinition): DemoBootStep[] {
  return scene.steps ?? [];
}

/** The anchors a tile tree's leaves name, in order. */
function tileLeaves(node: SerializedTileNode | null): string[] {
  if (!node) return [];
  if (node.kind === 'leaf') return [node.taskId];
  return node.children.flatMap(tileLeaves);
}

/** Every workspace blob a scene restores: the board layer's per-project map and the Command Terminal's global one. */
function workspacesOf(scene: SceneDefinition): Array<{ where: string; workspace: SerializedWorkspace }> {
  const config = scene.config ?? {};
  const restored: Array<{ where: string; workspace: SerializedWorkspace }> = [];
  for (const [projectId, workspace] of Object.entries((config.workspaceByProject ?? {}) as Record<string, SerializedWorkspace>)) {
    restored.push({ where: `workspaceByProject.${projectId}`, workspace });
  }
  if (config.commandTerminalWorkspace) restored.push({ where: 'commandTerminalWorkspace', workspace: config.commandTerminalWorkspace as SerializedWorkspace });
  return restored;
}

describe('scene registry', () => {
  it('is a plausible catalog', () => {
    // Vacuity guard: an import that resolved to an empty map would pass every check below.
    expect(scenes.length).toBeGreaterThanOrEqual(20);
    expect(SCENES.board).toBeDefined();
    expect(SCENES.monitor).toBeDefined();
  });

  it('keys every entry by its name', () => {
    for (const [key, scene] of entries) expect(scene.name, `SCENES.${key}`).toBe(key);
  });

  it('carries the fields the consumers read', () => {
    for (const scene of scenes) {
      expect(scene.description.trim(), `${scene.name}.description`).not.toBe('');
      expect(scene.alt.trim(), `${scene.name}.alt`).not.toBe('');
      expect(scene.ready.trim(), `${scene.name}.ready`).not.toBe('');
      // An alt is one or two sentences a screen reader speaks, not a paragraph.
      expect(scene.alt.length, `${scene.name}.alt is too long for alt text`).toBeLessThanOrEqual(260);
    }
  });

  it('writes its alt strings in house style', () => {
    for (const scene of scenes) {
      expect(scene.alt, `${scene.name}.alt carries a dash or a curly quote`).not.toMatch(BANNED_CHARACTERS);
      expect(scene.description, `${scene.name}.description carries a dash or a curly quote`).not.toMatch(BANNED_CHARACTERS);
    }
  });

  it('tags reach by what the frame does before it reveals', () => {
    for (const scene of scenes) {
      const steps = stepsOf(scene);
      if (scene.reach === 'state') {
        expect(steps, `${scene.name} is state but has steps`).toEqual([]);
        expect(hasPose(scene.choreography), `${scene.name} is state but plays a pose before it reveals; tag it boot`).toBe(false);
      } else {
        expect(steps.length > 0 || hasPose(scene.choreography), `${scene.name} is boot but neither clicks nor poses; tag it state`).toBe(true);
        for (const step of steps) {
          const extra = Object.keys(step).filter((key) => !BOOT_STEP_KEYS.includes(key));
          expect(extra, `${scene.name} boot step has keys boot.js would refuse`).toEqual([]);
          expect('click' in step || 'type' in step || 'press' in step, `${scene.name} boot step neither clicks, types, nor presses`).toBe(true);
        }
      }
    }
  });

  it('writes each choreography from its closed vocabulary, data only', () => {
    let checked = 0;
    for (const scene of scenes) {
      const choreography = scene.choreography;
      if (choreography === undefined) continue;
      checked += 1;
      expect(choreography.length, `${scene.name}.choreography is empty`).toBeGreaterThan(0);
      expect(choreography.filter((step) => 'pose' in step).length, `${scene.name} poses more than once`).toBeLessThanOrEqual(1);
      expect(choreography.some((step) => !('pose' in step)), `${scene.name}.choreography makes no gesture`).toBe(true);
      choreography.forEach((step, index) => {
        const where = `${scene.name}.choreography[${index}]`;
        const gesture = gestureOf(step);
        expect(gesture, `${where} makes exactly one gesture of ${CHOREOGRAPHY_GESTURES.join(', ')}`).not.toBeNull();
        const extra = Object.keys(step).filter((key) => key !== gesture && !CHOREOGRAPHY_STEP_EXTRAS.includes(key));
        expect(extra, `${where} carries keys the player does not read`).toEqual([]);
        if (step.ms !== undefined) expect(Number.isFinite(step.ms) && step.ms >= 0, `${where}.ms is not a duration`).toBe(true);
        if (step.waitFor !== undefined) expect(step.waitFor.trim(), `${where}.waitFor is empty`).not.toBe('');
        if ('pose' in step) {
          expect(step.pose, `${where}.pose`).toBe(true);
          expect(Object.keys(step), `${where} is a pose and nothing else`).toEqual(['pose']);
        }
        if ('hover' in step) expect(isTarget(step.hover), `${where}.hover`).toBe(true);
        if ('click' in step) expect(isTarget(step.click), `${where}.click`).toBe(true);
        if ('contextmenu' in step) expect(isTarget(step.contextmenu), `${where}.contextmenu`).toBe(true);
        if ('drag' in step) {
          const drag = step.drag as { from?: ChoreographyTarget; to?: ChoreographyTarget; by?: { x: number; y: number } };
          expect(isTarget(drag.from), `${where}.drag needs a from`).toBe(true);
          expect((drag.to === undefined) !== (drag.by === undefined), `${where}.drag needs one of a to and a by`).toBe(true);
          if (drag.to !== undefined) expect(isTarget(drag.to), `${where}.drag.to`).toBe(true);
          if (drag.by !== undefined) {
            expect([drag.by.x, drag.by.y].every((value) => typeof value === 'number' && Math.abs(value) <= 1), `${where}.drag.by is fractions of the frame`).toBe(true);
          }
          // Nothing releases a held pointer but a visitor, so the gesture it holds is the pose.
          if (step.drag.hold) expect('pose' in (choreography[index + 1] ?? {}), `${where} holds the pointer, so the pose follows it`).toBe(true);
        }
        if ('type' in step) {
          expect(Object.keys(step.type).sort(), `${where}.type names a field and a text`).toEqual(['into', 'text']);
          expect(step.type.into.trim(), `${where}.type.into`).not.toBe('');
          expect(typeof step.type.text, `${where}.type.text`).toBe('string');
          // Typed text is a visitor's keystrokes; a newline would be the Enter that submits.
          expect(step.type.text, `${where}.type.text carries a newline`).not.toMatch(/[\r\n]/);
          expect(step.type.text, `${where}.type.text carries a dash or a curly quote`).not.toMatch(BANNED_CHARACTERS);
        }
        if ('key' in step) expect(CHOREOGRAPHY_KEYS as readonly string[], `${where}.key is not one a choreography may press`).toContain(step.key);
        if ('choose' in step) {
          expect(Object.keys(step.choose).sort(), `${where}.choose names a select and a value`).toEqual(['in', 'value']);
          expect(step.choose.in.trim(), `${where}.choose.in`).not.toBe('');
          expect(typeof step.choose.value, `${where}.choose.value`).toBe('string');
        }
        if ('scroll' in step) expect(step.scroll.trim(), `${where}.scroll`).not.toBe('');
        if ('drop' in step) {
          // It lets go of the pose's held drag, which is the only drag a cycle starts holding: the
          // pose comes right before it, and the step before the pose holds.
          expect(step.drop, `${where}.drop`).toBe(true);
          const previous = choreography[index - 1] ?? {};
          const held = choreography[index - 2] ?? {};
          expect('pose' in previous && 'drag' in held && held.drag.hold === true, `${where} drops a drag the pose before it does not hold`).toBe(true);
        }
        // The same table boot.js presses a boot step's hotkey from, so a typo fails here and not in a frame.
        if ('hotkeyDown' in step) expect(step.hotkeyDown, `${where}.hotkeyDown`).toMatch(/^Mouse:(Back|Forward|Middle)$/);
        if ('hotkeyUp' in step) expect(step.hotkeyUp, `${where}.hotkeyUp`).toMatch(/^Mouse:(Back|Forward|Middle)$/);
      });
      // A hotkey a cycle lets go of is pressed again before the cycle ends, so the frame comes back held.
      const balance = new Map<string, number>();
      for (const step of choreography) {
        if ('hotkeyDown' in step) balance.set(step.hotkeyDown, (balance.get(step.hotkeyDown) ?? 0) + 1);
        if ('hotkeyUp' in step) balance.set(step.hotkeyUp, (balance.get(step.hotkeyUp) ?? 0) - 1);
      }
      for (const [combo, net] of balance) expect(net, `${scene.name} presses ${combo} and lets it go a different number of times`).toBe(0);
    }
    expect(checked, 'no scene carries a choreography').toBeGreaterThan(0);
  });

  it('times each timeline event on a working session the scene holds, moving a card it holds', () => {
    const laneIds = new Set(demoLaneIds());
    const recordings = loadDemoRecordings();
    let checked = 0;
    for (const scene of scenes) {
      for (const [index, event] of (scene.timeline ?? []).entries()) {
        checked += 1;
        const where = `${scene.name}.timeline[${index}]`;
        expect(sceneSessionIds(scene).has(event.session), `${where} names a session the install does not hold`).toBe(true);
        // The clock that fires it runs only for a session the board seeds as working, from its recording.
        const session = DEMO_ALL_SESSIONS.find((candidate) => candidate.id === event.session);
        const activity = scene.sessions?.[event.session]?.activity ?? session?.activity;
        expect(activity, `${where} rides a session that is not working, whose clock never runs`).toBe('thinking');
        expect(recordings.sessions[event.session], `${where} rides a session with no recording`).toBeDefined();
        expect(event.at, `${where}.at`).toBe('end');
        expect(Object.keys(event.do), `${where}.do names one action`).toEqual(['move']);
        expect(sceneTaskIds(scene).has(event.do.move.task), `${where} moves a task the install does not hold`).toBe(true);
        expect(laneIds.has(event.do.move.to), `${where} moves to a lane the install does not have`).toBe(true);
        expect(['agent', 'workflow'], `${where}.origin`).toContain(event.do.move.origin);
      }
    }
    expect(checked, 'no scene carries a timeline').toBeGreaterThan(0);
  });

  it('moves a workflow\'s task only where main would: a finished step to its next column, a start once every blocker is done', () => {
    // A workflow move is the engine's, not the scene's to choose, so each one is replayed here
    // through the same pure route helpers main uses (src/shared/workflow-route.ts), in the
    // timeline's own order, over the scene's board as its patches leave it.
    const ends = loadDemoEnds();
    let checked = 0;
    for (const scene of scenes) {
      const events = (scene.timeline ?? []).filter((event) => event.do.move.origin === 'workflow');
      if (events.length === 0) continue;
      const lanesByTask = new Map<string, string>();
      for (const task of DEMO_TASKS) lanesByTask.set(task.id, demoLaneId(task.projectId, task.lane));
      const patches = new Map((scene.tasks ?? []).map((patch) => [patch.id, patch]));
      const links = ((scene.seeds?.__mockWorkflowLinks ?? []) as Array<{ blocker_task_id: string; blocked_task_id: string }>);
      for (const [index, event] of events.entries()) {
        checked += 1;
        const where = `${scene.name}.timeline workflow move ${index}`;
        const move = event.do.move;
        const patch = patches.get(move.task) as (RouteFields & { workflow_id?: string }) | undefined;
        expect(patch?.workflow_id, `${where} moves ${move.task}, which is not in the scene's workflow`).toBeTruthy();
        const task = DEMO_TASKS.find((candidate) => candidate.id === move.task);
        const columns = routeColumnsOf(task?.projectId ?? '');
        const from = lanesByTask.get(move.task) ?? '';
        const fromColumn = columns.find((column) => column.id === from);
        if (fromColumn?.role === 'todo') {
          // A start: every link into the task has its blocker in Done by now.
          const blockers = links.filter((link) => link.blocked_task_id === move.task).map((link) => link.blocker_task_id);
          for (const blocker of blockers) {
            const blockerColumn = columns.find((column) => column.id === lanesByTask.get(blocker));
            expect(blockerColumn?.role, `${where} starts ${move.task} while ${blocker} is not done`).toBe('done');
          }
          expect(move.to, `${where} starts ${move.task} somewhere other than its route's first column`).toBe(startColumn(columns, patch as RouteFields)?.id);
        } else {
          // A step: the Automation agent judges a finished turn, so the session's recording ran to
          // the agent's own end, and the task goes to the next column on its route.
          expect(['idle', 'exited'], `${where} rides a session whose turn never ended`).toContain(ends[event.session]?.stopReason);
          expect(scene.config?.automation, `${where} moves on a step with no Automation agent to judge it`).toBeTruthy();
          expect(move.to, `${where} moves ${move.task} somewhere other than the next column on its route`).toBe(nextOnRoute(columns, patch as RouteFields, from)?.id);
        }
        lanesByTask.set(move.task, move.to);
      }
    }
    expect(checked, 'no scene carries a workflow move').toBeGreaterThan(0);
  });

  it('says how every scene moves under loop=1', () => {
    // A choreography that is only a pose holds still, so it does not count: every scene plays a
    // cycle, rides a timeline, or says in a sentence why it moves without either.
    for (const scene of scenes) {
      expect(declaresMotion(scene), `${scene.name} declares no choreography cycle, timeline, or motion reason`).toBe(true);
    }
  });

  it('patches only rows the scene\'s install holds: the sample install\'s and the scene-only rows it adds', () => {
    for (const scene of scenes) {
      const taskIds = sceneTaskIds(scene);
      const sessionIds = sceneSessionIds(scene);
      for (const patch of scene.tasks ?? []) {
        expect(taskIds.has(patch.id), `${scene.name} patches unknown task ${patch.id}`).toBe(true);
      }
      for (const sessionId of Object.keys(scene.sessions ?? {})) {
        expect(sessionIds.has(sessionId), `${scene.name} patches unknown session ${sessionId}`).toBe(true);
      }
    }
  });

  it('patches a session only with fields the seed folds in, and resumes only a running one', () => {
    // The seed reads exactly these three fields (demo-dataset.ts, the sessionPatches fold), so an
    // extra key or an off-list value is a patch that quietly does nothing, and a resume on a
    // paused or queued session is a state main never produces: it marks only a live respawn.
    const sessionStatus = new Map(DEMO_ALL_SESSIONS.map((session) => [session.id, session.status]));
    let resuming = 0;
    for (const scene of scenes) {
      for (const [sessionId, patch] of Object.entries(scene.sessions ?? {})) {
        for (const [field, value] of Object.entries(patch)) {
          const allowed = SESSION_PATCH_VALUES[field];
          expect(allowed, `${scene.name} patches ${sessionId}.${field}, which the seed does not read`).toBeDefined();
          expect(allowed, `${scene.name} patches ${sessionId}.${field} to ${String(value)}`).toContain(value);
        }
        if (!patch.resuming) continue;
        resuming += 1;
        expect(patch.status ?? sessionStatus.get(sessionId), `${scene.name} resumes ${sessionId}, which is not running`).toBe('running');
      }
    }
    // Vacuity guard: session-resume is the scene that resumes one.
    expect(resuming).toBeGreaterThanOrEqual(1);
  });

  it('restores windows only on rows the sample install seeds, and tiles only windows it restores', () => {
    // deserializeWorkspace drops a window whose anchor is unknown and, if that window was tiled,
    // the whole tile tree with it, silently: a tiled scene naming a stray id would boot to two
    // floating windows or none, and its ready selector would time out rather than say why.
    let restoredWindows = 0;
    for (const scene of scenes) {
      const taskIds = sceneTaskIds(scene);
      const sessionIds = sceneSessionIds(scene);
      for (const { where, workspace } of workspacesOf(scene)) {
        const anchors = new Set<string>();
        for (const window of workspace.windows) {
          restoredWindows += 1;
          const kind = window.kind ?? 'task-detail';
          if (kind === 'task-detail') expect(taskIds.has(window.taskId), `${scene.name} ${where} restores a task window on unknown task ${window.taskId}`).toBe(true);
          if (kind === 'conversation') expect(sessionIds.has(window.taskId), `${scene.name} ${where} restores a conversation window on unknown session ${window.taskId}`).toBe(true);
          if (kind === 'command-terminal') expect(window.taskId, `${scene.name} ${where} anchors a Command Terminal on something other than a slot`).toMatch(/^slot-\d+$/);
          anchors.add(window.taskId);
        }
        for (const leaf of tileLeaves(workspace.tileTree)) {
          expect(anchors.has(leaf), `${scene.name} ${where} tiles a leaf with no window: ${leaf}`).toBe(true);
        }
        if (workspace.focusedTaskId) expect(anchors.has(workspace.focusedTaskId), `${scene.name} ${where} focuses a window it does not restore`).toBe(true);
      }
    }
    // Vacuity guard: the task, changes, and tiled scenes all restore windows.
    expect(restoredWindows).toBeGreaterThan(5);
  });

  it('adds only scene-only rows the seed carries, each with a recorded session and the next free ticket', () => {
    // The seed folds a scene's `rows` into the install by id (demo-dataset.ts); boot.js refuses an id
    // the build does not emit, so a typo here is an error card in the frame rather than a quiet gap.
    const carried = new Set(DEMO_SCENE_TASKS.map((task) => task.id));
    const recordings = loadDemoRecordings().sessions;
    let added = 0;
    for (const scene of scenes) {
      for (const taskId of scene.rows ?? []) {
        added += 1;
        expect(carried.has(taskId), `${scene.name} adds ${taskId}, which is not a scene-only task`).toBe(true);
      }
    }
    for (const task of DEMO_SCENE_TASKS) {
      expect(DEMO_TASKS.some((row) => row.id === task.id), `${task.id} is a scene-only row and a dataset row at once`).toBe(false);
      const sessions = DEMO_SCENE_SESSIONS.filter((session) => session.taskId === task.id);
      expect(sessions.map((session) => session.id), `${task.id} names its session`).toEqual([task.session_id]);
      // The ticket is a literal on the row and is held two ways. It is the next free one on the
      // board, which is the number the preview's allocator handed the task when the capture seeded
      // the board after the archived history (scripts/capture-demo-sessions.mjs). And the recording's
      // own kangentic_* results print it, so a dataset change that moved the next free ticket fails
      // here rather than leaving a card whose terminal names another number.
      const projectTickets = DEMO_TASKS.filter((row) => row.projectId === task.projectId).map((row) => row.display_id);
      expect(task.display_id, `${task.id} must take the next free ticket on its board`).toBe(Math.max(...projectTickets) + 1);
      for (const session of sessions) {
        const recording = recordings[session.id];
        expect(recording, `${session.id} has no recording; every terminal replays one`).toBeDefined();
        const printed = (recording?.serialized ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        expect(printed, `${session.id}'s recording never prints #${task.display_id}`).toContain(`#${task.display_id}`);
      }
    }
    // Vacuity guard: task-mcp adds the one scene-only row there is.
    expect(added).toBeGreaterThanOrEqual(1);
  });

  it('fits a window only to a session the recordings index carries', () => {
    // The seed sizes a window marked fitToRecording to that session's recording at the visitor's
    // own cell (demo-dataset.ts, fitLayoutBlob). A marker naming a session with no recording is
    // refused with a console error in the frame; this says so at the source, before a build.
    const recorded = new Set(Object.keys(loadDemoRecordings().sessions));
    let fitted = 0;
    for (const scene of scenes) {
      for (const { where, workspace } of workspacesOf(scene)) {
        for (const window of workspace.windows as Array<SerializedWorkspace['windows'][number] & { fitToRecording?: unknown }>) {
          if (window.fitToRecording === undefined) continue;
          fitted += 1;
          expect(typeof window.fitToRecording, `${scene.name} ${where} names a fitToRecording that is not a session id`).toBe('string');
          expect(recorded.has(String(window.fitToRecording)), `${scene.name} ${where} fits a window to ${String(window.fitToRecording)}, which has no recording`).toBe(true);
          expect(window.state, `${scene.name} ${where} fits a window that is not floating; only a floating window keeps its own width`).toBe('floating');
        }
      }
    }
    // Vacuity guard: the task, dictation, window-dock, and command-terminal scenes are fitted.
    expect(fitted).toBeGreaterThanOrEqual(4);
  });

  it('overrides only real config keys', () => {
    // The mock's Object.assign would accept any key and the renderer would never read it.
    const configKeys = declaredAppConfigKeys();
    // Vacuity guard: a parse that resolved no members would accept every typo.
    expect(configKeys.size).toBeGreaterThan(Object.keys(DEFAULT_CONFIG).length / 2);
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(configKeys.has(key), `AppConfig no longer declares ${key}; declaredAppConfigKeys() is parsing the wrong thing`).toBe(true);
    }
    for (const scene of scenes) {
      for (const key of Object.keys(scene.config ?? {})) {
        expect(configKeys.has(key), `${scene.name}.config.${key} is not an AppConfig key`).toBe(true);
      }
    }
  });

  it('spells a nested config block whole, because a scene REPLACES one', () => {
    // boot.js merges a scene's config with a shallow Object.assign, and so does the mock, so a
    // nested block a scene names replaces the default's WHOLE. Naming one field of it therefore
    // leaves every sibling undefined, on settings the scene never meant to touch and that no
    // frame shows. The key-set check is what makes that loud; the VALUES are the scene's business.
    //
    // A block with no populated default (an optional one like `developer`, or a map keyed by
    // project id like `workspaceByProject`) has no shape to match and is skipped.
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const isPlainObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    let checked = 0;
    for (const scene of scenes) {
      for (const [key, override] of Object.entries(scene.config ?? {})) {
        const fallback = defaults[key];
        if (!isPlainObject(fallback) || !isPlainObject(override)) continue;
        if (Object.keys(fallback).length === 0) continue;
        checked += 1;
        expect(
          Object.keys(override).sort(),
          `${scene.name}.config.${key} replaces the whole block, so it must name every field DEFAULT_CONFIG.${key} has`,
        ).toEqual(Object.keys(fallback).sort());
      }
    }
    // Vacuity guard: the monitor and notification scenes both replace a populated block.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('seeds column ids the sample install actually has', () => {
    // A `tasks` or `sessions` patch is checked above; a `__mock*` seed is not, and a typo'd
    // column id fails SILENTLY in the worst way available: the Column Manager still opens, the
    // automation slot still reads Add automation, the scene's ready selector still resolves, and
    // the alt written from that frame is wrong. The ids come from demoLaneId, which the seed
    // itself uses, so this cannot drift from what the install writes.
    const laneIds = new Set(demoLaneIds());
    // Vacuity guard: a formula change that returned nothing, or collided every id into one, would
    // otherwise leave the loop below asserting against an empty set. The sample install seeds two
    // projects off DEFAULT_LANES, so the real count is comfortably above this floor; the floor is
    // deliberately loose so adding or retiring one column does not fail an unrelated test.
    expect(laneIds.size).toBeGreaterThan(6);
    let checked = 0;
    for (const scene of scenes) {
      const seeds = (scene.seeds ?? {}) as {
        __mockSwimlanePatches?: Record<string, unknown>;
        __mockAutomations?: Array<{ swimlane_id?: string }>;
      };
      for (const laneId of Object.keys(seeds.__mockSwimlanePatches ?? {})) {
        checked += 1;
        expect(laneIds.has(laneId), `${scene.name} patches unknown column ${laneId}`).toBe(true);
      }
      for (const automation of seeds.__mockAutomations ?? []) {
        checked += 1;
        expect(
          automation.swimlane_id !== undefined && laneIds.has(automation.swimlane_id),
          `${scene.name} seeds an automation on unknown column ${String(automation.swimlane_id)}`,
        ).toBe(true);
      }
    }
    // Vacuity guard: the column-automation and column-handoff scenes both seed one.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('seeds a task report only for an archived task of the open project', () => {
    // The mock serves a `__mockTaskReports` entry for whatever id it is keyed by, so a typo'd or
    // live task id fails silently: View details on the row opens the thin derived report, the
    // ready selector never resolves, and the scene times out with nothing to say why. Only an
    // archived contoso task has a row in the Completed Tasks dialog the scenes open it from.
    const archivedContosoIds = new Set(DEMO_TASKS.filter((task) => task.projectId === PROJECT_CONTOSO && task.archivedDaysAgo).map((task) => task.id));
    let checked = 0;
    const seededTaskIds = new Set<string>();
    for (const scene of scenes) {
      const reports = (scene.seeds ?? {}).__mockTaskReports as Record<string, unknown> | undefined;
      for (const taskId of Object.keys(reports ?? {})) {
        checked += 1;
        seededTaskIds.add(taskId);
        expect(archivedContosoIds.has(taskId), `${scene.name} seeds a report for ${taskId}, which is not an archived contoso task`).toBe(true);
      }
    }
    // Vacuity guard: the two completed-task scenes each seed one.
    expect(checked).toBeGreaterThanOrEqual(2);
    // The one authored report web-demo-parity.md allows: every scene that seeds one seeds the same task's.
    expect([...seededTaskIds], 'a second task carries an authored report').toHaveLength(1);
  });

  it('seeds only __mock globals', () => {
    for (const scene of scenes) {
      for (const key of Object.keys(scene.seeds ?? {})) {
        expect(key.startsWith('__mock'), `${scene.name}.seeds.${key}`).toBe(true);
      }
    }
  });

  it('signs out only an agent whose adapter can report it', () => {
    // v0.43.0 shipped welcome-setup with Gemini CLI signed out. Gemini has no auth probe, so the
    // desktop never draws that row, and a docs figure held on a state the app cannot produce.
    const probed = agentsWithAuthProbe();
    expect(probed.size, 'no adapter defines probeAuth; was the method renamed?').toBeGreaterThan(0);
    const agentReports: Array<{ where: string; agents: Record<string, Record<string, unknown>> }> = [
      { where: 'DEMO_AGENT_OVERRIDES', agents: DEMO_AGENT_OVERRIDES },
      ...scenes.map((scene) => ({
        where: `${scene.name}.seeds.__mockAgentListOverrides`,
        agents: (scene.seeds?.__mockAgentListOverrides ?? {}) as Record<string, Record<string, unknown>>,
      })),
    ];
    let checked = 0;
    for (const { where, agents } of agentReports) {
      for (const [agentName, override] of Object.entries(agents)) {
        if (override.authenticated !== false) continue;
        checked += 1;
        expect(probed.has(agentName), `${where} signs out ${agentName}, whose adapter has no probeAuth`).toBe(true);
      }
    }
    // Vacuity guard: welcome-setup is the scene that seeds a signed-out agent.
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  it('reports each agent\'s turn end as its adapter does', () => {
    // The sample install's Code Review column runs Codex, which says nothing when a turn ends, so
    // the desktop blocks On agent turn end there. Before the overrides carried the flag, every
    // Column Manager scene showed that group as runnable.
    const reports = adapterTurnEndReports();
    expect(reports.get('claude'), 'the Claude adapter no longer declares reportsTurnEnd; was it renamed?').toBe(true);
    expect(reports.get('codex'), 'the Codex adapter no longer declares reportsTurnEnd; was it renamed?').toBe(false);
    for (const [agentName, override] of Object.entries(DEMO_AGENT_OVERRIDES)) {
      expect(reports.has(agentName), `DEMO_AGENT_OVERRIDES names ${agentName}, which has no adapter declaring reportsTurnEnd`).toBe(true);
      expect(override.reportsTurnEnd, `DEMO_AGENT_OVERRIDES.${agentName}.reportsTurnEnd`).toBe(reports.get(agentName));
    }
    // A scene's own agent list replaces the dataset's whole, so one that sets the flag is held to it too.
    for (const scene of scenes) {
      const agents = (scene.seeds?.__mockAgentListOverrides ?? {}) as Record<string, Record<string, unknown>>;
      for (const [agentName, override] of Object.entries(agents)) {
        if (override.reportsTurnEnd === undefined) continue;
        expect(override.reportsTurnEnd, `${scene.name}.seeds.__mockAgentListOverrides.${agentName}.reportsTurnEnd`).toBe(reports.get(agentName));
      }
    }
  });

  it('links only workflow members the sample install seeds', () => {
    // The mock leaves out a link whose end is not a task in its workflow, with no error: a renamed
    // task id would drop a line from the canvas and a waiting card's Blocked by, and the figure
    // would still boot. Every end must be a row the install seeds that the scene patches into
    // the same workflow.
    const taskIds = new Set(DEMO_TASKS.map((task) => task.id));
    let checked = 0;
    for (const scene of scenes) {
      const seeds = (scene.seeds ?? {}) as {
        __mockWorkflows?: Array<{ workflow: { id: string } }>;
        __mockWorkflowLinks?: Array<{ workflow_id: string; blocker_task_id: string; blocked_task_id: string }>;
      };
      const workflowIds = new Set((seeds.__mockWorkflows ?? []).map((entry) => entry.workflow.id));
      const memberOf = new Map((scene.tasks ?? []).map((patch) => [patch.id, patch.workflow_id]));
      for (const link of seeds.__mockWorkflowLinks ?? []) {
        checked += 1;
        expect(workflowIds.has(link.workflow_id), `${scene.name} links tasks in ${link.workflow_id}, which it does not seed`).toBe(true);
        for (const end of [link.blocker_task_id, link.blocked_task_id]) {
          expect(taskIds.has(end), `${scene.name} links unknown task ${end}`).toBe(true);
          expect(memberOf.get(end), `${scene.name} links ${end} without patching it into ${link.workflow_id}`).toBe(link.workflow_id);
        }
      }
    }
    // Vacuity guard: the workflows and board-workflow scenes both seed links.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('draws a recorded workflow agent\'s plan as the plan its recording saved, beside the agent', () => {
    // The pane shows the agent saving a plan, and the canvas beside it draws the scene's draft. A
    // draft written by hand, or a plan fixture left behind by a re-recording, would put a plan on
    // the canvas the agent never saved, so the draft must be the recording's plan read back
    // (scripts/lib/demo-mcp-capture.mjs, planFixtureOf). A scene that shows one also names a
    // Workflow agent, since the pane otherwise asks for one and never opens the agent.
    const recorded = Object.keys(loadDemoRecordings().workflowAgents);
    const plansDirectory = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo', 'workflow-plans');
    const shownBy = new Map<string, string[]>();
    for (const scene of scenes) {
      const seeds = (scene.seeds ?? {}) as { __mockWorkflows?: Array<{ workflow: { id: string; title: string; draft: unknown } }> };
      for (const { workflow } of seeds.__mockWorkflows ?? []) {
        if (!recorded.includes(workflow.id)) continue;
        shownBy.set(workflow.id, [...(shownBy.get(workflow.id) ?? []), scene.name]);
        const plan = JSON.parse(fs.readFileSync(path.join(plansDirectory, `${workflow.id}.json`), 'utf-8')) as Parameters<typeof draftOfRecordedPlan>[0];
        expect(workflow.draft, `${scene.name} draws a plan for ${workflow.id} that its recording did not save`).toEqual(draftOfRecordedPlan(plan));
        expect(workflow.title).toBe(plan.title);
        const choice = (scene.config as { workflows?: { agent?: string | null; model?: string | null } } | undefined)?.workflows;
        expect(choice?.agent, `${scene.name} shows ${workflow.id}'s recorded agent, so it names a Workflow agent`).toBeTruthy();
        expect(choice?.model, `${scene.name} names a model, which Claude's Workflow agent setting needs`).toBeTruthy();
      }
    }
    // Every recorded workflow agent is shown somewhere, and has the plan it saved beside it: the
    // last save its terminal prints (the result kangentic_save_workflow answers with,
    // workflow-commands.ts) counts the plan file's tasks and links, so a re-recording whose plan
    // was never read back cannot pair a new conversation with the old plan.
    for (const workflowId of recorded) {
      expect(shownBy.has(workflowId), `workflow-${workflowId}.json is recorded, and no scene seeds its workflow`).toBe(true);
      const planPath = path.join(plansDirectory, `${workflowId}.json`);
      expect(fs.existsSync(planPath), `workflow-${workflowId}.json has no plan fixture`).toBe(true);
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Parameters<typeof draftOfRecordedPlan>[0];
      const painted = loadDemoRecordings().workflowAgents[workflowId].serialized
        .replace(/\x1b\[\d*C/g, ' ')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const saves = [...painted.matchAll(/Saved:\s+(\d+)\s+tasks?,\s+(\d+)\s+links?\./g)];
      expect(saves.length, `workflow-${workflowId}.json prints no save`).toBeGreaterThan(0);
      const [, taskCount, linkCount] = saves[saves.length - 1];
      expect({ tasks: Number(taskCount), links: Number(linkCount) }, `workflow-${workflowId}.json's last save is not its plan fixture`)
        .toEqual({ tasks: plan.tasks.length, links: plan.links.length });
    }
    // Vacuity guard: workflow-draft shows one.
    expect(shownBy.get(WORKFLOW_INVOICE_PDF)).toContain('workflow-draft');
  });

  it('has one settings scene per settings tab, and no other', () => {
    const tabIds = SETTINGS_TABS.map((tab) => tab.id).sort();
    const settingsScenes = scenes.filter((scene) => scene.name.startsWith('settings-'));
    expect(settingsScenes.map((scene) => scene.name.slice('settings-'.length)).sort()).toEqual(tabIds);

    const registryById = new Map(SETTINGS_REGISTRY.map((setting) => [setting.id, setting]));
    for (const scene of settingsScenes) {
      const tab = scene.name.slice('settings-'.length);
      // Each is the gear and then that tab's button, which shared.tsx stamps by id.
      const clicks = stepsOf(scene).map((step) => ('click' in step ? step.click : ''));
      expect(clicks, `${scene.name} steps`).toEqual(['[data-testid="settings-button"]', `[data-testid="settings-tab-${tab}"]`]);
      // A `setting-row-<id>` marker names a registry row that lives on this tab; a tab-level
      // marker (hotkeys-tab, add-shortcut) is pinned by the smoke tier instead.
      const marker = scene.ready.match(/^\[data-testid="setting-row-(.+)"\]$/);
      if (marker) {
        const setting = registryById.get(marker[1]);
        expect(setting, `${scene.name} waits on a registry row that does not exist: ${marker[1]}`).toBeDefined();
        expect(setting?.tabId, `${scene.name} waits on a row from another tab`).toBe(tab);
      }
    }
  });

  it('agrees with the keys demo/boot.js accepts in a state= blob', () => {
    const boot = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
    const keysMatch = boot.match(/var STATE_KEYS = \[([^\]]*)\]/);
    if (!keysMatch) throw new Error('STATE_KEYS not found in demo/boot.js');
    const bootKeys = Array.from(keysMatch[1].matchAll(/'([a-zA-Z]+)'/g), (match) => match[1]);
    expect(bootKeys.sort()).toEqual([...DEMO_STATE_KEYS].sort());
    // The step allowlist boot.js enforces on a blob is the boot-step shape, and nothing more.
    const stepKeysMatch = boot.match(/var BOOT_STEP_KEYS = \[([^\]]*)\]/);
    if (!stepKeysMatch) throw new Error('BOOT_STEP_KEYS not found in demo/boot.js');
    const bootStepKeys = Array.from(stepKeysMatch[1].matchAll(/'([a-zA-Z]+)'/g), (match) => match[1]);
    expect(bootStepKeys.sort()).toEqual([...BOOT_STEP_KEYS].sort());
    // A session patch in a blob is held to the same fields and values a scene is (above).
    const readList = (name: string): string[] => {
      const listMatch = boot.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
      if (!listMatch) throw new Error(`${name} not found in demo/boot.js`);
      return Array.from(listMatch[1].matchAll(/'([a-zA-Z]+)'/g), (match) => match[1]);
    };
    expect(readList('SESSION_PATCH_KEYS').sort()).toEqual(Object.keys(SESSION_PATCH_VALUES).sort());
    expect(readList('SESSION_ACTIVITIES').sort()).toEqual([...SESSION_PATCH_VALUES.activity].sort());
    expect(readList('SESSION_STATUSES').sort()).toEqual([...SESSION_PATCH_VALUES.status].sort());
    // The seed is what applies a patch, so it has to read the global boot.js publishes.
    expect(boot, 'boot.js publishes the session patches before the seed runs').toContain('window.__demoSessionPatches = effective.sessions');
    const dataset = fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/helpers/demo-dataset.ts'), 'utf-8');
    expect(dataset, 'the seed folds the session patches in').toContain('window.__demoSessionPatches');
    // The timeline rides the same hand-off, and the seed runs it on the session's clock.
    expect(boot, 'boot.js publishes the scene timeline before the seed runs').toContain('window.__demoSceneTimeline = (scene && scene.timeline)');
    expect(dataset, 'the seed reads the scene timeline').toContain('window.__demoSceneTimeline');
    expect(dataset, 'the clock\'s end runs the timeline').toContain("runSessionTimeline(sessionId, 'end')");
    expect(dataset, 'a loop=1 restart undoes it').toContain('revertSessionTimeline(sessionId)');
    // And the choreography: a pose is played before the reveal, a cycle after it under loop=1.
    expect(boot).toContain('scene.choreography');
    expect(boot).toContain('player.playToPose()');
    expect(boot).toContain('player.startLoop()');
    // The two fields the consumers wait on and report are read by name.
    expect(boot).toContain('scene.ready');
    expect(boot).toContain('scene.focus');
    // The nested-block shape the build emits, and the guard that reads it. boot.js is a classic
    // script and cannot import AppConfig, so the two halves only agree by name.
    const viteConfig = fs.readFileSync(DEMO_VITE_CONFIG_PATH, 'utf-8');
    expect(viteConfig, 'the build emits the nested config shape').toContain('window.__demoConfigShape =');
    expect(boot, 'boot.js validates a state= blob against it').toContain('window.__demoConfigShape');
  });

  it('keeps settle to the rig, on markers the renderer still stamps', () => {
    // A live frame plays a scene's motion as the desktop does, and a browser with no WebGL shows
    // the app's own no-GPU card, so boot.js never waits on `settle`. The rig does, before it shoots.
    const boot = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
    expect(boot, 'boot.js reads no settle').not.toContain('settle');
    const scenePage = fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/helpers/scene-page.ts'), 'utf-8');
    expect(scenePage, 'the rig waits on settle').toContain('scene.settle');
    // Each settle selector names a testid the renderer stamps, as does the no-GPU card the rig
    // refuses to shoot: a renamed marker would otherwise time every shot out, or let the card through.
    const rendererSources = (function readAll(directory: string): string {
      return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return readAll(full);
        return /\.tsx?$/.test(entry.name) ? fs.readFileSync(full, 'utf-8') : '';
      }).join('\n');
    })(path.join(REPO_ROOT, 'src/renderer'));
    const testIds: string[] = ['knowledge-graph-webgl-unavailable'];
    for (const scene of Object.values(SCENES)) {
      if (scene.settle === undefined) continue;
      const parts = scene.settle.split(',').map((part) => part.trim());
      expect(parts.length, `${scene.name}.settle names nothing`).toBeGreaterThan(0);
      for (const part of parts) {
        const testId = /^\[data-testid="([^"]+)"\]$/.exec(part)?.[1];
        expect(testId, `${scene.name}.settle part ${part} is not a data-testid selector`).toBeTruthy();
        if (testId) testIds.push(testId);
      }
    }
    for (const testId of testIds) expect(rendererSources, `no renderer file stamps data-testid="${testId}"`).toContain(`data-testid="${testId}"`);
  });

  it('guards the escape message on markers the renderer still stamps', () => {
    // boot.js decides "does the app own this Escape" by looking for these in the DOM, mirroring
    // PopOutWindowFrame's own ladder. A renamed marker would not fail anything: the frame would
    // simply stop posting, or start posting over an open dialog, and the site's figure would
    // quietly get the wrong behaviour. Anchored on the renderer so a rename fails here instead.
    const boot = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
    const markers: Array<{ marker: string; source: string }> = [
      { marker: 'data-dismissable-layer', source: 'src/renderer/components/dialogs/BaseDialog.tsx' },
      // The prefix, not the whole JSX attribute: the selector depends on the prefix alone, and
      // pinning the attribute would fail on a reformat of WindowFrame.tsx rather than a rename.
      { marker: 'window-frame-', source: 'src/renderer/window-manager/components/WindowFrame.tsx' },
      { marker: 'xterm-helper-textarea', source: 'src/renderer/utils/terminal-clipboard.ts' },
      // The view-mode header's X, which a task window shows whenever it shows a terminal. boot.js
      // clicks it to close a window whose hovered terminal kept the key.
      { marker: 'task-detail-close', source: 'src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx' },
      // The one window that does not close on Escape, so boot.js skips its frame.
      { marker: 'command-terminal-window', source: 'src/renderer/components/command-bar/CommandTerminalWindow.tsx' },
      // The predicate that decides whether a task window's terminal keeps Escape. boot.js reads the
      // same one, so a change here must be mirrored there.
      { marker: "matches(':hover')", source: 'src/renderer/utils/terminal-clipboard.ts' },
      // How a parked or retained window is marked. boot.js skips an inert frame, which has nothing
      // left to close.
      { marker: 'inert={isDormant', source: 'src/renderer/window-manager/components/WindowFrame.tsx' },
    ];
    for (const { marker, source } of markers) {
      const rendererSource = fs.readFileSync(path.join(REPO_ROOT, source), 'utf-8');
      expect(rendererSource, `${source} no longer stamps ${marker}`).toContain(marker);
    }
    expect(boot).toContain('[data-dismissable-layer]');
    expect(boot).toContain('[data-testid^="window-frame-"]');
    expect(boot).toContain('xterm-helper-textarea');
    expect(boot).toContain('[data-testid="task-detail-close"]');
    expect(boot).toContain('[data-testid="command-terminal-window"]');
    expect(boot).toContain("matches(':hover')");
    expect(boot).toContain("hasAttribute('inert')");
    expect(boot, 'the escape message is still posted').toContain('kangentic-demo-escape');
  });

  it('is emitted into the demo build as scenes.json', () => {
    const viteConfig = fs.readFileSync(DEMO_VITE_CONFIG_PATH, 'utf-8');
    expect(viteConfig).toContain("fileName: 'scenes.json'");
    // The manifest carries what the site needs and reads it off the same entries the page boots.
    for (const field of ['name', 'reach', 'alt', 'description']) {
      expect(viteConfig, `scenes.json carries ${field}`).toMatch(new RegExp(`${field}: scene\\.${field}`));
    }
  });
});
