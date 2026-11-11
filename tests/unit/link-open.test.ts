/**
 * What a click on a link does (src/renderer/utils/link-open.ts), and the
 * terminal's three guards on a plain click
 * (src/renderer/utils/terminal-links/link-gesture.ts).
 *
 * A plain click opens the browser the "Click opens links in" setting names and
 * Ctrl or Cmd click opens the other (#1056). What a user loses if this goes: a
 * setting that swaps nothing, a tip whose rows disagree with the click, a
 * bottom-panel link that opens nothing, a drag across a URL that opens a
 * browser, or the click that only brought a terminal forward opening one.
 */
import { describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({ linkClickTarget: undefined as 'default' | 'kangentic' | undefined }));
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ config: { linkClickTarget: configState.linkClickTarget } }) },
}));

import { isLinkOpenGesture, isPlainClick, planLinkActions } from '../../src/renderer/utils/link-open';
import { createTerminalLinkTargets, readLinkClickTarget } from '../../src/renderer/utils/terminal-links/link-targets';
import { createTerminalLinkGesture, heldPressAfterReport, LINK_CLICK_DRAG_THRESHOLD_PX } from '../../src/renderer/utils/terminal-links/link-gesture';
import { formatComboSegments } from '../../src/renderer/utils/keybindings';
import { comboToAccelerator, KEYBINDINGS } from '../../src/shared/keybindings';

function click(modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) {
  return { ctrlKey: modifiers.ctrl === true, metaKey: modifiers.meta === true, altKey: modifiers.alt === true, shiftKey: modifiers.shift === true };
}

describe('planLinkActions', () => {
  it('opens the default browser on a click and the Kangentic browser on Ctrl+click, by default', () => {
    const plan = planLinkActions('default', true, false);
    expect(plan.actions).toEqual([
      { target: 'default-browser', combo: 'Mouse:Left' },
      { target: 'kangentic-browser', combo: 'Mod+Mouse:Left' },
    ]);
    expect(plan.targetFor(click())).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true }))).toBe('kangentic-browser');
  });

  it('swaps both the rows and the clicks when the setting names the Kangentic browser', () => {
    const plan = planLinkActions('kangentic', true, false);
    expect(plan.actions.map((action) => action.target)).toEqual(['kangentic-browser', 'default-browser']);
    expect(plan.targetFor(click())).toBe('kangentic-browser');
    expect(plan.targetFor(click({ ctrl: true }))).toBe('default-browser');
  });

  it('opens the default browser on either click where there is no Kangentic browser, with one row', () => {
    for (const setting of ['default', 'kangentic'] as const) {
      const plan = planLinkActions(setting, false, false);
      expect(plan.actions).toEqual([{ target: 'default-browser', combo: 'Mouse:Left' }]);
      expect(plan.targetFor(click())).toBe('default-browser');
      expect(plan.targetFor(click({ ctrl: true }))).toBe('default-browser');
    }
  });

  it('leaves a Shift or Alt click to whatever owns it', () => {
    const plan = planLinkActions('default', true, false);
    expect(plan.targetFor(click({ shift: true }))).toBeNull();
    expect(plan.targetFor(click({ alt: true }))).toBeNull();
    expect(planLinkActions('default', false, false).targetFor(click({ shift: true }))).toBeNull();
  });

  it('reads Cmd as the other-browser key on a Mac, where Ctrl+click is a right click', () => {
    const plan = planLinkActions('default', true, true);
    expect(plan.targetFor(click({ meta: true }))).toBe('kangentic-browser');
    expect(plan.targetFor(click({ ctrl: true }))).toBeNull();
    expect(isLinkOpenGesture(click({ ctrl: true }), true)).toBe(false);
    expect(isPlainClick(click({ ctrl: true }))).toBe(false);
  });
});

