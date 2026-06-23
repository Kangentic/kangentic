/**
 * Unit tests for shouldForceCollapseTerminal, the pure decision behind whether the bottom
 * terminal panel renders collapsed because task-detail windows own the terminal surface.
 *
 * Covers:
 *   - a live detail window (dialogSessionIds non-empty) forces collapse regardless of pending
 *   - no window + no pending arm -> expanded (the common case, must not gain new motion)
 *   - no window + pending armed for the project now shown -> collapsed (first-frame-of-switch fix)
 *   - no window + pending armed for a DIFFERENT project (stale arm) -> expanded (project scoping)
 *   - no window + pending null -> expanded
 */
import { describe, it, expect } from 'vitest';
import { shouldForceCollapseTerminal } from '../../src/renderer/utils/terminal-force-collapse';

describe('shouldForceCollapseTerminal', () => {
  it('forces collapse when a detail window owns a session', () => {
    expect(
      shouldForceCollapseTerminal({
        dialogSessionIds: ['sess-1'],
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe(true);
  });

  it('forces collapse when a detail window is open even if a pending arm exists (OR short-circuit)', () => {
    expect(
      shouldForceCollapseTerminal({
        dialogSessionIds: ['sess-1'],
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      }),
    ).toBe(true);
  });

  it('does NOT collapse with no window and no pending arm (common case stays expanded)', () => {
    expect(
      shouldForceCollapseTerminal({
        dialogSessionIds: [],
        pendingDetailWindowsProjectId: null,
        currentProjectId: 'proj-a',
      }),
    ).toBe(false);
  });

  it('collapses when the pending arm matches the project now shown (mid-switch restore)', () => {
    expect(
      shouldForceCollapseTerminal({
        dialogSessionIds: [],
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-a',
      }),
    ).toBe(true);
  });

  it('ignores a stale pending arm for a project we have already left', () => {
    expect(
      shouldForceCollapseTerminal({
        dialogSessionIds: [],
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: 'proj-b',
      }),
    ).toBe(false);
  });

  it('does NOT collapse when armed but no project is shown', () => {
    expect(
      shouldForceCollapseTerminal({
        dialogSessionIds: [],
        pendingDetailWindowsProjectId: 'proj-a',
        currentProjectId: null,
      }),
    ).toBe(false);
  });
});
