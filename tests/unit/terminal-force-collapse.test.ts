/**
 * Unit tests for shouldForceCollapseTerminal, the pure decision behind whether the bottom
 * terminal panel renders collapsed because task-detail windows own the terminal surface.
 *
 * Covers:
 *   - every session detached to a detail window (zero tabs left) -> collapsed
 *   - some tabs left -> expanded, even while other sessions are detached
 *   - no sessions at all -> expanded, so the "drag a task into a column" hint stays visible
 *   - pending armed for the project now shown -> collapsed (first-frame-of-switch fix)
 *   - pending armed for a DIFFERENT project (stale arm) -> expanded (project scoping)
 *   - pending null -> expanded
 *
 * And isEveryPanelSessionDetached, the narrower state AppLayout sizes the panel to zero height
 * for: sessions exist and none has a tab. It must stay false with no sessions (the hint state)
 * and whenever any tab is left.
 *
 * And resolveTerminalForceCollapse, which names the reason so AppLayout can tell the zero-height
 * collapse from the restore arm's, which keeps its strip.
 */
import { describe, it, expect } from 'vitest';
import {
  isEveryPanelSessionDetached,
  resolveTerminalForceCollapse,
  shouldForceCollapseTerminal,
} from '../../src/renderer/utils/terminal-force-collapse';

describe('isEveryPanelSessionDetached', () => {
  it('is true when sessions exist and every one is detached', () => {
    expect(isEveryPanelSessionDetached({ activeSessionCount: 1, visibleSessionCount: 0 })).toBe(true);
  });

  it('is false with no sessions at all, which keeps its hint and its strip', () => {
    expect(isEveryPanelSessionDetached({ activeSessionCount: 0, visibleSessionCount: 0 })).toBe(false);
  });

  it('is false while any tab is left', () => {
    expect(isEveryPanelSessionDetached({ activeSessionCount: 3, visibleSessionCount: 2 })).toBe(false);
  });

  it('is false when every session has a tab', () => {
    expect(isEveryPanelSessionDetached({ activeSessionCount: 1, visibleSessionCount: 1 })).toBe(false);
  });
});

describe('shouldForceCollapseTerminal', () => {
  it('collapses when every session is detached to a detail window (no tabs left)', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 1,
        visibleSessionCount: 0,
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe(true);
  });

  it('stays expanded while ANY tab remains, even with other sessions detached', () => {
    // The panel sheds only the detached tab now. Opening one task must not hide the
    // other agents' live terminals, which is what the old whole-panel collapse did.
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 3,
        visibleSessionCount: 2,
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe(false);
  });

  it('does NOT collapse with no sessions at all - that state keeps its hint', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 0,
        visibleSessionCount: 0,
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe(false);
  });

  it('collapses on zero tabs even if a pending arm also exists (OR short-circuit)', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 1,
        visibleSessionCount: 0,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      }),
    ).toBe(true);
  });

  it('does NOT collapse with tabs showing and no pending arm (common case stays expanded)', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 1,
        visibleSessionCount: 1,
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe(false);
  });

  it('collapses when the pending arm matches the project now shown (mid-switch restore)', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 1,
        visibleSessionCount: 1,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      }),
    ).toBe(true);
  });

  it('ignores a stale pending arm for a project we have already left', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 1,
        visibleSessionCount: 1,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-b',
      }),
    ).toBe(false);
  });

  it('does NOT collapse when armed but no project is shown', () => {
    expect(
      shouldForceCollapseTerminal({
        activeSessionCount: 0,
        visibleSessionCount: 0,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: null,
      }),
    ).toBe(false);
  });
});

describe('resolveTerminalForceCollapse', () => {
  it('names every-session-detached when no tab is left', () => {
    expect(
      resolveTerminalForceCollapse({
        activeSessionCount: 2,
        visibleSessionCount: 0,
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe('every-session-detached');
  });

  it('names detail-windows-restoring for an arm on the shown project while tabs remain', () => {
    // This collapse keeps the strip, so AppLayout must not read it as the zero-height state.
    expect(
      resolveTerminalForceCollapse({
        activeSessionCount: 2,
        visibleSessionCount: 2,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      }),
    ).toBe('detail-windows-restoring');
  });

  it('prefers every-session-detached when both hold, since the panel then has nothing to render', () => {
    expect(
      resolveTerminalForceCollapse({
        activeSessionCount: 1,
        visibleSessionCount: 0,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      }),
    ).toBe('every-session-detached');
  });

  it('is null when nothing holds the panel', () => {
    expect(
      resolveTerminalForceCollapse({
        activeSessionCount: 1,
        visibleSessionCount: 1,
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-b',
      }),
    ).toBeNull();
  });
});
