import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { SettingRow, SettingToggleRow, SettingTextInput, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { useToastStore } from '../../../stores/toast-store';

type ClearState = 'idle' | 'confirming' | 'clearing';

export function BrowserTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  const browserConfig = config.browser ?? {};
  const enabled = browserConfig.enabled !== false;

  const [clearState, setClearState] = useState<ClearState>('idle');

  const handleClearConfirmed = async () => {
    setClearState('clearing');
    try {
      await window.electronAPI.browser.clearStorage();
      useToastStore.getState().addToast({
        message: 'Browser data cleared. Reload the browser pane to apply.',
        variant: 'success',
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `Failed to clear browser data: ${error instanceof Error ? error.message : String(error)}`,
        variant: 'error',
      });
    } finally {
      setClearState('idle');
    }
  };

  return (
    <>
      <SettingToggleRow
        {...settingProps('browser.enabled')}
        checked={enabled}
        onChange={(value) => updateProject({ browser: { enabled: value } })}
      />
      <SettingRow {...settingProps('browser.defaultUrl')}>
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
          placeholder="http://localhost:5173"
          ariaLabel="Default browser pane URL"
          className="placeholder-fg-faint"
          disabled={!enabled}
        />
      </SettingRow>
      <SettingRow {...settingProps('browser.clearStorage')}>
        <button
          type="button"
          onClick={() => setClearState('confirming')}
          disabled={clearState !== 'idle'}
          data-testid="browser-clear-storage"
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {clearState === 'clearing'
            ? <Loader2 size={14} className="animate-spin" />
            : <Trash2 size={14} />}
          <span>{clearState === 'clearing' ? 'Clearing...' : 'Clear data'}</span>
        </button>
      </SettingRow>

      {clearState === 'confirming' && (
        <ConfirmDialog
          title="Clear browser data?"
          variant="danger"
          confirmLabel="Clear data"
          message={
            <>
              <p>This wipes cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches for the embedded browser pane across all tasks and projects. You will be signed out of any sites.</p>
              <p>Saved URLs (per-task overrides and the project default) are kept.</p>
            </>
          }
          onConfirm={() => { void handleClearConfirmed(); }}
          onCancel={() => setClearState('idle')}
        />
      )}
    </>
  );
}
