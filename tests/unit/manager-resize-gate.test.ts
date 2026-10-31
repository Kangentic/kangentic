/**
 * Unit coverage for the manager-resize gate.
 *
 * The window manager's imperative resizers open a gesture on the gate for the
 * duration of a drag, so a window-hosted terminal suppresses its per-frame
 * ResizeObserver refit and the PTY is resized once on commit instead of once per
 * drag frame (which would stack duplicate Claude banners in scrollback).
 *
 * Every window terminal's refit waits on the gate, so one gesture left open
 * froze all of their grids until a reload (a task window grew to 1981px while
 * its terminal kept the 1483px grid it mounted at). The gate therefore closes a
 * gesture itself once the pointer shows its button up. These cases drive the
 * factory over a plain EventTarget standing in for the window; Node has no
 * PointerEvent, so the pointer fields ride on a plain Event.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  beginManagerResize,
  createManagerResizeGate,
  deferUntilManagerResizeEnds,
  isManagerResizeInProgress,
  WINDOW_RESIZE_SETTLE_MS,
} from '../../src/renderer/window-manager/terminal/manager-resize-gate';

const MOUSE = 1;

function pointerEvent(type: string, fields: { pointerId?: number; buttons?: number; button?: number }): Event {
  return Object.assign(new Event(type), { pointerId: MOUSE, buttons: 0, button: -1, ...fields });
}

/** Let a release finish dispatching, so the gate's look after it has run. */
const afterDispatch = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('manager-resize gate', () => {
  it('starts closed, opens on begin, and closes on the gesture end', () => {
    const gate = createManagerResizeGate(new EventTarget());
    expect(gate.isInProgress()).toBe(false);
    const gesture = gate.begin('test', MOUSE, () => {});
    expect(gate.isInProgress()).toBe(true);
    gesture.end();
    expect(gate.isInProgress()).toBe(false);
  });

  it('stays open across overlapping gestures until every one has ended', () => {
    const gate = createManagerResizeGate(new EventTarget());
    const first = gate.begin('first', MOUSE, () => {});
    const second = gate.begin('second', 2, () => {});
    first.end();
    expect(gate.isInProgress()).toBe(true);
    second.end();
    expect(gate.isInProgress()).toBe(false);
  });

  it('ends a gesture once: a second end cannot close another gesture', () => {
    const gate = createManagerResizeGate(new EventTarget());
    const first = gate.begin('first', MOUSE, () => {});
    gate.begin('second', 2, () => {});
    first.end();
    first.end();
    expect(gate.isInProgress()).toBe(true);
  });

  it('runs a deferred call once, when the LAST open gesture ends', () => {
    // A live container resize (the Command Terminal panel's edge) asks for a
    // terminal resize on every frame; the gate holds one and sends it at the end.
    const gate = createManagerResizeGate(new EventTarget());
    let runs = 0;
    const first = gate.begin('first', MOUSE, () => {});
    const second = gate.begin('second', 2, () => {});
    gate.deferUntilEnds(() => { runs += 1; });
    gate.deferUntilEnds(() => { runs += 1; });
    first.end();
    expect(runs).toBe(0);
    second.end();
    expect(runs).toBe(1);
    // Spent: a later gesture's end does not run it again.
    gate.begin('third', MOUSE, () => {}).end();
    expect(runs).toBe(1);
  });

  it('abandons a gesture on a move that shows its button up, and sends the held resize', () => {
    // The release never reached the owner's handler. The first move after it
    // carries buttons 0: the owner commits its drag, and the terminals refit.
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    const onAbandoned = vi.fn();
    const deferred = vi.fn();
    gate.begin('window-resize', MOUSE, onAbandoned);
    gate.deferUntilEnds(deferred);
    target.dispatchEvent(pointerEvent('pointermove', { buttons: 1 }));
    expect(gate.isInProgress()).toBe(true);
    target.dispatchEvent(pointerEvent('pointermove', { buttons: 0 }));
    expect(onAbandoned).toHaveBeenCalledTimes(1);
    expect(gate.isInProgress()).toBe(false);
    expect(deferred).toHaveBeenCalledTimes(1);
  });

  it('abandons on a pointerover with the button up too', () => {
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    gate.begin('tile-seam', MOUSE, () => {});
    target.dispatchEvent(pointerEvent('pointerover', { buttons: 0 }));
    expect(gate.isInProgress()).toBe(false);
  });

  it('leaves another pointer\'s gesture alone', () => {
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    const onAbandoned = vi.fn();
    gate.begin('touch-drag', 7, onAbandoned);
    target.dispatchEvent(pointerEvent('pointermove', { pointerId: MOUSE, buttons: 0 }));
    expect(onAbandoned).not.toHaveBeenCalled();
    expect(gate.isInProgress()).toBe(true);
  });

  it('abandons the old gesture on a new primary press of the same pointer', () => {
    // A press cannot follow a press without a release between them.
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    const onAbandoned = vi.fn();
    gate.begin('footprint-edge', MOUSE, onAbandoned);
    target.dispatchEvent(pointerEvent('pointerdown', { buttons: 1, button: 0 }));
    expect(onAbandoned).toHaveBeenCalledTimes(1);
    expect(gate.isInProgress()).toBe(false);
  });

  it('keeps the drag through a second button pressed while the primary is held', () => {
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    gate.begin('window-resize', MOUSE, () => {});
    target.dispatchEvent(pointerEvent('pointerdown', { buttons: 3, button: 2 }));
    expect(gate.isInProgress()).toBe(true);
  });

  it('leaves a release its owner answered alone, and abandons one no owner answered', async () => {
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    const answered = vi.fn();
    const gesture = gate.begin('tile-seam', MOUSE, answered);
    target.addEventListener('pointerup', () => gesture.end());
    target.dispatchEvent(pointerEvent('pointerup', { buttons: 0 }));
    await afterDispatch();
    expect(answered).not.toHaveBeenCalled();

    const unanswered = vi.fn();
    gate.begin('window-resize', MOUSE, unanswered);
    target.dispatchEvent(pointerEvent('pointercancel', { buttons: 0 }));
    expect(gate.isInProgress()).toBe(true);
    await afterDispatch();
    expect(unanswered).toHaveBeenCalledTimes(1);
    expect(gate.isInProgress()).toBe(false);
  });

  it('spares a gesture the same pointer opened after the release, when the look runs late', async () => {
    // Input outranks the timer: under a fast drag it ran 61ms late, after the
    // next press had opened its own gesture, and ended that drag at its first step.
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    const first = gate.begin('command-terminal-panel', MOUSE, () => {});
    target.addEventListener('pointerup', () => first.end());
    target.dispatchEvent(pointerEvent('pointerup', { buttons: 0 }));
    const next = vi.fn();
    gate.begin('command-terminal-panel', MOUSE, next);
    await afterDispatch();
    expect(next).not.toHaveBeenCalled();
    expect(gate.isInProgress()).toBe(true);
  });

  it('abandons every gesture when the window loses focus', () => {
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    gate.begin('first', MOUSE, () => {});
    gate.begin('second', 7, () => {});
    target.dispatchEvent(new Event('blur'));
    expect(gate.isInProgress()).toBe(false);
  });

  it('closes every gesture in a sweep even when an owner throws on abandon', () => {
    const target = new EventTarget();
    const gate = createManagerResizeGate(target);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    gate.begin('command-terminal-panel', MOUSE, () => { throw new Error('owner failed'); });
    gate.begin('window-resize', MOUSE, second);
    target.dispatchEvent(pointerEvent('pointermove', { buttons: 0 }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(gate.isInProgress()).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('listens for the pointer only while a gesture is open, and for the window resizing always', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const gate = createManagerResizeGate(target);
    expect(add.mock.calls.map((call) => call[0])).toEqual(['resize']);
    add.mockClear();
    const first = gate.begin('first', MOUSE, () => {});
    const second = gate.begin('second', MOUSE, () => {});
    const listened = add.mock.calls.length;
    expect(listened).toBeGreaterThan(0);
    first.end();
    expect(remove).not.toHaveBeenCalled();
    second.end();
    expect(remove.mock.calls.length).toBe(listened);
  });

  it('names the owner of every gesture it opens and abandons', () => {
    const target = new EventTarget();
    const trace = vi.fn();
    const gate = createManagerResizeGate(target, trace);
    gate.begin('window-resize', MOUSE, () => {});
    target.dispatchEvent(pointerEvent('pointermove', { buttons: 0 }));
    expect(trace).toHaveBeenCalledWith('manager-resize-begin', expect.objectContaining({ owner: 'window-resize' }));
    expect(trace).toHaveBeenCalledWith('manager-resize-abandoned', { owner: 'window-resize', reason: 'pointermove' });
  });

  describe('a drag of the OS window edge', () => {
    // The page sees no pointer for it, only one resize event a frame, and each
    // reached every window terminal unheld: 40 PTY resizes for a 40-step drag.
    afterEach(() => { vi.useRealTimers(); });

    it('leaves a lone resize alone, so a maximize or a snap refits at once', () => {
      vi.useFakeTimers();
      const target = new EventTarget();
      const gate = createManagerResizeGate(target);
      target.dispatchEvent(new Event('resize'));
      expect(gate.isInProgress()).toBe(false);
      vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS * 2);
      target.dispatchEvent(new Event('resize'));
      expect(gate.isInProgress()).toBe(false);
    });

    it('holds a run of resizes as one gesture and sends the held refit once the size has held', async () => {
      vi.useFakeTimers();
      const target = new EventTarget();
      const ended = vi.fn();
      const gate = createManagerResizeGate(target, () => {}, { onWindowResizeEnd: ended });
      let refits = 0;
      for (let step = 0; step < 40; step += 1) {
        target.dispatchEvent(new Event('resize'));
        // Every frame of the drag asks for a refit; the gate keeps the last ask.
        if (gate.isInProgress()) gate.deferUntilEnds(() => { refits += 1; });
        vi.advanceTimersByTime(16);
      }
      expect(gate.isInProgress()).toBe(true);
      expect(refits).toBe(0);
      vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS);
      expect(gate.isInProgress()).toBe(false);
      expect(refits).toBe(1);
      await Promise.resolve();
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('is no pointer\'s: a move with the button up does not end it, and the window losing focus does', async () => {
      vi.useFakeTimers();
      const target = new EventTarget();
      const ended = vi.fn();
      const gate = createManagerResizeGate(target, () => {}, { onWindowResizeEnd: ended });
      target.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(16);
      target.dispatchEvent(new Event('resize'));
      expect(gate.isInProgress()).toBe(true);
      target.dispatchEvent(pointerEvent('pointermove', { buttons: 0 }));
      expect(gate.isInProgress()).toBe(true);
      target.dispatchEvent(new Event('blur'));
      expect(gate.isInProgress()).toBe(false);
      await Promise.resolve();
      expect(ended).toHaveBeenCalledTimes(1);
      // The settle timer the blur cut short ends nothing a second time.
      vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS * 2);
      await Promise.resolve();
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('holds its refit while a pointer gesture is still open, and sends it when that one ends', async () => {
      vi.useFakeTimers();
      const target = new EventTarget();
      const ended = vi.fn();
      const gate = createManagerResizeGate(target, () => {}, { onWindowResizeEnd: ended });
      const seamDrag = gate.begin('tile-splitter', MOUSE, () => {});
      target.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(16);
      target.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS);
      await Promise.resolve();
      expect(ended).not.toHaveBeenCalled();
      expect(gate.isInProgress()).toBe(true);
      seamDrag.end();
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('stops watching the window once disposed', () => {
      vi.useFakeTimers();
      const target = new EventTarget();
      const gate = createManagerResizeGate(target);
      gate.dispose();
      target.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(16);
      target.dispatchEvent(new Event('resize'));
      expect(gate.isInProgress()).toBe(false);
    });
  });

  it('exports one shared gate for the resizers and the resize coalescer', () => {
    let runs = 0;
    const gesture = beginManagerResize('test', MOUSE, () => {});
    expect(isManagerResizeInProgress()).toBe(true);
    deferUntilManagerResizeEnds(() => { runs += 1; });
    gesture.end();
    expect(isManagerResizeInProgress()).toBe(false);
    expect(runs).toBe(1);
  });
});
