/**
 * Global "a hotkey rebind capture is in progress" flag. While the Hotkeys
 * settings capture widget is listening for a new combo, every app keybinding
 * handler (the central `useKeybinding` hook and the hand-wired push-to-talk
 * listeners) suppresses its action. Without this, capturing a combo that
 * overlaps an existing binding fires that binding mid-capture - e.g. pressing
 * the mouse button currently bound to push-to-talk starts dictation instead of
 * being recorded as the new binding. The capture widget reads keys on its own
 * element (bubble phase), but several global listeners run in the capture phase
 * and would otherwise win the race.
 */

// hmr-safe: transient capture flag. A bare module-scope `let` is NOT reset by an
// unrelated Fast Refresh, so App.tsx's `vite:afterUpdate` handler force-resets it
// to false on every HMR (Pattern D). Without that, a capture interrupted mid-rebind
// by an HMR leaves this stuck true, silently killing every app shortcut (including
// push-to-talk) until a full reload. You are never legitimately mid-rebind across
// an HMR, and the capture widget re-arms it on remount if it still is.
let rebindCaptureActive = false;

export function setRebindCaptureActive(active: boolean): void {
  rebindCaptureActive = active;
}

export function isRebindCaptureActive(): boolean {
  return rebindCaptureActive;
}
