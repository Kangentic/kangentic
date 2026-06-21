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
 *  - `single`  closes the window only when exactly one is open AND it is
 *              `floating` (the peek case). A lone docked window is left alone:
 *              there is no real "outside" to click, and closing it would still
 *              surprise.
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
      const only = onlyId ? windows[onlyId] : undefined;
      return ids.length === 1 && only?.state === 'floating' ? [only.id] : [];
    }
    case 'focused':
      return focusedWindowId && windows[focusedWindowId] ? [focusedWindowId] : [];
    case 'all':
      return ids;
    default:
      return [];
  }
}
