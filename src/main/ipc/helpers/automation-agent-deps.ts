import { agentRegistry } from '../../agent/agent-registry';
import type { AutomationAgentDeps } from '../../automations/automation-agent';
import type { IpcContext } from '../ipc-context';

/**
 * What resolving the Automation agent reads from the app: the config, and the
 * agent registry. Shared by the Condition check, the task title suggestion and
 * the Command Terminal namer, so all three resolve the same agent.
 */
export function automationAgentDeps(context: Pick<IpcContext, 'configManager'>): AutomationAgentDeps {
  return {
    loadConfig: () => context.configManager.load(),
    listAgents: async () => agentRegistry.list().flatMap((name) => {
      const adapter = agentRegistry.get(name);
      return adapter ? [{ name, adapter }] : [];
    }),
  };
}
