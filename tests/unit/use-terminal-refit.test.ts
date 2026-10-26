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
 * - resolveRefitTimerAction: what a debounced refit does when its timer fires. An
 *   observer refit is armed before a gesture may have opened (a drag of the OS
 *   window's edge opens the gate on its second resize), so it waits at fire time
 *   rather than fitting the terminal mid-gesture and sending the PTY a resize the
 *   gate was holding.
 * - resolvePanelResizeAction: how a terminal-panel-resize event is handled per
 *   host mode (synchronous fit+flush for immediatePanelResize, 0ms + settle
 *   cleanup for deferContainerResize, 50ms debounce otherwise), and that a
 *   user's layout change landing (its third argument) overrides every host
 *   mode with an immediate fit+flush.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldObserverScheduleRefit,
  resolveRefitTimerAction,
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

describe('resolveRefitTimerAction', () => {
  it('waits when an observer refit fires while a gesture is open', () => {
    // The race: the observer reports the drag's first layout with the gate still closed and arms its
    // 200ms refit, then the second resize opens the gate. Fitting here moved the grid mid-drag and the
    // PTY heard a resize 200ms later, which the gate exists to hold until the drag ends.
    expect(resolveRefitTimerAction(true, true)).toBe('wait-for-gesture');
  });

  it('fits when an observer refit fires with no gesture open', () => {
    expect(resolveRefitTimerAction(true, false)).toBe('fit');
  });

  it('fits a refit the observer did not arm, gesture or not', () => {
    // A terminal-panel-resize event is dispatched after a gesture ends, or by a host the gate does not
    // hold, so its debounced fit is the landing refit itself and must not wait on the gate.
    expect(resolveRefitTimerAction(false, true)).toBe('fit');
    expect(resolveRefitTimerAction(false, false)).toBe('fit');
  });

  it('agrees with shouldObserverScheduleRefit: whatever may not be armed mid-gesture may not fit mid-gesture', () => {
    // The two decisions guard the same gesture from both ends, the arming and the firing of one timer.
    for (const managerResizeInProgress of [false, true]) {
      const mayArm = shouldObserverScheduleRefit(false, managerResizeInProgress);
      const mayFire = resolveRefitTimerAction(true, managerResizeInProgress) === 'fit';
      expect(mayFire).toBe(mayArm);
    }
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

  describe('while a user\'s layout change lands', () => {
    // The third argument is `isTerminalLayoutLandingFor(element)` read at event time. A debounced
    // fit would reflow the old frame onto the new grid a beat later, so every host fits at once.
    it.each([
      { deferContainerResize: false, immediatePanelResize: false },
      { deferContainerResize: true, immediatePanelResize: false },
      { deferContainerResize: false, immediatePanelResize: true },
      { deferContainerResize: true, immediatePanelResize: true },
    ])(
      'fits and flushes at once for deferContainerResize=$deferContainerResize, immediatePanelResize=$immediatePanelResize',
      ({ deferContainerResize, immediatePanelResize }) => {
        expect(resolvePanelResizeAction(deferContainerResize, immediatePanelResize, true)).toEqual({ kind: 'immediate-fit-flush' });
      },
    );
  });

  it('treats an omitted landing flag as false, so the host-mode answers stand', () => {
    expect(resolvePanelResizeAction(false, false)).toEqual(resolvePanelResizeAction(false, false, false));
    expect(resolvePanelResizeAction(true, false)).toEqual(resolvePanelResizeAction(true, false, false));
    expect(resolvePanelResizeAction(false, true)).toEqual(resolvePanelResizeAction(false, true, false));
    expect(resolvePanelResizeAction(true, true)).toEqual(resolvePanelResizeAction(true, true, false));
  });
});
