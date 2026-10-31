/**
 * The cycle keys (GitHub #176): Ctrl+Tab walks this project's terminals,
 * Ctrl+Shift+Tab walks every project's, and Ctrl+` / Ctrl+Shift+` walk the
 * projects. A terminal is a running board agent (in panel-tab order) or a
 * Command Terminal terminal (by slot). The orders themselves are pinned in
 * tests/unit/cycle-targets.test.ts; this spec drives the landing in the real
 * renderer over the mock.
 *
 * Seed: three projects in sidebar order A, B, C. A has two agents and a Command
 * Terminal terminal in slot-1, B has one agent, C has only a Command Terminal
 * terminal. None has a saved window layout, so a switch into B or C takes the
 * restore's early return, the path an all-projects landing has to hear too.
 *
 * Each test owns its browser, so the file runs in parallel. Every wait is a
 * poll on store state or the DOM, never a timed sleep
 * (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, settleFrames, writtenToSession } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_A = `proj-cycle-a-${RUN_ID}`;
const PROJECT_B = `proj-cycle-b-${RUN_ID}`;
const PROJECT_C = `proj-cycle-c-${RUN_ID}`;
const TASK_A1 = `task-cycle-a1-${RUN_ID}`;
const TASK_A2 = `task-cycle-a2-${RUN_ID}`;
const TASK_B1 = `task-cycle-b1-${RUN_ID}`;
const SESSION_A1 = `sess-cycle-a1-${RUN_ID}`;
const SESSION_A2 = `sess-cycle-a2-${RUN_ID}`;
const SESSION_B1 = `sess-cycle-b1-${RUN_ID}`;
const SESSION_COMMAND_A = `sess-cycle-cmd-a-${RUN_ID}`;
const SESSION_COMMAND_C = `sess-cycle-cmd-c-${RUN_ID}`;

const STEP_TIMEOUT_MS = 8000;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    [['${PROJECT_A}', 'Cycle A'], ['${PROJECT_B}', 'Cycle B'], ['${PROJECT_C}', 'Cycle C']].forEach(function (entry, index) {
      state.projects.push({
        id: entry[0],
        name: entry[1] + ' ${RUN_ID}',
        path: '/mock/' + entry[0],
        github_url: null,
        default_agent: 'claude',
        default_model: null,
        default_effort: null,
        group_id: null,
        position: index,
        last_opened: ts,
        created_at: ts,
      });
    });

    var executingLaneId = null;
    state.DEFAULT_SWIMLANES.forEach(function (template, index) {
      var laneId = 'lane-cycle-${RUN_ID}-' + index;
      if (template.name === 'Executing') executingLaneId = laneId;
      state.swimlanes.push(Object.assign({}, template, { id: laneId, position: index, created_at: ts }));
    });

    function addAgent(projectId, taskId, sessionId, title, position) {
      state.sessions.push({
        id: sessionId, taskId: taskId, projectId: projectId, pid: 7300 + position,
        status: 'running', shell: 'bash', cwd: '/mock/' + projectId,
        startedAt: ts, exitCode: null, resuming: false, transient: false,
      });
      state.tasks.push({
        id: taskId, display_id: position + 1, title: title, description: '',
        swimlane_id: executingLaneId, position: position, agent: 'claude',
        session_id: sessionId, worktree_path: null, branch_name: null,
        pr_number: null, pr_url: null, base_branch: null, archived_at: null,
        created_at: ts, updated_at: ts,
      });
    }

    function addCommandTerminal(projectId, sessionId) {
      state.sessions.push({
        id: sessionId, taskId: sessionId, projectId: projectId, pid: null,
        status: 'running', shell: '/bin/bash', cwd: '/mock/' + projectId,
        startedAt: ts, exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-1', commandTerminalBranch: 'main',
        commandTerminalLabel: null, isolatedSwimlaneId: null, agentSessionId: null,
      });
    }

    addAgent('${PROJECT_A}', '${TASK_A1}', '${SESSION_A1}', 'Cycle A1 ${RUN_ID}', 0);
    addAgent('${PROJECT_A}', '${TASK_A2}', '${SESSION_A2}', 'Cycle A2 ${RUN_ID}', 1);
    addAgent('${PROJECT_B}', '${TASK_B1}', '${SESSION_B1}', 'Cycle B1 ${RUN_ID}', 2);
    addCommandTerminal('${PROJECT_A}', '${SESSION_COMMAND_A}');
    addCommandTerminal('${PROJECT_C}', '${SESSION_COMMAND_C}');

    // A1 is the one idle agent, so the panel starts on it.
    state.activityCache['${SESSION_A1}'] = 'idle';
    state.activityCache['${SESSION_A2}'] = 'thinking';
    state.activityCache['${SESSION_B1}'] = 'thinking';

    return { currentProjectId: '${PROJECT_A}' };
  });
`;

interface LaunchOptions {
  /** A second `__mockPreConfigure` call, run after the base seed. */
  extraPreConfig?: string;
  /** The sessions that call adds, so their launch overlays lift too. */
  extraSessionIds?: string[];
  viewport?: { width: number; height: number };
}

