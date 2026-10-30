import { describe, it, expect, afterEach } from 'vitest';
import { createOverlayEntry, isAnyOverlayOpen, type OverlayEntry } from '../../src/renderer/utils/overlay-gate';

// The overlay gate is the stack BaseDialog's save key reads: only the topmost
// open overlay acts on Ctrl+S, so a dialog opened over another one (Edit
// automation over the Board Manager) takes the key and the one beneath leaves
// it alone. `useRegisterOpenOverlay` creates one entry per overlay in render
// and drives it from an effect: `open` on mount, `close` on cleanup,
// `deactivate` while `active` is false. These tests drive the entry the same
// way, since the unit tier has no DOM to render the hook in.

const created: OverlayEntry[] = [];

/** An entry created and opened at once, as an overlay that mounts alone. */
function open(): OverlayEntry {
  const entry = createOverlayEntry();
  created.push(entry);
  entry.open();
  return entry;
}

afterEach(() => {
  for (const entry of created.splice(0)) entry.close();
});

describe('overlay stack', () => {
  it('puts the overlay opened last on top', () => {
    const boardManager = open();
    expect(boardManager.isTop()).toBe(true);
    const editAutomation = open();
    expect(editAutomation.isTop()).toBe(true);
    expect(boardManager.isTop()).toBe(false);
  });

  it('hands the top back to the overlay below when the one on top closes', () => {
    const boardManager = open();
    const editAutomation = open();
    editAutomation.close();
    expect(editAutomation.isTop()).toBe(false);
    expect(boardManager.isTop()).toBe(true);
  });

  it('keeps an overlay in place when its effect runs again', () => {
    // A Fast Refresh re-runs an edited dialog's effect: cleanup closes it and
    // the effect opens it again. With the number it opened with, it stays
    // underneath.
    const newTask = open();
    const settings = open();
    newTask.close();
    newTask.open();
    expect(settings.isTop()).toBe(true);
    expect(newTask.isTop()).toBe(false);
  });

  it('lifts an overlay to the top when it is reopened after deactivating', () => {
    const lower = open();
    const upper = open();
    lower.deactivate();
    expect(lower.isTop()).toBe(false);
    expect(upper.isTop()).toBe(true);
    lower.open();
    expect(lower.isTop()).toBe(true);
    expect(upper.isTop()).toBe(false);
  });

  it('keeps creation order when a child overlay opens before its parent', () => {
    // A Fast Refresh remount of the settings panel and a dialog one of its tabs
    // opened: render creates the panel's entry first, then the dialog's, and
    // effects open them child first.
    const settingsPanel = createOverlayEntry();
    const tabDialog = createOverlayEntry();
    created.push(settingsPanel, tabDialog);
    tabDialog.open();
    settingsPanel.open();
    expect(tabDialog.isTop()).toBe(true);
    expect(settingsPanel.isTop()).toBe(false);
  });

  it('takes a fresh number for an overlay that mounted inactive', () => {
    // Created in render while hidden, opened later: it goes above everything
    // opened in between, not at the number it was created with.
    const hidden = createOverlayEntry();
    created.push(hidden);
    hidden.deactivate();
    const opened = open();
    hidden.open();
    expect(hidden.isTop()).toBe(true);
    expect(opened.isTop()).toBe(false);
  });

  it('reports whether anything is open', () => {
    expect(isAnyOverlayOpen()).toBe(false);
    const dialog = open();
    expect(isAnyOverlayOpen()).toBe(true);
    dialog.close();
    expect(isAnyOverlayOpen()).toBe(false);
  });

  it('never reports a closed overlay as on top', () => {
    const neverOpened = createOverlayEntry();
    expect(neverOpened.isTop()).toBe(false);
  });
});
