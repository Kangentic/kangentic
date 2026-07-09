import { TriangleAlert } from 'lucide-react';

/**
 * Persistent notice explaining that OS-level and other-app global hotkeys take
 * priority over Kangentic's in-app hotkeys. This is the honest explanation for
 * the case where a bound combo silently does nothing because the OS or another
 * running app already owns it (Electron's globalShortcut registration fails
 * silently in exactly this situation).
 */
export function OsHotkeyBanner() {
  return (
    <div
      data-testid="os-hotkey-banner"
      className="flex items-start gap-2.5 rounded-lg border border-edge bg-surface-raised px-3 py-2.5"
    >
      <TriangleAlert size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" />
      <p className="text-sm text-fg-muted">
        Hotkeys reserved by your OS or other apps take priority and may not work here. If one
        is not responding, try a different combination.
      </p>
    </div>
  );
}
