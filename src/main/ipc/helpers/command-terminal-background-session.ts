/**
 * A Command Terminal's conversation and the agent CLI's own background session
 * (Claude Code's `/bg`), which outlives the terminal's PTY.
 *
 * `/bg` in a terminal moves its conversation into a background session that the
 * CLI's supervisor runs outside the PTY, and the live switch follows it there
 * (ConversationSwitchGate). Ending the terminal ends only the PTY's client, so
 * the session would keep working with nobody watching, and an Earlier resume of
 * the conversation would run a second process on it.
 *
 * A task's conversation is checked by its session record's own SessionStart
 * hooks (`backgroundSessionHoldingConversation`). A Command Terminal has no
 * record, and its events file is deleted with its session directory, so the
 * evidence here is the agent's own transcripts
 * (`AgentAdapter.isInBackgroundSession`), read with no CLI. Only on that
 * evidence does the CLI run: its stop, then for a resume the id a `--resume`
 * reaches. So an ordinary end or resume runs no CLI.
 */
import type { StoredCliTarget } from '../../../shared/types';
import type { AgentAdapter } from '../../agent/agent-adapter';
import { agentRegistry } from '../../agent/agent-registry';
import { placeFromStored, type CliPlace } from '../../agent/shared/cli-target';
import { PLAUSIBLE_AGENT_SESSION_ID } from '../../transition-engine/resume-id-reconcile';
import type { IpcContext } from '../ipc-context';

export interface CommandTerminalConversation {
  adapter: AgentAdapter;
  agentSessionId: string;
  /** The folder the terminal ran in, which places its transcripts. */
  cwd: string;
  /** Where its CLI ran when that is not this machine (a WSL distro). */
  place: CliPlace | null;
  /** The agent's CLI, resolved only once the files show a background session. */
  resolveCliPath(): Promise<string | null>;
}

/**
 * Stop the background session holding the conversation, when the agent's own
 * files show it moved into one. Resolves true on that evidence, whether or not
 * a session was still running to stop, and false without it. Never throws.
 */
export async function stopCommandTerminalBackgroundSession(conversation: CommandTerminalConversation): Promise<boolean> {
  const { adapter, agentSessionId, cwd, place } = conversation;
  if (!adapter.isInBackgroundSession || !adapter.stopBackgroundSession) return false;
  let inBackgroundSession: boolean;
  try {
    inBackgroundSession = await adapter.isInBackgroundSession({ agentSessionId, cwd, place });
  } catch (error) {
    warn(`could not check whether ${agentSessionId.slice(0, 8)} is in a background session`, error);
    return false;
  }
  if (!inBackgroundSession) return false;
  try {
    const cliPath = await conversation.resolveCliPath();
    if (!cliPath) return true;
    const stopRan = await adapter.stopBackgroundSession({ agentSessionId, cliPath });
    if (stopRan) console.log(`[COMMAND_TERMINAL] stopped the background session holding ${agentSessionId.slice(0, 8)}`);
  } catch (error) {
    warn(`could not stop the background session holding ${agentSessionId.slice(0, 8)}`, error);
  }
  return true;
}

/**
 * The id an Earlier resume of the conversation hands `--resume`, after the
 * background session holding it, if any, is stopped. A conversation moved
 * into a background session before its first turn there resumes by the
 * conversation it continued (`resolveResumableSessionId`). Anything unproven,
 * and an id that is not shaped like one, keeps `agentSessionId`. Never throws.
 */
export async function settleCommandTerminalResume(conversation: CommandTerminalConversation): Promise<string> {
  const { adapter, agentSessionId, cwd, place } = conversation;
  const inBackgroundSession = await stopCommandTerminalBackgroundSession(conversation);
  if (!inBackgroundSession || !adapter.resolveResumableSessionId) return agentSessionId;
  try {
    const resolved = await adapter.resolveResumableSessionId({ agentSessionId, cwd, place });
    if (resolved === agentSessionId || !PLAUSIBLE_AGENT_SESSION_ID.test(resolved)) return agentSessionId;
    console.log(
      `[COMMAND_TERMINAL] ${agentSessionId.slice(0, 8)} moved into a background session and took no turn there,`
      + ` so it resumes as ${resolved.slice(0, 8)}, the conversation it continued.`,
    );
    return resolved;
  } catch (error) {
    warn(`could not resolve which id resumes ${agentSessionId.slice(0, 8)}`, error);
    return agentSessionId;
  }
}

/** What an ended terminal's removal snapshot and registry row said about its conversation. */
export interface EndedCommandTerminal {
  agentName: string | undefined;
  agentSessionId: string | null;
  cwd: string;
  cliTarget: StoredCliTarget | null;
}

/**
 * `stopCommandTerminalBackgroundSession` for a terminal that just ended, on
 * the project's configured CLI for its agent. Never throws.
 */
export async function stopEndedCommandTerminalBackgroundSession(
  context: Pick<IpcContext, 'configManager'>,
  ended: EndedCommandTerminal,
): Promise<void> {
  const { agentName, agentSessionId, cwd } = ended;
  if (!agentName || !agentSessionId) return;
  const adapter = agentRegistry.get(agentName);
  if (!adapter) return;
  await stopCommandTerminalBackgroundSession({
    adapter,
    agentSessionId,
    cwd,
    place: placeFromStored(ended.cliTarget),
    resolveCliPath: async () => {
      const cliPathOverride = context.configManager.getEffectiveConfig(cwd).agent.cliPaths[adapter.name] ?? null;
      const detection = await adapter.detect(cliPathOverride);
      return detection.found && detection.path ? detection.path : null;
    },
  });
}

function warn(what: string, error: unknown): void {
  console.warn(`[COMMAND_TERMINAL] ${what} (non-fatal):`, error instanceof Error ? error.message : String(error));
}
