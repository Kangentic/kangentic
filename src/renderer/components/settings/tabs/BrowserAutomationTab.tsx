import type { AppConfig } from '../../../../shared/types';
import { SettingToggleRow, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

/**
 * Global "Agent Browser" settings: the cross-project policy for whether
 * and how agents may drive the embedded Browser pane via the kangentic_browser_*
 * MCP tools. Master switch plus per-capability toggles (interaction, navigation,
 * eval) and an optional localhost-navigation restriction. Read live by the MCP
 * tool layer so a flip applies on the next tool call.
 */
export function BrowserAutomationTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const automation = globalConfig.browserAutomation ?? {};
  // Master switch. When off, the dependent capability toggles below have no
  // effect (the MCP layer treats `enabled === false` as the kill switch), so
  // dim and disable them to communicate that. Their stored values are kept so
  // re-enabling restores the prior choices.
  const enabled = automation.enabled !== false;

  return (
    <>
      <SettingToggleRow
        {...settingProps('browserAutomation.enabled')}
        checked={enabled}
        onChange={(value) => updateGlobal({ browserAutomation: { enabled: value } })}
      />
      <div className={`space-y-4 ${enabled ? '' : 'opacity-40'}`} inert={!enabled}>
        <SettingToggleRow
          {...settingProps('browserAutomation.allowInteraction')}
          checked={automation.allowInteraction !== false}
          onChange={(value) => updateGlobal({ browserAutomation: { allowInteraction: value } })}
        />
        <SettingToggleRow
          {...settingProps('browserAutomation.allowNavigation')}
          checked={automation.allowNavigation !== false}
          onChange={(value) => updateGlobal({ browserAutomation: { allowNavigation: value } })}
        />
        <SettingToggleRow
          {...settingProps('browserAutomation.allowEval')}
          checked={automation.allowEval === true}
          onChange={(value) => updateGlobal({ browserAutomation: { allowEval: value } })}
        />
        <SettingToggleRow
          {...settingProps('browserAutomation.restrictNavigationToLocalhost')}
          checked={automation.restrictNavigationToLocalhost === true}
          onChange={(value) => updateGlobal({ browserAutomation: { restrictNavigationToLocalhost: value } })}
        />
      </div>
    </>
  );
}
