import { useEffect } from 'react';
import { mouseComboToButton } from '../../shared/keybindings';
import { isRebindCaptureActive } from '../utils/rebind-state';
import {
  resolveBrowserNavigationTarget,
  resolveBrowserNavigationTargetForGuest,
  type BrowserNavigationTarget,
} from '../utils/browser-navigation-registry';
import { usePushToTalkMouseButtons, type NavigationMouseButton } from '../utils/push-to-talk-buttons';

/** `PointerEvent.button` for each navigation button, read from the keybindings
 *  registry so this and a `Mouse:Back` / `Mouse:Forward` binding never disagree
 *  about which physical button they mean. */
const BUTTON_BY_POINTER: ReadonlyMap<number, NavigationMouseButton> = new Map(
  (['back', 'forward'] as const).flatMap((button): [number, NavigationMouseButton][] => {
    const pointerButton = mouseComboToButton(button === 'back' ? 'Mouse:Back' : 'Mouse:Forward');
    return pointerButton === null ? [] : [[pointerButton, button]];
  }),
);

/** Navigate the pane one step, if it has a page to go to. Reports whether it did. */
function navigatePane(pane: BrowserNavigationTarget | null, button: NavigationMouseButton): boolean {
  if (!pane) return false;
  if (button === 'forward') {
    if (!pane.canGoForward()) return false;
    pane.goForward();
    return true;
  }
  if (!pane.canGoBack()) return false;
  pane.goBack();
  return true;
}

/**
 * Mouse back and forward navigate the Browser pane, the same as its toolbar
 * arrows, in whichever window the pane is in and whether dictation is on or off.
 *
 * Mounted once per window: in `AppLayout` (`canDictate: true`) and in every
 * pop-out root (`canDictate: false`). A button push-to-talk holds in this window
 * is left to `useDictation`, which tells a tap (navigate) from a hold (dictate);
 * every other press is handled here. See `utils/push-to-talk-buttons.ts` for why
 * the two must read one answer.
 *
 * Two paths, because a guest consumes the mouse. A press over the host's own UI
 * (the pane's toolbar, its note bar) is a DOM `pointerdown` on this window. A
 * press inside the page never reaches the host DOM at all, so main forwards it
 * as `browser:guestMouseButton` to the window that hosts the guest, and that
 * press navigates on its release, as a browser does.
 */
export function useBrowserMouseNavigation({ canDictate }: { canDictate: boolean }): void {
  const pushToTalkButtons = usePushToTalkMouseButtons({ canDictate });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      // A rebind capture owns every input while it is open. A capture-phase
      // `window` listener would otherwise consume the press before the Hotkeys
      // capture widget (on `document`) could record it.
      if (isRebindCaptureActive()) return;
      const button = BUTTON_BY_POINTER.get(event.button);
      if (!button || pushToTalkButtons.has(button)) return;
      if (!navigatePane(resolveBrowserNavigationTarget(), button)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [pushToTalkButtons]);

  useEffect(() => {
    const subscribe = window.electronAPI?.browser?.onGuestMouseButton;
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.phase !== 'up' || pushToTalkButtons.has(event.button)) return;
      navigatePane(resolveBrowserNavigationTargetForGuest(event.webContentsId), event.button);
    });
  }, [pushToTalkButtons]);
}
