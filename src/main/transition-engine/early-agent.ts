import type { SpawnCommandOptions } from '../agent/agent-adapter';

/**
 * An agent CLI launched while its task's new worktree runs its setup script,
 * before anything about it is written to the database
 * (`TransitionEngine.launchEarlyAgent`). Its session is hidden until adopted
 * (`SessionManager.adoptSession`): the board, the renderer and every other
 * listener learn of it only when the task's spawn takes it over, after the
 * script exits, and that spawn types the first prompt in. Until then it has no
 * prompt, and nothing may type into it.
 *
 * Exactly one of two things ends it. The spawn adopts it (`markAdopted`), or
 * the caller discards it (`discard`): the script failed or was cancelled, the
 * task moved on, or the spawn would launch something different. A discard after
 * an adoption, or a second discard, does nothing, so every exit path of a
 * caller may discard without asking which one ran.
 */
export interface EarlyAgentHandle {
  /** The PTY session id, which an adopting spawn keeps. */
  readonly sessionId: string;
  readonly taskId: string;
  readonly agentName: string;
  /** The agent's own session id when the spawn chose it (`--session-id`), else null. */
  readonly agentSessionId: string | null;
  /** The command the PTY ran, recorded on the session row at adoption. */
  readonly command: string;
  readonly cwd: string;
  /** The launch this agent was started with (`launchKeyOf`), for the adoption check. */
  readonly launchKey: string;
  /** When the PTY started (epoch ms), which bounds the adoption's wait for its input box. */
  readonly launchedAt: number;
  /** True once adopted or discarded. */
  isSettled(): boolean;
  /** Mark the agent adopted. Returns false when it was already settled. */
  markAdopted(): boolean;
  /** Kill the agent, wait for its exit and drop its row. Never throws. */
  discard(): Promise<void>;
}

/**
 * How long after its launch an early agent has to reach its input box (its
 * TUI entering the alternate screen) for the spawn to adopt it. Its CLI start
 * runs alongside the setup script, so after a script of any length it is long
 * there; the bound matters only after a short script, or for an agent stopped
 * at a screen it shows first (an MCP server approval), which the spawn then
 * discards and launches as before, so the user answers that screen as always.
 * The same ceiling the launch overlay gives an agent to appear.
 */
export const EARLY_AGENT_INPUT_READY_BUDGET_MS = 15_000;

/**
 * The launch options a launch key leaves out: the prompt is typed in, the MCP
 * token is per app launch rather than per spawn, and the task is compared on
 * its own (`adoptEarlyAgent`). Every other option is in the key, one added
 * later included, so a new option can only make an adoption fail safe (the
 * early agent is discarded and the spawn launches as before), never adopt an
 * agent launched some other way.
 */
const LEFT_OUT_OF_THE_LAUNCH_KEY: ReadonlySet<string> = new Set<keyof SpawnCommandOptions>(['prompt', 'mcpServerToken', 'taskId']);

/**
 * What decides how an agent CLI is launched, as one comparable string. An
 * adopting spawn computes it for the launch it would make (same ids, no prompt
 * on the command line) and adopts only an agent with the same key: any change
 * between the early launch and the spawn (the column's model, a permission
 * mode, a CLI path, a launch option) means the running agent is not the one
 * the spawn would start. Keys are sorted, and an option left unset, undefined
 * or null reads the same, so two builds of one launch always match.
 */
export function launchKeyOf(agentName: string, options: SpawnCommandOptions): string {
  const deciding: Record<string, unknown> = { agentName };
  const entries: Array<[string, unknown]> = Object.entries(options);
  entries.sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : 1));
  for (const [key, value] of entries) {
    if (LEFT_OUT_OF_THE_LAUNCH_KEY.has(key) || value === undefined || value === null) continue;
    deciding[key] = value;
  }
  return JSON.stringify(deciding);
}

/**
 * Build the handle for an agent launched early. `teardown` is the kill, exit
 * wait and removal; the handle runs it at most once, and never after an
 * adoption.
 */
export function createEarlyAgentHandle(input: {
  sessionId: string;
  taskId: string;
  agentName: string;
  agentSessionId: string | null;
  command: string;
  cwd: string;
  launchKey: string;
  launchedAt: number;
  teardown: () => Promise<void>;
}): EarlyAgentHandle {
  let settled = false;
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    agentName: input.agentName,
    agentSessionId: input.agentSessionId,
    command: input.command,
    cwd: input.cwd,
    launchKey: input.launchKey,
    launchedAt: input.launchedAt,
    isSettled: () => settled,
    markAdopted: () => {
      if (settled) return false;
      settled = true;
      return true;
    },
    discard: async () => {
      if (settled) return;
      settled = true;
      try {
        await input.teardown();
      } catch (error) {
        console.warn(`[early-agent] Discarding the early agent of task ${input.taskId.slice(0, 8)} failed:`, error);
      }
    },
  };
}
