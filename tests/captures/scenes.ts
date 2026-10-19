/**
 * The scene registry: one catalog, two consumers.
 *
 * The web build (demo/) resolves `view=<name>` through this map at boot with no driver, and the
 * capture rig (tests/captures/features/scenes.capture.ts) opens the same names in the BUILT demo
 * with Playwright behind it. Every entry is DATA on top of the sample install in
 * helpers/demo-dataset.ts: config overrides, task-row patches, session activity states,
 * `window.__mock*` seeds the mock reads, and a short list of steps the consumer plays before it
 * reveals the frame. No code travels through a scene, so its state can ride a `state=` URL
 * parameter verbatim.
 *
 * A scene can also MOVE, still as data: a `choreography` (pointer steps the live frame plays by
 * itself under loop=1) and a `timeline` (what main does at a moment on a session's replay clock).
 * Neither rides a `state=` URL.
 *
 * `reach` says what the frame does before it reveals:
 *   state   config and rows alone; nothing is clicked
 *   boot    state plus a few pre-reveal clicks, or a choreography's pose (demo/boot.js plays both,
 *           for the site and for the capture rig alike)
 *
 * Three fields ship past this repo. `alt` is the reader-facing text a docs figure carries, so it is
 * authored here, beside the state it describes, and emitted into `dist/demo/scenes.json`. `ready`
 * is the selector that must exist before the frame counts as built: the demo waits for it before
 * it reveals and posts ready, the smoke tier asserts it, and the rig shoots after it. `focus`, when
 * set, names the element whose rect the ready message reports, so a host can crop a dialog scene
 * to the dialog without knowing the layout.
 *
 * Evaluated only in Node: demo/vite.config.mts serializes its values into the static build, and the
 * capture rig reads it as well, so every value is plain data. It calls no Node API itself; the
 * completed-task report reaches main's assembler, whose import chain is Node-safe and side-effect
 * free. tests/unit/scene-registry.test.ts pins the shape.
 */
import { DEMO_AGENT_OVERRIDES, DEMO_COLUMN_MODELS, DEMO_KNOWLEDGE_GRAPH, DEMO_LANES_BY_PROJECT, DEMO_KNOWLEDGE_GRAPH_NODE_TOTAL, DEMO_KNOWLEDGE_GRAPH_STATUS, DEMO_PROJECTS, PROJECT_CONTOSO, PROJECT_PETCLINIC, SESSION_API_CLIENT, SESSION_CONTOSO_TERMINAL, SESSION_EMPTY_STATES, SESSION_INTEGRATION, SESSION_MIDDLEWARE, SESSION_RATE_LIMIT, SESSION_VALIDATE, SESSION_WEBSOCKET, TASK_API_CLIENT, TASK_API_ERRORS, TASK_AUTH, TASK_LOGGING, TASK_MIDDLEWARE, TASK_RATE_LIMIT, TASK_SCHEMA, TASK_VALIDATE, TASK_WEBSOCKET, demoLaneId } from './helpers/demo-dataset';
import { DEMO_COMPLETED_TASK_ID, DEMO_COMPLETED_TASK_REPORT } from './helpers/demo-task-report';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import { commandTerminalTitle } from '../../src/shared/command-terminal-name';
import announcementsFeed from '../../announcements.json';
import contosoHistory from './fixtures/demo/history/contoso-web.json';
import invoicePdfPlan from './fixtures/demo/workflow-plans/wf-cw-invoice-pdf.json';

export type SceneReach = 'state' | 'boot';

/**
 * A step the demo plays in the page before the reveal: a click, or text typed into a field (set
 * through the element's own setter with one input event, so a controlled input takes it). Both
 * are state: no timing, no per-keystroke replay. Motion is the `choreography`'s.
 */
export type DemoBootStep =
  | {
      /** A CSS selector to click, usually a data-testid. boot.js focuses a text field first, as a
       *  pointer click would, because `element.click()` alone leaves focus where it was. */
      click: string;
      /** A selector that must appear before the next step (or the reveal). */
      waitFor?: string;
    }
  | {
      /** A CSS selector of the input or textarea to type into. */
      type: string;
      text: string;
      waitFor?: string;
    }
  | {
      /** A hotkey in the registry's spelling (`Mouse:Back`, `Mod+Shift+P`), pressed and held. */
      press: string;
      waitFor?: string;
    };

/**
 * Where a choreography step points: the centre of the first element a selector matches, or a point
 * as fractions of the frame (a screen edge has no element).
 */
export type ChoreographyTarget = string | { x: number; y: number };

/** The keys a choreography may press: moving a selection. Never Escape, which a host reads as "leave", and never Enter, which submits. */
export const CHOREOGRAPHY_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;

/** What one choreography step does with the pointer or the keyboard (demo/choreography.ts plays it). */
export type ChoreographyGesture =
  /** Travel to the target and rest there, as a visitor's mouse does. */
  | { hover: ChoreographyTarget }
  | { click: ChoreographyTarget }
  | { contextmenu: ChoreographyTarget }
  /** Press on `from`, travel to `to`, and release, or with `hold` stay pressed: the gesture in
   *  flight (the drag overlay, the dock preview). `by` in place of `to` carries it that far as
   *  fractions of the frame, for a drag into empty space no element marks. */
  | { drag: { from: ChoreographyTarget; to: ChoreographyTarget; hold?: boolean } }
  | { drag: { from: ChoreographyTarget; by: { x: number; y: number }; hold?: boolean } }
  /** Let go of the pointer a held drag kept pressed, where it is: the pose's gesture completing. */
  | { drop: true }
  /** Edit a field's text to `text` a keystroke at a time: back to what the two share, then on. The
   *  pointer clicks into the field first unless it already has the focus. `''` clears it. */
  | { type: { into: string; text: string } }
  /** One key, pressed and released on whatever has the focus. */
  | { key: (typeof CHOREOGRAPHY_KEYS)[number] }
  /** An option of a native select picked: the pointer clicks the field and its value changes, with
   *  the input and change events a pick sends. A page cannot draw the browser's own option list. */
  | { choose: { in: string; value: string } }
  /** Scroll the element into the middle of its scroll container, as a wheel over it would. */
  | { scroll: string }
  /** A hotkey in the registry's spelling pressed and held, as a boot step's `press` holds it, and its release. */
  | { hotkeyDown: string }
  | { hotkeyUp: string }
  /** The poster's moment. A still plays the steps up to it and stops, and a live loop starts and
   *  ends on it. At most one; without one the loop rests where the boot steps left the frame. */
  | { pose: true }
  /** Where the cycle's story ends. The frame fades out, the steps after it (up to the end, or to
   *  the end of the steps after the pose) play at once with no pointer drawn, and the frame fades
   *  back in at rest: a product video cutting back to its start, never the undo played on screen.
   *  At most one, after the pose, with a gesture on each side of it. */
  | { cut: true };

/**
 * One beat of a scene's choreography: a gesture, the selector its effect must produce before the
 * next beat (the app's own timing, a dwell or an animation, which pacing never shortens), and the
 * pacing after it in milliseconds. Data, never code.
 */
export type ChoreographyStep = ChoreographyGesture & { waitFor?: string; ms?: number };

/**
 * What main does at a moment on a session's replay clock, through the push main sends for it. `to`
 * is a lane id. A `move` with origin `agent` is an agent's own move (a recorded `kangentic_move_task`
 * result landing): the card changes column and `TASK_UPDATED_BY_AGENT` goes out. One with origin
 * `workflow` is a workflow's: a step the Automation agent judged done moving its task on its route
 * (workflow-step.ts), or the engine starting a task whose blockers are all done
 * (workflow-engine-host.ts); `TASK_MOVED_BY_AUTOMATION` and the workflow's change go out.
 */
export type SceneTimelineAction = { move: { task: string; to: string; origin: 'agent' | 'workflow' } };

/**
 * One timeline event. `at: 'end'` is the moment the session's recording ends, which is where the
 * capture cut it (`stopWhen`), so no offset is typed by hand. `loop=1` puts the frame back when
 * the session starts over.
 */
export interface SceneTimelineEvent {
  session: string;
  at: 'end';
  do: SceneTimelineAction;
}

export interface DemoState {
  /** Merged into `window.__mockConfigOverrides`. Nested objects replace the demo defaults whole. */
  config?: Record<string, unknown>;
  /** Patches merged by id into the sample install's task rows (live or archived). */
  tasks?: Array<{ id: string } & Record<string, unknown>>;
  /**
   * Per-session patches on rows the sample install seeds. The seed folds each one into its session
   * before it derives anything, so the row, the Monitor row, the usage, and the clock all agree.
   * `status` is where the board reads a queued or paused card from (`SessionDisplayState`), and
   * `resuming` is the moment after a relaunch, when main has respawned the agent on its own
   * conversation and it has not printed yet: the card reads "Resuming agent..." until its first
   * output. All three are patches rather than dataset rows because adding one to the sample install
   * would change every docs figure already placed.
   */
  sessions?: Record<string, { activity?: 'thinking' | 'idle' | 'permission'; status?: 'running' | 'suspended' | 'queued'; resuming?: true }>;
  /** `window.__mock*` globals the mock reads (diff fixtures, monitor rows, branch summary, ...). */
  seeds?: Record<string, unknown>;
  /** Synthetic clicks dispatched after the board renders and before the frame is revealed. */
  steps?: DemoBootStep[];
  /**
   * Scene-only tasks to add, by id (DEMO_SCENE_TASKS in helpers/demo-dataset.ts), each with its
   * session. The seed adds them before it derives anything, as it folds a session patch. A row
   * rather than a dataset task for the reason the workflow seeds are: a new card would change every
   * figure already placed.
   */
  rows?: string[];
}

/**
 * A scene's fields beside its steps. `steps` is left to each reach below, which types it its own
 * way: a `state` scene has none, and a `boot` scene may carry boot steps.
 */
interface SceneBase extends Omit<DemoState, 'steps'> {
  name: string;
  /** One line for the maintainer: what the scene is for and why it is shaped this way. */
  description: string;
  /** One or two sentences for the reader of a docs figure: what the frame shows, in the order the
   *  eye meets it. Ships to the site through scenes.json; never describes what is not on screen. */
  alt: string;
  /** The selector that must exist before the frame is built. */
  ready: string;
  /** The element a host may crop the figure to; its rect rides the ready message as fractions. A
   *  selector list (`a, b`) names several, and the rect is the box around all of them. */
  focus?: string;
  /**
   * Elements the frame places on every animation frame (a selector list), for a scene whose
   * subject moves after `ready`: the Knowledge Graph's camera flies to the projects a scene picks,
   * and nothing in the DOM marks the end of the flight. The capture rig and the smoke tier shoot
   * only once one of them is shown (a non-zero opacity, which the map's labels get only from a
   * frame it actually drew) and none has moved for half a second (`waitForSettled` in
   * helpers/scene-page.ts). demo/boot.js does not read it: a live frame plays the flight, as the
   * desktop does, and a browser that cannot draw the map shows the app's own no-GPU card.
   */
  settle?: string;
  /** `empty` seeds no project at all: the welcome screen a first launch lands on. Default: the
   *  sample install. */
  install?: 'empty';
  /**
   * Pointer steps the frame plays by itself under loop=1, as a visitor would (demo/choreography.ts),
   * after the boot steps. Each cycle starts and ends on the poster's state: on the `pose` step when
   * there is one (a still plays up to it), otherwise where the boot steps left the frame. A cycle
   * that ends anywhere else is logged and stopped. Skipped under still=1 but for the pose.
   *
   * A cycle shows what a person does next on that screen. Looking around (selecting, opening and
   * closing, hovering) comes back to rest by itself. An edit that is the scene's point plays forward
   * and ends on a `cut`, and the steps after the cut put it back out of view, so a visitor never
   * watches a title typed and then deleted.
   */
  choreography?: ChoreographyStep[];
  /** What main does on a session's replay clock (SceneTimelineEvent). Live frames only. */
  timeline?: SceneTimelineEvent[];
  /**
   * Why the frame moves under loop=1 with neither of the above, such as a terminal replaying its
   * recording. tests/unit/scene-registry.test.ts requires every scene to say how it moves.
   */
  motion?: string;
}

export type SceneDefinition =
  | (SceneBase & { reach: 'state'; steps?: never })
  | (SceneBase & { reach: 'boot'; steps?: DemoBootStep[] });

/** Whether a choreography has a pose: the still plays up to it, so the frame takes input before it reveals. */
export function hasPose(choreography: ChoreographyStep[] | undefined): boolean {
  return (choreography ?? []).some((step) => 'pose' in step);
}

/** Whether a choreography plays a cycle under loop=1: it has steps after its pose, or no pose. One that ends on its pose holds it. */
export function playsCycle(choreography: ChoreographyStep[] | undefined): boolean {
  const steps = choreography ?? [];
  const poseIndex = steps.findIndex((step) => 'pose' in step);
  return steps.length > 0 && (poseIndex < 0 || poseIndex < steps.length - 1);
}

/**
 * A floating window's rect, centred like the window manager's default (`defaultWindowGeometry`
 * in window-manager/store/geometry.ts) but 0.64 of the frame wide where the default is 0.58: the
 * rect a window restores to from maximized or tiled, and the one the conversation viewer opens at.
 */
const MIDDLEWARE_FLOATING_GEOMETRY = { x: 0.18, y: 0.15, w: 0.64, h: 0.7 };

/**
 * A floating TERMINAL window's rect. Its width is only the fallback: the window also names its
 * session in `fitToRecording`, and the seed (demo-dataset.ts, fitLayoutBlob) sets `w` and `x` so
 * the window is exactly as wide as that session's recording at the visitor's own terminal cell.
 * No fixed fraction can be: xterm floors the cell to device pixels, so the 12px Consolas cell is
 * 6.0 CSS px at 100 percent and 6.5 at 200, and a machine without Consolas draws a 7.0 px cell.
 * A pane wider than the 154-column recording left an empty band on the right (a held grid never
 * scales up), and one narrower held it at a smaller type. Fitted, the terminal is at native type
 * and fills its pane on every display; at 100 percent the window comes out at about the window
 * manager's own 0.58. A floating terminal is the SUBJECT of its scene, which is why it gets this;
 * a terminal beside a panel (the Browser pane, the Changes panel) is context and stays narrow, see
 * the Browser scene below.
 *
 * The height carries about a row and a half of margin over the recording's 37 rows. At 125
 * percent a cell is 14.4 px against 14 at 100 and 200, and at the 0.7 height the window fitted
 * 36 rows there: a hold that the ROWS decide drops the font a quarter pixel, and the device-pixel
 * floor then takes the cell a whole pixel narrower, a band as wide as the one this exists to
 * remove. The spare rows sit below the grid as terminal background.
 */
const FITTED_FLOATING_GEOMETRY = { x: 0.18, y: 0.14, w: 0.64, h: 0.72 };

/** Where a restored task window sits, as fractions of the frame, and the session a floating one is fitted to. */
interface TaskWindowPlacement {
  geometry: { x: number; y: number; w: number; h: number };
  restoreGeometry: { x: number; y: number; w: number; h: number } | null;
  fitToRecording?: string;
}

/**
 * One task-detail window restored on cold boot, and focused. `maximized` takes the full frame and
 * ignores the window's own geometry, so the floating rect rides along as `restoreGeometry`:
 * un-maximizing lands exactly where a floating window would have opened, which is what
 * `maximizeWindow` itself stores.
 */
