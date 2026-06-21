import type { WindowLightDismiss } from '../../../shared/types';
import type { ManagedWindow } from '../store/types';

/**
 * Pure policy resolver for click-outside (light-dismiss). Given the dismiss
 * policy and the current window set, return the ids of the windows a clean
 * empty-board click should close. The detection hook (`useClickOutsideToClose`)
 * owns the "was this a clean board-background click" decision; this function
 * owns only the policy-to-targets mapping, so it stays a pure, total, easily
 * unit-tested function.
 *
 *  - `off`     never closes anything.
 *  - `single`  closes the lone window whenever exactly one is open, in ANY state
 *              (the peek case). With a single window there are no siblings to
 *              reflow, so the old floating-only gate was too strict: a window left
 *              `snapped` after its dock partner closed (evictWindowFromTiling keeps
 *              the lone survivor snapped, by design) still leaves empty board to
 *              click, and a lone maximized window covers only the board while the
 *              toolbar, sidebar, and status bar (all dismiss surfaces) stay exposed
 *              beside it, so a click there still dismisses it as intended.
 *  - `focused` closes the focused window, regardless of how many are open and
 *              regardless of its state (the explicit aggressive choice).
 *  - `all`     closes every open window, regardless of state.
 */
export function resolveLightDismissTargets(
  policy: WindowLightDismiss,
  windows: Record<string, ManagedWindow>,
  focusedWindowId: string | null,
): string[] {
  const ids = Object.keys(windows);
  switch (policy) {
    case 'off':
      return [];
    case 'single': {
      const onlyId = ids[0];
      return ids.length === 1 && onlyId ? [onlyId] : [];
    }
    case 'focused':
      return focusedWindowId && windows[focusedWindowId] ? [focusedWindowId] : [];
    case 'all':
      return ids;
    default:
      return [];
  }
}
