/**
 * Keeps the SSH store in step with main's host connection states (#913).
 *
 * The project list's connection chip, the degraded board strip and the SSH settings tab all read the
 * same host list, so one subscription lives here and the store is loaded once at mount. Main pushes
 * whenever a host connects, drops, comes back or is added or removed.
 *
 * Mounted in `AppLayout`, the main window only: a pop-out has no project list.
 */

import { useEffect } from 'react';
import { useSshStore } from '../stores/ssh-store';

export function useSshHostsSync(): void {
  useEffect(() => {
    const ssh = window.electronAPI?.ssh;
    if (!ssh) return;
    void useSshStore.getState().loadHosts().catch(() => {
      // Best-effort seed; the next push corrects it.
    });
    return ssh.onHostsChanged(() => {
      void useSshStore.getState().loadHosts().catch(() => {
        // A failed list leaves the last one on screen.
      });
    });
  }, []);
}
