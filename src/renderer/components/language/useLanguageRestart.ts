import { useCallback, useRef } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { AppLocale } from '../../../shared/i18n/locales';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';

/**
 * Save a display language and restart, through one main-side call, as Settings >
 * Performance's Graphics acceleration does. Resolves once main has saved and is
 * quitting; a failure shows the same "Couldn't restart" toast and keeps the app up.
 */
export function useLanguageRestart(): (locale: AppLocale) => Promise<void> {
  // ConfirmDialog confirms on Enter, so a second press before the dialog closes
  // would ask main to save and restart twice.
  const restartInFlightRef = useRef(false);
  return useCallback(async (locale: AppLocale) => {
    if (restartInFlightRef.current) return;
    restartInFlightRef.current = true;
    try {
      await window.electronAPI.language.setLanguageAndRestart(locale);
      // Main saved the language and is quitting. Re-read config for the moment
      // the window is still up.
      void useConfigStore.getState().loadConfig();
    } catch (error) {
      // The toast says what to do; the reason goes to the log.
      console.error('Display language restart failed:', error);
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't restart`),
        message: i18n._(msg`Restart Kangentic to apply the change.`),
        variant: 'error',
      });
    } finally {
      restartInFlightRef.current = false;
    }
  }, []);
}
