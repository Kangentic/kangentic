/**
 * Call-time validation for the agent / model / effort pins an MCP caller can
 * put on a task.
 *
 * Without this, a typo in `modelOverride` or `effortOverride` produces a task
 * that looks correct on the board and fails hours later, when someone moves it
 * into an executing column and the agent CLI rejects the flag. The failure is
 * far from the call that caused it and the calling agent is long gone. Kangentic
 * already knows the valid values at call time (they are discovered from the live
 * CLI), so a rejection here is a terminal, self-correctable error instead.
 *
 * Two hard constraints shape the design:
 *
 *   1. No agent-name branching (`.claude/rules/agent-adapters-boundary.md`).
 *      Valid values come from `agentRegistry` plus the adapter-discovered
 *      `AgentCapabilities`, never a hardcoded map or a switch on agent name.
 *   2. An agent can legitimately enumerate NOTHING - it may declare no
 *      `discoverCapabilities`, may not be installed (discovery never runs), or
 *      may probe successfully and find nothing (codex/gemini/droid all report
 *      `effortLevels: []` because they have no effort flag at all). So an empty
 *      or absent list means "cannot validate" and the value is ACCEPTED, exactly
 *      as the renderer falls back to a free-form text input in that case. This
 *      module never guesses.
 */
import { agentRegistry } from '../agent-registry';
import { listAgents } from '../agent-list';
import { parseModelFamily, parseModelId } from '../../../shared/model-id';
import { DEFAULT_AGENT } from '../../../shared/types';

/**
 * Upper bound on the capability probe. `listAgents` is cached and in the
 * running app the renderer has already warmed it at startup, but a cold cache
 * fans out `--version` / `--help` / session-history probes across every
 * registered adapter. An MCP call must never hang on that: on timeout we accept
 * the value, which is the same answer we give when an agent cannot enumerate.
 */
export const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

export interface SpawnOverrideValidationInput {
  /** `agentOverride` as passed by the caller, or null/undefined when unset. */
  agentOverride?: string | null;
  /** `modelOverride` AFTER `resolveModelSelector`, or null/undefined when unset. */
  modelOverride?: string | null;
  /** `effortOverride` AFTER `resolveEffortSelector`, or null/undefined when unset. */
  effortOverride?: string | null;
  /**
   * `agent_override` already stored on the task being updated. Rung 1 of the
   * ladder below `agentOverride`, and populated on most tasks that have ever
   * run, since `lockAdvancedOverridesOnFirstSpawn` writes the pins at first
   * spawn. Unset for a create - there is no task yet.
   */
  taskAgentOverride?: string | null;
  /** `agent_override` on the destination (or current) column, if any. */
  laneAgentOverride?: string | null;
  /** The project row's `default_agent`, if reachable. */
  projectDefaultAgent?: string | null;
  /** `config.agent.cliPaths` - needed so discovery probes the binary the user configured. */
  cliPathOverrides: Record<string, string | null | undefined>;
  /**
   * `config.discoveredModelsByAgent` - the learned model cache the renderer's
   * own picker unions in. Validating without it would reject models the UI
   * itself offers.
   */
  discoveredModelsByAgent?: Record<string, string[]>;
}

/** Where the agent this task will run under came from, for the error text. */
type AgentSource =
  | 'the agent set by this call'
  | 'the agent pinned on this task'
  | 'the destination column'
  | 'the project default'
  | 'the app default';

function resolveAgent(input: SpawnOverrideValidationInput): { agent: string; source: AgentSource } {
  // The canonical ladder, mirroring resolveSpawnOverrides in
  // src/main/ipc/helpers/agent-spawn.ts:
  //   task.agent_override ?? lane.agent_override ?? project.default_agent ?? DEFAULT_AGENT
  // with this call's own agent argument ahead of the stored task pin, since
  // setting it IS rewriting rung 1.
  if (input.agentOverride) return { agent: input.agentOverride, source: 'the agent set by this call' };
  if (input.taskAgentOverride) return { agent: input.taskAgentOverride, source: 'the agent pinned on this task' };
  if (input.laneAgentOverride) return { agent: input.laneAgentOverride, source: 'the destination column' };
  if (input.projectDefaultAgent) return { agent: input.projectDefaultAgent, source: 'the project default' };
  return { agent: DEFAULT_AGENT, source: 'the app default' };
}

