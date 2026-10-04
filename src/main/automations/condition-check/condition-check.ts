import { ensureAnswerHomeDirectory, withAnswerRunDirectory } from '../../agent/shared/answer-run-directory';
import { answerSetupGap, automationAgentChoice, resolveAnswerAgent } from '../../../shared/answer-agent';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { AppConfig } from '../../../shared/types';
import { buildConditionPrompt, parseConditionReply, type ConditionAnswer, type ConditionPromptInput } from './condition-prompt';

/**
 * Answer a column's pending Conditions with one headless call on the
 * Automation agent (`AppConfig.automation`).
 *
 * The answer path is #529's (`answerFromContext`, in the shared answer home,
 * each run in a directory of its own), resolved the way the Knowledge Graph
 * resolves its agent but from the Automation agent's own choice, with no
 * fallback: a check never spends on an agent nobody chose.
 *
 * Two costs are held down because a check runs at turn ends, which a busy
 * board produces many of:
 * - the CLI's detection and effort levels are cached for a few minutes rather
 *   than probed on every check (`resolveAnswerRun` probes per call, which suits
 *   a question a person asked, not a background check);
 * - at most `MAX_CONCURRENT_CHECKS` run at once, each a CLI started in the pty
 *   host, so a workflow ending many turns together queues its checks instead
 *   of starting them all.
 */

export type ConditionCheckOutcome =
  | { ok: true; answers: Map<string, ConditionAnswer>; agentName: string }
  | { ok: false; reason: string };

/** The dependencies a check needs, so the module tests without Electron. */
export interface ConditionCheckDeps {
  loadConfig: () => AppConfig;
  listAgents: () => Promise<ReadonlyArray<{ name: string; adapter: AgentAdapter }>>;
}

const MAX_CONCURRENT_CHECKS = 2;
const DETECTION_TTL_MS = 5 * 60_000;

interface CachedCli {
  path: string;
  effortLevels: string[];
  at: number;
}

// Keyed by agent name plus its CLI path override, so changing the override
// finds the new CLI at once.
const cliCache = new Map<string, CachedCli>();

let runningChecks = 0;
const waitingChecks: Array<() => void> = [];

async function acquireCheckSlot(): Promise<void> {
  if (runningChecks < MAX_CONCURRENT_CHECKS) {
    runningChecks += 1;
    return;
  }
  await new Promise<void>((resolve) => waitingChecks.push(resolve));
  runningChecks += 1;
}

function releaseCheckSlot(): void {
  runningChecks -= 1;
  const next = waitingChecks.shift();
  if (next) next();
}

/** Why the Automation agent cannot run a check right now, or null when it can. */
export async function automationAgentUnavailableReason(deps: ConditionCheckDeps): Promise<string | null> {
  const resolved = await resolveCheckAgent(deps);
  return resolved.ok ? null : resolved.reason;
}

async function resolveCheckAgent(deps: ConditionCheckDeps): Promise<
  | { ok: true; adapter: AgentAdapter; agentName: string; cliPath: string; model: string | null; effort: string | null }
  | { ok: false; reason: string }
> {
  const config = deps.loadConfig();
  const choice = automationAgentChoice(config.automation);
  const registered = await deps.listAgents();
  const candidates = registered.map(({ name, adapter }) => ({
    name,
    displayName: adapter.displayName,
    supportsAnswerFromContext: typeof adapter.answerFromContext === 'function',
    answerCapabilities: adapter.answerCapabilities,
  }));
  const gap = answerSetupGap({ agents: candidates, configured: choice.agent, configuredModel: choice.model });
  if (gap) {
    return {
      ok: false,
      reason: gap === 'agent'
        ? 'Set up an Automation agent in Settings > Workflows to check this condition.'
        : 'Choose a model for the Automation agent in Settings > Workflows to check this condition.',
    };
  }
  const agentName = resolveAnswerAgent({ agents: candidates, configured: choice.agent })?.name ?? '';
  const adapter = registered.find((entry) => entry.name === agentName)?.adapter;
  if (!adapter?.answerFromContext) return { ok: false, reason: `The Automation agent "${agentName}" cannot answer checks.` };

  const override = config.agent.cliPaths[agentName] ?? null;
  const cacheKey = `${agentName}\n${override ?? ''}`;
  let cached = cliCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > DETECTION_TTL_MS) {
    const info = await adapter.detect(override);
    if (!info.found || !info.path) return { ok: false, reason: `${adapter.displayName} CLI not found, so the condition could not be checked.` };
    let effortLevels: string[] = [];
    if (adapter.answerCapabilities?.effort && adapter.discoverCapabilities) {
      const discovered = await adapter.discoverCapabilities(info.path).catch(() => undefined);
      effortLevels = discovered?.effortLevels ?? [];
    }
    cached = { path: info.path, effortLevels, at: Date.now() };
    cliCache.set(cacheKey, cached);
  }

  // Effort only when the CLI reports it right now: the chosen level, else the
  // adapter's recommended one. A stale level fails every run on the CLIs that
  // exit on an unknown one (Grok, Copilot, Antigravity).
  let effort: string | null = null;
  const capabilities = adapter.answerCapabilities;
  if (capabilities?.effort) {
    if (choice.effort && cached.effortLevels.includes(choice.effort)) effort = choice.effort;
    else if (capabilities.defaultEffort && cached.effortLevels.includes(capabilities.defaultEffort)) effort = capabilities.defaultEffort;
  }
  return { ok: true, adapter, agentName, cliPath: cached.path, model: choice.model, effort };
}

/**
 * Answer every Condition in `input.rows` with one call. A Condition the reply
 * did not answer comes back not met, with the reason saying so, never as a
 * guess. A check that could not run at all returns `ok: false` with why, and
 * the caller skips those rows (a skip is not a run, so the next trigger checks
 * them again).
 */
export async function checkAutomationConditions(
  deps: ConditionCheckDeps,
  input: ConditionPromptInput,
): Promise<ConditionCheckOutcome> {
  if (input.rows.length === 0) return { ok: true, answers: new Map(), agentName: '' };
  const resolved = await resolveCheckAgent(deps);
  if (!resolved.ok) return resolved;

  const prompt = buildConditionPrompt(input);
  await acquireCheckSlot();
  let reply: string;
  try {
    const answerHome = await ensureAnswerHomeDirectory();
    reply = await withAnswerRunDirectory((runDirectory) => resolved.adapter.answerFromContext!(
      prompt,
      resolved.cliPath,
      answerHome,
      resolved.model,
      { effort: resolved.effort, runDirectory },
    ));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `The Automation agent could not check the condition: ${detail}` };
  } finally {
    releaseCheckSlot();
  }

  const parsed = parseConditionReply(reply, input.rows.length);
  const answers = new Map<string, ConditionAnswer>();
  input.rows.forEach((row, index) => {
    answers.set(row.automationId, parsed.get(index) ?? {
      met: false,
      reason: 'The Automation agent did not answer this condition.',
    });
  });
  return { ok: true, answers, agentName: resolved.agentName };
}

/** For tests: forget cached CLI detections. */
export function resetConditionCheckCacheForTests(): void {
  cliCache.clear();
}
