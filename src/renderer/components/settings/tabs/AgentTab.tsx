import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, RefreshCw } from 'lucide-react';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import type { AgentDetectionInfo, AgentPermissionEntry, AppConfig, PermissionMode } from '../../../../shared/types';
import { DEFAULT_PERMISSIONS, DEFAULT_AGENT, getAgentDefaultPermission } from '../../../../shared/types';
import { agentDisplayName, agentLoginCommand } from '../../../utils/agent-display-name';
import { useAgentCapabilityResolution } from '../../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../../hooks/useKnownModels';
import { ModelCombobox } from '../../dialogs/ModelCombobox';
import { Combobox } from '../../dialogs/Combobox';
import { SectionHeader, SettingRow, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { AgentExecutionFields } from './agent-execution-fields';
import { AgentLaunchOptionFields } from './agent-launch-option-fields';

export function AgentTab({ config, globalConfig, agentList }: {
  config: AppConfig;
  globalConfig: AppConfig;
  agentList: AgentDetectionInfo[];
}) {
  const updateGlobal = useScopedUpdate('global');
  const updateProject = useScopedUpdate('project');
  const currentProject = useProjectStore((state) => state.currentProject);
  const refreshCurrentProject = useProjectStore((state) => state.loadCurrent);
  const refreshAgentList = useConfigStore((state) => state.loadAgentList);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
  }, []);

  const handleCopyLoginCommand = (agentName: string, command: string) => {
    navigator.clipboard.writeText(command).catch(() => { /* leave copied state alone; user can retry */ });
    setCopiedAgent(agentName);
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
    copyTimeout.current = setTimeout(
      () => setCopiedAgent((current) => (current === agentName ? null : current)),
      2000,
    );
  };

  const handleRefreshAgents = async () => {
    setRefreshing(true);
    const minimumDelay = new Promise((resolve) => setTimeout(resolve, 800));
    // Force a fresh probe: the user clicks this to pick up a CLI they just
    // installed or signed into, which the cached result would not reflect.
    await Promise.all([minimumDelay, refreshAgentList(true)]);
    setRefreshing(false);
  };

  const effectiveAgent = currentProject?.default_agent ?? DEFAULT_AGENT;
  const agentPermissions: AgentPermissionEntry[] = agentList.find((agent) => agent.name === effectiveAgent)?.permissions ?? DEFAULT_PERMISSIONS;
  const detectedAgents = useMemo(() => agentList.filter((agent) => agent.found), [agentList]);
  const undetectedAgents = useMemo(() => agentList.filter((agent) => !agent.found), [agentList]);

  const {
    models: defaultModelOptions,
    effortLevels: defaultEffortOptions,
    supportsModelOverride: showDefaultModelPicker,
  } = useAgentCapabilityResolution(effectiveAgent);
  const defaultModelContextWindows = useModelContextWindows(effectiveAgent);
  const defaultModelDisplayNames = useModelDisplayNames(effectiveAgent);
  const showDefaultEffortPicker = defaultEffortOptions.length > 0;

  const handleDefaultAgentChange = async (agentName: string) => {
    if (!currentProject) return;
    await window.electronAPI.projects.setDefaultAgent(currentProject.id, agentName);
    // Switch to the new agent's recommended default permission mode
    const newDefault = getAgentDefaultPermission(agentList, agentName);
    if (newDefault !== config.agent.permissionMode) {
      updateProject({ agent: { permissionMode: newDefault } });
    }
    // Previous model/effort defaults were valid for the previous agent's
    // capability matrix; clear so the user re-picks from the new agent.
    await window.electronAPI.projects.setDefaultModel(currentProject.id, null);
    await window.electronAPI.projects.setDefaultEffort(currentProject.id, null);
    await refreshCurrentProject();
  };

  const handleDefaultModelChange = async (model: string) => {
    if (!currentProject) return;
    await window.electronAPI.projects.setDefaultModel(currentProject.id, model || null);
    await refreshCurrentProject();
  };

  const handleDefaultEffortChange = async (effort: string) => {
    if (!currentProject) return;
    await window.electronAPI.projects.setDefaultEffort(currentProject.id, effort || null);
    await refreshCurrentProject();
  };

  return (
    <>
      <SectionHeader
        label="Project Defaults"
        searchIds={['project.defaultAgent', 'project.defaultModel', 'project.defaultEffort', 'agent.permissionMode']}
      />
      <SettingRow {...settingProps('project.defaultAgent')}>
        <Combobox
          value={effectiveAgent}
          onChange={handleDefaultAgentChange}
          options={
            agentList.length > 0
              ? [...detectedAgents, ...undetectedAgents].map((agent) => ({ value: agent.name, label: agent.displayName ?? agent.name }))
              : [{ value: DEFAULT_AGENT, label: agentDisplayName(DEFAULT_AGENT) }]
          }
          allowClear={false}
          disabled={!currentProject}
          testId="project-default-agent"
        />
      </SettingRow>
      {showDefaultModelPicker && (
        <SettingRow {...settingProps('project.defaultModel')}>
          <ModelCombobox
            value={currentProject?.default_model ?? ''}
            onChange={handleDefaultModelChange}
            availableModels={defaultModelOptions}
            placeholder="Agent default"
            placeholderVariant="muted"
            testId="project-default-model"
            onOpen={() => useConfigStore.getState().rescanModels()}
            contextWindows={defaultModelContextWindows}
            modelDisplayNames={defaultModelDisplayNames}
          />
        </SettingRow>
      )}
      {showDefaultEffortPicker && (
        <SettingRow {...settingProps('project.defaultEffort')}>
          <Combobox
            value={currentProject?.default_effort ?? ''}
            onChange={handleDefaultEffortChange}
            options={defaultEffortOptions.map((level) => ({ value: level, label: level }))}
            placeholder="Agent default"
            placeholderVariant="muted"
            testId="project-default-effort"
          />
        </SettingRow>
      )}
      <SettingRow {...settingProps('agent.permissionMode')}>
        <Combobox
          value={config.agent.permissionMode}
          onChange={(nextValue) => updateProject({ agent: { permissionMode: nextValue as PermissionMode } })}
          options={agentPermissions.map((entry) => ({ value: entry.mode, label: entry.label }))}
          allowClear={false}
          testId="agent-permission-mode"
        />
      </SettingRow>
      <SectionHeader
        label="Agent CLI"
        searchIds={['agent.cliPaths', 'agent.executionMode', 'agent.executionServerUrl', 'agent.executionServerAuth', 'agent.executionWorkingDirectory', 'agent.launchOptions']}
      />
      {agentList.filter((agent) => agent.name === effectiveAgent).map((agent) => {
        const loginCommand = agentLoginCommand(agent.name);
        const unauthenticated = agent.found && agent.authenticated === false;
        return (
        <Fragment key={agent.name}>
          <SettingRow
            {...settingProps('agent.cliPaths')}
            label={`${agent.displayName} Path`}
            trailing={
              unauthenticated ? (
                <span className="text-xs flex items-center gap-1 text-amber-400">
                  <CircleAlert size={13} />Not signed in
                </span>
              ) : (
                <span className={`text-xs flex items-center gap-1 ${agent.found ? 'text-fg-faint' : 'text-red-400/70'}`}>
                  {agent.found
                    ? <><Check size={13} className="text-green-400" />{agent.version ? `v${agent.version.replace(/^v/, '')}` : 'Detected'}</>
                    : <><CircleAlert size={13} />Not found</>}
                </span>
              )
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
            {unauthenticated && loginCommand && (
              <div className="mt-1 text-xs text-amber-400/80 flex items-center gap-2">
                <span>Run <code className="font-mono">{loginCommand}</code> in your terminal to authenticate.</span>
                <button
                  type="button"
                  onClick={() => handleCopyLoginCommand(agent.name, loginCommand)}
                  className="inline-flex items-center gap-1 text-accent hover:underline cursor-pointer"
                  title={`Copy "${loginCommand}" to clipboard`}
                  data-testid={`agent-tab-copy-login-${agent.name}`}
                >
                  <Copy size={11} />{copiedAgent === agent.name ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </SettingRow>
          <AgentExecutionFields agent={agent} config={config} globalConfig={globalConfig} />
          <AgentLaunchOptionFields agent={agent} globalConfig={globalConfig} />
        </Fragment>
        );
      })}
    </>
  );
}
