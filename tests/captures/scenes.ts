/**
 * The scene registry: one catalog, two consumers.
 *
 * The web build (demo/) resolves `view=<name>` through this map at boot with no driver, and the
 * capture rig (tests/captures/features/scenes.capture.ts) opens the same names in the BUILT demo
 * with Playwright behind it. Every entry is DATA on top of the sample install in
 * helpers/demo-dataset.ts: config overrides, task-row patches, session activity states,
 * `window.__mock*` seeds the mock reads, and a short list of steps the consumer plays before it
 * reveals the frame. No code travels through a scene, so the same shape can ride a `state=` URL
 * parameter verbatim.
 *
 * `reach` says who can build the scene:
 *   state   config and rows alone; nothing is clicked
 *   boot    state plus a few pre-reveal clicks (the demo runs them; the rig runs them too)
 *   driver  needs a hover, a drag, or an open menu; the capture rig only, the demo refuses it
 *
 * Three fields ship past this repo. `alt` is the reader-facing text a docs figure carries, so it is
 * authored here, beside the state it describes, and emitted into `dist/demo/scenes.json`. `ready`
 * is the selector that must exist before the frame counts as built: the demo waits for it before
 * it reveals and posts ready, the smoke tier asserts it, and the rig shoots after it. `focus`, when
 * set, names the element whose rect the ready message reports, so a host can crop a dialog scene
 * to the dialog without knowing the layout.
 *
 * No Node imports on purpose: demo/vite.config.mts serializes this module into the static build,
 * and the capture rig reads it as well. tests/unit/scene-registry.test.ts pins the shape.
 */
import { PROJECT_CONTOSO, SESSION_EMPTY_STATES, SESSION_INTEGRATION, SESSION_MIDDLEWARE, SESSION_RATE_LIMIT, TASK_API_CLIENT, TASK_AUTH, TASK_MIDDLEWARE, TASK_WEBSOCKET, demoLaneId } from './helpers/demo-dataset';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import { commandTerminalTitle } from '../../src/shared/command-terminal-name';
import announcementsFeed from '../../announcements.json';
import contosoHistory from './fixtures/demo/history/contoso-web.json';

export type SceneReach = 'state' | 'boot' | 'driver';

/**
 * A step the demo plays in the page before the reveal: a click, or text typed into a field (set
 * through the element's own setter with one input event, so a controlled input takes it). Both
 * are state, not choreography: no timing, no per-keystroke replay.
 */
