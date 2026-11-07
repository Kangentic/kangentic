/**
 * The whole decision behind "an agent never shows a window". Each case is a place
 * a pane can already live, where mounting a parked window would be wrong, and the
 * last is the one where the agent needs one and nothing else can hold the pane.
 */
import { describe, it, expect } from 'vitest';
import { resolvePaneOpenAction, type PaneOpenFacts } from '../../src/renderer/window-manager/bridge/pane-open-action';

const noHost: PaneOpenFacts = {
  projectId: 'project-a',
  currentProjectId: 'project-a',
  hasBoardWindow: false,
  browserPoppedOut: false,
  monitorMountsDetail: false,
};

describe('resolvePaneOpenAction', () => {
  it('mounts a parked window when nothing can hold the pane', () => {
    expect(resolvePaneOpenAction(noHost)).toBe('mount-parked');
  });

  it('leaves a board window of any kind alone, so a window the user closed stays closed', () => {
    expect(resolvePaneOpenAction({ ...noHost, hasBoardWindow: true })).toBe('flag-only');
  });

  it('mounts nothing for a backgrounded project, whose board cannot render its tasks', () => {
    expect(resolvePaneOpenAction({ ...noHost, currentProjectId: 'project-b' })).toBe('flag-only');
    expect(resolvePaneOpenAction({ ...noHost, currentProjectId: null })).toBe('flag-only');
  });

  it('leaves a detached Browser window alone: it owns the guest', () => {
    expect(resolvePaneOpenAction({ ...noHost, browserPoppedOut: true })).toBe('flag-only');
  });

  it('lets the mounted Agent Monitor host the pane, never a second guest beside it', () => {
    expect(resolvePaneOpenAction({ ...noHost, monitorMountsDetail: true })).toBe('flag-only');
  });
});
