/**
 * Which agent answers a question from the index, and what is still missing
 * before it can.
 *
 * SHARED, because two places need the same answer and a disagreement between
 * them is invisible: the renderer decides whether a question can run or must
 * first go to Settings > Knowledge Graph, and the main process decides who actually
 * runs. If those drifted, the box would send the user to settings for an agent
 * main would have run, or run an agent the settings row does not show.
 *
 * EXPLICIT, with no fallback. The chain used to fall through to the project's
 * default agent and then to any capable agent, so a question could run on an
 * agent and model nobody chose, and spend their tokens doing it. The user's
 * rule: this is one global choice, made in Settings > Knowledge Graph, never inferred
 * from a project. So a configured agent that cannot answer, or is not
 * installed, resolves to nothing, and the surface asks for a choice.
 */

import type { AnswerCapabilities, AnswerSetupGap, AppConfig } from './types';

/**
 * The two jobs the Knowledge Graph's agent does over the index: answering
 * questions, and writing task summaries. Both run on the one agent and model
 * chosen in the Knowledge Graph card. They differ only in effort, below.
 */
export type AgentJob = 'answer' | 'summary';

export interface AgentJobChoice {
  agent: string | null;
  model: string | null;
  /** The configured level, or null for the adapter's recommended one. */
  effort: string | null;
}

type KnowledgeGraphConfig = NonNullable<AppConfig['knowledgeGraph']>;

/**
 * The agent, model and effort one job runs at. The chosen effort is for
 * answers: a summary always runs at the adapter's recommended level. Measured on
 * this project's tasks, summaries at high effort read the same as at low and took
 * twice as long, while answers at the highest level got counts right that low
 * got wrong. So raising effort for a hard question neither slows the summaries
 * nor marks every one of them as written another way.
 */
export function agentJobChoice(config: KnowledgeGraphConfig | undefined, job: AgentJob): AgentJobChoice {
  return {
    agent: config?.agent ?? null,
    model: config?.model ?? null,
    effort: job === 'answer' ? config?.effort ?? null : null,
  };
}

/**
 * Whether task summaries are switched on. On unless switched off:
 * they are part of what the Knowledge Graph reads, and nothing is spent until
 * the Knowledge Graph has an agent, since the agent writes them. Their switch
 * stays usable while they wait, so they can be turned off before a call is
 * made. The one test main, the Settings card and the Index row all read, so
 * none of them can default it the other way.
 */
export function taskSummariesOn(config: KnowledgeGraphConfig | undefined): boolean {
  return config?.taskSummaries !== false;
}

/**
 * Whether source code is indexed: switched on (the default), with indexing
 * and the Knowledge Graph (`enabled`) on too, since code is found by
 * meaning only, and an agent chosen, since only its answers read
 * the code index (no other search does). Waiting for the agent keeps the first
 * fill, real background work, from running for nothing. The one test main,
 * the Settings card, the Index row and the Ask box all read.
 */
export function codeIndexOn(config: KnowledgeGraphConfig | undefined): boolean {
  return config?.sourceCode !== false
    && config?.indexingEnabled !== false
    && config?.enabled === true
    && Boolean(config?.agent);
}

/** What a sweep does with the source code index: see `codeSweepPlan`. */
export type CodeSweepPlan = 'index' | 'clear' | 'keep';

/**
 * What a sweep does with the source code index. It is indexed while on
 * (`codeIndexOn`), and cleared only when its own switch is off. While it waits
 * for the Knowledge Graph or an agent it is kept as it is, so switching either
 * off and on again never costs a full re-embed, and a config that cannot be
 * read never clears it.
 */
export function codeSweepPlan(loadConfig: () => KnowledgeGraphConfig | undefined): CodeSweepPlan {
  let config: KnowledgeGraphConfig | undefined;
  try {
    config = loadConfig();
  } catch {
    return 'keep';
  }
  if (codeIndexOn(config)) return 'index';
  return config?.sourceCode === false ? 'clear' : 'keep';
}

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
  /** The configured agent (`knowledgeGraph.agent`), or null/undefined when none
   *  has been chosen. */
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
  /** The configured model, or null/undefined when none has been chosen. */
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
