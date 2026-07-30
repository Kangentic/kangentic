/**
 * Unit tests for planMonitorWorkspaceRestore, the policy behind which windows the
 * Agent Monitor may take back from its persisted layout.
 *
 * The blob is what carries an open detail between the in-app monitor and its pop-out
 * (separate renderers, separate copies of the window store). The filter exists because
 * the blob describes the past: a task the user has since opened on the board must not
 * be silently yanked back into the monitor just because reopening it restored a layout.
 */
import { describe, it, expect } from 'vitest';
import {
  planMonitorWorkspaceRestore,
  shouldPersistMonitorWorkspace,
} from '../../src/renderer/components/monitor/monitor-workspace-restore';
import type { SerializedWorkspace } from '../../src/shared/types';

const PROJECT = 'proj-a';

type SavedWindow = SerializedWorkspace['windows'][number];

/** One persisted window, in the REAL serialized shape (no casts, so a drift in
 *  `SerializedWorkspace` fails typecheck here rather than silently passing a fixture
 *  that no saved blob actually looks like). `taskId` carries the durable ANCHOR, which
 *  for the monitor is `projectId:taskId` - the convention the layer opens with. */
function savedWindow(anchor: string, overrides: Partial<SavedWindow> = {}): SavedWindow {
  return {
    taskId: anchor,
    kind: 'task-detail',
    title: 'Task',
    geometry: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
    restoreGeometry: null,
    state: 'floating',
    ...overrides,
  };
}

function makeWorkspace(windows: SavedWindow[]): SerializedWorkspace {
  return {
    version: 1,
    windows,
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: null,
  };
}

/** Every anchor's task counts as live unless a case says otherwise, so a test that is
 *  not about liveness does not have to restate it. */
function taskIdsOf(anchors: string[]): string[] {
  return anchors.map((anchor) => anchor.slice(anchor.indexOf(':') + 1));
}

function plan(
  anchors: string[],
  overrides: { ownedElsewhere?: string[]; boardTaskIds?: string[]; liveTaskIds?: string[] } = {},
) {
  return planMonitorWorkspaceRestore({
    workspace: makeWorkspace(anchors.map((anchor) => savedWindow(anchor))),
    ownedElsewhere: overrides.ownedElsewhere ?? [],
    boardTaskIds: overrides.boardTaskIds ?? [],
    liveTaskIds: overrides.liveTaskIds ?? taskIdsOf(anchors),
  });
}

