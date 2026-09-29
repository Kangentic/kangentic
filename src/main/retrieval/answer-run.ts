import type { AgentAdapter } from '../agent/agent-adapter';
import { ensureAnswerHomeDirectory } from '../agent/shared/answer-run-directory';
import { appendAnswerCaller } from '../agent/mcp-http/caller-url';
import { agentJobChoice, answerSetupGap, resolveAnswerAgent, type AgentJob } from '../../shared/answer-agent';
import type { IpcContext } from '../ipc/ipc-context';

/** How a question, or a batch of task summaries, is answered: which agent, CLI,
 *  model, effort and search URL. A warm session is started under exactly
 *  these, summed up as `sessionKey`. */
export interface AnswerRun {
  adapter: AgentAdapter;
  /** The adapter's fresh run, bound. */
  answerFromContext: NonNullable<AgentAdapter['answerFromContext']>;
  agentName: string;
  cliPath: string;
  model: string | null;
  effort: string | null;
  retrieval: { url: string; token: string } | undefined;
  sessionKey: string;
  /** The one working directory every answer run starts in (`answer-run-directory.ts`). */
  answerHome: string;
}

export type AnswerRunResolution =
  | { ok: true; run: AnswerRun }
  | { ok: false; failure: { ok: false; reason: string; setup?: 'agent' | 'model' } };

/**
 * Resolve the search agent for a question, a prewarm, or a summary batch,
 * through the SHARED rule the renderer uses to decide whether a question runs
 * or goes to Settings first, so the two can never disagree. The rule is
 * explicit: the configured agent and model, with no fallback to the project's
 * agent or to any capable one.
 *
 * Both jobs read the Knowledge Graph card's one choice. `job` only decides the
 * effort: a question runs at the chosen level, a summary batch always at the
 * adapter's recommended one (`agentJobChoice`).
 *
 * `withSearch: false` resolves a run with no tool at all, which is what a
 * summary batch needs: it summarizes what it is handed.
 */
export async function resolveAnswerRun(
  context: IpcContext,
  homeProjectId: string,
  chatId: string,
  options: { withSearch?: boolean; job?: AgentJob } = {},
): Promise<AnswerRunResolution> {
  const { agentRegistry } = await import('../agent/agent-registry');
  const config = context.configManager.load();
  const agents = agentRegistry.list().flatMap((name) => {
    const entry = agentRegistry.get(name);
    return entry
      ? [{
        name,
        displayName: entry.displayName,
        supportsAnswerFromContext: typeof entry.answerFromContext === 'function',
        answerCapabilities: entry.answerCapabilities,
      }]
      : [];
  });
  const job = options.job ?? 'answer';
  const choice = agentJobChoice(config.knowledgeGraph, job);
  const configuredAgent = choice.agent;
  const configuredModel = choice.model;
  const setup = answerSetupGap({ agents, configured: configuredAgent, configuredModel });
  if (setup) {
    return {
      ok: false,
      failure: {
        ok: false,
        setup,
        reason: `choose ${setup === 'agent' ? 'an agent' : 'a model'} in Settings > Knowledge Graph`,
      },
    };
  }
  const agentName = resolveAnswerAgent({ agents, configured: configuredAgent })?.name ?? '';
  const adapter = agentRegistry.get(agentName);
  if (!adapter?.answerFromContext) return { ok: false, failure: { ok: false, reason: `unknown agent: ${agentName}` } };
  const info = await adapter.detect(config.agent.cliPaths[agentName] ?? null);
  if (!info.found || !info.path) return { ok: false, failure: { ok: false, reason: `${adapter.displayName} CLI not found` } };

  // Effort only for a run that passes it on: the user's level, else the
  // adapter's recommended default, and either only when the CLI reports it
  // right now. A stale level would fail every question: Grok, Copilot and
  // Antigravity all exit on an unknown one.
  const capabilities = adapter.answerCapabilities;
  let effort: string | null = null;
  if (capabilities?.effort && adapter.discoverCapabilities) {
    const discovered = await adapter.discoverCapabilities(info.path).catch(() => undefined);
    const levels = discovered?.effortLevels ?? [];
    const configuredEffort = choice.effort;
    if (configuredEffort && levels.includes(configuredEffort)) effort = configuredEffort;
    else if (capabilities.defaultEffort && levels.includes(capabilities.defaultEffort)) effort = capabilities.defaultEffort;
  }

  // The ONE tool the agent may reach: Kangentic's own conversation search,
  // scoped to the home project by the URL. Offered only to an agent whose
  // answer run can use it, and only when the MCP server is up. The URL carries
  // an ANSWER caller segment keyed by the chat: the server hands such a caller
  // exactly `kangentic_search` (`buildAnswerMcpServer`) and publishes its
  // searches to the trace.
  const retrieval = options.withSearch !== false && context.mcpServerHandle && capabilities?.search
    ? { url: appendAnswerCaller(context.mcpServerHandle.urlForProject(homeProjectId), chatId), token: context.mcpServerHandle.token }
    : undefined;
  const run = {
    adapter,
    answerFromContext: adapter.answerFromContext.bind(adapter),
    agentName,
    cliPath: info.path,
    model: configuredModel,
    effort,
    retrieval,
    answerHome: await ensureAnswerHomeDirectory(),
  };
  return { ok: true, run: { ...run, sessionKey: JSON.stringify([agentName, info.path, configuredModel, effort, retrieval?.url ?? null]) } };
}
