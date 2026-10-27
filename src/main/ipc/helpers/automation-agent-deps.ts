import { agentRegistry } from '../../agent/agent-registry';
import type { AutomationAgentDeps } from '../../automations/automation-agent';
import type { IpcContext } from '../ipc-context';

/**
 * What resolving the Automation agent reads from the app: the config, and the
 * agent registry. Shared by the Condition check, the task title suggestion and
 * the Command Terminal namer, so all three resolve the same agent.
 *
 * `projectPath` is the project the job runs for. CLI paths are per project
 * (Settings > Agent), so the agent's CLI is the one that project sets, a CLI in
 * a WSL distro included; the Automation agent itself is one global choice,
 * which the project's config carries unchanged. With no project, the global
 * config.
 */
export function automationAgentDeps(context: Pick<IpcContext, 'configManager'>, projectPath: string | null = null): AutomationAgentDeps {
  return {
    loadConfig: () => (projectPath ? context.configManager.getEffectiveConfig(projectPath) : context.configManager.load()),
    listAgents: async () => agentRegistry.list().flatMap((name) => {
      const adapter = agentRegistry.get(name);
      return adapter ? [{ name, adapter }] : [];
    }),
  };
}
