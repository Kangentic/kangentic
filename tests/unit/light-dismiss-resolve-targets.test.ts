import { describe, it, expect } from 'vitest';
import { resolveLightDismissTargets } from '../../src/renderer/window-manager/light-dismiss/resolve-targets';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { ManagedWindow, WindowState } from '../../src/renderer/window-manager/store/types';

function makeWindow(id: string, state: WindowState): ManagedWindow {
  return {
    id,
    taskId: `task-${id}`,
    sessionId: `session-${id}`,
    geometry: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
    state,
    zIndex: 1,
    leafId: state === 'tiled' ? `leaf-${id}` : null,
    sessionStatus: 'live',
    restoreGeometry: null,
    title: `Window ${id}`,
  };
}

function windowSet(...entries: Array<[string, WindowState]>): Record<string, ManagedWindow> {
  const record: Record<string, ManagedWindow> = {};
  for (const [id, state] of entries) record[id] = makeWindow(id, state);
  return record;
}

const ALL_STATES: WindowState[] = ['floating', 'snapped', 'tiled', 'maximized'];

describe('resolveLightDismissTargets', () => {
  describe('the shipped default', () => {
    it('is `focused`, so dismissal is not count-dependent', () => {
      // `single` was the old default and returns NOTHING once a second window is open,
      // so opening a second task silently turned background-close off with no visible
      // cause. `focused` closes the focused window whether one or five are open.
      // Asserted here because nothing else pins it: `tests/ui/mock-electron-api.js`
      // seeds its own independent literal, and the UI tier's `updateConfig` cannot
      // express "whatever the default is".
      expect(DEFAULT_CONFIG.windowLightDismiss).toBe('focused');
    });

    it('closes the focused window with several open, where `single` closed none', () => {
      const windows = windowSet(['a', 'floating'], ['b', 'floating']);
      expect(resolveLightDismissTargets(DEFAULT_CONFIG.windowLightDismiss, windows, 'b')).toEqual(['b']);
      expect(resolveLightDismissTargets('single', windows, 'b')).toEqual([]);
    });
  });

  describe('off', () => {
    it('never returns a target, no matter the window set', () => {
      expect(resolveLightDismissTargets('off', {}, null)).toEqual([]);
      expect(resolveLightDismissTargets('off', windowSet(['a', 'floating']), 'a')).toEqual([]);
      expect(
        resolveLightDismissTargets('off', windowSet(['a', 'floating'], ['b', 'tiled']), 'a'),
      ).toEqual([]);
    });
  });

  describe('single', () => {
    it('closes the only window when it is floating', () => {
      expect(resolveLightDismissTargets('single', windowSet(['a', 'floating']), 'a')).toEqual(['a']);
    });

    it('closes a lone window in any docked state (snapped/tiled/maximized)', () => {
      // A window left snapped after its dock partner closed must still dismiss
      // under `single`: with one window there is nothing to reflow and a snapped
      // half leaves real board to click. (A lone maximized window simply covers
      // the board, so no board click lands on it; including it is a harmless no-op.)
      for (const state of ['snapped', 'tiled', 'maximized'] as WindowState[]) {
        expect(resolveLightDismissTargets('single', windowSet(['a', state]), 'a')).toEqual(['a']);
      }
    });

    it('does not close anything when zero windows are open', () => {
      expect(resolveLightDismissTargets('single', {}, null)).toEqual([]);
    });

    it('does not close anything when more than one window is open', () => {
      expect(
        resolveLightDismissTargets('single', windowSet(['a', 'floating'], ['b', 'floating']), 'a'),
      ).toEqual([]);
    });
  });

  describe('focused', () => {
    it('closes the focused window in any state', () => {
      for (const state of ALL_STATES) {
        expect(resolveLightDismissTargets('focused', windowSet(['a', state]), 'a')).toEqual(['a']);
      }
    });

    it('closes only the focused window when several are open', () => {
      const windows = windowSet(['a', 'floating'], ['b', 'tiled'], ['c', 'snapped']);
      expect(resolveLightDismissTargets('focused', windows, 'b')).toEqual(['b']);
    });

    it('returns nothing when there is no focused window', () => {
      expect(resolveLightDismissTargets('focused', windowSet(['a', 'floating']), null)).toEqual([]);
    });

    it('returns nothing when the focused id is stale (no matching window)', () => {
      expect(
        resolveLightDismissTargets('focused', windowSet(['a', 'floating']), 'gone'),
      ).toEqual([]);
    });
  });

  describe('all', () => {
    it('returns every window id regardless of state', () => {
      const windows = windowSet(['a', 'floating'], ['b', 'tiled'], ['c', 'snapped'], ['d', 'maximized']);
      expect(resolveLightDismissTargets('all', windows, 'a').sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('returns nothing when no windows are open', () => {
      expect(resolveLightDismissTargets('all', {}, null)).toEqual([]);
    });
  });
});