async function launch(options: LaunchOptions = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1600, height: 1100 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  if (options.extraPreConfig) await page.addInitScript(options.extraPreConfig);
  await gotoVite(page);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  // Lift every launch overlay, as a long-running session already would, so each
  // terminal mounts a real xterm on its first arrival.
  await page.evaluate((sessionIds) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { markFirstOutput: (id: string) => void } } };
    }).__zustandStores;
    for (const id of sessionIds) stores.session.getState().markFirstOutput(id);
  }, [SESSION_A1, SESSION_A2, SESSION_B1, SESSION_COMMAND_A, SESSION_COMMAND_C, ...(options.extraSessionIds ?? [])]);
  return { browser, page };
}

interface Snapshot {
  projectId: string | null;
  activeSessionId: string | null;
  commandBarVisible: boolean;
  activeView: string;
  /** Anchor of the focused Command Terminal window (its slot), or null. */
  focusedCommandAnchor: string | null;
  /** Anchor of the focused board window (its task id), or null. */
  focusedBoardAnchor: string | null;
  /** Anchors of every board window. */
  boardAnchors: string[];
  /** The `window-frame-<id>` test id of the frame holding keyboard focus, or null. */
  focusedFrameTestId: string | null;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    interface WindowState { focusedWindowId: string | null; windows: Record<string, { anchor: string }> }
    const stores = (window as unknown as {
      __zustandStores: {
        project: { getState: () => { currentProject: { id: string } | null } };
        session: { getState: () => { activeSessionId: string | null; commandBarVisible: boolean } };
        board: { getState: () => { activeView: string } };
        window: { getState: () => WindowState };
        commandWindow: { getState: () => WindowState };
      };
    }).__zustandStores;
    const anchorOf = (state: WindowState): string | null =>
      state.focusedWindowId ? state.windows[state.focusedWindowId]?.anchor ?? null : null;
    const sessionState = stores.session.getState();
    const focusedFrame = document.activeElement?.closest('[data-testid^="window-frame-"]');
    return {
      projectId: stores.project.getState().currentProject?.id ?? null,
      activeSessionId: sessionState.activeSessionId,
      commandBarVisible: sessionState.commandBarVisible,
      activeView: stores.board.getState().activeView,
      focusedCommandAnchor: anchorOf(stores.commandWindow.getState()),
      focusedBoardAnchor: anchorOf(stores.window.getState()),
      boardAnchors: Object.values(stores.window.getState().windows).map((managed) => managed.anchor),
      focusedFrameTestId: focusedFrame?.getAttribute('data-testid') ?? null,
    };
  });
}

/** The window id of the focused window in one layer, for matching its frame. */
async function focusedWindowId(page: Page, layer: 'window' | 'commandWindow'): Promise<string | null> {
  return page.evaluate((storeKey) => {
    const store = (window as unknown as {
      __zustandStores: Record<string, { getState: () => { focusedWindowId: string | null } }>;
    }).__zustandStores[storeKey];
    return store.getState().focusedWindowId;
  }, layer);
}

async function setActiveSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as {
      __zustandStores: { session: { getState: () => { selectActiveSession: (sessionId: string) => void } } };
    }).__zustandStores.session.getState().selectActiveSession(id);
  }, sessionId);
}

/** The panel's xterm for one session (its tab button carries the same id but no xterm). */
function panelTerminal(page: Page, sessionId: string) {
  return page.locator(`[data-session-id="${sessionId}"] .xterm-helper-textarea`).first();
}

/** A press that crosses a project holds several polls in a row, each up to
 *  STEP_TIMEOUT_MS, so those tests get more than the ui project's 15s default. */
const MULTI_STEP_TEST_TIMEOUT_MS = 40_000;

/** What the project switch helpers below leave on the page. */
interface ProjectOpenScope {
  electronAPI: { projects: { open: (projectId: string) => Promise<void> } };
  __heldProjectOpens?: Array<{ projectId: string; release: () => Promise<void> }>;
  __failedProjectOpens?: string[];
}

/**
 * Hold every `projects.open` call open, as a slow switch would, until
 * `releaseProjectOpens`. The store's `openProject` is left waiting on it, so
 * `currentProject` stays on the project being left while the cycle key's
 * landing is still pending. The shared mock is untouched: this wraps it here.
 */