describe('planMonitorWorkspaceRestore', () => {
  it('restores every window when nothing else holds those tasks', () => {
    const result = plan([`${PROJECT}:task-a`, `${PROJECT}:task-b`]);
    expect([...result.restorableAnchors].sort()).toEqual([`${PROJECT}:task-a`, `${PROJECT}:task-b`]);
    expect(result.skippedAnchors).toEqual([]);
  });

  it('skips a task another renderer hosts (main window only - a pop-out never sees this)', () => {
    // Restoring it would report ownership main has to resolve by displacing the other
    // host - reopening the monitor would steal the window out from under the user.
    //
    // Reachable in the MAIN WINDOW only: `useRemoteDetailOwnersSync` is mounted there
    // and nowhere else, so a detached monitor always passes an empty set here and
    // relies on the arbiter's displacement instead. See the module header.
    const result = plan([`${PROJECT}:task-a`, `${PROJECT}:task-b`], { ownedElsewhere: ['task-b'] });
    expect([...result.restorableAnchors]).toEqual([`${PROJECT}:task-a`]);
    expect(result.skippedAnchors).toEqual([`${PROJECT}:task-b`]);
  });

  it('skips a task this renderer has open on the board', () => {
    const result = plan([`${PROJECT}:task-a`], { boardTaskIds: ['task-a'] });
    expect(result.restorableAnchors.size).toBe(0);
    expect(result.skippedAnchors).toEqual([`${PROJECT}:task-a`]);
  });

  it('matches on the task id alone, so the same task in a different project entry still counts', () => {
    // `remoteDetailTaskIds` carries task ids only (main drops the project when it
    // publishes), and task ids are uuids - so the anchor's project must not make a
    // held task look free.
    const result = plan([`proj-other:task-a`], { ownedElsewhere: ['task-a'] });
    expect(result.restorableAnchors.size).toBe(0);
  });

  it('skips a task whose agent is no longer running', () => {
    // Reported live: a task moved to Done and archived came BACK on the next monitor
    // open. The monitor is for watching working agents; a finished one has nothing to
    // watch, and resurrecting it is exactly the surprise the user hit.
    const result = plan([`${PROJECT}:task-a`, `${PROJECT}:task-b`], { liveTaskIds: ['task-b'] });
    expect([...result.restorableAnchors]).toEqual([`${PROJECT}:task-b`]);
    expect(result.skippedAnchors).toEqual([`${PROJECT}:task-a`]);
  });

  it('restores nothing when no agent is running at all', () => {
    const result = plan([`${PROJECT}:task-a`], { liveTaskIds: [] });
    expect(result.restorableAnchors.size).toBe(0);
  });

  it('drops a malformed anchor rather than restoring an unresolvable window', () => {
    const result = plan(['not-a-monitor-anchor']);
    expect(result.restorableAnchors.size).toBe(0);
    expect(result.skippedAnchors).toEqual(['not-a-monitor-anchor']);
  });

  it('drops a non-task-detail window (a conversation leaf has a session-id anchor)', () => {
    const result = planMonitorWorkspaceRestore({
      workspace: makeWorkspace([savedWindow(`${PROJECT}:task-a`, { kind: 'conversation' })]),
      ownedElsewhere: [],
      boardTaskIds: [],
      liveTaskIds: ['task-a'],
    });
    expect(result.restorableAnchors.size).toBe(0);
  });

  it('restores a window with no persisted kind (back-compat with older blobs)', () => {
    const result = planMonitorWorkspaceRestore({
      workspace: makeWorkspace([savedWindow(`${PROJECT}:task-a`, { kind: undefined })]),
      ownedElsewhere: [],
      boardTaskIds: [],
      liveTaskIds: ['task-a'],
    });
    expect([...result.restorableAnchors]).toEqual([`${PROJECT}:task-a`]);
  });

  // ── the "nothing to restore" states, which must not resurrect closed windows ──

  it('returns nothing when no layout has ever been saved', () => {
    const result = planMonitorWorkspaceRestore({
      workspace: null,
      ownedElsewhere: [],
      boardTaskIds: [],
      liveTaskIds: ['task-a'],
    });
    expect(result.restorableAnchors.size).toBe(0);
    expect(result.skippedAnchors).toEqual([]);
  });

  it('returns nothing for a saved-but-empty layout, so closing every detail stays closed', () => {
    // Closing the last detail persists an EMPTY layout. If that came back on the next
    // open, windows the user deliberately closed would reappear.
    const result = plan([]);
    expect(result.restorableAnchors.size).toBe(0);
  });
});

describe('shouldPersistMonitorWorkspace', () => {
  // The invariant the cross-renderer handoff rests on. Found live: without it, a host
  // that mounts with an empty store writes an empty layout over the one it was about to
  // restore, and detaching the monitor loses the open detail.

  it('lets a host with windows persist', () => {
    expect(shouldPersistMonitorWorkspace({ windowCount: 1, hasHeldWindows: false })).toBe(true);
  });

  it('BLOCKS a host that has never held a window from writing an empty layout', () => {
    expect(shouldPersistMonitorWorkspace({ windowCount: 0, hasHeldWindows: false })).toBe(false);
  });

  it('lets a host that HAS held a window persist an empty layout, so a close sticks', () => {
    expect(shouldPersistMonitorWorkspace({ windowCount: 0, hasHeldWindows: true })).toBe(true);
  });
});
