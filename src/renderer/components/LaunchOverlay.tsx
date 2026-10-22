import { Loader2 } from 'lucide-react';
import { useConfigStore } from '../stores/config-store';
import { resolveTerminalBackground, resolveTerminalForeground } from '../hooks/useTerminal';

interface LaunchOverlayProps {
  label: string;
}

/** Dim applied to the label. The terminal palette has no muted counterpart
 *  (TerminalColorOverrides exposes only background / foreground / cursor), so
 *  the resolved foreground is dimmed instead to read as a muted status line.
 *  Tuned against the default #e4e4e7-on-#0c0c0c pairing. */
const TERMINAL_LABEL_MUTED_OPACITY = 0.7;

/**
 * Full-size loading overlay for a terminal surface that is still starting up:
 * worktree creation, CLI boot, command-terminal spawn, or a resume. A centered
 * muted spinner + the status label, painted in the resolved terminal
 * background and foreground (the user's Settings > Terminal > Colors, or the
 * defaults; see useTerminal.ts).
 *
 * Every phase of a launch paints the same color. TaskDetailBody's pre-session
 * pane ("Creating worktree...") hands off to TerminalTab's overlay ("Starting
 * agent..."), which hands off to the terminal itself, all in one spot. The
 * pre-session pane used to paint the theme's surface color, so the background
 * stepped once on the way to a terminal that was always coming.
 */
export function LaunchOverlay({ label }: LaunchOverlayProps) {
  const terminalColors = useConfigStore((state) => state.config.terminal.colors);
  return (
    <div
      data-testid="launch-overlay"
      className="absolute inset-0 z-10 flex items-center justify-center"
      style={{ backgroundColor: resolveTerminalBackground(terminalColors) }}
    >
      <span
        className="flex items-center gap-2 text-sm"
        style={{ color: resolveTerminalForeground(terminalColors), opacity: TERMINAL_LABEL_MUTED_OPACITY }}
      >
        <Loader2 size={14} className="animate-spin" />
        {label}
      </span>
    </div>
  );
}
