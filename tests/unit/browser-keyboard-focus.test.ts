/**
 * An agent's key never lands outside the Browser pane.
 *
 * Chromium delivers `Input.dispatchKeyEvent` to whichever widget holds keyboard
 * focus in the window, not to the guest it was sent to. A `<webview>` shares its
 * window with Kangentic's own renderer, so with the user's terminal focused, an
 * agent's `kangentic_browser_keypress Escape` went to that terminal and
 * interrupted the agent that sent it (task #720). Measured with a standalone
 * probe on Electron 41: a textarea standing in for the terminal received the
 * agent's `x` and `Escape` as TRUSTED keydowns, same-origin page or cross-site
 * iframe alike, and the guest's `before-input-event` never fired.
 *
 * `keyboardFocusIsInHost` reads `hostWebContents.focusedFrame`, which the probe
 * showed names a host frame exactly when a key would land in the host. These
 * cases pin the predicate over that shape, then pin that the REAL `cdp.ts`
 * refuses every key event on it, without sending anything.
 *
 * Tier: Unit (vitest; the debugger and frames are fakes, no Electron).
 */
import { describe, it, expect, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  keyboardFocusIsInHost,
  KeyboardFocusNotInGuestError,
} from '../../src/main/browser/cdp/keyboard-focus';
import {
  attachDebugger,
  detachDebugger,
  dispatchKeyEvent,
  dispatchKeypress,
  dispatchMouseEvent,
  typeText,
} from '../../src/main/browser/cdp/cdp';

interface FakeFrame {
  frameTreeNodeId: number;
  parent: FakeFrame | null;
  top: FakeFrame | null;
}

/** A frame under `parent`, with `top` set the way Electron normally reports it. */
function frame(frameTreeNodeId: number, parent: FakeFrame | null = null): FakeFrame {
  const created: FakeFrame = { frameTreeNodeId, parent, top: null };
  created.top = parent ? parent.top : created;
  return created;
}

const hostMain = frame(1);
const hostSubframe = frame(2, hostMain);
// A guest's main frame has NO parent as seen through the host's focusedFrame:
// measured in the probe, so a guest frame never walks up into the host.
const guestMain = frame(10);
const guestCrossSiteIframe = frame(11, guestMain);

/**
 * A guest whose host reports `focused` as its focused frame, read at call time
 * so a test can move focus mid-sequence.
 */
function guestWithHost(focus: { current: FakeFrame | null }, options: { destroyed?: boolean; throws?: boolean } = {}) {
  const host = {
    isDestroyed: () => options.destroyed === true,
    mainFrame: hostMain,
    get focusedFrame() {
      if (options.throws) throw new Error('frame is gone');
      return focus.current;
    },
  };
  return { hostWebContents: host } as unknown as WebContents;
}

describe('keyboardFocusIsInHost', () => {
  it('is false with no host: a lane or Kangentic\'s own window cannot send a key anywhere else', () => {
    expect(keyboardFocusIsInHost({ hostWebContents: null } as unknown as WebContents)).toBe(false);
  });

  it('is true while the host document holds focus (the user\'s terminal, the host body)', () => {
    expect(keyboardFocusIsInHost(guestWithHost({ current: hostMain }))).toBe(true);
  });

  it('is true for a frame INSIDE the host document, not only its main frame', () => {
    expect(keyboardFocusIsInHost(guestWithHost({ current: hostSubframe }))).toBe(true);
  });

  it('is still true for a host subframe whose `top` reads null, since the check walks `parent`', () => {
    // Electron types `WebFrameMain.top` as nullable without saying when. Trusting
    // it (`top ?? focusedFrame`) would compare the subframe itself here, read
    // "not in host", and SEND the key: the unsafe direction.
    const hostSubframeWithoutTop: FakeFrame = { frameTreeNodeId: 3, parent: hostMain, top: null };
    expect(keyboardFocusIsInHost(guestWithHost({ current: hostSubframeWithoutTop }))).toBe(true);
  });

  it('is false while the guest page holds focus', () => {
    expect(keyboardFocusIsInHost(guestWithHost({ current: guestMain }))).toBe(false);
  });

  it('is false while a cross-site iframe inside the guest holds focus, which is where the key then goes', () => {
    // The probe's cell D and E: the key reached the iframe and closed its dialog.
    expect(keyboardFocusIsInHost(guestWithHost({ current: guestCrossSiteIframe }))).toBe(false);
  });

  it('is false when no frame is reported, which the probe saw only with the guest holding focus', () => {
    expect(keyboardFocusIsInHost(guestWithHost({ current: null }))).toBe(false);
  });

  it('is false for a destroyed host, where there is nothing left to type into', () => {
    expect(keyboardFocusIsInHost(guestWithHost({ current: hostMain }, { destroyed: true }))).toBe(false);
  });

  it('fails CLOSED when the focused frame cannot be read', () => {
    // A key not sent can be retried. A key sent into a terminal cannot be taken back.
    expect(keyboardFocusIsInHost(guestWithHost({ current: guestMain }, { throws: true }))).toBe(true);
  });
});