async function holdProjectOpens(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as ProjectOpenScope;
    const projectsApi = scope.electronAPI.projects;
    const realOpen = projectsApi.open;
    const held: NonNullable<ProjectOpenScope['__heldProjectOpens']> = [];
    scope.__heldProjectOpens = held;
    projectsApi.open = (projectId: string) => new Promise<void>((resolve) => {
      held.push({
        projectId,
        release: async () => {
          await realOpen.call(projectsApi, projectId);
          resolve();
        },
      });
    });
  });
}

/** The project ids of the held `projects.open` calls, in call order. */
async function heldProjectOpenIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as ProjectOpenScope).__heldProjectOpens?.map((held) => held.projectId) ?? []);
}

/** Let the held opens through one at a time in call order, as main serializes them. */
async function releaseProjectOpens(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const held = (window as unknown as ProjectOpenScope).__heldProjectOpens ?? [];
    for (const entry of held.splice(0)) await entry.release();
  });
}

/**
 * Make every `projects.open` call fail with a plain error. `openProject` takes
 * its generic failure branch (a toast, outcome `failed`) and the project never
 * changes. A missing-path failure would raise a dialog, which holds the cycle
 * keys off, so it is not the failure to use here.
 */
async function failProjectOpens(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as ProjectOpenScope;
    const failed: string[] = [];
    scope.__failedProjectOpens = failed;
    scope.electronAPI.projects.open = async (projectId: string) => {
      failed.push(projectId);
      throw new Error('Mock project open failed');
    };
  });
}

async function failedProjectOpenIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as ProjectOpenScope).__failedProjectOpens ?? []);
}

/** From A2 in the panel, one Ctrl+Shift+Tab reaches A's Command Terminal, the
 *  last stop before project B in the all-projects list. */
async function stepToProjectACommandTerminal(page: Page): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
  await setActiveSession(page, SESSION_A2);
  await panelTerminal(page, SESSION_A2).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await panelTerminal(page, SESSION_A2).focus();
  await page.keyboard.press('Control+Shift+Tab');
  await expect.poll(async () => (await snapshot(page)).focusedCommandAnchor, { timeout: STEP_TIMEOUT_MS }).toBe('slot-1');
}

interface CommandWindowState {
  expandedWindowId: string | null;
  windows: Array<{ id: string; anchor: string }>;
}

async function commandWindowState(page: Page): Promise<CommandWindowState> {
  return page.evaluate(() => {
    const state = (window as unknown as {
      __zustandStores: { commandWindow: { getState: () => {
        expandedWindowId: string | null;
        windows: Record<string, { id: string; anchor: string }>;
      } } };
    }).__zustandStores.commandWindow.getState();
    return {
      expandedWindowId: state.expandedWindowId,
      windows: Object.values(state.windows).map((managed) => ({ id: managed.id, anchor: managed.anchor })),
    };
  });
}

/** The board window open on a task, if any, with whether it is parked. */
async function boardWindowForTask(page: Page, taskId: string): Promise<{ id: string; parked: boolean } | null> {
  return page.evaluate((anchor) => {
    const windows = (window as unknown as {
      __zustandStores: { window: { getState: () => {
        windows: Record<string, { id: string; anchor: string; parked?: boolean }>;
      } } };
    }).__zustandStores.window.getState().windows;
    const found = Object.values(windows).find((managed) => managed.anchor === anchor);
    return found ? { id: found.id, parked: found.parked === true } : null;
  }, taskId);
}

async function openTaskWindow(page: Page, taskId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as {
      __zustandStores: { session: { getState: () => { setDetailTaskId: (taskId: string) => void } } };
    }).__zustandStores.session.getState().setDetailTaskId(id);
  }, taskId);
  await expect.poll(async () => (await boardWindowForTask(page, taskId)) !== null, { timeout: STEP_TIMEOUT_MS }).toBe(true);
}

async function detailTaskId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as {
    __zustandStores: { session: { getState: () => { detailTaskId: string | null } } };
  }).__zustandStores.session.getState().detailTaskId);
}