describe('createTerminalLinkTargets reading the setting', () => {
  const KANGENTIC = { open: vi.fn() };

  it('reads the default browser when the setting was never saved', () => {
    configState.linkClickTarget = undefined;
    expect(readLinkClickTarget()).toBe('default');
  });

  it('follows the setting live, and opens where the click named', () => {
    const openExternal = vi.fn();
    const targets = createTerminalLinkTargets({ getBrowser: () => KANGENTIC, openExternal });
    configState.linkClickTarget = 'kangentic';
    try {
      expect(targets.plan().targetFor(click())).toBe('kangentic-browser');
      targets.open('kangentic-browser', 'https://example.com/a');
      expect(KANGENTIC.open).toHaveBeenCalledWith('https://example.com/a');
      targets.open('default-browser', 'https://example.com/b');
      expect(openExternal).toHaveBeenCalledWith('https://example.com/b');
    } finally {
      configState.linkClickTarget = undefined;
    }
  });

  it('opens the default browser when the Kangentic browser went away between the hover and the click', () => {
    const openExternal = vi.fn();
    const targets = createTerminalLinkTargets({ getBrowser: () => null, openExternal });
    targets.open('kangentic-browser', 'https://example.com/c');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/c');
  });
});

describe('the click as key chips', () => {
  it('draws a plain click as one chip, and a modified one after its modifier', () => {
    expect(formatComboSegments('Mouse:Left', false)).toEqual(['Click']);
    expect(formatComboSegments('Mod+Mouse:Left', false)).toEqual(['Ctrl', 'Click']);
    expect(formatComboSegments('Mod+Mouse:Left', true)).toEqual(['⌘', 'Click']);
  });

  it('is never an OS shortcut to probe', () => {
    expect(comboToAccelerator('Mouse:Left')).toBeNull();
  });

  it('is not a hotkey: the registry holds no link click action to rebind', () => {
    expect(KEYBINDINGS.filter((definition) => definition.id.startsWith('terminal.openLink'))).toEqual([]);
    expect(KEYBINDINGS.filter((definition) => definition.defaultCombo.includes('Mouse:Left'))).toEqual([]);
  });
});

/**
 * The gesture reads DOM events, so it is driven through a small stand-in for
 * the terminal's element and the window: only the listeners it registers.
 */
function gestureRig(options: { focused: boolean }) {
  type Listener = (event: MouseEvent) => void;
  const elementListeners: Listener[] = [];
  const windowListeners = new Map<string, Set<Listener>>();
  const element = {
    addEventListener: (_type: string, listener: Listener) => { elementListeners.push(listener); },
    contains: () => options.focused,
    ownerDocument: { activeElement: {} },
  } as unknown as HTMLElement;
  const eventTarget = {
    addEventListener: (type: string, listener: Listener) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => { windowListeners.get(type)?.delete(listener); },
  } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  // A URL opens on a plain click and on Ctrl; anything else is not a link click.
  const gesture = createTerminalLinkGesture(eventTarget, (event) => isPlainClick(event) || event.ctrlKey);
  gesture.attach(element);
  const mouse = (modifiers: { ctrl?: boolean } = {}, x = 100, y = 100): MouseEvent =>
    ({ ...click(modifiers), button: 0, clientX: x, clientY: y } as unknown as MouseEvent);
  return {
    gesture,
    press: (event: MouseEvent) => { for (const listener of elementListeners) listener(event); },
    move: (event: MouseEvent) => { for (const listener of [...(windowListeners.get('mousemove') ?? [])]) listener(event); },
    // The gesture registers its mouseup listener with `once`, so fire and clear it.
    release: (event: MouseEvent) => {
      const listeners = [...(windowListeners.get('mouseup') ?? [])];
      windowListeners.get('mouseup')?.clear();
      for (const listener of listeners) listener(event);
    },
    mouse,
  };
}

