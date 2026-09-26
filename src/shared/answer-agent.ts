/**
 * Which agent answers a question from the index, and what is still missing
 * before it can.
 *
 * SHARED, because two places need the same answer and a disagreement between
 * them is invisible: the renderer decides whether a question can run or must
 * first go to Settings > Memory, and the main process decides who actually
 * runs. If those drifted, the box would send the user to settings for an agent
 * main would have run, or run an agent the settings row does not show.
 *
 * EXPLICIT, with no fallback. The chain used to fall through to the project's
 * default agent and then to any capable agent, so a question could run on an
 * agent and model nobody chose, and spend their tokens doing it. The user's
 * rule: this is one global choice, made in Settings > Memory, never inferred
 * from a project. So a configured agent that cannot answer, or is not
 * installed, resolves to nothing, and the surface asks for a choice.
 */

import type { AnswerCapabilities, AnswerSetupGap } from './types';

export interface AnswerAgentCandidate {
  name: string;
  displayName: string;
  /** Detection result. An installed-but-missing CLI cannot answer. */
  found?: boolean;
  supportsAnswerFromContext?: boolean;
  answerCapabilities?: AnswerCapabilities;
}

export interface ResolveAnswerAgentInput<T extends AnswerAgentCandidate> {
  agents: ReadonlyArray<T>;
  /** `memory.answerAgent`, or null/undefined when none has been chosen. */
  configured?: string | null;
  /**
   * Whether a candidate must be detected on disk.
   *
   * True in the renderer, which has the agent list with its `found` flag and
   * must not treat an agent that is not installed as chosen. The main process
   * detects the CLI itself immediately afterwards and reports a precise reason,
   * so it passes false rather than duplicating the check against a stale list.
   */
  requireFound?: boolean;
}

export function resolveAnswerAgent<T extends AnswerAgentCandidate>(
  input: ResolveAnswerAgentInput<T>,
): T | null {
  if (!input.configured) return null;
  const candidate = input.agents.find((entry) => entry.name === input.configured);
  if (!candidate || !candidate.supportsAnswerFromContext) return null;
  if (input.requireFound && !candidate.found) return null;
  return candidate;
}

export interface AnswerSetupGapInput<T extends AnswerAgentCandidate> extends ResolveAnswerAgentInput<T> {
  /** `memory.answerModel`, or null/undefined when none has been chosen. */
  configuredModel?: string | null;
}

/**
 * What is still missing before a question can run, or null when nothing is.
 *
 * `'agent'` covers every way the agent is not usable: never chosen, not able to
 * answer, or (for the renderer) not installed. `'model'` means the agent is fine
 * but its answer run takes a model and none has been chosen.
 */
export function answerSetupGap<T extends AnswerAgentCandidate>(
  input: AnswerSetupGapInput<T>,
): AnswerSetupGap | null {
  const agent = resolveAnswerAgent(input);
  if (!agent) return 'agent';
  if (agent.answerCapabilities?.model && !input.configuredModel) return 'model';
  return null;
}
