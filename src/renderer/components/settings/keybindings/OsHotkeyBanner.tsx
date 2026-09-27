import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { CardTile } from '../settings-card';

/**
 * Persistent notice explaining that OS-level and other-app global hotkeys take
 * priority over Kangentic's in-app hotkeys. This is the honest explanation for
 * the case where a bound combo silently does nothing because the OS or another
 * running app already owns it (Electron's globalShortcut registration fails
 * silently in exactly this situation). A settings-card tile, so it sits in the
 * Hotkeys card like any other row.
 *
 * The Hotkeys card's one tile: `action` (Reset to default) sits on the tile's right
 * edge, and `status` (the conflict count, only while there are conflicts)
 * sits under the notice.
 */
export function OsHotkeyBanner({ action, status }: { action?: ReactNode; status?: ReactNode }) {
  return (
    <CardTile className="flex items-center gap-3" testId="os-hotkey-banner">
      <TriangleAlert size={16} className="text-yellow-400 flex-shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm text-fg-muted">
          Your OS and other apps can claim a hotkey first. If one does nothing here, try another
          combination.
        </p>
        {status}
      </div>
      {action ? <div className="flex-shrink-0">{action}</div> : null}
    </CardTile>
  );
}
