import { useMemo } from 'react';
import { useConfigStore } from '../stores/config-store';
import { effectiveCombo, mouseComboTokens } from '../../shared/keybindings';

/** The two mouse buttons a Browser pane navigates on. */
export type NavigationMouseButton = 'back' | 'forward';

export const PUSH_TO_TALK_ACTION_ID = 'dictation.pushToTalk';

// Every answer that holds nothing is this one set, so a change between two such
// settings (dictation toggled while bound to a key) keeps the same reference and
// the listeners that depend on it do not re-subscribe.
const NO_BUTTONS: ReadonlySet<NavigationMouseButton> = new Set();

/**
 * The mouse buttons push-to-talk holds in this window, which is the set it
 * arbitrates between a tap (navigate) and a hold (dictate).
 *
 * Every other back or forward press is plain navigation, owned by
 * `useBrowserMouseNavigation`. Both hooks read this one answer, because each
 * listens in the capture phase on `window`, where `stopPropagation` does not stop
 * a sibling listener: if the two disagreed, a press would navigate twice or not
 * at all.
 *
 * Every window answers the same way, a pop-out included: each window runs its own
 * push-to-talk, so a button push-to-talk holds in a pop-out has a hold to protect
 * there too.
 */
export function pushToTalkMouseButtons({ enabled, combo }: {
  enabled: boolean;
  combo: string;
}): ReadonlySet<NavigationMouseButton> {
  if (!enabled) return NO_BUTTONS;
  const tokens = mouseComboTokens(combo);
  const buttons = new Set<NavigationMouseButton>();
  if (tokens.includes('Mouse:Back')) buttons.add('back');
  if (tokens.includes('Mouse:Forward')) buttons.add('forward');
  return buttons.size === 0 ? NO_BUTTONS : buttons;
}

/** The push-to-talk combo in effect: the user's override, else the default.
 *  `useDictation` binds this combo and the button set below is derived from it,
 *  so both read it here and cannot resolve it two ways. */
export function usePushToTalkCombo(): string {
  const override = useConfigStore((state) => state.globalConfig.hotkeyOverrides?.[PUSH_TO_TALK_ACTION_ID]);
  return effectiveCombo(PUSH_TO_TALK_ACTION_ID, override ? { [PUSH_TO_TALK_ACTION_ID]: override } : undefined);
}

/** `pushToTalkMouseButtons` for this window, from the live config. */
export function usePushToTalkMouseButtons(): ReadonlySet<NavigationMouseButton> {
  const enabled = useConfigStore((state) => state.globalConfig.dictation?.enabled ?? false);
  const combo = usePushToTalkCombo();
  return useMemo(() => pushToTalkMouseButtons({ enabled, combo }), [enabled, combo]);
}
