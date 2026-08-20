import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserPaneEntry } from '../../src/main/browser/browser-pane-registry';

/**
 * Keeping an agent's browser alive when the user closes the task window.
 *
 * The product rule: a browser an agent is using belongs to the AGENT, not to a
 * piece of UI, so the user must be free to close the task detail and move around
 * the board without disconnecting it. An Electron <webview> guest dies the
 * moment its DOM node unmounts, so the page is handed off to an offscreen lane
 * instead.
 */

// The registry touches Electron on its liveness and shutdown paths. `fromId`
// returns undefined so `resolveLiveGuest` takes its self-heal branch, which is
// one of the cases under test.
vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => undefined) },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  detachDebugger: vi.fn(),
  isDebuggerAttached: vi.fn(() => false),
}));

const openLane = vi.fn(async () => ({ ok: true as const, laneId: 'lane_handoff1', webContents: {} }));
const destroyHandoffLanesForTask = vi.fn(() => 0);
let handoffLaneExists = false;

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  openLane: (...args: unknown[]) => openLane(...(args as [])),
  destroyHandoffLanesForTask: (...args: unknown[]) => destroyHandoffLanesForTask(...(args as [])),
  hasHandoffLaneForTask: () => handoffLaneExists,
}));

const { installLaneHandoff, uninstallLaneHandoff } = await import(
  '../../src/main/browser/browser-lane-handoff'
);
const { browserPaneRegistry } = await import('../../src/main/browser/browser-pane-registry');

function pane(overrides: Partial<BrowserPaneEntry> = {}): BrowserPaneEntry {
  return {
    sessionId: 'session-1',
    taskId: 'task-1',
    projectId: 'project-1',
    webContentsId: 7,
    url: 'http://localhost:4200',
    registeredAt: 0,
    kind: 'pane',
    ...overrides,
  };
}

let liveTasks = new Set<string>(['task-1']);

beforeEach(() => {
  openLane.mockClear();
  destroyHandoffLanesForTask.mockClear();
  handoffLaneExists = false;
  liveTasks = new Set(['task-1']);
  installLaneHandoff({
    hasLiveSession: (taskId) => liveTasks.has(taskId),
    getTaskWorktreePath: () => 'C:\\Users\\dev\\repo\\.kangentic\\worktrees\\7',
  });
});

afterEach(() => {
  uninstallLaneHandoff();
  browserPaneRegistry.detachAll();
});

/** Register then remove a pane, which is what closing the window does. */
function closePane(entry: BrowserPaneEntry): void {
  browserPaneRegistry.register(entry);
  browserPaneRegistry.unregisterByWebContentsId(entry.webContentsId);
}

describe('pane hand-off', () => {
  it('opens a lane at the same URL when a live task"s pane closes', async () => {
    closePane(pane());
    await vi.waitFor(() => expect(openLane).toHaveBeenCalledTimes(1));
    expect(openLane.mock.calls[0][0]).toMatchObject({
      taskId: 'task-1',
      projectId: 'project-1',
      url: 'http://localhost:4200',
      handoff: true,
    });
  });

  it('does nothing when the task has no live session', async () => {
    // Nothing to preserve for, and opening a browser for a finished agent would
    // be a resource nobody asked for.
    liveTasks.clear();
    closePane(pane());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openLane).not.toHaveBeenCalled();
  });

  it('does nothing for a pane that never loaded a page', async () => {
    closePane(pane({ url: null }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openLane).not.toHaveBeenCalled();
  });

  it('never hands off a LANE closing', async () => {
    // A lane closing is the agent's own decision or a cleanup path. Re-opening
    // it would make lanes impossible to close.
    closePane(pane({ sessionId: 'lane_abc', kind: 'lane' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openLane).not.toHaveBeenCalled();
  });

  it('does not stack a second lane when one is already standing in', async () => {
    handoffLaneExists = true;
    closePane(pane());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openLane).not.toHaveBeenCalled();
  });

  it('does not hand off a self-healed entry whose guest was already gone', async () => {
    // `self-heal-dead-guest` means the registry noticed a stale entry, not that
    // a live page just went away - there is nothing to carry over.
    browserPaneRegistry.register(pane());
    // Resolve against a guest id that does not exist, which triggers the
    // self-heal path rather than a close.
    browserPaneRegistry.resolveLiveGuest(pane());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openLane).not.toHaveBeenCalled();
  });
});

describe('standing down', () => {
  it('closes the hand-off lane when the user"s own pane comes back', () => {
    browserPaneRegistry.register(pane({ webContentsId: 9 }));
    expect(destroyHandoffLanesForTask).toHaveBeenCalledWith('task-1');
  });

  it('does not stand down when a LANE registers', () => {
    // Otherwise an agent opening its own isolated lane would tear down the
    // hand-off lane serving a different purpose.
    destroyHandoffLanesForTask.mockClear();
    browserPaneRegistry.register(pane({ sessionId: 'lane_xyz', kind: 'lane', webContentsId: 11 }));
    expect(destroyHandoffLanesForTask).not.toHaveBeenCalled();
  });
});
