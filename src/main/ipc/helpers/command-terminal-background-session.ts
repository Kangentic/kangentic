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
 * (`AgentAdapter.backgroundSessionOf`), read with no CLI. Only on that evidence
 * does the CLI run: its stop, then for a resume the id a `--resume` reaches. So
 * an ordinary end or resume runs no CLI.
 */
import type { StoredCliTarget } from '../../../shared/types';
import type { AgentAdapter } from '../../agent/agent-adapter';
import { agentRegistry } from '../../agent/agent-registry';
import { PLAUSIBLE_AGENT_SESSION_ID } from '../../agent/shared/agent-session-id';
import { placeFromStored, type CliPlace } from '../../agent/shared/cli-target';
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
  /**
   * Does a live terminal hold this conversation? The one `/bg` ran in keeps
   * the background session on screen, and its row the move left is offered in
   * Earlier while it runs, so a resume of that row must not stop it.
   */
  isHeldLive(agentSessionId: string): boolean;
}

/** Whether a live session of the context's session manager holds the conversation. */
export function heldByLiveSession(context: Pick<IpcContext, 'sessionManager'>, agentSessionId: string): boolean {
  return context.sessionManager.listSessions()
    .some((session) => session.agentSessionId === agentSessionId && session.status !== 'exited');
}

/**
 * Stop the background session the conversation moved into, when the agent's
 * own files show one and no live terminal holds it. Resolves the background
 * session's id on that evidence, whether or not it was still running to stop,
 * and null without it. Never throws.
 */
export async function stopCommandTerminalBackgroundSession(conversation: CommandTerminalConversation): Promise<string | null> {
  const { adapter, agentSessionId, cwd, place } = conversation;
  if (!adapter.backgroundSessionOf || !adapter.stopBackgroundSession) return null;
  let backgroundId: string | null;
  try {
    backgroundId = await adapter.backgroundSessionOf({ agentSessionId, cwd, place });
  } catch (error) {
    warn(`could not check whether ${agentSessionId.slice(0, 8)} is in a background session`, error);
    return null;
  }
  if (!backgroundId) return null;
  if (conversation.isHeldLive(backgroundId)) {
    console.log(`[COMMAND_TERMINAL] the background session ${backgroundId.slice(0, 8)} is held by a live terminal; not stopped`);
    return backgroundId;
  }
  try {
    const cliPath = await conversation.resolveCliPath();
    if (!cliPath) return backgroundId;
    const stopRan = await adapter.stopBackgroundSession({ agentSessionId: backgroundId, cliPath });
    if (stopRan) console.log(`[COMMAND_TERMINAL] stopped the background session ${backgroundId.slice(0, 8)} holding ${agentSessionId.slice(0, 8)}`);
  } catch (error) {
    warn(`could not stop the background session ${backgroundId.slice(0, 8)}`, error);
  }
  return backgroundId;
}

/**
 * The id an Earlier resume of the conversation hands `--resume`, after the
 * background session it moved into, if any, is stopped.
 *
 * A row that is the background session itself, moved into before its first
 * turn there, resumes by the conversation it continued
 * (`resolveResumableSessionId`). A row the move left keeps its own id, by
 * decision: its transcript holds the conversation up to the move, and a
 * background session that took turns has a row of its own beside it. The
 * alternative was to resume the background session instead, which would make
 * an Earlier row open a conversation other than the one it shows.
 *
 * Anything unproven, and an id that is not shaped like one, keeps
 * `agentSessionId`. Never throws.
 */
export async function settleCommandTerminalResume(conversation: CommandTerminalConversation): Promise<string> {
  const { adapter, agentSessionId, cwd, place } = conversation;
  const backgroundId = await stopCommandTerminalBackgroundSession(conversation);
  if (backgroundId !== agentSessionId || !adapter.resolveResumableSessionId) return agentSessionId;
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
  context: Pick<IpcContext, 'configManager' | 'sessionManager'>,
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
    // The ended terminal's row is gone by now, so only another terminal counts.
    isHeldLive: (backgroundId) => heldByLiveSession(context, backgroundId),
  });
}

function warn(what: string, error: unknown): void {
  console.warn(`[COMMAND_TERMINAL] ${what} (non-fatal):`, error instanceof Error ? error.message : String(error));
}
