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

/**
 * Take a check slot, or give up when `signal` aborts first. A waiter that gives
 * up leaves the queue, so it never takes a slot nobody will release.
 */
function acquireCheckSlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (runningChecks < MAX_CONCURRENT_CHECKS) {
    runningChecks += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      const index = waitingChecks.indexOf(waiter);
      if (index >= 0) waitingChecks.splice(index, 1);
      resolve(false);
    };
    const waiter = (): void => {
      signal.removeEventListener('abort', onAbort);
      runningChecks += 1;
      resolve(true);
    };
    waitingChecks.push(waiter);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long a caller waits for a check. Enter and exit groups run inside the
 * move's task lock, so their check is bounded: a queue of turn-end checks ahead
 * of it, or a slow CLI, must not hold that task's lock for minutes.
 */
export interface ConditionCheckLimits {
  /** The caller moved on (its move was superseded): stop waiting. */
  signal?: AbortSignal;
  /** The longest the caller waits, the slot queue included. */
  timeoutMs?: number;
}

/** Settles with the work's result, or with null once `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<{ value: T } | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
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

type ResolvedCheckAgent =
  | { ok: true; adapter: AgentAdapter; agentName: string; cliPath: string; model: string | null; effort: string | null }
  | { ok: false; reason: string };

/** Which agent answers, and with what. A setup step that throws (a CLI probe that fails to spawn) is a check that could not run. */
async function resolveCheckAgent(deps: ConditionCheckDeps): Promise<ResolvedCheckAgent> {
  try {
    return await resolveCheckAgentOrThrow(deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `The Automation agent could not be set up, so the condition was not checked: ${detail}` };
  }
}

async function resolveCheckAgentOrThrow(deps: ConditionCheckDeps): Promise<ResolvedCheckAgent> {
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
 * them again). So does one the caller stopped waiting for (`limits`); its CLI
 * run finishes in the background and frees its slot then.
 */
export async function checkAutomationConditions(
  deps: ConditionCheckDeps,
  input: ConditionPromptInput,
  limits: ConditionCheckLimits = {},
): Promise<ConditionCheckOutcome> {
  if (input.rows.length === 0) return { ok: true, answers: new Map(), agentName: '' };
  const stop = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => stop.abort();
  if (limits.signal?.aborted) stop.abort();
  limits.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = limits.timeoutMs !== undefined
    ? setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, Math.max(0, limits.timeoutMs))
    : null;
  const stoppedReason = (): string => (timedOut
    ? 'The Automation agent did not answer in time, so the condition was not checked.'
    : 'The condition check was stopped because the task moved on.');

  try {
    // Inside the bound too: finding the agent can probe its CLI, and a probe
    // that hangs must not hold the move's task lock past the limit.
    const settledAgent = await untilAborted(resolveCheckAgent(deps), stop.signal);
    if (!settledAgent) return { ok: false, reason: stoppedReason() };
    const resolved = settledAgent.value;
    if (!resolved.ok) return resolved;
    if (stop.signal.aborted) return { ok: false, reason: stoppedReason() };

    const prompt = buildConditionPrompt(input);
    if (!(await acquireCheckSlot(stop.signal))) return { ok: false, reason: stoppedReason() };
    const answering = (async (): Promise<string> => {
      try {
        const answerHome = await ensureAnswerHomeDirectory();
        return await withAnswerRunDirectory((runDirectory) => resolved.adapter.answerFromContext!(
          prompt,
          resolved.cliPath,
          answerHome,
          resolved.model,
          { effort: resolved.effort, runDirectory },
        ));
      } finally {
        releaseCheckSlot();
      }
    })();
    // A caller that stopped waiting leaves this run to finish on its own.
    answering.catch(() => undefined);

    let reply: string;
    try {
      const settled = await untilAborted(answering, stop.signal);
      if (!settled) return { ok: false, reason: stoppedReason() };
      reply = settled.value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `The Automation agent could not check the condition: ${detail}` };
    }
    return { ok: true, answers: answersFrom(reply, input), agentName: resolved.agentName };
  } finally {
    if (timer) clearTimeout(timer);
    limits.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Every row's answer from the reply; a row the reply skipped is not met, and says so. */
function answersFrom(reply: string, input: ConditionPromptInput): Map<string, ConditionAnswer> {
  const parsed = parseConditionReply(reply, input.rows.length);
  const answers = new Map<string, ConditionAnswer>();
  input.rows.forEach((row, index) => {
    answers.set(row.automationId, parsed.get(index) ?? {
      met: false,
      reason: 'The Automation agent did not answer this condition.',
    });
  });
  return answers;
}

/** For tests: forget cached CLI detections. */
export function resetConditionCheckCacheForTests(): void {
  cliCache.clear();
}