function taskWindowWorkspace(taskId: string, title: string, state: 'floating' | 'maximized', placement: TaskWindowPlacement) {
  return {
    version: 1,
    windows: [
      {
        taskId,
        kind: 'task-detail',
        title,
        ...placement,
        state,
      },
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: taskId,
  };
}

/** The maximized placement: the floating rect kept as `restoreGeometry`, as `maximizeWindow` keeps it. */
const MAXIMIZED_PLACEMENT: TaskWindowPlacement = { geometry: MIDDLEWARE_FLOATING_GEOMETRY, restoreGeometry: MIDDLEWARE_FLOATING_GEOMETRY };

/** The middleware task's window. A floating one is fitted to its session's recording (FITTED_FLOATING_GEOMETRY). */
function middlewareWindowWorkspace(state: 'floating' | 'maximized') {
  const placement = state === 'floating'
    ? { geometry: FITTED_FLOATING_GEOMETRY, restoreGeometry: null, fitToRecording: SESSION_MIDDLEWARE }
    : MAXIMIZED_PLACEMENT;
  return taskWindowWorkspace(TASK_MIDDLEWARE, 'Extract auth middleware', state, placement);
}

/**
 * The task-mcp scene's window: the scene-only Validate request bodies task, maximized, so its
 * session's terminal is most of the frame.
 */
function validateWindowWorkspace() {
  return taskWindowWorkspace(TASK_VALIDATE, 'Validate request bodies', 'maximized', MAXIMIZED_PLACEMENT);
}

const MCP_SCENE_AGENT_LIST = {
  // The context bar's version pill reads the agent list, so the scene reports the Claude Code its
  // recording ran on (the terminal's own header prints 2.1.302), where the sample install's other
  // Claude recordings were made on 2.1.270. The seed's map is replaced whole by a scene seed, so
  // every other agent is restated from it unchanged.
  ...DEMO_AGENT_OVERRIDES,
  claude: { ...DEMO_AGENT_OVERRIDES.claude, version: '2.1.302' },
};

/**
 * The terminal settings the task-mcp scene runs at: the demo's own (demo/boot.js) with a larger
 * font, the one scene that does not keep the terminal at native type (demo/README.md, One viewport,
 * one scale). The site shows that scene as the whole app at 56 percent for its MCP tools tab, where
 * native 12px type is under 7px and the tool names are the point. The font is sized so the
 * maximized pane fits FEWER columns than the 154-column recording at every display scale, and the
 * seed then holds the terminal at the largest type that carries the recording across the whole
 * pane (displayFor in demo-dataset.ts, conformToHeldGrid in useTerminal), well above HOLD_MIN_SCALE.
 */
const MCP_SCENE_TERMINAL = {
  shell: null,
  fontFamily: 'Consolas, "Courier New", monospace',
  // About 137 columns across the maximized pane at scale 1 (Consolas), 141 at 1.25 and 125 at 2 in
  // the posters' Liberation Mono: under 154 everywhere, so the hold always lands, at about 18.6px.
  // Checked in Courier New too, whose metrics Liberation Mono clones: the pane fills at 1, 1.25 and 2.
  fontSize: 21,
  showPreview: false,
  panelHeight: 280,
  panelCollapsed: false,
  cursorStyle: 'block',
  colors: {},
  backspaceSendsCtrlH: false,
};

/**
 * The footprint two task windows tile into: the floating window's height, and the width two
 * panes at the engine's 750px minimum need (`enforceMinPaneSize` in CommandTerminalLayer.tsx,
 * the floor a dock grows its target's footprint to). Docking one window onto another on the
 * desktop lands on this rect, so a tiled figure is what a visitor's own dock would produce. Each
 * pane is then the tiled width the matrix records at (manifest geometry `taskWindowTiled`), and
 * the rows stay the floating window's 37, so a tiled recording differs from the single only in
 * width. Both terminals are the SUBJECT of the figure, so both sessions carry a tiled recording.
 */
const TILED_PAIR_RECT = { x: 0.03, y: 0.15, w: 0.94, h: 0.7 };

/** The middleware and api-client windows tiled side by side, restored on cold boot. */
function tiledPairWorkspace() {
  const halfWidth = TILED_PAIR_RECT.w / 2;
  return {
    version: 1,
    windows: [
      {
        taskId: TASK_MIDDLEWARE,
        kind: 'task-detail',
        title: 'Extract auth middleware',
        geometry: { x: TILED_PAIR_RECT.x, y: TILED_PAIR_RECT.y, w: halfWidth, h: TILED_PAIR_RECT.h },
        restoreGeometry: MIDDLEWARE_FLOATING_GEOMETRY,
        state: 'tiled',
      },
      {
        taskId: TASK_API_CLIENT,
        kind: 'task-detail',
        title: 'Generate API client types',
        geometry: { x: TILED_PAIR_RECT.x + halfWidth, y: TILED_PAIR_RECT.y, w: halfWidth, h: TILED_PAIR_RECT.h },
        restoreGeometry: { ...MIDDLEWARE_FLOATING_GEOMETRY, x: MIDDLEWARE_FLOATING_GEOMETRY.x + 0.03, y: MIDDLEWARE_FLOATING_GEOMETRY.y + 0.03 },
        state: 'tiled',
      },
    ],
    tileTree: {
      kind: 'split',
      direction: 'horizontal',
      children: [{ kind: 'leaf', taskId: TASK_MIDDLEWARE }, { kind: 'leaf', taskId: TASK_API_CLIENT }],
      sizes: [0.5, 0.5],
    },
    tileTreeRect: TILED_PAIR_RECT,
    focusedTaskId: TASK_MIDDLEWARE,
  };
}

/**
 * The conversation viewer on the middleware session, restored as a conversation window
 * (anchored on the session id, which the workspace restore always treats as known) at the plain
 * floating rect, since the board around it is the point. It has no terminal to fit, so it is not
 * sized to a recording the way the task window is. The transcript
 * it shows is the one recorded beside the session (transcripts/contoso-web-claude-middleware.json,
 * main's own parser over the agent's history file), fetched when the viewer mounts.
 */
function conversationWindowWorkspace() {
  return {
    version: 1,
    windows: [
      {
        taskId: SESSION_MIDDLEWARE,
        kind: 'conversation',
        title: 'Conversation',
        geometry: MIDDLEWARE_FLOATING_GEOMETRY,
        restoreGeometry: null,
        state: 'floating',
      },
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: SESSION_MIDDLEWARE,
  };
}

/** The first Command Terminal slot; the window's durable anchor (CommandTerminalLayer.tsx). */
const COMMAND_TERMINAL_SLOT = 'slot-1';

/** The title bar's open/close toggle for the Command Terminal layer, and the windows it opens. */
const COMMAND_TERMINAL_TOGGLE = '[data-testid="quick-session-button"]';
const COMMAND_TERMINAL_WINDOW = '[data-testid="command-terminal-window"]';
const COMMAND_TERMINAL_SECOND = '[data-command-slot="slot-2"]';
const COMMAND_TERMINAL_SECOND_MODEL = `${COMMAND_TERMINAL_SECOND} [data-testid^="context-bar-model-"]`;

/**
 * The GLOBAL Command Terminal layout blob (`AppConfig.commandTerminalWorkspace`), one floating
 * window. The layer restores this on its first open and re-pairs the slot to the live session.
 * `fitted` sizes the window to the contoso terminal session's recording, for the same reason as
 * the task window (FITTED_FLOATING_GEOMETRY). The tiled scene takes the plain rect instead: New
 * terminal docks a second window beside this one and grows the pair to the dock's 750px pane
 * minimum, so its panes are that width whatever the first window's, and a fitted first window
 * would only move the footprint the tiled recordings were measured in.
 */
function commandTerminalWorkspace(fitted: boolean) {
  const placement = fitted
    ? { geometry: FITTED_FLOATING_GEOMETRY, fitToRecording: SESSION_CONTOSO_TERMINAL }
    : { geometry: MIDDLEWARE_FLOATING_GEOMETRY };
  return {
    version: 1,
    windows: [
      {
        taskId: COMMAND_TERMINAL_SLOT,
        kind: 'command-terminal' as const,
        title: commandTerminalTitle(COMMAND_TERMINAL_SLOT),
        ...placement,
        restoreGeometry: null,
        state: 'floating' as const,
      },
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: COMMAND_TERMINAL_SLOT,
  };
}

/** The Changes panel open on one scope with the middleware session's routes.ts selected. */
function middlewareChangesStateWith(extra: Record<string, unknown>) {
  return JSON.stringify({
    changesOpen: true,
    changesViewMode: 'split',
    changesSelectedFile: 'server/routes.ts',
    dividerRatio: 0.42,
    ...extra,
  });
}

// The contoso scaffold's real history, as scripts/capture-demo-history.mjs captured it (the seed
// serves the graph, the branch summary, the blame, and each commit's diff per worktree). The
// History scene selects the commit that wired the routes, the file the middleware session edits.
const CONTOSO_HISTORY_COMMITS = contosoHistory.commits;
const ROUTES_COMMIT = CONTOSO_HISTORY_COMMITS.find((commit) => commit.subject.startsWith('Wire the API routes'));
if (!ROUTES_COMMIT) throw new Error('tests/captures/fixtures/demo/history/contoso-web.json no longer carries the routes commit; re-run scripts/capture-demo-history.mjs');

/**
 * The contoso board as someone would configure it, shared by the four Column Manager scenes
 * (edit-columns, column-automation, column-automation-turn-end, column-handoff) so they describe
 * one board. Modelled on this
 * repo's own kangentic.json (Opus at xhigh plans in plan mode, Sonnet at high builds, an isolated
 * Code Review with an automation) plus the cross-agent step real teams take: Claude builds, Codex
 * reviews, because a second model family catches what the first missed.
 *
 * Handoff is on exactly where the agent changes: into Code Review (the reviewer knows what was
 * asked), into Testing (Claude gets the review back), and into Merge (Copilot, which ships GitHub's
 * own tools, gets the history for the pull request). Executing stays off: it is the same agent as
 * Planning, which resumes natively and ignores the setting. Codex carries no effort because it takes
 * none from Kangentic (its effort is config.toml only), so the effort ladder lives on the Claude
 * columns. Planning's plan mode is already the sample install's.
 *
 * Scene data, not the dataset: every other figure shows the board as the sample install leaves
 * it. Code Review's isolated session writes both fields the Session control writes, so the form
 * shows a pairing a user can make.
 */
const COLUMN_LADDER: Record<string, Record<string, unknown>> = {
  [demoLaneId(PROJECT_CONTOSO, 'planning')]: { model_override: DEMO_COLUMN_MODELS.opus, effort_override: 'xhigh' },
  [demoLaneId(PROJECT_CONTOSO, 'executing')]: { model_override: DEMO_COLUMN_MODELS.sonnet, effort_override: 'high', permission_mode: 'acceptEdits' },
  [demoLaneId(PROJECT_CONTOSO, 'review')]: {
    agent_override: 'codex',
    model_override: DEMO_COLUMN_MODELS.codex,
    handoff_context: true,
    session_target: 'isolated',
    session_spawn_strategy: 'always_spawn_new',
  },
  [demoLaneId(PROJECT_CONTOSO, 'testing')]: { model_override: DEMO_COLUMN_MODELS.sonnet, effort_override: 'high', permission_mode: 'acceptEdits', handoff_context: true },
  [demoLaneId(PROJECT_CONTOSO, 'merge')]: { agent_override: 'copilot', handoff_context: true },
};

/** Code Review's one automation: what the reviewer is asked to do the moment a task arrives. */
const REVIEW_PASS_AUTOMATION = {
  swimlane_id: demoLaneId(PROJECT_CONTOSO, 'review'),
  name: 'Ask for a review pass',
  type: 'send_message',
  trigger: 'enter',
  config: { message: 'Review the diff against main and fix anything you would block a pull request on.', mode: 'immediate' },
};

/**
 * The review loop, at Testing's turn end: two rows the runner reads in order, one of each
 * Condition kind. Codex reviews in Code Review and its adapter reports no turn end, so the desktop
 * blocks On agent turn end on that column (DEMO_AGENT_OVERRIDES carries the flag). The ladder hands
 * the review on to Claude in Testing, and that is where the loop can run. The first row is an
 * Agent evaluation: when the review found work, it sends the task back to Executing with Claude's
 * reply, and a move ends the group, so the second never runs. The second is a Text match, checked
 * in code with no agent call: it moves the task on to Merge when Claude's final message ends on
 * the line "PR: ready to merge", which is how this repo's own kangentic.json gates Testing. Snake
 * case `max_runs` and `final_line`, because the mock copies a seeded row's keys as they are.
 */
const TESTING_TURN_END_AUTOMATIONS = [
  {
    swimlane_id: demoLaneId(PROJECT_CONTOSO, 'testing'),
    name: 'Send findings back',
    type: 'move_to_column',
    trigger: 'turn_end',
    position: 0,
    condition: 'The review found work the implementer can do',
    max_runs: 3,
    config: {
      targetColumn: 'Executing',
      message: 'Code Review found work before this can merge. Fix it, then move the task on.\n\n{{agentReply}}',
    },
  },
  {
    swimlane_id: demoLaneId(PROJECT_CONTOSO, 'testing'),
    name: 'On to Merge',
    type: 'move_to_column',
    trigger: 'turn_end',
    position: 1,
    final_line: 'PR: ready to merge',
    max_runs: 1,
    config: { targetColumn: 'Merge' },
  },
];

/** The Edit automation dialog's controls column-automation-edit's choreography works. */
const AUTOMATION_KIND_TEXT = '[data-testid="edit-automation-condition-kind-text"]';
const AUTOMATION_KIND_AGENT = '[data-testid="edit-automation-condition-kind-agent"]';
const AUTOMATION_FINAL_LINE = '[data-testid="edit-automation-final-line"]';
const AUTOMATION_RUNS_DECREMENT = '[data-testid="edit-automation-max-runs-decrement"]';
const AUTOMATION_RUNS_INCREMENT = '[data-testid="edit-automation-max-runs-increment"]';

/**
 * The whole record of one archived contoso task, Set up CI/CD pipeline, shared by the two
 * completed-task scenes (helpers/demo-task-report.ts says which parts are its recorded run and
 * which are authored). A scene seed, never the dataset. The dataset holds what the recordings
 * hold, and this report is partly authored, so it stays with the two figures that show it.
 */
const COMPLETED_TASK_REPORTS = { [DEMO_COMPLETED_TASK_ID]: DEMO_COMPLETED_TASK_REPORT };

/**
 * Opening that task's view the way a user does: the Done column's Completed header, then View
 * details on its row, which opens the task's window and closes the dialog. Clicks, not a restored
 * window: workspace restore keeps a window only for a task on the board, and an archived one is not.
 * Then the window's maximize toggle, because the floating window cuts both tabs off after their
 * first card or two: Files changed on Summary, and Models and tokens and Background calls on Usage.
 */
const COMPLETED_TASK_STEPS: DemoBootStep[] = [
  { click: '[data-testid="expand-completed-btn"]', waitFor: '[data-testid="completed-tasks-dialog"]' },
  { click: `[data-testid="completed-task-row"][data-row-id="${DEMO_COMPLETED_TASK_ID}"] [data-testid="view-task-btn"]`, waitFor: '[data-testid="completed-task-view"]' },
  { click: '[data-testid="task-detail-maximize"]', waitFor: '[data-testid="task-detail-maximize"][aria-label="Restore dialog"]' },
];

/**
 * One running workflow on contoso-web, shared by the workflows and board-workflow scenes. A scene
 * seed, never the dataset: a workflow card draws its strip and step track on the BOARD, and the
 * view toggle draws a running mark, so seeding it into the sample install would change every
 * contoso figure already placed. Its members are cards the install already has, joined by a task
 * patch (the mock lists a started workflow's tasks by `workflow_id`): two done, two mid-route,
 * and two waiting in To Do, so the canvas shows both a met link and an open one.
 *
 * `started_at` stays unset: nothing in the view renders it, and a date written here would drift.
 * The agent's conversation id is the mock's to fill in when the pane first opens, as main
 * records it on every start.
 */
const WORKFLOW_HARDEN_API = 'wf-cw-harden-api';
/** The slot main gives a project's first workflow. Each scene seeds only one. */
const FIRST_WORKFLOW_COLOR_SLOT = 1;
const WORKFLOW_HARDEN_API_SEEDS = {
  __mockWorkflows: [{
    projectId: PROJECT_CONTOSO,
    workflow: {
      id: WORKFLOW_HARDEN_API,
      title: 'Harden the API',
      brief: 'Put auth and rate limits in front of every API route, then make the errors those layers return consistent.',
      state: 'running',
      draft: null,
      color_slot: FIRST_WORKFLOW_COLOR_SLOT,
      agent_name: 'claude',
    },
  }],
  __mockWorkflowLinks: [
    [TASK_SCHEMA, TASK_MIDDLEWARE],
    [TASK_LOGGING, TASK_RATE_LIMIT],
    [TASK_MIDDLEWARE, TASK_AUTH],
    [TASK_MIDDLEWARE, TASK_API_ERRORS],
    [TASK_RATE_LIMIT, TASK_API_ERRORS],
  ].map(([blocker, blocked]) => ({
    workflow_id: WORKFLOW_HARDEN_API,
    blocker_project_id: PROJECT_CONTOSO,
    blocker_task_id: blocker,
    blocked_task_id: blocked,
  })),
};
/**
 * A workflow planned but not started, for the workflow-draft scene: the plan its own agent wrote
 * and saved, before Start makes any of it a board task. It is the capture matrix's recording of
 * that agent planning the contoso backlog item (workflow-wf-cw-invoice-pdf.json, the manifest's
 * `workflowAgents`), and the draft is read from the plan the recording shows being saved
 * (workflow-plans/wf-cw-invoice-pdf.json, written by scripts/lib/demo-mcp-capture.mjs), never
 * written by hand, so the canvas and the agent pane beside it agree. Planned tasks live in the
 * draft, not on the board, so seeding it changes no other figure.
 */
export const WORKFLOW_INVOICE_PDF = 'wf-cw-invoice-pdf';

/** A plan the capture matrix read back from a recorded workflow agent (planFixtureOf). */
interface RecordedWorkflowPlan {
  title: string;
  brief: string | null;
  tasks: Array<{
    key: string;
    title: string;
    description: string;
    labels: string[];
    priority: number;
    routeStart: string | null;
    routeLast: string | null;
    skipped: string[];
    runSettings: Record<string, unknown>;
  }>;
  links: Array<{ blocker: string; blocked: string }>;
}

/** A contoso column's sample-install id, by the name a recorded plan gives it. */
function contosoLaneByName(name: string): string {
  const lane = DEMO_LANES_BY_PROJECT[PROJECT_CONTOSO].find((candidate) => candidate.name === name);
  if (!lane) throw new Error(`a recorded workflow plan names column "${name}", which contoso's board does not have`);
  return demoLaneId(PROJECT_CONTOSO, lane.slug);
}

/** The draft a recorded plan becomes on contoso's board: its columns by the install's ids. */
export function draftOfRecordedPlan(plan: RecordedWorkflowPlan): Record<string, unknown> {
  return {
    tasks: plan.tasks.map((task) => ({
      key: task.key,
      title: task.title,
      description: task.description,
      labels: task.labels,
      priority: task.priority,
      project_id: null,
      existing_task_id: null,
      route_start_swimlane_id: task.routeStart === null ? null : contosoLaneByName(task.routeStart),
      route_last_swimlane_id: task.routeLast === null ? null : contosoLaneByName(task.routeLast),
      skipped_swimlane_ids: task.skipped.map(contosoLaneByName),
      canvas_x: null,
      canvas_y: null,
      ...task.runSettings,
    })),
    links: plan.links.map((link) => ({ blocker: link.blocker, blocked: link.blocked })),
  };
}

const INVOICE_PDF_PLAN: RecordedWorkflowPlan = invoicePdfPlan;
/** The planned task the workflow-draft scene selects: the client half, which waits for the server half. */
export const PLANNED_BILLING_PAGE = 'billing-page';
const PLANNED_PDF_ROUTE = 'pdf-route';
/** The selected task's Planning stop in the inspector's route, the column the agent's reply offers to skip. */
const PLANNED_ROUTE_PLANNING = `[data-testid="workflow-route-switch-${contosoLaneByName('Planning')}"]`;
const WORKFLOW_INVOICE_DRAFT_SEEDS = {
  __mockWorkflows: [{
    projectId: PROJECT_CONTOSO,
    workflow: {
      id: WORKFLOW_INVOICE_PDF,
      title: INVOICE_PDF_PLAN.title,
      brief: INVOICE_PDF_PLAN.brief,
      state: 'draft',
      color_slot: FIRST_WORKFLOW_COLOR_SLOT,
      draft: draftOfRecordedPlan(INVOICE_PDF_PLAN),
      // Its own agent planned it (the recording), so the pane opens on that agent. A plan with
      // no agent recorded opens with nothing started, as one another session created does.
      agent_name: 'claude',
    },
  }],
};
/**
 * The Workflow agent setting the recording ran under, so the pane opens the agent rather than
 * asking for one: Claude, on the model the sample install's Claude columns plan with.
 */
const WORKFLOW_AGENT_CHOICE = { workflows: { agent: 'claude', model: DEMO_COLUMN_MODELS.opus, effort: null } };

/**
 * The member patches. Refactor API error handling starts at Executing, so its route skips Planning.
 * Extract auth middleware's route ends at Executing, where its agent is working: when its recorded
 * turn ends, the step is done and the route is finished, so the workflow moves it to Done, which
 * meets Add user auth flow's one link (the workflows scene's timeline).
 */
const WORKFLOW_HARDEN_API_MEMBERS = [TASK_SCHEMA, TASK_LOGGING, TASK_MIDDLEWARE, TASK_RATE_LIMIT, TASK_AUTH, TASK_API_ERRORS].map((id) => ({
  id,
  workflow_id: WORKFLOW_HARDEN_API,
  workflow_project_id: PROJECT_CONTOSO,
  route_start_swimlane_id: id === TASK_API_ERRORS ? demoLaneId(PROJECT_CONTOSO, 'executing') : null,
  route_last_swimlane_id: id === TASK_MIDDLEWARE ? demoLaneId(PROJECT_CONTOSO, 'executing') : null,
  skipped_swimlane_ids: [],
  canvas_x: null,
  canvas_y: null,
}));

/**
 * A workflow step needs someone to judge it: with no Automation agent a column is a human gate
 * (workflow-step.ts), and the sample install chooses none. The same seed column-automation-edit
 * uses for its Condition.
 */
const DEMO_AUTOMATION_AGENT = { automation: { agent: 'claude', model: DEMO_COLUMN_MODELS.sonnet, effort: null } };

/**
 * What Harden the API does when the middleware session's recorded turn ends: the step is done at
 * the route's last column, so the task moves to Done, and with its one blocker done the engine
 * starts Add user auth flow at its route's first column, Planning, which plays its recorded
 * plan-mode boot. loop=1 undoes both as the session starts over.
 */
const HARDEN_API_STEP_TIMELINE: SceneTimelineEvent[] = [
  { session: SESSION_MIDDLEWARE, at: 'end', do: { move: { task: TASK_MIDDLEWARE, to: demoLaneId(PROJECT_CONTOSO, 'done'), origin: 'workflow' } } },
  { session: SESSION_MIDDLEWARE, at: 'end', do: { move: { task: TASK_AUTH, to: demoLaneId(PROJECT_CONTOSO, 'planning'), origin: 'workflow' } } },
];

/**
 * How the workflows scene opens the canvas: the view, the agent pane collapsed, Board, then the
 * view again. The canvas fits its cards when a workflow opens and never on a resize, so only the
 * second open lays them out at the width the collapse gave back. The collapse is store state and
 * survives the round trip. Its workflow's agent has no recording, so the pane would be empty.
 */
const WORKFLOW_VIEW_ROUND_TRIP: DemoBootStep[] = [
  { click: '[data-testid="view-toggle-workflows"]', waitFor: '[data-testid="workflow-agent-pane-collapse"]' },
  { click: '[data-testid="workflow-agent-pane-collapse"]', waitFor: '[data-testid="workflow-agent-pane"][data-collapsed="true"]' },
  { click: '[data-testid="view-toggle-board"]', waitFor: '[data-swimlane-name="To Do"]' },
  { click: '[data-testid="view-toggle-workflows"]', waitFor: '[data-testid="workflow-inspector-title"]' },
];

/**
 * A `waitFor` for something gone, not just closing: a popover or a dialog stays mounted through its
 * exit animation, and pacing never covers the app's own timing (a test plays it eight times faster).
 */
const gone = (selector: string): string => `body:not(:has(${selector}))`;

const SETTINGS_PANEL = '[data-testid="settings-panel"]';

/** The Git tab's base branch field, and the nth branch its list offers (the mock's: main, develop, then three more). */
const BRANCH_PICKER = '[data-testid="branch-picker-input"]';
const branchOption = (position: number): string => `[data-testid="branch-picker-dropdown"] > div:nth-child(2) > button:nth-child(${position})`;
/** The list gone, not just closing: the popover stays mounted through its exit animation. */
const BRANCH_PICKER_CLOSED = gone('[data-testid="branch-picker-dropdown"]');
const mcpGroupToggle = (group: string): string => `[data-testid="mcp-tool-group-${group}-toggle"]`;

/**
 * Dictation switched on and nothing else changed. Nested config blocks replace the demo defaults
 * whole (boot.js merges config shallowly), so the whole block rides along with only `enabled`
 * flipped. With every other field at its default the Dictation tab reads what a user sees right
 * after turning it on: the Best preset, whose models the dataset's getInfo answer names
 * (DEMO_DICTATION_INFO in demo-dataset.ts).
 */
const DICTATION_ON = { ...DEFAULT_CONFIG.dictation, enabled: true };

/**
 * The app's own announcement feed (announcements.json at the repo root), not a line written for
 * the demo, in the shape main's parser hands the renderer: `links` is always an array, on the
 * announcement and on each section (the feed leaves it out where there are none). The
 * publication window is dropped from the copy the scene seeds: the frame must show the banner
 * on any day it is opened, and the feed's dates are the desktop's concern.
 */
const ANNOUNCEMENTS = announcementsFeed.announcements.map((announcement) => {
  const { publishedAt: _publishedAt, expiresAt: _expiresAt, ...timeless } = announcement as typeof announcement & { links?: unknown[] };
  return {
    ...timeless,
    links: timeless.links ?? [],
    sections: (timeless.sections ?? []).map((section) => ({ ...section, links: (section as { links?: unknown[] }).links ?? [] })),
  };
});
const ANNOUNCEMENT_HISTORY = ANNOUNCEMENTS.map((announcement) => ({ announcement, firstSeenAt: '2026-09-01T09:00:00.000Z', readAt: null }));

/**
 * One scene per settings tab, keyed by the tab id in src/renderer/components/settings/settings-tabs.ts
 * (the unit test pins the two lists to each other). `lastSettingsTab` is renderer store state, never
 * written to config, so every tab is two clicks: the gear, then the tab. `ready` is a row that tab
 * renders: a `setting-row-<registry id>` where the tab leads with a registry row, otherwise the
 * tab's own root marker.
 */
// The settings panel docks to the right of the frame rather than centring, so each alt opens with
// the tab and then reads the panel top to bottom. Every line below was checked against the
// rendered tab in both themes; a row that only shows once a switch is on (the Mobile tab's connection
// test) is left out rather than described. An entry may carry
// `config` to show its tab in use: Dictation is switched on, because off it greys out every row
// below the switch and reads as a feature that is not there.
/**
 * Steps every settings tab's choreography is built from, as data: a switch flipped to a state, a
 * segmented option picked, and the panel's project switcher taken to another project and back,
 * which is how a project tab shows the same rows for a second project. Each tab's cycle ends on the
 * values it found, so whatever a step writes, a later one writes back.
 */
/** A settings row by its registry id; a switch row is the switch itself. */
const settingRow = (id: string): string => `[data-testid="setting-row-${id}"]`;
/** A step after a cut plays at once behind the veil, so it carries no pacing. */
const switchSetting = (id: string, on: boolean, ms?: number): ChoreographyStep => ({ click: settingRow(id), waitFor: `${settingRow(id)}[aria-checked="${on}"]`, ms });
const pickSetting = (selector: string, ms?: number): ChoreographyStep => ({ click: selector, waitFor: `${selector}[aria-checked="true"]`, ms });
/** One option of a row's segmented control, by its label. */
const settingRadio = (rowId: string, label: string): string => `[data-testid="setting-row-${rowId}"] [role="radio"][aria-label="${label}"]`;
const WORKFLOW_PROMPT_VARIABLES = '[data-testid="workflow-agent-prompt-variable-trigger"]';
/** The switcher's options are the projects' folders. */
const projectPath = (projectId: string): string => DEMO_PROJECTS.find((project) => project.id === projectId)?.path ?? projectId;
const PROJECT_SWITCHER_ROUND_TRIP: ChoreographyStep[] = [
  { choose: { in: '[data-testid="settings-project-switcher"]', value: projectPath(PROJECT_PETCLINIC) }, ms: 2600 },
  { choose: { in: '[data-testid="settings-project-switcher"]', value: projectPath(PROJECT_CONTOSO) }, ms: 900 },
];

const SETTINGS_TABS_SCENES: Record<string, { ready: string; alt: string; config?: Record<string, unknown>; note?: string; choreography?: ChoreographyStep[] }> = {
  general: {
    ready: '[data-testid="setting-row-project.location"]',
    alt: 'Settings on the General tab: the project\'s folder on disk, with a control to move it.',
    choreography: PROJECT_SWITCHER_ROUND_TRIP,
  },
  // `ready` stays on the Theme row rather than the switch that now leads the tab: the grid is the
  // figure's subject, and both rows mount in the same commit. The first tile that is not the frame's
  // theme is picked, which re-themes the whole frame live, and then the tile the frame opened on
  // again. A host passes the theme, so the cycle names it by the player's rest mark, never by name.
  theme: {
    ready: '[data-testid="setting-row-theme"]',
    alt: 'Settings on the Theme tab: a Follow system appearance switch, then twelve theme tiles in Dark and Light groups, each painted in its own colors, with the current theme outlined.',
    choreography: [
      { click: '[data-testid^="theme-tile-"]:not([data-demo-rest])', waitFor: '[data-testid^="theme-tile-"][data-demo-rest][aria-checked="false"]', ms: 2800 },
      { click: '[data-testid^="theme-tile-"][data-demo-rest]', waitFor: '[data-testid^="theme-tile-"][data-demo-rest][aria-checked="true"]', ms: 1200 },
    ],
  },
  agent: {
    ready: '[data-testid="setting-row-project.defaultAgent"]',
    alt: 'Settings on the Agent tab: the project\'s default agent, its model and effort, the permission mode, and the path to the agent\'s CLI.',
    choreography: PROJECT_SWITCHER_ROUND_TRIP,
  },
  // Another base branch picked from the branch list, then auto-fetch switched off. Each one writes
  // the project's config as the desktop's does. Then the cut, and both written back behind it.
  git: {
    ready: '[data-testid="setting-row-git.worktreesEnabled"]',
    alt: 'Settings on the Git tab in three cards: Branches with the default base branch and auto-fetch, Worktrees with its switch, cleanup, node_modules linking, and files and a script for each new worktree, and Pull requests with auto-refresh and merge bypass.',
    choreography: [
      { click: BRANCH_PICKER, waitFor: branchOption(2), ms: 700 },
      { hover: branchOption(2), ms: 500 },
      { click: branchOption(2), waitFor: BRANCH_PICKER_CLOSED, ms: 1600 },
      switchSetting('git.autoFetch', false, 2200),
      { cut: true },
      { click: BRANCH_PICKER, waitFor: branchOption(1) },
      { click: branchOption(1), waitFor: BRANCH_PICKER_CLOSED },
      switchSetting('git.autoFetch', true),
    ],
  },
  // The Browser pane switched off, which takes its rows away. Then the cut, and on again behind it.
  browser: {
    ready: '[data-testid="setting-row-browser.enabled"]',
    alt: 'Settings on the Browser tab: the Browser pane toggle, the default URL a task opens, and a control to clear the browser\'s data.',
    choreography: [switchSetting('browser.enabled', false, 2600), { cut: true }, switchSetting('browser.enabled', true)],
  },
  // The Presets menu opened over its preset shortcuts and closed again without adding one.
  shortcuts: {
    ready: '[data-testid="add-shortcut"]',
    alt: 'Settings on the Shortcuts tab: the project\'s command shortcuts, none configured here, with Add shortcut and Presets controls.',
    choreography: [
      { click: '[data-testid="shortcut-presets"]', waitFor: '[data-testid="shortcut-presets-menu"]', ms: 900 },
      { hover: '[data-testid="shortcut-presets-menu"] button', ms: 1600 },
      { click: '[data-testid="shortcut-presets"]', waitFor: gone('[data-testid="shortcut-presets-menu"]'), ms: 1000 },
    ],
  },
  // Column width through Narrow and Wide, which redraws the board's columns beside the panel, and back.
  board: {
    ready: '[data-testid="setting-row-columnWidth"]',
    alt: 'Settings on the Board tab: column width, automatic board config sync, and switches for the terminal panel and the status bar.',
    choreography: [
      pickSetting(settingRadio('columnWidth', 'Narrow'), 1800),
      pickSetting(settingRadio('columnWidth', 'Wide'), 1800),
      pickSetting(settingRadio('columnWidth', 'Default'), 900),
    ],
  },
  // The context bar trimmed from the top down: Version, Cost and Tool calls switched off. The site's
  // Context bar panel crops to these switches, phone crop included, so every step of the story is
  // in its frame. Then the cut, and the three on again.
  task: {
    ready: '[data-testid="setting-row-cardDensity"]',
    alt: 'Settings on the Task tab: card density, card preview, ticket numbers, and a switch for each pill the context bar shows.',
    choreography: [
      switchSetting('contextBar.showVersion', false, 1200),
      switchSetting('contextBar.showCost', false, 1200),
      switchSetting('contextBar.showToolCalls', false, 2200),
      { cut: true },
      switchSetting('contextBar.showVersion', true),
      switchSetting('contextBar.showCost', true),
      switchSetting('contextBar.showToolCalls', true),
    ],
  },
  // The diff set to Inline, long lines wrapped, and files sorted by status. Then the cut, and the
  // three put back behind it.
  changes: {
    ready: '[data-testid="setting-row-diffViewMode"]',
    alt: 'Settings on the Changes tab: the diff layout, the default scope a Changes panel opens on, the whitespace, folding, wrapping, and narrow-pane options, and file sorting.',
    choreography: [
      pickSetting(settingRadio('diffViewMode', 'Inline'), 1400),
      switchSetting('diffWrapLines', true, 1200),
      pickSetting(settingRadio('diffFileSort', 'Status'), 2000),
      { cut: true },
      pickSetting(settingRadio('diffViewMode', 'Side by side')),
      switchSetting('diffWrapLines', false),
      pickSetting(settingRadio('diffFileSort', 'Name')),
    ],
  },
  // Cursor style through Underline and Bar, which every terminal in the panel below takes live, and back.
  terminal: {
    ready: '[data-testid="setting-row-terminal.shell"]',
    alt: 'Settings on the Terminal tab: the shell, the font size and family, the cursor style, backspace behavior, and the terminal colors.',
    choreography: [
      pickSetting(settingRadio('terminal.cursorStyle', 'Underline'), 1600),
      pickSetting(settingRadio('terminal.cursorStyle', 'Bar'), 1600),
      pickSetting(settingRadio('terminal.cursorStyle', 'Block'), 900),
    ],
  },
  behavior: {
    ready: '[data-testid="setting-row-agent.maxConcurrentSessions"]',
    alt: 'Settings on the Behavior tab: the concurrent session cap, what happens when it is reached, idle focus and timeout, auto-resume, and how windows dismiss and restore.',
    // A full queue set to reject, and windows set to stay open on a click outside. Then the cut,
    // and both put back behind it.
    choreography: [
      pickSetting(settingRadio('agent.queueOverflow', 'Reject'), 1400),
      pickSetting(settingRadio('windowLightDismiss', 'Off'), 2000),
      { cut: true },
      pickSetting(settingRadio('agent.queueOverflow', 'Queue')),
      pickSetting(settingRadio('windowLightDismiss', 'Focused')),
    ],
  },
  // The callout under Graphics acceleration only renders on an install Kangentic downgraded
  // itself, so the alt describes the two switches a normal install shows and not that line.
  // Animations switched off, then the cut, and on again behind it. Never Graphics acceleration,
  // which only takes effect on a restart.
  performance: {
    ready: '[data-testid="setting-row-graphicsAccelerationEnabled"]',
    alt: 'Settings on the Performance tab: switches for graphics acceleration and for animations.',
    choreography: [switchSetting('animationsEnabled', false, 2400), { cut: true }, switchSetting('animationsEnabled', true)],
  },
  // Rebind on the first hotkey, which opens its capture box asking for a key, and a click beside
  // it, which cancels as a click away does. No key is pressed, so no binding changes.
  hotkeys: {
    ready: '[data-testid="hotkeys-tab"]',
    alt: 'Settings on the Hotkeys tab: every keyboard shortcut with its current binding and a Rebind control, with a reset to defaults above the list.',
    choreography: [
      { click: '[data-testid="key-capture-input"]', waitFor: '[data-testid="key-capture-box"]', ms: 2800 },
      { click: { x: 0.72, y: 0.28 }, waitFor: gone('[data-testid="key-capture-box"]'), ms: 1000 },
    ],
  },
  notifications: {
    ready: '[data-testid="setting-row-notifications.onAgentIdle"]',
    alt: 'Settings on the Notifications tab: for each event, whether it raises a desktop notification, a toast, or both, and how toasts are delivered.',
    // An idle agent set to raise a toast only, and a finished plan a desktop notification only.
    // Then the cut, and both back to both.
    choreography: [
      pickSetting('[data-testid="notify-channel-onAgentIdle-toast"]', 1400),
      pickSetting('[data-testid="notify-channel-onPlanComplete-desktop"]', 2000),
      { cut: true },
      pickSetting('[data-testid="notify-channel-onAgentIdle-both"]'),
      pickSetting('[data-testid="notify-channel-onPlanComplete-both"]'),
    ],
  },
  // `ready` is the model list, which mounts only once getInfo has answered, so the frame is never
  // shot before its lines name their models.
  dictation: {
    ready: '[data-testid="dictation-model-lines"]',
    alt: 'Settings on the Dictation tab with voice dictation on: the push-to-talk key, release buffer, and auto-submit, then a Transcription card with English, the Best mode, the live and refinement models each with a check, and their licenses.',
    config: { dictation: DICTATION_ON },
    note: 'Dictation is switched on, with every other setting at its default, so the models are the ones the dataset\'s getInfo answer selects (DEMO_DICTATION_INFO).',
    // The mode through Balanced and Light and back to Best.
    choreography: [
      pickSetting('[data-testid="dictation-preset-balanced"]', 1600),
      pickSetting('[data-testid="dictation-preset-fast"]', 1600),
      pickSetting('[data-testid="dictation-preset-accurate"]', 900),
    ],
  },
  // The first message's Template variable menu opened over the variables it can insert, and closed.
  // No agent is chosen: the alt says so, and a choice could not be taken back to none.
  workflows: {
    ready: '[data-testid="setting-row-workflows.agent"]',
    alt: 'Settings on the Workflows tab: the Workflow agent card that plans each workflow, the agent\'s first message, and the Automation agent card that judges conditions and workflow steps and names tasks, with no agent chosen on either card yet.',
    choreography: [
      { click: WORKFLOW_PROMPT_VARIABLES, waitFor: `${WORKFLOW_PROMPT_VARIABLES}[aria-expanded="true"]`, ms: 2200 },
      { click: WORKFLOW_PROMPT_VARIABLES, waitFor: `${WORKFLOW_PROMPT_VARIABLES}[aria-expanded="false"]`, ms: 1000 },
    ],
  },
  // The sample install has the Knowledge Graph on, as its maps were built (DEMO_KNOWLEDGE_GRAPH_CONFIG),
  // so the card shows the rows a switched-on graph has. The Index counts are the derived status's.
  knowledgeGraph: {
    ready: '[data-testid="setting-row-knowledgeGraph.indexingEnabled"]',
    alt: `Settings on the Knowledge Graph tab, switched on: search quality, the downloaded local model, acceleration, and no Ask agent yet, then an Index card counting ${DEMO_KNOWLEDGE_GRAPH_STATUS.sources?.conversations.count} conversations, ${DEMO_KNOWLEDGE_GRAPH_STATUS.sources?.tasks.count} tasks and ${DEMO_KNOWLEDGE_GRAPH_STATUS.sources?.commits.count} commits, with summaries and source code waiting on an agent.`,
    // Model acceleration through GPU and CPU and back to Auto. Search quality stays: a different
    // model would mean a download and a rebuilt index, which no cycle could take back.
    choreography: [
      pickSetting('[data-testid="knowledge-graph-acceleration-gpu"]', 1500),
      pickSetting('[data-testid="knowledge-graph-acceleration-cpu"]', 1500),
      pickSetting('[data-testid="knowledge-graph-acceleration-auto"]', 900),
    ],
  },
  // The tool groups folded up one by one, which brings the closed Diagnostics group into view, and
  // that one opened and read. Then the cut, and the groups put back as the tab opened them. Their
  // open state is the tab's own.
  mcpServer: {
    ready: '[data-testid="setting-row-mcpServer.enabled"]',
    alt: 'Settings on the MCP Server tab: one card with the server switch and, inside it, a Documentation row and the available tools in collapsible groups by area: tasks, board, sessions, and more.',
    choreography: [
      { click: mcpGroupToggle('tasks'), waitFor: `${mcpGroupToggle('tasks')}[aria-expanded="false"]`, ms: 600 },
      { click: mcpGroupToggle('board'), waitFor: `${mcpGroupToggle('board')}[aria-expanded="false"]`, ms: 600 },
      { click: mcpGroupToggle('workflows'), waitFor: `${mcpGroupToggle('workflows')}[aria-expanded="false"]`, ms: 900 },
      { click: mcpGroupToggle('diagnostics'), waitFor: `${mcpGroupToggle('diagnostics')}[aria-expanded="true"]`, ms: 2600 },
      { cut: true },
      { click: mcpGroupToggle('diagnostics'), waitFor: `${mcpGroupToggle('diagnostics')}[aria-expanded="false"]` },
      { click: mcpGroupToggle('workflows'), waitFor: `${mcpGroupToggle('workflows')}[aria-expanded="true"]` },
      { click: mcpGroupToggle('board'), waitFor: `${mcpGroupToggle('board')}[aria-expanded="true"]` },
      { click: mcpGroupToggle('tasks'), waitFor: `${mcpGroupToggle('tasks')}[aria-expanded="true"]` },
    ],
  },
  // Navigation held to localhost and eval allowed. Then the cut, and both off again behind it.
  browserAutomation: {
    ready: '[data-testid="setting-row-browserAutomation.enabled"]',
    alt: 'Settings on the Agent Browser tab: one card with the browser automation switch and the actions agents get: interaction, navigation with a localhost restriction under it, and eval.',
    choreography: [
      switchSetting('browserAutomation.restrictNavigationToLocalhost', true, 1400),
      switchSetting('browserAutomation.allowEval', true, 2000),
      { cut: true },
      switchSetting('browserAutomation.allowEval', false),
      switchSetting('browserAutomation.restrictNavigationToLocalhost', false),
    ],
  },
  // The pointer over the two guides, each showing its hover. The bridge switch stays off: turning it
  // on starts a pairing a visitor cannot finish, and a guide opens a browser.
  mobile: {
    ready: '[data-testid="setting-row-mobileBridge.enabled"]',
    alt: 'Settings on the Mobile Devices tab: the Mobile bridge switch, off here, with links to how the relay works and how to install and pair.',
    choreography: [
      { hover: '[data-testid="mobile-relay-docs-link"]', ms: 1600 },
      { hover: '[data-testid="mobile-get-app-docs-link"]', ms: 1600 },
    ],
  },
  // The tab scrolled down to the contact line and back up to its first card.
  privacy: {
    ready: '[data-testid="privacy-contact-email"]',
    alt: 'Settings on the Privacy tab: what anonymous analytics are collected and what is not, how they work, and how to opt out.',
    // Back up is the tab's first list line: centring a line that near the top scrolls to the top.
    choreography: [
      { scroll: '[data-testid="privacy-contact-email"]', ms: 2400 },
      { scroll: '[data-testid="settings-content"] li', ms: 1200 },
    ],
  },
  // The activity debug overlay switched on, which draws it over the board and the panel, and closed
  // with the overlay's own close control, which turns the same setting off.
  developer: {
    ready: '[data-testid="developer-tab"]',
    alt: 'Settings on the Developer tab: the activity debug overlay, persistent console logs, crash reports, and IPC recording.',
    choreography: [
      switchSetting('developer.activityDebugOverlay', true, 2800),
      { click: '[data-testid="activity-debug-overlay"] button[data-overlay-button]', waitFor: `${settingRow('developer.activityDebugOverlay')}[aria-checked="false"]`, ms: 1000 },
    ],
  },
};

function settingsScenes(): Record<string, SceneDefinition> {
  const scenes: Record<string, SceneDefinition> = {};
  for (const [tab, entry] of Object.entries(SETTINGS_TABS_SCENES)) {
    const name = `settings-${tab}`;
    scenes[name] = {
      name,
      reach: 'boot',
      description: `The Settings dialog on the ${tab} tab, opened with the gear and the tab button.${entry.note ? ` ${entry.note}` : ''}`,
      alt: entry.alt,
      ...(entry.config ? { config: entry.config } : {}),
      ...(entry.choreography ? { choreography: entry.choreography } : {}),
      ready: entry.ready,
      focus: SETTINGS_PANEL,
      steps: [
        { click: '[data-testid="settings-button"]', waitFor: SETTINGS_PANEL },
        { click: `[data-testid="settings-tab-${tab}"]`, waitFor: entry.ready },
      ],
    };
  }
  return scenes;
}

/**
 * One Knowledge Graph scene per sample project, `knowledge-graph-<project name>`, beside
 * `knowledge-graph` for all three, so a figure can show the whole install or one project's map.
 * A single map frames close enough for each conversation's task title to show beside its point,
 * which the three-island frame is too far out for. The scope is renderer store state, so it is
 * clicks: the graph opens on the open project (contoso-web), and any other is scoped the way a
 * visitor would, ticking its row in the Projects picker and then unticking the open project's
 * (the picker never lets the scope go empty, so the order matters).
 */
function knowledgeGraphProjectScenes(): Record<string, SceneDefinition> {
  const scenes: Record<string, SceneDefinition> = {};
  const row = (projectId: string): string => `[data-testid="knowledge-graph-projects-row"][data-project-id="${projectId}"]`;
  const open: DemoBootStep = { click: '[data-testid="knowledge-graph-button"]', waitFor: '[data-testid="knowledge-graph-projects"]' };
  for (const project of DEMO_PROJECTS) {
    const graph = DEMO_KNOWLEDGE_GRAPH.projects[project.id];
    if (!graph) continue;
    const name = `knowledge-graph-${project.name}`;
    scenes[name] = {
      name,
      reach: 'boot',
      description: project.id === PROJECT_CONTOSO
        ? `The Knowledge Graph on ${project.name} alone, the open project, which is where a graph opens: one click on the title-bar button.`
        : `The Knowledge Graph on ${project.name} alone: the title-bar button, then the Projects picker, ${project.name}'s row, the open project's row to untick it, and the picker again to close its menu.`,
      alt: `The Knowledge Graph for ${project.name} alone: each conversation a point labelled with its task title, joined by links, the named regions over them, and the Filter, Regions and Display cards on the left.`,
      // That project's nodes alone drawn: the scope has landed on it.
      ready: `[data-testid="knowledge-graph-canvas"][data-drawn-count="${graph.projection.nodes.length}"]`,
      settle: '[data-testid="knowledge-graph-cluster-label"], [data-testid="knowledge-graph-node-title"]',
      focus: '[data-testid="knowledge-graph-page"]',
      choreography: KNOWLEDGE_GRAPH_ORBIT,
      steps: project.id === PROJECT_CONTOSO
        ? [open]
        : [
          open,
          { click: '[data-testid="knowledge-graph-projects"]', waitFor: row(project.id) },
          { click: row(project.id) },
          { click: row(PROJECT_CONTOSO) },
          { click: '[data-testid="knowledge-graph-projects"]' },
        ],
    };
  }
  return scenes;
}

// ---------------------------------------------------------------- choreography targets
// Selectors the choreographies below share. A removal is waited for with `gone(...)` (above).

const WELCOME_REFRESH = '[data-testid="welcome-refresh"]';
const WELCOME_SETUP_TOGGLE = '[data-testid="welcome-setup-toggle"]';
/** A board filter pill: a priority by its index (0 None, 1 Low, 2 Medium, 3 High, 4 Urgent), or a label. */
const priorityFilter = (index: number): string => `[data-testid="filter-priority"][data-priority="${index}"]`;
const labelFilter = (label: string): string => `[data-testid="filter-label"][data-label="${label}"]`;
const CONFIG_CHANGE_ALWAYS = '[data-testid="config-change-dialog"] input[type="checkbox"]';
const CONVERSATION_SEARCH = '[data-testid="conversation-search-input"]';
/** The Agent Monitor table's header for a column, by its key; the first group's table answers first. */
const monitorHeader = (key: string): string => `[data-testid="monitor-page"] th[data-column-key="${key}"]`;
const completedRow = (taskId: string): string => `[data-testid="completed-task-row"][data-row-id="${taskId}"]`;
const turnEndRowEdit = (name: string): string => `[data-testid="column-automation-group"][data-trigger="turn_end"] [data-testid="column-automation-row"][data-name="${name}"] [data-testid="column-automation-edit"]`;
const completedTab = (tab: 'summary' | 'usage' | 'description'): string => `[data-testid="completed-task-tabs-${tab}"]`;
/** An orbit around a Knowledge Graph and one over it, then Reset view, which flies the camera to the framing it opened on. */
const KNOWLEDGE_GRAPH_ORBIT: ChoreographyStep[] = [
  { drag: { from: { x: 0.6, y: 0.52 }, to: { x: 0.74, y: 0.47 } }, ms: 1400 },
  { drag: { from: { x: 0.74, y: 0.47 }, to: { x: 0.7, y: 0.36 } }, ms: 1400 },
  { click: '[data-testid="knowledge-graph-reset-view"]', ms: 2600 },
];
/** The Usage dashboard's period buttons in order: 1 Live, 2 Today, 3 This Week, 4 This Month, 5 All Time. */
const usagePeriod = (position: number): string => `[data-testid="stats-period-group"] [role="group"] > button:nth-child(${position})`;
const backlogCheckbox = (itemId: string): string => `[data-testid="backlog-task-row"][data-row-id="${itemId}"] [data-testid="backlog-task-checkbox"]`;
const PROMOTE_POPOVER = '[data-testid="promote-popover"]';
const SEARCH_INPUT = '[data-testid="search-palette-input"]';
const NEW_TASK_TITLE = '[data-testid="new-task-dialog"] input[placeholder="Task title"]';
const NEW_TASK_DESCRIPTION = '[data-testid="task-description"]';
const NEW_TASK_PRIORITY = '[data-testid="new-task-dialog"] [data-testid="task-priority"]';
const NEW_TASK_LABELS = '[data-testid="new-task-dialog"] [data-testid="task-labels"]';
const NEW_TASK_FEATURE_LABEL = '[data-testid="new-task-dialog"] [aria-label="Remove feature"]';
/** A Changes panel file row's select button (the row's first), and its Viewed toggle. */
const changesFile = (path: string): string => `[data-testid="changes-file-row"][data-path="${path}"] > button:first-child`;
const changesViewed = (path: string): string => `[data-testid="changes-viewed-toggle"][data-path="${path}"]`;
const changesScope = (scope: 'working' | 'staged' | 'branch'): string => `[data-testid="changes-scope-${scope}"]`;
/** A commit in the Changes panel's History, by its place in the list: 1 is the newest. */
const commitRow = (position: number): string => `[data-testid="commit-graph-row"]:nth-of-type(${position})`;
const BOARD_MANAGER = '[data-testid="board-manager-dialog"]';
const BOARD_MANAGER_CLEAN = '[data-testid="board-manager-save"]:disabled';
const columnTab = (name: string): string => `[data-testid="board-manager-tab"][data-tab-name="${name}"]`;
/** A column's grip in the Column Manager's rail, the element just before its tab. */
const columnGrip = (name: string): string => `[role="tablist"][aria-orientation="vertical"] [data-drag-handle]:has(+ [data-tab-name="${name}"])`;
/** The column page's handoff switch; the All columns table draws the same switch read-only. */
const HANDOFF_SWITCH = `${BOARD_MANAGER} button[role="switch"][aria-label="Hand off context when the agent changes"]:not([aria-readonly])`;
const overviewRow = (lane: string): string => `[data-testid="board-manager-overview-row"][data-row-id="${demoLaneId(PROJECT_CONTOSO, lane)}"]`;
const ALL_COLUMNS_CLEAN = `${BOARD_MANAGER}:has([data-testid="board-manager-tab-all"][aria-selected="true"]):has(${BOARD_MANAGER_CLEAN})`;
const automationPickerType = (type: string): string => `[data-testid="column-automation-picker-type"][data-type="${type}"]`;
const DICTATION_FIELD_LISTENING = '[data-testid="dictation-live-chip"][data-placement="below"] [data-testid="dictation-recording-dot"][data-tone="active"]';
const WORKFLOW_AUTH_CARD = `[data-testid="workflow-canvas-card"][data-workflow-task-key="${TASK_AUTH}"]`;
const AUTH_CARD = `[data-task-id="${TASK_AUTH}"]`;
const TASK_TITLEBAR = '[data-testid="task-detail-titlebar"]';
/**
 * Points on the board at the 1600 by 1000 frame, where no element marks the spot: the top of To Do
 * (above the middle of its first card, so a dropped card goes in first), and empty space at the foot
 * of Code Review, which holds one card.
 */
const TODO_TOP_SLOT = { x: 0.2775, y: 0.17 };
/** A planned card on the draft canvas, and its outgoing handle on the right edge (React Flow's own attributes). */
const draftCard = (key: string): string => `[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`;
const EMPTY_BOARD = { x: 0.8475, y: 0.6 };
/** The Agent Monitor's Group control in order: 1 Project, 2 Status. An icon may lead the group, so by type. */
const monitorGroup = (position: number): string => `[role="group"][aria-label="Group sessions by"] > button:nth-of-type(${position})`;
const MONITOR_FILTER = '[data-testid="monitor-text-filter"]';

export const SCENES: Record<string, SceneDefinition> = {
  // ---------------------------------------------------------------- first launch
  welcome: {
    name: 'welcome',
    reach: 'state',
    install: 'empty',
    description: 'The welcome screen a first launch lands on, with no project yet. Nothing from the sample install is seeded; the detection line reads the same agent list the sample install reports.',
    alt: 'The welcome screen on first launch: the Kangentic mark, an Open a project button, a line reporting the git and agent CLIs it found with a Show setup control, and three notes on what opening a project does.',
    ready: '[data-testid="welcome-open-project"]',
    // Show setup, Refresh (every row reads Checking for the app's own 800 ms), and Hide setup.
    choreography: [
      { click: WELCOME_SETUP_TOGGLE, waitFor: `${WELCOME_SETUP_TOGGLE}[aria-expanded="true"]`, ms: 900 },
      { click: WELCOME_REFRESH, waitFor: `${WELCOME_REFRESH}:disabled`, ms: 0 },
      { hover: WELCOME_REFRESH, waitFor: `${WELCOME_REFRESH}:not(:disabled)`, ms: 2000 },
      { click: WELCOME_SETUP_TOGGLE, waitFor: `${WELCOME_SETUP_TOGGLE}[aria-expanded="false"]`, ms: 900 },
    ],
  },
  'welcome-setup': {
    name: 'welcome-setup',
    reach: 'state',
    description: 'The welcome screen with the setup list open on a not-installed row and a not-signed-in one, for the Installation and Troubleshooting pages. The default welcome scene reports everything found, so the rows those pages describe never appear there. No click: the screen opens the list itself when anything is missing or signed out, which is exactly the state seeded here.',
    alt: 'The welcome screen with its setup list open: a prompt to sign in to OpenCode, OpenCode on top marked Not signed in with its login command to copy, git and three agents found with versions, and three more marked Not installed beside an Install link.',
    install: 'empty',
    // Replaces the dataset's own overrides whole (boot.js assigns a scene's seeds after the seed
    // script has set them), so this map is the entire agent report, not a patch on it.
    //
    // Only an agent whose adapter defines probeAuth can read Not signed in (listAgents in
    // src/main/agent/agent-list.ts): grok, kimi, and opencode. OpenCode is the one the sample
    // install already records at a version. Gemini stays found so the three Not installed rows
    // are the ones this scene has always shown; RECOMMENDED_AGENT_ORDER would rank a missing
    // Gemini first among them.
    seeds: {
      __mockAgentListOverrides: {
        claude: { version: '2.1.270' },
        codex: { found: true, path: '/usr/local/bin/codex', version: '0.141.0' },
        gemini: { found: true, path: '/usr/local/bin/gemini', version: '0.58.0' },
        opencode: { found: true, path: '/usr/local/bin/opencode', version: '1.18.30', authenticated: false },
      },
    },
    ready: '#welcome-setup-panel',
    focus: '#welcome-setup-panel',
    // Refresh, the one control that puts every row through its real check: each reads Checking for
    // the app's own 800 ms and resolves to the same report, since the install it reads is fixed.
    choreography: [
      { click: WELCOME_REFRESH, waitFor: `${WELCOME_REFRESH}:disabled`, ms: 0 },
      { hover: WELCOME_REFRESH, waitFor: `${WELCOME_REFRESH}:not(:disabled)`, ms: 2600 },
    ],
  },

  // ---------------------------------------------------------------- the board
  board: {
    name: 'board',
    reach: 'boot',
    description: 'The contoso-web board with agents running across Planning, Executing, Code Review, and Testing, the bottom panel on the working auth-middleware session.',
    alt: 'The Kangentic board for contoso-web: columns from To Do to Testing, each card showing its agent, latest message, and context use, three projects in the sidebar, and the terminal panel along the bottom on the working auth-middleware agent.',
    // The panel picks its own first tab, and the app prefers whatever needs a human
    // (derivePanelSessionId), which lands on the WebSocket session sitting at a prompt. That is
    // right for a desktop a user is returning to, and wrong for a frame someone is meeting the
    // product through: the panel is the largest thing on the page and it should show an agent
    // mid-turn. One click, the same one a visitor could make.
    ready: '[data-session-id="sess-cw-middleware"]',
    steps: [{ click: '[data-session-id="sess-cw-middleware"]', waitFor: '[data-session-id="sess-cw-middleware"]' }],
    motion: 'The panel streams the middleware session, and Generate API client types flips from working to needs-you about 25 s into each cycle (its 25 s tail).',
  },
  'board-filter': {
    name: 'board-filter',
    reach: 'boot',
    description: 'The board with its Filter popover open, for the board search section of the agent orchestration page.',
    alt: 'The board\'s Filter popover open: priority and label toggles that narrow which cards the columns show.',
    ready: '[data-testid="board-filter-btn-popover"]',
    focus: '[data-testid="board-filter-btn-popover"]',
    steps: [{ click: '[data-testid="board-filter-btn"]', waitFor: '[data-testid="board-filter-btn-popover"]' }],
    // High priority, then the feature label, each narrowing the board behind the popover. Then the
    // cut, and both switched off behind it. Filters are the board's view state; the cycle ends on
    // every card shown.
    choreography: [
      { click: priorityFilter(3), waitFor: `${priorityFilter(3)}[aria-pressed="true"]`, ms: 1800 },
      { click: labelFilter('feature'), waitFor: `${labelFilter('feature')}[aria-pressed="true"]`, ms: 2600 },
      { cut: true },
      { click: labelFilter('feature'), waitFor: `${labelFilter('feature')}[aria-pressed="false"]` },
      { click: priorityFilter(3), waitFor: `${priorityFilter(3)}[aria-pressed="false"]` },
    ],
  },
  'activity-tab': {
    name: 'activity-tab',
    reach: 'boot',
    description: 'The bottom panel on its Activity tab, the structured event list every running session feeds.',
    alt: 'The terminal panel on its Activity tab: a timeline of tool calls across every running session, each line stamped with its time, its session, and the tool, with a filter above it.',
    ready: '[data-testid="activity-filter"]',
    steps: [{ click: '[data-testid="terminal-activity-tab"]', waitFor: '[data-testid="activity-filter"]' }],
    // The list narrowed to one session's events, to another's, and back to All with the filter
    // above it. The events themselves are seeded once: the recordings carry no tool events to put
    // on their clocks, and the transcripts that would are not committed (demo/README.md).
    choreography: [
      { choose: { in: '[data-testid="activity-filter"]', value: SESSION_MIDDLEWARE }, waitFor: `[data-testid="activity-filter"] option[value="${SESSION_MIDDLEWARE}"]:checked`, ms: 2800 },
      { choose: { in: '[data-testid="activity-filter"]', value: SESSION_API_CLIENT }, waitFor: `[data-testid="activity-filter"] option[value="${SESSION_API_CLIENT}"]:checked`, ms: 2400 },
      { choose: { in: '[data-testid="activity-filter"]', value: '' }, waitFor: '[data-testid="activity-filter"] option[value=""]:checked', ms: 900 },
    ],
  },
  'session-states': {
    name: 'session-states',
    reach: 'boot',
    description: 'The contoso-web board with a paused card in Planning and a queued one in Code Review, for the Session Persistence page. The sample install has neither: its one suspended session is in online-boutique and nothing is queued. Both are session patches, not dataset rows, so every other figure is unchanged, and the seed folds them in before it builds the Monitor, which shows the two stopped as the board does.',
    alt: 'The contoso-web board with two agents stopped: the Onboarding empty states card in Planning reads Paused, the Add rate limiting card in Code Review reads Queued, and the status bar counts six agents with one of them queued.',
    // Both columns are in frame at 1600px. Merge is not, which is why the paused card is not the
    // Vite 8 task: its card passed every check and sat off the right edge of the figure.
    //
    // Neither session has a clock either: the seed arms one only for an `activity` of thinking,
    // and these two are permission and idle, so flipping their status starts no timer.
    sessions: {
      [SESSION_EMPTY_STATES]: { status: 'suspended' },
      [SESSION_RATE_LIMIT]: { status: 'queued' },
    },
    ready: '[data-task-id="task-cw-empty-states"]',
    steps: [{ click: '[data-session-id="sess-cw-middleware"]', waitFor: '[data-session-id="sess-cw-middleware"]' }],
    // No pause-and-start cycle: the card carries no pause control, the sample install's cap leaves a
    // free slot so nothing would start from the queue, and a resume mints a new session.
    motion: 'The bottom panel streams the middleware session and Generate API client types flips to needs-you about 25 s in, while the paused and queued cards hold, as a paused and a queued agent do.',
  },
  'session-resume': {
    name: 'session-resume',
    reach: 'boot',
    description: 'The contoso-web board just after a relaunch, for the Session Persistence panel: the WebSocket agent in Planning is resuming on its own conversation while the card below it stays Paused, as a session paused on purpose does. The resume is a session patch the seed folds in (no usage until first output), so the card draws the same Resuming agent... footer the desktop does. A still holds that moment; the live frame resolves it about 1.5 seconds after page open, the way a Resume click does, so a figure of this scene is the still or its poster, never a live frame.',
    alt: 'The contoso-web board in Planning: the Fix WebSocket reconnection card shows its agent\'s last message and reads Resuming agent..., the Onboarding empty states card below it reads Paused, and the agents in Executing are working.',
    // A resumed agent starts idle and waiting for the user (resume-suspended.ts marks the spawn
    // resuming so the engine seeds idle), and it keeps its trail: the tracker reads the previous
    // run's messages at once. The paused card is the one session-states pauses, directly below.
    sessions: {
      [SESSION_WEBSOCKET]: { resuming: true, activity: 'idle' },
      [SESSION_EMPTY_STATES]: { status: 'suspended' },
    },
    ready: `[data-task-id="${TASK_WEBSOCKET}"] [data-testid="usage-bar"]`,
    focus: `[data-task-id="${TASK_WEBSOCKET}"], [data-task-id="task-cw-empty-states"]`,
    steps: [{ click: '[data-session-id="sess-cw-middleware"]', waitFor: '[data-session-id="sess-cw-middleware"]' }],
    // No pause-and-resume cycle: the card has no pause control (the task window does), and a demo
    // resume starts a session under a new id, so a cycle could not come back to this one.
    motion: 'The bottom panel streams the middleware session, and the WebSocket card resolves its resume about 1.5 s after the frame opens, once.',
  },
  'activity-overlay': {
    name: 'activity-overlay',
    reach: 'state',
    description: 'The board with the activity-engine debug overlay switched on over the working sessions, for the Activity Detection page, which explains the classifier with a diagram alone today. The snapshot it draws is derived from each session\'s own seeded events; see activityStatsFor in demo-dataset.ts.',
    alt: 'The Activity Engine Debugger open over the board: a panel per session naming its state, how long since its last signal, its pending tools, subagents and background shells, whether a turn is active, a log of recent transitions, and a timeline.',
    // `developer` is an OPTIONAL AppConfig block with no DEFAULT_CONFIG entry, so it is supplied
    // whole here; boot.js assigns a scene's config with a shallow Object.assign.
    config: { developer: { activityDebugOverlay: true } },
    ready: '[data-testid="activity-debug-overlay"]',
    focus: '[data-testid="activity-debug-overlay"]',
    motion: 'The overlay polls every 2 s, and each snapshot is taken when it is asked, so a panel\'s time since its last signal counts up; when a session\'s recording ends its panel turns idle and logs the event:idle step (Generate API client types about 25 s in), and loop=1 logs event:prompt as it starts again.',
  },
  'notification-toast': {
    name: 'notification-toast',
    reach: 'state',
    description: 'An in-app toast over the board, for the Notifications page, which can otherwise show only the announcement banner because an OS notification cannot appear in a browser. This is the session-ended toast, which the app raises off the exit push seeded below. The idle toast the Notifications tab also offers is edge-triggered off an activity TRANSITION, and a scene can seed only a static activity value into the mock cache, so there is still no push here for it to fire on.',
    alt: 'The board with an in-app toast in its bottom right corner, reporting that the session for Integration test coverage ended with exit code 0, and carrying a control to dismiss it.',
    // The app raises this itself off the exit push, gated on notifications.toasts.onAgentCrash;
    // the scene seeds the push, never the toast store.
    seeds: { __mockInitialExit: { sessionId: SESSION_INTEGRATION, exitCode: 0, projectId: PROJECT_CONTOSO } },
    // `notifications` is nested, and boot.js assigns a scene's config with a shallow
    // Object.assign, so the block replaces the default WHOLE. Every field here is
    // DEFAULT_CONFIG.notifications verbatim except `durationSeconds`, which is the one thing the
    // scene is changing: a toast the frame is read after would otherwise be gone. 30 is the
    // maximum the Notifications tab's own input accepts (min 1, max 30), so this is a value a
    // visitor could set, not one only a scene can reach.
    config: {
      notifications: {
        desktop: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true },
        toasts: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true, durationSeconds: 30, maxCount: 5 },
        cooldownSeconds: 10,
      },
    },
    ready: '[data-testid="toast"]',
    focus: '[data-testid="toast"]',
    // No dismiss-and-raise cycle: raising the toast again would take an exit push main never sends
    // twice. The toasts that come later are the sample install's own.
    motion: 'The toast counts its 30 s down and closes, and the board\'s sessions raise their own toasts as each finishes its turn on its recording\'s clock, Generate API client types about 25 s in and again every cycle under loop=1.',
  },
  'board-config-change': {
    name: 'board-config-change',
    reach: 'state',
    description: 'The board config reconciliation dialog, raised the way the desktop raises it: the seeded kangentic.json watch push, which App.tsx turns into a pending config change. Nothing in the demo draws the dialog itself.',
    alt: 'A dialog over the board headed Board configuration changed: it reports changes detected in kangentic.json and asks whether to apply the updated board configuration, with a checkbox to always apply automatically and Dismiss and Apply buttons.',
    seeds: { __mockBoardConfigChanged: PROJECT_CONTOSO },
    ready: '[data-testid="config-change-dialog"]',
    focus: '[data-testid="config-change-dialog"]',
    // The always-apply box ticked, which writes nothing until Apply or Dismiss, and neither is
    // pressed. Then the cut, and the box unticked behind it. Raising the dialog again would take a
    // file change that never happened.
    choreography: [
      { click: CONFIG_CHANGE_ALWAYS, waitFor: `${CONFIG_CHANGE_ALWAYS}:checked`, ms: 2600 },
      { cut: true },
      { click: CONFIG_CHANGE_ALWAYS, waitFor: `${CONFIG_CHANGE_ALWAYS}:not(:checked)` },
    ],
  },
  announcements: {
    name: 'announcements',
    reach: 'state',
    description: 'The board with the app\'s own announcement feed active: the banner strip across the top of the content column and the unread badge on the title bar\'s megaphone. OS notifications cannot show in a browser; this is the in-app half of the notifications page.',
    alt: 'The board with an announcement banner across the top of the content area, a Learn more link and a dismiss control on it, and the megaphone in the title bar carrying an unread badge.',
    seeds: { __mockActiveAnnouncements: ANNOUNCEMENTS, __mockAnnouncementHistory: ANNOUNCEMENT_HISTORY },
    ready: '[data-testid="announcement-banner"]',
    focus: '[data-testid="announcement-banner"]',
    // The pointer over Learn more, the banner's dismiss control, and the megaphone, each showing its
    // own hover and tip. Nothing is pressed: dismissing the banner and opening the feed both mark
    // the announcement read, which no cycle could take back.
    choreography: [
      { hover: '[data-testid="announcement-learn-more"]', ms: 1600 },
      { hover: '[data-testid="announcement-dismiss"]', ms: 1600 },
      { hover: '[data-testid="announcements-button"]', ms: 1800 },
    ],
  },
  'announcement-dialog': {
    name: 'announcement-dialog',
    reach: 'boot',
    description: 'The announcement\'s Learn more dialog, sections and QR-coded links included, opened from the banner.',
    alt: 'An announcement dialog over the board: an intro, titled sections for each platform, and QR codes beside the links meant to be opened on a phone.',
    seeds: { __mockActiveAnnouncements: ANNOUNCEMENTS, __mockAnnouncementHistory: ANNOUNCEMENT_HISTORY },
    ready: '[data-testid="announcement-dialog-content"]',
    focus: '[data-testid="announcement-dialog-content"]',
    steps: [{ click: '[data-testid="announcement-learn-more"]', waitFor: '[data-testid="announcement-dialog-content"]' }],
    // The dialog fits its frame, so there is nothing to scroll: the pointer goes over the store
    // links and the QR code, each with its hover. A link is never pressed, since it opens a browser.
    choreography: [
      { hover: '[data-testid="announcement-link"]', ms: 1400 },
      { hover: '[data-testid="announcement-qr"]', ms: 1600 },
      { hover: '[data-testid="announcement-dialog-content"] > :last-child [data-testid="announcement-link"]', ms: 1400 },
    ],
  },

  // ---------------------------------------------------------------- the task window
  task: {
    name: 'task',
    reach: 'state',
    description: 'A task-detail window open on "Extract auth middleware", its agent working in the terminal.',
    alt: 'A task window floating over the board. Claude Code is extracting the auth middleware in the terminal, and the context bar under it reports the model, the context window used, and the cost so far.',
    // Floating on purpose: the board around it is the point, so the scene names no focus to crop
    // to. The window is fitted to the session's recording (FITTED_FLOATING_GEOMETRY), so the
    // terminal is at native type and fills its pane.
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') } },
    ready: '[data-testid="task-title-text"]',
    motion: 'The terminal replays its working session\'s recording.',
  },
  'windows-tiled': {
    name: 'windows-tiled',
    reach: 'state',
    description: 'The middleware and api-client task windows tiled side by side in the footprint a dock produces (TILED_PAIR_RECT). Both sessions carry a recording made at the tiled width (manifest geometry taskWindowTiled), so both terminals are at native type; the single recording would be held at two-thirds. The api-client session opens 25 s before its single recording ends (the board scene flips it), which is after its 112 s tiled run ended at a permission prompt, so the right window paints that run\'s last frame while the card reads working until the single recording ends.',
    alt: 'Two task windows tiled side by side over the board: Claude Code working on Extract auth middleware on the left, and on the right asking to run a PowerShell typecheck for Generate API client types, each with a context bar of model, context use, and cost.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: tiledPairWorkspace() } },
    ready: '[data-testid^="tile-splitter-"]',
    motion: 'Both terminals replay their working sessions\' tiled recordings.',
  },
  // The Browser and Changes scenes below keep a narrow terminal on purpose. There the PANEL is the
  // subject and the terminal beside it is context, and giving the terminal the width its native
  // type needs squeezes the subject instead (the address bar and the note field truncate, a split
  // diff clips mid-line). A pane that narrow is shown better by the tiled recording (the seed's
  // layoutFor): about 110 to 118 columns against its 115, so at the configured type where the pane
  // is at least 113 columns and at about 0.85 of it where it is narrower, rather than the single
  // at 0.67. Either way it fills the tall pane with the rows above the recording's screen. The
  // seed's floor (HOLD_MIN_SCALE in demo-dataset.ts) is what keeps that context legible: below 0.6
  // the terminal would keep the configured type, which in a narrow pane cuts every row at the edge.
  browser: {
    name: 'browser',
    reach: 'state',
    description: 'The task window with the Browser pane open on the project\'s dev URL. The pane is the real renderer; its guest is demo/webview-shim.js\'s iframe onto a bundled page with the scaffold app\'s own data and an authored presentation (demo/README.md, Browser guest), since no browser has Electron\'s webview. The terminal beside it shows the session\'s tiled recording, filling the narrow pane (the comment above).',
    alt: 'A task window with the Browser pane open beside the agent\'s terminal: an address bar on the project\'s local dev server, the page it serves loaded beneath, zoom and Close browser controls above, and Draw, Inspect, and a note field for the agent below.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: JSON.stringify({ browserOpen: true, dividerRatio: 0.45 }) }],
    ready: '[data-testid="browser-webview"] iframe',
    // A note for the agent typed into the pane's own field and the pointer on Send. Then the cut,
    // the note taken back behind it, and a click on the page that leaves the field. Never sent:
    // Send and Enter are the two things that would. The guest page itself has nothing to type into
    // and may not animate (demo/README.md, Browser guest).
    choreography: [
      { type: { into: '[data-testid="browser-note-input"]', text: 'Ask for a confirmation before Cancel subscription' }, ms: 900 },
      { hover: '[data-testid="browser-send"]', ms: 1600 },
      { cut: true },
      { type: { into: '[data-testid="browser-note-input"]', text: '' } },
      { click: '[data-testid="browser-webview"] iframe' },
    ],
  },
  // An agent calling Kangentic's own MCP tools, for the landing page's MCP tools tab. The task is a
  // scene-only row (DEMO_SCENE_TASKS), since a new contoso card would change every figure already
  // placed, and its recording was made against a preview seeded with this board
  // (scripts/lib/demo-mcp-capture.mjs), so every number and column the calls print is this frame's.
  // The session opens once its first three calls have printed their results (its liveTailMs,
  // demo-dataset.ts), which is what a still paints, and the live frame plays the column check and
  // the move from there. The recording was cut where the move's result landed (the manifest's
  // stopWhen), so its end IS the move, and the timeline moves the card then, as main does.
  'task-mcp': {
    name: 'task-mcp',
    reach: 'state',
    description: 'A maximized task window whose Claude Code session reviews its branch and moves its own card on through Kangentic\'s MCP tools, for the landing page\'s MCP tools tab. The task and session are scene-only rows (rows), and the recording ran against a preview seeded with this board, so the ticket number, the column counts and the column settings the calls print are this frame\'s. A still paints the moment kangentic_get_current_task, kangentic_list_columns and kangentic_list_automations have printed their results; live, the agent then reads Testing with kangentic_get_column_detail and moves the card with kangentic_move_task, about eleven seconds. When the move\'s result lands, the timeline moves the card to Testing through the push main sends for an agent\'s move, so the window\'s header and the board say Testing, and loop=1 puts it back in Code Review as the stretch starts over. The terminal is the one scene above native type: the site shows it at 56 percent, where native type is under 7px, so the scene raises the font and the seed holds the 154-column recording across the whole pane.',
    alt: 'A task window filled by its Claude Code session reviewing its branch with Kangentic\'s MCP tools: kangentic_get_current_task finds its card, #68 in Code Review, then kangentic_list_columns and kangentic_list_automations read the board before the move.',
    rows: [TASK_VALIDATE],
    config: {
      workspaceByProject: { [PROJECT_CONTOSO]: validateWindowWorkspace() },
      terminal: MCP_SCENE_TERMINAL,
    },
    seeds: { __mockAgentListOverrides: MCP_SCENE_AGENT_LIST },
    ready: '[data-testid="task-title-text"]',
    timeline: [{ session: SESSION_VALIDATE, at: 'end', do: { move: { task: TASK_VALIDATE, to: demoLaneId(PROJECT_CONTOSO, 'testing'), origin: 'agent' } } }],
  },

  dictation: {
    name: 'dictation',
    reach: 'boot',
    description: 'Push-to-talk held over the middleware task window, the live chip anchored to its terminal. The hotkey is the default Mouse:Back, pressed and never released, and the whole pipeline runs over a silent microphone (demo/README.md, Dictation). The transcript itself lands in the terminal on release, as the CLI\'s own echo, so it is not part of this frame.',
    alt: 'A task window with the dictation chip anchored to the bottom of its terminal: a live recording dot beside Listening, a hint that releasing the key sends the words to the agent, and a Clear control.',
    config: {
      workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') },
      dictation: DICTATION_ON,
    },
    ready: '[data-testid="dictation-live-chip"]',
    focus: '[data-testid="dictation-live-chip"]',
    steps: [{ press: 'Mouse:Back', waitFor: '[data-testid="dictation-live-chip"]' }],
    motion: 'The terminal under the chip replays its working session\'s recording.',
  },
  'dictation-field': {
    name: 'dictation-field',
    reach: 'boot',
    description: 'Push-to-talk held with the caret in the Settings search box, the live chip anchored under the field and the Dictation tab\'s options around it. Dictation types into any text field, not only a terminal. The click on the search box focuses it (boot.js focuses a text field it clicks), and the target is resolved from that focus on the press. A bottom-panel terminal cannot take the focus back once a field holds it (arrival focus denies it as occupied). No transcript lands on release: the dataset answers stop with nothing, which is what a silent microphone transcribes to.',
    alt: 'The Settings panel on the Dictation tab with its search box focused and the dictation chip under it: a live dot beside Listening, a hint that releasing the key sends the words, and a Clear control, over dictation settings in Best mode.',
    config: { dictation: DICTATION_ON },
    // Below the field, which fails on the fallback: had the search box not held focus, the press
    // would resolve to the bottom panel's terminal and the chip would mount above that instead.
    // Not `:focus`, which need not match in a frame the host has not focused (stage.html).
    ready: DICTATION_FIELD_LISTENING,
    focus: '[data-testid="dictation-live-chip"]',
    // The first wait is for the panel's slide-in to END (useOverlayPhase drops the class on its
    // animationend), not for the panel to exist. The chip anchors to the field wherever the field
    // is at the press, and the ready message measures the chip's rect once: pressed mid-slide in a
    // live frame, the frame posted a rect 220px right of where the chip settles.
    steps: [
      { click: '[data-testid="settings-button"]', waitFor: `${SETTINGS_PANEL}:not(.overlay-panel-in)` },
      { click: '[data-testid="settings-tab-dictation"]', waitFor: '[data-testid="dictation-model-lines"]' },
      { click: '[data-testid="settings-search"]' },
      { press: 'Mouse:Back', waitFor: '[data-testid="dictation-live-chip"]' },
    ],
    // The key let go, so the chip finalizes over the silent microphone and closes with nothing to
    // insert, then held again, so it opens under the field again. No words: none were spoken.
    choreography: [
      { hotkeyUp: 'Mouse:Back', waitFor: gone('[data-testid="dictation-live-chip"]'), ms: 1600 },
      { hotkeyDown: 'Mouse:Back', waitFor: DICTATION_FIELD_LISTENING, ms: 3200 },
    ],
  },

  // ---------------------------------------------------------------- the conversation viewer
  conversation: {
    name: 'conversation',
    reach: 'state',
    description: 'The conversation viewer open on the middleware session, floating over the board at the plain floating rect. The transcript is the one recorded beside the session (the manifest\'s transcript flag; main\'s own parser over the agent\'s history file), so the viewer shows what the desktop would for this run.',
    alt: 'The conversation viewer floating over the board, open on Extract auth middleware and scrolled to Claude Code\'s closing message: what changed in the middleware and the routes, the choices it made, and a caveat on the test run, with a search field above.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: conversationWindowWorkspace() } },
    // An assistant row exists only once the transcript has been fetched and rendered, so the
    // reveal waits for the conversation rather than for an empty window.
    ready: '[data-testid="conversation-row-assistant"]',
    focus: '[data-testid="conversation-window"]',
    // A search typed into the viewer and its matches stepped through. Then the cut, the search
    // cleared behind it, and the closing message brought back into view, which is where the viewer
    // opened.
    choreography: [
      { type: { into: CONVERSATION_SEARCH, text: 'middleware' }, waitFor: '[data-testid="conversation-search-next"]:not(:disabled)', ms: 1400 },
      { click: '[data-testid="conversation-search-next"]', ms: 1300 },
      { click: '[data-testid="conversation-search-next"]', ms: 1300 },
      { click: '[data-testid="conversation-search-previous"]', ms: 2000 },
      { cut: true },
      { type: { into: CONVERSATION_SEARCH, text: '' }, waitFor: '[data-testid="conversation-search-next"]:disabled' },
      // The viewer's own way back to the end, which shows once a match has scrolled it up.
      { click: '[data-testid="conversation-jump-to-latest"]', waitFor: gone('[data-testid="conversation-jump-to-latest"]') },
    ],
  },

  // ---------------------------------------------------------------- the Changes panel
  changes: {
    name: 'changes',
    reach: 'state',
    description: 'The task-detail window maximized with the Changes panel open on the Branch tab, server/routes.ts selected. The diff is the one the recorded session left in its working tree (seeded per task by the dataset).',
    alt: 'A maximized task window with the Changes panel open on the Branch tab, which compares the task branch against main: the file tree lists server/routes.ts and middleware/auth.ts with their line counts, and routes.ts is open in the diff pane.',
    // Maximized, unlike the `task` scene. A split diff wants three columns at once (the agent's
    // terminal, the file tree, the hunks), and in the floating rect at the frame's 1600x1000 the
    // diff pane clips mid-line. The maximize control is right there in the header, so a visitor
    // can put it back; this only picks the state the panel is legible in. The terminal takes
    // 0.42 of the width and shows the session's tiled recording (the comment above the Browser
    // scene).
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'branch', changesViewedFiles: ['server/middleware/auth.ts'] }) }],
    // The selected file's row, not the scope tab alone: the tree loads after the tab is checked, and
    // a frame built before it shows an empty panel.
    ready: '[data-testid="changes-file-tree"]:has([data-testid="changes-scope-branch"][aria-checked="true"]) [data-testid="changes-file-row"][data-path="server/routes.ts"][data-selected="true"]',
    // The new middleware file opened, routes.ts again, and routes.ts marked viewed, the last file
    // left. Then the cut, and the mark taken off behind it. Both are the task's own view state,
    // which the cycle leaves as it found it.
    choreography: [
      { click: changesFile('server/middleware/auth.ts'), waitFor: '[data-testid="changes-file-row"][data-path="server/middleware/auth.ts"][data-selected="true"]', ms: 2600 },
      { click: changesFile('server/routes.ts'), waitFor: '[data-testid="changes-file-row"][data-path="server/routes.ts"][data-selected="true"]', ms: 1500 },
      { click: changesViewed('server/routes.ts'), waitFor: `${changesViewed('server/routes.ts')}[aria-pressed="true"]`, ms: 2200 },
      { cut: true },
      { click: changesViewed('server/routes.ts'), waitFor: `${changesViewed('server/routes.ts')}[aria-pressed="false"]` },
    ],
  },
  'changes-working': {
    name: 'changes-working',
    reach: 'state',
    description: 'The same window on the Working tab: the agent\'s unstaged edits. The seed splits the recorded diff by status (modified files unstaged, the new file staged), so Working and Staged show different files and Branch shows both.',
    alt: 'The Changes panel on the Working tab: the agent\'s unstaged edit to server/routes.ts, open in the diff pane, with the new middleware file listed under Staged instead.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'working' }) }],
    ready: '[data-testid="changes-scope-working"][aria-checked="true"]',
    // The Staged tab looked at, where the new middleware file is, and Working again. The scope is
    // the task's own view state, which the cycle leaves as it found it.
    choreography: [
      { click: changesScope('staged'), waitFor: `${changesScope('staged')}[aria-checked="true"]`, ms: 3000 },
      { click: changesScope('working'), waitFor: `${changesScope('working')}[aria-checked="true"]`, ms: 1400 },
    ],
  },
  'changes-staged': {
    name: 'changes-staged',
    reach: 'state',
    description: 'The same window on the Staged tab: the new file the agent added (git add makes a new file tracked, which is what stages it).',
    alt: 'The Changes panel on the Staged tab: the new server/middleware/auth.ts the agent added, shown as an all-new file in the diff pane.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'staged', changesSelectedFile: 'server/middleware/auth.ts' }) }],
    ready: '[data-testid="changes-scope-staged"][aria-checked="true"]',
    // The Working tab looked at, where the edit to routes.ts is, and Staged again.
    choreography: [
      { click: changesScope('working'), waitFor: `${changesScope('working')}[aria-checked="true"]`, ms: 3000 },
      { click: changesScope('staged'), waitFor: `${changesScope('staged')}[aria-checked="true"]`, ms: 1400 },
    ],
  },
  'changes-history': {
    name: 'changes-history',
    reach: 'state',
    description: 'The Changes panel with History expanded and the commit that wired the routes selected, so the diff pane shows that commit rather than the working tree. The graph is the scaffold\'s real history (scripts/capture-demo-history.mjs).',
    alt: 'The Changes panel with its History section expanded: the branch\'s commits listed under Uncommitted changes with the routes commit selected, the file tree showing the two files that commit added, and the diff pane showing routes.ts as that commit introduced it.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'branch', changesHistoryOpen: true, changesSelectedCommit: ROUTES_COMMIT.hash }) }],
    ready: '[data-testid="changes-file-tree"]',
    // The pointer over the rate limiting commit below it, then the commit's other file opened and
    // routes.ts again. Never another commit: a restored selection draws its header without the
    // subject until the row is clicked (ChangesPanel's commitHeaderMeta), so selecting it again
    // would leave a header the poster does not have.
    choreography: [
      { hover: commitRow(2), ms: 2000 },
      { click: changesFile('server/index.ts'), waitFor: '[data-testid="changes-file-row"][data-path="server/index.ts"][data-selected="true"]', ms: 2800 },
      { click: changesFile('server/routes.ts'), waitFor: '[data-testid="changes-file-row"][data-path="server/routes.ts"][data-selected="true"]', ms: 1400 },
    ],
  },
  'changes-blame': {
    name: 'changes-blame',
    reach: 'boot',
    description: 'The diff with the blame gutter on, toggled through the View options menu (blame is per-file view state, never persisted). The blame is git\'s own over the working tree the session left: the agent\'s new lines are uncommitted, the rest carry the scaffold\'s commits.',
    alt: 'The Changes panel diff for server/routes.ts with the blame gutter on: each committed line carries the short hash and author of the commit that wrote it, the lines the agent just added carry none, and the View options menu is still open with Show blame checked.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'working' }) }],
    ready: '[data-testid="diff-blame-toggle"][aria-checked="true"]',
    steps: [
      { click: '[data-testid="diff-view-options"]', waitFor: '[data-testid="diff-blame-toggle"]' },
      { click: '[data-testid="diff-blame-toggle"]', waitFor: '[data-testid="diff-blame-toggle"][aria-checked="true"]' },
    ],
    motion: 'The terminal beside the panel replays its working session\'s recording.',
  },

  // ---------------------------------------------------------------- the Agent Monitor
  monitor: {
    name: 'monitor',
    reach: 'boot',
    description: 'The Agent Monitor over all three projects, every session in its live state. The open flag is not persisted, so it is one click.',
    alt: 'The Agent Monitor over all three projects: summary tiles for idle, active, and paused sessions, then a card per session grouped by project, each with its column, its latest output, and its model and context use.',
    ready: '[data-testid="monitor-card"]',
    steps: [{ click: '[data-testid="agent-monitor-button"]', waitFor: '[data-testid="monitor-page"]' }],
    // A filter typed, which narrows the cards to the sessions it matches, and those regrouped by
    // status. Then the cut, and behind it the grouping back by project, the filter cleared, and a
    // click on the header that leaves the field. The view's grouping and filter persist
    // (config.monitor), and the cycle ends on what it found. A card with a message trail draws the
    // trail, never the output peek, so most cards change only when their agent's message lands;
    // the cycle is what moves the page between those.
    choreography: [
      { type: { into: MONITOR_FILTER, text: 'auth' }, waitFor: '[data-testid="monitor-visible-count"]', ms: 2000 },
      { click: monitorGroup(2), waitFor: `${monitorGroup(2)}[aria-pressed="true"]`, ms: 3000 },
      { cut: true },
      { click: monitorGroup(1), waitFor: `${monitorGroup(1)}[aria-pressed="true"]` },
      { type: { into: MONITOR_FILTER, text: '' }, waitFor: gone('[data-testid="monitor-visible-count"]') },
      { click: { x: 0.75, y: 0.15 } },
    ],
  },
  'monitor-table': {
    name: 'monitor-table',
    reach: 'boot',
    description: 'The Agent Monitor in its table layout. The layout IS persisted (config.monitor.layout), so it is config plus the same open click.',
    alt: 'The Agent Monitor in table layout: summary tiles for idle, active, and paused sessions, then one row per session grouped by project, with columns for task, column, agent, model, effort, permission, runtime, and context.',
    // Spelled whole, because a scene's nested config block REPLACES the default rather than
    // merging into it. `layout` is the only field this scene is changing; the other six were
    // undefined here until the registry test started checking the shape.
    config: {
      monitor: {
        layout: 'table', groupBy: 'project', sort: 'longest-running', liveOnly: false,
        projectFilter: [], stateFilter: [], textFilter: '',
      },
    },
    ready: '[data-testid="monitor-table-row"]',
    steps: [{ click: '[data-testid="agent-monitor-button"]', waitFor: '[data-testid="monitor-page"]' }],
    // The Column header clicked through its cycle, ascending, descending, and back to the order the
    // rows arrived in. A table's sort is its own state and never persists.
    choreography: [
      { click: monitorHeader('column'), waitFor: `${monitorHeader('column')}[aria-sort="ascending"]`, ms: 2000 },
      { click: monitorHeader('column'), waitFor: `${monitorHeader('column')}[aria-sort="descending"]`, ms: 2000 },
      { click: monitorHeader('column'), waitFor: `${monitorHeader('column')}:not([aria-sort])`, ms: 900 },
    ],
  },

  // ---------------------------------------------------------------- the Command Terminal
  'command-terminal': {
    name: 'command-terminal',
    reach: 'boot',
    description: 'One Command Terminal window over the blurred board, on the contoso terminal session the dataset seeds. The layer\'s open state is component state, so it is one click on the title bar\'s toggle, which the choreography plays up to its pose; the window\'s rect is the global layout blob (commandTerminalWorkspace), restored on that open and fitted to the session\'s recording like the task window.',
    alt: 'A Command Terminal window open over the blurred board, running Claude Code in the project root, which has just summarized the repository and listed its npm scripts; the header carries the branch pill and the window controls.',
    config: { commandTerminalWorkspace: commandTerminalWorkspace(true) },
    ready: COMMAND_TERMINAL_WINDOW,
    // A person opening one: the pointer rests on the title bar's toggle, whose tip names the
    // Command Terminal with its shortcut, and clicks it. The open window is the pose, so the
    // poster, a still and the rest are that window, as they were when the click was a boot step.
    // Then the window is maximized, and the cut restores it and hides the layer behind the veil
    // (its session keeps running, as on the desktop), so the frame fades in on the board and the
    // next cycle opens it again. Its session finished its recording, so the terminal holds;
    // restarting it would take a working stretch the scene has no opening frame for.
    choreography: [
      { hover: COMMAND_TERMINAL_TOGGLE, ms: 1800 },
      { click: COMMAND_TERMINAL_TOGGLE, waitFor: COMMAND_TERMINAL_WINDOW },
      { hover: `${COMMAND_TERMINAL_WINDOW} .xterm`, ms: 600 },
      { pose: true },
      { click: '[data-testid="command-bar-maximize"]', ms: 2600 },
      { cut: true },
      { click: '[data-testid="command-bar-maximize"]' },
      { click: COMMAND_TERMINAL_TOGGLE, waitFor: gone(COMMAND_TERMINAL_WINDOW) },
    ],
  },
  'command-terminal-tiled': {
    name: 'command-terminal-tiled',
    reach: 'boot',
    description: 'Two Command Terminals tiled in one footprint, opened the way a person opens them: the toggle reattaches the contoso terminal session, then New terminal docks a second beside it and boots the project default agent from the boot recorded at the tiled width. The first window switches to its own tiled recording as it narrows (the seed\'s layoutFor), so both are at native type. The second terminal has no inline frame, so a still of this scene fetches that boot\'s final frame.',
    alt: 'Two Command Terminal windows tiled side by side: on the left Claude Code has summarized the repository and listed its npm scripts in a table, on the right a second Claude Code has just started in the same project root and waits at its prompt.',
    config: { commandTerminalWorkspace: commandTerminalWorkspace(false) },
    // The second window's model pill, which the context bar shows only once the session's first
    // usage lands, a beat after its terminal mounts (the seed pushes it 1.2 s after the boot's
    // first output, as main's status-line push would): a still shot before that would show the
    // "Starting agent" spinner in the bar rather than the pills.
    ready: COMMAND_TERMINAL_SECOND_MODEL,
    // The toggle opens the first window and New terminal docks a second beside it, each after the
    // pointer rests on it long enough for its tip. The pair is the pose. Then the pointer looks
    // at the second window's model pill, and the cut stops that terminal (Stop ends it for good,
    // so the next New terminal takes slot-2 again) and hides the layer behind the veil, so the
    // frame fades in on the board and the next cycle opens both again.
    choreography: [
      { hover: COMMAND_TERMINAL_TOGGLE, ms: 1800 },
      { click: COMMAND_TERMINAL_TOGGLE, waitFor: COMMAND_TERMINAL_WINDOW },
      { hover: '[data-testid="quick-session-new-terminal"]', ms: 1800 },
      { click: '[data-testid="quick-session-new-terminal"]', waitFor: COMMAND_TERMINAL_SECOND_MODEL },
      { hover: `${COMMAND_TERMINAL_SECOND} .xterm`, ms: 600 },
      { pose: true },
      { hover: COMMAND_TERMINAL_SECOND_MODEL, ms: 2400 },
      { cut: true },
      { click: `${COMMAND_TERMINAL_SECOND} [data-testid="command-bar-terminate-button"]`, waitFor: gone(COMMAND_TERMINAL_SECOND) },
      { click: COMMAND_TERMINAL_TOGGLE, waitFor: gone(COMMAND_TERMINAL_WINDOW) },
    ],
  },

  // ---------------------------------------------------------------- views and dialogs
  usage: {
    name: 'usage',
    reach: 'boot',
    description: 'The Usage dashboard over all projects for the week, from the seeded ninety-day history. Each period reads its slice of that history on main\'s own grid: Today by the hour from local midnight, This Week from Monday and This Month from the 1st by the day. So the bars a still shows under This Week depend on the weekday it was shot. The scope and period persist; the open flag does not.',
    alt: 'The Usage dashboard for all projects this week: token, cost and burn rate tiles, session and tool counts, a Background card for the calls Kangentic makes itself, cost per day by model beside cumulative spend, and breakdowns by agent, model and effort.',
    config: { usageStatsScope: 'all', usageStatsPeriod: 'week' },
    ready: '[data-testid="stats-filter-row"]',
    steps: [{ click: '[data-testid="usage-stats-button"]', waitFor: '[data-testid="stats-page"]' }],
    // Today, This Month, and This Week again: each period re-reads the series, so the tiles and
    // charts change with it. The period persists, and the cycle ends on the one it found.
    choreography: [
      { click: usagePeriod(2), waitFor: `${usagePeriod(2)}[aria-pressed="true"]`, ms: 2400 },
      { click: usagePeriod(4), waitFor: `${usagePeriod(4)}[aria-pressed="true"]`, ms: 2400 },
      { click: usagePeriod(3), waitFor: `${usagePeriod(3)}[aria-pressed="true"]`, ms: 900 },
    ],
  },
  'knowledge-graph': {
    name: 'knowledge-graph',
    reach: 'boot',
    description: 'The Knowledge Graph over all three projects, each an island of the conversations main\'s own pipeline indexed, embedded, laid out, and named (DEMO_KNOWLEDGE_GRAPH). Its open flag and its project scope are renderer store state, so it is clicks: the title-bar button, the Projects picker, All, and the picker again to close its menu. Choosing projects flies the camera, so the rig waits for the labels to settle, which also proves the map drew in a 3D context.',
    alt: 'The Knowledge Graph across three projects: contoso-web, spring-petclinic and online-boutique as islands of conversation points joined by links, regions named over them, the Filter, Regions and Display cards on the left, and an Ask box above.',
    // Every node of all three islands drawn: the scope has landed, rather than the open project alone.
    ready: `[data-testid="knowledge-graph-canvas"][data-drawn-count="${DEMO_KNOWLEDGE_GRAPH_NODE_TOTAL}"]`,
    settle: '[data-testid="knowledge-graph-island-label"], [data-testid="knowledge-graph-cluster-label"]',
    focus: '[data-testid="knowledge-graph-page"]',
    steps: [
      { click: '[data-testid="knowledge-graph-button"]', waitFor: '[data-testid="knowledge-graph-projects"]' },
      { click: '[data-testid="knowledge-graph-projects"]', waitFor: '[data-testid="knowledge-graph-projects-all"]' },
      { click: '[data-testid="knowledge-graph-projects-all"]' },
      // The picker's menu stays open after All; a second click on its trigger closes it.
      { click: '[data-testid="knowledge-graph-projects"]' },
    ],
    // Two orbits dragged across the map, then Reset view, the graph's own way back to the framing
    // the frame opened on.
    choreography: KNOWLEDGE_GRAPH_ORBIT,
  },
  ...knowledgeGraphProjectScenes(),
  backlog: {
    name: 'backlog',
    reach: 'boot',
    description: 'The Backlog view with the six seeded rows. The active view is store state, so it is one click on the view toggle.',
    alt: 'The Backlog view: a table of unscheduled items with a priority badge, title, description, labels, and age for each, under a toolbar with search, filter, New Task, and Import Tasks.',
    ready: '[data-testid="backlog-task-row"]',
    steps: [{ click: '[data-testid="view-toggle-backlog"]', waitFor: '[data-testid="backlog-view"]' }],
    // Two items selected and the bulk Move to board menu opened over its columns, the pointer on
    // one. Then the cut, and the menu closed and the selection cleared behind it. Never a column:
    // picking one moves the items onto the board for real.
    choreography: [
      { click: backlogCheckbox('backlog-cw-dark-mode'), waitFor: '[data-testid="backlog-bulk-toolbar"]', ms: 700 },
      { click: backlogCheckbox('backlog-cw-invoice-pdf'), waitFor: `${backlogCheckbox('backlog-cw-invoice-pdf')}:checked`, ms: 900 },
      { click: '[data-testid="bulk-move-to-board-btn"]', waitFor: PROMOTE_POPOVER, ms: 600 },
      { hover: `${PROMOTE_POPOVER} > button:nth-of-type(1)`, ms: 500 },
      { hover: `${PROMOTE_POPOVER} > button:nth-of-type(2)`, ms: 2000 },
      { cut: true },
      { click: '[data-testid="bulk-move-to-board-btn"]', waitFor: gone(PROMOTE_POPOVER) },
      { click: backlogCheckbox('backlog-cw-invoice-pdf'), waitFor: `${backlogCheckbox('backlog-cw-invoice-pdf')}:not(:checked)` },
      { click: backlogCheckbox('backlog-cw-dark-mode'), waitFor: gone('[data-testid="backlog-bulk-toolbar"]') },
    ],
  },
  'quick-find': {
    name: 'quick-find',
    reach: 'boot',
    description: 'The Quick Find palette on its empty state, before a query.',
    alt: 'The Quick Find palette open over the board, its search field empty, a This project or All projects scope toggle beside it, and a hint listing what it searches: tasks, backlog, conversations, session events, and projects.',
    ready: '[data-testid="search-palette-input"]',
    // The card, not `search-palette`: that marker is the full-frame backdrop, and a crop to it is
    // a no-op (the smoke tier now fails a focus that resolves to the whole frame).
    focus: '[data-testid="search-palette-card"]',
    steps: [{ click: '[data-testid="open-search-button"]', waitFor: '[data-testid="search-palette-input"]' }],
    // A query typed a key at a time and its results arriving. Then the cut, the field cleared
    // behind it, back to the empty state, and a click on the palette's hint below the field, which
    // leaves it: the frame opens with no field focused, so none draws a focus ring at rest.
    choreography: [
      { type: { into: SEARCH_INPUT, text: 'websocket' }, waitFor: '[data-testid="search-palette-result"]', ms: 3200 },
      { cut: true },
      { type: { into: SEARCH_INPUT, text: '' }, waitFor: gone('[data-testid="search-palette-result"]') },
      { click: '[data-testid="search-palette-card"] > div > div:last-child' },
    ],
  },
  'quick-find-results': {
    name: 'quick-find-results',
    reach: 'boot',
    description: 'Quick Find with a query typed and its grouped results. The seed answers the palette with a keyword match over the sample install\'s own rows (tasks, backlog, session events), so the hits are the rows a visitor can see on the board.',
    alt: 'The Quick Find palette with "auth" typed into it, and grouped results beneath: the tasks whose titles or descriptions match, and the session events where an agent touched an auth file, each with the match highlighted.',
    ready: '[data-testid="search-palette-result"]',
    // The card, not `search-palette`: that marker is the full-frame backdrop, and a crop to it is
    // a no-op (the smoke tier now fails a focus that resolves to the whole frame).
    focus: '[data-testid="search-palette-card"]',
    steps: [
      { click: '[data-testid="open-search-button"]', waitFor: '[data-testid="search-palette-input"]' },
      { type: '[data-testid="search-palette-input"]', text: 'auth', waitFor: '[data-testid="search-palette-result"]' },
    ],
    // The arrow keys down the results, a beat on each, then the query narrowed to the one task it
    // was after. Then the cut, "auth" again behind it with its five results and the first one
    // selected, and a click on the palette's search icon, which leaves the field: the frame opens
    // with no field focused (the arrows reach the palette's own listener), so none draws a focus
    // ring at rest. The pointer stays off the results: a result under the pointer takes the
    // selection. Never Escape or Enter.
    choreography: [
      { key: 'ArrowDown', ms: 1000 },
      { key: 'ArrowDown', ms: 1400 },
      { type: { into: SEARCH_INPUT, text: 'auth middleware' }, waitFor: gone('[data-testid="search-palette-result"][data-row-index="1"]'), ms: 2800 },
      { cut: true },
      { type: { into: SEARCH_INPUT, text: 'auth' }, waitFor: '[data-testid="search-palette-card"]:has([data-row-index="4"]) [data-testid="search-palette-result"][data-row-index="0"].bg-surface-hover' },
      { click: '[data-testid="search-palette-card"] > div > div:first-child > svg' },
    ],
  },
  'new-task': {
    name: 'new-task',
    reach: 'boot',
    description: 'The New Task dialog, empty, opened from the To Do column\'s Add task control.',
    alt: 'The New Task dialog: a title field, a description editor that takes dropped files, priority and labels, the Branch row with the branch it will create from main in a new worktree, and the choice between the column\'s settings and an agent override.',
    ready: '[data-testid="new-task-dialog"]',
    focus: '[data-testid="new-task-dialog"]',
    steps: [{ click: '[data-testid="swimlane-add-task"]', waitFor: '[data-testid="new-task-dialog"]' }],
    // A task filled in the way one is: a title, a description, a priority, a label picked from
    // the suggestions, and the pointer on Create. Then the cut, the form put back behind it, and a
    // click on the dialog's title, which leaves the last field: the dialog opens with no field
    // focused, so none draws a focus ring at rest. Create is never pressed, so no task is made.
    choreography: [
      { type: { into: NEW_TASK_TITLE, text: 'Add a health check route' }, ms: 700 },
      { type: { into: NEW_TASK_DESCRIPTION, text: 'Serve GET /healthz with the build version and the uptime.' }, ms: 1000 },
      { choose: { in: NEW_TASK_PRIORITY, value: '2' }, ms: 900 },
      { type: { into: NEW_TASK_LABELS, text: 'feat' }, waitFor: '[data-testid="label-suggestion"]', ms: 600 },
      { click: '[data-testid="label-suggestion"]', waitFor: NEW_TASK_FEATURE_LABEL, ms: 900 },
      { hover: '[data-testid="new-task-dialog"] button[type="submit"]', ms: 1600 },
      { cut: true },
      { click: NEW_TASK_FEATURE_LABEL, waitFor: `[data-testid="new-task-dialog"]:not(:has([aria-label="Remove feature"]))` },
      { choose: { in: NEW_TASK_PRIORITY, value: '0' } },
      { type: { into: NEW_TASK_DESCRIPTION, text: '' } },
      { type: { into: NEW_TASK_TITLE, text: '' } },
      { click: '[data-testid="new-task-dialog"] h3' },
    ],
  },
  'edit-columns': {
    name: 'edit-columns',
    reach: 'boot',
    description: 'The Column Manager (the docs call it Edit Columns) on the Code Review column of the configured board the four Column Manager scenes share, where Codex CLI reviews on its own model. No automation is configured here, so the enter and exit slots read Add automation, and On agent turn end says the column\'s agent cannot report a turn end, because Codex does not. The column-automation scene is the configured counterpart.',
    alt: 'The Column Manager dialog with the Code Review column selected: its name, icon, and color, Codex CLI on gpt-5.5 as the agent that starts when a task enters it, and empty automation slots for entering and leaving the column.',
    seeds: { __mockSwimlanePatches: COLUMN_LADDER },
    ready: '[data-testid="board-manager-dialog"]',
    focus: '[data-testid="board-manager-dialog"]',
    steps: [{ click: '[data-swimlane-name="Code Review"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' }],
    // Testing opened in the rail and dragged above Code Review, which lights Save up (the order is a
    // draft), and the pointer on Save. Then the cut, Testing dragged back below it behind the veil
    // (Save goes dark again), and Code Review selected again. Save is never pressed, so the board
    // is never written.
    choreography: [
      { click: columnTab('Testing'), waitFor: `${columnTab('Testing')}[aria-selected="true"]`, ms: 1500 },
      { drag: { from: columnGrip('Testing'), to: columnTab('Code Review') }, waitFor: '[data-testid="board-manager-save"]:not(:disabled)', ms: 900 },
      { hover: '[data-testid="board-manager-save"]', ms: 1800 },
      { cut: true },
      { drag: { from: columnGrip('Testing'), to: columnTab('Code Review') }, waitFor: BOARD_MANAGER_CLEAN },
      { click: columnTab('Code Review'), waitFor: `${BOARD_MANAGER}:has(${columnTab('Code Review')}[aria-selected="true"]):has(${BOARD_MANAGER_CLEAN})` },
    ],
  },
  // ---------------------------------------------------------------- column workflow
  // An automation and a handed-off context are per-scene seeds, never dataset rows: an automation
  // draws a glyph in the BOARD column header (AutomationGlyph), so seeding one into the sample
  // install would change every docs figure already placed and every poster in the release zip.
  // COLUMN_LADDER and REVIEW_PASS_AUTOMATION name their columns through demoLaneId, which the
  // registry test resolves against the install.
  'column-automation': {
    name: 'column-automation',
    reach: 'boot',
    description: 'The Column Manager on Code Review with a Send message automation configured on enter, for the Workflows page and the Workflow Automation showcase. The sample install configures none, so this is a scene seed, on the same configured board as edit-columns and column-handoff.',
    alt: 'The Column Manager on the Code Review column: Codex CLI on gpt-5.5 as the agent that starts there, and an Automations pane holding one Send message row on enter with the message it sends, edit and delete controls, and its switch on.',
    seeds: {
      __mockSwimlanePatches: COLUMN_LADDER,
      __mockAutomations: [REVIEW_PASS_AUTOMATION],
    },
    ready: '[data-testid="column-automation-row"]',
    focus: '[data-testid="board-manager-dialog"]',
    steps: [{ click: '[data-swimlane-name="Code Review"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' }],
    // Add automation on task exit, a type picked from its menu, which adds a draft row and opens it
    // in the Add automation dialog, and Cancel, which takes the draft row away again. Save is never
    // pressed, so the column's automations are never written.
    choreography: [
      { click: '[data-testid="column-automation-add"][data-trigger="exit"]', waitFor: '[data-testid="column-automation-picker"]', ms: 700 },
      { hover: automationPickerType('send_message'), ms: 500 },
      { click: automationPickerType('notify'), waitFor: '[data-testid="edit-automation-dialog"]', ms: 2400 },
      { click: '[data-testid="edit-automation-cancel"]', waitFor: `${gone('[data-testid="edit-automation-dialog"]')}:has(${BOARD_MANAGER_CLEAN})`, ms: 900 },
    ],
  },
  'column-automation-turn-end': {
    name: 'column-automation-turn-end',
    reach: 'boot',
    description: 'The Column Manager on Testing with two Move to column automations on agent turn end, run in order, for the landing page\'s Automations tab and the Columns and automations docs: the review loop sending findings back, then the move on, with one row of each Condition kind so both row marks show side by side. Send findings back is an Agent evaluation (the robot mark) with a Frequency of three and a Message carrying {{agentReply}}. On to Merge is a Text match (the text search mark) on the line PR: ready to merge, checked in code with no agent call, once. Codex CLI reviews in Code Review and reports no turn end, so the desktop blocks that trigger there; the ladder hands the review on to Claude in Testing, which is where the loop runs. A scene seed on the same configured board as the other Column Manager scenes, which keeps their Code Review automation too.',
    alt: 'The Column Manager on Testing, where Claude Code runs on Sonnet 5. On agent turn end runs two rows in order: Send findings back to Executing, an Agent evaluation with a message, up to three times, then On to Merge, a Text match on PR: ready to merge, once.',
    seeds: {
      __mockSwimlanePatches: COLUMN_LADDER,
      __mockAutomations: [REVIEW_PASS_AUTOMATION, ...TESTING_TURN_END_AUTOMATIONS],
    },
    ready: '[data-testid="column-automation-group"][data-trigger="turn_end"] [data-testid="column-automation-row"][data-name="On to Merge"]',
    focus: '[data-testid="board-manager-dialog"]',
    steps: [{ click: '[data-swimlane-name="Testing"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' }],
    // Each turn-end row opened in its Edit automation dialog and cancelled, so a figure moves through
    // what both rows hold. Cancel on a saved row changes nothing, and Save is never pressed.
    choreography: [
      { click: turnEndRowEdit('Send findings back'), waitFor: '[data-testid="edit-automation-dialog"]', ms: 2800 },
      { click: '[data-testid="edit-automation-cancel"]', waitFor: `${gone('[data-testid="edit-automation-dialog"]')}:has(${BOARD_MANAGER_CLEAN})`, ms: 800 },
      { click: turnEndRowEdit('On to Merge'), waitFor: '[data-testid="edit-automation-dialog"]', ms: 2800 },
      { click: '[data-testid="edit-automation-cancel"]', waitFor: `${gone('[data-testid="edit-automation-dialog"]')}:has(${BOARD_MANAGER_CLEAN})`, ms: 900 },
    ],
  },
  // The first of those two rows opened in its Edit automation dialog, so a figure can show what a
  // row holds rather than its title and two marks. The first row, not the second: its Condition is
  // an Agent evaluation in plain words, where the second quotes one specific final line. The
  // Automation agent is a scene seed too. Without one the Condition card shows its setup notice in
  // place of the condition, and the sample install chooses none, so settings-workflows still reads
  // "no agent chosen". `ready` is the condition field itself, so a missing seed fails the boot.
  'column-automation-edit': {
    name: 'column-automation-edit',
    reach: 'boot',
    description: 'The Edit automation dialog on Testing\'s first turn-end row, Send findings back, for the landing page\'s Automations tab: its four cards, Trigger on agent turn end, an Agent evaluation Condition in plain words, a Frequency of three, and a Move to column Action to Executing whose message carries {{agentReply}}. Opened from the Column Manager of the same configured board as column-automation-turn-end, with Claude on Sonnet 5 as the Automation agent that answers the Condition. At the 1600 by 1000 frame the dialog\'s body scrolls by about 115px: the first three cards show whole, and the Action card shows its Type, its column and the Message, whose last line ({{agentReply}}) is cut off at the bottom of the body, with the Template variable picker below the fold.',
    alt: 'The Edit automation dialog for Send findings back on Testing: it runs on agent turn end when an Agent evaluation finds the review left work for the implementer, up to three times, and moves the task back to Executing with a message.',
    config: DEMO_AUTOMATION_AGENT,
    seeds: {
      __mockSwimlanePatches: COLUMN_LADDER,
      __mockAutomations: [REVIEW_PASS_AUTOMATION, ...TESTING_TURN_END_AUTOMATIONS],
    },
    ready: '[data-testid="edit-automation-dialog"] [data-testid="edit-automation-condition"]',
    focus: '[data-testid="edit-automation-dialog"]',
    steps: [
      { click: '[data-swimlane-name="Testing"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' },
      {
        click: '[data-testid="column-automation-group"][data-trigger="turn_end"] [data-testid="column-automation-row"][data-name="Send findings back"] [data-testid="column-automation-edit"]',
        waitFor: '[data-testid="edit-automation-dialog"]',
      },
    ],
    // The form changed the way an edit goes: Text match picked and the reviewer's last line typed
    // for it, the Frequency down to one, and the pointer on Done. Then the cut, and the form put
    // back behind it: the line cleared, the Frequency back to three, and Agent evaluation again.
    // The dialog keeps the evaluation's text across the switch (its conditionDraft), so the cycle
    // ends on the poster's values. Done is never pressed, so the mock's automations are never
    // written.
    choreography: [
      { click: AUTOMATION_KIND_TEXT, waitFor: `${AUTOMATION_KIND_TEXT}[aria-checked="true"]`, ms: 900 },
      { type: { into: AUTOMATION_FINAL_LINE, text: 'Changes requested' }, ms: 1000 },
      { click: AUTOMATION_RUNS_DECREMENT, ms: 500 },
      { click: AUTOMATION_RUNS_DECREMENT, ms: 1000 },
      { hover: '[data-testid="edit-automation-done"]', ms: 2000 },
      { cut: true },
      { type: { into: AUTOMATION_FINAL_LINE, text: '' } },
      { click: AUTOMATION_RUNS_INCREMENT },
      { click: AUTOMATION_RUNS_INCREMENT },
      { click: AUTOMATION_KIND_AGENT, waitFor: `${AUTOMATION_KIND_AGENT}[aria-checked="true"]` },
    ],
  },
  'column-handoff': {
    name: 'column-handoff',
    reach: 'boot',
    description: 'The Column Manager\'s All columns table on a configured board, for the Handoff Context showcase: Claude Code plans on Opus 5 and builds on Sonnet 5, Codex CLI reviews in an isolated session, Claude tests, and GitHub Copilot CLI merges, with handoff on at each change of agent. The sample install configures none of it, so it is a scene seed. The TABLE, not the column form: in the form the toggle sits 996px down a 1000px frame, so the figure would show everything except its own subject.',
    alt: 'The Column Manager\'s All columns table: Claude Code plans on Opus 5 at xhigh and builds on Sonnet 5, Codex CLI reviews on gpt-5.5 in an isolated session, and GitHub Copilot CLI merges, with handoff on at each change of agent.',
    seeds: {
      __mockSwimlanePatches: COLUMN_LADDER,
      __mockAutomations: [REVIEW_PASS_AUTOMATION],
    },
    // `[aria-selected="true"]`, not the bare testid: ColumnRail renders the All columns tab button
    // unconditionally as soon as the dialog mounts, so the bare selector resolves the instant step
    // one opens the dialog. Both the step's wait and the frame's gate would then be satisfied
    // before the click that switches the view, and the figure could be shot on the column form.
    // `aria-selected` is the only thing on that button that tracks which view is showing.
    ready: '[data-testid="board-manager-tab-all"][aria-selected="true"]',
    focus: '[data-testid="board-manager-dialog"]',
    steps: [
      { click: '[data-swimlane-name="Code Review"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' },
      { click: '[data-testid="board-manager-tab-all"]', waitFor: '[data-testid="board-manager-tab-all"][aria-selected="true"]' },
    ],
    // The table is read-only, so the edit goes through a column's own page, the way a visitor's
    // would: Testing's row opens it, its handoff switch goes off, and All columns shows the change as
    // a draft. Then the cut, and the switch back on behind it, which leaves the board as it was.
    choreography: [
      { click: overviewRow('testing'), waitFor: `${columnTab('Testing')}[aria-selected="true"]`, ms: 900 },
      { scroll: HANDOFF_SWITCH, ms: 500 },
      { click: HANDOFF_SWITCH, waitFor: `${HANDOFF_SWITCH}[aria-checked="false"]`, ms: 1200 },
      { click: '[data-testid="board-manager-tab-all"]', waitFor: `${overviewRow('testing')} [aria-label="unsaved changes"]`, ms: 3000 },
      { cut: true },
      { click: overviewRow('testing'), waitFor: `${columnTab('Testing')}[aria-selected="true"]` },
      { scroll: HANDOFF_SWITCH },
      { click: HANDOFF_SWITCH, waitFor: `${HANDOFF_SWITCH}[aria-checked="true"]` },
      { click: '[data-testid="board-manager-tab-all"]', waitFor: ALL_COLUMNS_CLEAN },
    ],
  },

  // ---------------------------------------------------------------- workflows
  // One running workflow, seeded per scene for the reason WORKFLOW_HARDEN_API_SEEDS gives.
  'workflows': {
    name: 'workflows',
    reach: 'boot',
    description: 'The Workflows view on a running workflow, for the landing page\'s Workflows tab and the Workflows docs page. Six existing contoso cards joined by task patches. The steps collapse the agent pane and then open the view again: the canvas fits its cards only when a workflow opens, never on a resize, so this is how it opens at its full width. The pane is collapsed because the mock\'s workflow agent has no recording. The last click, on empty canvas, clears the task the view selects on open, so every link shows its own state and the inspector shows the run order. The cards sit at their own size with room around them because the canvas never fits past 1:1 (FIT_VIEW_OPTIONS in WorkflowCanvas.tsx). Live, a card is dragged out and Auto layout slides it home while the middleware agent works; when its recorded turn ends, about 90 s in, the timeline moves it to Done and starts Add user auth flow in Planning (HARDEN_API_STEP_TIMELINE), and loop=1 undoes both six seconds later.',
    alt: 'The Workflows view on Harden the API, a running workflow of six linked cards: two done, two in progress, and two waiting in To Do. Green links run from the done cards and grey links into the waiting ones, beside the run order.',
    config: DEMO_AUTOMATION_AGENT,
    seeds: WORKFLOW_HARDEN_API_SEEDS,
    tasks: WORKFLOW_HARDEN_API_MEMBERS,
    ready: '[data-testid="workflow-run-order"]',
    focus: '[data-testid="workflows-view"]',
    steps: [
      ...WORKFLOW_VIEW_ROUND_TRIP,
      { click: '.react-flow__pane', waitFor: '[data-testid="workflow-run-order"]' },
    ],
    timeline: HARDEN_API_STEP_TIMELINE,
    // Add user auth flow dragged up into the empty canvas, its links following, then Auto layout,
    // the canvas's own way back: it slides hand-placed cards home and turns itself off again. Then a
    // click on empty canvas, since a drag selects the card it moves. The drag writes the card's
    // place as the desktop's does, and Auto layout clears it.
    choreography: [
      { drag: { from: WORKFLOW_AUTH_CARD, by: { x: 0, y: -0.19 } }, waitFor: '[data-testid="workflow-auto-layout"]:not(:disabled)', ms: 1600 },
      { click: '[data-testid="workflow-auto-layout"]', waitFor: '[data-testid="workflow-auto-layout"]:disabled', ms: 1400 },
      { click: { x: 0.3, y: 0.25 }, waitFor: '[data-testid="workflow-run-order"]', ms: 900 },
    ],
  },
  'board-workflow': {
    name: 'board-workflow',
    reach: 'state',
    description: 'The board with the workflows scene\'s running workflow seeded, for the figure of workflow cards on the board: each member card\'s strip and step track, the To Do cards\' waiting line, and the view toggle\'s running mark. Nothing is clicked. Live, the pointer rests on Refactor API error handling and then on Add user auth flow, so the board draws each one\'s workflow links in turn, and the same step chain as the workflows scene plays on the board when the middleware session\'s recorded turn ends, about 90 s in: its card leaves Executing for Done, and Add user auth flow moves from To Do into Planning and starts its agent.',
    alt: 'The contoso-web board with Harden the API running: each of its cards carries the workflow\'s strip and a step track through the columns, the two in To Do say what they are blocked by, and the Workflows toggle shows a running mark.',
    config: DEMO_AUTOMATION_AGENT,
    seeds: WORKFLOW_HARDEN_API_SEEDS,
    tasks: WORKFLOW_HARDEN_API_MEMBERS,
    timeline: HARDEN_API_STEP_TIMELINE,
    ready: `[data-task-id="${TASK_MIDDLEWARE}"] [data-testid="workflow-card-strip"]`,
    focus: [TASK_AUTH, TASK_API_ERRORS, TASK_MIDDLEWARE, TASK_RATE_LIMIT].map((id) => `[data-task-id="${id}"]`).join(', '),
    // Looking the workflow over the way board-workflow-links holds it: the pointer rests on the card
    // blocked by two tasks, then on Add user auth flow, each long enough for the board's own 400 ms
    // dwell to draw its links, and leaves the board, which takes them away.
    choreography: [
      { hover: `[data-task-id="${TASK_API_ERRORS}"]`, waitFor: '[data-testid="workflow-link-line"]', ms: 2800 },
      { hover: AUTH_CARD, waitFor: '[data-testid="workflow-link-line"]', ms: 2800 },
    ],
  },
  'workflow-draft': {
    name: 'workflow-draft',
    reach: 'boot',
    description: 'The Workflows view on a workflow planned but not started, for the part of the Workflows docs that shows how one is made: the workflow agent in its pane beside the plan it saved, the planned cards and the link between them, the selected task\'s route and what it waits for in the inspector, and Start in the header. The pane is the recorded agent at the end of its planning: it saved one task, the user asked for the server and the page apart, and it saved the two linked tasks the canvas draws. The last click selects the billing page task, so its link is lit and the inspector names the route task it waits for.',
    alt: 'The Workflows view on Invoice PDF export, planned but not started: the workflow agent\'s reply after saving two linked tasks, the server route and billing page cards, and the billing page selected, with its route and what it waits for.',
    config: WORKFLOW_AGENT_CHOICE,
    seeds: WORKFLOW_INVOICE_DRAFT_SEEDS,
    ready: `${draftCard(PLANNED_BILLING_PAGE)}[data-selected="true"]`,
    focus: '[data-testid="workflows-view"]',
    // The view, with the agent pane open on its recording, and the billing page selected over the
    // first task in run order, which the view selects when it opens.
    steps: [
      { click: '[data-testid="view-toggle-workflows"]', waitFor: '[data-testid="workflow-agent-pane"] .xterm' },
      { click: draftCard(PLANNED_BILLING_PAGE), waitFor: `${draftCard(PLANNED_BILLING_PAGE)}[data-selected="true"]` },
    ],
    // The plan reviewed where the recording leaves it: the pointer over the agent's reply, the
    // server task looked over, the billing page again, and its Planning stop switched off, the
    // column the reply offers to skip. Then the cut, and Planning on again behind it. Start is
    // never pressed.
    choreography: [
      { hover: '[data-testid="workflow-agent-pane"] .xterm', ms: 1800 },
      { click: draftCard(PLANNED_PDF_ROUTE), waitFor: `${draftCard(PLANNED_PDF_ROUTE)}[data-selected="true"]`, ms: 2400 },
      { click: draftCard(PLANNED_BILLING_PAGE), waitFor: `${draftCard(PLANNED_BILLING_PAGE)}[data-selected="true"]`, ms: 1200 },
      { click: PLANNED_ROUTE_PLANNING, waitFor: `${PLANNED_ROUTE_PLANNING}[aria-checked="false"]`, ms: 2600 },
      { cut: true },
      { click: PLANNED_ROUTE_PLANNING, waitFor: `${PLANNED_ROUTE_PLANNING}[aria-checked="true"]` },
    ],
  },

  'completed-tasks': {
    name: 'completed-tasks',
    reach: 'boot',
    description: 'The Completed Tasks dialog over the archived contoso rows, opened from the Done column\'s Completed header.',
    alt: 'The Completed Tasks dialog: a table of archived tasks with columns for cost, agent runtime, tokens, tools, files, and lines, when each was completed, and restore and delete controls on every row.',
    ready: '[data-testid="completed-task-checkbox"]',
    focus: '[data-testid="completed-tasks-dialog"]',
    steps: [{ click: '[data-testid="expand-completed-btn"]', waitFor: '[data-testid="completed-tasks-dialog"]' }],
    // The pointer down the rows, then View details on the CI/CD pipeline row, which opens its
    // completed task view, and that window closed again over the list.
    choreography: [
      { hover: completedRow(DEMO_COMPLETED_TASK_ID), ms: 600 },
      { click: `${completedRow(DEMO_COMPLETED_TASK_ID)} [data-testid="view-task-btn"]`, waitFor: '[data-testid="completed-task-view"]', ms: 3200 },
      // The list hands over to the view, so it opens again from the Completed header once the view
      // closes. That header is on Done, past the frame's right edge, so the board scrolls to it and
      // back to To Do, where the frame opened, behind the list.
      { click: '[data-testid="task-detail-close"]', waitFor: gone('[data-testid="completed-task-view"]'), ms: 600 },
      { scroll: '[data-testid="expand-completed-btn"]', ms: 300 },
      { click: '[data-testid="expand-completed-btn"]', waitFor: '[data-testid="completed-task-checkbox"]', ms: 300 },
      { scroll: '[data-swimlane-name="To Do"]', ms: 1000 },
    ],
  },
  'completed-task': {
    name: 'completed-task',
    reach: 'boot',
    description: 'The completed task view of an archived contoso task, opened the way a user opens one: the Done column\'s Completed header, then View details on the Set up CI/CD pipeline row, then the window\'s maximize toggle so every card fits. It shows the default Summary tab under the header strip, for the Completed tasks docs. The maximized window fills the frame between the title and status bars, so its focus rect is close to the whole frame. The report is a scene seed (`__mockTaskReports`, helpers/demo-task-report.ts) that main\'s assembleTaskReport builds. The header strip is the row\'s own summary, so its cost and agent runtime match the completed-tasks scene. The runs, tokens and changed files come from the task\'s recorded run. The columns, the second conversation, the time between runs, the moves, the commits, the background calls and the summary wording are authored.',
    alt: 'The completed task view of Set up CI/CD pipeline. A header strip gives dates, runtime, changes, pull request, cost and status. The Summary tab shows the written summary, a route through Executing and Code Review twice each, two commits and four changed files.',
    seeds: { __mockTaskReports: COMPLETED_TASK_REPORTS },
    ready: '[data-testid="completed-route"]',
    focus: '[data-testid="task-detail-dialog"]',
    steps: COMPLETED_TASK_STEPS,
    // Usage, then Description, then Summary again: the report's three tabs.
    choreography: [
      { click: completedTab('usage'), waitFor: `${completedTab('usage')}[aria-selected="true"]`, ms: 3000 },
      { click: completedTab('description'), waitFor: `${completedTab('description')}[aria-selected="true"]`, ms: 2400 },
      { click: completedTab('summary'), waitFor: `${completedTab('summary')}[aria-selected="true"]`, ms: 900 },
    ],
  },
  'completed-task-usage': {
    name: 'completed-task-usage',
    reach: 'boot',
    description: 'The same completed task view, maximized, after a click on Usage, for the Completed tasks docs: the Runs table over two conversations (main, and Code Review\'s isolated one) with its per-tool popovers, Models and tokens from the run\'s own ledger (one model, so one row), and the background calls with Code Review\'s Agent evaluation met once and not met once, then the summary call. The same scene seed as completed-task.',
    alt: 'The Usage tab of the completed CI/CD pipeline task: four runs across a main and a Code Review conversation, each with its column, model, permissions, runtime, cost and tool calls, then tokens by kind and background calls that ran once and skipped once.',
    seeds: { __mockTaskReports: COMPLETED_TASK_REPORTS },
    ready: '[data-testid="completed-models"]',
    focus: '[data-testid="task-detail-dialog"]',
    steps: [
      ...COMPLETED_TASK_STEPS,
      { click: '[data-testid="completed-task-tabs-usage"]', waitFor: '[data-testid="completed-task-tabs-usage"][aria-selected="true"]' },
    ],
    // Summary, then Description, then Usage again.
    choreography: [
      { click: completedTab('summary'), waitFor: `${completedTab('summary')}[aria-selected="true"]`, ms: 3000 },
      { click: completedTab('description'), waitFor: `${completedTab('description')}[aria-selected="true"]`, ms: 2400 },
      { click: completedTab('usage'), waitFor: `${completedTab('usage')}[aria-selected="true"]`, ms: 900 },
    ],
  },

  // ---------------------------------------------------------------- settings, one per tab
  ...settingsScenes(),

  // ---------------------------------------------------------------- held gestures
  // Each of these is a gesture in flight, so its choreography ends on a pose: a still plays the
  // gesture up to it (demo/choreography.ts, the same synthetic pointer a live frame uses), and the
  // poster is that frame. They were the capture rig's alone until the frame could play a pointer.
  'card-drag': {
    name: 'card-drag',
    reach: 'boot',
    description: 'A card lifted out of To Do and held over Executing, for the drag-to-start figure. The choreography presses on the card and carries it past dnd-kit\'s activation distance to Executing, and the pose holds it there. Live, the card is dropped and its agent starts from the recorded boot. Then the frame cuts, and behind it the card goes back to the top of To Do, which ends its session as main does, so the board is back as it was when the card is lifted again.',
    alt: 'A task card mid-drag from To Do into Executing, the card lifted and tilted, the Executing column highlighted as the drop target.',
    ready: '.drag-overlay',
    choreography: [
      { drag: { from: AUTH_CARD, to: '[data-swimlane-name="Executing"]', hold: true }, waitFor: '.drag-overlay' },
      { pose: true },
      { drop: true, waitFor: `[data-swimlane-name="Executing"] ${AUTH_CARD}`, ms: 5500 },
      { cut: true },
      // Above Refactor API error handling's middle, so the card goes back to the top of the column,
      // and landed there: the overlay plays its drop animation after the card has moved, and the
      // frame fades back in only once it is gone.
      { drag: { from: `[data-swimlane-name="Executing"] ${AUTH_CARD}`, to: TODO_TOP_SLOT }, waitFor: `${gone('.drag-overlay')} [data-swimlane-name="To Do"] ${AUTH_CARD}` },
    ],
  },
  'card-menu': {
    name: 'card-menu',
    reach: 'boot',
    description: 'A card\'s context menu, which opens on right-click only, so the choreography right-clicks the card and the pose holds the menu open. Live, the pointer runs down the items without picking one, a click on empty board closes the menu, and the card is right-clicked again.',
    alt: 'A task card\'s right-click menu open over the board: Edit, Disable automations, New workflow, a Move to list of the other columns, then Backlog, Archive, and Delete.',
    ready: '[data-testid="task-context-menu"]',
    focus: '[data-testid="task-context-menu"]',
    choreography: [
      { contextmenu: AUTH_CARD, waitFor: '[data-testid="task-context-menu"]' },
      { pose: true },
      { hover: '[data-testid="context-edit-task"]', ms: 500 },
      { hover: '[data-testid="context-toggle-automations"]', ms: 500 },
      { hover: '[data-testid="context-new-workflow"]', ms: 700 },
      { hover: '[data-testid="context-move-to"]', ms: 1100 },
      { click: EMPTY_BOARD, waitFor: gone('[data-testid="task-context-menu"]'), ms: 1400 },
    ],
  },
  // The board draws a workflow card's links only while the pointer rests on the card
  // (card-links-preview.ts: a mouse pointerenter, then a 400ms dwell) or after a refused move, so
  // no click reaches it. Refactor API error handling is the card that reads "Blocked by 2 tasks",
  // and resting on it draws which two.
  'board-workflow-links': {
    name: 'board-workflow-links',
    reach: 'boot',
    description: 'The board-workflow scene with the pointer resting on Refactor API error handling, so the board draws that card\'s workflow links: one from each card it waits for. The choreography rests the pointer on the card through the board\'s dwell, and the pose holds it there. Live, the pointer moves up to Add user auth flow, whose one link runs from the middleware card, and back.',
    alt: 'The contoso-web board with the pointer resting on Refactor API error handling, a To Do card blocked by two tasks: lines run into it from Extract auth middleware in Executing and from Add rate limiting in Code Review, and the card is outlined.',
    seeds: WORKFLOW_HARDEN_API_SEEDS,
    tasks: WORKFLOW_HARDEN_API_MEMBERS,
    ready: '[data-testid="workflow-link-line"]',
    focus: [TASK_API_ERRORS, TASK_MIDDLEWARE, TASK_RATE_LIMIT].map((id) => `[data-task-id="${id}"]`).join(', '),
    choreography: [
      { hover: `[data-task-id="${TASK_API_ERRORS}"]`, waitFor: '[data-testid="workflow-link-line"]' },
      { pose: true },
      // The board's dwell is its own 400 ms, so the pacing holds the card long enough to draw.
      { hover: AUTH_CARD, waitFor: '[data-testid="workflow-link-line"]', ms: 2800 },
    ],
  },
  'window-dock': {
    name: 'window-dock',
    reach: 'boot',
    description: 'The task window dragged toward the right edge with the snap preview armed, for the docking figure. The choreography presses on the title bar and carries the window to the edge, and the pose holds it there. Live, the window is dropped and docks to the right half. Then the frame cuts, and behind it the title bar is dragged back out, which floats the window at its own size again. The pose\'s frame depends only on the window\'s size and where its title bar is held, so it is the same each time.',
    alt: 'A task window being dragged toward the edge of the board, the docking preview showing where it will snap.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') } },
    ready: '[data-testid="snap-preview"]',
    // The snap zone is the last few pixels before the edge; the point is a fraction of the frame
    // because an edge has no element to name.
    choreography: [
      { drag: { from: TASK_TITLEBAR, to: { x: 0.997, y: 0.5 }, hold: true }, waitFor: '[data-testid="snap-preview"]' },
      { pose: true },
      { drop: true, ms: 3000 },
      { cut: true },
      { drag: { from: TASK_TITLEBAR, to: { x: 0.5, y: 0.2 } } },
    ],
  },
};
