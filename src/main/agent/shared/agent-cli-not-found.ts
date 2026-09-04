import { UserConfigurationError } from '../../../shared/user-configuration-error';

/**
 * The one canonical "this agent's CLI is missing" sentence.
 *
 * Takes `displayName` alone and never appends the word "CLI": six of the
 * fourteen registered adapters already end their display name with it
 * (`Codex CLI`, `Cursor CLI`, `GitHub Copilot CLI`, `Gemini CLI`,
 * `Antigravity CLI`, `Oz CLI`), so the three sites that used to append it
 * produced "Codex CLI CLI not found on PATH". The adapters that omit "CLI"
 * (`Claude Code`, `Droid`, `Aider`, ...) read correctly without it, so
 * appending the word was the bug, not the display names.
 *
 * Exported separately from the error class because one of the three call sites
 * reports a `reason` string rather than throwing
 * (`ipc/handlers/system.ts`'s summarize probe). Both routes therefore share a
 * single function, which is what lets `tests/unit/agent-cli-not-found.test.ts`
 * walk every registered adapter through one call.
 */
export function agentCliNotFoundMessage(displayName: string): string {
  return `${displayName} not found on PATH. Install it, or set its path in Settings > Agent.`;
}

/**
 * Thrown when a spawn resolves an agent whose CLI is not installed or not on
 * PATH. Typed so the callers that deliberately do not fail the whole operation
 * can still tell the user why no agent started, the way
 * `BranchCheckoutBlockedError` does for a blocked checkout.
 *
 * The remedy travels with the error: `describeSpawnFailure` returns this
 * message verbatim, so the user gets the pointer to the CLI path override
 * (`agent.cliPaths.<agent>`, Settings > Agent) rather than a card that silently
 * never spawned.
 *
 * Extending `UserConfigurationError` is what keeps it out of Sentry: a missing
 * CLI is the user's environment, not a defect we can ship a fix for. The
 * Aptabase `spawn_failed` counter still fires, which is where "how often are
 * users hitting a missing CLI" gets answered.
 *
 * Generic via `displayName` on purpose - no agent-name branching outside the
 * adapters folder (.claude/rules/agent-adapters-boundary.md).
 */
export class AgentCliNotFoundError extends UserConfigurationError {
  constructor(
    readonly agentName: string,
    readonly displayName: string,
  ) {
    super(agentCliNotFoundMessage(displayName));
    this.name = 'AgentCliNotFoundError';
  }
}
