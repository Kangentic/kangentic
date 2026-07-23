import { Loader2 } from 'lucide-react';
import { useConfigStore } from '../stores/config-store';
import { resolveTerminalBackground, resolveTerminalForeground } from '../hooks/useTerminal';

interface LaunchOverlayProps {
  label: string;
  /** 'surface' (default): the board card's launch treatment - a muted spinner
   *  + label on the app's theme surface color. Used for the two pre-terminal
   *  panes in TaskDetailBody.tsx, which have no terminal underneath.
   *  'terminal': paints the resolved terminal background/foreground instead,
   *  so a surface covering a not-yet-ready terminal (TerminalTab,
   *  CommandTerminalWindow) matches the terminal it is about to reveal - no
   *  color swap when the overlay lifts. */
  variant?: 'surface' | 'terminal';
}

/** Dim applied to the label in the 'terminal' variant. The surface variant gets
 *  its muted look from the `text-fg-muted` theme token, but the terminal palette
 *  has no muted counterpart (TerminalColorOverrides exposes only background /
 *  foreground / cursor), so the resolved foreground is dimmed instead to read the
 *  same way. Tuned against the default #e4e4e7-on-#0c0c0c pairing. */
const TERMINAL_LABEL_MUTED_OPACITY = 0.7;

/**
 * Full-size loading overlay for a terminal surface that is still starting up:
 * worktree creation, CLI boot, command-terminal spawn, or a resume. Mirrors
 * the board card's launch treatment - a centered muted spinner + the status
 * label - so the dialog and the card read the same during launch. The
 * 'terminal' variant paints the resolved terminal background/foreground
 * (see useTerminal.ts) instead of the theme surface, for call sites that
 * directly precede a terminal in the same spot.
 */
export function LaunchOverlay({ label, variant = 'surface' }: LaunchOverlayProps) {
  const terminalColors = useConfigStore((state) => state.config.terminal.colors);
  // The two variants share the same markup and differ only in how the two color
  // slots are sourced: theme tokens (Tailwind classes) vs the resolved terminal
  // palette (inline styles). Kept as one tree so a change to the spinner, the
  // spacing, or the test id cannot land on only one of them.
  const paintsTerminalColors = variant === 'terminal';

  return (
    <div
      data-testid="launch-overlay"
      className={`absolute inset-0 z-10 flex items-center justify-center${paintsTerminalColors ? '' : ' bg-surface'}`}
      style={paintsTerminalColors ? { backgroundColor: resolveTerminalBackground(terminalColors) } : undefined}
    >
      <span
        className={`flex items-center gap-2 text-sm${paintsTerminalColors ? '' : ' text-fg-muted'}`}
        style={
          paintsTerminalColors
            ? { color: resolveTerminalForeground(terminalColors), opacity: TERMINAL_LABEL_MUTED_OPACITY }
            : undefined
        }
      >
        <Loader2 size={14} className="animate-spin" />
        {label}
      </span>
    </div>
  );
}
