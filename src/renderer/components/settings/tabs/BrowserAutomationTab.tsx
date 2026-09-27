import { Globe } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow } from '../settings-card';
import { settingProps } from '../settings-registry';

/**
 * Global "Agent Browser" settings: the cross-project policy for whether
 * and how agents may drive the embedded Browser pane via the kangentic_browser_*
 * MCP tools. One card: the master switch, then the per-capability switches
 * (interaction, navigation, eval) and the localhost restriction under
 * navigation. Read live by the MCP tool layer so a flip applies on the next
 * tool call.
 *
 * The one card that keeps its row descriptions inline rather than in
 * tooltips: it is short enough that a tooltip would only hide them.
 */
export function BrowserAutomationTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const automation = globalConfig.browserAutomation ?? {};
  // Master switch. When off, the capability switches have no effect (the MCP
  // layer treats `enabled === false` as the kill switch), so they hide. Their
  // stored values are kept, so switching it back on restores the prior choices.
  const enabled = automation.enabled !== false;
  const allowNavigation = automation.allowNavigation !== false;

  return (
    <SettingsCard
      icon={<Globe size={16} />}
      {...settingProps('browserAutomation.enabled')}
      searchIds={[
        'browserAutomation.allowInteraction',
        'browserAutomation.allowNavigation',
        'browserAutomation.restrictNavigationToLocalhost',
        'browserAutomation.allowEval',
      ]}
      checked={enabled}
      onChange={(value) => updateGlobal({ browserAutomation: { enabled: value } })}
    >
      {enabled ? (
        <>
          <CardToggleRow
            {...settingProps('browserAutomation.allowInteraction')}
            inlineDescription
            checked={automation.allowInteraction !== false}
            onChange={(value) => updateGlobal({ browserAutomation: { allowInteraction: value } })}
          />
          <CardToggleRow
            {...settingProps('browserAutomation.allowNavigation')}
            inlineDescription
            checked={allowNavigation}
            onChange={(value) => updateGlobal({ browserAutomation: { allowNavigation: value } })}
          />
          {/* Nested under navigation: it narrows where navigation may go, so
              with navigation off it does nothing and is hidden. */}
          {allowNavigation ? (
            <CardToggleRow
              {...settingProps('browserAutomation.restrictNavigationToLocalhost')}
              inlineDescription
              nested
              checked={automation.restrictNavigationToLocalhost === true}
              onChange={(value) => updateGlobal({ browserAutomation: { restrictNavigationToLocalhost: value } })}
            />
          ) : null}
          <CardToggleRow
            {...settingProps('browserAutomation.allowEval')}
            inlineDescription
            checked={automation.allowEval === true}
            onChange={(value) => updateGlobal({ browserAutomation: { allowEval: value } })}
          />
        </>
      ) : null}
    </SettingsCard>
  );
}
