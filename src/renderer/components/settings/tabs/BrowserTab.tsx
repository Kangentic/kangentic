import { useState } from 'react';
import { Eraser, Globe, Loader2, Trash2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../../shared/types';
import { SettingTextInput, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow } from '../settings-card';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { useToastStore } from '../../../stores/toast-store';
import { asSentence, describeIpcError } from '../../../lib/ipc-error';

type ClearState = 'idle' | 'confirming' | 'clearing';

export function BrowserTab({ config }: { config: AppConfig }) {
  const { t } = useLingui();
  const updateProject = useScopedUpdate('project');
  const browserConfig = config.browser ?? {};
  const enabled = browserConfig.enabled !== false;

  const [clearState, setClearState] = useState<ClearState>('idle');

  const handleClearConfirmed = async () => {
    setClearState('clearing');
    try {
      await window.electronAPI.browser.clearStorage();
      useToastStore.getState().addToast({
        title: t`Browser data cleared`,
        message: t`Reload the browser pane to apply.`,
        variant: 'success',
      });
    } catch (error) {
      useToastStore.getState().addToast({
        title: t`Couldn't clear browser data`,
        message: asSentence(describeIpcError(error)),
        variant: 'error',
      });
    } finally {
      setClearState('idle');
    }
  };

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Globe size={16} />}
        {...settingProps('browser.enabled')}
        searchIds={['browser.defaultUrl']}
        checked={enabled}
        onChange={(value) => updateProject({ browser: { enabled: value } })}
      >
        {enabled ? (
          <CardRow {...settingProps('browser.defaultUrl')}>
            <SettingTextInput
              value={browserConfig.defaultUrl ?? ''}
              onCommit={(nextDefaultUrl) => {
                // Persist empty string (not undefined) when cleared. deepMergeConfig
                // skips `undefined` values (object-utils.ts:94), so passing
                // `undefined` would be a no-op and leave the existing value in
                // the persisted overrides. Empty string survives the merge, and
                // useBrowserUrl's `||` fallthrough treats it as "no default".
                updateProject({ browser: { defaultUrl: nextDefaultUrl.trim() } });
              }}
              // i18n-ok: an example URL
              placeholder="http://localhost:5173"
              ariaLabel={t`Default browser pane URL`}
              className="placeholder-fg-faint"
            />
          </CardRow>
        ) : null}
      </SettingsCard>

      {/* Its own card, not inside the pane's: it clears the embedded browser's
          storage for every project, so it stays reachable with this project's
          pane turned off. */}
      <SettingsCard
        icon={<Eraser size={16} />}
        label={t`Browser data`}
        description={t`Cookies and storage the embedded browser keeps.`}
        searchIds={['browser.clearStorage']}
      >
        <CardRow {...settingProps('browser.clearStorage')}>
          <button
            type="button"
            onClick={() => setClearState('confirming')}
            disabled={clearState !== 'idle'}
            data-testid="browser-clear-storage"
            className="inline-flex w-fit items-center gap-2 px-3 py-1.5 text-xs rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {clearState === 'clearing'
              ? <Loader2 size={14} className="animate-spin" />
              : <Trash2 size={14} />}
            <span>{clearState === 'clearing' ? t`Clearing...` : t`Clear data`}</span>
          </button>
        </CardRow>
      </SettingsCard>

      {clearState === 'confirming' && (
        <ConfirmDialog
          title={t`Clear browser data?`}
          variant="danger"
          confirmLabel={t`Clear data`}
          message={
            <>
              <p><Trans>This wipes cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches for the embedded browser pane across all tasks and projects. You will be signed out of any sites.</Trans></p>
              <p><Trans>Saved URLs (per-task overrides and the project default) are kept.</Trans></p>
            </>
          }
          onConfirm={() => { void handleClearConfirmed(); }}
          onCancel={() => setClearState('idle')}
        />
      )}
    </div>
  );
}