test('Ctrl+Tab walks the agents, then the Command Terminal, wraps, and sends the terminal no Tab', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await panelTerminal(page, SESSION_A1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A1).focus();
    await page.evaluate(() => {
      (window as unknown as { electronAPI: { sessions: { __writeCalls: unknown[] } } }).electronAPI.sessions.__writeCalls.length = 0;
    });

    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A2);

    // The Command Terminal is hidden: the press opens it and lands on slot-1 once
    // its window exists, with the keyboard in that terminal.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { visible: state.commandBarVisible, anchor: state.focusedCommandAnchor };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ visible: true, anchor: 'slot-1' });
    const commandWindowId = await focusedWindowId(page, 'commandWindow');
    await expect.poll(async () => (await snapshot(page)).focusedFrameTestId, { timeout: STEP_TIMEOUT_MS })
      .toBe(`window-frame-${commandWindowId}`);

    // Past the last terminal it wraps to the first agent and hides the panel over the board.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { visible: state.commandBarVisible, active: state.activeSessionId };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ visible: false, active: SESSION_A1 });

    // The capture-phase binding took every press before xterm, which would have
    // sent Tab or back-tab to the agent.
    for (const sessionId of [SESSION_A1, SESSION_A2, SESSION_COMMAND_A]) {
      const written = await writtenToSession(page, sessionId);
      expect(written).not.toContain('\t');
      expect(written).not.toContain('\x1b[Z');
    }
  } finally {
    await browser.close();
  }
});

test('a held Ctrl+Shift+Tab cycles once and its repeats never reach the terminal it landed on', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await panelTerminal(page, SESSION_A1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A1).focus();
    await page.evaluate(() => {
      (window as unknown as { electronAPI: { sessions: { __writeCalls: unknown[] } } }).electronAPI.sessions.__writeCalls.length = 0;
    });

    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Tab');
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A2);
    // Wait for A2's terminal to hold the keyboard, so an unswallowed repeat would
    // reach its xterm and go to the agent as Shift+Tab (ESC [ Z).
    await expect.poll(() => page.evaluate((sessionId) =>
      document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id') === sessionId, SESSION_A2,
    ), { timeout: STEP_TIMEOUT_MS }).toBe(true);

    // A second down of a held key is a repeat.
    await page.keyboard.down('Tab');
    await page.keyboard.down('Tab');
    await settleFrames(page, 4);
    await page.keyboard.up('Tab');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');

    const state = await snapshot(page);
    expect(state.activeSessionId).toBe(SESSION_A2);
    expect(state.commandBarVisible).toBe(false);
    const written = await writtenToSession(page, SESSION_A2);
    expect(written).not.toContain('\x1b[Z');
    expect(written).not.toContain('\t');
  } finally {
    await browser.close();
  }
});

test("Ctrl+Tab focuses an agent's open task window", async () => {
  const { browser, page } = await launch();
  try {
    await page.evaluate((taskId) => {
      (window as unknown as {
        __zustandStores: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
      }).__zustandStores.session.getState().setDetailTaskId(taskId);
    }, TASK_A2);
    await expect.poll(async () => (await snapshot(page)).boardAnchors, { timeout: STEP_TIMEOUT_MS }).toContain(TASK_A2);

    // A2's terminal moved to its window, so the panel keeps A1 and is not forced.
    await setActiveSession(page, SESSION_A1);
    await panelTerminal(page, SESSION_A1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A1).focus();

    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await snapshot(page)).focusedBoardAnchor, { timeout: STEP_TIMEOUT_MS }).toBe(TASK_A2);
    const boardWindowId = await focusedWindowId(page, 'window');
    await expect.poll(async () => (await snapshot(page)).focusedFrameTestId, { timeout: STEP_TIMEOUT_MS })
      .toBe(`window-frame-${boardWindowId}`);

    // Keyboard focus is now inside A2's window frame, so A2 is the terminal the
    // user is on. The panel still shows A1, so a press that read the panel and
    // not the frame would step from A1 to A2 again and never open the Command
    // Terminal.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { visible: state.commandBarVisible, anchor: state.focusedCommandAnchor };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ visible: true, anchor: 'slot-1' });
  } finally {
    await browser.close();
  }
});

