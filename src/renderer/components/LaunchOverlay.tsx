import { Loader2 } from 'lucide-react';

interface LaunchOverlayProps {
  label: string;
}

/**
 * Full-size, muted loading overlay for a terminal surface that is still starting
 * up: worktree creation, CLI boot, command-terminal spawn, or a resume. Mirrors
 * the board card's launch treatment - a centered muted spinner + the status
 * label on the terminal's surface background - so the dialog and the card read
 * the same during launch.
 */
export function LaunchOverlay({ label }: LaunchOverlayProps) {
  return (
    <div data-testid="launch-overlay" className="absolute inset-0 z-10 flex items-center justify-center bg-surface">
      <span className="flex items-center gap-2 text-sm text-fg-muted">
        <Loader2 size={14} className="animate-spin" />
        {label}
      </span>
    </div>
  );
}
