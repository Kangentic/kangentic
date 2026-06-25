import { useCallback, useState } from 'react';
import { getIsHmrReload } from '../utils/hmr-flag';

/**
 * Shared open/close motion for every in-app overlay (dialogs, panels, popovers,
 * context menus, the command bar, the search palette). Replaces the hand-rolled
 * `entering | visible | exiting` phase machine that BaseDialog, CommandBarOverlay,
 * SearchPalette, SettingsPanelShell, and OverlayPopover each used to duplicate.
 *
 * The overlay stays mounted through its exit animation: a close gesture calls
 * `requestClose()` (phase -> exiting); when the content element's exit animation
 * finishes, `onAnimationEnd` fires `onClose()` so the parent can unmount.
 *
 * Timing/easing live entirely in the CSS token classes (see `index.css` overlay
 * motion tokens), so nothing here carries a duration - tweak the feel there.
 */

export type OverlayVariant = 'dialog' | 'popover' | 'panel' | 'command-bar';
export type OverlayPhaseName = 'entering' | 'visible' | 'exiting';

interface UseOverlayPhaseOptions {
  /** Selects which CSS token classes the content element animates with. */
  variant?: OverlayVariant;
  /**
   * When the overlay mounts due to a Vite HMR reload, start already-visible so
   * it does not replay its entrance on every Fast Refresh. Off by default;
   * overlays that can remount on HMR (command bar, search) opt in.
   */
  skipEnterOnHmr?: boolean;
  /**
   * Start already-visible this mount (unconditionally), skipping the entrance
   * animation. For content remounted in a state that should not animate in
   * (e.g. a window rebuilt by a workspace restore on project switch).
   */
  skipEnter?: boolean;
}

export interface OverlayPhaseApi {
  phase: OverlayPhaseName;
  isExiting: boolean;
  /** Begin the exit animation. Idempotent; the overlay stays mounted until it ends. */
  requestClose: () => void;
  /** Force back to the entering phase (for open-driven overlays that re-open). */
  reset: () => void;
  /** Class for the backdrop element per phase (empty string for the popover variant). */
  backdropClassName: string;
  /** Class for the content element per phase. */
  contentClassName: string;
  /**
   * Attach to the CONTENT element (the one carrying `contentClassName`). Gates
   * the phase transition on the content's own animation end and ignores
   * animations bubbling up from descendants (e.g. an embedded terminal).
   */
  onAnimationEnd: (event: React.AnimationEvent) => void;
}

const CONTENT_IN: Record<OverlayVariant, string> = {
  dialog: 'overlay-content-in',
  popover: 'overlay-popover-in',
  panel: 'overlay-panel-in',
  'command-bar': 'overlay-command-bar-in',
};

const CONTENT_OUT: Record<OverlayVariant, string> = {
  dialog: 'overlay-content-out',
  popover: 'overlay-popover-out',
  panel: 'overlay-panel-out',
  'command-bar': 'overlay-command-bar-out',
};

export function useOverlayPhase(
  onClose: () => void,
  options: UseOverlayPhaseOptions = {},
): OverlayPhaseApi {
  const { variant = 'dialog', skipEnterOnHmr = false, skipEnter = false } = options;

  const [phase, setPhase] = useState<OverlayPhaseName>(() =>
    skipEnter || (skipEnterOnHmr && getIsHmrReload()) ? 'visible' : 'entering',
  );

  const requestClose = useCallback(() => {
    setPhase((currentPhase) => (currentPhase === 'exiting' ? currentPhase : 'exiting'));
  }, []);

  const reset = useCallback(() => {
    setPhase('entering');
  }, []);

  const onAnimationEnd = useCallback(
    (event: React.AnimationEvent) => {
      // Ignore animations bubbling up from descendants of the content element.
      if (event.target !== event.currentTarget) return;
      if (phase === 'entering') setPhase('visible');
      else if (phase === 'exiting') onClose();
    },
    [phase, onClose],
  );

  const backdropClassName =
    variant === 'popover'
      ? ''
      : phase === 'entering'
        ? 'overlay-backdrop-in'
        : phase === 'exiting'
          ? 'overlay-backdrop-out'
          : '';

  const contentClassName =
    phase === 'entering'
      ? CONTENT_IN[variant]
      : phase === 'exiting'
        ? CONTENT_OUT[variant]
        : '';

  return {
    phase,
    isExiting: phase === 'exiting',
    requestClose,
    reset,
    backdropClassName,
    contentClassName,
    onAnimationEnd,
  };
}