describe('heldPressAfterReport', () => {
  const SGR_PRESS = '\x1b[<0;10;5M';
  const SGR_RELEASE = '\x1b[<0;10;5m';
  // X10 bytes are button+32, column+32, row+32: row 77 is the byte 'm' (109).
  const X10_PRESS_ROW_77 = '\x1b[M' + ' ' + '*' + 'm';

  it('holds an SGR press when nothing is held', () => {
    expect(heldPressAfterReport(SGR_PRESS, null)).toBe(SGR_PRESS);
  });

  it('holds nothing for an SGR release', () => {
    expect(heldPressAfterReport(SGR_RELEASE, null)).toBeNull();
    expect(heldPressAfterReport(SGR_RELEASE, SGR_PRESS)).toBeNull();
  });

  it('holds an X10 press even when its row byte is m, which is not a release mark', () => {
    expect(X10_PRESS_ROW_77.endsWith('m')).toBe(true);
    expect(heldPressAfterReport(X10_PRESS_ROW_77, null)).toBe(X10_PRESS_ROW_77);
  });

  it('reads an X10 report that arrives while a press is held as the release, and holds nothing', () => {
    const x10Release = '\x1b[M' + '#' + '*' + '%';
    expect(heldPressAfterReport(x10Release, X10_PRESS_ROW_77)).toBeNull();
    expect(heldPressAfterReport(X10_PRESS_ROW_77, X10_PRESS_ROW_77)).toBeNull();
  });
});

describe('a plain click on a terminal link', () => {
  it('claims the press and opens on release when the terminal holds the keyboard', () => {
    const rig = gestureRig({ focused: true });
    rig.gesture.noteLinkHover({ event: { clientY: 100 }, range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, kind: 'url' });
    rig.press(rig.mouse());
    expect(rig.gesture.isClickingLink()).toBe(true);
    expect(rig.gesture.opensOnRelease(click())).toBe(true);
  });

  it('lets go of the press when it turns into a drag, tells the terminal, and opens nothing', () => {
    const rig = gestureRig({ focused: true });
    const released = vi.fn();
    rig.gesture.onClaimReleased(released);
    rig.gesture.noteLinkHover({ event: { clientY: 100 }, range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, kind: 'url' });
    rig.press(rig.mouse());

    // A wobble under the threshold is still a click.
    rig.move(rig.mouse({}, 100 + LINK_CLICK_DRAG_THRESHOLD_PX, 100));
    expect(rig.gesture.isClickingLink()).toBe(true);
    expect(released).not.toHaveBeenCalled();

    rig.move(rig.mouse({}, 100 + LINK_CLICK_DRAG_THRESHOLD_PX + 1, 100));
    expect(rig.gesture.isClickingLink()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    expect(rig.gesture.opensOnRelease(click())).toBe(false);
  });

  it('opens nothing when the press only brought the terminal forward', () => {
    const rig = gestureRig({ focused: false });
    rig.gesture.noteLinkHover({ event: { clientY: 100 }, range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, kind: 'url' });
    rig.press(rig.mouse());
    expect(rig.gesture.isClickingLink()).toBe(false);
    expect(rig.gesture.opensOnRelease(click())).toBe(false);
  });

  it('a Ctrl click opens whether or not the terminal held the keyboard, and a drag does not cancel it', () => {
    const rig = gestureRig({ focused: false });
    rig.gesture.noteLinkHover({ event: { clientY: 100 }, range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, kind: 'url' });
    rig.press(rig.mouse({ ctrl: true }));
    rig.move(rig.mouse({ ctrl: true }, 200, 100));
    expect(rig.gesture.isClickingLink()).toBe(true);
    expect(rig.gesture.opensOnRelease(click({ ctrl: true }))).toBe(true);
  });

  it('is over once released: the link\'s own release still opens, a later one with no press does not', () => {
    vi.useFakeTimers();
    try {
      const rig = gestureRig({ focused: true });
      rig.gesture.noteLinkHover({ event: { clientY: 100 }, range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, kind: 'url' });
      rig.press(rig.mouse());
      rig.release(rig.mouse());

      // Same tick as the mouseup: the link's own release reads its press.
      expect(rig.gesture.opensOnRelease(click())).toBe(true);
      expect(rig.gesture.isClickingLink()).toBe(true);

      vi.runAllTimers();
      expect(rig.gesture.opensOnRelease(click())).toBe(false);
      expect(rig.gesture.isClickingLink()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims nothing for a press that is not on a link', () => {
    const rig = gestureRig({ focused: true });
    rig.press(rig.mouse());
    expect(rig.gesture.isClickingLink()).toBe(false);
    expect(rig.gesture.opensOnRelease(click())).toBe(false);
  });
});
