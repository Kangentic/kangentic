import type { I18n } from '@lingui/core';
import { RotateCw } from 'lucide-react';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { LOCALE_NATIVE_NAMES, type AppLocale } from '../../../shared/i18n/locales';
import { resolveText } from '../../../shared/i18n/text';
import { LANGUAGE_PROMPT_MESSAGES } from './language-messages';

interface LanguageRestartDialogProps {
  /** The language to switch to, named in the title in its own name. */
  locale: AppLocale;
  /**
   * The instance the prompt speaks: the session's, from Settings > Language, or
   * the OS language's, from the first-launch suggestion, whose reader may not
   * read English.
   */
  i18n: I18n;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

/** The restart prompt for a language change: the Graphics acceleration restart's dialog, icon and button. */
export function LanguageRestartDialog({
  locale,
  i18n,
  onConfirm,
  onCancel,
  testId = 'language-restart-confirm',
}: LanguageRestartDialogProps) {
  const language = LOCALE_NATIVE_NAMES[locale];
  return (
    <ConfirmDialog
      testId={testId}
      // A restart, not a warning, so not the default warning triangle.
      icon={<RotateCw size={16} className="text-accent-fg" />}
      title={resolveText(i18n, LANGUAGE_PROMPT_MESSAGES.switchTitle, { language })}
      message={resolveText(i18n, LANGUAGE_PROMPT_MESSAGES.restartMessage)}
      confirmLabel={resolveText(i18n, LANGUAGE_PROMPT_MESSAGES.restartNow)}
      cancelLabel={resolveText(i18n, LANGUAGE_PROMPT_MESSAGES.cancel)}
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    />
  );
}