test("from Backlog Ctrl+Tab returns to the board, and with the panel hidden it opens the agent's window", async () => {
  const { browser, page } = await launch();
  try {
    const collapsedBefore = await page.evaluate(() => (window as unknown as {
      __zustandStores: { config: { getState: () => { globalConfig: { terminal: { panelCollapsed?: boolean } } } } };
    }).__zustandStores.config.getState().globalConfig.terminal.panelCollapsed ?? false);

    await page.evaluate(() => {
      (window as unknown as {
        __zustandStores: { board: { getState: () => { setActiveView: (view: string) => void } } };
      }).__zustandStores.board.getState().setActiveView('backlog');
    });
    await expect.poll(async () => (await snapshot(page)).activeView, { timeout: STEP_TIMEOUT_MS }).toBe('backlog');
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await snapshot(page)).activeView, { timeout: STEP_TIMEOUT_MS }).toBe('board');

    // Hide the panel, as Settings does. Nothing can show a panel tab now, so the
    // landing opens the target agent's task window instead.
    await page.evaluate(() => {
      const configStore = (window as unknown as {
        __zustandStores: { config: {
          getState: () => { config: Record<string, unknown> };
          setState: (partial: { config: Record<string, unknown> }) => void;
        } };
      }).__zustandStores.config;
      configStore.setState({ config: { ...configStore.getState().config, terminalPanelVisible: false } });
    });
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await snapshot(page)).boardAnchors.length, { timeout: STEP_TIMEOUT_MS }).toBe(1);
    expect((await snapshot(page)).focusedBoardAnchor).not.toBeNull();

    const collapsedAfter = await page.evaluate(() => (window as unknown as {
      __zustandStores: { config: { getState: () => { globalConfig: { terminal: { panelCollapsed?: boolean } } } } };
    }).__zustandStores.config.getState().globalConfig.terminal.panelCollapsed ?? false);
    expect(collapsedAfter).toBe(collapsedBefore);
  } finally {
    await browser.close();
  }
});

test('Ctrl+Shift+Tab crosses into the next project and lands on its agent, then its Command Terminal', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    // From A's Command Terminal terminal, the next terminal in any project is B's agent.
    await setActiveSession(page, SESSION_A2);
    await panelTerminal(page, SESSION_A2).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A2).focus();
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(async () => (await snapshot(page)).focusedCommandAnchor, { timeout: STEP_TIMEOUT_MS }).toBe('slot-1');

    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { project: state.projectId, active: state.activeSessionId, visible: state.commandBarVisible };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ project: PROJECT_B, active: SESSION_B1, visible: false });

    // C has no agents, only a Command Terminal terminal: the panel opens there.
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { project: state.projectId, visible: state.commandBarVisible, anchor: state.focusedCommandAnchor };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ project: PROJECT_C, visible: true, anchor: 'slot-1' });
  } finally {
    await browser.close();
  }
});

test('Ctrl+` and Ctrl+Shift+` walk the projects in sidebar order and wrap', async () => {
  const { browser, page } = await launch();
  try {
    const expectProject = (projectId: string) =>
      expect.poll(async () => (await snapshot(page)).projectId, { timeout: STEP_TIMEOUT_MS }).toBe(projectId);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Backquote');
    await expectProject(PROJECT_B);
    await page.keyboard.press('Control+Backquote');
    await expectProject(PROJECT_C);
    await page.keyboard.press('Control+Backquote');
    await expectProject(PROJECT_A);
    await page.keyboard.press('Control+Shift+Backquote');
    await expectProject(PROJECT_C);
  } finally {
    await browser.close();
  }
});

test('under the Agent Monitor, a cycle key aimed at a terminal is swallowed, never typed into it', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await panelTerminal(page, SESSION_A1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await page.evaluate(() => {
      (window as unknown as {
        __zustandStores: { monitor: { getState: () => { toggle: () => void } } };
      }).__zustandStores.monitor.getState().toggle();
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __zustandStores: { monitor: { getState: () => { monitorOpen: boolean } } };
    }).__zustandStores.monitor.getState().monitorOpen), { timeout: STEP_TIMEOUT_MS }).toBe(true);

    // A terminal holds the keyboard while the overlay is up, as one of the
    // Monitor's own task terminals would.
    await panelTerminal(page, SESSION_A1).focus();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.xterm') !== null), { timeout: STEP_TIMEOUT_MS }).toBe(true);
    await page.evaluate(() => {
      (window as unknown as { electronAPI: { sessions: { __writeCalls: unknown[] } } }).electronAPI.sessions.__writeCalls.length = 0;
    });

    await page.keyboard.press('Control+Shift+Tab');
    await page.keyboard.press('Control+Tab');
    await page.keyboard.press('Control+Backquote');
    await settleFrames(page, 4);

    const state = await snapshot(page);
    expect(state.projectId).toBe(PROJECT_A);
    expect(state.activeSessionId).toBe(SESSION_A1);
    expect(state.commandBarVisible).toBe(false);
    const written = await writtenToSession(page, SESSION_A1);
    expect(written).not.toContain('\x1b[Z');
    expect(written).not.toContain('\t');
  } finally {
    await browser.close();
  }
});

