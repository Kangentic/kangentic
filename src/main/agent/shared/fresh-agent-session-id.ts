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
 *
 * `signal` is the spawn's own abort. Creating a chat runs the CLI (Cursor's
 * `create-chat` waits up to 20 s on its server) inside the task lock, so a
 * move that aborts this spawn gets null at once instead of waiting it out. The
 * CLI run itself ends on its own timeout.
 */
export async function resolveFreshAgentSessionId(
  adapter: Pick<AgentAdapter, 'supportsCallerSessionId' | 'createSessionId' | 'reportsLaunchSessionId'>,
  input: {
    cliPath: string;
    workingDirectory: string;
    permissionMode: PermissionMode;
    nonInteractive?: boolean;
    signal?: AbortSignal;
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
  const created = adapter.createSessionId(input.cliPath, input.workingDirectory);
  const { signal } = input;
  if (!signal) return created;
  if (signal.aborted) return null;
  return new Promise<string | null>((resolve) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    created.then(
      (agentSessionId) => {
        signal.removeEventListener('abort', onAbort);
        resolve(agentSessionId);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      },
    );
  });
}
