import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useConfigStore } from '../stores/config-store';
import type { ModelAliasOption } from '../../shared/types';

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
  return useMemo(() => (agent ? unionKnownModels(fromAgentList, fromCache) : []), [agent, fromAgentList, fromCache]);
}

/**
 * The union `useKnownModels` returns, for a caller that already holds both
 * sources outside a hook (the board overview reads it per column).
 */
export function unionKnownModels(
  capabilityModels: readonly string[] | undefined,
  discoveredModels: readonly string[] | undefined,
): string[] {
  const union = new Set<string>();
  if (capabilityModels) for (const value of capabilityModels) union.add(value);
  if (discoveredModels) for (const value of discoveredModels) union.add(value);
  return Array.from(union).sort((first, second) => first.localeCompare(second));
}

const EMPTY_WINDOWS: Record<string, number> = {};
const EMPTY_DISPLAY_NAMES: Record<string, string> = {};
const EMPTY_ALIASES: ModelAliasOption[] = [];

/**
 * Floating model selectors the agent offers (`AgentCapabilities.modelAliases`,
 * e.g. Claude's `opus`), each with the versioned id it currently resolves to,
 * in the CLI's own order. The pickers list them above the specific versions.
 * Live from capability discovery only: an alias is never learned from
 * telemetry, which reports resolved ids. Selected by content, because every
 * agent-list reload (one per picker open) brings fresh objects, and a new
 * array per reload would re-render an open picker for no change.
 */
export function useModelAliases(agent: string | null): ModelAliasOption[] {
  const aliasesKey = useConfigStore((state) => {
    const aliases = agent
      ? state.agentList.find((entry) => entry.name === agent)?.capabilities?.modelAliases
      : undefined;
    return aliases && aliases.length > 0 ? JSON.stringify(aliases) : '';
  });
  return useMemo(
    () => (aliasesKey ? (JSON.parse(aliasesKey) as ModelAliasOption[]) : EMPTY_ALIASES),
    [aliasesKey],
  );
}

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
