import { useConfigStore } from '../stores/config-store';
import { effectiveCombo } from '../../shared/keybindings';
import { dictationHoldsMouseButton, PUSH_TO_TALK_ACTION_ID } from '../utils/dictation-hold';

export interface PushToTalkBinding {
  /** Whether dictation is on in settings. */
  enabled: boolean;
  /** The push-to-talk combo, the user's override or the default. */
  combo: string;
  /** Whether push-to-talk holds the mouse back button. */
  holdsBack: boolean;
  /** Whether push-to-talk holds the mouse forward button. */
  holdsForward: boolean;
}

/**
 * The push-to-talk binding as `useDictation` and `useBrowserMouseNavigation`
 * both read it. One derivation, because each hook acts only on the buttons the
 * other leaves alone: a copy that drifted would let a press navigate and
 * dictate at once, or do neither.
 */
export function usePushToTalkBinding(): PushToTalkBinding {
  const enabled = useConfigStore((state) => state.globalConfig.dictation?.enabled ?? false);
  const override = useConfigStore((state) => state.globalConfig.hotkeyOverrides?.[PUSH_TO_TALK_ACTION_ID]);
  const combo = effectiveCombo(PUSH_TO_TALK_ACTION_ID, override ? { [PUSH_TO_TALK_ACTION_ID]: override } : undefined);
  return {
    enabled,
    combo,
    holdsBack: dictationHoldsMouseButton(enabled, combo, 'back'),
    holdsForward: dictationHoldsMouseButton(enabled, combo, 'forward'),
  };
}
