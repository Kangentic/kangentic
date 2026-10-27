import { useEffect, useRef, useState } from 'react';
import { i18n as sessionI18n, type I18n } from '@lingui/core';
import { LOCALE_NATIVE_NAMES, type AppLocale } from '../../../shared/i18n/locales';
import { resolveText } from '../../../shared/i18n/text';
import { createLocaleI18n } from '../../i18n';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import { LANGUAGE_PROMPT_MESSAGES } from './language-messages';
import { LanguageRestartDialog } from './LanguageRestartDialog';
import { useLanguageRestart } from './useLanguageRestart';

/** Record the answer, so the suggestion never shows again. */
function markSuggestionAnswered(): void {
  void useConfigStore.getState()
    .updateConfig({ hasAnsweredLanguageSuggestion: true })
    .catch((error: unknown) => console.error('Could not record the language suggestion answer:', error));
}

/**
 * The first-launch language suggestion. Kangentic always starts in English; once,
 * while the user has never picked a language, and only when the OS language ships
 * (main decides: `language.getInfo().suggestion`), this raises a persistent toast
 * offering it. Its title and button are in the OS language and its body is the
 * same question in English. The button opens the restart prompt in the OS
 * language too, because that reader may not read English.
 *
 * Closing the toast means "do not ask again", and so does either answer to the
 * prompt: config's `hasAnsweredLanguageSuggestion` records it (Restart now's save
 * sets it in main). Mounted in AppLayout's overlay block, main window only.
 */
export function LanguageSuggestion() {
  const [prompt, setPrompt] = useState<{ locale: AppLocale; i18n: I18n } | null>(null);
  // Set once the toast is up, so an effect re-run (a Fast Refresh) while the
  // restart prompt is open does not raise the toast again. Set after the await,
  // not before: StrictMode runs the effect twice and cancels the first run, which
  // must not block the second.
  const raisedRef = useRef(false);
  const restart = useLanguageRestart();

  useEffect(() => {
    let cancelled = false;
    // The toast this run raised while it is still up. Its button opens this
    // instance's prompt, so the cleanup takes it down with the instance: a remount
    // then raises one fresh toast instead of a second beside a dead one.
    let raisedToastId: string | null = null;
    void (async () => {
      const info = await window.electronAPI.language.getInfo();
      const locale = info.suggestion;
      if (cancelled || raisedRef.current || !locale) return;
      const osI18n = await createLocaleI18n(locale);
      if (cancelled || raisedRef.current) return;
      raisedRef.current = true;
      const language = LOCALE_NATIVE_NAMES[locale];
      const toastId = useToastStore.getState().addToast({
        title: resolveText(osI18n, LANGUAGE_PROMPT_MESSAGES.suggestionQuestion, { language }),
        message: resolveText(sessionI18n, LANGUAGE_PROMPT_MESSAGES.suggestionQuestion, { language }),
        persistent: true,
        action: {
          label: resolveText(osI18n, LANGUAGE_PROMPT_MESSAGES.changeAndRestart),
          icon: 'retry',
          onClick: () => {
            // Dismissed from code, which does not count as an answer: the prompt's does.
            raisedToastId = null;
            useToastStore.getState().dismissToast(toastId);
            setPrompt({ locale, i18n: osI18n });
          },
        },
        onDismiss: markSuggestionAnswered,
      });
      raisedToastId = toastId;
    })().catch((error: unknown) => console.error('Could not offer the system language:', error));
    return () => {
      cancelled = true;
      if (raisedToastId !== null) {
        // Dismissed from code, so it records no answer, and the next run may raise it again.
        useToastStore.getState().dismissToast(raisedToastId);
        raisedRef.current = false;
      }
    };
  }, []);

  if (!prompt) return null;
  return (
    <LanguageRestartDialog
      testId="language-suggestion-confirm"
      locale={prompt.locale}
      i18n={prompt.i18n}
      onConfirm={() => { void restart(prompt.locale).finally(() => setPrompt(null)); }}
      onCancel={() => {
        markSuggestionAnswered();
        setPrompt(null);
      }}
    />
  );
}
