/**
 * Toasts a file download that finished in a Browser pane.
 *
 * The pane saves silently to the OS Downloads folder, which is what Chrome does
 * and what makes downloads work at all for the human using the pane. The toast is
 * what stops that being INVISIBLE: an agent driving the pane can trigger a
 * download the user never asked for, and a file appearing in Downloads with no
 * UI anywhere is the worst of the three options considered.
 *
 * "Show in folder" reuses the existing `shell:showItemInFolder` channel rather
 * than adding one, so the only new IPC here is the push itself.
 *
 * See `docs/embedded-browser.md` decision 13.
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
          message: `Download did not finish: ${download.fileName}`,
          variant: 'warning',
        });
        return;
      }
      addToast({
        message: `Downloaded ${download.fileName}`,
        variant: 'success',
        action: {
          label: 'Show in folder',
          onClick: () => { void window.electronAPI.shell.showItemInFolder(download.filePath); },
        },
      });
    });
  }, []);
}
