/**
 * Toasts a file download that finished in a Browser pane.
 *
 * The pane saves silently to the OS Downloads folder, which is what Chrome does
 * and what makes downloads work at all for the human using the pane. The toast is
 * what stops that being INVISIBLE: an agent driving the pane can trigger a
 * download the user never asked for, and a file appearing in Downloads with no
 * UI anywhere is the worst of the three options considered.
 *
 * A click on the finished toast's card shows the file in its folder, through
 * the existing `shell:showItemInFolder` channel rather than a new one, so the
 * only new IPC here is the push itself.
 *
 * See `docs/architecture/embedded-browser/decision-log.md` decision 13.
 */

import { useEffect } from 'react';
import { useToastStore } from '../../stores/toast-store';

export function useBrowserDownloadToast(): void {
  useEffect(() => {
    const browser = window.electronAPI?.browser;
    if (!browser?.onDownloadDone) return;
    return browser.onDownloadDone((download) => {
      const addToast = useToastStore.getState().addToast;
      if (download.state !== 'completed') {
        // Named rather than generic: an interrupted download leaves a partial
        // file behind, and the user needs to know which one.
        addToast({
          title: "Download didn't finish",
          message: download.fileName,
          variant: 'warning',
        });
        return;
      }
      addToast({
        title: 'Downloaded',
        message: download.fileName,
        variant: 'success',
        onOpen: () => { void window.electronAPI.shell.showItemInFolder(download.filePath); },
      });
    });
  }, []);
}