/**
 * Whether `model` is a floating alias (`opus`, `sonnet`) rather than a concrete
 * versioned id (`claude-opus-4-8`).
 *
 * This decides what we are able to check. A discovered model list is built from
 * concrete ids - Claude's comes from `message.model` on assistant records in
 * transcript history and from the CLI's `/model` picker, both of which report
 * full ids - so an alias is by construction absent from it even though
 * `--model opus` is perfectly valid and is the first example in the tool's own
 * schema. Rejecting on absence would therefore refuse a value the CLI accepts.
 *
 * So membership is only enforced for a value carrying a trailing numeric
 * version, which is exactly the shape the list enumerates. That still catches
 * the case this validation exists for - a mistyped or superseded concrete id
 * like `claude-opus-4-9` - and leaves the CLI as the validator for aliases.
 */
function isFloatingAlias(model: string): boolean {
  return parseModelFamily(model).version.length === 0;
}

/** Resolve `promise`, or `null` if it rejects or outruns `timeoutMs`. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        // Do not hold the event loop open purely for this bound.
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validate the pins present on THIS call. Returns a rejection message, or null
 * when the values are valid or cannot be verified.
 *
 * Only fields the caller actually passed are checked. Re-validating a task's
 * stored values would mean a labels-only follow-up update starts failing on a
 * task carrying a since-deprecated model pin.
 */
export async function validateSpawnOverrides(
  input: SpawnOverrideValidationInput,
): Promise<string | null> {
  // 1. An unknown agent name is decidable with no probe at all.
  if (input.agentOverride && !agentRegistry.has(input.agentOverride)) {
    return `agentOverride "${input.agentOverride}" is not a registered agent. Valid values: ${agentRegistry.list().join(', ')}. `
      + 'Retrying this call unchanged will fail identically.';
  }

  const model = input.modelOverride?.trim() || null;
  const effort = input.effortOverride?.trim() || null;
  // 2. Nothing to check means no capability probe at all, which is the common
  //    case for create_task and keeps this free for it.
  if (!model && !effort) return null;

  const { agent, source } = resolveAgent(input);

  // 3. Probe, bounded. A null result means "could not determine" -> accept.
  const agents = await settleWithin(listAgents(input.cliPathOverrides, false), CAPABILITY_PROBE_TIMEOUT_MS);
  if (!agents) return null;
  const capabilities = agents.find((entry) => entry.name === agent)?.capabilities;
  if (!capabilities) return null;

  const context = `for agent "${agent}" (resolved from ${source})`;

  if (model) {
    if (capabilities.supportsModelOverride === false) {
      return `modelOverride "${model}" cannot be applied ${context}: this agent's CLI accepts no model override flag. `
        + 'Omit modelOverride, or set agentOverride to an agent that supports one. '
        + 'Retrying this call unchanged will fail identically.';
    }
    // One union, used for both the membership test and the rejection message,
    // so the two can never drift apart.
    const enumeratedModels = [...new Set([
      ...(capabilities.models ?? []),
      ...(input.discoveredModelsByAgent?.[agent] ?? []),
    ])];
    // Compare on `baseId`, never the raw string. One model is spawnable under
    // several spellings - `claude-opus-4-8`, the context-window variant
    // `claude-opus-4-8[1m]`, and the dated pin `claude-opus-4-8-20260101` -
    // and discovery deliberately records whichever spelling the transcript
    // used (adapters/claude/capability-discovery.ts documents why it does NOT
    // strip the date). A raw match would therefore reject a valid model
    // whenever the caller and the discovered list disagree on spelling, which
    // includes the friendly "Opus 4.8" this tool's own schema advertises.
    const known = new Set(enumeratedModels.map((entry) => parseModelId(entry).baseId.toLowerCase()));
    // The alias test also runs on the baseId, so a `[1m]` suffix cannot hide a
    // trailing version and wave a typo through as a floating alias.
    const modelBaseId = parseModelId(model).baseId;
    // An empty set means the agent curates no model list; the CLI stays the
    // final validator, exactly as the renderer's free-form input assumes.
    if (known.size > 0 && !isFloatingAlias(modelBaseId) && !known.has(modelBaseId.toLowerCase())) {
      return `modelOverride "${model}" is not a known model ${context}. Valid values: ${[...enumeratedModels].sort().join(', ')}. `
        + 'Omit modelOverride to inherit column -> project -> agent default. '
        + 'Retrying this call unchanged will fail identically.';
    }
  }

  if (effort) {
    const levels = capabilities.effortLevels ?? [];
    // Empty covers both "this CLI has no effort flag" and "the probe found
    // nothing"; neither is grounds for rejecting the caller's value.
    if (levels.length > 0 && !levels.some((level) => level.toLowerCase() === effort.toLowerCase())) {
      return `effortOverride "${effort}" is not valid ${context}. Valid values: ${levels.join(', ')}. `
        + 'Omit effortOverride to inherit column -> project -> agent default. '
        + 'Retrying this call unchanged will fail identically.';
    }
  }

  return null;
}
