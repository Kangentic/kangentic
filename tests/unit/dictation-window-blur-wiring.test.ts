/**
 * Push-to-talk ends its hold when the OS window loses focus, and the signal is
 * sent from the main window's own `blur` event. DOM `window` blur is not a
 * substitute: it also fires when a click moves focus into a Browser pane
 * guest, and a click into the page must never end a hold.
 *
 * src/main/index.ts cannot be imported (it boots the app), so this reads its
 * text. It pins that the `blur` listener sends TRANSCRIBE_WINDOW_BLUR to the
 * renderer and only while the window is alive, since a blur can land during
 * teardown and a send to a destroyed window throws.
 *
 * Red-green: remove the `isDestroyed()` guard, change the channel, or move the
 * send off `mainWindow.on('blur'` and a case below fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf-8');

/** The body of the `mainWindow.on('blur', ...)` listener, up to its closing `});`. */
function blurListenerBody(): string {
  const start = INDEX_SOURCE.indexOf("mainWindow.on('blur'");
  expect(start, "src/main/index.ts must register mainWindow.on('blur')").toBeGreaterThan(-1);
  const end = INDEX_SOURCE.indexOf('});', start);
  return INDEX_SOURCE.slice(start, end);
}

describe("the main window's blur event reaches push-to-talk", () => {
  it('sends TRANSCRIBE_WINDOW_BLUR to the renderer from the blur listener', () => {
    expect(blurListenerBody()).toMatch(/webContents\.send\(\s*IPC\.TRANSCRIBE_WINDOW_BLUR\s*\)/);
  });

  it('sends only while the window is not destroyed', () => {
    const body = blurListenerBody();
    const guard = body.indexOf('!mainWindow.isDestroyed()');
    const send = body.indexOf('IPC.TRANSCRIBE_WINDOW_BLUR');
    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(guard);
  });

  it('registers one blur listener, so the signal is not sent twice', () => {
    expect(INDEX_SOURCE.split("mainWindow.on('blur'").length - 1).toBe(1);
  });
});
