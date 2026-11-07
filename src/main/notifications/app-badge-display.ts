/**
 * Puts the waiting count on the app icon, the way each platform does it: an image
 * overlay on the Windows taskbar button, and the system badge on the macOS Dock and
 * Linux launchers. `app.setBadgeCount` returns false on a desktop with no launcher
 * support, which is normal and needs no report.
 */
import { app, type BrowserWindow } from 'electron';
import { msg, plural } from '@lingui/core/runtime-macro';
import { translateText } from '../i18n/main-i18n';
import { loadOverlayImage, overlayLabel } from './badge-overlay-image';

export interface AppBadgeDisplay {
  show: (count: number) => void;
}

/**
 * A Windows overlay is lost when it is set before the taskbar button exists and
 * when Explorer restarts. Hearing that restart would take a native message hook,
 * so the same image goes back on whenever the window shows or takes focus: it costs
 * nothing, and a lost badge comes back when the user returns to the app.
 */
function windowsDisplay(getWindow: () => BrowserWindow): AppBadgeDisplay {
  let latestCount = 0;
  let reapplyingOn: BrowserWindow | null = null;
  const applied = { image: null as Electron.NativeImage | null, description: '' };

  const apply = () => {
    const window = getWindow();
    if (window.isDestroyed()) return;
    window.setOverlayIcon(applied.image, applied.description);
  };

  // Attached with the first overlay on each window: until then there is nothing to put back.
  const reapplyOnReturn = () => {
    const window = getWindow();
    if (reapplyingOn === window || window.isDestroyed()) return;
    reapplyingOn = window;
    window.on('show', apply);
    window.on('focus', apply);
  };

  const clear = () => {
    applied.image = null;
    applied.description = '';
    apply();
  };

  return {
    show: (count) => {
      latestCount = count;
      const label = overlayLabel(count);
      const window = getWindow();
      if (label === null || window.isDestroyed()) {
        clear();
        return;
      }
      loadOverlayImage(window.webContents, label)
        .then((image) => {
          if (count !== latestCount) return;
          applied.image = image;
          applied.description = translateText(msg`${plural({ count }, { one: '# agent needs you', other: '# agents need you' })}`);
          apply();
          reapplyOnReturn();
        })
        .catch((error: unknown) => {
          console.error('[NOTIFICATION] could not draw the taskbar overlay', error);
          if (count === latestCount) clear();
        });
    },
  };
}

/** Takes a getter because a rebuilt main window replaces the one this display started on. */
export function createAppBadgeDisplay(getWindow: () => BrowserWindow): AppBadgeDisplay {
  if (process.platform === 'win32') return windowsDisplay(getWindow);
  return { show: (count) => { app.setBadgeCount(count); } };
}