/**
 * A guest with a spying debugger AND a host, for driving the real cdp.ts.
 * `onKeyEvent` runs after each key event is recorded, with the running count.
 */
function drivableGuest(focus: { current: FakeFrame | null }, onKeyEvent?: (keyEventCount: number) => void) {
  const sent: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const guest = {
    isDestroyed: () => false,
    hostWebContents: (guestWithHost(focus) as unknown as { hostWebContents: unknown }).hostWebContents,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        if (method === 'Input.dispatchKeyEvent') {
          onKeyEvent?.(sent.filter((entry) => entry.method === 'Input.dispatchKeyEvent').length);
        }
        return Promise.resolve({});
      }),
      on: () => {},
      removeListener: () => {},
    },
  } as unknown as WebContents;
  attachDebugger(guest);
  sent.length = 0;
  return { guest, sent, keyEvents: () => sent.filter((entry) => entry.method === 'Input.dispatchKeyEvent') };
}

describe('the real cdp.ts refuses a key the pane would not receive', () => {
  it('sends NOTHING for an Escape while the host holds focus, and says why', async () => {
    // The #720 repro. Red-green: remove the check in `dispatchKeyEvent` and the
    // Escape is sent, which in the live app landed in the agent's own terminal.
    const { guest, keyEvents } = drivableGuest({ current: hostMain });

    await expect(dispatchKeypress(guest, 'Escape')).rejects.toBeInstanceOf(KeyboardFocusNotInGuestError);

    expect(keyEvents()).toEqual([]);
    detachDebugger(guest);
  });

  it('sends the key when the guest holds focus, a cross-site iframe included', async () => {
    const { guest, keyEvents } = drivableGuest({ current: guestCrossSiteIframe });

    await dispatchKeypress(guest, 'Escape');

    expect(keyEvents().map((entry) => entry.params?.type)).toEqual(['keyDown', 'keyUp']);
    detachDebugger(guest);
  });

  it('stops a type the moment focus leaves the pane, instead of sending the rest into the host', async () => {
    // Checked per event, not once per call: a user who clicks into their
    // terminal partway through must not receive the remaining text.
    const focus: { current: FakeFrame | null } = { current: guestMain };
    // After the first character's keyUp, the user clicks their terminal.
    const { guest, keyEvents } = drivableGuest(focus, (keyEventCount) => {
      if (keyEventCount === 2) focus.current = hostMain;
    });

    await expect(typeText(guest, 'abc')).rejects.toBeInstanceOf(KeyboardFocusNotInGuestError);

    expect(keyEvents()).toHaveLength(2);
    expect(keyEvents()[0].params).toMatchObject({ type: 'keyDown', text: 'a' });
    detachDebugger(guest);
  });

  it('refuses a bare dispatchKeyEvent too, which the tools call directly for Backspace', async () => {
    const { guest, keyEvents } = drivableGuest({ current: hostMain });

    await expect(
      dispatchKeyEvent(guest, { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }),
    ).rejects.toBeInstanceOf(KeyboardFocusNotInGuestError);

    expect(keyEvents()).toEqual([]);
    detachDebugger(guest);
  });

  it('still sends a CLICK while the host holds focus: mouse input is hit-tested, and a click is how the pane gets focus', async () => {
    const { guest, sent } = drivableGuest({ current: hostMain });

    await dispatchMouseEvent(guest, { type: 'mousePressed', x: 10, y: 20 });

    expect(sent.map((entry) => entry.method)).toEqual(['Input.dispatchMouseEvent']);
    detachDebugger(guest);
  });
});
