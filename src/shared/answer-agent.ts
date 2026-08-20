/**
 * Which agent answers a question from the conversation index.
 *
 * SHARED, because two places need the same answer and a disagreement between
 * them is invisible: the renderer decides whether to offer Ask at all and whose
 * name to print on the button, and the main process decides who actually runs.
 * If those drifted, the button would name one agent and a different one would
 * reply - or worse, the button would appear for an agent that cannot answer and
 * fail only when pressed.
 *
 * The order is a preference chain, and every step is skipped unless the agent
 * can actually answer:
 *
 *   1. The explicit `memory.answerAgent` setting. Someone said what they want.
 *   2. The project's default agent. Which agent runs your tasks is a reasonable
 *      guess at which agent should read their history.
 *   3. Any agent that declares the capability. Better a named fallback than no
 *      affordance - and the button prints the name, so the fallback is stated
 *      rather than silent.
 */

export interface AnswerAgentCandidate {
  name: string;
  displayName: string;
  /** Detection result. An installed-but-missing CLI cannot answer. */
  found?: boolean;
  supportsAnswerFromContext?: boolean;
}

export interface ResolveAnswerAgentInput<T extends AnswerAgentCandidate> {
  agents: ReadonlyArray<T>;
  /** `memory.answerAgent`, or null/undefined for "follow the project". */
  configured?: string | null;
  /** The project's `default_agent`, or null when it names none. */
  projectAgent?: string | null;
  /**
   * Whether a candidate must be detected on disk.
   *
   * True in the renderer, which has the agent list with its `found` flag and
   * must not offer Ask for an agent that is not installed. The main process
   * detects the CLI itself immediately afterwards and reports a precise reason,
   * so it passes false rather than duplicating the check against a stale list.
   */
  requireFound?: boolean;
}

export function resolveAnswerAgent<T extends AnswerAgentCandidate>(
  input: ResolveAnswerAgentInput<T>,
): T | null {
  const usable = (candidate: T | undefined): T | null => {
    if (!candidate) return null;
    if (!candidate.supportsAnswerFromContext) return null;
    if (input.requireFound && !candidate.found) return null;
    return candidate;
  };
  const byName = (name: string | null | undefined): T | null =>
    (name ? usable(input.agents.find((entry) => entry.name === name)) : null);

  return byName(input.configured)
    ?? byName(input.projectAgent)
    ?? input.agents.find((entry) => usable(entry) !== null)
    ?? null;
}
