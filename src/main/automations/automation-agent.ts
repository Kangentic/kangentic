import { answerSetupGap, automationAgentChoice, resolveAnswerAgent } from '../../shared/answer-agent';
import { agentCliNotFoundMessage } from '../agent/shared/agent-cli-not-found';
import { ensureAnswerHomeDirectory, withAnswerRunDirectory } from '../agent/shared/answer-run-directory';
import { startRecordedCall, type BackgroundCallSink } from '../background-calls/record-background-call';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { AppConfig, BackgroundCallJob } from '../../shared/types';

/**
 * Which agent the Automation agent setting (`AppConfig.automation`) resolves to,
 * with the CLI path, model and effort a headless run on it takes.
 *
 * Two jobs run on it: answering a column's Conditions (and a workflow step's
 * check), and naming a task or a Command Terminal. Both resolve here, so the
 * detection cache and the effort rule exist once. There is no fallback to any
 * other agent: nothing spends on an agent nobody chose.
 *
 * Detection and effort levels are cached for a few minutes rather than probed
 * on every call, because checks run at turn ends, which a busy board produces
 * many of.
 */

/** The dependencies a resolution needs, so callers test without Electron. */
export interface AutomationAgentDeps {
  loadConfig: () => AppConfig;
  listAgents: () => Promise<ReadonlyArray<{ name: string; adapter: AgentAdapter }>>;
}

/** What the agent is resolved for: a Condition check runs `answerFromContext`,
 *  naming runs `summarize`. */
export type AutomationAgentJob = 'check' | 'naming';

/**
 * Why a job cannot run: `'unavailable'` is a setup gap a person fixes in
 * Settings (no agent, no model, an agent that cannot do the job, a CLI not
 * found), `'failed'` a setup step that threw and may work on a later try.
 */
export type AutomationAgentGapCause = 'unavailable' | 'failed';

export type ResolvedAutomationAgent =
  | { ok: true; adapter: AgentAdapter; agentName: string; cliPath: string; model: string | null; effort: string | null }
  | { ok: false; reason: string; cause: AutomationAgentGapCause };

const DETECTION_TTL_MS = 5 * 60_000;
/** A discovery that threw (a probe timeout) is retried this soon, so one
 *  failure does not drop effort from every call for the full TTL. */
const FAILED_DISCOVERY_TTL_MS = 30_000;

interface CachedCli {
  path: string;
  effortLevels: string[];
  at: number;
  ttlMs: number;
}

// Keyed by agent name plus its CLI path override, so changing the override
// finds the new CLI at once.
const cliCache = new Map<string, CachedCli>();

/** The sentence each way a job cannot run says, per job. */
const REASONS: Record<AutomationAgentJob, {
  agent: string;
  model: string;
  unsupported: (agentName: string) => string;
  notFound: (displayName: string) => string;
  setupFailed: (detail: string) => string;
}> = {
  check: {
    agent: 'Set up an Automation agent in Settings > Workflows to check this condition.',
    model: 'Choose a model for the Automation agent in Settings > Workflows to check this condition.',
    unsupported: (agentName) => `The Automation agent "${agentName}" cannot answer checks.`,
    notFound: (displayName) => `${displayName} CLI not found, so the condition could not be checked.`,
    setupFailed: (detail) => `The Automation agent could not be set up, so the condition was not checked: ${detail}`,
  },
  naming: {
    agent: 'Set up an Automation agent in Settings > Workflows to name tasks.',
    model: 'Choose a model for the Automation agent in Settings > Workflows to name tasks.',
    unsupported: (agentName) => `The Automation agent "${agentName}" cannot name tasks.`,
    notFound: (displayName) => agentCliNotFoundMessage(displayName),
    setupFailed: (detail) => `The Automation agent could not be set up, so the task was not named: ${detail}`,
  },
};

/**
 * Which agent runs `job`, and with what. A setup step that throws (a CLI probe
 * that fails to spawn) is a job that could not run, never a throw.
 */
export async function resolveAutomationAgent(deps: AutomationAgentDeps, job: AutomationAgentJob): Promise<ResolvedAutomationAgent> {
  try {
    return await resolveAutomationAgentOrThrow(deps, job);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: REASONS[job].setupFailed(detail), cause: 'failed' };
  }
}

async function resolveAutomationAgentOrThrow(deps: AutomationAgentDeps, job: AutomationAgentJob): Promise<ResolvedAutomationAgent> {
  const reasons = REASONS[job];
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
  if (gap) return { ok: false, reason: gap === 'agent' ? reasons.agent : reasons.model, cause: 'unavailable' };
  const agentName = resolveAnswerAgent({ agents: candidates, configured: choice.agent })?.name ?? '';
  const adapter = registered.find((entry) => entry.name === agentName)?.adapter;
  const canRun = job === 'check' ? typeof adapter?.answerFromContext === 'function' : typeof adapter?.summarize === 'function';
  if (!adapter || !canRun) return { ok: false, reason: reasons.unsupported(agentName), cause: 'unavailable' };

  const override = config.agent.cliPaths[agentName] ?? null;
  const cacheKey = `${agentName}\n${override ?? ''}`;
  let cached = cliCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > cached.ttlMs) {
    const info = await adapter.detect(override);
    if (!info.found || !info.path) return { ok: false, reason: reasons.notFound(adapter.displayName), cause: 'unavailable' };
    let effortLevels: string[] = [];
    let discoveryFailed = false;
    if (adapter.answerCapabilities?.effort && adapter.discoverCapabilities) {
      const discovered = await adapter.discoverCapabilities(info.path).catch(() => {
        discoveryFailed = true;
        return undefined;
      });
      effortLevels = discovered?.effortLevels ?? [];
    }
    cached = { path: info.path, effortLevels, at: Date.now(), ttlMs: discoveryFailed ? FAILED_DISCOVERY_TTL_MS : DETECTION_TTL_MS };
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

/** Where a naming call is recorded: the project whose ledger takes it, and for what. */
export interface NamingCall {
  projectId: string | null;
  job: Extract<BackgroundCallJob, 'task_title' | 'terminal_name'>;
  taskId: string | null;
}

/**
 * A title from the agent resolved for naming: `summarize` on its model and
 * effort, run in the shared answer home (a title needs nothing from the
 * repository, and a project root loads its agent instructions into every
 * call), and recorded in `call.projectId`'s ledger when the CLI settles. The
 * caller resolves the agent and takes its rate-limit slot first, so a refusal
 * spends nothing.
 */
export async function runNamingCall(
  agent: Extract<ResolvedAutomationAgent, { ok: true }>,
  prompt: string,
  sink: BackgroundCallSink | undefined,
  call: NamingCall,
): Promise<string> {
  const summarize = agent.adapter.summarize?.bind(agent.adapter);
  if (!summarize) throw new Error(REASONS.naming.unsupported(agent.agentName));
  const answerHome = await ensureAnswerHomeDirectory();
  return startRecordedCall(sink, {
    projectId: call.projectId,
    job: call.job,
    taskId: call.taskId,
    swimlaneId: null,
    agent: agent.agentName,
    requestedModel: agent.model,
    effort: agent.effort,
  }, (onUsage) => withAnswerRunDirectory((runDirectory) => summarize(
    prompt,
    agent.cliPath,
    answerHome,
    { model: agent.model, effort: agent.effort, runDirectory, onUsage },
  ))).done;
}

/** For tests: forget cached CLI detections. */
export function resetAutomationAgentCacheForTests(): void {
  cliCache.clear();
}
