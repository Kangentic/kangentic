import type { BrowserWindow } from 'electron';
import { recordPush } from '../diagnostics/ipc-recorder';

/**
 * Send a main -> renderer push to the main window, guarding against a destroyed
 * window and mirroring the send into the IPC traffic recorder. This is the
 * shared chokepoint for main-window-only board-invalidation pushes (the MCP
 * command context's callbacks and the PR linker's `onLinked`), so the dev IPC
 * log (`kangentic_get_ipc_log`) sees the whole outbound pipeline that the
 * renderer-side board reload depends on. A dropped push (window destroyed) is
 * still recorded, with a `PushDropped` marker, so a lost event leaves a trace
 * instead of vanishing silently.
 *
 * It lives here rather than beside one of its callers because a raw
 * `webContents.send` at any of them is invisible to the recorder - which is
 * exactly the bug this module was extracted to close.
 *
 * Distinct from `broadcast` (`src/main/pop-out/window-broadcast.ts`), which
 * additionally fans a push out to every open pop-out window that declared the
 * channel. Use `broadcast` when a pop-out surface consumes the channel; use
 * this when only the main window does. Both record.
 */
export function sendToRenderer(mainWindow: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (mainWindow.isDestroyed()) {
    recordPush(channel, args, { dropped: true });
    return;
  }
  mainWindow.webContents.send(channel, ...args);
  recordPush(channel, args);
}
