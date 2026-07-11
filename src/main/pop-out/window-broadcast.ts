import type { BrowserWindow } from 'electron';
import { recordPush } from '../diagnostics/ipc-recorder';
import { popOutWindowManager } from './pop-out-window-manager';

/**
 * Fan a main -> renderer push to the main window AND every open pop-out window whose
 * surface declared `channel` in its fan-out list (src/shared/pop-out.ts). Guards every
 * destroyed target, mirrors once into the IPC traffic recorder (mirroring the existing
 * sendToRenderer chokepoint in mcp-project-context.ts), and never throws.
 *
 * Additive: this does not replace context.mainWindow or any main-only send site. Only
 * the sites whose channel a pop-out surface actually declares route through here.
 */
export function broadcast(mainWindow: BrowserWindow, channel: string, ...args: unknown[]): void {
  let delivered = false;
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
    delivered = true;
  }
  for (const popOutWindow of popOutWindowManager.windowsForChannel(channel)) {
    popOutWindow.webContents.send(channel, ...args);
    delivered = true;
  }
  recordPush(channel, args, delivered ? undefined : { dropped: true });
}
