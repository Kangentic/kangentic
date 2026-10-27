import { useState } from 'react';
import { Check, CircleAlert, Loader2, Signal } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AgentDetectionInfo, AgentExecutionServer, AgentProjectExecution, AppConfig, RemoteServerStatus } from '../../../../shared/types';
import { INPUT_CLASS, useScopedUpdate } from '../shared';
import { CardRow, CardTile, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';
import { OptionalTag } from '../../OptionalTag';
import { Tooltip } from '../../Tooltip';

const DEFAULT_SERVER: AgentExecutionServer = { url: null, auth: { kind: 'none' } };
const DEFAULT_USAGE: AgentProjectExecution = { mode: 'local', workingDirectory: null };

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
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  const updateProject = useScopedUpdate('project');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<RemoteServerStatus | null>(null);

  if (!agent.remoteExecution) return null;

  const server = globalConfig.agent.executionServers[agent.name] ?? DEFAULT_SERVER;
  const usage = config.agent.execution[agent.name] ?? DEFAULT_USAGE;
  const isRemote = usage.mode === 'remote';
  const basicAuth = server.auth.kind === 'basic' ? server.auth : { kind: 'basic' as const, username: '', password: '' };
  const displayName = agent.displayName;

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
      <CardChoiceRow
        {...settingProps('agent.executionMode')}
        label={t`${displayName} execution`}
        options={[
          { value: 'local', label: t({ message: 'Local', context: 'execution mode' }), testId: `execution-mode-${agent.name}-local` },
          { value: 'remote', label: t({ message: 'Remote', context: 'execution mode' }), testId: `execution-mode-${agent.name}-remote` },
        ]}
        value={usage.mode}
        onChange={(mode) => updateUsage({ mode })}
        testId={`execution-mode-${agent.name}`}
      />

      {isRemote && (
        <>
          <CardRow
            {...settingProps('agent.executionServerUrl')}
            trailing={
              probeResult ? (
                probeResult.reachable ? (
                  // Tokens, not raw green-400 / amber-400, so the verdict tracks
                  // every theme. Same treatment as the relay's Test connection
                  // verdict in MobileDevicesTab and WelcomeScreen's CLI probe:
                  // the lockstep with the relay control is the whole verdict, not
                  // just the glyph, or the two drift apart in exactly the themes
                  // where a fixed hue stops reading as a verdict at all.
                  <span className="text-xs flex items-center gap-1 text-active">
                    <Check size={13} />
                    {/* i18n-ok: a version number */}
                    {probeResult.version ? `v${probeResult.version}` : t`Reachable`}
                  </span>
                ) : (
                  <Tooltip label={probeResult.reason}>
                    <span className="text-xs flex items-center gap-1 text-attention">
                      <CircleAlert size={13} /><Trans>Unreachable</Trans>
                    </span>
                  </Tooltip>
                )
              ) : undefined
            }
          >
            <div className="flex gap-2">
              {/* Deliberately per-keystroke, unlike the other settings text fields.
                  "Test connection" beside it probes BY AGENT NAME, so main reads the
                  PERSISTED url; a commit-on-blur boundary would both leave the button
                  disabled while typing and race the probe against the write the blur
                  started. See SettingTextInput's docblock. */}
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
                {/* Signal, kept in lockstep with the relay's identical Test
                    connection button in MobileDevicesTab: two controls that do
                    the same thing must not drift to different glyphs. See that
                    file for why Server was dropped and why Signal was picked
                    over the other candidates. */}
                {probing ? <Loader2 size={13} className="animate-spin" /> : <Signal size={13} />}
                <Trans>Test connection</Trans>
              </button>
            </div>
          </CardRow>

          {agent.remoteExecution.authKind === 'basic' && (
            <CardRow
              {...settingProps('agent.executionServerAuth')}
              labelTrailing={<OptionalTag />}
            >
              <div className="flex gap-2">
                {/* Per-keystroke for the same reason as the url above: "Test connection"
                    probes the persisted credentials. */}
                <input
                  type="text"
                  value={basicAuth.username}
                  onChange={(event) => updateServer({ auth: { ...basicAuth, kind: 'basic', username: event.target.value } })}
                  placeholder={t`Username`}
                  className={`${INPUT_CLASS} flex-1`}
                  data-testid={`execution-server-username-${agent.name}`}
                />
                <input
                  type="password"
                  value={basicAuth.password}
                  onChange={(event) => updateServer({ auth: { ...basicAuth, kind: 'basic', password: event.target.value } })}
                  placeholder={t`Password`}
                  className={`${INPUT_CLASS} flex-1`}
                  data-testid={`execution-server-password-${agent.name}`}
                />
              </div>
            </CardRow>
          )}

          <CardRow
            {...settingProps('agent.executionWorkingDirectory')}
            label={t`Server working directory`}
            labelTrailing={<OptionalTag />}
          >
            {/* Per-keystroke, matching its siblings above rather than being the one
                field in this section with a different commit boundary. */}
            <input
              type="text"
              value={usage.workingDirectory ?? ''}
              onChange={(event) => updateUsage({ workingDirectory: event.target.value || null })}
              // i18n-ok: an example path
              placeholder="/home/dev/project"
              className={INPUT_CLASS}
              data-testid={`execution-working-directory-${agent.name}`}
            />
          </CardRow>

          {agent.remoteExecution.remoteModeCaveat && (
            <CardTile className="text-xs text-fg-faint">{agent.remoteExecution.remoteModeCaveat}</CardTile>
          )}
        </>
      )}
    </>
  );
}