test('with a dialog open the cycle keys pass through and change nothing', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await page.evaluate(() => {
      (window as unknown as {
        __zustandStores: { board: { getState: () => { requestNewTask: () => void } } };
      }).__zustandStores.board.getState().requestNewTask();
    });
    await page.getByTestId('new-task-dialog').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

    await page.keyboard.press('Control+Backquote');
    await page.keyboard.press('Control+Tab');
    await page.keyboard.press('Control+Shift+Tab');
    await settleFrames(page, 4);

    const state = await snapshot(page);
    expect(state.projectId).toBe(PROJECT_A);
    expect(state.activeSessionId).toBe(SESSION_A1);
    expect(state.commandBarVisible).toBe(false);
    await expect(page.getByTestId('new-task-dialog')).toBeVisible();
  } finally {
    await browser.close();
  }
});

// A press that crosses into another project does not land until that project's
// workspace has restored. These tests hold `projects.open` open (or make it
// fail) so a second press arrives while the first landing is still pending.

test('a second Ctrl+Shift+Tab, pressed while the first project switch is still landing, steps on from the switch target', async () => {
  test.setTimeout(MULTI_STEP_TEST_TIMEOUT_MS);
  const { browser, page } = await launch();
  try {
    await stepToProjectACommandTerminal(page);
    await holdProjectOpens(page);

    // The next terminal after A's Command Terminal is B1, in another project.
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(() => heldProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B]);

    // B1 is where the user is going, so a quick second press steps on from it, to
    // C's Command Terminal. Stepping from A's terminal would ask for B again.
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(() => heldProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B, PROJECT_C]);

    await releaseProjectOpens(page);
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { project: state.projectId, visible: state.commandBarVisible, anchor: state.focusedCommandAnchor };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ project: PROJECT_C, visible: true, anchor: 'slot-1' });
  } finally {
    await browser.close();
  }
});

test('Ctrl+Tab, pressed while the switch to project B is still landing, stays inside project B', async () => {
  test.setTimeout(MULTI_STEP_TEST_TIMEOUT_MS);
  const { browser, page } = await launch();
  try {
    await stepToProjectACommandTerminal(page);
    await holdProjectOpens(page);

    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(() => heldProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B]);
    // The panel hid on the press, so A2 is the tab the user was last on.
    await expect.poll(async () => (await snapshot(page)).commandBarVisible, { timeout: STEP_TIMEOUT_MS }).toBe(false);
    expect((await snapshot(page)).activeSessionId).toBe(SESSION_A2);

    // This-project scope while B is where the user is going: B holds one agent, so
    // the press lands on it and asks for B again. Read as project A it would land
    // on A1 on the spot, behind a switch that is about to replace the board.
    await page.keyboard.press('Control+Tab');
    await expect.poll(() => heldProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B, PROJECT_B]);
    expect((await snapshot(page)).activeSessionId).toBe(SESSION_A2);

    await releaseProjectOpens(page);
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { project: state.projectId, active: state.activeSessionId };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ project: PROJECT_B, active: SESSION_B1 });
  } finally {
    await browser.close();
  }
});

test('Ctrl+` pressed twice before the first project switch lands steps on from the switch in flight', async () => {
  test.setTimeout(MULTI_STEP_TEST_TIMEOUT_MS);
  const { browser, page } = await launch();
  try {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await holdProjectOpens(page);

    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => heldProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B]);

    // The open project is still A, but the user is on their way to B, so the next
    // project is C. Stepping from A would ask for B a second time.
    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => heldProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B, PROJECT_C]);

    await releaseProjectOpens(page);
    await expect.poll(async () => (await snapshot(page)).projectId, { timeout: STEP_TIMEOUT_MS }).toBe(PROJECT_C);
  } finally {
    await browser.close();
  }
});

test('a project switch that fails releases the landing, so the next press steps from where the user really is', async () => {
  test.setTimeout(MULTI_STEP_TEST_TIMEOUT_MS);
  const { browser, page } = await launch();
  try {
    await stepToProjectACommandTerminal(page);
    await failProjectOpens(page);

    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(() => failedProjectOpenIds(page), { timeout: STEP_TIMEOUT_MS }).toEqual([PROJECT_B]);
    // The failure toast follows the `failed` outcome that releases the landing, and
    // microtasks run before React paints, so the release has happened by now.
    await expect(page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't open project" })).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    // The press hid A's Command Terminal on its way out and the switch never
    // happened, so the user is back on A2 in the panel.
    await expect.poll(async () => (await snapshot(page)).commandBarVisible, { timeout: STEP_TIMEOUT_MS }).toBe(false);

    // From A2 the next terminal in this project is the Command Terminal. A landing
    // that stayed pending would still read B1 as the current terminal and ask for B.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => {
      const state = await snapshot(page);
      return { project: state.projectId, visible: state.commandBarVisible, anchor: state.focusedCommandAnchor };
    }, { timeout: STEP_TIMEOUT_MS }).toEqual({ project: PROJECT_A, visible: true, anchor: 'slot-1' });
    expect(await failedProjectOpenIds(page)).toEqual([PROJECT_B]);
  } finally {
    await browser.close();
  }
});

