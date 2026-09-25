import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useConfigStore } from '../stores/config-store';

/**
 * Single source of truth for "what models can this agent run".
 *
 * Returns the sorted union of:
 *   1. `capabilities.models` from the latest agent-detection result: what the
 *      agent's CLI reports RIGHT NOW (Cursor runs `--list-models`, antigravity
 *      `agy models`, Claude walks `~/.claude/projects/` plus its own picker).
 *   2. `config.discoveredModelsByAgent[agent]`: the persisted cache of models
 *      the user has actually RUN, fed only by live `usage.model.id` updates
 *      through `rememberDiscoveredModel`.
 *
 * The union happens HERE, at read time, and (2) is deliberately not seeded
 * from (1). Seeding made the persisted set grow-only, so a model an adapter
 * stopped reporting could never leave a picker - that is how a hardcoded
 * Cursor fallback list outlived its own deletion. Reading (1) live instead
 * means a dropped model disappears, while a model the user ran still survives
 * a restart.
 */
export function useKnownModels(agent: string | null): string[] {
  const fromAgentList = useConfigStore(
    useShallow((state) => agent ? state.agentList.find((entry) => entry.name === agent)?.capabilities?.models : undefined),
  );
  const fromCache = useConfigStore(
    useShallow((state) => agent ? state.config.discoveredModelsByAgent?.[agent] : undefined),
  );
  return useMemo(() => {
    if (!agent) return [];
    const union = new Set<string>();
    if (fromAgentList) for (const value of fromAgentList) union.add(value);
    if (fromCache) for (const value of fromCache) union.add(value);
    return Array.from(union).sort((a, b) => a.localeCompare(b));
  }, [agent, fromAgentList, fromCache]);
}

const EMPTY_WINDOWS: Record<string, number> = {};
const EMPTY_DISPLAY_NAMES: Record<string, string> = {};

/**
 * Friendly display name per discovered model id (e.g. `claude-opus-4-8` ->
 * "Opus 4.8"), from the agent's own capability discovery
 * (`AgentCapabilities.modelDisplayNames`). All naming knowledge lives in the
 * adapter (see `.claude/rules/agent-adapters-boundary.md`); an id absent from
 * the map falls back to its raw id at the render site.
 */
export function useModelDisplayNames(agent: string | null): Record<string, string> {
  const displayNames = useConfigStore(
    useShallow((state) =>
      agent ? state.agentList.find((entry) => entry.name === agent)?.capabilities?.modelDisplayNames : undefined,
    ),
  );
  return displayNames ?? EMPTY_DISPLAY_NAMES;
}

/**
 * Empirically-observed context-window sizes for an agent's models, keyed by
 * BASE model id (the `[1m]`/dated suffix stripped). Learned from any adapter's
 * live usage tick (`contextWindow.contextWindowSize`, via
 * `rememberModelContextWindow`) and persisted across restarts. Claude sources
 * that from its `status.json`, but the handler is generic, so an adapter that
 * reports the 0 "unknown" sentinel instead (Gemini) simply never populates it. A model is present only once its window has actually been observed
 * on a real session, so the dropdowns badge context size without hardcoding
 * (the window is not derivable from a model id - see the store action). Reactive
 * like `useKnownModels`: the badge appears the moment the window is learned.
 */
export function useModelContextWindows(agent: string | null): Record<string, number> {
  const windows = useConfigStore(
    useShallow((state) => (agent ? state.config.discoveredContextWindowsByAgent?.[agent] : undefined)),
  );
  return windows ?? EMPTY_WINDOWS;
}
