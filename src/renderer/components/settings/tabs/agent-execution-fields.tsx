import { useState } from 'react';
import { Check, CircleAlert, Loader2, Server } from 'lucide-react';
import type { AgentDetectionInfo, AgentExecutionServer, AgentProjectExecution, AppConfig, RemoteServerStatus } from '../../../../shared/types';
import { Select, SettingRow, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { Pill } from '../../Pill';

const DEFAULT_SERVER: AgentExecutionServer = { url: null, auth: { kind: 'none' } };
const DEFAULT_USAGE: AgentProjectExecution = { mode: 'local', workingDirectory: null };

/** Small muted "Optional" tag appended to a field label. Required fields are
 *  left unmarked - only the exception (optional) needs calling out. */
function OptionalTag() {
  return (
    <Pill size="xs" className="bg-surface-hover text-fg-faint border border-edge/50 font-normal">
      Optional
    </Pill>
  );
}

/**
 * Remote-execution fields for the currently-selected agent in the Agent
 * settings tab: choose local vs. remote for this project, and (when remote)
 * configure the server this agent attaches to instead of spawning locally.
 *
 * Renders nothing when `agent` has no `remoteExecution` capability - the
 * caller does not need to check first. Server identity (URL, auth) is
 * global - it names a machine, like `agent.cliPaths`. Execution mode and the
 * server working directory are per-project - this project's use of that
 * server, like `project.location`.
 */
export function AgentExecutionFields({ agent, config, globalConfig }: {
  agent: AgentDetectionInfo;
  config: AppConfig;
  globalConfig: AppConfig;
}) {
  const updateGlobal = useScopedUpdate('global');
  const updateProject = useScopedUpdate('project');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<RemoteServerStatus | null>(null);

  if (!agent.remoteExecution) return null;

  const server = globalConfig.agent.executionServers[agent.name] ?? DEFAULT_SERVER;
  const usage = config.agent.execution[agent.name] ?? DEFAULT_USAGE;
  const isRemote = usage.mode === 'remote';
  const basicAuth = server.auth.kind === 'basic' ? server.auth : { kind: 'basic' as const, username: '', password: '' };

  const updateServer = (patch: Partial<AgentExecutionServer>) => {
    updateGlobal({ agent: { executionServers: { ...globalConfig.agent.executionServers, [agent.name]: { ...server, ...patch } } } });
  };
  const updateUsage = (patch: Partial<AgentProjectExecution>) => {
    updateProject({ agent: { execution: { ...config.agent.execution, [agent.name]: { ...usage, ...patch } } } });
  };
  const handleProbe = async () => {
    setProbing(true);
    try {
      setProbeResult(await window.electronAPI.agents.probeExecutionServer(agent.name));
    } finally {
      setProbing(false);
    }
  };

  return (
    <>
      <SettingRow {...settingProps('agent.executionMode')} label={`${agent.displayName} Execution`}>
        <Select
          value={usage.mode}
          onChange={(event) => updateUsage({ mode: event.target.value as AgentProjectExecution['mode'] })}
          data-testid={`execution-mode-${agent.name}`}
        >
          <option value="local">Local</option>
          <option value="remote">Remote</option>
        </Select>
      </SettingRow>

      {isRemote && (
        <>
          <SettingRow
            {...settingProps('agent.executionServerUrl')}
            trailing={
              probeResult ? (
                probeResult.reachable ? (
                  <span className="text-xs flex items-center gap-1 text-green-400">
                    <Check size={13} />{probeResult.version ? `v${probeResult.version}` : 'Reachable'}
                  </span>
                ) : (
                  <span className="text-xs flex items-center gap-1 text-amber-400" title={probeResult.reason}>
                    <CircleAlert size={13} />Unreachable
                  </span>
                )
              ) : undefined
            }
          >
            <div className="flex gap-2">
              <input
                type="text"
                value={server.url ?? ''}
                onChange={(event) => updateServer({ url: event.target.value || null })}
                placeholder={agent.remoteExecution.urlPlaceholder}
                className={`${INPUT_CLASS} flex-1`}
                data-testid={`execution-server-url-${agent.name}`}
              />
              <button
                type="button"
                onClick={() => void handleProbe()}
                disabled={probing || !server.url}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-edge-input bg-surface-hover text-fg-secondary hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid={`execution-test-connection-${agent.name}`}
              >
                {probing ? <Loader2 size={13} className="animate-spin" /> : <Server size={13} />}
                Test connection
              </button>
            </div>
          </SettingRow>

          {agent.remoteExecution.authKind === 'basic' && (
            <SettingRow
              {...settingProps('agent.executionServerAuth')}
              label={<span className="inline-flex items-center gap-2">Authentication<OptionalTag /></span>}
            >
              <div className="flex gap-2">
                <input
                  type="text"
                  value={basicAuth.username}
                  onChange={(event) => updateServer({ auth: { ...basicAuth, kind: 'basic', username: event.target.value } })}
                  placeholder="Username"
                  className={`${INPUT_CLASS} flex-1`}
                  data-testid={`execution-server-username-${agent.name}`}
                />
                <input
                  type="password"
                  value={basicAuth.password}
                  onChange={(event) => updateServer({ auth: { ...basicAuth, kind: 'basic', password: event.target.value } })}
                  placeholder="Password"
                  className={`${INPUT_CLASS} flex-1`}
                  data-testid={`execution-server-password-${agent.name}`}
                />
              </div>
            </SettingRow>
          )}

          <SettingRow
            {...settingProps('agent.executionWorkingDirectory')}
            label={<span className="inline-flex items-center gap-2">Server Working Directory<OptionalTag /></span>}
          >
            <input
              type="text"
              value={usage.workingDirectory ?? ''}
              onChange={(event) => updateUsage({ workingDirectory: event.target.value || null })}
              placeholder="/home/dev/project"
              className={INPUT_CLASS}
              data-testid={`execution-working-directory-${agent.name}`}
            />
          </SettingRow>

          {agent.remoteExecution.remoteModeCaveat && (
            <p className="text-xs text-fg-faint">{agent.remoteExecution.remoteModeCaveat}</p>
          )}
        </>
      )}
    </>
  );
}
