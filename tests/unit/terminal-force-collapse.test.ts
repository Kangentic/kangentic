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
 */
import { describe, it, expect } from 'vitest';
import { shouldForceCollapseTerminal } from '../../src/renderer/utils/terminal-force-collapse';

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
