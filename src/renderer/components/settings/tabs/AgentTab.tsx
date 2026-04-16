import { useMemo, useState } from 'react';
import { Check, CircleAlert, RefreshCw } from 'lucide-react';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import type { AgentDetectionInfo, AgentPermissionEntry, AppConfig, PermissionMode } from '../../../../shared/types';
import { DEFAULT_PERMISSIONS, DEFAULT_AGENT, getAgentDefaultPermission } from '../../../../shared/types';
import { agentDisplayName } from '../../../utils/agent-display-name';
import { SettingRow, Select, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function AgentTab({ config, globalConfig, agentInfo, agentList }: {
  config: AppConfig;
  globalConfig: AppConfig;
  agentInfo: { found: boolean; path: string | null; version: string | null } | null;
  agentList: AgentDetectionInfo[];
}) {
  // agentInfo is kept in the signature for future use (e.g. surfacing the currently-detected
  // Claude CLI details even when another agent is the project default).
  void agentInfo;

  const updateGlobal = useScopedUpdate('global');
  const updateProject = useScopedUpdate('project');
  const currentProject = useProjectStore((state) => state.currentProject);
  const refreshCurrentProject = useProjectStore((state) => state.loadCurrent);
  const refreshAgentList = useConfigStore((state) => state.loadAgentList);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshAgents = async () => {
    setRefreshing(true);
    const minimumDelay = new Promise((resolve) => setTimeout(resolve, 800));
    await Promise.all([minimumDelay, refreshAgentList()]);
    setRefreshing(false);
  };

  const effectiveAgent = currentProject?.default_agent ?? DEFAULT_AGENT;
  const agentPermissions: AgentPermissionEntry[] = agentList.find((agent) => agent.name === effectiveAgent)?.permissions ?? DEFAULT_PERMISSIONS;
  const detectedAgents = useMemo(() => agentList.filter((agent) => agent.found), [agentList]);
  const undetectedAgents = useMemo(() => agentList.filter((agent) => !agent.found), [agentList]);

  const handleDefaultAgentChange = async (agentName: string) => {
    if (!currentProject) return;
    await window.electronAPI.projects.setDefaultAgent(currentProject.id, agentName);
    // Switch to the new agent's recommended default permission mode
    const newDefault = getAgentDefaultPermission(agentList, agentName);
    if (newDefault !== config.agent.permissionMode) {
      updateProject({ agent: { permissionMode: newDefault } });
    }
    await refreshCurrentProject();
  };

  return (
    <>
      <SettingRow {...settingProps('project.defaultAgent')}>
        <Select
          value={effectiveAgent}
          onChange={(event) => handleDefaultAgentChange(event.target.value)}
          disabled={!currentProject}
        >
          {detectedAgents.map((agent) => (
            <option key={agent.name} value={agent.name}>
              {agent.displayName ?? agent.name}
            </option>
          ))}
          {detectedAgents.length > 0 && undetectedAgents.length > 0 && (
            <option disabled>────────────</option>
          )}
          {undetectedAgents.map((agent) => (
            <option key={agent.name} value={agent.name}>
              {agent.displayName ?? agent.name}
            </option>
          ))}
          {agentList.length === 0 && <option value={DEFAULT_AGENT}>{agentDisplayName(DEFAULT_AGENT)}</option>}
        </Select>
      </SettingRow>
      {agentList.filter((agent) => agent.name === effectiveAgent).map((agent) => (
        <SettingRow
          key={agent.name}
          {...settingProps('agent.cliPaths')}
          label={`${agent.displayName} Path`}
          trailing={
            <span className={`text-xs flex items-center gap-1 ${agent.found ? 'text-fg-faint' : 'text-red-400/70'}`}>
              {agent.found
                ? <><Check size={13} className="text-green-400" />{agent.version ? `v${agent.version.replace(/^v/, '')}` : 'Detected'}</>
                : <><CircleAlert size={13} />Not found</>}
            </span>
          }
        >
          <div className="relative">
            <input
              type="text"
              value={globalConfig.agent.cliPaths[agent.name] || ''}
              onChange={(event) => updateGlobal({ agent: { cliPaths: { ...globalConfig.agent.cliPaths, [agent.name]: event.target.value || null } } })}
              placeholder={agent.found ? (agent.path ?? undefined) : 'Enter path manually'}
              className={`${INPUT_CLASS} pr-8 placeholder-fg-muted`}
            />
            <button
              type="button"
              onClick={handleRefreshAgents}
              disabled={refreshing}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors disabled:opacity-50"
              title={agent.found ? 'Re-detect agent' : `${agent.displayName} not found - click to re-detect`}
            >
              <RefreshCw size={16} className={`text-fg-faint hover:text-fg-muted ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </SettingRow>
      ))}
      <SettingRow {...settingProps('agent.idleTimeoutMinutes')}>
        <input
          type="number"
          value={globalConfig.agent.idleTimeoutMinutes}
          onChange={(event) => updateGlobal({ agent: { idleTimeoutMinutes: Number(event.target.value) } })}
          min={0}
          max={120}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('agent.permissionMode')}>
        <Select
          value={config.agent.permissionMode}
          onChange={(event) => updateProject({ agent: { permissionMode: event.target.value as PermissionMode } })}
        >
          {agentPermissions.map((entry) => (
            <option key={entry.mode} value={entry.mode}>{entry.label}</option>
          ))}
        </Select>
      </SettingRow>
    </>
  );
}
