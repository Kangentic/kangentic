import type { WebContents } from 'electron';

/**
 * Whether a CDP key event sent to this guest RIGHT NOW would land in its host's
 * own document instead of the page.
 *
 * WHY THIS EXISTS. Chromium does not deliver `Input.dispatchKeyEvent` to the
 * target it was sent to. It delivers it to whichever widget holds keyboard
 * focus across the whole window, and a `<webview>` guest shares that window
 * with Kangentic's own renderer. So when the user's terminal holds focus, an
 * agent's key goes to the terminal: an agent-sent Escape interrupted the very
 * agent that sent it, and a typed string would land in a live prompt. Measured
 * on Electron 41 with a standalone probe (a textarea standing in for the
 * terminal beside a 740x749 guest): with the textarea focused, a selector-less
 * `x` and `Escape` arrived at the textarea as TRUSTED keydowns, on a same-origin
 * page and with a cross-site iframe focused inside the guest alike, and the
 * guest's `before-input-event` fired zero times. The iframe was never the
 * cause.
 *
 * THE SIGNAL. `hostWebContents.focusedFrame` resolves across the guest
 * boundary: it names a frame of the host's own document while the host holds
 * focus, and a guest frame (a cross-site iframe included) or null while the
 * guest does. Across every probe cell - host textarea, host body, guest input,
 * guest iframe, each with the window focused and blurred - a host frame here
 * meant the key landed in the host, and anything else meant it landed in the
 * guest. It reads the same browser-process state that routes the key.
 *
 * WHY SYNCHRONOUS MATTERS. The caller checks this and hands the command to
 * `sendCommand` in the same turn of the main thread, with no `await` between.
 * A focus change reaches the browser process as its own task on that thread,
 * so none can land between the check and the hand-off. A renderer-side probe
 * (`executeJavaScript` asking whether the `<webview>` is `activeElement`) was
 * equally accurate in the probe, but it crosses a process boundary and leaves
 * a window in which the user can click into their terminal.
 *
 * Only a guest has a `hostWebContents`. A lane (its own offscreen window) and
 * Kangentic's own window under the dev bridge have none, so a key sent to them
 * cannot leave them and this returns false.
 *
 * It only READS focus. Nothing here may take it: the driver never moves focus
 * on its own, see `.claude/rules/agent-driven-focus.md`.
 */
export function keyboardFocusIsInHost(webContents: WebContents): boolean {
  const host = webContents.hostWebContents;
  if (!host || host.isDestroyed()) return false;
  try {
    const focusedFrame = host.focusedFrame;
    if (!focusedFrame) return false;
    // Walk `parent` to the root rather than trusting `top`. Electron documents
    // `parent` as null exactly at the top of a frame hierarchy and says nothing
    // about when `top` is null, and a null `top` on a host subframe would have
    // compared the subframe itself, read "not in host", and sent the key: the
    // unsafe direction. A guest's main frame has no parent here (measured in
    // the same probe), so a guest frame never walks up into the host.
    let rootFrame = focusedFrame;
    while (rootFrame.parent) rootFrame = rootFrame.parent;
    return rootFrame.frameTreeNodeId === host.mainFrame.frameTreeNodeId;
  } catch {
    // Cannot tell where the key would go, so treat it as the unsafe answer: a
    // key that is not sent is recoverable, a key sent into a terminal is not.
    return true;
  }
}

/**
 * Thrown by `dispatchKeyEvent` instead of sending a key the guest would not
 * receive. `withGuest` turns it into the `pane-not-focused` error kind.
 */
export class KeyboardFocusNotInGuestError extends Error {
  constructor() {
    super('Keyboard focus is outside the Browser pane, so the key was not sent.');
    this.name = 'KeyboardFocusNotInGuestError';
  }
}
