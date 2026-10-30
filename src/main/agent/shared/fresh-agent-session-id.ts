import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../agent-adapter';
import type { PermissionMode } from '../../../shared/types';

/**
 * A fresh conversation's id.
 *
 * A CLI that accepts an id Kangentic chose gets one here. A CLI that can
 * create an empty conversation and name it (`createSessionId`) is asked when
 * this launch will not report its own id. A print launch that already prints
 * the id (`reportsLaunchSessionId`) is left to do that, so the start does not
 * wait on a second, unused chat. Null when the CLI could not create one, or
 * reports it after launch.
 */
export async function resolveFreshAgentSessionId(
  adapter: Pick<AgentAdapter, 'supportsCallerSessionId' | 'createSessionId' | 'reportsLaunchSessionId'>,
  input: {
    cliPath: string;
    workingDirectory: string;
    permissionMode: PermissionMode;
    nonInteractive?: boolean;
  },
): Promise<string | null> {
  if (adapter.supportsCallerSessionId) return randomUUID();
  if (!adapter.createSessionId) return null;
  if (adapter.reportsLaunchSessionId?.({
    permissionMode: input.permissionMode,
    nonInteractive: input.nonInteractive,
  })) {
    return null;
  }
  return adapter.createSessionId(input.cliPath, input.workingDirectory);
}
