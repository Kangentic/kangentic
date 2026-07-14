/**
 * Unit coverage for useTerminalRefit's pure decision helpers.
 *
 * The hook itself is timer/observer wiring exercised by the UI tier
 * (tests/ui/command-terminal.spec.ts, container-only pane resize refit). These
 * matrices lock the two decisions the wiring switches on:
 *
 * - shouldObserverScheduleRefit: a ResizeObserver notification schedules a
 *   debounced refit only when the host does not defer container resizes AND no
 *   window-manager resize gesture is in progress. This is the contract the
 *   Command Terminal clipping fix depends on: container-only changes (its
 *   ContextBar growing) happen with the gate closed, so they refit.
 * - resolvePanelResizeAction: how a terminal-panel-resize event is handled per
 *   host mode (synchronous fit+flush for immediatePanelResize, 0ms + settle
 *   cleanup for deferContainerResize, 50ms debounce otherwise).
 */
import { describe, it, expect } from 'vitest';
import {
  shouldObserverScheduleRefit,
  resolvePanelResizeAction,
  PANEL_EVENT_REFIT_DEBOUNCE_MS,
} from '../../src/renderer/hooks/useTerminalRefit';

describe('shouldObserverScheduleRefit', () => {
  it('schedules for a plain container change (no defer, gate closed)', () => {
    expect(shouldObserverScheduleRefit(false, false)).toBe(true);
  });

  it('suppresses while a window-manager resize gesture is in progress', () => {
    // The imperative resizers rewrite the frame's box per frame; refitting per
    // frame would SIGWINCH per frame and stack duplicate TUI banners.
    expect(shouldObserverScheduleRefit(false, true)).toBe(false);
  });

  it('suppresses for deferContainerResize hosts regardless of the gate', () => {
    expect(shouldObserverScheduleRefit(true, false)).toBe(false);
    expect(shouldObserverScheduleRefit(true, true)).toBe(false);
  });
});

describe('resolvePanelResizeAction', () => {
  it('fits synchronously for immediatePanelResize hosts', () => {
    expect(resolvePanelResizeAction(false, true)).toEqual({ kind: 'immediate-fit-flush' });
  });

  it('immediatePanelResize wins even if deferContainerResize is also set', () => {
    expect(resolvePanelResizeAction(true, true)).toEqual({ kind: 'immediate-fit-flush' });
  });

  it('fits on the next tick and schedules the settle cleanup for deferContainerResize hosts', () => {
    expect(resolvePanelResizeAction(true, false)).toEqual({
      kind: 'debounced-fit',
      delayMs: 0,
      scheduleSettleCleanup: true,
    });
  });

  it('keeps the 50ms debounce with no settle cleanup for default hosts', () => {
    expect(resolvePanelResizeAction(false, false)).toEqual({
      kind: 'debounced-fit',
      delayMs: PANEL_EVENT_REFIT_DEBOUNCE_MS,
      scheduleSettleCleanup: false,
    });
  });
});
