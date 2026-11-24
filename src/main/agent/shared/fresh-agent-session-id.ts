import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../agent-adapter';
import type { PermissionMode, SessionIdCreation, SessionIdCreationOutcome } from '../../../shared/types';
import type { CliPlace } from './cli-target';

/** A fresh conversation's id, or null, and how the launch got it (the session-id report's `create_chat` tag). */
export interface FreshAgentSessionId {
  agentSessionId: string | null;
  sessionIdCreation: SessionIdCreationOutcome;
}

/**
 * A fresh conversation's id.
 *
 * A CLI that accepts an id Kangentic chose gets one here. A CLI that can
 * create an empty conversation and name it (`createSessionId`) is asked when
 * this launch will not report its own id. A print launch that already prints
 * the id (`reportsLaunchSessionId`) is left to do that, so the start does not
 * wait on a second, unused chat. Null when the CLI could not create one, or
 * reports it after launch; `sessionIdCreation` says which, as a fixed word.
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
    /** The prompt the launch's command carries: undefined with none, or one typed in after launch. */
    prompt: string | undefined;
    signal?: AbortSignal;
    /** Where the CLI runs when it is not on this computer (a WSL distro, an SSH host): the chat is made there. */
    place?: CliPlace | null;
  },
): Promise<FreshAgentSessionId> {
  if (adapter.supportsCallerSessionId) return { agentSessionId: randomUUID(), sessionIdCreation: 'not_asked' };
  if (!adapter.createSessionId) return { agentSessionId: null, sessionIdCreation: 'not_asked' };
  if (adapter.reportsLaunchSessionId?.({
    permissionMode: input.permissionMode,
    nonInteractive: input.nonInteractive,
    prompt: input.prompt,
  })) {
    return { agentSessionId: null, sessionIdCreation: 'not_asked' };
  }
  const { signal } = input;
  if (signal?.aborted) return { agentSessionId: null, sessionIdCreation: 'aborted' };
  // The place goes only when the CLI runs somewhere else, so a spawn on this computer calls it exactly as before.
  const created = (input.place
    ? adapter.createSessionId(input.cliPath, input.workingDirectory, input.place)
    : adapter.createSessionId(input.cliPath, input.workingDirectory)
  ).then(
    (creation: SessionIdCreation): FreshAgentSessionId => ({ agentSessionId: creation.agentSessionId, sessionIdCreation: creation.outcome }),
    // report-ok: the contract says never throws; a rejection anyway is reported as the fixed `failed` tag.
    (): FreshAgentSessionId => ({ agentSessionId: null, sessionIdCreation: 'failed' }),
  );
  if (!signal) return created;
  return new Promise<FreshAgentSessionId>((resolve) => {
    const onAbort = (): void => resolve({ agentSessionId: null, sessionIdCreation: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    void created.then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    });
  });
}