export type DemoBootStep =
  | {
      /** A CSS selector to click, usually a data-testid. */
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
 * A step only the capture rig can play. `boot.js` refuses these in a `state=` blob and refuses a
 * `driver` scene at `view=`, so they never reach a page that cannot honour them.
 */
export type RigStep =
  | { hover: string; waitFor?: string }
  | { contextmenu: string; waitFor?: string }
  | {
      /** A pointer drag from one element's centre to another's, or to a point given as fractions
       *  of the frame (a screen edge has no element). `hold` leaves the pointer down, so the still
       *  shows the gesture in flight (the drag overlay, the dock preview). */
      drag: { from: string; to: string | { x: number; y: number }; hold?: boolean };
      waitFor?: string;
    };

export interface DemoState {
  /** Merged into `window.__mockConfigOverrides`. Nested objects replace the demo defaults whole. */
  config?: Record<string, unknown>;
  /** Patches merged by id into the sample install's task rows (live or archived). */
  tasks?: Array<{ id: string } & Record<string, unknown>>;
  /**
   * Per-session patches on rows the sample install seeds. `activity` is written to the mock's
   * `activityCache`; `status` is written onto the session row, which is where the board reads a
   * queued or paused card from (`SessionDisplayState`). Both are patches rather than dataset rows
   * because the sample install has one suspended session and no queued one, and adding either
   * would change every docs figure already placed.
   */
  sessions?: Record<string, { activity?: 'thinking' | 'idle' | 'permission'; status?: 'running' | 'suspended' | 'queued' }>;
  /** `window.__mock*` globals the mock reads (diff fixtures, monitor rows, branch summary, ...). */
  seeds?: Record<string, unknown>;
  /** Synthetic clicks dispatched after the board renders and before the frame is revealed. */
  steps?: DemoBootStep[];
}

interface SceneBase extends DemoState {
  name: string;
  /** One line for the maintainer: what the scene is for and why it is shaped this way. */
  description: string;
  /** One or two sentences for the reader of a docs figure: what the frame shows, in the order the
   *  eye meets it. Ships to the site through scenes.json; never describes what is not on screen. */
  alt: string;
  /** The selector that must exist before the frame is built. */
  ready: string;
  /** The element a host may crop the figure to; its rect rides the ready message as fractions. */
  focus?: string;
  /** `empty` seeds no project at all: the welcome screen a first launch lands on. Default: the
   *  sample install. */
  install?: 'empty';
}

export type SceneDefinition =
  | (SceneBase & { reach: 'state'; steps?: never })
  | (SceneBase & { reach: 'boot'; steps: DemoBootStep[] })
  | (SceneBase & { reach: 'driver'; steps: Array<DemoBootStep | RigStep> });

export function isRigStep(step: DemoBootStep | RigStep): step is RigStep {
  return !('click' in step) && !('type' in step) && !('press' in step);
}

/**
 * The floating window's rect, centred like the window manager's default (`defaultWindowGeometry`
 * in window-manager/store/geometry.ts) but 0.64 of the frame wide where the default is 0.58. Every
 * task recording is 154 columns, and at the rig's launch (a real 2x scale, where the renderer
 * rounds the 12px Consolas cell to 6.5 CSS px) the default window fits 142, so the seed HOLDS the
 * recording's grid at 0.92 of the type size; at 0.64 the window fits 157, the hold lands at 154
 * with the native cell (a held grid never scales up), and the terminal reads at exactly the size
 * the board's bottom panel does. A floating terminal is the SUBJECT of its scene, which is why it
 * gets the width; a terminal beside a panel (the Browser pane, the Changes panel) is context and
 * stays held, see the Browser scene below.
 */
const MIDDLEWARE_FLOATING_GEOMETRY = { x: 0.18, y: 0.15, w: 0.64, h: 0.7 };

/**
 * One task-detail window restored on cold boot. `maximized` takes the full frame and ignores the
 * window's own geometry, so the floating rect rides along as `restoreGeometry`: un-maximizing lands
 * exactly where a floating window would have opened, which is what `maximizeWindow` itself stores.
 */
function middlewareWindowWorkspace(state: 'floating' | 'maximized') {
  return {
    version: 1,
    windows: [
      {
        taskId: TASK_MIDDLEWARE,
        kind: 'task-detail',
        title: 'Extract auth middleware',
        geometry: MIDDLEWARE_FLOATING_GEOMETRY,
        restoreGeometry: state === 'maximized' ? MIDDLEWARE_FLOATING_GEOMETRY : null,
        state,
      },
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: TASK_MIDDLEWARE,
  };
}

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
 * (anchored on the session id, which the workspace restore always treats as known) at the same
 * rect as the task window, for the same reason: the board around it is the point. The transcript
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

/**
 * The GLOBAL Command Terminal layout blob (`AppConfig.commandTerminalWorkspace`), one floating
 * window at the same rect as the task window and for the same reason: the contoso terminal
 * recording is 154 columns too, and the layer's default window (the same 0.58) would hold it at
 * 0.92. The layer restores this on its first open and re-pairs the slot to the live session.
 */
const COMMAND_TERMINAL_WORKSPACE = {
  version: 1,
  windows: [
    {
      taskId: COMMAND_TERMINAL_SLOT,
      kind: 'command-terminal' as const,
      title: commandTerminalTitle(COMMAND_TERMINAL_SLOT),
      geometry: MIDDLEWARE_FLOATING_GEOMETRY,
      restoreGeometry: null,
      state: 'floating' as const,
    },
  ],
  tileTree: null,
  tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
  focusedTaskId: COMMAND_TERMINAL_SLOT,
};

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

const SETTINGS_PANEL = '[data-testid="settings-panel"]';

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
// rendered tab in both themes; a row that only shows once a switch is on (the Memory tab's model
// picker, the Mobile tab's connection test) is left out rather than described.
const SETTINGS_TABS_SCENES: Record<string, { ready: string; alt: string }> = {
  general: { ready: '[data-testid="setting-row-project.location"]', alt: 'Settings on the General tab: the project\'s folder on disk, with a control to move it.' },
  // `ready` stays on the Theme row rather than the switch that now leads the tab: the grid is the
  // figure's subject, and both rows mount in the same commit.
  theme: { ready: '[data-testid="setting-row-theme"]', alt: 'Settings on the Theme tab: a Follow system appearance switch, then twelve theme tiles in Dark and Light groups, each painted in its own colors, with the current theme outlined.' },
  agent: { ready: '[data-testid="setting-row-project.defaultAgent"]', alt: 'Settings on the Agent tab: the project\'s default agent, its model and effort, the permission mode, and the path to the agent\'s CLI.' },
  git: { ready: '[data-testid="setting-row-git.worktreesEnabled"]', alt: 'Settings on the Git tab: worktrees on or off, automatic cleanup, the default base branch, files and a script for each new worktree, and how often PRs and the remote are refreshed.' },
  browser: { ready: '[data-testid="setting-row-browser.enabled"]', alt: 'Settings on the Browser tab: the Browser pane toggle, the default URL a task opens, and a control to clear the browser\'s data.' },
  shortcuts: { ready: '[data-testid="add-shortcut"]', alt: 'Settings on the Shortcuts tab: the project\'s command shortcuts, none configured here, with Add Shortcut and Presets controls.' },
  board: { ready: '[data-testid="setting-row-columnWidth"]', alt: 'Settings on the Board tab: column width, automatic board config sync, and switches for the terminal panel and the status bar.' },
  task: { ready: '[data-testid="setting-row-cardDensity"]', alt: 'Settings on the Task tab: card density, card preview, ticket numbers, and a switch for each pill the context bar shows.' },
  changes: { ready: '[data-testid="setting-row-diffViewMode"]', alt: 'Settings on the Changes tab: the diff layout, the default scope a Changes panel opens on, the whitespace, folding, wrapping, and narrow-pane options, and file sorting.' },
  terminal: { ready: '[data-testid="setting-row-terminal.shell"]', alt: 'Settings on the Terminal tab: the shell, the font size and family, the cursor style, backspace behavior, and the terminal colors.' },
  behavior: { ready: '[data-testid="setting-row-agent.maxConcurrentSessions"]', alt: 'Settings on the Behavior tab: the concurrent session cap, what happens when it is reached, idle focus and timeout, auto-resume, and how windows dismiss and restore.' },
  // The callout under Graphics acceleration only renders on an install Kangentic downgraded
  // itself, so the alt describes the two switches a normal install shows and not that line.
  performance: { ready: '[data-testid="setting-row-graphicsAccelerationEnabled"]', alt: 'Settings on the Performance tab: switches for graphics acceleration and for animations.' },
  hotkeys: { ready: '[data-testid="hotkeys-tab"]', alt: 'Settings on the Hotkeys tab: every keyboard shortcut with its current binding and a Rebind control, with a reset to defaults above the list.' },
  notifications: { ready: '[data-testid="setting-row-notifications.onAgentIdle"]', alt: 'Settings on the Notifications tab: for each event, whether it raises a desktop notification, a toast, or both, and how toasts are delivered.' },
  dictation: { ready: '[data-testid="setting-row-dictation.enabled"]', alt: 'Settings on the Dictation tab: the voice dictation toggle, the language, the live and refinement models, punctuation, push-to-talk, and auto-submit.' },
  memory: { ready: '[data-testid="setting-row-memory.indexingEnabled"]', alt: 'Settings on the Memory tab: conversation indexing for search, semantic search, and a control to rebuild the index.' },
  mcpServer: { ready: '[data-testid="setting-row-mcpServer.enabled"]', alt: 'Settings on the MCP Server tab: the server toggle and the available tools as pills grouped by area: tasks, board, sessions, and more.' },
  browserAutomation: { ready: '[data-testid="setting-row-browserAutomation.enabled"]', alt: 'Settings on the Agent Browser tab: whether agents may drive the embedded browser, and which actions they get: interaction, navigation, eval, and a localhost restriction.' },
  mobile: { ready: '[data-testid="setting-row-mobileBridge.enabled"]', alt: 'Settings on the Mobile Devices tab: the Mobile Bridge toggle, the relay it connects through, the Pair a device button, and the paired devices list, empty here.' },
  privacy: { ready: '[data-testid="privacy-contact-email"]', alt: 'Settings on the Privacy tab: what anonymous analytics are collected and what is not, how they work, and how to opt out.' },
  developer: { ready: '[data-testid="developer-tab"]', alt: 'Settings on the Developer tab: the activity debug overlay, persistent console logs, crash reports, and IPC recording.' },
};

function settingsScenes(): Record<string, SceneDefinition> {
  const scenes: Record<string, SceneDefinition> = {};
  for (const [tab, entry] of Object.entries(SETTINGS_TABS_SCENES)) {
    const name = `settings-${tab}`;
    scenes[name] = {
      name,
      reach: 'boot',
      description: `The Settings dialog on the ${tab} tab, opened with the gear and the tab button.`,
      alt: entry.alt,
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

export const SCENES: Record<string, SceneDefinition> = {
  // ---------------------------------------------------------------- first launch
  welcome: {
    name: 'welcome',
    reach: 'state',
    install: 'empty',
    description: 'The welcome screen a first launch lands on, with no project yet. Nothing from the sample install is seeded; the detection line reads the same agent list the sample install reports.',
    alt: 'The welcome screen on first launch: the Kangentic mark, an Open a project button, a line reporting the git and agent CLIs it found with a Show setup control, and three notes on what opening a project does.',
    ready: '[data-testid="welcome-open-project"]',
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
  },
  'board-filter': {
    name: 'board-filter',
    reach: 'boot',
    description: 'The board with its Filter popover open, for the board search section of the agent orchestration page.',
    alt: 'The board\'s Filter popover open: priority and label toggles that narrow which cards the columns show.',
    ready: '[data-testid="board-filter-btn-popover"]',
    focus: '[data-testid="board-filter-btn-popover"]',
    steps: [{ click: '[data-testid="board-filter-btn"]', waitFor: '[data-testid="board-filter-btn-popover"]' }],
  },
  'activity-tab': {
    name: 'activity-tab',
    reach: 'boot',
    description: 'The bottom panel on its Activity tab, the structured event list every running session feeds.',
    alt: 'The terminal panel on its Activity tab: a timeline of tool calls across every running session, each line stamped with its time, its session, and the tool, with a filter above it.',
    ready: '[data-testid="activity-filter"]',
    steps: [{ click: '[data-testid="terminal-activity-tab"]', waitFor: '[data-testid="activity-filter"]' }],
  },
  'session-states': {
    name: 'session-states',
    reach: 'boot',
    description: 'The contoso-web board with a paused card in Planning and a queued one in Code Review, for the Session Persistence page. The sample install has neither: its one suspended session is in online-boutique and nothing is queued. Both are row patches, not dataset rows, so every other figure is unchanged.',
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
  },
  'board-config-change': {
    name: 'board-config-change',
    reach: 'state',
    description: 'The board config reconciliation dialog, raised the way the desktop raises it: the seeded kangentic.json watch push, which App.tsx turns into a pending config change. Nothing in the demo draws the dialog itself.',
    alt: 'A dialog over the board headed Board configuration changed: it reports changes detected in kangentic.json and asks whether to apply the updated board configuration, with a checkbox to always apply automatically and Dismiss and Apply buttons.',
    seeds: { __mockBoardConfigChanged: PROJECT_CONTOSO },
    ready: '[data-testid="config-change-dialog"]',
    focus: '[data-testid="config-change-dialog"]',
  },
  announcements: {
    name: 'announcements',
    reach: 'state',
    description: 'The board with the app\'s own announcement feed active: the banner strip across the top of the content column and the unread badge on the title bar\'s megaphone. OS notifications cannot show in a browser; this is the in-app half of the notifications page.',
    alt: 'The board with an announcement banner across the top of the content area, a Learn more link and a dismiss control on it, and the megaphone in the title bar carrying an unread badge.',
    seeds: { __mockActiveAnnouncements: ANNOUNCEMENTS, __mockAnnouncementHistory: ANNOUNCEMENT_HISTORY },
    ready: '[data-testid="announcement-banner"]',
    focus: '[data-testid="announcement-banner"]',
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
  },

  // ---------------------------------------------------------------- the task window
  task: {
    name: 'task',
    reach: 'state',
    description: 'A task-detail window open on "Extract auth middleware", its agent working in the terminal.',
    alt: 'A task window floating over the board. Claude Code is extracting the auth middleware in the terminal, and the context bar under it reports the model, the context window used, and the cost so far.',
    // Floating on purpose: the board around it is the point. The rect is the wider one
    // MIDDLEWARE_FLOATING_GEOMETRY explains, so the terminal is at native type.
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') } },
    ready: '[data-testid="task-title-text"]',
  },
  'windows-tiled': {
    name: 'windows-tiled',
    reach: 'state',
    description: 'The middleware and api-client task windows tiled side by side in the footprint a dock produces (TILED_PAIR_RECT). Both sessions carry a recording made at the tiled width (manifest geometry taskWindowTiled), so both terminals are at native type; the single recording would be held at two-thirds.',
    alt: 'Two task windows tiled side by side over the board, Extract auth middleware on the left and Generate API client types on the right, each with Claude Code working in its terminal and a context bar below it showing the model, context use, and cost.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: tiledPairWorkspace() } },
    ready: '[data-testid^="tile-splitter-"]',
  },
  // The Browser and Changes scenes below keep a held terminal on purpose. There the PANEL is the
  // subject and the terminal beside it is context, and giving the terminal the width its native
  // type needs squeezes the subject instead (the address bar and the note field truncate, a split
  // diff clips mid-line). A pane narrower than the single recording takes the tiled one (the
  // seed's layoutFor), so these terminals hold the middleware session's tiled recording at about
  // 0.9 of the type size rather than the single at 0.67. The seed's floor (HOLD_MIN_SCALE in
  // demo-dataset.ts) is what keeps that context legible: below 0.6 the terminal would play frames
  // at native type, which in a narrow pane cuts every row at the edge.
  browser: {
    name: 'browser',
    reach: 'state',
    description: 'The task window with the Browser pane open on the project\'s dev URL. The pane is the real renderer; its guest is demo/webview-shim.js\'s iframe onto a bundled copy of what the scaffold app renders at that URL, since no browser has Electron\'s webview. The terminal beside it is held at 0.71 type (the comment above).',
    alt: 'A task window with the Browser pane open beside the agent\'s terminal: an address bar on the project\'s local dev server, the page it serves loaded beneath, zoom and Close browser controls above, and Draw, Inspect, and a note field for the agent below.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: JSON.stringify({ browserOpen: true, dividerRatio: 0.45 }) }],
    ready: '[data-testid="browser-webview"] iframe',
  },

  dictation: {
    name: 'dictation',
    reach: 'boot',
    description: 'Push-to-talk held over the middleware task window, the live chip anchored to its terminal. The hotkey is the default Mouse:Back, pressed and never released, and the whole pipeline runs over a silent microphone (demo/README.md, Dictation). The transcript itself lands in the terminal on release, as the CLI\'s own echo, so it is not part of this frame.',
    alt: 'A task window with the dictation chip anchored to the bottom of its terminal: a live recording dot beside Listening, a hint that releasing the key sends the words to the agent, and a Clear control.',
    // Nested objects replace the demo defaults whole (boot.js merges config shallowly), so the
    // whole dictation block rides along with only `enabled` flipped.
    config: {
      workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') },
      dictation: { ...DEFAULT_CONFIG.dictation, enabled: true },
    },
    ready: '[data-testid="dictation-live-chip"]',
    focus: '[data-testid="dictation-live-chip"]',
    steps: [{ press: 'Mouse:Back', waitFor: '[data-testid="dictation-live-chip"]' }],
  },

  // ---------------------------------------------------------------- the conversation viewer
  conversation: {
    name: 'conversation',
    reach: 'state',
    description: 'The conversation viewer open on the middleware session, floating over the board at the task window\'s rect. The transcript is the one recorded beside the session (the manifest\'s transcript flag; main\'s own parser over the agent\'s history file), so the viewer shows what the desktop would for this run.',
    alt: 'The conversation viewer floating over the board, open on Extract auth middleware and scrolled to Claude Code\'s closing message: what changed in the middleware and the routes, the choices it made, and a caveat on the test run, with a search field above.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: conversationWindowWorkspace() } },
    // An assistant row exists only once the transcript has been fetched and rendered, so the
    // reveal waits for the conversation rather than for an empty window.
    ready: '[data-testid="conversation-row-assistant"]',
    focus: '[data-testid="conversation-window"]',
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
    // 0.42 of the width and is held at 0.67 type (the comment above the Browser scene).
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'branch', changesViewedFiles: ['server/middleware/auth.ts'] }) }],
    ready: '[data-testid="changes-scope-branch"][aria-checked="true"]',
  },
  'changes-working': {
    name: 'changes-working',
    reach: 'state',
    description: 'The same window on the Working tab: the agent\'s unstaged edits. The seed splits the recorded diff by status (modified files unstaged, the new file staged), so Working and Staged show different files and Branch shows both.',
    alt: 'The Changes panel on the Working tab: the agent\'s unstaged edit to server/routes.ts, open in the diff pane, with the new middleware file listed under Staged instead.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'working' }) }],
    ready: '[data-testid="changes-scope-working"][aria-checked="true"]',
  },
  'changes-staged': {
    name: 'changes-staged',
    reach: 'state',
    description: 'The same window on the Staged tab: the new file the agent added (git add makes a new file tracked, which is what stages it).',
    alt: 'The Changes panel on the Staged tab: the new server/middleware/auth.ts the agent added, shown as an all-new file in the diff pane.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'staged', changesSelectedFile: 'server/middleware/auth.ts' }) }],
    ready: '[data-testid="changes-scope-staged"][aria-checked="true"]',
  },
  'changes-history': {
    name: 'changes-history',
    reach: 'state',
    description: 'The Changes panel with History expanded and the commit that wired the routes selected, so the diff pane shows that commit rather than the working tree. The graph is the scaffold\'s real history (scripts/capture-demo-history.mjs).',
    alt: 'The Changes panel with its History section expanded: the branch\'s commits listed under Uncommitted changes with the routes commit selected, the file tree showing the two files that commit added, and the diff pane showing routes.ts as that commit introduced it.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [{ id: TASK_MIDDLEWARE, detail_view_state: middlewareChangesStateWith({ changesScope: 'branch', changesHistoryOpen: true, changesSelectedCommit: ROUTES_COMMIT.hash }) }],
    ready: '[data-testid="changes-file-tree"]',
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
  },

  // ---------------------------------------------------------------- the Agent Monitor
  monitor: {
    name: 'monitor',
    reach: 'boot',
    description: 'The Agent Monitor over all three projects, every session in its live state. The open flag is not persisted, so it is one click.',
    alt: 'The Agent Monitor over all three projects: summary tiles for idle, active, and paused sessions, then a card per session grouped by project, each with its column, its latest output, and its model and context use.',
    ready: '[data-testid="monitor-card"]',
    steps: [{ click: '[data-testid="agent-monitor-button"]', waitFor: '[data-testid="monitor-page"]' }],
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
  },

  // ---------------------------------------------------------------- the Command Terminal
  'command-terminal': {
    name: 'command-terminal',
    reach: 'boot',
    description: 'One Command Terminal window over the blurred board, on the contoso terminal session the dataset seeds. The layer\'s open state is component state, so it is one click; the window\'s rect is the global layout blob (COMMAND_TERMINAL_WORKSPACE), restored on that open.',
    alt: 'A Command Terminal window open over the blurred board, running Claude Code in the project root, which has just summarized the repository and listed its npm scripts; the header carries the branch pill and the window controls.',
    config: { commandTerminalWorkspace: COMMAND_TERMINAL_WORKSPACE },
    ready: '[data-testid="command-terminal-window"]',
    steps: [{ click: '[data-testid="quick-session-button"]', waitFor: '[data-testid="command-terminal-window"]' }],
  },
  'command-terminal-tiled': {
    name: 'command-terminal-tiled',
    reach: 'boot',
    description: 'Two Command Terminals tiled in one footprint: the toggle reattaches the contoso terminal session, then New terminal docks a second beside it and boots the project default agent from the boot recorded at the tiled width. The first window switches to its own tiled recording as it narrows (the seed\'s layoutFor), so both are at native type. The second terminal has no inline frame, so a still of this scene fetches that boot\'s final frame.',
    alt: 'Two Command Terminal windows tiled side by side: on the left Claude Code has summarized the repository and listed its npm scripts in a table, on the right a second Claude Code has just started in the same project root and waits at its prompt.',
    config: { commandTerminalWorkspace: COMMAND_TERMINAL_WORKSPACE },
    // The second window's model pill, which the context bar shows only once the session's first
    // usage lands, a beat after its terminal mounts (the seed pushes it 1.2 s after the boot's
    // first output, as main's status-line push would): a still shot before that would show the
    // "Starting agent" spinner in the bar rather than the pills.
    ready: '[data-command-slot="slot-2"] [data-testid^="context-bar-model-"]',
    steps: [
      { click: '[data-testid="quick-session-button"]', waitFor: '[data-testid="command-terminal-window"]' },
      { click: '[data-testid="quick-session-new-terminal"]', waitFor: '[data-command-slot="slot-2"] [data-testid^="context-bar-model-"]' },
    ],
  },

  // ---------------------------------------------------------------- views and dialogs
  usage: {
    name: 'usage',
    reach: 'boot',
    description: 'The Usage dashboard over all projects for the week, from the seeded fourteen-day series. The scope and period persist; the open flag does not.',
    alt: 'The Usage dashboard for all projects this week: total tokens, cost, and burn rate tiles, a row of session, tool, and file counts, cost per day by model with cumulative spend beside it, and the by-agent, by-model, and by-effort breakdowns below.',
    config: { usageStatsScope: 'all', usageStatsPeriod: 'week' },
    ready: '[data-testid="stats-filter-row"]',
    steps: [{ click: '[data-testid="usage-stats-button"]', waitFor: '[data-testid="stats-page"]' }],
  },
  backlog: {
    name: 'backlog',
    reach: 'boot',
    description: 'The Backlog view with the six seeded rows. The active view is store state, so it is one click on the view toggle.',
    alt: 'The Backlog view: a table of unscheduled items with a priority badge, title, description, labels, and age for each, under a toolbar with search, filter, New Task, and Import Tasks.',
    ready: '[data-testid="backlog-task-row"]',
    steps: [{ click: '[data-testid="view-toggle-backlog"]', waitFor: '[data-testid="backlog-view"]' }],
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
  },
  'new-task': {
    name: 'new-task',
    reach: 'boot',
    description: 'The New Task dialog, empty, opened from the To Do column\'s Add task control.',
    alt: 'The New Task dialog: a title field, a description editor that takes dropped files, priority and labels, the Branch row with the branch it will create from main in a new worktree, and the choice between the column\'s settings and an agent override.',
    ready: '[data-testid="new-task-dialog"]',
    focus: '[data-testid="new-task-dialog"]',
    steps: [{ click: '[data-testid="swimlane-add-task"]', waitFor: '[data-testid="new-task-dialog"]' }],
  },
  'edit-columns': {
    name: 'edit-columns',
    reach: 'boot',
    description: 'The Column Manager (the docs call it Edit Columns) on the Code Review column, as the sample install leaves it: no automation configured, so both slots read Add automation. The column-automation scene is the configured counterpart.',
    alt: 'The Column Manager dialog with the Code Review column selected: its name, icon, and color, the agent that starts when a task enters it, and the automation slots for entering and leaving the column.',
    ready: '[data-testid="board-manager-dialog"]',
    focus: '[data-testid="board-manager-dialog"]',
    steps: [{ click: '[data-swimlane-name="Code Review"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' }],
  },
  // ---------------------------------------------------------------- column workflow
  // An automation and a handed-off context are per-scene seeds, never dataset rows: an automation
  // draws a glyph in the BOARD column header (AutomationGlyph), so seeding one into the sample
  // install would change every docs figure already placed and every poster in the release zip.
  // The two ids below go through demoLaneId, which the registry test resolves against the install.
  'column-automation': {
    name: 'column-automation',
    reach: 'boot',
    description: 'The Column Manager on Code Review with a Send message automation configured on enter, for the Workflows page and the Workflow Automation showcase. The sample install configures none, so this is a scene seed.',
    alt: 'The Column Manager on the Code Review column: its name, icon and color, the agent that starts when a task enters, and an Automations pane holding one Send message row on enter with the message it sends, edit and delete controls, and its switch on.',
    seeds: {
      __mockAutomations: [
        {
          swimlane_id: demoLaneId(PROJECT_CONTOSO, 'review'),
          name: 'Ask for a review pass',
          type: 'send_message',
          trigger: 'enter',
          config: { message: 'Review the diff against main and fix anything you would block a pull request on.', mode: 'immediate' },
        },
      ],
    },
    ready: '[data-testid="column-automation-row"]',
    focus: '[data-testid="board-manager-dialog"]',
    steps: [{ click: '[data-swimlane-name="Code Review"] [data-testid="edit-column-btn"]', waitFor: '[data-testid="board-manager-dialog"]' }],
  },
  'column-handoff': {
    name: 'column-handoff',
    reach: 'boot',
    description: 'The Column Manager\'s All columns table with handoff context on for Code Review, for the Handoff Context showcase. Every lane in the sample install has it off, so this is a scene seed. The TABLE, not the column form: in the form the toggle sits 996px down a 1000px frame, so the figure would show everything except its own subject.',
    alt: 'The Column Manager on its All columns table: a row per column carrying the agent that starts there, the model, effort and permissions it uses, a handoff switch, the session it runs in, and what runs on enter and on exit. Handoff is on for Code Review alone.',
    seeds: {
      __mockSwimlanePatches: { [demoLaneId(PROJECT_CONTOSO, 'review')]: { handoff_context: true } },
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
  },

  'completed-tasks': {
    name: 'completed-tasks',
    reach: 'boot',
    description: 'The Completed Tasks dialog over the archived contoso rows, opened from the Done column\'s Completed header.',
    alt: 'The Completed Tasks dialog: a table of archived tasks with columns for cost, duration, tokens, tools, files, and lines, when each was completed, and restore and delete controls on every row.',
    ready: '[data-testid="completed-task-checkbox"]',
    focus: '[data-testid="completed-tasks-dialog"]',
    steps: [{ click: '[data-testid="expand-completed-btn"]', waitFor: '[data-testid="completed-tasks-dialog"]' }],
  },

  // ---------------------------------------------------------------- settings, one per tab
  ...settingsScenes(),

  // ---------------------------------------------------------------- rig only
  'card-drag': {
    name: 'card-drag',
    reach: 'driver',
    description: 'A card lifted out of Planning and held over Executing, for the drag-to-start figure. dnd-kit needs a real pointer sequence, so the rig plays it and stops before the drop.',
    alt: 'A task card mid-drag from Planning into Executing, the card lifted and tilted, the Executing column highlighted as the drop target.',
    ready: '.drag-overlay',
    steps: [{ drag: { from: `[data-task-id="${TASK_WEBSOCKET}"]`, to: '[data-swimlane-name="Executing"]', hold: true }, waitFor: '.drag-overlay' }],
  },
  'card-menu': {
    name: 'card-menu',
    reach: 'driver',
    description: 'A card\'s context menu, which opens on right-click only.',
    alt: 'A task card\'s right-click menu open over the board: Edit, a Move to list of the other columns, Backlog, Archive, and Delete.',
    ready: '[data-testid="task-context-menu"]',
    focus: '[data-testid="task-context-menu"]',
    steps: [{ contextmenu: `[data-task-id="${TASK_AUTH}"]`, waitFor: '[data-testid="task-context-menu"]' }],
  },
  'window-dock': {
    name: 'window-dock',
    reach: 'driver',
    description: 'The task window dragged toward the right edge with the snap preview armed, for the docking figure.',
    alt: 'A task window being dragged toward the edge of the board, the docking preview showing where it will snap.',
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') } },
    ready: '[data-testid="snap-preview"]',
    // The snap zone is the last few pixels before the edge; the point is a fraction of the frame
    // because an edge has no element to name.
    steps: [{ drag: { from: '[data-testid="task-detail-titlebar"]', to: { x: 0.997, y: 0.5 }, hold: true }, waitFor: '[data-testid="snap-preview"]' }],
  },
};
