/**
 * The scene registry: one catalog, two consumers.
 *
 * The web build (demo/) resolves `view=<name>` through this map at boot with no driver, and the
 * capture rig (#632) resolves the same names with Playwright behind it. Every entry is DATA on top
 * of the sample install in helpers/demo-dataset.ts: config overrides, task-row patches, session
 * activity states, `window.__mock*` seeds the mock reads, and at most a short list of synthetic
 * clicks the demo dispatches before it reveals the frame. No code travels through a scene, so the
 * same shape can ride a `state=` URL parameter verbatim.
 *
 * `reach` says who can build the scene:
 *   state   config and rows alone; nothing is clicked
 *   boot    state plus a few pre-reveal clicks (the demo runs them; the rig runs them too)
 *   driver  needs a hover, a drag, or an open menu; the capture rig only, the demo refuses it
 *
 * No Node imports on purpose: demo/vite.config.mts serializes this module into the static build,
 * and the capture rig reads it as well.
 */
import { PROJECT_CONTOSO, TASK_MIDDLEWARE } from './helpers/demo-dataset';

export type SceneReach = 'state' | 'boot' | 'driver';

export interface DemoBootStep {
  /** A CSS selector to click, usually a data-testid. */
  click: string;
  /** A selector that must appear before the next step (or the reveal). */
  waitFor?: string;
}

export interface DemoState {
  /** Merged into `window.__mockConfigOverrides`. Nested objects replace the demo defaults whole. */
  config?: Record<string, unknown>;
  /** Patches merged by id into the sample install's task rows (live or archived). */
  tasks?: Array<{ id: string } & Record<string, unknown>>;
  /** Per-session activity state, written to the mock's `activityCache`. */
  sessions?: Record<string, { activity?: 'thinking' | 'idle' | 'permission' }>;
  /** `window.__mock*` globals the mock reads (diff fixtures, monitor rows, branch summary, ...). */
  seeds?: Record<string, unknown>;
  /** Synthetic clicks dispatched after the board renders and before the frame is revealed. */
  steps?: DemoBootStep[];
}

export interface SceneDefinition extends DemoState {
  name: string;
  reach: SceneReach;
  /** One line; doubles as the alt-text seed for a generated still. */
  description: string;
}

const MIDDLEWARE_CASCADE_GEOMETRY = { x: 0.21, y: 0.15, w: 0.58, h: 0.7 };

/**
 * One task-detail window restored on cold boot. `maximized` takes the full frame and ignores the
 * window's own geometry, so the cascade rect rides along as `restoreGeometry`: un-maximizing lands
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
        geometry: MIDDLEWARE_CASCADE_GEOMETRY,
        restoreGeometry: state === 'maximized' ? MIDDLEWARE_CASCADE_GEOMETRY : null,
        state,
      },
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: TASK_MIDDLEWARE,
  };
}

export const SCENES: Record<string, SceneDefinition> = {
  board: {
    name: 'board',
    reach: 'state',
    description: 'The contoso-web board with agents running across Planning, Executing, Code Review, and Testing, the bottom panel on the working auth-middleware session.',
    // The panel picks its own first tab, and the app prefers whatever needs a human
    // (derivePanelSessionId), which lands on the WebSocket session sitting at a prompt. That is
    // right for a desktop a user is returning to, and wrong for a frame someone is meeting the
    // product through: the panel is the largest thing on the page and it should show an agent
    // mid-turn. One click, the same one a visitor could make.
    steps: [{ click: '[data-session-id="sess-cw-middleware"]', waitFor: '[data-session-id="sess-cw-middleware"]' }],
  },
  task: {
    name: 'task',
    reach: 'state',
    description: 'A task-detail window open on "Extract auth middleware", its agent working in the terminal.',
    // Floating on purpose: the board around it is the point, and a terminal reads fine at this size.
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('floating') } },
  },
  changes: {
    name: 'changes',
    reach: 'state',
    description: 'The task-detail window maximized with the Changes panel open on the Branch tab, server/routes.ts selected. The diff is the one the recorded session left in its working tree (seeded per task by the dataset).',
    // Maximized, unlike the `task` scene. A split diff wants three columns at once (the agent's
    // terminal, the file tree, the hunks), and in the cascade rect at the frame's 1600x1000 the
    // diff pane clips mid-line. The maximize control is right there in the header, so a visitor
    // can put it back; this only picks the state the panel is legible in.
    config: { workspaceByProject: { [PROJECT_CONTOSO]: middlewareWindowWorkspace('maximized') } },
    tasks: [
      {
        id: TASK_MIDDLEWARE,
        detail_view_state: JSON.stringify({
          changesOpen: true,
          changesScope: 'branch',
          changesViewMode: 'split',
          changesSelectedFile: 'server/routes.ts',
          dividerRatio: 0.42,
        }),
      },
    ],
    seeds: {
      // The task branch carries the agent's uncommitted work, so it is 0 ahead of main and the
      // last commit is the scaffold's own (scripts/demo-repos/contoso-web, as the capture rig
      // committed it).
      __mockBranchSummary: {
        currentBranch: 'extract-auth-middleware',
        ahead: 0,
        behind: 0,
        lastCommit: { hash: '173a75e6ac79d3e1411b67b75309f57732bf41e8', shortHash: '173a75e', subject: 'Initial import', authorName: 'Dev', authorTimestamp: 1789184965 },
      },
    },
  },
  monitor: {
    name: 'monitor',
    reach: 'boot',
    description: 'The Agent Monitor over all three projects, every session in its live state.',
    steps: [{ click: '[data-testid="agent-monitor-button"]', waitFor: '[data-testid="monitor-page"]' }],
  },
};
