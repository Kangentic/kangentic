import { useCallback, useRef, useState } from 'react';
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

  /**
   * Set synchronously by `requestClose`, so it is readable the instant a close
   * is asked for - before React has committed the `'exiting'` phase.
   *
   * Closing an overlay DURING its entrance animation queues two updates in the
   * same fold: `requestClose`'s `'exiting'`, then the entrance animation's own
   * genuine `animationend`. Without this flag that second handler unconditionally
   * set `'visible'`, and being later in the fold it won - `'exiting'` was
   * computed but never committed, nothing re-drove the exit (`closing` does not
   * change again), and the overlay was left permanently stuck open while its
   * owner's state already read closed. A ref rather than state because the race
   * is one of commit ORDER, not staleness: a re-render would be too late.
   */
  const closeRequestedRef = useRef(false);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setPhase((currentPhase) => (currentPhase === 'exiting' ? currentPhase : 'exiting'));
  }, []);

  const reset = useCallback(() => {
    closeRequestedRef.current = false;
    setPhase('entering');
  }, []);

  const onAnimationEnd = useCallback(
    (event: React.AnimationEvent) => {
      // Ignore animations bubbling up from descendants of the content element.
      if (event.target !== event.currentTarget) return;
      // The exit branch is deliberately checked FIRST and is never gated on the
      // flag: it is the only path to `onClose()`, so skipping it would strand
      // the overlay mounted forever - stuck the opposite way.
      if (phase === 'exiting') onClose();
      // A close already asked for wins over the entrance finishing. Leaving the
      // phase alone lets the pending `'exiting'` commit and play its exit.
      else if (phase === 'entering' && !closeRequestedRef.current) setPhase('visible');
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
