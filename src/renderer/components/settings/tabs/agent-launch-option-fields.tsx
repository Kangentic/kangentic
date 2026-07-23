import type { AgentDetectionInfo, AppConfig } from '../../../../shared/types';
import { SettingToggleRow, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

/**
 * Launch-option toggles for the currently-selected agent in the Agent
 * settings tab: one row per `AgentDetectionInfo.launchOptions` entry (e.g.
 * Codex's "Disable ChatGPT Apps"). Renders nothing when `agent` declares no
 * launch options - the caller does not need to check first, mirroring
 * `AgentExecutionFields`. Global/machine-scoped, like `agent.cliPaths` - the
 * underlying hang is a property of the local CLI install, not a project.
 */
export function AgentLaunchOptionFields({ agent, globalConfig }: {
  agent: AgentDetectionInfo;
  globalConfig: AppConfig;
}) {
  const updateGlobal = useScopedUpdate('global');

  if (!agent.launchOptions || agent.launchOptions.length === 0) return null;

  // Optional-chained to match `resolveLaunchOptions` on the main side: a real
  // loaded config always backfills this to `{}` via DEFAULT_CONFIG, but test
  // and mock builders construct partial `agent` configs directly.
  const stored = globalConfig.agent.launchOptions?.[agent.name] ?? {};

  return (
    <>
      {agent.launchOptions.map((option) => (
        <SettingToggleRow
          key={option.id}
          {...settingProps('agent.launchOptions')}
          label={option.label}
          description={option.description}
          checked={stored[option.id] ?? option.default}
          onChange={(value) => updateGlobal({
            agent: { launchOptions: { ...globalConfig.agent.launchOptions, [agent.name]: { ...stored, [option.id]: value } } },
          })}
        />
      ))}
    </>
  );
}
