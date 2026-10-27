import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { McpConnectionCheck } from '../../../shared/types';
import { agentRegistry } from '../../agent/agent-registry';
import { checkMcpConnection, wslDistrosOfCliPaths } from '../../agent/mcp-connection-check';
import { mcpServerStartFailure } from '../../agent/mcp-server-start-failure';
import { broadcast } from '../../pop-out/window-broadcast';
import { McpConnectionWatch } from '../helpers/mcp-connection-watch';
import type { IpcContext } from '../ipc-context';

/** Whether an agent's CLI may run in a WSL distro, so its path can name one. */
function supportsWsl(agentName: string): boolean {
  return agentRegistry.get(agentName)?.supportsWslCli === true;
}

/**
 * The MCP connection row's check (Settings > MCP Server) and the watch that
 * runs the same check at an agent session's start. The distros checked are the
 * ones the open project's CLI paths point into. Never throws: a check that
 * cannot run answers as a failure with its error.
 */
export function registerMcpServerHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.MCP_SERVER_CHECK_CONNECTION, async (_event, options?: { explicit?: boolean }): Promise<McpConnectionCheck> => {
    try {
      const config = context.configManager.getEffectiveConfig(context.currentProjectPath || undefined);
      return await checkMcpConnection({
        handle: context.mcpServerHandle,
        startFailure: mcpServerStartFailure(),
        projectId: context.currentProjectId,
        distros: wslDistrosOfCliPaths(config.agent.cliPaths, supportsWsl),
        startStoppedDistros: options?.explicit === true,
      });
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const watch = new McpConnectionWatch({
    sessions: context.sessionManager,
    isEnabled: () => context.configManager.load().mcpServer?.enabled !== false,
    // A session is running in its distro, so the check runs there whatever
    // the distro's state was a moment ago.
    check: (projectId, distros) => checkMcpConnection({
      handle: context.mcpServerHandle,
      startFailure: mcpServerStartFailure(),
      projectId,
      distros,
      startStoppedDistros: true,
    }),
    notify: (error) => broadcast(context.mainWindow, IPC.MCP_SERVER_CONNECTION_FAILED, { error }),
  });
  watch.start();
}
