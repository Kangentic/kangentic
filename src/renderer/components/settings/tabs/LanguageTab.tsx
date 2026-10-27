import { useEffect, useMemo, useState } from 'react';
import { Languages } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import {
  LOCALE_NATIVE_NAMES,
  SOURCE_LOCALE,
  isAppLocale,
  localeDisplayCode,
  type AppLocale,
} from '../../../../shared/i18n/locales';
import { SettingsCard, CardRow } from '../settings-card';
import { settingProps } from '../settings-registry';
import { Combobox } from '../../dialogs/Combobox';
import { LanguageRestartDialog } from '../../language/LanguageRestartDialog';
import { useLanguageRestart } from '../../language/useLanguageRestart';

/**
 * Settings > Language: the display language, first under System so a user who
 * cannot read the rest finds it. One card, one row: the shared Combobox listing
 * every shipped language by its own name and its code. Picking another asks to
 * restart (the language loads once at startup and never switches live, since a
 * reload would destroy Browser pane guests) and saves only on Restart now.
 * docs/architecture/i18n.md has the design.
 */
export function LanguageTab() {
  const { t, i18n } = useLingui();
  // The picker lists only the languages that ship. Until main answers, the
  // session's own language is the one row it can show.
  const [shippedLocales, setShippedLocales] = useState<AppLocale[] | null>(null);
  // The language picked but not yet confirmed. The picker stays bound to the
  // session's language, so Cancel snaps it back by clearing this.
  const [pendingLocale, setPendingLocale] = useState<AppLocale | null>(null);
  const restart = useLanguageRestart();
  const activeLocale: AppLocale = isAppLocale(i18n.locale) ? i18n.locale : SOURCE_LOCALE;

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.language.getInfo()
      .then((info) => { if (!cancelled) setShippedLocales(info.shippedLocales); })
      .catch((error: unknown) => console.error('Could not read the display languages:', error));
    return () => { cancelled = true; };
  }, []);

  const options = useMemo(
    () => (shippedLocales ?? [activeLocale]).map((locale) => ({
      value: locale,
      label: LOCALE_NATIVE_NAMES[locale],
      detail: `(${localeDisplayCode(locale)})`,
    })),
    [shippedLocales, activeLocale],
  );

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Languages size={16} />}
        label={t`Display language`}
        description={t`The language of menus, settings and dialogs.`}
        searchIds={['displayLanguage']}
      >
        <CardRow {...settingProps('displayLanguage')}>
          <Combobox
            value={activeLocale}
            onChange={(value) => {
              if (isAppLocale(value) && value !== activeLocale) setPendingLocale(value);
            }}
            options={options}
            allowClear={false}
            placeholder={t`Select display language`}
            testId="display-language"
          />
        </CardRow>
      </SettingsCard>

      {pendingLocale !== null && (
        <LanguageRestartDialog
          locale={pendingLocale}
          i18n={i18n}
          onConfirm={() => { void restart(pendingLocale).finally(() => setPendingLocale(null)); }}
          onCancel={() => setPendingLocale(null)}
        />
      )}
    </div>
  );
}