// A second Command Terminal in A (slot-2) beside slot-1, so one can be expanded
// while the other is the target. The panel is seeded to fill the area and the
// viewport is wide, so the two terminals tile at the pane floor and the only
// expand is the one the test makes.
const SESSION_COMMAND_A_SECOND = `sess-cycle-cmd-a-second-${RUN_ID}`;
const SECOND_COMMAND_TERMINAL_SEED = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.sessions.push({
      id: '${SESSION_COMMAND_A_SECOND}', taskId: '${SESSION_COMMAND_A_SECOND}', projectId: '${PROJECT_A}', pid: null,
      status: 'running', shell: '/bin/bash', cwd: '/mock/${PROJECT_A}',
      startedAt: ts, exitCode: null, resuming: false, transient: true,
      commandTerminalSlot: 'slot-2', commandTerminalBranch: 'main',
      commandTerminalLabel: null, isolatedSwimlaneId: null, agentSessionId: null,
    });
    state.config.commandTerminalPanel = { x: 0, y: 0, w: 1, h: 1, maximized: false };
  });
`;

test('landing on a Command Terminal slot behind an expanded terminal brings that slot to the front', async () => {
  test.setTimeout(MULTI_STEP_TEST_TIMEOUT_MS);
  const { browser, page } = await launch({
    extraPreConfig: SECOND_COMMAND_TERMINAL_SEED,
    extraSessionIds: [SESSION_COMMAND_A_SECOND],
    viewport: { width: 2600, height: 1300 },
  });
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await setActiveSession(page, SESSION_A2);
    await panelTerminal(page, SESSION_A2).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A2).focus();

    // A2 is followed by slot-1, which opens the panel with a window per terminal.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await commandWindowState(page)).windows.map((managed) => managed.anchor).sort(), { timeout: STEP_TIMEOUT_MS })
      .toEqual(['slot-1', 'slot-2']);
    await expect.poll(async () => (await snapshot(page)).focusedCommandAnchor, { timeout: STEP_TIMEOUT_MS }).toBe('slot-1');
    await settleFrames(page, 6);
    const opened = await commandWindowState(page);
    expect(opened.expandedWindowId).toBeNull();
    const slotOneWindowId = opened.windows.find((managed) => managed.anchor === 'slot-1')?.id ?? '';
    const slotTwoWindowId = opened.windows.find((managed) => managed.anchor === 'slot-2')?.id ?? '';
    expect(slotOneWindowId).not.toBe('');
    expect(slotTwoWindowId).not.toBe('');

    // The user expands slot-1, which leaves slot-2 mounted behind it.
    await page.evaluate((windowId) => {
      (window as unknown as {
        __zustandStores: { commandWindow: { getState: () => { setExpandedWindow: (id: string) => void } } };
      }).__zustandStores.commandWindow.getState().setExpandedWindow(windowId);
    }, slotOneWindowId);
    await expect.poll(async () => (await commandWindowState(page)).expandedWindowId, { timeout: STEP_TIMEOUT_MS }).toBe(slotOneWindowId);
    await page.locator(`[data-testid="window-frame-${slotOneWindowId}"] .xterm-helper-textarea`).focus();

    // Slot-1 is the current terminal and slot-2 is next. Focusing slot-2 under the
    // expanded slot-1 would raise nothing on screen, so the landing expands slot-2.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await commandWindowState(page)).expandedWindowId, { timeout: STEP_TIMEOUT_MS }).toBe(slotTwoWindowId);
    await expect.poll(async () => (await snapshot(page)).focusedCommandAnchor, { timeout: STEP_TIMEOUT_MS }).toBe('slot-2');
    await expect.poll(async () => (await snapshot(page)).focusedFrameTestId, { timeout: STEP_TIMEOUT_MS })
      .toBe(`window-frame-${slotTwoWindowId}`);
  } finally {
    await browser.close();
  }
});

test('Ctrl+Tab expands a bottom panel the user collapsed, on the target tab', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await setActiveSession(page, SESSION_A2);
    const collapseButton = page.getByRole('button', { name: 'Collapse terminal panel', exact: true });
    const expandButton = page.getByRole('button', { name: 'Expand terminal panel', exact: true });
    await collapseButton.click();
    await expect(expandButton).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await page.locator('body').click({ position: { x: 5, y: 5 } });

    // A collapsed panel names no current tab, and from no terminal the next press
    // lands on the project's first one (cycle-targets.ts, cycleStep). That is A1,
    // not the A2 the panel last showed, so the selection is proof the landing ran.
    await page.keyboard.press('Control+Tab');
    await expect(collapseButton).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
  } finally {
    await browser.close();
  }
});

test('a session a phone streams lands in its task window, since the panel has no tab for it', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await panelTerminal(page, SESSION_A1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A1).focus();

    await page.evaluate((sessionIds) => {
      (window as unknown as {
        __mockFireMobileTerminalStreamsChanged: (ids: string[]) => void;
      }).__mockFireMobileTerminalStreamsChanged(sessionIds);
    }, [SESSION_A2]);
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __zustandStores: { session: { getState: () => { mobileTerminalStreamedSessionIds: string[] } } };
    }).__zustandStores.session.getState().mobileTerminalStreamedSessionIds), { timeout: STEP_TIMEOUT_MS }).toEqual([SESSION_A2]);

    // A2 is next. The phone holds its panel tab, so selecting that tab would show
    // nothing: only a task window can show A2's terminal.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await snapshot(page)).focusedBoardAnchor, { timeout: STEP_TIMEOUT_MS }).toBe(TASK_A2);
  } finally {
    await browser.close();
  }
});

test('a task window closed with its agent live is revived, not focused while hidden, when Ctrl+Tab lands on that agent', async () => {
  test.setTimeout(MULTI_STEP_TEST_TIMEOUT_MS);
  const { browser, page } = await launch();
  try {
    await openTaskWindow(page, TASK_A2);
    const openedWindow = await boardWindowForTask(page, TASK_A2);
    expect(openedWindow).not.toBeNull();

    // Park it, as closing the window with its Browser pane live does. A parked
    // window lasts only while its task has an open pane with a registered guest
    // (the reaper drops it otherwise), so stand in for both at the store, as
    // the registration specs do with a stub webview. A parked window is closed
    // as far as the board is concerned, so the detail clears.
    await page.evaluate(({ windowId, taskId, guestWebContentsId }) => {
      const stores = (window as unknown as {
        __zustandStores: {
          session: { getState: () => {
            setBrowserOpen: (id: string, open: boolean) => void;
            setBrowserGuest: (id: string, webContentsId: number) => void;
          } };
          window: { getState: () => { parkWindow: (id: string) => void } };
        };
      }).__zustandStores;
      stores.session.getState().setBrowserOpen(taskId, true);
      stores.session.getState().setBrowserGuest(taskId, guestWebContentsId);
      stores.window.getState().parkWindow(windowId);
    }, { windowId: openedWindow?.id ?? '', taskId: TASK_A2, guestWebContentsId: 5151 });
    await expect.poll(async () => (await boardWindowForTask(page, TASK_A2))?.parked, { timeout: STEP_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => detailTaskId(page), { timeout: STEP_TIMEOUT_MS }).toBeNull();

    // With the window gone from the screen, A2's panel tab is back beside A1's.
    await setActiveSession(page, SESSION_A1);
    await panelTerminal(page, SESSION_A1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A1).focus();

    // Focusing a parked window does nothing and a panel tab cannot show a terminal
    // its window still owns, so the landing un-parks the window through the detail.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await boardWindowForTask(page, TASK_A2))?.parked, { timeout: STEP_TIMEOUT_MS }).toBe(false);
    await expect.poll(async () => (await snapshot(page)).focusedBoardAnchor, { timeout: STEP_TIMEOUT_MS }).toBe(TASK_A2);
  } finally {
    await browser.close();
  }
});

test('a project whose Command Terminal is in a window of its own is skipped by the cycle', async () => {
  const { browser, page } = await launch();
  try {
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    await setActiveSession(page, SESSION_A2);
    await panelTerminal(page, SESSION_A2).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await panelTerminal(page, SESSION_A2).focus();

    // The key main reports for A's detached Command Terminal (popOutInstanceKey).
    await page.evaluate((instanceKey) => {
      (window as unknown as {
        __zustandStores: { popOut: { getState: () => { setOpen: (keys: string[]) => void } } };
      }).__zustandStores.popOut.getState().setOpen([instanceKey]);
    }, `command-terminal:${PROJECT_A}`);

    // That terminal lives in the other window, so A2 is A's last terminal here and
    // the walk wraps to A1 instead of opening the panel on a terminal it cannot show.
    await page.keyboard.press('Control+Tab');
    await expect.poll(async () => (await snapshot(page)).activeSessionId, { timeout: STEP_TIMEOUT_MS }).toBe(SESSION_A1);
    expect((await snapshot(page)).commandBarVisible).toBe(false);
  } finally {
    await browser.close();
  }
});
