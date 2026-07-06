import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useConfigStore } from '../stores/config-store';

/**
 * Single source of truth for "what models can this agent run".
 *
 * Returns the sorted union of:
 *   1. `capabilities.models` from the latest agent-detection result
 *      (`discoverCapabilities()` walks `--help` + `~/.claude/projects/`
 *      JSONL history for Claude).
 *   2. `config.discoveredModelsByAgent[agent]`: the persisted cache that
 *      augments via live `usage.model.id` updates and seeds itself from the
 *      capabilities walk on every `loadAgentList` call.
 *
 * The cache survives restarts and grows automatically as the user invokes
 * new models, so the model dropdowns "learn" any model in real time without
 * a manual refresh.
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

/**
 * Empirically-observed context-window sizes for an agent's models, keyed by
 * BASE model id (the `[1m]`/dated suffix stripped). Learned from live
 * `status.json` telemetry (`rememberModelContextWindow`) and persisted across
 * restarts. A model is present only once its window has actually been observed
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
